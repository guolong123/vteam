import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * agent-native-permission-editor Todo 3 · 原生 glob 规则表编辑器
 * ==============================================================
 * 覆盖 agents 页「生效权限」四个原生行（edit/read/bash/task）从只读徽章变为：
 *  - edit/read：glob 规则表编辑器（`*` 兜底行恒在且置首、锁定 glob；添加/删除规则；
 *    客户端镜像 server 校验：非空 / ≤256 / ≤64 / 无重复）；
 *  - bash：三态分段（native-bash-effect）；
 *  - task：只读 + 引擎限制说明（native-task-note）；
 *  - 缺失键（如 task absent）仍渲染四行。
 *
 * 判别性（MUST DO）：测试 3 用 `{ '*':'deny','x':'ask' }` 断言 `ask` 不被归一化，
 * 且编辑循环（加 y → 删 y）后 `x` 仍为 `ask`、`*` 仍置首；测试 5 断言重复 glob
 * 被客户端拒绝（提交面条数不变）。若编辑器误用 normalizeToolEffect 或丢失兜底行序，
 * 这些断言必然失败（见 learnings.md 的 mutation 记录）。
 *
 * 运行（仓库根）：`bash scripts/e2e-native-rule-editor.sh`
 * （独立 tmp config，不碰 playwright.config.ts；baseURL 指向 compose web :13001）
 */

const SERVER_URL = "http://localhost:13000";
const RUN_TAG = `t3-${Date.now().toString(36)}`;

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

/** 建自定义 agent（无角色=骨架），返回完整条目。 */
async function createAgent(
  request: APIRequestContext,
  token: string,
  suffix: string,
): Promise<ApiAgent> {
  const res = await request.post(`${SERVER_URL}/api/v1/agents`, {
    headers: authHeaders(token),
    data: { name: `t3 ${suffix} ${RUN_TAG}`, agentKey: `t3-${suffix}-${RUN_TAG}`, type: "custom" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as ApiAgent;
}

/** 直接 PATCH 策略 config（测试夹具：制造 absent/ask 等存储形态）。 */
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

/** 在 agents 页选中指定 agent（按列表文本点击）。 */
async function openAgent(page: Page, name: string) {
  await page.goto("/agents");
  await page.getByTestId("agent-config-root").waitFor({ timeout: 20_000 });
  await page.getByText(name, { exact: false }).first().click();
  await expect(page.getByTestId("effective-permission-section")).toBeVisible({ timeout: 20_000 });
}

function row(page: Page, key: string) {
  return page.locator(`[data-testid="effective-permission-row"][data-key="${key}"]`);
}

function editor(page: Page, name: "edit" | "read") {
  return page.locator(`[data-testid="native-rule-editor"][data-native="${name}"]`);
}

/** 规则行（编辑态）按 glob 定位。 */
function ruleRow(page: Page, name: "edit" | "read", glob: string) {
  return editor(page, name).locator(`[data-testid="native-rule-row"][data-glob="${glob}"]`);
}

async function save(path: string | undefined, page: Page) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

/** 直写 DB 注入非三态 effect 值（API 正确拒绝该形态；未知值只可能来自存量行）。 */
function injectUnknownEffect(policyId: string, glob: string, effect: string) {
  const sql = `UPDATE execution_policies SET config=JSON_SET(config, '$.permission.edit.${glob}', '${effect}') WHERE id='${policyId}';`;
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

function recordEvidence(entry: Record<string, unknown>) {
  const path = process.env.T3_EVIDENCE_JSON;
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

test.describe("Todo 3 · 原生 glob 规则表编辑器", () => {
  test("1. 四行恒显 + 编辑器形态（模板 agent）", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/agents");
    await page.getByTestId("agent-config-root").waitFor({ timeout: 20_000 });
    await page.getByText("产品经理", { exact: false }).first().click();
    await expect(page.getByTestId("effective-permission-section")).toBeVisible({ timeout: 20_000 });

    const rows = page.locator('[data-testid="effective-permission-row"]');
    await expect(rows).toHaveCount(4);
    const keys = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
    expect(keys).toEqual(["edit", "read", "bash", "task"]);

    const editEditor = editor(page, "edit");
    const readEditor = editor(page, "read");
    await expect(editEditor).toBeVisible();
    await expect(readEditor).toBeVisible();
    await expect(editEditor).toHaveAttribute("data-readonly", "false");
    await expect(readEditor).toHaveAttribute("data-readonly", "false");
    const bash = page.getByTestId("native-bash-effect");
    await expect(bash).toBeVisible();
    await expect(bash).toHaveAttribute("data-readonly", "false");

    // `*` 兜底行置首 + glob 锁定 + 无删除按钮
    const firstRow = editEditor.locator('[data-testid="native-rule-row"]').first();
    await expect(firstRow).toHaveAttribute("data-glob", "*");
    await expect(firstRow.locator('[data-testid="native-catchall-glob"]')).toBeDisabled();
    await expect(firstRow.locator('[data-testid="native-rule-remove"]')).toHaveCount(0);

    // task 只读 + 说明
    await expect(row(page, "task").locator('[data-testid="native-task-note"]')).toBeVisible();

    // bash 三态齐备
    const effects = await bash.locator('[data-effect]').evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-effect")),
    );
    expect(effects).toEqual(["allow", "ask", "deny"]);

    await save(process.env.T3_SCREENSHOT, page);
    recordEvidence({
      test: "four_rows_template",
      keys,
      edit_readonly: await editEditor.getAttribute("data-readonly"),
      read_readonly: await readEditor.getAttribute("data-readonly"),
      bash_effects: effects,
      catchall_first: true,
      task_note: true,
    });
  });

  test("2. absent task 仍渲染（只读 + note）", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "absent");
    try {
      // permission 无 task 键；read 也移除（同时覆盖两处 absent 渲染）。
      await patchPolicy(request, token, agent, { edit: { "*": "deny" }, bash: "deny" });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      await expect(page.locator('[data-testid="effective-permission-row"]')).toHaveCount(4);
      const taskRow = row(page, "task");
      await expect(taskRow).toBeVisible();
      await expect(taskRow.locator('[data-testid="native-task-note"]')).toBeVisible();
      await expect(page.getByTestId("native-bash-effect")).toBeVisible();
      // read 缺失 → seed {'*':'allow'} 展示
      const readFirst = editor(page, "read").locator('[data-testid="native-rule-row"]').first();
      await expect(readFirst).toHaveAttribute("data-glob", "*");
      await expect(
        readFirst.locator('[data-testid="native-rule-effect"][aria-checked="true"]'),
      ).toHaveAttribute("data-effect", "allow");
      const readStarEffect = await readFirst
        .locator('[data-testid="native-rule-effect"][aria-checked="true"]')
        .getAttribute("data-effect");
      recordEvidence({
        test: "absent_task",
        agent: agent.id,
        stored_permission: { edit: { "*": "deny" }, bash: "deny" },
        task_row_rendered: true,
        read_seed_effect: readStarEffect,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("3. 往返不归一化：{ '*':'deny', x:'ask' } 编辑循环后 ask 仍 ask", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "rt");
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny", x: "ask" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      const editEditor = editor(page, "edit");
      const xRow = ruleRow(page, "edit", "x");
      await expect(xRow).toBeVisible();
      const rowsBefore = await editEditor.locator('[data-testid="native-rule-row"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-glob")),
      );
      expect(rowsBefore[0]).toBe("*");

      const xEffectBefore = await xRow
        .locator('[data-testid="native-rule-effect"][aria-checked="true"]')
        .getAttribute("data-effect");
      expect(xEffectBefore).toBe("ask");

      // 编辑循环：加 y（合法）→ 删 y（提交面 2 → 3 → 2）
      await editEditor.getByTestId("native-rule-add").click();
      const yRow = ruleRow(page, "edit", "");
      await expect(yRow).toBeVisible();
      await yRow.getByTestId("native-rule-glob").fill("y");
      await expect(ruleRow(page, "edit", "y")).toBeVisible();
      await expect(editEditor).toHaveAttribute("data-committed", "3");
      await ruleRow(page, "edit", "y").getByTestId("native-rule-remove").click();
      await expect(ruleRow(page, "edit", "y")).toHaveCount(0);

      // 断言：x 仍 ask（未被 normalize 成 deny）、`*` 仍置首
      const xEffectAfter = await ruleRow(page, "edit", "x")
        .locator('[data-testid="native-rule-effect"][aria-checked="true"]')
        .getAttribute("data-effect");
      expect(xEffectAfter).toBe("ask");
      const rowsAfter = await editEditor.locator('[data-testid="native-rule-row"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-glob")),
      );
      expect(rowsAfter[0]).toBe("*");
      expect(rowsAfter).toEqual(["*", "x"]);
      await expect(editEditor).toHaveAttribute("data-committed", "2");
      // 提交面（emit 出的 map）逐字节保留 ask —— 归一化会把它改写为 deny
      await expect(editEditor).toHaveAttribute("data-emitted", '{"*":"deny","x":"ask"}');

      await save(process.env.T3_SCREENSHOT, page);
      recordEvidence({
        test: "roundtrip_no_coercion",
        agent: agent.id,
        stored: { "*": "deny", x: "ask" },
        rows_before: rowsBefore,
        x_effect_before: xEffectBefore,
        x_effect_after: xEffectAfter,
        rows_after: rowsAfter,
        emitted: '{"*":"deny","x":"ask"}',
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("4. `*` 兜底警告：切 allow 即出现", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "warn");
    try {
      await loginAsAdmin(page);
      await openAgent(page, agent.name);
      const editEditor = editor(page, "edit");
      const warning = page.getByTestId("native-catchall-warning");
      await expect(warning).toHaveCount(0);

      const starRow = editEditor.locator('[data-testid="native-rule-row"]').first();
      await starRow.locator('[data-testid="native-rule-effect"][data-effect="allow"]').click();
      await expect(warning).toBeVisible();
      // 切回 deny 警告消失（`*` 行可切走再切回）
      await starRow.locator('[data-testid="native-rule-effect"][data-effect="deny"]').click();
      await expect(warning).toHaveCount(0);
      recordEvidence({ test: "catchall_warning", agent: agent.id, warn_on_allow: true, cleared_on_deny: true });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("5. 重复 glob 客户端拒绝（提交面不增长）", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "dup");
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny", dup: "allow" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      await loginAsAdmin(page);
      await openAgent(page, agent.name);
      const editEditor = editor(page, "edit");
      await expect(editEditor).toHaveAttribute("data-committed", "2");

      await editEditor.getByTestId("native-rule-add").click();
      const newRow = ruleRow(page, "edit", "");
      await newRow.getByTestId("native-rule-glob").fill("dup");
      await expect(
        editEditor.locator('[data-testid="native-rule-error"][data-code="duplicate"]').first(),
      ).toBeVisible();
      // 重复对的两行都被标记（互为重复）
      await expect(
        editEditor.locator('[data-testid="native-rule-error"][data-code="duplicate"]'),
      ).toHaveCount(2);
      // 提交面条数不变（非法行被排除、未 emit 新 map）
      await expect(editEditor).toHaveAttribute("data-committed", "2");
      recordEvidence({
        test: "duplicate_rejected",
        agent: agent.id,
        duplicate_error: true,
        committed_after: "2",
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("7. 未知 effect 原样保留（不归一化）", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "unk");
    try {
      await patchPolicy(request, token, agent, {
        edit: { "*": "deny", legacy: "allow" },
        read: { "*": "allow" },
        bash: "deny",
        task: "deny",
      });
      injectUnknownEffect(agent.effectivePermission!.policyId, "legacy", "ask2");
      await loginAsAdmin(page);
      await openAgent(page, agent.name);

      const legacyRow = ruleRow(page, "edit", "legacy");
      await expect(legacyRow).toBeVisible();
      const unknownChip = legacyRow.locator('[data-testid="native-rule-effect"][data-unknown="true"]');
      await expect(unknownChip).toHaveAttribute("data-effect", "ask2");
      // 未知值不吞掉三态 chip：三态仍在（用户可显式改判）
      await expect(legacyRow.locator('[data-testid="native-rule-effect"]')).toHaveCount(4);
      // 触发一次合法编辑（切 `*` 再切回）→ 提交面必须原样保留 ask2
      const starRow = editor(page, "edit").locator('[data-testid="native-rule-row"]').first();
      await starRow.locator('[data-testid="native-rule-effect"][data-effect="allow"]').click();
      await starRow.locator('[data-testid="native-rule-effect"][data-effect="deny"]').click();
      await expect(editor(page, "edit")).toHaveAttribute("data-emitted", '{"*":"deny","legacy":"ask2"}');
      recordEvidence({
        test: "unknown_effect_preserved",
        agent: agent.id,
        stored: "ask2",
        rendered_unknown: "ask2",
        tri_state_chips_intact: 4,
        emitted_after_edit: '{"*":"deny","legacy":"ask2"}',
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });

  test("6. bash 三态：当前值选中且可切换（持久化）", async ({ page, request }) => {
    const token = await adminToken(request);
    const agent = await createAgent(request, token, "bash");
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
      await expect(bash).toHaveAttribute("data-readonly", "false");
      await expect(bash.locator('[data-effect="ask"]')).toHaveAttribute("aria-checked", "true");
      await bash.locator('[data-effect="allow"]').click();
      await expect(bash.locator('[data-effect="allow"]')).toHaveAttribute("aria-checked", "true");
      // 契约变更（todo 4 拥有写盘）：原生编辑不再是 state-only——debounce(400ms) 后 PATCH 落盘，
      // 刷新后仍是新值 allow。旧断言「刷新后仍为存储值 ask」随 todo 4 交付持久化而作废，非弱化测试。
      const policyId = agent.effectivePermission!.policyId;
      await expect
        .poll(
          async () => {
            const res = await request.get(`${SERVER_URL}/api/v1/execution-policies/${policyId}`, {
              headers: authHeaders(token),
            });
            const body = (await res.json()) as { config: { permission: Record<string, unknown> } };
            return String(body.config.permission.bash);
          },
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
        test: "bash_tristate",
        agent: agent.id,
        stored_ask_selected: true,
        toggled_allow_persisted: true,
      });
    } finally {
      console.log(`[cleanup] ${await deleteAgent(request, token, agent)}`);
    }
  });
});
