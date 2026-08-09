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

  test("register-link → 跳转 /register（ISSUE-011 死链修复）", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("register-link").click();
    await expect(page).toHaveURL(/\/register/, { timeout: 15_000 });
    await expect(page.getByTestId("register-username")).toBeVisible();
    await expect(page.getByTestId("register-displayname")).toBeVisible();
    await expect(page.getByTestId("register-password")).toBeVisible();
    await expect(page.getByTestId("register-submit")).toBeVisible();
    await expect(page.getByTestId("register-login-link")).toBeVisible();
  });

  test("register 前端校验：空表单 → 提示，不提交", async ({ page }) => {
    await page.goto("/register");
    await page.getByTestId("register-submit").click();
    await expect(page.getByTestId("register-error")).toBeVisible();
    await expect(page.getByTestId("register-error")).toContainText("请输入账号");
  });

  test("register 前端校验：密码不足 6 位 → 提示", async ({ page }) => {
    await page.goto("/register");
    await page.getByTestId("register-username").fill("e2e-check-user");
    await page.getByTestId("register-displayname").fill("e2e");
    await page.getByTestId("register-password").fill("123");
    await page.getByTestId("register-submit").click();
    await expect(page.getByTestId("register-error")).toContainText("密码至少 6 位");
  });
});
