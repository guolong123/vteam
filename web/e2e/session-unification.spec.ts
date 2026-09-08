import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * session-unification Todo 12 · 团队会话团队化 Playwright 证据
 * ============================================================
 * 覆盖 page.tsx 四处改动：
 * 1. `data-testid="session-status"` 状态点随团队会话翻转（Todo 11 toTaskDto 已从团队会话行
 *    组装 sessionStatus；page 订阅 team: 域 + sessionSeed 消费该快照）。
 * 2. 重置按钮调 Todo 11 新路由 POST /teams/:teamId/members/:memberId/reset-session
 *   （旧 POST /tasks/:id/instances/:instanceId/reset-session 不再被调用）。
 * 3. 群消息任务分区列表不断裂（跨任务历史同一列表连续渲染；message DTO 无 taskId 列，
 *    客户端不做分区过滤，服务端分区 + 历史接口承担）。
 * QA failure：无会话成员在成员面板兜底显示“就绪”。
 *
 * 选择器依据（执行期 grep 会话页 + TeamMembersPanel 实测）：
 * - team-session-root / team-session-refresh / chat-message-list / members-panel /
 *   member-item / session-status / dm-tab-group（静态 testid）
 * - agent-more-<instanceId>（更多菜单，reset 入口载体；实例 key 取任务实例 id，如 ta_1）
 * - “重置会话”菜单项无 testid → members-panel 内按 role+name 定位
 *
 * 方法：全 /api/v1/* route-mock（SSE /events 直接 abort，零后端接触；
 * 未命中 mock 的请求 route.fallback 走真实后端只读， POST 类一律先拦截）。
 * 运行：`npx playwright test --config /tmp/su12.playwright.config.ts`（独立 config，
 * 不碰 playwright.config.ts——Todo 13 拥有；证据落 .omo/evidence/session-unification/su12/）。
 */

const TEAM_ID = "tm_0000000001";
const TASK_ID = "t_su12";
const MEMBER_ID = "tmm_1";
const CHANNEL_ID = "ch_group";
const EVIDENCE_DIR = path.join(
  process.cwd(),
  "..",
  ".omo",
  "evidence",
  "session-unification",
  "su12",
);

const iso = "2026-09-07T10:00:00.000Z";

function teamFixture() {
  return {
    id: TEAM_ID,
    name: "SU12 团队",
    description: null,
    reuseSession: true,
    currentTaskId: TASK_ID,
    mainAgentMemberId: "tmm_1",
    version: 1,
    createdBy: "u_seed_admin",
    createdAt: iso,
    updatedAt: iso,
    members: [
      { id: "tmm_1", teamId: TEAM_ID, agentId: "a_developer", alias: "Dev-1", seq: 1, workDir: "/tmp/su12", agent: { id: "a_developer", name: "开发者", role: "developer" } },
      { id: "tmm_2", teamId: TEAM_ID, agentId: "a_tester", alias: "Test-1", seq: 1, workDir: "/tmp/su12", agent: { id: "a_tester", name: "测试", role: "tester" } },
      { id: "tmm_3", teamId: TEAM_ID, agentId: "a_architect", alias: "Arch-1", seq: 1, workDir: "/tmp/su12", agent: { id: "a_architect", name: "架构师", role: "architect" } },
    ],
    userMembers: [],
    queue: [],
  };
}

function taskFixture(sessionStatuses: [string | null, string | null, string | null]) {
  const [s1, s2, s3] = sessionStatuses;
  return {
    id: TASK_ID,
    title: "SU12 任务",
    description: null,
    priority: "P1",
    status: "in_progress",
    mainAgentId: "a_developer",
    mainAgentInstanceId: "ta_1",
    managedMode: false,
    backgroundDocs: [],
    teamAgentIds: ["a_developer", "a_tester", "a_architect"],
    instances: [
      { id: "ta_1", agentId: "a_developer", alias: "Dev-1", seq: 1, name: "开发者", role: "developer", main: true, enabled: true, overrideModelId: null, sessionStatus: s1, sessionId: s1 ? "s_1" : null },
      { id: "ta_2", agentId: "a_tester", alias: "Test-1", seq: 1, name: "测试", role: "tester", main: false, enabled: true, overrideModelId: null, sessionStatus: s2, sessionId: s2 ? "s_2" : null },
      { id: "ta_3", agentId: "a_architect", alias: "Arch-1", seq: 1, name: "架构师", role: "architect", main: false, enabled: true, overrideModelId: null, sessionStatus: s3, sessionId: s3 ? "s_3" : null },
    ],
    teamId: TEAM_ID,
    createdBy: "u_seed_admin",
    createdAt: iso,
    startedAt: null,
    pendingReviewAt: null,
    completedAt: null,
    archivedAt: null,
    executionMode: "direct",
  };
}

function msg(id: string, senderType: string, senderId: string, senderInstanceId: string | null, text: string) {
  return {
    id,
    channelId: CHANNEL_ID,
    senderType,
    senderId,
    senderInstanceId,
    content: { text, parts: [] },
    mentions: [],
    attachmentUrl: null,
    attachmentName: null,
    attachmentType: null,
    status: "sent",
    createdAt: iso,
  };
}

function messagesFixture() {
  return {
    // message DTO 无 taskId 列：分区归属由服务端承担，客户端同一列表连续渲染跨任务历史。
    items: [
      msg("m_1", "user", "u_seed_admin", null, "开工共识：先出方案再写用例"),
      msg("m_2", "agent", "a_developer", "ta_1", "任务A结论：方案已出，请评审"),
      msg("m_3", "agent", "a_tester", "ta_2", "任务B结论：回归用例全部通过"),
    ],
    nextCursor: null,
  };
}

/** 为 page 安装全量 mock；taskSessions 控制三实例 sessionStatus；返回请求记录器。 */
async function installMocks(page: Page, taskSessions: [string | null, string | null, string | null]) {
  const seen: { method: string; path: string }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const apiPath = url.pathname.replace(/^\/api\/v1/, "") || "/";
    const method = req.method();
    if (apiPath === "/events") return route.abort(); // SSE  hermetic：页面走 REST 种子渲染
    if (method === "POST" && apiPath.endsWith("reset-session")) {
      seen.push({ method, path: apiPath });
      return route.fulfill({
        json: { teamId: TEAM_ID, memberId: MEMBER_ID, session: { id: "s_new", status: "created", teamMemberId: MEMBER_ID } },
      });
    }
    if (method === "GET" && apiPath === `/teams/${TEAM_ID}`) return route.fulfill({ json: teamFixture() });
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}`) return route.fulfill({ json: taskFixture(taskSessions) });
    if (method === "GET" && apiPath === "/channels") {
      return route.fulfill({ json: { items: [{ id: CHANNEL_ID, type: "team_group", teamId: TEAM_ID, taskId: null, agentId: null }], total: 1 } });
    }
    if (method === "GET" && apiPath === `/channels/${CHANNEL_ID}/messages`) return route.fulfill({ json: messagesFixture() });
    if (method === "GET" && apiPath === "/agents") return route.fulfill({ json: { items: [], total: 0 } });
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}/artifacts`) {
      return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 10 } });
    }
    if (method === "GET" && apiPath === "/issues") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } });
    if (method === "GET" && apiPath === "/plans") return route.fulfill({ json: {} });
    if (method === "GET" && apiPath === "/questions") return route.fulfill({ json: [] });
    return route.fallback();
  });
  return seen;
}

test.describe("Todo12 团队会话团队化", () => {
  test.use({ storageState: "/Users/mac/01work/git-project/vteam/web/.auth/user.json" });

  test.beforeAll(() => {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  });

  test("1. session-status 状态点随团队会话翻转", async ({ page }) => {
    await installMocks(page, ["running", "idle", null]);
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const dot = page.getByTestId("session-status");
    await expect(dot).toBeVisible();
    await expect(dot).toContainText("会话运行中");
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "01-status-on.png") });

    // 翻转：团队会话全 idle → 状态点消失（stale_state 对照：reload 重挂载重播种子）
    await installMocks(page, ["idle", "idle", "idle"]);
    await page.reload();
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("session-status")).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "02-status-off.png") });
  });

  test("2. 重置按钮调团队新路由", async ({ page }) => {
    const seen = await installMocks(page, ["running", "idle", null]);
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    // 更多菜单（agent-more-ta_1）→ 重置会话
    await page.getByTestId("agent-more-ta_1").click();
    const resetBtn = page.getByTestId("members-panel").getByRole("button", { name: "重置会话", exact: true });
    await expect(resetBtn).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "03-reset-menu.png") });
    await resetBtn.click();
    await expect
      .poll(() => seen.filter((s) => s.path.endsWith("reset-session")).length, { timeout: 10_000 })
      .toBe(1);
    expect(seen).toContainEqual({ method: "POST", path: `/teams/${TEAM_ID}/members/${MEMBER_ID}/reset-session` });
    // 旧任务路由零命中
    expect(seen.every((s) => !s.path.startsWith(`/tasks/${TASK_ID}/instances/`))).toBe(true);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "03-reset-done.png") });
  });

  test("3. 群消息任务分区列表不断裂", async ({ page }) => {
    await installMocks(page, ["running", "idle", null]);
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText("开工共识：先出方案再写用例").first()).toBeVisible();
    await expect(list.getByText("任务A结论：方案已出，请评审").first()).toBeVisible();
    await expect(list.getByText("任务B结论：回归用例全部通过").first()).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "04-group-partition.png") });
  });

  test("QA-failure. 无会话成员兜底显示就绪", async ({ page }) => {
    await installMocks(page, ["running", "idle", null]);
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const panel = page.getByTestId("members-panel");
    await expect(panel.getByText("Arch-1").first()).toBeVisible();
    // ta_3 无会话（sessionStatus null）→ 状态兜底“就绪”
    await expect(panel.getByText("就绪").first()).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "05-member-ready-fallback.png") });
  });
});
