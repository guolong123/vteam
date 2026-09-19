import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * agent-native-permission-editor Todo 5 · 策略写入后的传播提示与可选重启
 * =====================================================================================
 * 背景：策略 PATCH 落库后，server 广播 reload-config；在线 worker 收到即 injectAll()
 * 重写 opencode.json + .vteam-role-guard/roles.json，随后自动重启 serve（有活跃会话时
 * 挂起至会话结束）→ 通常十余秒自动生效，无需手动操作。离线 worker 在下次注册时 injectAll()
 * 应用。因此写盘成功 ≠ 立即生效，但**也不需要**用户手动重启才能生效。本 spec 断言四件事：
 *   1. 通知只在一次成功写盘后出现，且明说「自动生效」+ 真实传播规则
 *      （全局策略 × 逐 worker injectAll()，离线待注册，活跃会话下 serve 重启挂起）；
 *   2. 保存**不**自动重启（拦截 restart 端点计数为 0）——重启会中断在途会话；
 *   3. 点击动作对**每一个**已注册 worker 各发一次 restart（GET /workers 为期望集合），随后展示完成态；
 *   4. 零 worker 时展示空态（policy-restart-empty），**不**渲染死按钮。
 *
 * 安全：restart 端点真实存在（命令经心跳下发）。测试 2/3 通过 page.route 拦截并本地
 * fulfil，绝不把重启命令打到真实 worker；因此 QA 不会重启任何 worker。
 *
 * 运行（仓库根）：`bash scripts/e2e-policy-restart-notice.sh`
 * （独立 tmp config，不碰 playwright.config.ts；baseURL 指向 compose web :13001）
 */

const SERVER_URL = "http://localhost:13000";
const RUN_TAG = `t5-${Date.now().toString(36)}`;

type ApiAgent = {
  id: string;
  name: string;
  agentKey: string | null;
  policyId: string | null;
  effectivePermission: {
    policyId: string;
    policyName: string;
    agentName: string;
    permission: Record<string, unknown>;
    correction: Record<string, unknown>;
    tools?: Record<string, unknown>;
  } | null;
};

type StoredConfig = {
  permission: Record<string, unknown>;
  correction: Record<string, unknown>;
  tools: Record<string, unknown>;
};

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await request.post(`${SERVER_URL}/api/v1/auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(login.ok()).toBeTruthy();
  return ((await login.json()) as { accessToken: string }).accessToken;
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
}

async function createAgent(
  request: APIRequestContext,
  token: string,
  suffix: string,
): Promise<ApiAgent> {
  const res = await request.post(`${SERVER_URL}/api/v1/agents`, {
    headers: authHeaders(token),
    data: { name: `t5 ${suffix} ${RUN_TAG}`, agentKey: `t5-${suffix}-${RUN_TAG}`, type: "custom" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ApiAgent;
}

async function patchPolicy(
  request: APIRequestContext,
  token: string,
  agent: ApiAgent,
  permission: Record<string, unknown>,
) {
  const ep = agent.effectivePermission;
  expect(ep).not.toBeNull();
  const res = await request.patch(`${SERVER_URL}/api/v1/execution-policies/${ep!.policyId}`, {
    headers: authHeaders(token),
    data: {
      config: {
        permission,
        correction: ep!.correction,
        tools: ep!.tools ?? {},
      },
    },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** 读服务端存储的整份 config（写盘完成的唯一事实来源）。 */
async function storedConfig(
  request: APIRequestContext,
  token: string,
  policyId: string,
): Promise<StoredConfig> {
  const res = await request.get(`${SERVER_URL}/api/v1/execution-policies/${policyId}`, {
    headers: authHeaders(token),
  });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { config: StoredConfig };
  return body.config;
}

async function registeredWorkerIds(request: APIRequestContext, token: string): Promise<string[]> {
  const res = await request.get(`${SERVER_URL}/api/v1/workers`, { headers: authHeaders(token) });
  expect(res.status(), await res.text()).toBe(200);
  const rows = (await res.json()) as { id: string }[];
  return rows.map((r) => r.id);
}

async function deleteAgent(
  request: APIRequestContext,
  token: string,
  agent: ApiAgent,
): Promise<string> {
  const del = await request.delete(`${SERVER_URL}/api/v1/agents/${agent.id}`, {
    headers: authHeaders(token),
  });
  const policyId = agent.effectivePermission?.policyId ?? agent.policyId;
  const policyDel = policyId
    ? await request.delete(`${SERVER_URL}/api/v1/execution-policies/${policyId}`, {
        headers: authHeaders(token),
      })
    : null;
  const gone = await request.get(`${SERVER_URL}/api/v1/agents/${agent.id}`, {
    headers: authHeaders(token),
  });
  return `${agent.id} (agent ${del.status()}, policy ${policyId} ${policyDel?.status() ?? "n/a"}, re-GET ${gone.status()})`;
}

async function openAgent(page: Page, name: string) {
  await page.goto("/agents");
  await page.getByTestId("agent-config-root").waitFor({ timeout: 20_000 });
  await page.getByText(name, { exact: false }).first().click();
  await expect(page.getByTestId("effective-permission-section")).toBeVisible({ timeout: 20_000 });
}

/** 原生编辑：bash 切到 allow（debounce 400ms 后合并写盘）。 */
async function switchBashToAllow(page: Page) {
  const bash = page.getByTestId("native-bash-effect");
  await bash.locator('[data-effect="allow"]').click();
  await expect(bash.locator('[data-effect="allow"]')).toHaveAttribute("aria-checked", "true");
}

function recordEvidence(entry: Record<string, unknown>) {
  const path = process.env.T5_EVIDENCE_JSON;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  let records: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    records = Array.isArray(parsed) ? parsed : [];
  } catch {
    records = [];
  }
  records.push(entry);
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
}

async function saveScreenshot(page: Page, entryLabel: string) {
  const path = process.env.T5_SCREENSHOT;
  if (!path) return;
  await page.getByTestId("policy-restart-notice").scrollIntoViewIfNeeded();
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
  recordEvidence({ screenshot: path, captured_at: entryLabel });
}

test.describe("Todo 5 · 策略写入后的传播通知", () => {
  test("1. 通知只在成功写盘后出现，且明确「自动生效」+ 真实传播规则", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "notice");
    const policyId = agent.effectivePermission!.policyId;
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      // Given 尚无任何写盘：通知不出现
      await expect(page.getByTestId("policy-restart-notice")).toHaveCount(0);

      // When 原生编辑落盘成功（服务端存储为准）
      await switchBashToAllow(page);
      await expect
        .poll(
          async () => String((await storedConfig(request, token, policyId)).permission.bash),
          { timeout: 10_000 },
        )
        .toBe("allow");

      // Then 通知出现，明说自动生效，并给出真实传播规则（全局策略 × 逐 worker injectAll()，
      // 离线待下次注册，活跃会话下 serve 重启挂起）
      const notice = page.getByTestId("policy-restart-notice");
      await expect(notice).toBeVisible({ timeout: 10_000 });
      await expect(notice).toContainText("在线 worker 将自动重新注入");
      await expect(notice).not.toContainText("尚未生效");
      await expect(notice).not.toContainText("重启后才会写入");
      const hint = page.getByTestId("policy-restart-hint");
      await expect(hint).toContainText("injectAll()");
      await expect(hint).toContainText("全局");
      await expect(hint).toContainText("离线 worker");
      await expect(hint).toContainText("活跃会话");

      await saveScreenshot(page, "test-1-notice-after-save");
      recordEvidence({
        test: "notice_after_successful_save",
        agent: agent.id,
        policy_id: policyId,
        stored_bash: "allow",
        notice_visible: true,
        notice_says_auto_apply: true,
        notice_no_false_restart_requirement: true,
        hint_mentions_propagation: true,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("2. 保存不自动重启：写盘两次，restart 请求数为 0", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "noauto");
    const policyId = agent.effectivePermission!.policyId;
    const restartUrls: string[] = [];
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      // 拦截真实 restart 端点：若有自动重启会被计数；fulfil 保证绝不触达真实 worker
      await page.route("**/workers/*/restart", async (route) => {
        restartUrls.push(route.request().url());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ workerId: "intercepted", queued: false }),
        });
      });

      // When 两次保存（bash allow → deny），均确认写盘完成
      await switchBashToAllow(page);
      await expect
        .poll(
          async () => String((await storedConfig(request, token, policyId)).permission.bash),
          { timeout: 10_000 },
        )
        .toBe("allow");
      const bash = page.getByTestId("native-bash-effect");
      await bash.locator('[data-effect="deny"]').click();
      await expect
        .poll(
          async () => String((await storedConfig(request, token, policyId)).permission.bash),
          { timeout: 10_000 },
        )
        .toBe("deny");

      // 第二次写盘已回读确认；若 onSuccess 里挂了自动重启，此刻早该发出
      await expect(page.getByTestId("policy-restart-action")).toBeVisible();
      await page.waitForTimeout(750); // 负断言的观察窗口（无事件可等待）
      expect(restartUrls).toHaveLength(0);
      await expect(page.getByTestId("policy-restart-done")).toHaveCount(0);

      recordEvidence({
        test: "no_auto_restart_on_save",
        agent: agent.id,
        policy_id: policyId,
        saves: 2,
        restart_requests: restartUrls.length,
        action_still_offered: true,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("3. 点击重启：每个已注册 worker 各一次 restart，随后展示完成态", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "restartall");
    const policyId = agent.effectivePermission!.policyId;
    const restartUrls: string[] = [];
    try {
      const expectedIds = await registeredWorkerIds(request, token);
      expect(expectedIds.length).toBeGreaterThan(0);
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      // 拦截并本地 fulfil：断言真实请求集合，同时避免真正重启 worker
      await page.route("**/workers/*/restart", async (route) => {
        restartUrls.push(route.request().url());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ workerId: "intercepted", queued: true }),
        });
      });

      // 先制造一次成功的策略写盘 → 通知 + 动作按钮出现
      await switchBashToAllow(page);
      await expect
        .poll(
          async () => String((await storedConfig(request, token, policyId)).permission.bash),
          { timeout: 10_000 },
        )
        .toBe("allow");
      await expect(page.getByTestId("policy-restart-action")).toBeVisible({ timeout: 10_000 });

      // When 点击动作
      await page.getByTestId("policy-restart-action").click();

      // Then 每个已注册 worker 各收到一次 restart
      await expect.poll(() => restartUrls.length, { timeout: 10_000 }).toBe(expectedIds.length);
      const hitIds = restartUrls.map((u) => /\/workers\/([^/]+)\/restart/.exec(u)?.[1]);
      expect([...hitIds].sort()).toEqual([...expectedIds].sort());

      // 完成态展示；按钮消失（不重复触发）
      await expect(page.getByTestId("policy-restart-done")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("policy-restart-action")).toHaveCount(0);

      recordEvidence({
        test: "restart_all_workers",
        agent: agent.id,
        policy_id: policyId,
        expected_worker_ids: expectedIds,
        restart_requests: restartUrls,
        done_hint_visible: true,
        real_restart_avoided_by_route_fulfil: true,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("4. 零 worker 空态：显示空态句，不显示死按钮", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "noworker");
    const policyId = agent.effectivePermission!.policyId;
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      // GET /workers 桩为 []（页面 workersQuery 数据源）
      await page.route(/\/api\/v1\/workers(\?.*)?$/, async (route) => {
        if (route.request().method() !== "GET") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([]),
        });
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      await switchBashToAllow(page);
      await expect
        .poll(
          async () => String((await storedConfig(request, token, policyId)).permission.bash),
          { timeout: 10_000 },
        )
        .toBe("allow");
      await expect(page.getByTestId("policy-restart-notice")).toBeVisible({ timeout: 10_000 });

      // Then 空态句出现，按钮缺席
      await expect(page.getByTestId("policy-restart-empty")).toBeVisible();
      await expect(page.getByTestId("policy-restart-empty")).toContainText("没有已注册 worker");
      await expect(page.getByTestId("policy-restart-action")).toHaveCount(0);

      recordEvidence({
        test: "zero_worker_empty_state",
        agent: agent.id,
        policy_id: policyId,
        workers_stubbed: [],
        empty_state_visible: true,
        action_button_absent: true,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });
});
