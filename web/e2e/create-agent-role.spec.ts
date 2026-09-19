import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * agent-native-permission-editor Todo 6 · 新建 Agent 角色选择器
 * ============================================================
 * 覆盖 `CreateAgentModal` 新增的角色下拉（data-testid=create-agent-role）：
 *  A. 选项集：恰好 6 项 = 「无」 + 5 个角色（product/project_manager/
 *     architect/developer/tester）；`plan` 不提供。
 *  B. role=developer：新建成功后，agent 绑定的策略是该角色的能力集
 *     —— `permission.edit['**tasks/* /**']='allow'`（可写任务工作区）、
 *     `permission.bash='allow'`、`tools` 非空（27 条 allow）——不是骨架。
 *  C. 「无」（默认）：绑定策略是 deny-by-default 骨架
 *     —— `permission.edit` 只有 `{'*':'deny'}`、`bash='deny'`、`tools={}`。
 *  D. 提交体判别：「无」时请求体不含 `role` 键（undefined 不发），
 *     developer 时含 `role:"developer"`；绝不出现 `role:""`。
 *  E. 「无」再选回 developer：状态重置有效（下拉受控值往返）。
 *
 * 判别性（MUST DO）：断言 B 直接读服务端回包 `effectivePermission` 与
 * 落库策略 config；若前端停发 role，后端走 `dto.role ?? null` → 骨架，
 * B 的 edit/bash/tools 断言必然失败（见 learnings.md 的 mutation 记录）。
 *
 * 运行（仓库根）：`bash scripts/e2e-create-agent-role.sh`
 * （独立 tmp config，不碰 playwright.config.ts；baseURL 指向 compose web :13001）
 */

const SERVER_URL = "http://localhost:13000";
const RUN_TAG = `t6-${Date.now().toString(36)}`;

type CreatedAgent = {
  id: string;
  name: string;
  role: string | null;
  policyId: string;
  effectivePermission: {
    agentName: string;
    policyId: string;
    permission: { edit?: Record<string, string>; bash?: string; task?: string };
    tools: Record<string, string>;
  } | null;
};

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
}

async function openCreateModal(page: Page) {
  await page.goto("/agents");
  await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("create-agent-button").click();
  await expect(page.getByTestId("create-agent-modal")).toBeVisible();
}

function optionValues(page: Page) {
  return page.getByTestId("create-agent-role").locator("option").evaluateAll((els) =>
    els.map((e) => (e as HTMLOptionElement).value),
  );
}

/** 填必填字段并提交；返回捕获到的 POST /agents 请求体与 201 响应体。 */
async function submitCreate(
  page: Page,
  fields: { name: string; agentKey: string; role?: string },
): Promise<{ body: Record<string, unknown>; created: CreatedAgent }> {
  const caught: Record<string, unknown>[] = [];
  await page.route("**/api/v1/agents", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    caught.push(JSON.parse(route.request().postData() || "{}"));
    return route.fallback();
  });
  const responsePromise = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/api\/v1\/agents$/.test(new URL(r.url()).pathname),
  );
  await page.getByTestId("agent-name-input").fill(fields.name);
  await page.getByTestId("agent-key-input").fill(fields.agentKey);
  if (fields.role !== undefined) {
    await page.getByTestId("create-agent-role").selectOption(fields.role);
  }
  await page.getByTestId("create-agent-confirm").click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const created = (await response.json()) as CreatedAgent;
  await expect(page.getByTestId("create-agent-modal")).toHaveCount(0, { timeout: 15_000 });
  expect(caught).toHaveLength(1);
  return { body: caught[0], created };
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await request.post(`${SERVER_URL}/api/v1/auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(login.ok()).toBeTruthy();
  return ((await login.json()) as { accessToken: string }).accessToken;
}

/** 删除测试创建的 agent（联动删除其 custom 策略）；返回清理收据。 */
async function deleteAgent(
  request: APIRequestContext,
  token: string,
  agent: CreatedAgent,
): Promise<string> {
  const del = await request.delete(`${SERVER_URL}/api/v1/agents/${agent.id}`, {
    headers: authHeaders(token),
  });
  const policyDel = await request.delete(
    `${SERVER_URL}/api/v1/execution-policies/${agent.policyId}`,
    { headers: authHeaders(token) },
  );
  const gone = await request.get(`${SERVER_URL}/api/v1/agents/${agent.id}`, {
    headers: authHeaders(token),
  });
  return `${agent.id} (agent ${del.status()}, policy ${agent.policyId} ${policyDel.status()}, re-GET ${gone.status()})`;
}

async function save(path: string | undefined, page: Page) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
}

/** 追加一条 JSON 证据到 T6_EVIDENCE_JSON（数组文件；不存在则初始化为 []）。 */
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

test.describe("Todo 6 · 新建 Agent 角色选择器", () => {
  test("1. 选项集 = 「无」 + 五角色，plan 不提供", async ({ page }) => {
    await loginAsAdmin(page);
    await openCreateModal(page);
    const values = await optionValues(page);
    expect(values).toEqual([
      "",
      "product",
      "project_manager",
      "architect",
      "developer",
      "tester",
    ]);
    expect(values).not.toContain("plan");
    const labels = await page
      .getByTestId("create-agent-role")
      .locator("option")
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).textContent ?? ""));
    expect(labels[0]).toContain("无");
    expect(labels.some((l) => l.includes("开发"))).toBe(true);
    expect(labels.join("|")).not.toContain("计划");
    // 默认选中「无」（骨架语义）
    await expect(page.getByTestId("create-agent-role")).toHaveValue("");
    await page.getByTestId("create-agent-role").selectOption("developer");
    await page.setViewportSize({ width: 900, height: 980 });
    await page.locator("#agent-role").scrollIntoViewIfNeeded();
    await save(process.env.T6_SCREENSHOT, page);
    recordEvidence({
      test: "options",
      offered: values,
      labels,
      plan_offered: values.includes("plan"),
      default_selected: "",
    });
  });

  test("2. role=developer → 继承开发者能力集（非骨架）", async ({ page, request }) => {
    await loginAsAdmin(page);
    await openCreateModal(page);
    const { body, created } = await submitCreate(page, {
      name: `t6 开发者 ${RUN_TAG}`,
      agentKey: `t6-dev-${RUN_TAG}`,
      role: "developer",
    });

    const agent: CreatedAgent = { ...created, name: `t6 开发者 ${RUN_TAG}` };
    const ep = agent.effectivePermission;
    expect(ep).not.toBeNull();
    expect(ep!.permission.edit?.["**tasks/*/**"]).toBe("allow");
    expect(ep!.permission.edit?.["*"]).toBe("deny");
    expect(ep!.permission.bash).toBe("allow");
    expect(Object.keys(ep!.tools).length).toBeGreaterThan(0);
    expect(agent.role).toBe("developer");

    // 请求契约：「无」不发 role，选中角色才发
    expect(body.role).toBe("developer");
    expect(body.type).toBe("custom");

    // 落库策略 config 同形（深拷贝模板，非共享 template 行）
    const token = await adminToken(request);
    const policy = (await (
      await request.get(`${SERVER_URL}/api/v1/execution-policies/${agent.policyId}`, {
        headers: authHeaders(token),
      })
    ).json()) as { id: string; type: string; config: { permission: Record<string, unknown> } };
    expect(agent.policyId).not.toBe("ep_developer");
    expect(policy.type).toBe("custom");
    expect(policy.config.permission.edit).toMatchObject({
      "*": "deny",
      "**tasks/*/**": "allow",
    });

    await page.goto("/agents");
    await page.getByTestId("agent-config-root").waitFor();
    await page.getByText(agent.name, { exact: false }).first().click();
    await expect(page.getByTestId("effective-permission-section")).toBeVisible({
      timeout: 15_000,
    });
    await save(process.env.T6_SCREENSHOT_DEV_PANEL, page);
    recordEvidence({
      test: "developer",
      request_body_role: body.role,
      agent: { id: agent.id, role: agent.role, policyId: agent.policyId },
      effectivePermission: ep,
      stored_policy: {
        id: policy.id,
        type: policy.type,
        edit: policy.config.permission.edit,
      },
      inherited_not_skeleton: true,
    });
    console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
  });

  test("3. 「无」→ 骨架策略（deny-by-default）", async ({ page, request }) => {
    await loginAsAdmin(page);
    await openCreateModal(page);
    // 不选角色 = 默认「无」
    const { body, created } = await submitCreate(page, {
      name: `t6 骨架 ${RUN_TAG}`,
      agentKey: `t6-none-${RUN_TAG}`,
    });
    expect(body).not.toHaveProperty("role");
    expect(JSON.stringify(body)).not.toContain('"role":""');

    const token = await adminToken(request);
    const agent: CreatedAgent = { ...created, name: `t6 骨架 ${RUN_TAG}` };
    expect(agent.role).toBeNull();
    const ep = agent.effectivePermission;
    expect(ep).not.toBeNull();
    expect(ep!.permission.edit).toEqual({ "*": "deny" });
    expect(ep!.permission.bash).toBe("deny");
    expect(ep!.tools).toEqual({});
    await page.goto("/agents");
    await page.getByTestId("agent-config-root").waitFor();
    await page.getByText(agent.name, { exact: false }).first().click();
    await expect(page.getByTestId("effective-permission-section")).toBeVisible({
      timeout: 15_000,
    });
    await save(process.env.T6_SCREENSHOT_NONE_PANEL, page);
    recordEvidence({
      test: "none",
      request_body_role_present: Object.prototype.hasOwnProperty.call(body, "role"),
      agent: { id: agent.id, role: agent.role, policyId: agent.policyId },
      effectivePermission: ep,
      skeleton: {
        edit: ep!.permission.edit,
        bash: ep!.permission.bash,
        tools: ep!.tools,
      },
    });
    console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
  });

  test("4. 下拉往返：developer → 无 → developer 重置有效", async ({ page }) => {
    await loginAsAdmin(page);
    await openCreateModal(page);
    const select = page.getByTestId("create-agent-role");
    await select.selectOption("developer");
    await expect(select).toHaveValue("developer");
    await select.selectOption("");
    await expect(select).toHaveValue("");
    await select.selectOption("tester");
    await expect(select).toHaveValue("tester");
    // 关闭再打开：重置回「无」
    await page.getByTestId("create-agent-close").click();
    await page.getByTestId("create-agent-button").click();
    await expect(page.getByTestId("create-agent-role")).toHaveValue("");
    recordEvidence({ test: "roundtrip_reset", values: ["developer", "", "tester", "reopen:"] });
  });
});
