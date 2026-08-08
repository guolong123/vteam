import { test, expect } from "@playwright/test";

/**
 * 1/17 login 页（无 storageState，测登录页本身）。
 * 断言：4 个原型 testid + 错误密码反馈 + 成功登录跳转（独立 context）。
 */
test.describe("1/17 login 登录页", () => {
  test("登录页元素齐全", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("username")).toBeVisible();
    await expect(page.getByTestId("password")).toBeVisible();
    await expect(page.getByTestId("login-button")).toBeVisible();
    await expect(page.getByTestId("register-link")).toBeVisible();
  });

  test("错误密码 → 登录失败提示", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("username").fill("seed-admin");
    await page.getByTestId("password").fill("wrong-password");
    await page.getByTestId("login-button").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
  });

  test("正确密码 → 跳转 /projects", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("username").fill("seed-admin");
    await page.getByTestId("password").fill("Admin@123456");
    await page.getByTestId("login-button").click();
    await expect(page).toHaveURL(/\/projects/, { timeout: 15_000 });
  });
});
