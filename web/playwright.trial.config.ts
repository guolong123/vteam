import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-trial",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "/tmp/e2e-trial.json" }]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    headless: false,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "trial", testMatch: /.*\.spec\.ts/ }],
});
