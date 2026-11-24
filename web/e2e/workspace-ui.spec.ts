import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * 多工作空间前端 UI 验收（真实浏览器）：
 * - 管理员：顶栏空间切换器可见（多空间）→ 切换后当前空间变化；
 *   /workspaces 页面展示空间列表 + 管理员迁移面板；管理员跨空间只读入口 + 横幅。
 * - 普通成员：工作空间页可用，但看不到管理员迁移面板。
 *
 * 登录态通过 API 登录后注入 zustand persist 存储（避免依赖登录页选择器）。
 */
const API =
  process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13100/api/v1";

async function loginState(
  request: APIRequestContext,
  username: string,
  password: string,
) {
  const res = await request.post(`${API}/auth/login`, {
    data: { username, password },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    accessToken: string;
    refreshToken: string;
    user: Record<string, unknown>;
  };
}

async function seedAuth(page: Page, state: object) {
  await page.addInitScript((payload) => {
    window.localStorage.setItem("agent-platform-auth", JSON.stringify(payload));
    window.sessionStorage.removeItem("agent-platform-auth");
  }, { state, version: 0 });
}

test("管理员：空间切换器 + 工作空间页 + 跨空间只读横幅", async ({
  page,
  request,
}) => {
  const auth = await loginState(request, "admin", "admin123");
  await seedAuth(page, {
    token: auth.accessToken,
    refreshToken: auth.refreshToken,
    user: auth.user,
  });

  await page.goto("/workspaces");
  await expect(page.getByTestId("workspaces-page")).toBeVisible();

  // 切换器（管理员默认空间 + E2E 空间 → 多空间，可搜索面板）
  await expect(page.getByTestId("workspace-switcher-button")).toBeVisible();
  await page.getByTestId("workspace-switcher-button").click();
  await expect(page.getByTestId("workspace-switcher-panel")).toBeVisible();
  await expect(page.getByTestId("workspace-switcher-search")).toBeVisible();
  const options = await page
    .getByTestId("workspace-switcher-panel")
    .getByRole("option")
    .count();
  expect(options).toBeGreaterThan(1);
  await page.getByTestId("workspace-switcher-button").click();

  // 空间列表行存在；管理员迁移面板可见
  await expect(page.getByText("我的工作空间")).toBeVisible();
  await expect(page.getByTestId("workspace-relocations")).toBeVisible();

  // 管理员跨空间只读：点第一个「管理员只读查看」→ 横幅出现 → 退出
  const viewBtn = page.getByRole("button", { name: "平台管理员只读查看" }).first();
  await expect(viewBtn).toBeVisible();
  await viewBtn.click();
  await expect(page.getByTestId("workspace-view-banner")).toBeVisible();
  await expect(page.getByTestId("workspace-view-banner")).toContainText(
    "只读",
  );
  await page.getByTestId("workspace-view-exit").click();
  await expect(page.getByTestId("workspace-view-banner")).toHaveCount(0);
});

test("管理员：顶栏切换空间后 URL 数据刷新（当前空间变化）", async ({
  page,
  request,
}) => {
  const auth = await loginState(request, "admin", "admin123");
  await seedAuth(page, {
    token: auth.accessToken,
    refreshToken: auth.refreshToken,
    user: auth.user,
  });

  await page.goto("/workspaces");
  const switcherBtn = page.getByTestId("workspace-switcher-button");
  await expect(switcherBtn).toBeVisible();
  const before = await switcherBtn.innerText();
  await switcherBtn.click();
  await expect(page.getByTestId("workspace-switcher-panel")).toBeVisible();
  const optionIds = await page
    .getByTestId("workspace-switcher-panel")
    .getByRole("option")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid") ?? ""),
    );
  expect(optionIds.length).toBeGreaterThan(1);
  // 点第二个可切换空间（第一个是当前空间，点它不会切换）
  const targetId = (optionIds[1] ?? optionIds[0]).replace(
    "workspace-switcher-option-",
    "",
  );
  await page.getByTestId(`workspace-switcher-option-${targetId}`).click();
  await expect(page.getByTestId("workspace-switcher-panel")).toHaveCount(0);
  await expect.poll(async () => switcherBtn.innerText(), { timeout: 15_000 }).not.toBe(before);
});

test("普通成员：工作空间页可用，但无管理员迁移面板", async ({
  page,
  request,
}) => {
  const auth = await loginState(request, "seed-member", "Admin@123456");
  await seedAuth(page, {
    token: auth.accessToken,
    refreshToken: auth.refreshToken,
    user: auth.user,
  });

  await page.goto("/workspaces");
  await expect(page.getByTestId("workspaces-page")).toBeVisible();
  await expect(page.getByTestId("workspace-relocations")).toHaveCount(0);
});
