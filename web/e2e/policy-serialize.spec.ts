import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * agent-native-permission-editor Todo 4 · 策略写入串行化（防丢失更新）
 * ==================================================================
 * 判别性核心（MUST DO）：测试 1 先切 bash 再立即新增 edit 规则，断言**服务端存储**同时含两处
 * 改动——写入载荷若来自 render 闭包（旧 mutation 的 `effective.permission`）而非 configRef
 * 权威配置，第二次写入会把第一次的改动打回，本测试必然失败（mutation 记录见 learnings.md）。
 * 测试 2 用 page.route 挂起 PATCH，断言在途期间原生编辑器 + bash + 全部 MCP 工具行禁用。
 * 测试 4 用击键 burst 断言 debounce 合并为单次 PATCH（每击键一写会数到 N 次）。
 *
 * 运行（仓库根）：`bash scripts/e2e-policy-serialize.sh`
 * （独立 tmp config，不碰 playwright.config.ts；baseURL 指向 compose web :13001）
 */

const SERVER_URL = "http://localhost:13000";
const RUN_TAG = `t4-${Date.now().toString(36)}`;

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
  bashDeny?: unknown;
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
    data: { name: `t4 ${suffix} ${RUN_TAG}`, agentKey: `t4-${suffix}-${RUN_TAG}`, type: "custom" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ApiAgent;
}

async function patchPolicy(
  request: APIRequestContext,
  token: string,
  agent: ApiAgent,
  permission: Record<string, unknown>,
  bashDeny?: string[],
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
        ...(bashDeny !== undefined ? { bashDeny } : {}),
      },
    },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** 读服务端存储的整份 config（丢失更新判定的唯一事实来源）。 */
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

function ruleRow(page: Page, name: "edit" | "read", glob: string) {
  return page.locator(
    `[data-testid="native-rule-editor"][data-native="${name}"] [data-testid="native-rule-row"][data-glob="${glob}"]`,
  );
}

function editor(page: Page, name: "edit" | "read") {
  return page.locator(`[data-testid="native-rule-editor"][data-native="${name}"]`);
}

function recordEvidence(entry: Record<string, unknown>) {
  const path = process.env.T4_EVIDENCE_JSON;
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

test.describe("Todo 4 · 策略写入串行化", () => {
  test("1. 无丢失更新：bash 切换 + 新增 edit 规则同存（服务端为准 + 刷新可见）", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "lu");
    const policyId = agent.effectivePermission!.policyId;
    const patchUrls: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes("/execution-policies/")) {
        patchUrls.push(req.url());
      }
    });
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      // (a) bash 先改为 allow（原生编辑：debounce 落盘）
      const bash = page.getByTestId("native-bash-effect");
      await bash.locator('[data-effect="allow"]').click();
      await expect(bash.locator('[data-effect="allow"]')).toHaveAttribute("aria-checked", "true");

      // (b) 立即新增 edit 规则（首击键取消挂起的 bash debounce，合并为一次写）
      const editEditor = editor(page, "edit");
      await editEditor.getByTestId("native-rule-add").click();
      await editEditor
        .locator('[data-testid="native-rule-glob"]')
        .last()
        .pressSequentially("src/**", { delay: 15 });
      await expect(ruleRow(page, "edit", "src/**")).toBeVisible();

      // 服务端存储必须同时含两处改动（旧闭包载荷会把 bash 打回 deny / 丢掉新规则）
      await expect
        .poll(
          async () => {
            const cfg = await storedConfig(request, token, policyId);
            const edit = cfg.permission.edit as Record<string, unknown>;
            return `${String(cfg.permission.bash)}|${String(edit["src/**"])}`;
          },
          { timeout: 10_000 },
        )
        .toBe("allow|deny");

      // 刷新后两处改动都可见（回读路径生效）
      await page.reload();
      await page.getByTestId("agent-config-root").waitFor({ timeout: 20_000 });
      await page.getByText(agent.name, { exact: false }).first().click();
      await expect(page.getByTestId("effective-permission-section")).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByTestId("native-bash-effect").locator('[data-effect="allow"]'),
      ).toHaveAttribute("aria-checked", "true");
      await expect(ruleRow(page, "edit", "src/**")).toBeVisible();

      recordEvidence({
        test: "no_lost_update",
        agent: agent.id,
        policy_id: policyId,
        stored_after: { bash: "allow", edit_src: "deny" },
        patch_count: patchUrls.length,
        reload_visible: true,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("2. 单一在途闸门：PATCH 挂起期间全部控件禁用，释放后恢复", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "gate");
    const policyId = agent.effectivePermission!.policyId;
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny", src: "allow" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);
      await page.getByTestId("effective-mcp-tool").first().waitFor({ timeout: 20_000 });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = 0;
      await page.route("**/api/v1/execution-policies/**", async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        held += 1;
        await gate;
        await route.continue();
      });

      // 触发一次立即写（工具切换无 debounce）
      const toolRow = page
        .locator('[data-testid="effective-mcp-tool"][data-tool="vteam_chat_history"]');
      await toolRow.scrollIntoViewIfNeeded();
      const toolSelect = toolRow.locator('[data-testid="tool-effect-select"]');
      await expect(toolSelect.locator('[data-effect="allow"]')).toHaveAttribute(
        "aria-disabled",
        "false",
      );
      await toolSelect.locator('[data-effect="allow"]').click();
      await expect.poll(() => held, { timeout: 10_000 }).toBe(1);

      try {
        // 原生编辑器：非兜底 glob 输入 + effect chips + add 按钮全部禁用
        await expect(ruleRow(page, "edit", "src").getByTestId("native-rule-glob")).toBeDisabled();
        await expect(
          editor(page, "edit").locator('[data-testid="native-rule-effect"]').first(),
        ).toHaveAttribute("aria-disabled", "true");
        await expect(editor(page, "edit").getByTestId("native-rule-add")).toBeDisabled();
        // bash 三态禁用
        await expect(page.getByTestId("native-bash-effect").locator('[data-effect="ask"]')).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        // 全部 MCP 工具行禁用（含未在写入中的那一行）
        await expect(toolSelect.locator('[data-effect="deny"]')).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await expect(
          page
            .locator('[data-testid="effective-mcp-tool"][data-tool="vteam_task_context"]')
            .locator('[data-testid="tool-effect-select"] [data-effect="allow"]'),
        ).toHaveAttribute("aria-disabled", "true");
      } finally {
        release();
      }

      // 释放后恢复可交互并落盘
      await expect(toolSelect.locator('[data-effect="allow"]')).toHaveAttribute(
        "aria-disabled",
        "false",
      );
      await expect(
        page.getByTestId("native-bash-effect").locator('[data-effect="allow"]'),
      ).toHaveAttribute("aria-disabled", "false");
      await expect
        .poll(
          async () => {
            const cfg = await storedConfig(request, token, policyId);
            return String((cfg.tools as Record<string, unknown>)["vteam_chat_history"]);
          },
          { timeout: 10_000 },
        )
        .toBe("allow");

      recordEvidence({
        test: "inflight_gate_disables_all",
        agent: agent.id,
        policy_id: policyId,
        patched_tool: "vteam_chat_history",
        native_input_disabled: true,
        native_chips_disabled: true,
        bash_chips_disabled: true,
        all_mcp_selects_disabled: true,
        re_enabled_after_release: true,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("3. 原生编辑持久化：bash 切 allow 刷新后仍为 allow", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "persist");
    const policyId = agent.effectivePermission!.policyId;
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny" },
        read: { "*": "allow" },
        bash: "ask",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);
      const bash = page.getByTestId("native-bash-effect");
      await expect(bash.locator('[data-effect="ask"]')).toHaveAttribute("aria-checked", "true");
      await bash.locator('[data-effect="allow"]').click();
      await expect(bash.locator('[data-effect="allow"]')).toHaveAttribute("aria-checked", "true");

      // debounce(400ms) + PATCH 落盘
      await expect
        .poll(
          async () => String((await storedConfig(request, token, policyId)).permission.bash),
          { timeout: 10_000 },
        )
        .toBe("allow");

      await page.reload();
      await page.getByTestId("agent-config-root").waitFor({ timeout: 20_000 });
      await page.getByText(agent.name, { exact: false }).first().click();
      await expect(page.getByTestId("native-bash-effect")).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByTestId("native-bash-effect").locator('[data-effect="allow"]'),
      ).toHaveAttribute("aria-checked", "true");

      recordEvidence({
        test: "native_edit_persists",
        agent: agent.id,
        policy_id: policyId,
        stored_bash: "allow",
        reload_selected: "allow",
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("4. debounce 合并击键 burst：一次 burst 仅一个 PATCH", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "debounce");
    const policyId = agent.effectivePermission!.policyId;
    const patchUrls: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes("/execution-policies/")) {
        patchUrls.push(req.url());
      }
    });
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      const editEditor = editor(page, "edit");
      await editEditor.getByTestId("native-rule-add").click();
      // 逐击键输入：每击键都会 commit → 无 debounce 时每个字符一个 PATCH
      await editEditor
        .locator('[data-testid="native-rule-glob"]')
        .last()
        .pressSequentially("abc", { delay: 25 });

      await expect
        .poll(
          async () => {
            const cfg = await storedConfig(request, token, policyId);
            return String((cfg.permission.edit as Record<string, unknown>)["abc"]);
          },
          { timeout: 10_000 },
        )
        .toBe("deny");
      expect(patchUrls).toHaveLength(1);

      recordEvidence({
        test: "debounce_coalesces",
        agent: agent.id,
        policy_id: policyId,
        keystrokes: 3,
        patch_count: patchUrls.length,
        stored_edit_abc: "deny",
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  /**
   * Todo 11（F2 发现的数据丢失）：编辑器整份 config PATCH 必须透传 `bashDeny`。
   * 判别性核心：断言「服务端存储的 bashDeny 未被编辑器写盘抹掉」——修复前载荷类型只有
   * `{permission, correction, tools}`，任何一次原生编辑都会把该键整份覆盖丢弃。
   * 负控：无 bashDeny 的策略编辑后不得凭空获得该键（服务端解析值恒为数组，空数组必须在
   * 载荷中省略，否则落库 JSON 会被物化出 `bashDeny: []`）。
   */
  test("5. 整份 config 写回保留 bashDeny；无该字段的策略不凭空获得", async ({ page, request }) => {
    const token = await adminToken(request);
    const withDeny = await createAgent(request, token, "bashdeny");
    const withoutDeny = await createAgent(request, token, "nobashdeny");
    const denyPolicyId = withDeny.effectivePermission!.policyId;
    const plainPolicyId = withoutDeny.effectivePermission!.policyId;
    const denyPattern = ["rm -rf /"];
    try {
      // API 预置：一个带 bashDeny 的策略 + 一个不带（走编辑器默认骨架）的策略
      await patchPolicy(
        request,
        token,
        withDeny,
        { edit: { "*": "deny" }, read: { "*": "allow" }, bash: "deny", task: "deny" },
        denyPattern,
      );
      await patchPolicy(request, token, withoutDeny, {
        edit: { "*": "deny" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      const before = await storedConfig(request, token, denyPolicyId);
      expect(before.bashDeny).toEqual(denyPattern);
      const plainBefore = await storedConfig(request, token, plainPolicyId);
      expect("bashDeny" in plainBefore).toBe(false);

      await loginAsAdmin(page);

      // (a) 带 bashDeny 的策略：通过真实 UI 编辑一个无关权限（新增 edit glob 规则）
      await openAgent(page, withDeny.name);
      const editEditor = editor(page, "edit");
      await editEditor.getByTestId("native-rule-add").click();
      await editEditor
        .locator('[data-testid="native-rule-glob"]')
        .last()
        .pressSequentially("src/t11/**", { delay: 15 });
      await expect(ruleRow(page, "edit", "src/t11/**")).toBeVisible();
      await expect
        .poll(
          async () => {
            const cfg = await storedConfig(request, token, denyPolicyId);
            return `${String((cfg.permission.edit as Record<string, unknown>)["src/t11/**"])}|${JSON.stringify(cfg.bashDeny)}`;
          },
          { timeout: 10_000 },
        )
        .toBe(`deny|${JSON.stringify(denyPattern)}`);

      // (b) 不带 bashDeny 的策略：同样经 UI 编辑，落库 JSON 不得出现该键
      await openAgent(page, withoutDeny.name);
      await page.getByTestId("native-bash-effect").locator('[data-effect="allow"]').click();
      await expect
        .poll(
          async () => String((await storedConfig(request, token, plainPolicyId)).permission.bash),
          { timeout: 10_000 },
        )
        .toBe("allow");
      const plainAfter = await storedConfig(request, token, plainPolicyId);
      expect("bashDeny" in plainAfter).toBe(false);

      const shot = process.env.T11_SCREENSHOT;
      if (shot) {
        mkdirSync(dirname(shot), { recursive: true });
        await page.screenshot({ path: shot, fullPage: true });
      }

      recordEvidence({
        test: "bashdeny_survives_whole_config_save",
        agent_with_bashdeny: withDeny.id,
        policy_with_bashdeny: denyPolicyId,
        agent_without_bashdeny: withoutDeny.id,
        policy_without_bashdeny: plainPolicyId,
        bashDeny_after_ui_edit: (await storedConfig(request, token, denyPolicyId)).bashDeny,
        unrelated_edit: { edit_src_t11: "deny" },
        negative_control_key_absent: !("bashDeny" in plainAfter),
        negative_control_bash_after_ui_edit: plainAfter.permission.bash,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, withDeny)}`);
      console.log(`[cleanup] ${await deleteAgent(request, token, withoutDeny)}`);
    }
  });
});
