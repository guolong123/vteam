/**
 * todo 9 (step 4d) — FRESH-stack UI proof: role colours/labels render from the new
 * data source (AgentRole keyed by TeamMember.roleId / agentKey), on the pages migrated
 * by todo 6. Reuses the todo-6 approach: capture computed styles + visible labels.
 */
import { test, expect } from "@playwright/test";

test.describe("task-9 fresh-stack role rendering", () => {
  test("agents list: avatar data-role + computed colours (7 seeds)", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("agent-list-item").first()).toBeVisible();
    const rows = page.getByTestId("agent-list-item");
    const n = await rows.count();
    const facts: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const id = await row.getAttribute("data-agent-id");
      const avatar = row.getByTestId("agent-avatar").first();
      const role = await avatar.getAttribute("data-role");
      facts.push(
        `${id} data-role=${role} bg=${await avatar.evaluate((el) => getComputedStyle(el).backgroundColor)} border=${await avatar.evaluate((el) => getComputedStyle(el).borderTopColor)}`,
      );
    }
    console.log("AGENT_ROWS_BEGIN");
    facts.forEach((f) => console.log(f));
    console.log("AGENT_ROWS_END");
    expect(facts.length).toBe(7);
    // every seeded template must resolve a NON-fallback role key
    for (const key of ["product", "project_manager", "architect", "developer", "tester", "plan", "librarian"]) {
      expect(facts.some((f) => f.includes(`data-role=${key} `))).toBe(true);
    }
    await page.screenshot({ path: ".omo/evidence/agent-role-decommission/task-9-fresh/t9-agents.png", fullPage: true });
  });

  test("team detail: member rows carry role key + alias, no empty labels", async ({ page }) => {
    await page.goto("/teams/tm_0000000001");
    await expect(page.getByTestId("member-row").first()).toBeVisible();
    const rows = page.getByTestId("member-row");
    const n = await rows.count();
    const facts: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      const avatar = row.getByTestId("agent-avatar").first();
      const role = await avatar.getAttribute("data-role");
      facts.push(`${await row.getAttribute("data-member-id")} | avatar=${role} | ${(await row.innerText()).replace(/\s+/g, " ").trim()}`);
    }
    console.log("MEMBER_ROWS_BEGIN");
    facts.forEach((f) => console.log(f));
    console.log("MEMBER_ROWS_END");
    expect(facts.length).toBe(7);
    for (const f of facts) expect(f).not.toMatch(/avatar=(null|)\s*\|/);
    await page.screenshot({ path: ".omo/evidence/agent-role-decommission/task-9-fresh/t9-team-members.png", fullPage: true });
  });

  test("create-agent modal: role picker lists AgentRole rows (not a dead role string)", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByTestId("agent-list-item").first()).toBeVisible();
    await page.getByTestId("create-agent-button").click();
    const select = page.getByTestId("create-agent-role");
    await expect(select).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => select.locator("option").count()).toBeGreaterThan(1);
    const texts = await select.locator("option").allInnerTexts();
    console.log("CREATE_ROLE_OPTIONS_BEGIN");
    texts.forEach((t) => console.log(t.replace(/\s+/g, " ").trim()));
    console.log("CREATE_ROLE_OPTIONS_END");
    expect(texts.length).toBeGreaterThan(1);
  });
});
