import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import { resolve } from "path";

/** 真实页面 CRUD 验收：每个资源都在新建空间里通过页面操作完成增/改/删。 */
import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME } from "./e2e-credentials";

const API_BASE = process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";
const WEB_BASE = process.env.WORKSPACE_WEB_BASE ?? "http://127.0.0.1:13201";
const SHOT_DIR = resolve(__dirname, "../../.design/multi-workspace/shots/crud-ui");
mkdirSync(SHOT_DIR, { recursive: true });
let seq = 0;
async function shot(page: Page, name: string) {
  seq += 1;
  const file = `${String(seq).padStart(2, "0")}-${name}.png`;
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(SHOT_DIR, file), fullPage: true });
  return file;
}

async function login(request: APIRequestContext) {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown> & { id: string };
  };
}
async function createWorkspace(
  request: APIRequestContext,
  token: string,
  name: string,
) {
  const res = await request.post(`${API_BASE}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string };
}
async function switchWorkspace(
  request: APIRequestContext,
  token: string,
  id: string,
) {
  const res = await request.post(`${API_BASE}/auth/workspace`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { workspaceId: id },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown> & { id: string };
  };
}

test.describe.serial("真实页面 CRUD", () => {
  const ts = Date.now();
  let session: {
    token: string;
    refreshToken: string;
    user: Record<string, unknown> & { id: string };
  };

  test.beforeAll(async ({ request }) => {
    const a = await login(request);
    const ws = await createWorkspace(request, a.accessToken, `UI-CRUD-${ts}`);
    const sw = await switchWorkspace(request, a.accessToken, ws.id);
    session = { token: sw.accessToken, refreshToken: sw.refreshToken, user: sw.user };
  });

  async function open(page: Page, path: string) {
    await page.addInitScript(
      ([state]) =>
        localStorage.setItem(
          "agent-platform-auth",
          JSON.stringify({ state, version: 0 }),
        ),
      [
        {
          token: session.token,
          refreshToken: session.refreshToken,
          user: session.user,
        },
      ],
    );
    await page.goto(`${WEB_BASE}${path}`, { waitUntil: "networkidle" });
  }

  test("角色：页面新建 → 列表可见 → 页面删除", async ({ page }) => {
    await open(page, "/system/roles");
    const name = `UI角色-${ts}`;
    await page.getByTestId("add-role-button").click();
    await page.getByTestId("create-role-name-input").fill(name);
    await page.getByTestId("create-role-confirm").click();
    await expect(page.getByTestId("create-role-modal")).toBeHidden();
    const item = page.getByTestId("role-item").filter({ hasText: name }).first();
    await expect(item).toBeVisible({ timeout: 15_000 });
    await shot(page, "角色-已创建");

    await item.click();
    await page.getByTestId("delete-role-button").click();
    await page.getByTestId("confirm-delete-confirm").click();
    await expect(
      page.getByTestId("role-item").filter({ hasText: name }),
    ).toHaveCount(0, { timeout: 15_000 });
    await shot(page, "角色-已删除");
  });

  test("技能：页面新建 → 编辑 → 启停", async ({ page }) => {
    await open(page, "/skills");
    const name = `ui-skill-${ts}`;
    await page.getByTestId("create-skill-button").click();
    await page.getByTestId("create-skill-name-input").fill(name);
    await page.getByTestId("create-skill-desc-input").fill("UI CRUD 技能描述");
    await page.getByTestId("create-skill-body-input").fill("# UI CRUD\n\n正文内容。");
    await page.getByTestId("create-skill-confirm-button").click();
    await expect(page.getByTestId("create-skill-modal-root")).toBeHidden();
    // 平台技能累计超过一页，翻页找到新建项
    const row = page.getByTestId("skill-item").filter({ hasText: name }).first();
    for (let i = 0; i < 10 && (await row.count()) === 0; i++) {
      const next = page.getByTestId("skills-pagination-next");
      if ((await next.count()) === 0 || (await next.isDisabled())) break;
      await next.click();
      await page.waitForTimeout(500);
    }
    await expect(row).toBeVisible({ timeout: 15_000 });
    await shot(page, "技能-已创建");

    await row.getByTestId("skill-edit-button").click();
    await page.getByTestId("edit-skill-desc-input").fill("UI 修改后的描述");
    await page.getByTestId("edit-skill-confirm-button").click();
    await expect(page.getByTestId("edit-skill-modal-root")).toBeHidden();

    const toggle = row.getByTestId("skill-toggle-button");
    const before = await row.getByTestId("skill-status").innerText();
    await toggle.click();
    await expect
      .poll(async () => row.getByTestId("skill-status").innerText(), { timeout: 15_000 })
      .not.toBe(before);
    await shot(page, "技能-已编辑并启停");
  });

  test("消息渠道/通知渠道：页面新建 → 编辑 → 删除", async ({ page }) => {
    await open(page, "/integrations");
    const mcName = `UI渠道-${ts}`;
    await page.getByTestId("create-message-channel-button").click();
    await page.getByTestId("integration-name-input").fill(mcName);
    await page.getByTestId("integration-modal-confirm").click();
    await expect(page.getByTestId("integration-channel-modal")).toBeHidden();
    const mc = page.getByTestId("integration-channel-item").filter({ hasText: mcName }).first();
    await expect(mc).toBeVisible({ timeout: 15_000 });
    await shot(page, "消息渠道-已创建");

    await mc.getByTestId("integration-edit-button").click();
    await page.getByTestId("integration-name-input").fill(`${mcName}-v2`);
    await page.getByTestId("integration-modal-confirm").click();
    await expect(page.getByText(mcName, { exact: true })).toHaveCount(0);
    const mc2 = page.getByTestId("integration-channel-item").filter({ hasText: `${mcName}-v2` }).first();
    await expect(mc2).toBeVisible({ timeout: 15_000 });
    await mc2.getByTestId("integration-delete-button").click();
    await page.getByTestId("confirm-delete-confirm").click();
    await expect(page.getByText(`${mcName}-v2`, { exact: true })).toHaveCount(0, { timeout: 15_000 });

    const ncName = `UI通知-${ts}`;
    await page.getByRole("button", { name: "通知渠道", exact: true }).click();
    await expect(page.getByTestId("integration-tab-panel")).toHaveAttribute("data-tab", "notification");
    await page.getByTestId("create-notification-channel-button").click();
    await page.getByTestId("notification-name-input").fill(ncName);
    await page.getByTestId("notification-targetUrl-input").fill("https://example.com/hook");
    await page.getByTestId("notification-modal-confirm").click();
    await expect(page.getByTestId("notification-channel-modal")).toBeHidden();
    const nc = page
      .getByTestId("notification-channel-item")
      .filter({ hasText: ncName })
      .first();
    await expect(nc).toBeVisible({ timeout: 15_000 });
    await nc.getByTestId("notification-edit-button").click();
    await page.getByTestId("notification-name-input").fill(`${ncName}-v2`);
    await page.getByTestId("notification-modal-confirm").click();
    const nc2 = page
      .getByTestId("notification-channel-item")
      .filter({ hasText: `${ncName}-v2` })
      .first();
    await expect(nc2).toBeVisible({ timeout: 15_000 });
    await nc2.getByTestId("notification-delete-button").click();
    await page.getByTestId("confirm-delete-confirm").click();
    await expect(page.getByText(`${ncName}-v2`, { exact: true })).toHaveCount(0, { timeout: 15_000 });
    await shot(page, "通知渠道-已删除");
  });


  test("MCP Server：页面新建 → 编辑 → 删除", async ({ page }) => {
    await open(page, "/skills");
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page
      .getByTestId("tool-subtab")
      .filter({ hasText: "MCP 工具" })
      .click();
    const name = `ui-mcp-${ts}`;
    await page.getByTestId("create-mcp-server-button").click();
    await page.getByTestId("mcp-server-name-input").fill(name);
    await page.getByTestId("mcp-server-type-remote").click();
    await page.getByTestId("mcp-server-url-input").fill("https://example.com/mcp");
    await page.getByTestId("mcp-server-modal-confirm").click();
    await expect(page.getByTestId("mcp-server-modal-root")).toBeHidden();
    // 平台共享 MCP 已超过一页，翻页找到新建项
    const row = page.getByTestId("mcp-server-item").filter({ hasText: name }).first();
    for (let i = 0; i < 10 && (await row.count()) === 0; i++) {
      const next = page.getByTestId("mcp-servers-pagination-next");
      if ((await next.count()) === 0 || (await next.isDisabled())) break;
      await next.click();
      await page.waitForTimeout(600);
    }
    await expect(row).toBeVisible({ timeout: 15_000 });
    await shot(page, "MCP-已创建");

    await row.getByTestId("mcp-server-actions-toggle").click();
    await page.getByTestId("mcp-server-edit-button").click();
    await page.getByTestId("mcp-server-url-input").fill("https://example.com/mcp-v2");
    await page.getByTestId("mcp-server-modal-confirm").click();
    await expect(page.getByTestId("mcp-server-modal-root")).toBeHidden();

    await row.getByTestId("mcp-server-actions-toggle").click();
    await page.getByTestId("mcp-server-delete-button").click();
    await page.getByTestId("delete-mcp-server-confirm").click();
    await expect(page.getByTestId("mcp-server-item").filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 });
    await shot(page, "MCP-已删除");
  });

  test("Git：页面建凭证 → 建仓库 → 删除仓库 → 删除凭证", async ({ page }) => {
    await open(page, "/git-repos");
    const credName = `UI凭证-${ts}`;
    await page.getByRole("button", { name: "凭证", exact: true }).click();
    await page.getByTestId("git-credentials-add").click();
    await page.getByTestId("git-credential-modal-name").fill(credName);
    await page.getByTestId("git-credential-modal-auth-type").selectOption("https_token");
    await page.getByTestId("git-credential-modal-key").fill("ui-crud-token");
    await page.getByTestId("git-credential-modal-save").click();
    await expect(page.getByTestId("git-credential-modal")).toBeHidden();
    const credRow = page.getByTestId("git-credential-item").filter({ hasText: credName }).first();
    await expect(credRow).toBeVisible({ timeout: 15_000 });
    await shot(page, "Git凭证-已创建");

    const repoUrl = `git@example.com:ui/crud-${ts}.git`;
    await page.getByRole("button", { name: "仓库", exact: true }).click();
    await page.getByTestId("git-repos-add").click();
    await page.getByTestId("git-repo-modal-url").fill(repoUrl);
    const credSelect = page.getByTestId("git-repo-modal-credential");
    const credValue = await credSelect
      .locator("option")
      .evaluateAll((opts, name) => {
        const hit = opts.find((o) =>
          (o.textContent ?? "").trim().startsWith(name),
        ) as HTMLOptionElement | undefined;
        return hit?.value ?? "";
      }, credName);
    expect(credValue).toBeTruthy();
    await credSelect.selectOption(credValue);
    await page.getByTestId("git-repo-modal-save").click();
    await expect(page.getByTestId("git-repo-modal")).toBeHidden();
    const repoRow = page
      .getByTestId("git-repo-item")
      .filter({ hasText: `crud-${ts}` })
      .first();
    await expect(repoRow).toBeVisible({ timeout: 15_000 });
    await shot(page, "Git仓库-已创建");

    await repoRow.getByTestId("git-repo-delete").click();
    await page.getByTestId("git-repo-delete-confirm").click();
    await expect(
      page.getByTestId("git-repo-item").filter({ hasText: `crud-${ts}` }),
    ).toHaveCount(0, { timeout: 15_000 });

    await page.getByRole("button", { name: "凭证", exact: true }).click();
    const credRow2 = page.getByTestId("git-credential-item").filter({ hasText: credName }).first();
    await credRow2.getByTestId("git-credential-delete").click();
    await page.getByTestId("git-credential-delete-confirm").click();
    await expect(page.getByTestId("git-credential-item").filter({ hasText: credName })).toHaveCount(0, { timeout: 15_000 });
    await shot(page, "Git-已清理");
  });

  test("成员：页面新建 → 编辑 → 删除", async ({ page }) => {
    await open(page, "/members");
    const name = `UI成员-${ts}`;
    await page.getByTestId("create-member-button").click();
    const drawer = page.getByTestId("member-edit-drawer");
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await drawer.getByPlaceholder("留空自动生成，例如：胡一开").fill(name);
    await drawer.getByTestId("member-role-chip").first().click();
    await drawer.getByRole("button", { name: "保存修改" }).click();
    const row = page.getByTestId("member-row").filter({ hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await shot(page, "成员-已创建");

    await row.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await drawer.getByTestId("member-prompt-input").fill("UI 修改后的成员提示词");
    await drawer.getByRole("button", { name: "保存修改" }).click();
    await expect(drawer).toBeHidden({ timeout: 15_000 });

    await row.getByTestId("member-delete").click();
    await page.getByTestId("member-delete-confirm-confirm").click();
    await expect(page.getByTestId("member-row").filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 });
    await shot(page, "成员-已删除");
  });

  test("Agent：页面新建 → 删除", async ({ page }) => {
    await open(page, "/agents");
    const name = `UI Agent ${ts}`;
    const key = `ui-agent-${ts}`;
    await page.getByTestId("create-agent-button").click();
    await page.getByTestId("agent-name-input").fill(name);
    await page.getByTestId("agent-key-input").fill(key);
    await page.getByTestId("create-agent-confirm").click();
    await expect(page.getByTestId("create-agent-modal")).toBeHidden();
    const item = page.getByTestId("agent-list-item").filter({ hasText: name }).first();
    await expect(item).toBeVisible({ timeout: 15_000 });
    await shot(page, "Agent-已创建");

    await item.click();
    await page.getByTestId("delete-agent-button").click();
    await page.getByTestId("confirm-delete-confirm").click();
    await expect(page.getByTestId("agent-list-item").filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 });
    await shot(page, "Agent-已删除");
  });


  test("Provider：页面新增 → 编辑 → 删除", async ({ page }) => {
    await open(page, "/models");
    const providerID = `ui-provider-${ts}`;
    await page.getByTestId("provider-add-button").click();
    await page.getByTestId("provider-add-modal").waitFor();
    await page.getByTestId("provider-add-provider-input").fill(providerID);
    await page.getByTestId("provider-add-model-id-input").fill("ui-model");
    await page.getByTestId("provider-add-model-name-input").fill("UI Model");
    await page.getByTestId("provider-add-key-input").fill("ui-key");
    await page.getByTestId("provider-add-modal-save").click();
    await expect(page.getByTestId("provider-add-modal")).toBeHidden({ timeout: 20_000 });
    const row = page.locator(".pv-provider-row").filter({ hasText: providerID }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await shot(page, "Provider-已创建");

    await row.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByTestId("provider-edit-modal").waitFor();
    await page.getByTestId("provider-edit-baseurl-input").fill("https://example.com/v1");
    await page.getByTestId("provider-edit-modal-save").click();
    await expect(page.getByTestId("provider-edit-modal")).toBeHidden({ timeout: 20_000 });

    await row.getByRole("button", { name: "删除Provider", exact: true }).click();
    await page.getByTestId("provider-delete-provider-confirm-confirm").click();
    await expect(
      page.locator(".pv-provider-row").filter({ hasText: providerID }),
    ).toHaveCount(0, { timeout: 20_000 });
    await shot(page, "Provider-已删除");
  });

  test("Agent 岗位：页面新建 → 编辑 → 删除", async ({ page }) => {
    await open(page, "/agents");
    await page.getByRole("button", { name: "角色", exact: true }).click();
    const name = `UI岗位-${ts}`;
    const key = `ui-role-${ts}`;
    await page.getByTestId("role-create-button").click();
    await page.getByTestId("role-key-input").fill(key);
    await page.getByTestId("role-name-input").fill(name);
    await page.getByTestId("role-save-button").click();
    const item = page.getByTestId("role-item").filter({ hasText: name }).first();
    await expect(item).toBeVisible({ timeout: 15_000 });
    await shot(page, "岗位-已创建");

    await item.click();
    await page.getByTestId("role-description-input").fill("UI 修改后的岗位描述");
    await page.getByTestId("role-save-button").click();
    await expect(page.getByTestId("role-description-input")).toHaveValue(
      "UI 修改后的岗位描述",
      { timeout: 15_000 },
    );

    await page.getByTestId("role-delete-button").click();
    await page.getByTestId("confirm-delete-confirm").click();
    await expect(page.getByTestId("role-item").filter({ hasText: name })).toHaveCount(0, { timeout: 15_000 });
    await shot(page, "岗位-已删除");
  });

  test("团队：页面新建 → 改名 → 删除", async ({ page }) => {
    await open(page, "/teams/new");
    const name = `UI团队-${ts}`;
    await page.getByTestId("team-name-input").fill(name);
    await page.getByTestId("team-member-mode-roles").click();
    await page.locator('[data-testid="role-card"]').first().locator('[data-testid="role-toggle"]').click();
    await page.getByTestId("create-team-submit").click();
    await page.waitForURL(/\/teams\/tm_/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await shot(page, "团队-已创建");

    const renamed = `${name}-v2`;
    const nameInput = page.getByTestId("team-name-edit");
    await nameInput.fill(renamed);
    await page.getByTestId("team-save-name").click();
    await expect(page.getByTestId("team-name-edit")).toHaveValue(renamed, {
      timeout: 15_000,
    });

    await page.getByTestId("delete-team-button").click();
    await page.getByTestId("team-delete-confirm-confirm").click();
    await page.waitForURL((url) => !url.pathname.startsWith("/teams/tm_"), {
      timeout: 30_000,
    });
    await shot(page, "团队-已删除");
  });
});