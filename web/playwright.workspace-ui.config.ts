import { defineConfig } from "@playwright/test";

/**
 * 多工作空间前端 UI 验收（真实浏览器 + 已登录 storageState 注入）。
 * 前置：后端 13100（测试库）、web 3011（API_PROXY_TARGET 指向后端）。
 *   npx playwright test --config=playwright.workspace-ui.config.ts
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /(workspace-ui|workspace-crud\.ui)\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.WORKSPACE_WEB_BASE ?? "http://127.0.0.1:3011",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
