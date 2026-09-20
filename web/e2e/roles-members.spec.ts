import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

/**
 * agent-role-entity Todo 7 · 成员⇄角色链接 + Roles Tab + 成员预填
 * ============================================================
 * 覆盖四件事：
 *  A. /agents 有两个 Tab（Agent / 角色）；角色 Tab 列出 7 内置 + 自定义，带内置徽章。
 *  B. 内置角色只读且**无删除控件**（role-delete-button 不存在）；
 *     自定义角色可创建、改默认 Agent 并持久化（reload 后回读一致）、可删除。
 *  C. 成员按岗位添加：选岗位自动预填该岗位 defaultAgentId，仍可切换 Agent；
 *     切换后的 agentId 覆盖岗位默认（提交体 agentId=覆盖值，roleId=岗位）。
 *  D. 单一 `role-default-agent` 选择器承载互斥槽位（issue 3 / opencode-native-
 *     permissions-and-fixes todo 7）：选外部引擎 Agent → defaultOpencodeAgentName
 *     持久化且 defaultAgentId=null；切回内部 Agent → 外部槽位被原子清空；
 *     服务端 400 AGENT_ROLE_DEFAULT_SLOT_CONFLICT 在 role-action-error 可见。
 *
 * 运行（仓库根）：bash scripts/e2e-roles-members.sh
 * （独立 tmp config，指向 compose web :13001 / server :13000）
 */

const SERVER_URL = "http://localhost:13000";
const RUN_TAG = `t7-${Date.now().toString(36)}`;
const ROLE_KEY = `qa-t7-role-${RUN_TAG}`;

interface AgentRole {
  id: string;
  key: string;
  name: string;
  type: string;
  defaultAgentId: string | null;
  defaultOpencodeAgentName: string | null;
}

interface OpencodeAgentEntry {
  name: string;
  mode: string;
  hidden?: boolean;
  governed: boolean;
}

interface TeamMember {
  id: string;
  agentId: string;
  roleId: string | null;
  alias: string;
}

interface TeamDto {
  id: string;
  members: TeamMember[];
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
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

async function save(path: string | undefined, page: Page) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

/** Viewport snapshot（fullPage 在本应用不可靠：主区域是内部滚动容器，需先 scrollIntoView）。 */
async function snap(path: string | undefined, page: Page) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
}

function recordEvidence(entry: Record<string, unknown>) {
  const path = process.env.T7_EVIDENCE_JSON;
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

async function openRolesTab(page: Page) {
  await page.goto("/agents");
  await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("manage-tab").filter({ hasText: "角色" }).click();
  await expect(page.getByTestId("agent-role-root")).toBeVisible({ timeout: 15_000 });
}

/** 引擎实时外部清单（!governed && !hidden），非硬编码；degraded/空 → 调用方 skip。 */
async function engineExternal(
  request: APIRequestContext,
  token: string,
): Promise<{ names: string[]; degraded: boolean }> {
  const res = await request.get(`${SERVER_URL}/api/v1/agents/opencode`, {
    headers: authHeaders(token),
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { agents: OpencodeAgentEntry[]; degraded: boolean };
  return {
    names: body.agents.filter((a) => !a.governed && !a.hidden).map((a) => a.name),
    degraded: body.degraded,
  };
}

test.describe("Todo 7 · 角色 Tab 与成员⇄角色", () => {
  test("1. 两 Tab；角色 Tab 列出 7 内置带徽章；内置只读且无删除", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId("manage-tabs")).toBeVisible();
    await expect(page.getByTestId("manage-tab")).toHaveCount(3);
    await expect(page.getByTestId("manage-tab").filter({ hasText: /^Agent$/ })).toHaveAttribute("data-active", "true");

    await page.getByTestId("manage-tab").filter({ hasText: "角色" }).click();
    await expect(page.getByTestId("agent-role-root")).toBeVisible({ timeout: 15_000 });

    const roleItems = page.getByTestId("role-item");
    await expect(roleItems.first()).toBeVisible({ timeout: 15_000 });
    const builtins = page.locator('[data-testid="role-item"][data-role-type="builtin"]');
    await expect(builtins).toHaveCount(7);
    const builtinKeys = await builtins.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.roleKey),
    );
    expect(builtinKeys).toEqual([
      "product",
      "project_manager",
      "architect",
      "developer",
      "tester",
      "plan",
      "librarian",
    ]);

    const firstBuiltin = builtins.first();
    await firstBuiltin.click();
    await expect(page.getByTestId("role-builtin-notice")).toBeVisible();
    await expect(page.getByTestId("role-delete-button")).toHaveCount(0);
    await expect(page.getByTestId("role-save-button")).toHaveCount(0);

    const builtinBadge = firstBuiltin.getByTestId("role-type-badge");
    await expect(builtinBadge).toContainText("内置");

    await page.setViewportSize({ width: 1280, height: 900 });
    await save(process.env.T7_SCREENSHOT, page);
    recordEvidence({
      test: "tabs_and_builtins",
      tab_count: 2,
      builtin_count: builtinKeys.length,
      builtin_keys: builtinKeys,
      builtin_readonly_no_delete: true,
    });
  });

  test("2. 自定义角色：创建 → 改默认 Agent 持久化 → 删除", async ({ page, request }) => {
    await loginAsAdmin(page);
    await openRolesTab(page);
    const token = await adminToken(request);

    await page.getByTestId("role-create-button").click();
    await expect(page.getByTestId("role-key-input")).toBeVisible();
    await page.getByTestId("role-key-input").fill(ROLE_KEY);
    await page.getByTestId("role-name-input").fill(`QA 角色 ${RUN_TAG}`);
    await page.getByTestId("role-default-agent").selectOption("internal:a_developer");
    await page.getByTestId("role-prompt").fill("QA 角色：仅用于证明默认 Agent 可编辑并持久化。");
    await page.getByTestId("role-save-button").click();

    const createdItem = page.locator(`[data-testid="role-item"][data-role-key="${ROLE_KEY}"]`);
    await expect(createdItem).toBeVisible({ timeout: 15_000 });

    const list = (await (
      await request.get(`${SERVER_URL}/api/v1/agent-roles?pageSize=100`, {
        headers: authHeaders(token),
      })
    ).json()) as { items: AgentRole[] };
    const created = list.items.find((r) => r.key === ROLE_KEY);
    expect(created).toBeTruthy();
    expect(created!.type).toBe("custom");
    expect(created!.defaultAgentId).toBe("a_developer");

    // 已选中的新建角色：改默认 Agent → 保存
    await page.getByTestId("role-default-agent").selectOption("internal:a_tester");
    await page.getByTestId("role-save-button").click();
    await expect(page.getByTestId("role-action-error")).toHaveCount(0);

    await expect
      .poll(
        async () => {
          const after = (await (
            await request.get(`${SERVER_URL}/api/v1/agent-roles/${created!.id}`, {
              headers: authHeaders(token),
            })
          ).json()) as AgentRole;
          return after.defaultAgentId;
        },
        { timeout: 15_000 },
      )
      .toBe("a_tester");

    // reload 后回读一致（持久化，不是仅前端态）
    await page.goto("/agents");
    await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("manage-tab").filter({ hasText: "角色" }).click();
    await page.locator(`[data-testid="role-item"][data-role-key="${ROLE_KEY}"]`).click();
    await expect(page.getByTestId("role-default-agent")).toHaveValue("internal:a_tester");

    // 删除自定义角色（cleanup 收据）
    await page.getByTestId("role-delete-button").click();
    await expect(page.getByTestId("confirm-delete-modal")).toBeVisible();
    await page.getByTestId("confirm-delete-confirm").click();
    await expect(
      page.locator(`[data-testid="role-item"][data-role-key="${ROLE_KEY}"]`),
    ).toHaveCount(0, { timeout: 15_000 });
    const gone = await request.get(`${SERVER_URL}/api/v1/agent-roles/${created!.id}`, {
      headers: authHeaders(token),
    });
    expect(gone.status()).toBe(404);

    recordEvidence({
      test: "custom_role_crud",
      role_key: ROLE_KEY,
      created_default_agent: "a_developer",
      edited_default_agent: "a_tester",
      persisted_after_reload: true,
      deleted: true,
      cleanup: `${created!.id} DELETE -> ${gone.status()}`,
    });
    console.log(`[cleanup] custom role ${created!.id} deleted (re-GET ${gone.status()})`);
  });

  test("3. 成员按岗位添加：预填 Agent → 覆盖后持久化", async ({ page, request }) => {
    await loginAsAdmin(page);
    const token = await adminToken(request);

    // 建团队（初始 1 名 developer）+ pending 任务（使会话页成员可编辑）
    const teamRes = await request.post(`${SERVER_URL}/api/v1/teams`, {
      headers: authHeaders(token),
      data: { name: `qa-t7-team-${RUN_TAG}`, members: [{ roleId: "ar_developer" }] },
    });
    expect(teamRes.status()).toBe(201);
    const team = (await teamRes.json()) as TeamDto;
    const taskRes = await request.post(`${SERVER_URL}/api/v1/tasks`, {
      headers: authHeaders(token),
      data: { title: `qa t7 ${RUN_TAG}`, teamId: team.id },
    });
    expect(taskRes.status()).toBe(201);

    try {
      await page.goto(`/teams/${team.id}/session`);
      await expect(page.getByTestId("members-panel")).toBeVisible({ timeout: 20_000 });

      await page.getByTestId("add-instance-entry").click();
      await expect(page.getByTestId("add-instance-panel")).toBeVisible();

      // 选 developer 岗位 → 自动预填 developer 默认 Agent（a_developer）
      await page
        .locator('[data-testid="add-instance-role"][data-role="developer"]')
        .click();
      await expect(page.getByTestId("add-instance-agent-select")).toHaveValue("a_developer");

      // 覆盖：切到 tester（岗位仍是 developer，Agent 显式覆盖）
      await page.getByTestId("add-instance-agent-select").selectOption("a_tester");
      await page.getByTestId("add-instance-alias").fill(`qa-override-${RUN_TAG}`);
      await page.getByTestId("add-instance-confirm").click();
      await expect(page.getByTestId("add-instance-panel")).toHaveCount(0, { timeout: 15_000 });

      const after = (await (
        await request.get(`${SERVER_URL}/api/v1/teams/${team.id}`, {
          headers: authHeaders(token),
        })
      ).json()) as TeamDto;
      const added = after.members.find((m) => m.alias === `qa-override-${RUN_TAG}`);
      expect(added).toBeTruthy();
      expect(added!.agentId).toBe("a_tester");
      expect(added!.roleId).toBe("ar_developer");

      recordEvidence({
        test: "member_prefill_and_override",
        team_id: team.id,
        prefilled_agent: "a_developer",
        overridden_agent: added!.agentId,
        persisted_role_id: added!.roleId,
        override_persisted: true,
      });
    } finally {
      const del = await request.delete(`${SERVER_URL}/api/v1/teams/${team.id}`, {
        headers: authHeaders(token),
      });
      console.log(`[cleanup] team ${team.id} DELETE -> ${del.status()}`);
    }
  });

  // issue 3（todo 7 web 切片）：角色编辑器的单一 Agent 选择器承载「内部 XOR 外部」槽位，
  // 外部选择必须经 API 持久化到 defaultOpencodeAgentName 且 defaultAgentId 为 null；反向切换
  // （外部 → 内部）必须原子清空外部槽位。名字来自实时引擎清单，绝不硬编码。
  test("4. 角色编辑器：外部 Agent 往返（外部→保存→reload；内部→保存→外部清空）", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const { names, degraded } = await engineExternal(request, token);
    test.skip(
      degraded || names.length === 0,
      `GET /agents/opencode 不可用（degraded=${degraded}，外部条目=${names.length}）——无外部 Agent 可测`,
    );
    const externalName = names[0];
    const roleKey = `qa-t7-ext-${RUN_TAG}`;

    await loginAsAdmin(page);
    await openRolesTab(page);

    await page.getByTestId("role-create-button").click();
    await page.getByTestId("role-key-input").fill(roleKey);
    await page.getByTestId("role-name-input").fill(`QA 外部槽位 ${RUN_TAG}`);
    await page
      .getByTestId("role-default-agent")
      .selectOption(`external:${externalName}`);
    await expect(page.getByTestId("role-default-agent")).toHaveAttribute("data-slot", "external");
    await page.getByTestId("role-save-button").click();

    const createdItem = page.locator(`[data-testid="role-item"][data-role-key="${roleKey}"]`);
    await expect(createdItem).toBeVisible({ timeout: 15_000 });

    let roleId: string | null = null;
    try {
      const list = (await (
        await request.get(`${SERVER_URL}/api/v1/agent-roles?pageSize=100`, {
          headers: authHeaders(token),
        })
      ).json()) as { items: AgentRole[] };
      const created = list.items.find((r) => r.key === roleKey);
      expect(created).toBeTruthy();
      roleId = created!.id;
      // 列表项文案必须如实指向外部绑定，不得谎报「未设置」
      await expect(createdItem).toContainText(externalName);
      await expect(createdItem).not.toContainText("未设置");

      // API 事实：外部槽位落库、内部槽位为 null
      await expect
        .poll(
          async () =>
            (await (
              await request.get(`${SERVER_URL}/api/v1/agent-roles/${created!.id}`, {
                headers: authHeaders(token),
              })
            ).json()) as AgentRole,
          { timeout: 15_000 },
        )
        .toMatchObject({ defaultOpencodeAgentName: externalName, defaultAgentId: null });

      // reload 后仍选中外部项（持久化，不是仅前端态）
      await page.goto("/agents");
      await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("manage-tab").filter({ hasText: "角色" }).click();
      await page.locator(`[data-testid="role-item"][data-role-key="${roleKey}"]`).click();
      const select = page.getByTestId("role-default-agent");
      await expect(select).toHaveValue(`external:${externalName}`);
      await expect(select).toHaveAttribute("data-slot", "external");

      // 证据：选择器可见且选中外部项（先滚到主区域滚动容器内再截图）
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(page.getByTestId("role-default-agent-note")).toContainText("个外部 Agent", {
        timeout: 20_000,
      });
      await select.scrollIntoViewIfNeeded();
      await snap(process.env.T7_ROLE_AGENT_SCREENSHOT, page);

      recordEvidence({
        test: "role_external_slot_roundtrip_external_leg",
        external_name: externalName,
        engine_external_count: names.length,
        persisted_default_opencode_agent_name: externalName,
        persisted_default_agent_id: null,
        selected_after_reload: true,
      });

      // 反向：切到内部 Agent → 保存 → 外部槽位被原子清空
      await select.selectOption("internal:a_tester");
      await expect(select).toHaveAttribute("data-slot", "internal");
      await page.getByTestId("role-save-button").click();
      await expect(page.getByTestId("role-action-error")).toHaveCount(0);

      await expect
        .poll(
          async () =>
            (await (
              await request.get(`${SERVER_URL}/api/v1/agent-roles/${created!.id}`, {
                headers: authHeaders(token),
              })
            ).json()) as AgentRole,
          { timeout: 15_000 },
        )
        .toMatchObject({ defaultAgentId: "a_tester", defaultOpencodeAgentName: null });

      await page.goto("/agents");
      await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("manage-tab").filter({ hasText: "角色" }).click();
      await page.locator(`[data-testid="role-item"][data-role-key="${roleKey}"]`).click();
      await expect(page.getByTestId("role-default-agent")).toHaveValue("internal:a_tester");
      await expect(page.getByTestId("role-default-agent")).toHaveAttribute("data-slot", "internal");

      recordEvidence({
        test: "role_external_slot_roundtrip_internal_leg",
        switched_to_internal: "a_tester",
        persisted_default_agent_id: "a_tester",
        persisted_default_opencode_agent_name: null,
        selected_after_reload: true,
      });

      // 槽位不变量的错误面：服务端 400 AGENT_ROLE_DEFAULT_SLOT_CONFLICT 必须可见、具体，
      // 绝不静默吞掉。单选择器 UI 不可能发出双非空请求，故用 route mock 精确植入该 400。
      let patchHits = 0;
      const conflictRoute = async (route: import("@playwright/test").Route) => {
        const req = route.request();
        if (req.method() === "PATCH" && /\/agent-roles\/[^/]+$/.test(new URL(req.url()).pathname)) {
          patchHits += 1;
          await route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({
              code: "AGENT_ROLE_DEFAULT_SLOT_CONFLICT",
              message: "默认 Agent 槽位至多一个：defaultAgentId 与 defaultOpencodeAgentName 不能同时设置",
            }),
          });
          return;
        }
        await route.fallback();
      };
      await page.route("**/api/v1/agent-roles/**", conflictRoute);
      await page.getByTestId("role-default-agent").selectOption("internal:a_developer");
      await page.getByTestId("role-save-button").click();
      const error = page.getByTestId("role-action-error");
      await expect(error).toBeVisible({ timeout: 15_000 });
      await expect(error).toContainText("槽位冲突");
      await expect(error).toContainText("二选一");
      expect(patchHits).toBeGreaterThan(0);
      await page.unroute("**/api/v1/agent-roles/**", conflictRoute);

      // 失败的保存不得改动已持久化的状态：reload 后仍是内部槽位 a_tester
      await page.goto("/agents");
      await expect(page.getByTestId("agent-config-root")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("manage-tab").filter({ hasText: "角色" }).click();
      await page.locator(`[data-testid="role-item"][data-role-key="${roleKey}"]`).click();
      await expect(page.getByTestId("role-default-agent")).toHaveValue("internal:a_tester");
      const stillInternal = (await (
        await request.get(`${SERVER_URL}/api/v1/agent-roles/${created!.id}`, {
          headers: authHeaders(token),
        })
      ).json()) as AgentRole;
      expect(stillInternal.defaultAgentId).toBe("a_tester");

      recordEvidence({
        test: "slot_conflict_surface",
        mocked_status: 400,
        mocked_code: "AGENT_ROLE_DEFAULT_SLOT_CONFLICT",
        error_visible: true,
        error_mentions_slot_conflict: true,
        persisted_state_unchanged_after_failed_save: true,
      });
    } finally {
      if (roleId) {
        const del = await request.delete(`${SERVER_URL}/api/v1/agent-roles/${roleId}`, {
          headers: authHeaders(token),
        });
        console.log(`[cleanup] throwaway role ${roleId} DELETE -> ${del.status()}`);
      }
    }
  });
});
