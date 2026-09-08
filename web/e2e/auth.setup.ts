import { test as setup, expect } from "@playwright/test";
import path from "node:path";

/**
 * 登录态 setup：真实表单登录（走 /login 页面，非注入），存 storageState。
 * 账号：seed-admin/Admin@123456（种子团队 tm_0000000001 的成员归属 seed-admin；
 * admin 登录后团队列表为空，数据型 testid 无法断言）。
 * 产物：.auth/user.json（相对 playwright 运行 cwd = web/）。
 */
const AUTH_FILE = path.join(process.cwd(), ".auth", "user.json");

setup("真实表单登录 seed-admin → storageState", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("username").fill("seed-admin");
  await page.getByTestId("password").fill("Admin@123456");
  await page.getByTestId("login-button").click();

  // 登录成功 → 跳转 /teams
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
  // 数据可见：团队卡片渲染
  await expect(page.getByTestId("teams-list-root")).toBeVisible();
  await expect(page.getByTestId("team-card").first()).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
