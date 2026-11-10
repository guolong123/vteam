import { test as setup, expect } from "@playwright/test";
import path from "node:path";
import { LANDING_ADMIN } from "@/lib/landing";

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

  // 登录成功 → 落地页由产品单点决定（web/lib/landing.ts）：
  // 平台管理员落 /stats、普通成员落 /teams。seed-admin 是管理员 ⇒ /stats。
  // 这里直接 import 产品常量而不是硬编码，落地页再调整时本断言不会漂移。
  await expect(page).toHaveURL(new RegExp(`${LANDING_ADMIN}$`), { timeout: 15_000 });
  // 数据可见：团队页团队卡片渲染（需显式导航——管理员落地页是统计看板）
  await page.goto("/teams");
  await expect(page.getByTestId("teams-list-root")).toBeVisible();
  await expect(page.getByTestId("team-row").first()).toBeVisible();

  await page.context().storageState({ path: AUTH_FILE });
});
