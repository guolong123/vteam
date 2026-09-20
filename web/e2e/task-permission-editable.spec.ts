import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * opencode-native-permissions-and-fixes Todo 6 · task 权限可编辑
 * ==============================================================
 * 覆盖 agents 页「生效权限」的 task 行：从只读徽章 + guard 说明（native-task-note）
 * 变为与 bash 相同的三态分段（native-task-effect）。写路径与 bash 完全一致：
 * debounce(400ms) → PATCH /execution-policies/:policyId { config } → 落库
 * `config.permission.task` → 服务端 resolveTaskEffect(name, stored) 以显式存储值胜出
 * → GET /agents/:id（页面）与 GET /agent-policies（引擎注入源）同时回读。
 *
 * 判别性：
 *  - 测试 2 在**种子 agent**（产品经理 / ep_product）上做 deny→ask→reload 真往返，
 *    并从 `GET /agent-policies` 断言引擎侧同样读到 ask；随后还原 deny 并逐字节
 *    （canonical）比对还原前后的落库 config —— 证明结束时不残留任何修改。
 *  - 测试 3 注入非法存储值（'bogus'）→ 控件绝不显示非法值（落到 deny），且点击
 *    合法档位必然写穿（非静默 no-op）。控件仅暴露 allow/ask/deny 三档、无自由文本输入。
 *
 * 运行（仓库根）：`bash scripts/e2e-task-permission-editable.sh`
 * （独立 tmp config，不碰 playwright.config.ts；baseURL 指向 compose web :13001）
 */

const SERVER_URL = "http://localhost:13000";
const SEED_AGENT_NAME = "产品经理";
const SEED_POLICY_ID = "ep_product";
const SEED_ENGINE_AGENT = "vteam-product";
const RUN_TAG = `t6-${Date.now().toString(36)}`;

type StoredPolicy = {
  id: string;
  config: {
    permission: Record<string, unknown>;
    correction: Record<string, unknown>;
    tools?: Record<string, unknown>;
  };
};

type AgentPolicies = { agents: { name: string; permission: Record<string, unknown> }[] };

type ApiAgent = {
  id: string;
  name: string;
  agentKey: string | null;
  policyId: string | null;
  effectivePermission: { policyId: string } | null;
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

async function openAgent(page: Page, name: string) {
  await page.goto("/agents");
  await page.getByTestId("agent-config-root").waitFor({ timeout: 20_000 });
  await page.getByText(name, { exact: false }).first().click();
  await expect(page.getByTestId("effective-permission-section")).toBeVisible({ timeout: 20_000 });
}

function row(page: Page, key: string) {
  return page.locator(`[data-testid="effective-permission-row"][data-key="${key}"]`);
}

async function storedConfig(
  request: APIRequestContext,
  token: string,
  policyId: string,
): Promise<StoredPolicy> {
  const res = await request.get(`${SERVER_URL}/api/v1/execution-policies/${policyId}`, {
    headers: authHeaders(token),
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as StoredPolicy;
}

async function storedTask(
  request: APIRequestContext,
  token: string,
  policyId: string,
): Promise<string> {
  const cfg = await storedConfig(request, token, policyId);
  return String(cfg.config.permission.task);
}

async function engineTask(
  request: APIRequestContext,
  token: string,
  engineAgentName: string,
): Promise<string> {
  const res = await request.get(`${SERVER_URL}/api/v1/agent-policies`, {
    headers: authHeaders(token),
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as AgentPolicies;
  const entry = body.agents.find((a) => a.name === engineAgentName);
  expect(entry, `agent-policies 缺少 ${engineAgentName}`).toBeTruthy();
  return String(entry!.permission.task);
}

async function createAgent(
  request: APIRequestContext,
  token: string,
  suffix: string,
): Promise<ApiAgent> {
  const res = await request.post(`${SERVER_URL}/api/v1/agents`, {
    headers: authHeaders(token),
    data: { name: `t6 ${suffix} ${RUN_TAG}`, agentKey: `t6-${suffix}-${RUN_TAG}`, type: "custom" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ApiAgent;
}

/** 删除 agent + 其 custom 策略；返回清理收据。 */
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

/** 直写 DB 注入非三态 task 值（模拟存量/旁路写入；API 正确形态由控件独占）。 */
function injectTaskValue(policyId: string, value: string) {
  const sql = `UPDATE execution_policies SET config=JSON_SET(config, '$.permission.task', '${value}') WHERE id='${policyId}';`;
  execFileSync("docker", [
    "exec",
    "aiagents-compose-db",
    "mysql",
    "-uroot",
    "-paiagents-root",
    "aiagents",
    "-N",
    "-B",
    "-e",
    sql,
  ]);
}

/** 规范序序列化（MySQL JSON 会重排键序；canonical 比对才是"内容等价"判据）。 */
function deepCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(deepCanonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${deepCanonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function recordEvidence(entry: Record<string, unknown>) {
  const path = process.env.T6_EVIDENCE_JSON;
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

async function save(path: string | undefined, page: Page) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  await row(page, "task").scrollIntoViewIfNeeded();
  await page.screenshot({ path, fullPage: true });
}

test.describe("Todo 6 · task 原生权限可编辑", () => {
  test("1. task 行与 bash 同为可编辑三态；旧只读说明已移除", async ({ page }) => {
    await loginAsAdmin(page);
    await openAgent(page, SEED_AGENT_NAME);

    const rows = page.locator('[data-testid="effective-permission-row"]');
    await expect(rows).toHaveCount(4);

    const task = page.getByTestId("native-task-effect");
    const bash = page.getByTestId("native-bash-effect");
    await expect(task).toBeVisible();
    await expect(task).toHaveAttribute("data-readonly", "false");
    await expect(task).toHaveAttribute("role", "radiogroup");
    await expect(bash).toHaveAttribute("role", "radiogroup");

    const effects = await task
      .locator("[data-effect]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-effect")));
    expect(effects).toEqual(["allow", "ask", "deny"]);
    await expect(task.locator('[data-effect="deny"]')).toHaveAttribute("aria-checked", "true");

    // 旧说明（native-task-note）与它的错误断言必须消失；新说明不得复述被删 guard 的说法
    await expect(page.getByTestId("native-task-note")).toHaveCount(0);
    const note = page.getByTestId("native-task-effect-note");
    await expect(note).toBeVisible();
    const noteText = (await note.textContent()) ?? "";
    expect(noteText).not.toContain("guard");
    expect(noteText).not.toContain("vteam-plan");
    expect(noteText).toContain("subagent_depth");

    // 其余三行保持原控件形态
    await expect(
      page.locator('[data-testid="native-rule-editor"][data-native="edit"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="native-rule-editor"][data-native="read"]'),
    ).toBeVisible();
    await expect(bash).toBeVisible();

    await save(process.env.T6_SCREENSHOT_FIRST, page);
    recordEvidence({
      test: "task_row_editable_seed_agent",
      agent: SEED_AGENT_NAME,
      task_effects: effects,
      task_readonly: await task.getAttribute("data-readonly"),
      old_note_present: false,
      new_note: noteText.trim(),
    });
  });

  test("2. deny→ask→reload 真往返（控件 + /agent-policies 一致），末尾还原并逐字节校验", async ({ page, request }) => {
    const token = await adminToken(request);
    const before = await storedConfig(request, token, SEED_POLICY_ID);
    expect(before.config.permission.task).toBe("deny");
    const beforeCanonical = deepCanonical(before.config);

    await loginAsAdmin(page);
    await openAgent(page, SEED_AGENT_NAME);
    const task = page.getByTestId("native-task-effect");
    await expect(task.locator('[data-effect="deny"]')).toHaveAttribute("aria-checked", "true");

    // deny → ask（debounce 400ms 后落库）
    await task.locator('[data-effect="ask"]').click();
    await expect(task.locator('[data-effect="ask"]')).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() => storedTask(request, token, SEED_POLICY_ID), { timeout: 10_000 })
      .toBe("ask");
    const engineAfterChange = await engineTask(request, token, SEED_ENGINE_AGENT);
    expect(engineAfterChange).toBe("ask");

    // reload → 控件回读 ask
    await openAgent(page, SEED_AGENT_NAME);
    await expect(
      page.getByTestId("native-task-effect").locator('[data-effect="ask"]'),
    ).toHaveAttribute("aria-checked", "true");
    await save(process.env.T6_SCREENSHOT, page);

    // 还原 ask → deny（本测试最后动作），并断言服务端回读一致
    await page.getByTestId("native-task-effect").locator('[data-effect="deny"]').click();
    await expect
      .poll(() => storedTask(request, token, SEED_POLICY_ID), { timeout: 10_000 })
      .toBe("deny");
    await openAgent(page, SEED_AGENT_NAME);
    await expect(
      page.getByTestId("native-task-effect").locator('[data-effect="deny"]'),
    ).toHaveAttribute("aria-checked", "true");

    const after = await storedConfig(request, token, SEED_POLICY_ID);
    const engineRestored = await engineTask(request, token, SEED_ENGINE_AGENT);
    expect(after.config.permission.task).toBe("deny");
    expect(engineRestored).toBe("deny");
    expect(deepCanonical(after.config)).toBe(beforeCanonical);
    expect(Object.keys(after.config.tools ?? {})).toHaveLength(
      Object.keys(before.config.tools ?? {}).length,
    );

    recordEvidence({
      test: "task_round_trip_and_restore",
      agent: SEED_AGENT_NAME,
      policy_id: SEED_POLICY_ID,
      before_task: before.config.permission.task,
      changed_to: "ask",
      control_after_reload: "ask",
      engine_agent_policies_after_change: engineAfterChange,
      restored_task: after.config.permission.task,
      engine_agent_policies_restored: engineRestored,
      canonical_config_equal_after_restore: true,
      screenshot: process.env.T6_SCREENSHOT ?? null,
    });
  });

  test("3. 控件仅暴露三档合法值；非法存量值不显示且点击必然写穿（非静默 no-op）", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "neg");
    const policyId = agent.effectivePermission!.policyId;
    try {
      injectTaskValue(policyId, "bogus");
      const bogus = await storedTask(request, token, policyId);
      expect(bogus).toBe("bogus");

      await loginAsAdmin(page);
      await openAgent(page, agent.name);
      const task = page.getByTestId("native-task-effect");
      await expect(task).toBeVisible();

      // 控件绝不显示服务端不会兑现的值：非法 'bogus' 归一到 deny 显示；也不存在第 4 档
      const effects = await task
        .locator("[data-effect]")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-effect")));
      expect(effects).toEqual(["allow", "ask", "deny"]);
      await expect(task.locator('[data-effect="bogus"]')).toHaveCount(0);
      await expect(task.locator('[data-effect="deny"]')).toHaveAttribute("aria-checked", "true");
      // 本行唯一写入口是三档 chip，无自由文本输入
      await expect(row(page, "task").locator("input, textarea, select")).toHaveCount(0);

      // 点击必然写穿：非法存量值被合法值替换（不是静默 no-op）
      await task.locator('[data-effect="allow"]').click();
      await expect
        .poll(() => storedTask(request, token, policyId), { timeout: 10_000 })
        .toBe("allow");
      const pageError = page.getByTestId("policy-save-error");
      recordEvidence({
        test: "illegal_value_never_shown_click_writes_through",
        agent: agent.id,
        injected_stored: "bogus",
        rendered_effects: effects,
        rendered_checked: "deny",
        click_result_stored: "allow",
        server_error_surface_present_without_error: (await pageError.count()) === 0,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });
});
