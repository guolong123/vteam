import { defineConfig } from "@playwright/test";

/**
 * Phase 5 T9 · Playwright QA 套件配置
 * =============================================
 * - baseURL：http://localhost:3001（web dev server，假定已运行；不配置 webServer 自启）
 * - 浏览器：chromium，channel 显式指系统 chrome（本机 ms-playwright 缓存与 CLI 版本不匹配，
 *   T4/T5 已实证 channel=chrome 可用；不依赖 playwright 自带浏览器下载）
 * - projects 分层：
 *   setup  → auth.setup.ts 真实表单登录（seed-admin/Admin@123456）→ storageState .auth/user.json
 *   login  → login.spec.ts  登录页 UI 断言（无 storageState，测登录本身）
 *   pages  → pages.spec.ts  17 页 testid 断言（依赖 setup 的登录态）
 *   perf   → perf.spec.ts   性能 E2E（页面加载 + 群聊 SSE + 首字；依赖登录态）
 *   guard  → guard.spec.ts  未登录跳转 /login（无 storageState）
 * - 注意：QA 数据账号用 seed-admin（T8 实证：projectMember 归属 seed-admin，
 *   admin 登录后 /projects 为空 → 数据型 testid 无法断言）。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "../.omo/evidence/phase5-t9-playwright.json" }],
  ],
  use: {
    baseURL: "http://localhost:3001",
    // 本机 ms-playwright 缓存（chromium-1208）与 @playwright/test 1.62.1 需要的
    // chromium_headless_shell-1234 不匹配（T4/T5 已实证）→ 用系统 chrome
    channel: "chrome",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "login", testMatch: /login\.spec\.ts/, dependencies: ["setup"] },
    {
      name: "pages",
      testMatch: /pages\.spec\.ts/,
      use: { storageState: ".auth/user.json" },
      dependencies: ["setup"],
    },
    {
      name: "perf",
      testMatch: /perf\.spec\.ts/,
      use: { storageState: ".auth/user.json" },
      dependencies: ["setup"],
    },
    { name: "guard", testMatch: /guard\.spec\.ts/ },
  ],
});
