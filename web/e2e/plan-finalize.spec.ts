import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * plan finalize gate · 会话计划 Tab 待定稿态断言 + 截图
 * =====================================================
 * 自包含（不依赖 setup 登录态与后端 DB）：
 * - localStorage 预置 agent-platform-auth（成员 e2e-member）
 * - page.route 全量 mock 会话页 API，SSE 直接 abort
 * - pending_final 截图 + approved 对照截图 + asserts.json 落
 *   .omo/evidence/plan-finalize-gate/
 */

const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../.omo/evidence/plan-finalize-gate",
);

type PlanStatus = "draft" | "pending_final" | "approved" | "executing" | "completed";

const scenario: { planStatus: PlanStatus; taskId: string } = {
  planStatus: "pending_final",
  taskId: "t_plan_pending_final",
};

const LEDGER = {
  schemaVersion: 1,
  round: 1,
  planVersion: { version: "v3", lines: 120, hash: "a1b2c3d4" },
  planPath: ".opencode/plans/e2e-plan.md",
  taskId: "t_plan_pending_final",
  issueId: "is_0000000001",
  expected: ["tmm_0000000001", "tmm_0000000002", "tmm_0000000003"],
  expectedRoles: ["架构视角", "开发视角", "测试视角"],
  received: {
    tmm_0000000001: { verdict: "APPROVE", msgId: "m_0000000001", version: "v3" },
    tmm_0000000002: { verdict: "APPROVE", msgId: "m_0000000002", version: "v3" },
    tmm_0000000003: { verdict: "APPROVE", msgId: "m_0000000003", version: "v3" },
  },
  status: "complete",
  timeoutAt: "2026-09-16T00:40:00Z",
};

const LEDGER_TEXT = `评审收敛 R1（v3，3/3 APPROVE）\n\n<!-- REVIEW-ROUND-JSON -->\n\`\`\`json\n${JSON.stringify(LEDGER, null, 2)}\n\`\`\``;

const TEAM_MEMBERS = [
  { id: "tmm_0000000001", agentId: "a_arch", alias: "架构师", seq: 1, agent: { id: "a_arch", name: "架构师", role: "architect" } },
  { id: "tmm_0000000002", agentId: "a_dev", alias: "开发者", seq: 1, agent: { id: "a_dev", name: "开发者", role: "developer" } },
  { id: "tmm_0000000003", agentId: "a_tester", alias: "测试", seq: 1, agent: { id: "a_tester", name: "测试", role: "tester" } },
];

function teamJson(taskId: string) {
  return {
    id: "tm_0000000001",
    name: "E2E 团队",
    description: "定稿门 e2e 夹具",
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
    title: "定稿确认 e2e",
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
    plan: { id: "pl_e2e", taskId, title: "定稿确认 e2e", status, createdBy: "system", confirmedBy: null, confirmedAt: null, finalizedBy: null, finalizedAt: null, rejectReason: null },
    status,
    source: "db",
    fileDocs: { displayOnly: true, count: 0, degraded: false },
  };
}

function issuesJson(taskId: string) {
  return {
    items: [
      { id: "is_0000000001", taskId, title: "评审派发 R1", status: "open", description: LEDGER_TEXT },
    ],
    total: 1,
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
  // glob 单星号不跨 `/`：用 pathname 前缀谓词覆盖 /tasks/t_final_*/plan 等深层路径
  await page.route((url) => url.pathname.startsWith("/api/v1/tasks/t_final_"), (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes("/plan/confirm") && method === "POST") {
      const body = route.request().postDataJSON() as { action?: string } | null;
      const action = body?.action ?? "confirm";
      if (action === "finalize") {
        scenario.planStatus = "approved";
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ plan: { status: "approved" }, idempotent: false, action: "finalize" }),
        });
      }
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

test.describe("定稿门会话计划 Tab（mock API）", () => {
  test("pending_final 待定稿琥珀徽 + 确认定稿按钮二次确认翻转 approved", async ({ page }) => {
    scenario.planStatus = "pending_final";
    scenario.taskId = "t_final_pending";
    await seedMemberAuth(page);
    await mockSessionApis(page);
    const block = await openPlanTab(page);
    const badge = page.getByTestId("plan-status-badge");
    await expect(badge).toHaveText("待定稿");
    await expect(badge).toHaveAttribute("data-status", "pending_final");
    await expect(badge).toHaveCSS("color", "rgb(217, 119, 6)");
    // 定稿按钮可见，开始执行按钮不可见
    const finalizeBtn = page.getByTestId("plan-finalize-btn");
    await expect(finalizeBtn).toBeVisible();
    await expect(finalizeBtn).toHaveText("确认定稿");
    await expect(page.getByTestId("plan-confirm-btn")).toHaveCount(0);
    await finalizeBtn.click();
    const modal = page.getByTestId("plan-finalize-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("确认定稿");
    await modal.screenshot({ path: path.join(EVIDENCE_DIR, "plan-pending-final.png") });
    await page.getByTestId("plan-finalize-confirm").click();
    // 定稿后翻 approved：待执行徽 + 开始执行按钮出现 + 定稿按钮消失
    await expect(page.getByTestId("plan-status-badge")).toHaveText("待执行");
    await expect(page.getByTestId("plan-confirm-btn")).toBeVisible();
    await expect(page.getByTestId("plan-finalize-btn")).toHaveCount(0);
    await block.screenshot({ path: path.join(EVIDENCE_DIR, "plan-after-finalize.png") });
    asserts["pending_final"] = { badge: "待定稿", finalizeFlow: "modal→POST finalize→approved", afterFinalize: "待执行" };
  });

  test("approved 态无定稿按钮（仅开始执行按钮）", async ({ page }) => {
    scenario.planStatus = "approved";
    scenario.taskId = "t_final_approved";
    await seedMemberAuth(page);
    await mockSessionApis(page);
    await openPlanTab(page);
    await expect(page.getByTestId("plan-status-badge")).toHaveText("待执行");
    await expect(page.getByTestId("plan-confirm-btn")).toBeVisible();
    await expect(page.getByTestId("plan-finalize-btn")).toHaveCount(0);
    asserts["approved"] = { badge: "待执行", finalizeBtn: 0, confirmBtn: 1 };
  });

  test("draft 态两按钮皆不可见", async ({ page }) => {
    scenario.planStatus = "draft";
    scenario.taskId = "t_final_draft";
    await seedMemberAuth(page);
    await mockSessionApis(page);
    await openPlanTab(page);
    await expect(page.getByTestId("plan-status-badge")).toHaveText("修订中");
    await expect(page.getByTestId("plan-finalize-btn")).toHaveCount(0);
    await expect(page.getByTestId("plan-confirm-btn")).toHaveCount(0);
    asserts["draft"] = { badge: "修订中", finalizeBtn: 0, confirmBtn: 0 };
  });

  test.afterAll(async () => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, "asserts.json"), `${JSON.stringify({ finalizeGate: true, asserts }, null, 2)}\n`);
  });
});
