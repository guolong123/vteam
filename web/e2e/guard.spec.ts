import { test, expect } from "@playwright/test";

/**
 * 登录守卫验证：未登录访问 (main) 受保护路由 → 重定向 /login。
 * 覆盖所有 (main) 路由组入口（AppShell 守卫 router.replace("/login")）。
 */
test.describe("未登录守卫", () => {
  const PROTECTED = [
    "/projects",
    "/board?pid=p_seed_1",
    "/tasks/new",
    "/tasks/t_0000000001",
    "/agents",
    "/messages",
    "/messages/c_0000000001",
    "/roles",
    "/skills",
    "/artifacts?pid=p_seed_1",
    "/tools/register",
    "/users",
    "/workers",
  ];

  for (const route of PROTECTED) {
    test(`未登录访问 ${route} → /login`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
      await expect(page.getByTestId("username")).toBeVisible();
    });
  }
});
