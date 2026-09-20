import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:13001",
    channel: "chrome",
    trace: "off",
  },
  projects: [
    { name: "setup", testMatch: /t9-auth\.setup\.ts/ },
    {
      name: "task-9",
      testMatch: /t9-role-proof\.spec\.ts/,
      use: { storageState: ".auth/t9-user.json" },
      dependencies: ["setup"],
    },
  ],
});
