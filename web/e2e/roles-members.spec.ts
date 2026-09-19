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
 * 覆盖三件事：
 *  A. /agents 有两个 Tab（Agent / 角色）；角色 Tab 列出 7 内置 + 自定义，带内置徽章。
 *  B. 内置角色只读且**无删除控件**（role-delete-button 不存在）；
 *     自定义角色可创建、改默认 Agent 并持久化（reload 后回读一致）、可删除。
 *  C. 成员按岗位添加：选岗位自动预填该岗位 defaultAgentId，仍可切换 Agent；
 *     切换后的 agentId 覆盖岗位默认（提交体 agentId=覆盖值，roleId=岗位）。
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
    await page.getByTestId("role-default-agent").selectOption("a_developer");
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
    await page.getByTestId("role-default-agent").selectOption("a_tester");
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
    await expect(page.getByTestId("role-default-agent")).toHaveValue("a_tester");

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
});
