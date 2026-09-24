import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * plan-finalize-actions todo 6 · 归档入口 + 冻结版本号展示断言 + 截图
 * =====================================================================
 * 自包含（不依赖 setup 登录态与后端 DB）：
 * - localStorage 预置 agent-platform-auth（成员 e2e-member）
 * - page.route 全量 mock 会话页 API；SSE 直接 abort
 * - 断言 + 截图落 .omo/evidence/plan-finalize-actions/task-6/（ui.png + asserts.json）
 */

const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../.omo/evidence/plan-finalize-actions/task-6",
);

const LEDGER_R2 = {
  schemaVersion: 1,
  round: 2,
  planVersion: { version: "v4", lines: 140, hash: "e5f6a7b8" },
  planPath: ".opencode/plans/e2e-plan.md",
  taskId: "t_plan_archive",
  issueId: "is_0000000011",
  expected: ["tmm_0000000001", "tmm_0000000002", "tmm_0000000003"],
  expectedRoles: ["架构视角", "开发视角", "测试视角"],
  received: {
    tmm_0000000001: { verdict: "APPROVE", msgId: "m_0000000101", version: "v4" },
    tmm_0000000002: { verdict: "APPROVE", msgId: "m_0000000102", version: "v4" },
  },
  superseded: [
    { member: "tmm_0000000003", verdict: "REJECT", msgId: "m_0000000091", version: "v3" },
  ],
  status: "collecting",
  timeoutAt: "2026-09-16T00:40:00Z",
};

const LEDGER_R1 = {
  schemaVersion: 1,
  round: 1,
  planVersion: { version: "v3", lines: 120, hash: "a1b2c3d4" },
  planPath: ".opencode/plans/e2e-plan.md",
  taskId: "t_plan_archive",
  issueId: "is_0000000010",
  expected: ["tmm_0000000001", "tmm_0000000002", "tmm_0000000003"],
  expectedRoles: ["架构视角", "开发视角", "测试视角"],
  received: {
    tmm_0000000001: { verdict: "APPROVE", msgId: "m_0000000081", version: "v3" },
    tmm_0000000002: { verdict: "REJECT", msgId: "m_0000000082", version: "v3" },
    tmm_0000000003: { verdict: "APPROVE", msgId: "m_0000000083", version: "v3" },
  },
  superseded: [
    { member: "tmm_0000000001", verdict: "REJECT", msgId: "m_0000000071", version: "v2" },
  ],
  status: "complete",
  timeoutAt: "2026-09-15T00:40:00Z",
};

const ledgerText = (ledger: unknown, label: string) =>
  `${label}\n\n<!-- REVIEW-ROUND-JSON -->\n\`\`\`json\n${JSON.stringify(ledger, null, 2)}\n\`\`\``;

const TEAM_MEMBERS = [
  { id: "tmm_0000000001", agentId: "a_arch", alias: "架构师", seq: 1, agent: { id: "a_arch", name: "架构师", role: "architect" } },
  { id: "tmm_0000000002", agentId: "a_dev", alias: "开发者", seq: 1, agent: { id: "a_dev", name: "开发者", role: "developer" } },
  { id: "tmm_0000000003", agentId: "a_tester", alias: "测试", seq: 1, agent: { id: "a_tester", name: "测试", role: "tester" } },
];

const TASK_ID = "t_plan_archive";

function teamJson() {
  return {
    id: "tm_0000000001",
    name: "E2E 团队",
    description: "归档入口断言夹具",
    members: TEAM_MEMBERS,
    mainAgentMemberId: "tmm_0000000001",
    currentTaskId: TASK_ID,
    queue: [],
    reuseSession: true,
    managedMode: false,
  };
}

function taskJson() {
  return {
    id: TASK_ID,
    title: "归档入口 e2e",
    description: "",
    status: "in_progress",
    priority: "medium",
    teamId: "tm_0000000001",
    mainAgentMemberId: "tmm_0000000001",
    instances: [],
  };
}

function planJson() {
  return {
    plan: {
      id: "pl_e2e",
      taskId: TASK_ID,
      title: "归档入口 e2e",
      status: "approved",
      createdBy: "system",
      confirmedBy: null,
      confirmedAt: null,
      rejectReason: null,
      frozenVersion: "v4",
      frozenHash: "e5f6a7b8",
    },
    status: "approved",
    source: "db",
    fileDocs: { displayOnly: true, count: 0, degraded: false },
  };
}

function issuesJson() {
  return {
    items: [
      { id: "is_0000000011", taskId: TASK_ID, title: "评审派发 R2", status: "open", description: ledgerText(LEDGER_R2, "评审派发 R2（v4）") },
      { id: "is_0000000010", taskId: TASK_ID, title: "评审派发 R1", status: "closed", description: ledgerText(LEDGER_R1, "评审派发 R1（v3）") },
    ],
    total: 2,
    page: 1,
    pageSize: 100,
  };
}

async function mockSessionApis(page: import("@playwright/test").Page) {
  await page.route("**/api/v1/events*", (route) => route.abort());
  await page.route("**/api/v1/teams/tm_0000000001", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(teamJson()) });
  });
  await page.route((url) => url.pathname.startsWith("/api/v1/tasks/t_plan_"), (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.endsWith("/plan") && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(planJson()) });
    }
    if (url.includes("/plan-docs") && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ files: [], workerId: null, directory: ".opencode/plans", degraded: false }) });
    }
    if (url.includes("/plan-steps") && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ steps: [], workerId: null, degraded: false }) });
    }
    if (url.includes("/artifacts") && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 10 }) });
    }
    if (method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(taskJson()) });
    }
    return route.fallback();
  });
  await page.route("**/api/v1/channels**", (route) => {
    const url = route.request().url();
    if (url.includes("/messages")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], nextCursor: null }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [{ id: "ch_0000000001", type: "team_group", teamId: "tm_0000000001" }], total: 1 }),
    });
  });
  await page.route("**/api/v1/issues**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(issuesJson()) });
  });
  await page.route("**/api/v1/agents", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0 }) }),
  );
  await page.route("**/api/v1/questions**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });
}

async function seedMemberAuth(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "agent-platform-auth",
      JSON.stringify({
        state: {
          token: "e2e-member-token",
          user: { id: "u_e2e", username: "e2e-member", displayName: "E2E成员", role: "member", permissions: { all: false } },
        },
        version: 0,
      }),
    );
  });
}

async function openPlanTab(page: import("@playwright/test").Page) {
  await page.goto("/teams/tm_0000000001/session");
  await expect(page.getByTestId("team-session-root")).toBeVisible();
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await page.getByRole("button", { name: "计划", exact: true }).click();
  const block = page.getByTestId("plan-status-block");
  await expect(block).toBeVisible();
  return block;
}

const asserts: Record<string, unknown> = {};

test.describe("todo6 归档入口 + 冻结版本号展示（mock API）", () => {
  test("冻结版本可见 + 归档入口点达旧轮次回执", async ({ page }) => {
    await seedMemberAuth(page);
    await mockSessionApis(page);
    const block = await openPlanTab(page);
    await expect(page.getByTestId("plan-version-line")).toHaveText("v4·R2·2/3");
    await expect(page.getByTestId("plan-frozen-version")).toHaveText("v4");
    await expect(page.getByTestId("plan-frozen-hash")).toContainText("e5f6a7b8");
    const toggle = page.getByTestId("plan-archive-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText("归档回执（2）");
    await expect(page.getByTestId("plan-archive-item")).toHaveCount(0);
    await toggle.click();
    const items = page.getByTestId("plan-archive-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute("data-round", "2");
    await expect(items.nth(0)).toHaveAttribute("data-version", "v3");
    await expect(items.nth(1)).toHaveAttribute("data-round", "1");
    await expect(items.nth(1)).toHaveAttribute("data-version", "v2");
    await expect(items.nth(1)).toContainText("架构师");
    await block.screenshot({ path: path.join(EVIDENCE_DIR, "ui.png") });
    asserts["archive"] = {
      versionLine: "v4·R2·2/3",
      frozenVersion: "v4",
      frozenHash: "e5f6a7b8",
      toggle: "归档回执（2）",
      items: [
        { round: 2, version: "v3" },
        { round: 1, version: "v2" },
      ],
    };
  });

  test.afterAll(async () => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, "asserts.json"), `${JSON.stringify({ todo: 6, asserts }, null, 2)}\n`);
  });
});
