import { defineConfig } from "@playwright/test";

/**
 * 用户视角功能验收（真实浏览器操作 + 逐步截图）。
 * 前置：compose 测试栈 web 13201 / API 13200（或 dev 3012 + 13200）。
 *   WORKSPACE_API_BASE=http://127.0.0.1:13200/api/v1 \
 *   WORKSPACE_WEB_BASE=http://127.0.0.1:13201 \
 *   npx playwright test --config=playwright.functional.config.ts
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /workspace-functional\.ui\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.WORKSPACE_WEB_BASE ?? "http://127.0.0.1:13201",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
});
