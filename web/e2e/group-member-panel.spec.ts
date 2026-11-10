import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

/**
 * 群聊成员状态角标 + 成员视角右栏 e2e（2026-11-10）
 * =====================================================
 * 锁两条产品语义：
 *
 * 1. **成员工作中时头像要有状态角标**
 *    - 成员切换条 chip（`group-member-chip[data-presence=running]` → 内含黄点）
 *    - 顶部头像组（只展示前 5 个，但**按工作状态优先排序**，保证执行中成员不被裁掉）
 *    根因修复：`teamQuery` 此前不轮询，`seat.sessionStatus` 冻结在 idle ⇒ 开始执行后
 *    角标永远不变黄。本 spec 通过「先 idle 再 running 的响应切换」覆盖轮询语义。
 *
 * 2. **点上方成员头像 = 进入成员视角，右栏显示成员信息（而非团队信息）**
 *    - 选中后出现 `group-member-context-panel`，团队/任务面板（`task-panel`）让出；
 *    - 面板含：名字、工作状态（与角标同一判定来源）、Agent、席位 ID、视角内消息数；
 *    - 「返回团队」→ 成员面板消失、团队面板恢复。
 *
 * 全 route-mock，零后端接触。
 */

const TEAM_ID = "tm_0000000001";
const CHANNEL_ID = "c_0000000001";
const TASK_ID = "t_0000000001";
const RUNNING_SEAT = "tmm_0000000002";
const RUNNING_NAME = "周一项";
const iso = "2026-11-10T13:00:00.000Z";

const SEATS = [
  { id: "tmm_0000000001", alias: "林一架", agent: "架构师", role: "architect" },
  { id: RUNNING_SEAT, alias: RUNNING_NAME, agent: "项目经理", role: "project_manager" },
  { id: "tmm_0000000003", alias: "文一知", agent: "文档", role: "doc_writer" },
];

/** 席位状态由参数控制：本 spec 用它模拟「执行中」。 */
function teamFixture(runningSeatId: string) {
  return {
    id: TEAM_ID,
    name: "e2e 群聊团队",
    description: null,
    reuseSession: true,
    currentTaskId: TASK_ID,
    currentTaskTitle: "e2e 任务",
    currentTaskStatus: "in_progress",
    mainAgentMemberId: RUNNING_SEAT,
    version: 1,
    createdBy: "u_seed_admin",
    createdAt: iso,
    updatedAt: iso,
    members: SEATS.map((s, i) => ({
      id: s.id,
      teamId: TEAM_ID,
      memberId: null,
      agentId: `a_${s.role}`,
      roleId: `ar_${s.role}`,
      alias: s.alias,
      seq: i + 1,
      workDir: `/data/vteam-worker/${s.alias}`,
      member: null,
      agent: { id: `a_${s.role}`, name: s.agent, role: s.role },
      // 只有目标席位处于执行中
      sessionStatus:
        s.id === runningSeatId
          ? { busyState: "running", busySince: iso, lastTurnOutcome: null, lastActivityAt: iso }
          : { busyState: "idle", busySince: null, lastTurnOutcome: null, lastActivityAt: null },
      createdAt: iso,
    })),
    userMembers: [],
  };
}

function taskFixture() {
  return {
    id: TASK_ID,
    title: "e2e 任务",
    description: null,
    priority: "P1",
    status: "in_progress",
    mainAgentMemberId: RUNNING_SEAT,
    managedMode: false,
    backgroundDocs: [],
    teamAgentIds: SEATS.map((s) => `a_${s.role}`),
    instances: SEATS.map((s, i) => ({
      id: s.id,
      agentId: `a_${s.role}`,
      alias: s.alias,
      seq: i + 1,
      name: s.agent,
      role: s.role,
      main: s.id === RUNNING_SEAT,
      enabled: true,
      overrideModelId: null,
      sessionStatus: "idle",
      sessionId: `s_${i}`,
    })),
    teamId: TEAM_ID,
    createdBy: "u_seed_admin",
    createdAt: iso,
    startedAt: iso,
    pendingReviewAt: null,
    completedAt: null,
    archivedAt: null,
    resetAfterComplete: false,
    longRunning: false,
  };
}

function groupMessagesFixture() {
  return {
    items: [
      {
        id: "m_group_1",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: RUNNING_SEAT,
        content: { text: "群聊里只有这条结论", parts: [{ type: "text", text: "群聊里只有这条结论" }] },
        mentions: [],
        status: "sent",
        createdAt: iso,
      },
    ],
    nextCursor: null,
  };
}

function memberHistoryFixture() {
  return {
    items: [
      {
        id: "m_member_1",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: RUNNING_SEAT,
        content: {
          text: "我查一下配置",
          parts: [
            { type: "reasoning", state: "done", text: "先看看配置" },
            { type: "tool", name: "bash", state: { status: "success", input: "cat config.json", output: "{}" } },
            { type: "text", text: "我查一下配置" },
          ],
        },
        mentions: [],
        status: "sent",
        createdAt: iso,
      },
    ],
    nextCursor: null,
    source: "session",
  };
}

interface Harness {
  /** 通过改这个值模拟「开始执行」后的团队状态刷新（覆盖 teamQuery 轮询）。 */
  setRunningSeat: (seatId: string) => void;
  /** team 详情被请求次数（轮询证据）。 */
  teamHits: () => number;
}

async function installMocks(page: Page): Promise<Harness> {
  let runningSeatId = "";
  let hits = 0;

  // 兜底必须先注册（Playwright 后者优先 ⇒ 它最后匹配），只兜住未显式 mock 的接口，
  // 避免 fallback 到真实后端拿 401 → 前端全局登出跳落地页。
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 100 }),
    }),
  );
  // `/workers` 返回**裸数组**（前端 `(data ?? []).map`）：必须注册在兜底之后，
  // 否则被兜底抢先匹配成 {items} 对象 → `.map is not a function` 整页崩。
  await page.route((url) => url.pathname === "/api/v1/workers", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
  await page.route("**/api/v1/events*", (route) => route.abort());

  await page.route((url) => url.pathname === "/api/v1/conversations", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: `group:${TEAM_ID}`,
            type: "group",
            title: "e2e 群聊团队",
            badge: "群",
            channelId: CHANNEL_ID,
            contextTeamId: TEAM_ID,
            memberCount: SEATS.length,
            unreadCount: 0,
            pinned: false,
            processing: false,
            lastMessage: { text: "群聊里只有这条结论", createdAt: iso },
          },
        ],
        total: 1,
      },
    }),
  );
  await page.route((url) => url.pathname === `/api/v1/teams/${TEAM_ID}`, (route) => {
    hits += 1;
    return route.fulfill({ json: teamFixture(runningSeatId) });
  });
  await page.route((url) => url.pathname === `/api/v1/tasks/${TASK_ID}`, (route) =>
    route.fulfill({ json: taskFixture() }),
  );
  await page.route((url) => url.pathname === "/api/v1/tasks", (route) =>
    route.fulfill({
      json: {
        items: [{ id: TASK_ID, title: "e2e 任务", status: "in_progress", createdAt: iso, startedAt: iso, pendingReviewAt: null, completedAt: null }],
        total: 1,
        page: 1,
        pageSize: 100,
      },
    }),
  );
  await page.route((url) => url.pathname === "/api/v1/channels", (route) =>
    route.fulfill({
      json: { items: [{ id: CHANNEL_ID, type: "team_group", teamId: TEAM_ID, taskId: null, agentId: null }], total: 1 },
    }),
  );
  await page.route((url) => url.pathname === `/api/v1/channels/${CHANNEL_ID}/session-history`, (route) =>
    route.fulfill({ json: memberHistoryFixture() }),
  );
  await page.route((url) => url.pathname === `/api/v1/channels/${CHANNEL_ID}/messages`, (route) =>
    route.fulfill({ json: groupMessagesFixture() }),
  );
  await page.route((url) => url.pathname === "/api/v1/members", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );
  await page.route((url) => url.pathname === "/api/v1/agents", (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route("**/api/v1/agent-roles**", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );
  await page.route("**/api/v1/models**", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );
  await page.route("**/api/v1/issues**", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );
  await page.route("**/api/v1/questions**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/v1/triggers**", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );

  return {
    setRunningSeat: (seatId: string) => {
      runningSeatId = seatId;
    },
    teamHits: () => hits,
  };
}

test.describe("群聊成员状态角标 + 成员视角右栏", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  test("1. 执行中成员在切换条与顶部头像组都显示状态角标，且状态随轮询更新", async ({ page }) => {
    const h = await installMocks(page);
    // 初始全员 idle
    h.setRunningSeat("");
    await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("group-member-switcher")).toBeVisible();

    // 初始：无任何状态角标
    await expect(page.locator('[data-testid^="group-member-presence-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="group-header-presence-"]')).toHaveCount(0);

    // 模拟「该成员开始执行」：后续 teamQuery 轮询应拿到 running
    h.setRunningSeat(RUNNING_SEAT);
    const before = h.teamHits();

    // ★ teamQuery 必须轮询（5s）：否则 seat.sessionStatus 冻结，角标永不出现
    await expect
      .poll(() => h.teamHits(), { timeout: 20_000, message: "teamQuery 应轮询刷新席级状态" })
      .toBeGreaterThan(before);

    // 成员切换条：目标 chip 变 running 且渲染出黄点
    const runningChip = page.locator(`[data-testid="group-member-chip"][data-presence="running"]`);
    await expect(runningChip).toHaveCount(1, { timeout: 20_000 });
    await expect(runningChip.locator('[data-testid="group-member-presence-running"]')).toBeVisible();

    // 顶部头像组：执行中成员被排到可见区（只取 5 个，排序必须让 running 优先）
    await expect(page.getByTestId("group-header-presence-running")).toBeVisible({ timeout: 10_000 });
    // 头像 span 只有 title（无可读文本），断言排序把执行中成员置于首位的 title 上
    await expect(
      page.getByTestId("group-header-avatars").locator("span[title]").first(),
    ).toHaveAttribute("title", new RegExp(RUNNING_NAME), { timeout: 10_000 });
  });

  test("2. 点成员 → 右栏显示成员信息（而非团队信息）", async ({ page }) => {
    const h = await installMocks(page);
    h.setRunningSeat(RUNNING_SEAT);
    await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });

    // 选中前：右栏是团队/任务面板
    await expect(page.getByTestId("task-panel")).toBeVisible();

    // 点目标成员 chip
    const chip = page.locator(`[data-testid="group-member-chip"][data-presence="running"]`);
    await expect(chip).toHaveCount(1, { timeout: 20_000 });
    await chip.click();

    // ★ 右栏切换为成员信息面板，团队/任务面板让出
    const panel = page.getByTestId("group-member-context-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("task-panel")).toHaveCount(0);

    // 成员信息：名字 / 状态（与角标同源 running）/ Agent / 席位 ID
    await expect(page.getByTestId("group-member-context-name")).toHaveText(RUNNING_NAME);
    await expect(page.getByTestId("group-member-context-status")).toHaveAttribute("data-presence", "running");
    await expect(page.getByTestId("group-member-context-status")).toContainText("正在执行");
    await expect(page.getByTestId("group-member-context-agent")).toHaveText("项目经理");
    await expect(page.getByTestId("group-member-context-seat")).toHaveText(RUNNING_SEAT);
    // 视角内消息数（该成员会话历史条数）
    await expect(page.getByTestId("group-member-context-count")).toContainText("1 条");
  });

  test("3. 「返回团队」恢复团队面板", async ({ page }) => {
    const h = await installMocks(page);
    h.setRunningSeat(RUNNING_SEAT);
    await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });

    await page.locator(`[data-testid="group-member-chip"][data-presence="running"]`).click();
    await expect(page.getByTestId("group-member-context-panel")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("group-member-context-close").click();
    await expect(page.getByTestId("group-member-context-panel")).toHaveCount(0);
    await expect(page.getByTestId("task-panel")).toBeVisible({ timeout: 15_000 });
    // 回到「全部」视角：群聊消息（而非成员会话历史）
    await expect(page.getByTestId("chat-message-list")).toContainText("群聊里只有这条结论");
  });
});
