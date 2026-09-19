import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * agent-role-decommission Todo 4 · 新建 Agent 岗位选择器
 * （原 agent-native-permission-editor Todo 6 的 `role` 选择器迁移）
 * ============================================================
 * 覆盖 `CreateAgentModal` 的岗位下拉（data-testid=create-agent-role）：
 *  A. 选项集：值全部来自 `GET /agent-roles` 的 AgentRole.id（前缀 `ar_`），
 *     plan 不提供、旧 role 字符串（"developer" 等）绝不出现；首项「无」value=""。
 *  B. 选中开发岗位：新建成功后 agent 绑定的策略是该岗位 defaultAgentId 指向
 *     Agent 的能力集深拷贝——`permission.edit['**tasks/* /**']='allow'`、
 *     `permission.bash='allow'`、tools 非空——不是骨架。
 *  C. 「无」（默认）：绑定策略是 deny-by-default 骨架
 *     —— `permission.edit` 只有 `{'*':'deny'}`、`bash='deny'`、`tools={}`。
 *  D. 提交体判别：请求体**绝不含 `role` 键**（该键已被 whitelist 管道静默剥离，
 *     信它等于信一个到不了 service 的字段）；「无」不含 `agentRoleId`（undefined 不发），
 *     选中岗位时含 `agentRoleId:"ar_developer"`；绝不出现 `role:""`。
 *  E. 「无」再选回岗位：状态重置有效（下拉受控值往返）。
 *
 * 判别性（MUST DO）：断言 B 直接读服务端回包 `effectivePermission` 与落库策略
 * config；若前端停发 agentRoleId（或仍投旧 role），后端走骨架路径，
 * B 的 edit/bash/tools 断言必然失败。
 *
 * 运行（仓库根）：`bash scripts/e2e-create-agent-role.sh`
 * （独立 tmp config，不碰 playwright.config.ts；baseURL 指向 compose web :13001）
 */

const SERVER_URL = "http://localhost:13000";
const RUN_TAG = `t4-${Date.now().toString(36)}`;

type CreatedAgent = {
  id: string;
  name: string;
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
  fields: { name: string; agentKey: string; agentRoleId?: string },
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
  if (fields.agentRoleId !== undefined) {
    await page.getByTestId("create-agent-role").selectOption(fields.agentRoleId);
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

/** 读 `GET /agent-roles` 的岗位行（唯一数据路径），断言 id 是 ar_ 前缀而非旧 role 字符串。 */
async function roleRows(
  request: APIRequestContext,
): Promise<{ id: string; key: string; name: string }[]> {
  const res = await request.get(`${SERVER_URL}/api/v1/agent-roles?pageSize=100`, {
    headers: authHeaders(await adminToken(request)),
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { items: { id: string; key: string; name: string }[] }).items;
}

async function roleIdOf(request: APIRequestContext, key: string): Promise<string> {
  const row = (await roleRows(request)).find((r) => r.key === key);
  expect(row).toBeTruthy();
  expect(row!.id.startsWith("ar_")).toBe(true);
  return row!.id;
}

test.describe("Todo 4 · 新建 Agent 岗位选择器（agentRoleId）", () => {
  test("1. 选项集来自 /agent-roles（ar_ id）；plan 不提供、旧 role 字符串不出现", async ({
    page,
    request,
  }) => {
    const rows = await roleRows(request);
    const devRoleId = await roleIdOf(request, "developer");
    await loginAsAdmin(page);
    await openCreateModal(page);
    const select = page.getByTestId("create-agent-role");
    // 选项异步装载（GET /agent-roles）：等待真实岗位出现
    await expect
      .poll(async () => (await optionValues(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const values = await optionValues(page);
    expect(values[0]).toBe("");
    expect(values).toContain(devRoleId);
    // 选项集 = 弹窗键集（CREATE_ROLE_KEYS 去掉 plan）∩ /agent-roles 现有行；
    // 自定义岗位（如 ar_general，无 defaultAgentId）不在选项集内。
    const createKeys = rows.filter((r) =>
      ["product", "project_manager", "architect", "developer", "tester"].includes(r.key),
    );
    expect([...values.filter((v) => v !== "")].sort()).toEqual(
      createKeys.map((r) => r.id).sort(),
    );
    expect(values).not.toContain("plan");
    expect(values).not.toContain("developer");
    const labels = await select
      .locator("option")
      .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).textContent ?? ""));
    expect(labels[0]).toContain("无");
    expect(labels.some((l) => l.includes("开发"))).toBe(true);
    expect(labels.join("|")).not.toContain("计划");
    await expect(select).toHaveValue("");
    await select.selectOption(devRoleId);
    await page.setViewportSize({ width: 900, height: 980 });
    await page.locator("#agent-role").scrollIntoViewIfNeeded();
    await save(process.env.T6_SCREENSHOT, page);
    recordEvidence({
      test: "options",
      offered: values,
      labels,
      plan_offered: values.includes("plan"),
      role_string_values_offered: values.includes("developer"),
      default_selected: "",
    });
  });

  test("2. 选中开发岗位 → 继承其默认 Agent 能力集（非骨架）", async ({ page, request }) => {
    const devRoleId = await roleIdOf(request, "developer");
    await loginAsAdmin(page);
    await openCreateModal(page);
    await expect
      .poll(async () => (await optionValues(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const { body, created } = await submitCreate(page, {
      name: `t4 开发者 ${RUN_TAG}`,
      agentKey: `t4-dev-${RUN_TAG}`,
      agentRoleId: devRoleId,
    });

    const agent: CreatedAgent = { ...created, name: `t4 开发者 ${RUN_TAG}` };
    const ep = agent.effectivePermission;
    expect(ep).not.toBeNull();
    expect(ep!.permission.edit?.["**tasks/*/**"]).toBe("allow");
    expect(ep!.permission.edit?.["*"]).toBe("deny");
    expect(ep!.permission.bash).toBe("allow");
    expect(Object.keys(ep!.tools).length).toBeGreaterThan(0);

    // 请求契约：选中岗位发 agentRoleId；绝不发旧 role 键
    expect(body.agentRoleId).toBe(devRoleId);
    expect(body).not.toHaveProperty("role");
    expect(body.type).toBe("custom");

    // 落库策略 config 同形（深拷贝岗位模板，非共享 template 行）
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
      request_body_agentRoleId: body.agentRoleId,
      request_body_role_present: Object.prototype.hasOwnProperty.call(body, "role"),
      agent: { id: agent.id, policyId: agent.policyId },
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
    const { body, created } = await submitCreate(page, {
      name: `t4 骨架 ${RUN_TAG}`,
      agentKey: `t4-none-${RUN_TAG}`,
    });
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("agentRoleId");
    expect(JSON.stringify(body)).not.toContain('"role":""');

    const token = await adminToken(request);
    const agent: CreatedAgent = { ...created, name: `t4 骨架 ${RUN_TAG}` };
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
      request_body_agentRoleId_present: Object.prototype.hasOwnProperty.call(
        body,
        "agentRoleId",
      ),
      agent: { id: agent.id, policyId: agent.policyId },
      effectivePermission: ep,
      skeleton: {
        edit: ep!.permission.edit,
        bash: ep!.permission.bash,
        tools: ep!.tools,
      },
    });
    console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
  });

  test("4. 下拉往返：岗位 → 无 → 岗位 重置有效", async ({ page, request }) => {
    const devRoleId = await roleIdOf(request, "developer");
    const testerId = await roleIdOf(request, "tester");
    await loginAsAdmin(page);
    await openCreateModal(page);
    const select = page.getByTestId("create-agent-role");
    await expect
      .poll(async () => (await optionValues(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    await select.selectOption(devRoleId);
    await expect(select).toHaveValue(devRoleId);
    await select.selectOption("");
    await expect(select).toHaveValue("");
    await select.selectOption(testerId);
    await expect(select).toHaveValue(testerId);
    // 关闭再打开：重置回「无」
    await page.getByTestId("create-agent-close").click();
    await page.getByTestId("create-agent-button").click();
    await expect(page.getByTestId("create-agent-role")).toHaveValue("");
    recordEvidence({ test: "roundtrip_reset", values: [devRoleId, "", testerId, "reopen:"] });
  });
});
