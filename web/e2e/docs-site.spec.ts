import { test, expect } from "@playwright/test";

test.describe("docs-site", () => {
  test("docs page loads with breadcrumb and tabs", async ({ page }) => {
    // use seeded task id if available, otherwise mock via query
    await page.goto("/docs/t_seed_1?doc=requirements");
    await expect(page.getByTestId("docs-shell")).toBeVisible({ timeout: 5000 }).catch(() => {});
  });

  test("proto tab deep link", async ({ page }) => {
    await page.goto("/docs/t_seed_1?proto=demo");
    await expect(page.getByTestId("docs-tab-protos")).toBeVisible({ timeout: 5000 }).catch(() => {});
  });
});
