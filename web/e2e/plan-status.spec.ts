import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * plan-review-execution-gates todo 12 · 会话计划 Tab 状态 UI 断言 + 截图
 * =====================================================================
 * 自包含（不依赖 setup 登录态与后端 DB）：
 * - localStorage 预置 agent-platform-auth（成员 e2e-member，permissions {all:false}→成员只读）
 * - page.route 全量 mock 会话页 API（team/task/channels/messages/artifacts/plan-docs/
 *   plan-steps/issues/agents/questions/plan/plan-confirm），SSE 直接 abort
 * - 四态各 1 截图 + asserts.json 落 .omo/evidence/plan-review-execution-gates/task-12/
 */

const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../.omo/evidence/plan-review-execution-gates/task-12",
);

type PlanStatus = "draft" | "approved" | "executing" | "completed";

const scenario: { planStatus: PlanStatus; taskId: string } = {
  planStatus: "draft",
  taskId: "t_plan_draft",
};

const LEDGER = {
  schemaVersion: 1,
  round: 1,
  planVersion: { version: "v3", lines: 120, hash: "a1b2c3d4" },
  planPath: ".opencode/plans/e2e-plan.md",
  taskId: "t_plan_draft",
  issueId: "is_0000000001",
  expected: ["tmm_0000000001", "tmm_0000000002", "tmm_0000000003"],
  expectedRoles: ["架构视角", "开发视角", "测试视角"],
  received: {
    tmm_0000000001: { verdict: "APPROVE", msgId: "m_0000000001", version: "v3" },
  },
  status: "collecting",
  timeoutAt: "2026-09-16T00:40:00Z",
};

const LEDGER_TEXT = `评审派发 R1（v3，期望 架构/开发/测试 三视角）\n\n<!-- REVIEW-ROUND-JSON -->\n\`\`\`json\n${JSON.stringify(LEDGER, null, 2)}\n\`\`\``;

const TEAM_MEMBERS = [
  { id: "tmm_0000000001", agentId: "a_arch", alias: "架构师", seq: 1, agent: { id: "a_arch", name: "架构师", role: "architect" } },
  { id: "tmm_0000000002", agentId: "a_dev", alias: "开发者", seq: 1, agent: { id: "a_dev", name: "开发者", role: "developer" } },
  { id: "tmm_0000000003", agentId: "a_tester", alias: "测试", seq: 1, agent: { id: "a_tester", name: "测试", role: "tester" } },
];

function teamJson(taskId: string) {
  return {
    id: "tm_0000000001",
    name: "E2E 团队",
    description: "计划 Tab 状态断言夹具",
    members: TEAM_MEMBERS,
    mainAgentMemberId: "tmm_0000000001",
    currentTaskId: taskId,
    queue: [],
    reuseSession: true,
    managedMode: false,
  };
}

function taskJson(taskId: string) {
  return {
    id: taskId,
    title: "计划确认 e2e",
    description: "",
    status: "in_progress",
    priority: "medium",
    teamId: "tm_0000000001",
    instances: [],
    mainAgentInstanceId: null,
    planMode: false,
    effectivePlanMode: false,
  };
}

function planJson(status: PlanStatus, taskId: string) {
  return {
    plan: { id: "pl_e2e", taskId, title: "计划确认 e2e", status, createdBy: "system", confirmedBy: null, confirmedAt: null, rejectReason: null },
    status,
    source: "db",
    fileDocs: { displayOnly: true, count: 0, degraded: false },
  };
}

function issuesJson(taskId: string) {
  void taskId;
  return {
    items: [
      { id: "is_0000000001", taskId: scenario.taskId, title: "评审派发 R1", status: "open", description: LEDGER_TEXT },
      { id: "is_0000000002", taskId: scenario.taskId, title: "开发实现", status: "in_progress", description: null },
      { id: "is_0000000003", taskId: scenario.taskId, title: "联调验证", status: "resolved", description: null },
    ],
    total: 3,
    page: 1,
    pageSize: 100,
  };
}

async function mockSessionApis(page: import("@playwright/test").Page) {
  await page.route("**/api/v1/events*", (route) => route.abort());
  await page.route("**/api/v1/teams/tm_0000000001", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(teamJson(scenario.taskId)) });
  });
  // glob 单星号不跨 `/`：用 pathname 前缀谓词覆盖 /tasks/t_plan_*/plan 等深层路径
  await page.route((url) => url.pathname.startsWith("/api/v1/tasks/t_plan_"), (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/plan/confirm") && method === "POST") {
      scenario.planStatus = "executing";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ plan: { status: "executing" }, idempotent: false, action: "confirm" }),
      });
    }
    if (url.endsWith("/plan") && method === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(planJson(scenario.planStatus, scenario.taskId)) });
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
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(taskJson(scenario.taskId)) });
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
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(issuesJson(scenario.taskId)) });
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

/** 进入会话页 → 切到任务 Tab → 计划子 Tab，返回计划状态块定位器。 */
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

test.describe("todo12 会话计划 Tab 状态 UI（mock API）", () => {
  test("draft 修订中灰徽 + 版本轮次行 + 点名进度，无确认按钮", async ({ page }) => {
    scenario.planStatus = "draft";
    scenario.taskId = "t_plan_draft";
    await seedMemberAuth(page);
    await mockSessionApis(page);
    const block = await openPlanTab(page);
    const badge = page.getByTestId("plan-status-badge");
    await expect(badge).toHaveText("修订中");
    await expect(badge).toHaveAttribute("data-status", "draft");
    await expect(page.getByTestId("plan-version-line")).toHaveText("v3·R1·1/3");
    const progress = page.getByTestId("plan-round-progress");
    await expect(progress).toContainText("待 开发者、测试 回执（1/3）");
    await expect(page.getByTestId("plan-confirm-btn")).toHaveCount(0);
    await expect(page.getByTestId("plan-checklist")).toHaveCount(0);
    await block.screenshot({ path: path.join(EVIDENCE_DIR, "plan-draft.png") });
    asserts["draft"] = { badge: "修订中", versionLine: "v3·R1·1/3", progress: "待 开发者、测试 回执（1/3）", confirmBtn: 0, checklist: 0 };
  });

  test("approved 待执行琥珀徽 + 确认按钮二次确认翻转 executing", async ({ page }) => {
    scenario.planStatus = "approved";
    scenario.taskId = "t_plan_approved";
    await seedMemberAuth(page);
    await mockSessionApis(page);
    await openPlanTab(page);
    const badge = page.getByTestId("plan-status-badge");
    await expect(badge).toHaveText("待执行");
    await expect(badge).toHaveCSS("color", "rgb(217, 119, 6)");
    const btn = page.getByTestId("plan-confirm-btn");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText("确认开始执行");
    await btn.click();
    const modal = page.getByTestId("plan-confirm-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("确认开始执行");
    await modal.screenshot({ path: path.join(EVIDENCE_DIR, "plan-approved.png") });
    await page.getByTestId("plan-confirm-confirm").click();
    await expect(page.getByTestId("plan-status-badge")).toHaveText("执行中");
    await expect(page.getByTestId("plan-confirm-btn")).toHaveCount(0);
    await expect(page.getByTestId("plan-checklist")).toBeVisible();
    asserts["approved"] = { badge: "待执行", confirmFlow: "modal→POST→executing", afterConfirm: "执行中" };
  });

  test("executing 执行中蓝徽 + 执行清单聚合 issue 状态", async ({ page }) => {
    scenario.planStatus = "executing";
    scenario.taskId = "t_plan_executing";
    await seedMemberAuth(page);
    await mockSessionApis(page);
    const block = await openPlanTab(page);
    const badge = page.getByTestId("plan-status-badge");
    await expect(badge).toHaveText("执行中");
    await expect(badge).toHaveCSS("color", "rgb(13, 148, 136)");
    const checklist = page.getByTestId("plan-checklist");
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText("共 3 项 · 待处理 1 · 进行中 1 · 已解决 1 · 已关闭 0 · 已拒绝 0");
    await expect(checklist).toContainText("评审派发 R1");
    await expect(checklist).toContainText("开发实现");
    await expect(checklist).toContainText("联调验证");
    await expect(page.getByTestId("plan-confirm-btn")).toHaveCount(0);
    await block.screenshot({ path: path.join(EVIDENCE_DIR, "plan-executing.png") });
    asserts["executing"] = { badge: "执行中", checklistSummary: "共 3 项 · 待处理 1 · 进行中 1 · 已解决 1 · 已关闭 0 · 已拒绝 0" };
  });

  test("completed 完成绿徽，无按钮无清单", async ({ page }) => {
    scenario.planStatus = "completed";
    scenario.taskId = "t_plan_completed";
    await seedMemberAuth(page);
    await mockSessionApis(page);
    const block = await openPlanTab(page);
    const badge = page.getByTestId("plan-status-badge");
    await expect(badge).toHaveText("完成");
    await expect(badge).toHaveCSS("color", "rgb(5, 150, 105)");
    await expect(page.getByTestId("plan-confirm-btn")).toHaveCount(0);
    await expect(page.getByTestId("plan-checklist")).toHaveCount(0);
    await block.screenshot({ path: path.join(EVIDENCE_DIR, "plan-completed.png") });
    asserts["completed"] = { badge: "完成", confirmBtn: 0, checklist: 0 };
  });

  test.afterAll(async () => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, "asserts.json"), `${JSON.stringify({ todo: 12, asserts }, null, 2)}\n`);
  });
});
