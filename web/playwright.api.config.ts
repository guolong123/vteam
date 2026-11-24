import { defineConfig } from "@playwright/test";

/**
 * 多工作空间 API 级 E2E 配置（不需要浏览器、不需要 web 端口）。
 * 直接打后端（默认本地 13100，已迁移+seed 的测试库）：
 *   WORKSPACE_API_BASE=http://127.0.0.1:13100/api/v1 npx playwright test --config=playwright.api.config.ts
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /workspace-(isolation|crud)(\.[a-z-]+)?\.api\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
