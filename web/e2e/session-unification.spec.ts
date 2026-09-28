import { test, expect, type Page, type Locator } from "@playwright/test";
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
    mainAgentMemberId: "tmm_1",
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

const DM1 = "ch_dm_1";
const DM2 = "ch_dm_2";
const DM3 = "ch_dm_3";
const DM_BY_MEMBER: Record<string, string> = { tmm_1: DM1, tmm_2: DM2, tmm_3: DM3 };
const TERMINAL_MSG_ID = "h_term_1";
const TERMINAL_TEXT = "终态正文：不可被旧 delta 覆盖";
const DELTA_MSG_ID = "m_delta_live";
const DELTA_TEXT = "流式增量：空缓存补拉后可见";

function channelMsg(
  id: string,
  channelId: string,
  senderType: string,
  senderId: string,
  senderInstanceId: string | null,
  text: string,
  status = "sent",
) {
  return {
    id,
    channelId,
    senderType,
    senderId,
    senderInstanceId,
    content: { text, parts: [] },
    mentions: [],
    attachmentUrl: null,
    attachmentName: null,
    attachmentType: null,
    status,
    createdAt: iso,
  };
}

/** 私聊历史：40 条足量正文确保列表可滚动（scrollTop 门控断言的前提），并带终态与补拉目标消息。 */
/** 群聊足量历史：Todo14 群 Tab 滚动门控断言的前提（Todo12 的 messagesFixture 保持 3 条不变）。 */
function longGroupMessagesFixture() {
  const base = messagesFixture();
  for (let i = 0; i < 40; i++) {
    base.items.push(
      msg(`g_fill_${i}`, "agent", "a_developer", "ta_1", `群聊历史 ${i}：${"群聊历史正文占位，用于撑高列表。".repeat(6)}`),
    );
  }
  return base;
}

function privateHistoryFixture(channelId: string) {
  const items = [];
  for (let i = 0; i < 40; i++) {
    const isUser = i % 3 === 0;
    items.push(
      channelMsg(
        `h_${channelId}_${i}`,
        channelId,
        isUser ? "user" : "agent",
        isUser ? "u_seed_admin" : "a_developer",
        isUser ? null : "ta_1",
        `历史消息 ${i}：${"私聊历史正文占位，用于撑高列表。".repeat(6)}`,
      ),
    );
  }
  items.push(channelMsg(TERMINAL_MSG_ID, channelId, "agent", "a_developer", "ta_1", TERMINAL_TEXT));
  items.push(channelMsg(DELTA_MSG_ID, channelId, "agent", "a_developer", "ta_1", DELTA_TEXT));
  return { items, nextCursor: null };
}

/** 安装受控 EventSource stub：不发真实 /events 请求，由测试经 __sseEmit 显式投递帧。 */
async function installSseStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const instances: Array<{
      onmessage: ((ev: { data: string }) => void) | null;
      closed: boolean;
    }> = [];
    class StubEventSource {
      url: string;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(url: string | URL) {
        this.url = String(url);
        instances.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    window.EventSource = StubEventSource as unknown as typeof EventSource;
    const scope = window as unknown as { __sseEmit?: (frame: unknown) => void; __sseLive?: () => number };
    scope.__sseEmit = (frame) => {
      const live = instances.filter((i) => !i.closed);
      const target = live[live.length - 1];
      if (!target || !target.onmessage) throw new Error("no live EventSource");
      target.onmessage({ data: JSON.stringify(frame) });
    };
    scope.__sseLive = () => instances.filter((i) => !i.closed).length;
  });
}

/** 同步投递一帧 SSE：use-sse → use-realtime → 页面回调全链路在 evaluate 返回前已完成。 */
async function emitFrame(page: Page, id: number, type: string, payload: unknown): Promise<void> {
  await page.evaluate(
    (frame) => {
      const w = window as unknown as { __sseEmit?: (f: unknown) => void };
      if (!w.__sseEmit) throw new Error("EventSource stub 未安装");
      w.__sseEmit(frame);
    },
    { id, type, payload, timestamp: new Date().toISOString() },
  );
}

function deltaPayload(
  messageId: string,
  channelId: string,
  senderInstanceId: string,
  senderId: string,
  text: string,
) {
  return {
    message: channelMsg(messageId, channelId, "agent", senderId, senderInstanceId, text, "processing"),
    delta: [{ id: "p_delta", type: "text", text }],
  };
}

function newMessagePayload(channelId: string, messageId: string, senderInstanceId: string, senderId: string, text: string) {
  return { message: channelMsg(messageId, channelId, "agent", senderId, senderInstanceId, text, "sent") };
}

interface MockHarness {
  /** 命中自定义分支的请求记录（reset-session 等，Todo12 断言沿用）。 */
  seen: { method: string; path: string }[];
  /** GET /channels/:id/session-history 的请求顺序（值为频道 id，Todo14 补拉计数）。 */
  privateHistory: string[];
  /** session-history 失败后回退的 GET /channels/:id/messages（期望恒 0）。 */
  privateMessagesFallback: string[];
  /** POST /dm-channels 收到的 teamMemberId 顺序。 */
  dmChannels: string[];
  /** 放行被 holdPrivateHistory 挂起的私聊历史响应（幂等）。 */
  releasePrivateHistory: () => void;
}

interface HarnessOptions {
  /** 挂起私聊 session-history 响应直到 releasePrivateHistory()：构造“delta 早于 REST cache”竞态。 */
  holdPrivateHistory?: boolean;
  /**
   * 前 N 次私聊历史（及其 /messages 回退）返回 500：让 REST cache 稳定停在“无数据 + idle”，
   * 这是 React Query 下唯一能观察到“空缓存 delta → 真正发出补拉请求”的状态
   * （fetching 中的 refetch 会被 query-core 内部并入既有 promise，不产生新请求）。
   */
  failPrivateHistoryAttempts?: number;
  /** 群聊历史返回足量条目使列表可滚动（Todo14 群 Tab 滚动门控用，不改 Todo12 的 fixture）。 */
  longGroupHistory?: boolean;
  /** B2（复选框 5）：覆盖群频道 GET /channels/:id/messages 的响应体，构造分组/边界夹具。 */
  groupHistory?: { items: unknown[]; nextCursor?: string | null };
  /** B2（复选框 5）：覆盖私聊 GET /channels/:id/session-history 的响应体（过程 part 分组态）。 */
  privateHistoryOverride?: { items: unknown[]; nextCursor?: string | null };
  /** B5/B9（复选框 7）：覆盖 GET /teams/:id，追加 author 与角色标签同值的成员夹具。 */
  teamOverride?: unknown;
}

async function installHarness(
  page: Page,
  taskSessions: [string | null, string | null, string | null],
  options: HarnessOptions = {},
): Promise<MockHarness> {
  const seen: { method: string; path: string }[] = [];
  const privateHistory: string[] = [];
  const privateMessagesFallback: string[] = [];
  const dmChannels: string[] = [];
  const gate: { release: (() => void) | null } = { release: null };
  const held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const releasePrivateHistory = () => {
    const release = gate.release;
    gate.release = null;
    release?.();
  };
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
    // Todo14：私聊建频道路由拦截（不得落真实后端写入）
    if (method === "POST" && apiPath === "/dm-channels") {
      const body = req.postDataJSON() as { teamMemberId?: string } | null;
      const member = body?.teamMemberId ?? "";
      dmChannels.push(member);
      const dmId = DM_BY_MEMBER[member];
      if (!dmId) return route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: "团队成员不存在" } });
      return route.fulfill({ json: { id: dmId } });
    }
    // Todo14：私聊历史（session-history 主源）
    const historyHit = /^\/channels\/(ch_dm_\d+)\/session-history$/.exec(apiPath);
    if (method === "GET" && historyHit) {
      const hitChannel = historyHit[1];
      const attempt = privateHistory.push(hitChannel);
      if (options.failPrivateHistoryAttempts && attempt <= options.failPrivateHistoryAttempts) {
        return route.fulfill({ status: 500, json: { code: "INTERNAL", message: "session-history 不可用" } });
      }
      if (options.privateHistoryOverride) {
        return route.fulfill({ json: options.privateHistoryOverride });
      }
      if (options.holdPrivateHistory) {
        void held
          .then(async () => {
            try {
              await route.fulfill({ json: privateHistoryFixture(hitChannel) });
            } catch {
              // 请求已被 React Query 取消或页面已关闭：忽略
            }
          })
          .catch(() => undefined);
        return;
      }
      return route.fulfill({ json: privateHistoryFixture(hitChannel) });
    }
    const fallbackHit = /^\/channels\/(ch_dm_\d+)\/messages$/.exec(apiPath);
    if (method === "GET" && fallbackHit) {
      const attempt = privateMessagesFallback.push(apiPath);
      if (options.failPrivateHistoryAttempts && attempt <= options.failPrivateHistoryAttempts) {
        return route.fulfill({ status: 500, json: { code: "INTERNAL", message: "messages 不可用" } });
      }
      return route.fulfill({ json: privateHistoryFixture(fallbackHit[1]) });
    }
    if (method === "GET" && apiPath === `/teams/${TEAM_ID}`) {
      return route.fulfill({ json: options.teamOverride ?? teamFixture() });
    }
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}`) return route.fulfill({ json: taskFixture(taskSessions) });
    if (method === "GET" && apiPath === "/channels") {
      return route.fulfill({ json: { items: [{ id: CHANNEL_ID, type: "team_group", teamId: TEAM_ID, taskId: null, agentId: null }], total: 1 } });
    }
    if (method === "GET" && apiPath === `/channels/${CHANNEL_ID}/messages`) {
      if (options.groupHistory) return route.fulfill({ json: options.groupHistory });
      return route.fulfill({ json: options.longGroupHistory ? longGroupMessagesFixture() : messagesFixture() });
    }
    if (method === "GET" && apiPath === "/agents") return route.fulfill({ json: { items: [], total: 0 } });
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}/artifacts`) {
      return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 10 } });
    }
    if (method === "GET" && apiPath === "/issues") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } });
    if (method === "GET" && apiPath === "/questions") return route.fulfill({ json: [] });
    return route.fallback();
  });
  return { seen, privateHistory, privateMessagesFallback, dmChannels, releasePrivateHistory };
}

/** 为 page 安装全量 mock；taskSessions 控制三实例 sessionStatus；返回请求记录器。 */
async function installMocks(page: Page, taskSessions: [string | null, string | null, string | null]) {
  const harness = await installHarness(page, taskSessions);
  return harness.seen;
}

test.describe("Todo12 团队会话团队化", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

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

test.describe("Todo14 页面 delta 消费 / 滚动门控 / DM 轮询", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  const TASK14_EVIDENCE_DIR = path.join(
    process.cwd(),
    "..",
    ".omo",
    "evidence",
    "chat-ux-hierarchy-and-streaming",
  );

  async function openPrivate1(page: Page, harness: MockHarness) {
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("dm-tab-private-ta_1").click();
    await expect.poll(() => harness.privateHistory.length, { timeout: 10_000 }).toBe(1);
    await expect(harness.dmChannels).toEqual(["tmm_1"]);
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText("历史消息 0").first()).toBeVisible({ timeout: 10_000 });
    return list;
  }

  async function scrollTopOf(list: ReturnType<Page["getByTestId"]>): Promise<number> {
    return list.evaluate((el) => el.scrollTop);
  }

  async function resetScroll(list: ReturnType<Page["getByTestId"]>): Promise<void> {
    // 首屏滚动效果会再补一次 150ms 延迟滚底 (page.tsx bottomTabRef)：单次归零可能被它覆盖，
    // 因此重复“归零→读回”直到 0 真正稳定，避免依赖 sleep。
    let observed = -1;
    for (let attempt = 0; attempt < 20 && observed !== 0; attempt++) {
      await list.evaluate((el) => {
        el.scrollTop = 0;
      });
      observed = await scrollTopOf(list);
    }
    expect(observed).toBe(0);
  }

  test("1. 当前私聊 delta 滚到底，非当前私聊 delta 不滚动但未读收敛", async ({ page }) => {
    await installSseStub(page);
    const harness = await installHarness(page, ["running", "idle", null]);
    const list = await openPrivate1(page, harness);

    const size = await list.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(size.scrollHeight).toBeGreaterThan(size.clientHeight + 200);

    await resetScroll(list);
    await emitFrame(page, 101, "message.part.delta", deltaPayload(DELTA_MSG_ID, DM1, "ta_1", "a_developer", DELTA_TEXT));
    expect(await scrollTopOf(list)).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(TASK14_EVIDENCE_DIR, "task-14-current-delta-scroll.png") });

    await resetScroll(list);
    await emitFrame(
      page,
      102,
      "message.part.delta",
      deltaPayload("m_delta_other", DM2, "ta_2", "a_tester", "另一私聊的流式输出"),
    );
    expect(await scrollTopOf(list)).toBe(0);
    await expect(page.getByTestId("dm-tab-unread-ta_2")).toBeVisible();
    await page.screenshot({ path: path.join(TASK14_EVIDENCE_DIR, "task-14-other-delta-no-scroll.png") });
  });

  test("2. 非当前频道 chat.message.new 不改当前列表滚动", async ({ page }) => {
    await installSseStub(page);
    const harness = await installHarness(page, ["running", "idle", null]);
    const list = await openPrivate1(page, harness);

    await resetScroll(list);
    await emitFrame(
      page,
      201,
      "chat.message.new",
      newMessagePayload(DM2, "m_new_other", "ta_2", "a_tester", "另一私聊的新消息"),
    );
    expect(await scrollTopOf(list)).toBe(0);
    await expect(page.getByTestId("dm-tab-unread-ta_2")).toBeVisible();
  });

  test("3. 空缓存首个 delta 触发恰好一次补拉并渲染消息", async ({ page }) => {
    await installSseStub(page);
    const harness = await installHarness(page, ["running", "idle", null], { failPrivateHistoryAttempts: 2 });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("dm-tab-private-ta_1").click();
    await expect.poll(() => harness.privateHistory.length, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => harness.privateMessagesFallback.length, { timeout: 15_000 }).toBe(2);
    await page.waitForTimeout(500);

    const list = page.getByTestId("chat-message-list");
    expect(await list.getByText(DELTA_TEXT).count()).toBe(0);
    await emitFrame(
      page,
      301,
      "message.part.delta",
      deltaPayload(DELTA_MSG_ID, DM1, "ta_1", "a_developer", DELTA_TEXT),
    );
    await expect.poll(() => harness.privateHistory.length, { timeout: 10_000 }).toBe(3);
    await emitFrame(page, 302, "message.part.delta", deltaPayload("m_delta_dup", DM1, "ta_1", "a_developer", "重复增量"));
    expect(harness.privateHistory.length).toBe(3);

    await expect(list.getByText(DELTA_TEXT).first()).toBeVisible({ timeout: 10_000 });
    expect(harness.privateHistory.length).toBe(3);
    expect(harness.privateMessagesFallback.length).toBe(2);
    await page.screenshot({ path: path.join(TASK14_EVIDENCE_DIR, "task-14-empty-cache-refetch.png") });
  });

  test("3b. 初始历史请求挂起期间的首个 delta 不丢消息", async ({ page }) => {
    await installSseStub(page);
    const harness = await installHarness(page, ["running", "idle", null], { holdPrivateHistory: true });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("dm-tab-private-ta_1").click();
    await expect.poll(() => harness.privateHistory.length, { timeout: 10_000 }).toBe(1);

    await emitFrame(
      page,
      311,
      "message.part.delta",
      deltaPayload(DELTA_MSG_ID, DM1, "ta_1", "a_developer", DELTA_TEXT),
    );
    harness.releasePrivateHistory();
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText(DELTA_TEXT).first()).toBeVisible({ timeout: 10_000 });
    expect(harness.privateMessagesFallback.length).toBe(0);
  });

  test("4. DM 查询 30s 轮询兜底可观测", async ({ page }) => {
    await installSseStub(page);
    const harness = await installHarness(page, ["running", "idle", null]);
    await page.clock.install();
    const list = await openPrivate1(page, harness);
    expect(await scrollTopOf(list)).toBeGreaterThan(0);

    await page.clock.fastForward(31_000);
    await expect.poll(() => harness.privateHistory.length, { timeout: 10_000 }).toBe(2);
    expect(harness.privateHistory.every((channel) => channel === DM1)).toBe(true);
  });

  test("5. 终态消息不被旧 delta 覆盖", async ({ page }) => {
    await installSseStub(page);
    const harness = await installHarness(page, ["running", "idle", null]);
    const list = await openPrivate1(page, harness);

    await emitFrame(
      page,
      501,
      "message.part.delta",
      deltaPayload(TERMINAL_MSG_ID, DM1, "ta_1", "a_developer", "旧 delta：应被终态优先规则丢弃"),
    );
    await expect(list.getByText(TERMINAL_TEXT).first()).toBeVisible();
    await expect(list.getByText("旧 delta：应被终态优先规则丢弃")).toHaveCount(0);
    expect(harness.privateHistory.length).toBe(1);
  });

  test("6. 群聊 Tab：群频道 delta 滚动，私聊频道 delta 不滚动但未读收敛", async ({ page }) => {
    await installSseStub(page);
    const harness = await installHarness(page, ["running", "idle", null], { longGroupHistory: true });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText("开工共识：先出方案再写用例").first()).toBeVisible({ timeout: 10_000 });

    const size = await list.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(size.scrollHeight).toBeGreaterThan(size.clientHeight + 200);

    await resetScroll(list);
    await emitFrame(
      page,
      601,
      "message.part.delta",
      deltaPayload(DELTA_MSG_ID, CHANNEL_ID, "ta_1", "a_developer", "群频道流式增量"),
    );
    expect(await scrollTopOf(list)).toBeGreaterThan(0);

    await resetScroll(list);
    await emitFrame(
      page,
      602,
      "message.part.delta",
      deltaPayload("m_delta_dm1", DM1, "ta_1", "a_developer", "私聊频道流式增量"),
    );
    expect(await scrollTopOf(list)).toBe(0);
    await expect(page.getByTestId("dm-tab-unread-ta_1")).toBeVisible();
    expect(harness.privateHistory.length).toBe(0);
  });
});

test.describe("B2 连续同发送者消息复用身份栏", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  const B2_DIR = path.join(
    process.cwd(),
    "..",
    ".omo",
    "evidence",
    "chat-ux-hierarchy-and-streaming",
  );

  /** 本地日历时间 → ISO：5 分钟边界与跨日都按本地日构造，断言不依赖运行时区换算。 */
  const at = (day: number, h: number, m: number, s = 0, ms = 0) =>
    new Date(2026, 8, day, h, m, s, ms).toISOString();

  interface B2Row {
    id: string;
    senderType: string;
    /** undefined = payload 该字段缺失；null = 字段存在但为 null；"" = 空 senderId */
    senderId?: string | null;
    createdAt?: string;
    text: string;
    /** 期望身份三件套（message-identity / agent-avatar / chat-bubble-author）各几个 */
    identity: number;
  }

  const B2_ROWS: B2Row[] = [
    { id: "b2_01", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 0), text: "分组-01 首条独立", identity: 1 },
    { id: "b2_02", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 1), text: "分组-02 同发送者1分钟", identity: 0 },
    { id: "b2_03", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 4), text: "分组-03 同发送者3分钟", identity: 0 },
    { id: "b2_04", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 9), text: "分组-04 间隔恰好5分钟", identity: 0 },
    { id: "b2_05", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 14, 0, 1), text: "分组-05 间隔5分零1毫秒", identity: 1 },
    { id: "b2_06", senderType: "agent", senderId: "a_tester", createdAt: at(20, 10, 15), text: "分组-06 换发送者", identity: 1 },
    { id: "b2_07", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 16), text: "分组-07 换回原发送者", identity: 1 },
    { id: "b2_08", senderType: "user", senderId: "u_seed_admin", createdAt: at(20, 10, 17), text: "分组-08 用户消息独立", identity: 0 },
    { id: "b2_09", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 18), text: "分组-09 用户之后首条", identity: 1 },
    { id: "b2_10", senderType: "system", senderId: null, createdAt: at(20, 10, 19), text: "分组-10 系统消息独立", identity: 0 },
    { id: "b2_11", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 20), text: "分组-11 系统之后首条", identity: 1 },
    { id: "b2_12", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 21), text: "分组-12 系统之后连续", identity: 0 },
    { id: "b2_13", senderType: "agent", senderId: "", createdAt: at(20, 10, 22), text: "分组-13 空senderId独立", identity: 1 },
    { id: "b2_14", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 23), text: "分组-14 前一条senderId为空", identity: 1 },
    { id: "b2_15", senderType: "agent", createdAt: at(20, 10, 24), text: "分组-15 senderId缺失独立", identity: 1 },
    { id: "b2_16", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 25), text: "分组-16 前一条senderId缺失", identity: 1 },
    { id: "b2_17", senderType: "agent", senderId: "a_developer", text: "分组-17 createdAt缺失独立", identity: 1 },
    { id: "b2_18", senderType: "agent", senderId: "a_developer", createdAt: at(20, 10, 27), text: "分组-18 前一条createdAt缺失", identity: 1 },
    { id: "b2_19", senderType: "agent", senderId: "a_developer", createdAt: at(20, 23, 58), text: "分组-19 同日间隔超5分钟", identity: 1 },
    { id: "b2_20", senderType: "agent", senderId: "a_developer", createdAt: at(21, 0, 1), text: "分组-20 跨日仅3分钟", identity: 1 },
    { id: "b2_21", senderType: "agent", senderId: "a_developer", createdAt: at(21, 0, 2), text: "分组-21 跨日后首条", identity: 0 },
  ];

  function b2Item(row: B2Row) {
    const item: Record<string, unknown> = {
      id: row.id,
      channelId: CHANNEL_ID,
      senderType: row.senderType,
      content: { text: row.text, parts: [] },
      mentions: [],
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      status: "sent",
    };
    if (row.senderId !== undefined) item.senderId = row.senderId;
    if (row.createdAt !== undefined) item.createdAt = row.createdAt;
    return item;
  }

  function messageNodes(page: Page) {
    return page.locator('xpath=//*[@data-testid="chat-message-list"]/*');
  }

  /** user/system 行的节点本身就是 chat-bubble 根，后代查询取不到自身 → 先看自身属性。 */
  async function bubbleCount(node: Locator): Promise<number> {
    if ((await node.getAttribute("data-testid")) === "chat-bubble") return 1;
    return node.getByTestId("chat-bubble").count();
  }

  /**
   * B3（复选框 6）在跨天处插入 `chat-date-separator`，它同样是列表的直接子元素。
   * 本夹具唯一一次跨天发生在第 20 条（b2_19 同日 23:58 → b2_20 次日 00:01），
   * 故列表直接子元素 = 1 头部 + 21 消息 + 1 分隔 = 23。
   * 分隔下标显式写死（不调用生产 helper 反推），B2 既有断言强度不降级，只补分隔位偏移。
   */
  const B2_SEPARATOR_BEFORE_ROW = [19];

  /** 第 row 条消息（0-based）在列表中的直接子元素下标：头部占 0，再加它之前的分隔条数。 */
  function b2NodeIndex(row: number): number {
    return 1 + row + B2_SEPARATOR_BEFORE_ROW.filter((before) => before <= row).length;
  }

  async function assertGroupMatrix(page: Page): Promise<void> {
    const nodes = messageNodes(page);
    expect(await nodes.count()).toBe(1 + B2_ROWS.length + B2_SEPARATOR_BEFORE_ROW.length);
    const separators = page.getByTestId("chat-date-separator");
    expect(await separators.count()).toBe(B2_SEPARATOR_BEFORE_ROW.length);
    await expect(separators.first()).toHaveAttribute("data-date-key", "2026-09-21");
    expect(await separators.first().evaluate((el) => el.nextElementSibling?.textContent ?? ""))
      .toContain("分组-20 跨日仅3分钟");
    for (let i = 0; i < B2_ROWS.length; i++) {
      const row = B2_ROWS[i];
      const node = nodes.nth(b2NodeIndex(i));
      await expect(node, `第 ${i + 1} 条 ${row.id} 顺序与正文`).toContainText(row.text);
      expect(await bubbleCount(node), `${row.id} chat-bubble`).toBe(1);
      await expect(node.getByTestId("message-identity"), `${row.id} message-identity`).toHaveCount(row.identity);
      await expect(node.getByTestId("agent-avatar"), `${row.id} agent-avatar`).toHaveCount(row.identity);
      await expect(node.getByTestId("chat-bubble-author"), `${row.id} chat-bubble-author`).toHaveCount(row.identity);
    }
  }

  test("1. 分组矩阵：同发送者连续复用身份，边界/跨日/空 senderId/缺 createdAt 全部独立", async ({ page }) => {
    await installHarness(page, ["idle", "idle", "idle"], {
      groupHistory: { items: B2_ROWS.map(b2Item), nextCursor: null },
    });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("dm-tabs")).toBeVisible();
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText("分组-01 首条独立").first()).toBeVisible({ timeout: 10_000 });
    await expect(list.getByText("分组-21 跨日后首条").first()).toBeVisible({ timeout: 10_000 });
    await assertGroupMatrix(page);

    const nodes = messageNodes(page);
    await expect(nodes.nth(1 + 1).getByTestId("message-identity")).toHaveCount(0);
    let scrollTop = -1;
    for (let attempt = 0; attempt < 20 && scrollTop !== 0; attempt++) {
      await list.evaluate((el) => { el.scrollTop = 0; });
      scrollTop = await list.evaluate((el) => el.scrollTop);
    }
    expect(scrollTop).toBe(0);
    await page.screenshot({ path: path.join(B2_DIR, "task-5-grouping.png") });
    console.log(`[B2] 截图时刻列表 scrollTop=${scrollTop}`);
  });

  test("2. user/system 相邻消息独立气泡，且不吞掉相邻 agent 身份", async ({ page }) => {
    await installHarness(page, ["idle", "idle", "idle"], {
      groupHistory: { items: B2_ROWS.map(b2Item), nextCursor: null },
    });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText("分组-08 用户消息独立").first()).toBeVisible({ timeout: 10_000 });
    const nodes = messageNodes(page);

    const user = nodes.nth(1 + 7);
    await expect(user).toHaveAttribute("data-testid", "chat-bubble");
    await expect(user).toHaveAttribute("data-type", "user");
    await expect(user.getByTestId("message-identity")).toHaveCount(0);

    const system = nodes.nth(1 + 9);
    await expect(system).toHaveAttribute("data-testid", "chat-bubble");
    await expect(system).toHaveAttribute("data-type", "system");
    await expect(system.getByTestId("message-identity")).toHaveCount(0);

    await expect(nodes.nth(1 + 8).getByTestId("message-identity")).toHaveCount(1);
    await expect(nodes.nth(1 + 10).getByTestId("message-identity")).toHaveCount(1);
    await expect(nodes.nth(1 + 11).getByTestId("message-identity")).toHaveCount(0);
  });

  test("3. 分组态仍渲染正文与过程 testid（reasoning + tool + text 私聊）", async ({ page }) => {
    const processItem = (id: string, text: string, createdAt: string) => ({
      id,
      channelId: DM1,
      senderType: "agent",
      senderId: "a_developer",
      senderInstanceId: "ta_1",
      content: {
        text,
        parts: [
          { type: "reasoning", state: "done", text: `${id} 的思考过程` },
          { type: "tool", tool: "vteam_task_context", state: { status: "success", input: "in", output: "out" } },
          { type: "text", text },
        ],
      },
      mentions: [],
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      status: "sent",
      createdAt,
    });

    const harness = await installHarness(page, ["idle", "idle", "idle"], {
      privateHistoryOverride: {
        items: [
          processItem("p2_1", "过程分组-01 独立身份", at(20, 10, 30)),
          processItem("p2_2", "过程分组-02 分组复用身份", at(20, 10, 31)),
        ],
        nextCursor: null,
      },
    });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("dm-tab-private-ta_1").click();
    await expect.poll(() => harness.privateHistory.length, { timeout: 10_000 }).toBe(1);
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText("过程分组-02 分组复用身份").first()).toBeVisible({ timeout: 10_000 });

    const nodes = messageNodes(page);
    expect(await nodes.count()).toBe(3);

    const first = nodes.nth(1);
    await expect(first.getByTestId("message-identity")).toHaveCount(1);
    await expect(first.getByTestId("agent-avatar")).toHaveCount(1);
    await expect(first.getByTestId("msg-thinking")).toHaveCount(1);
    await expect(first.getByTestId("msg-tool")).toHaveCount(1);
    await expect(first.getByTestId("chat-bubble")).toHaveCount(1);

    const second = nodes.nth(2);
    await expect(second.getByTestId("message-identity")).toHaveCount(0);
    await expect(second.getByTestId("agent-avatar")).toHaveCount(0);
    await expect(second.getByTestId("chat-bubble-author")).toHaveCount(0);
    await expect(second.getByTestId("msg-thinking")).toHaveCount(1);
    await expect(second.getByTestId("msg-tool")).toHaveCount(1);
    await expect(second.getByTestId("chat-bubble")).toHaveCount(1);
    await expect(second.getByTestId("msg-streaming")).toHaveCount(0);
    await expect(second).toContainText("过程分组-02 分组复用身份");
    await page.screenshot({ path: path.join(B2_DIR, "task-5-grouping-parts.png") });
  });
});

test.describe("B3 跨天日期分隔与 B4 system 行降噪", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  const B3_DIR = path.join(
    process.cwd(),
    "..",
    ".omo",
    "evidence",
    "chat-ux-hierarchy-and-streaming",
  );

  /** 本地日历时间 → ISO：分隔断言按本地日构造，不依赖运行时区换算（与 B2 同口径）。 */
  const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m).toISOString();

  interface B3Row {
    id: string;
    senderType: string;
    senderId?: string | null;
    /** undefined = payload 缺该字段；空串与非法串原样下发（验证不崩、不产生假分隔） */
    createdAt?: string;
    text: string;
  }

  function b3Item(row: B3Row) {
    const item: Record<string, unknown> = {
      id: row.id,
      channelId: CHANNEL_ID,
      senderType: row.senderType,
      content: { text: row.text, parts: [] },
      mentions: [],
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      status: "sent",
    };
    if (row.senderId !== undefined) item.senderId = row.senderId;
    if (row.createdAt !== undefined) item.createdAt = row.createdAt;
    return item;
  }

  const agentRow = (id: string, createdAt: string | undefined, text: string): B3Row => ({
    id,
    senderType: "agent",
    senderId: "a_developer",
    createdAt,
    text,
  });

  function messageNodes(page: Page) {
    return page.locator('xpath=//*[@data-testid="chat-message-list"]/*');
  }

  async function openGroupList(page: Page, rows: B3Row[]) {
    await installHarness(page, ["idle", "idle", "idle"], {
      groupHistory: { items: rows.map(b3Item), nextCursor: null },
    });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText(rows[rows.length - 1].text).first()).toBeVisible({ timeout: 10_000 });
    return list;
  }

  /** 列表直接子元素逐条 `testid=首屏可见文本`：断言插入位置与消息顺序共用这一份清单。 */
  async function childOutline(page: Page): Promise<string[]> {
    const nodes = messageNodes(page);
    const count = await nodes.count();
    const outline: string[] = [];
    for (let i = 0; i < count; i++) {
      const node = nodes.nth(i);
      const testid = (await node.getAttribute("data-testid")) ?? "(no-testid)";
      const text = (await node.innerText()).replace(/\s+/g, " ");
      outline.push(`${testid}=${text}`);
    }
    return outline;
  }

  function positionsOf(outline: string[], texts: string[]): number[] {
    return texts.map((text) => {
      const idx = outline.findIndex((line) => line.includes(text));
      if (idx < 0) throw new Error(`列表中找不到消息文本: ${text}`);
      return idx;
    });
  }

  function rgbOf(css: string): [number, number, number] {
    const match = /rgba?\(([^)]+)\)/.exec(css);
    if (!match) throw new Error(`无法解析颜色: ${css}`);
    const parts = match[1].split(",").map((v) => Number.parseFloat(v.trim()));
    return [parts[0], parts[1], parts[2]];
  }

  function relativeLuminance([r, g, b]: [number, number, number]): number {
    const chan = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  }

  function contrastRatio(fgCss: string, bgCss: string): number {
    const fg = relativeLuminance(rgbOf(fgCss));
    const bg = relativeLuminance(rgbOf(bgCss));
    const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
    return (hi + 0.05) / (lo + 0.05);
  }

  test("1. 单日列表零分隔，消息顺序与子元素数不变", async ({ page }) => {
    const rows = [
      agentRow("b3a", at(20, 10, 0), "单日-01 首条"),
      agentRow("b3b", at(20, 10, 1), "单日-02 次条"),
      agentRow("b3c", at(20, 21, 0), "单日-03 末条"),
    ];
    await openGroupList(page, rows);
    await expect(page.getByTestId("chat-date-separator")).toHaveCount(0);

    const nodes = messageNodes(page);
    expect(await nodes.count()).toBe(1 + rows.length);

    const outline = await childOutline(page);
    expect(outline[0]).toContain("团队会话 · 历史跨任务可见");
    const positions = positionsOf(outline, rows.map((r) => r.text));
    expect(positions).toEqual([1, 2, 3]);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  test("2. 跨天列表恰好一条 chat-date-separator 落在交界处", async ({ page }) => {
    const rows = [
      agentRow("b3d1", at(20, 10, 0), "跨天-01 当日10:00"),
      agentRow("b3d2", at(20, 23, 58), "跨天-02 当日23:58"),
      agentRow("b3d3", at(21, 0, 1), "跨天-03 次日00:01"),
      agentRow("b3d4", at(21, 0, 2), "跨天-04 次日00:02"),
    ];
    await openGroupList(page, rows);

    await expect(page.getByTestId("chat-date-separator")).toHaveCount(1);
    const nodes = messageNodes(page);
    expect(await nodes.count()).toBe(1 + rows.length + 1);

    const outline = await childOutline(page);
    expect(outline[3].startsWith("chat-date-separator=")).toBe(true);
    expect(outline[3]).toContain("2026/09/21");
    await expect(nodes.nth(3)).toHaveAttribute("data-date-key", "2026-09-21");
    expect(outline[2]).toContain("跨天-02 当日23:58");
    expect(outline[4]).toContain("跨天-03 次日00:01");

    const positions = positionsOf(outline, rows.map((r) => r.text));
    expect(positions).toEqual([1, 2, 4, 5]);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
    await page.screenshot({ path: path.join(B3_DIR, "task-6-cross-day.png") });
  });

  test("3. 多次跨天逐次插入分隔，消息顺序仍与夹具一致", async ({ page }) => {
    const rows = [
      agentRow("b3e1", at(20, 10, 0), "多跨天-01 9月20日"),
      agentRow("b3e2", at(21, 9, 0), "多跨天-02 9月21日"),
      agentRow("b3e3", at(22, 9, 0), "多跨天-03 9月22日"),
      agentRow("b3e4", at(22, 10, 0), "多跨天-04 同日次条"),
      agentRow("b3e5", at(23, 9, 0), "多跨天-05 9月23日"),
    ];
    await openGroupList(page, rows);

    const separators = page.getByTestId("chat-date-separator");
    await expect(separators).toHaveCount(3);
    const nodes = messageNodes(page);
    expect(await nodes.count()).toBe(1 + rows.length + 3);

    const outline = await childOutline(page);
    expect(outline[2].startsWith("chat-date-separator=")).toBe(true);
    expect(outline[2]).toContain("2026/09/21");
    expect(outline[4].startsWith("chat-date-separator=")).toBe(true);
    expect(outline[4]).toContain("2026/09/22");
    expect(outline[7].startsWith("chat-date-separator=")).toBe(true);
    expect(outline[7]).toContain("2026/09/23");

    const positions = positionsOf(outline, rows.map((r) => r.text));
    expect(positions).toEqual([1, 3, 5, 6, 8]);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
    expect(outline.filter((line) => line.startsWith("chat-date-separator="))).toHaveLength(3);
  });

  test("4. 缺失/非法 createdAt 不崩溃、不产生假分隔，跨天仍只一条", async ({ page }) => {
    const rows: B3Row[] = [
      { id: "b3f1", senderType: "agent", senderId: "a_developer", text: "缺时间-01 createdAt缺失" },
      { id: "b3f2", senderType: "agent", senderId: "a_developer", createdAt: "not-a-date", text: "缺时间-02 非法串" },
      { id: "b3f3", senderType: "agent", senderId: "a_developer", createdAt: "", text: "缺时间-03 空串" },
      agentRow("b3f4", at(20, 23, 0), "缺时间-04 当日23:00"),
      agentRow("b3f5", at(21, 0, 30), "缺时间-05 次日00:30"),
    ];
    await openGroupList(page, rows);

    await expect(page.getByTestId("chat-date-separator")).toHaveCount(1);
    const nodes = messageNodes(page);
    expect(await nodes.count()).toBe(1 + rows.length + 1);

    const outline = await childOutline(page);
    const positions = positionsOf(outline, rows.map((r) => r.text));
    expect(positions).toEqual([1, 2, 3, 4, 6]);
    // 分隔只能落在可解析的跨天交界（第 4 条之后），缺时间的前三条之间不得出现分隔
    expect(outline[5].startsWith("chat-date-separator=")).toBe(true);
    await expect(nodes.nth(5)).toHaveAttribute("data-date-key", "2026-09-21");
    expect(outline.filter((line) => line.startsWith("chat-date-separator="))).toHaveLength(1);
  });

  test("5. 首条缺 createdAt 不在列表顶部插分隔，跨缺失行仍分隔", async ({ page }) => {
    const rows: B3Row[] = [
      { id: "b3g1", senderType: "agent", senderId: "a_developer", text: "跨缺失-01 首条缺时间" },
      agentRow("b3g2", at(20, 23, 30), "跨缺失-02 当日23:30"),
      agentRow("b3g3", at(21, 0, 30), "跨缺失-03 次日00:30"),
    ];
    await openGroupList(page, rows);

    await expect(page.getByTestId("chat-date-separator")).toHaveCount(1);
    const nodes = messageNodes(page);
    expect(await nodes.count()).toBe(1 + rows.length + 1);

    const outline = await childOutline(page);
    expect(outline[1]).toContain("跨缺失-01 首条缺时间");
    expect(outline[3].startsWith("chat-date-separator=")).toBe(true);
    await expect(nodes.nth(3)).toHaveAttribute("data-date-key", "2026-09-21");
    const positions = positionsOf(outline, rows.map((r) => r.text));
    expect(positions).toEqual([1, 2, 4]);
  });

  test("6. system 行独立低对比居中容器，与 14px 正文非颜色区隔", async ({ page }) => {
    const rows: B3Row[] = [
      agentRow("b3h1", at(20, 10, 0), "正文对照-agent 首条"),
      { id: "b3h2", senderType: "system", senderId: null, createdAt: at(20, 10, 1), text: "system 行：成员已加入频道" },
      { id: "b3h3", senderType: "user", senderId: "u_seed_admin", createdAt: at(20, 10, 2), text: "正文对照-user 次条" },
      agentRow("b3h4", at(20, 10, 3), "尾条 agent 消息"),
    ];
    await openGroupList(page, rows);
    await expect(page.getByTestId("chat-date-separator")).toHaveCount(0);

    const systemRoot = page.locator('[data-testid="chat-bubble"][data-type="system"]');
    await expect(systemRoot).toHaveCount(1);
    await expect(systemRoot).toBeVisible();
    await expect(systemRoot).toContainText("system 行：成员已加入频道");
    await expect(systemRoot.getByTestId("message-identity")).toHaveCount(0);
    await expect(systemRoot.getByTestId("chat-bubble-toggle")).toHaveCount(0);
    await expect(systemRoot.getByTestId("chat-bubble-content")).toHaveCount(0);

    const systemInner = systemRoot.locator("> div");
    const sys = await systemInner.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        fontSize: cs.fontSize,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        borderStyle: cs.borderStyle,
        textAlign: cs.textAlign,
        paddingTop: cs.paddingTop,
        paddingLeft: cs.paddingLeft,
        borderRadius: cs.borderRadius,
      };
    });
    const sysRoot = await systemRoot.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { justifyContent: cs.justifyContent, marginTop: cs.marginTop, marginLeft: cs.marginLeft };
    });

    const body = await page.getByTestId("chat-bubble-content").first().evaluate((el) => {
      const cs = getComputedStyle(el);
      const host = el.parentElement;
      const hostCs = host ? getComputedStyle(host) : null;
      return {
        fontSize: cs.fontSize,
        color: cs.color,
        backgroundColor: hostCs ? hostCs.backgroundColor : "",
        borderStyle: hostCs ? hostCs.borderStyle : "",
        paddingTop: hostCs ? hostCs.paddingTop : "",
        paddingLeft: hostCs ? hostCs.paddingLeft : "",
      };
    });
    const userRoot = await page
      .locator('[data-testid="chat-bubble"][data-type="user"]')
      .evaluate((el) => {
        const cs = getComputedStyle(el);
        return { justifyContent: cs.justifyContent, marginTop: cs.marginTop };
      });

    console.log("[B4] system:", JSON.stringify(sys), JSON.stringify(sysRoot));
    console.log("[B4] body:", JSON.stringify(body), JSON.stringify(userRoot));

    expect(sys.fontSize).toBe("11px");
    expect(body.fontSize).toBe("14px");
    expect(sys.fontSize).not.toBe(body.fontSize);
    expect(sys.textAlign).toBe("center");
    expect(sysRoot.justifyContent).toBe("center");
    expect(sys.borderStyle).toBe("dashed");
    expect(body.borderStyle).toBe("solid");
    expect(sys.paddingTop).toBe("4px");
    expect(body.paddingTop).toBe("12px");
    expect(sys.paddingLeft).toBe("12px");
    expect(body.paddingLeft).toBe("16px");
    expect(sysRoot.marginTop).toBe("4px");
    expect(sysRoot.marginLeft).toBe("8px");
    expect(userRoot.marginTop).toBe("0px");

    const systemContrast = contrastRatio(sys.color, sys.backgroundColor);
    const bodyContrast = contrastRatio(body.color, body.backgroundColor);
    console.log("[B4] contrast system=%s body=%s", systemContrast.toFixed(2), bodyContrast.toFixed(2));
    expect(systemContrast).toBeLessThan(bodyContrast);
    expect(systemContrast).toBeGreaterThanOrEqual(3);
    expect(bodyContrast).toBeGreaterThan(7);

    await page.screenshot({ path: path.join(B3_DIR, "task-6-system-body.png") });
  });
});

test.describe("B5 author 与角色并列，B9 禁止裸 id 兜底", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  const B5_DIR = path.join(
    process.cwd(),
    "..",
    ".omo",
    "evidence",
    "chat-ux-hierarchy-and-streaming",
  );

  const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m).toISOString();

  /** 计划 Acceptance 指定的裸 id 扫描口径，作用于可见 DOM 文本（innerText，不含 testid 属性）。 */
  const RAW_ID_SCAN = /a_[0-9a-z]+|tmm_[0-9a-z]+|ta_[0-9a-z]+/;

  interface B5Row {
    id: string;
    senderType: string;
    senderId?: string | null;
    senderInstanceId?: string | null;
    text: string;
    mentions?: unknown[];
    /** 期望身份三件套（message-identity / agent-avatar / chat-bubble-author）各几个 */
    identity: number;
  }

  const B5_ROWS: B5Row[] = [
    { id: "b5_1", senderType: "agent", senderId: "a_developer", senderInstanceId: "ta_1", text: "身份-01 已解析 author 并列角色", identity: 1 },
    { id: "b5_2", senderType: "agent", senderId: "tmm_5", senderInstanceId: null, text: "身份-02 author 与角色同值去重", identity: 1 },
    { id: "b5_3", senderType: "agent", senderId: "a_plan", senderInstanceId: "ta_99", text: "身份-03 未映射 agent 只显示角色", identity: 1 },
    { id: "b5_4", senderType: "agent", senderId: "tmm_404", senderInstanceId: null, text: "身份-04 未映射成员只显示角色", identity: 1 },
    { id: "b5_5", senderType: "external", senderId: "a_ghost_ext", senderInstanceId: null, text: "身份-05 外部渠道保留徽标", identity: 1 },
    { id: "b5_6", senderType: "user", senderId: "u_seed_admin", senderInstanceId: null, text: "身份-06 用户消息不受影响", identity: 0 },
    { id: "b5_7", senderType: "system", senderId: null, senderInstanceId: null, text: "身份-07 系统消息不受影响", identity: 0 },
    { id: "b5_8", senderType: "agent", senderId: "a_developer", senderInstanceId: "ta_1", text: "身份-08 提及徽标保留", mentions: [{ type: "all" }], identity: 1 },
    { id: "b5_9", senderType: "agent", senderId: "a_tester", senderInstanceId: "ta_2", text: "身份-09 分组首条保留身份", identity: 1 },
    { id: "b5_10", senderType: "agent", senderId: "a_tester", senderInstanceId: "ta_2", text: "身份-10 分组次条省略身份", identity: 0 },
  ];

  function b5Item(row: B5Row, index: number): Record<string, unknown> {
    return {
      id: row.id,
      channelId: CHANNEL_ID,
      senderType: row.senderType,
      senderId: row.senderId,
      senderInstanceId: row.senderInstanceId,
      content: { text: row.text, parts: [] },
      mentions: row.mentions ?? [],
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      status: "sent",
      createdAt: at(20, 10, index),
    };
  }

  /** 追加一名 alias 恰好等于角色标签的成员：构造 author === roleLabel 的去重夹具。 */
  function b5TeamOverride() {
    const team = teamFixture();
    team.members.push({
      id: "tmm_5",
      teamId: TEAM_ID,
      agentId: "a_dup_role",
      alias: "计划员",
      seq: 1,
      workDir: "/tmp/b5",
      agent: { id: "a_dup_role", name: "计划员", role: "plan" },
    });
    return team;
  }

  async function openB5List(page: Page): Promise<Locator> {
    await installHarness(page, ["idle", "idle", "idle"], {
      groupHistory: { items: B5_ROWS.map(b5Item), nextCursor: null },
      teamOverride: b5TeamOverride(),
    });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText("身份-01 已解析 author 并列角色").first()).toBeVisible({ timeout: 10_000 });
    await expect(list.getByText("身份-10 分组次条省略身份").first()).toBeVisible({ timeout: 10_000 });
    const nodes = page.locator('xpath=//*[@data-testid="chat-message-list"]/*');
    expect(await nodes.count()).toBe(1 + B5_ROWS.length);
    return list;
  }

  /** 第 index 条消息（0-based）的列表直接子元素：头部占 0，无跨天分隔。 */
  function b5Row(page: Page, index: number): Locator {
    return page.locator('xpath=//*[@data-testid="chat-message-list"]/*').nth(1 + index);
  }

  async function assertIdentityCount(row: Locator, id: string, expected: number): Promise<void> {
    await expect(row.getByTestId("message-identity"), `${id} message-identity`).toHaveCount(expected);
    await expect(row.getByTestId("agent-avatar"), `${id} agent-avatar`).toHaveCount(expected);
    await expect(row.getByTestId("chat-bubble-author"), `${id} chat-bubble-author`).toHaveCount(expected);
  }

  test("1. 已解析 author 与角色标签并列展示，二者同值时只出现一次", async ({ page }) => {
    await openB5List(page);

    const distinct = b5Row(page, 0);
    await assertIdentityCount(distinct, "b5_1", 1);
    const distinctAuthor = distinct.getByTestId("chat-bubble-author");
    await expect(distinctAuthor).toContainText("Dev-1");
    await expect(distinctAuthor).toContainText("开发者");
    await expect(distinct.getByTestId("message-identity-role")).toHaveCount(1);
    await expect(distinct.getByTestId("message-identity-role")).toContainText("开发者");
    await expect(distinct.getByTestId("chat-bubble-time")).toBeVisible();

    const dedupe = b5Row(page, 1);
    await assertIdentityCount(dedupe, "b5_2", 1);
    const dedupeAuthor = dedupe.getByTestId("chat-bubble-author");
    await expect(dedupeAuthor).toHaveText("计划员");
    await expect(dedupe.getByTestId("message-identity-role")).toHaveCount(0);
    const dedupeText = (await dedupeAuthor.innerText()).replace(/\s+/g, " ");
    expect(dedupeText.split("计划员").length - 1, "同值身份只出现一次").toBe(1);

    const tester = b5Row(page, 8);
    await assertIdentityCount(tester, "b5_9", 1);
    await expect(tester.getByTestId("chat-bubble-author")).toContainText("Test-1");
    await expect(tester.getByTestId("message-identity-role")).toContainText("测试");

    await page.screenshot({ path: path.join(B5_DIR, "task-7-author-role.png") });
  });

  test("2. 未映射 sender 只显示角色标签，可见 DOM 不含裸 a_/tmm_/ta_ id", async ({ page }) => {
    await openB5List(page);

    const unmappedAgent = b5Row(page, 2);
    await assertIdentityCount(unmappedAgent, "b5_3", 1);
    const agentAuthor = unmappedAgent.getByTestId("chat-bubble-author");
    await expect(agentAuthor).toHaveText("计划员");
    await expect(unmappedAgent.getByTestId("message-identity-role")).toHaveCount(0);
    expect(await unmappedAgent.innerText()).not.toMatch(RAW_ID_SCAN);

    const unmappedMember = b5Row(page, 3);
    await assertIdentityCount(unmappedMember, "b5_4", 1);
    const memberAuthor = unmappedMember.getByTestId("chat-bubble-author");
    await expect(memberAuthor).toHaveText("开发者");
    await expect(unmappedMember.getByTestId("message-identity-role")).toHaveCount(0);
    expect(await unmappedMember.innerText()).not.toMatch(RAW_ID_SCAN);

    const external = b5Row(page, 4);
    await expect(external.getByTestId("chat-bubble-author").locator(":scope > span").first()).toHaveText("开发者");
    await expect(external.getByTestId("chat-bubble-author")).not.toContainText("a_ghost_ext");
    expect(await external.innerText()).not.toMatch(RAW_ID_SCAN);

    const visible = await page.evaluate(() => document.body.innerText);
    expect(visible, "全页可见文本不得出现裸 sender/成员/实例 id").not.toMatch(RAW_ID_SCAN);
    expect(
      B5_ROWS.filter((r) => typeof r.senderId === "string" && RAW_ID_SCAN.test(r.senderId)).length,
      "夹具确实包含未映射裸 id 发送者",
    ).toBeGreaterThanOrEqual(3);
  });

  test("3. external 渠道徽标与 @你 提及徽标在身份改造后仍可见", async ({ page }) => {
    await openB5List(page);

    const external = b5Row(page, 4);
    await expect(external).toHaveAttribute("data-testid", "chat-bubble");
    await expect(external).toHaveAttribute("data-type", "agent");
    const externalBadge = external.getByTestId("external-channel-badge");
    await expect(externalBadge).toHaveCount(1);
    await expect(externalBadge).toBeVisible();
    await expect(externalBadge).toHaveText("外部渠道");
    await expect(external.getByTestId("chat-bubble-author").locator(":scope > span").first()).toHaveText("开发者");
    expect(await external.innerText()).not.toMatch(RAW_ID_SCAN);

    const mention = b5Row(page, 7);
    await assertIdentityCount(mention, "b5_8", 1);
    const mentionBadge = mention.getByTestId("mention-me-badge");
    await expect(mentionBadge).toHaveCount(1);
    await expect(mentionBadge).toBeVisible();
    await expect(mentionBadge).toContainText("@你");
    await expect(mention.getByTestId("chat-bubble-author")).toContainText("Dev-1");
    await expect(mention.getByTestId("message-identity-role")).toContainText("开发者");
  });

  test("4. user/system 独立气泡与 B2 分组省略身份行为不受影响", async ({ page }) => {
    await openB5List(page);

    const user = b5Row(page, 5);
    await expect(user).toHaveAttribute("data-testid", "chat-bubble");
    await expect(user).toHaveAttribute("data-type", "user");
    await assertIdentityCount(user, "b5_6", 0);
    await expect(user).toContainText("身份-06 用户消息不受影响");

    const system = b5Row(page, 6);
    await expect(system).toHaveAttribute("data-testid", "chat-bubble");
    await expect(system).toHaveAttribute("data-type", "system");
    await assertIdentityCount(system, "b5_7", 0);
    await expect(system).toContainText("身份-07 系统消息不受影响");

    const groupedFirst = b5Row(page, 8);
    await assertIdentityCount(groupedFirst, "b5_9", 1);
    await expect(groupedFirst.getByTestId("chat-bubble-author")).toContainText("Test-1");

    const groupedSecond = b5Row(page, 9);
    await assertIdentityCount(groupedSecond, "b5_10", 0);
    await expect(groupedSecond).toContainText("身份-10 分组次条省略身份");
    await expect(groupedSecond.getByTestId("chat-bubble-content")).toHaveCount(1);
  });
});

test.describe("B12 session-status 容器与 system 消息时间", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  const B12_DIR = path.join(
    process.cwd(),
    "..",
    ".omo",
    "evidence",
    "chat-ux-hierarchy-and-streaming",
  );

  /** 本地日历时间 → ISO：system 时间文本按本地时构造，断言不依赖运行时区换算（与 B2/B3 同口径）。 */
  const at = (day: number, h: number, m: number) => new Date(2026, 8, day, h, m).toISOString();

  /** at(20, 10, 5) 经页面 formatTime(HH:MM) 的期望输出。 */
  const B12_SYSTEM_TIME = "10:05";

  interface B12Row {
    id: string;
    senderType: string;
    senderId?: string | null;
    senderInstanceId?: string | null;
    createdAt: string;
    text: string;
  }

  /** 群频道夹具：agent 正文 + system（带 createdAt → 页面把它作为 time 传给 ChatBubble）+ user 正文。 */
  const B12_ROWS: B12Row[] = [
    { id: "b12_a", senderType: "agent", senderId: "a_developer", senderInstanceId: "ta_1", createdAt: at(20, 10, 0), text: "B12 正文-agent 首条" },
    { id: "b12_s", senderType: "system", senderId: null, senderInstanceId: null, createdAt: at(20, 10, 5), text: "B12 system 行：成员已加入频道" },
    { id: "b12_u", senderType: "user", senderId: "u_seed_admin", senderInstanceId: null, createdAt: at(20, 10, 6), text: "B12 正文-user 次条" },
  ];

  function b12Item(row: B12Row): Record<string, unknown> {
    return {
      id: row.id,
      channelId: CHANNEL_ID,
      senderType: row.senderType,
      senderId: row.senderId ?? null,
      senderInstanceId: row.senderInstanceId ?? null,
      content: { text: row.text, parts: [] },
      mentions: [],
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      status: "sent",
      createdAt: row.createdAt,
    };
  }

  async function openB12List(page: Page, taskSessions: [string | null, string | null, string | null]): Promise<Locator> {
    await installHarness(page, taskSessions, {
      groupHistory: { items: B12_ROWS.map(b12Item), nextCursor: null },
    });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const list = page.getByTestId("chat-message-list");
    await expect(list.getByText(B12_ROWS[0].text).first()).toBeVisible({ timeout: 10_000 });
    await expect(list.getByText(B12_ROWS[1].text).first()).toBeVisible({ timeout: 10_000 });
    return list;
  }

  /** 容器规格（与 LoadingIndicator 容器逐项对齐的计算样式）。 */
  async function containerSignature(locator: Locator): Promise<Record<string, string>> {
    return locator.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        display: cs.display,
        alignItems: cs.alignItems,
        gap: cs.gap,
        color: cs.color,
        fontSize: cs.fontSize,
        padding: cs.padding,
        fontFamily: cs.fontFamily,
      };
    });
  }

  test("1. transient session-status 是与 LoadingIndicator 一致的可识别容器，且不混入消息数组", async ({ page }) => {
    await installSseStub(page);
    await openB12List(page, ["running", "running", "idle"]);

    const status = page.locator('div[data-testid="session-status"]');
    await expect(status).toHaveCount(1);
    await expect(status).toContainText("会话运行中");
    // 实现前的原样 DOM 落进运行日志：红跑据此记录「裸文本/无指示元素」事实
    console.log("[B12] session-status outerHTML =", await status.evaluate((el) => el.outerHTML));

    // (a) 真实容器，而非裸文本：div 根 + 元素子节点（LoadingIndicator 容器签名 = <style> + 三连点）
    const shape = await status.evaluate((el) => ({
      tag: el.tagName,
      children: Array.from(el.children).map((c) => {
        const testid = c.getAttribute("data-testid");
        return testid ? `${c.tagName.toLowerCase()}[${testid}]` : c.tagName.toLowerCase();
      }),
      styleText: Array.from(el.querySelectorAll("style")).map((s) => s.textContent ?? "").join(""),
      text: (el.textContent ?? "").trim(),
    }));
    expect(shape.tag).toBe("DIV");
    expect(shape.children.length).toBeGreaterThan(0);
    expect(shape.children).toContain("style");
    expect(shape.children).toContain("span[session-status-dots]");
    expect(shape.styleText).toContain("chat-bounce");
    expect(shape.text).toContain("会话运行中");

    const dots = status.getByTestId("session-status-dots");
    await expect(dots).toHaveCount(1);
    expect(await dots.locator("span").count()).toBe(3);

    // (b) 状态行不进消息数组：仍是「1 头部 + 3 消息 + 1 状态行」，消息顺序与夹具一致
    const nodes = page.locator('xpath=//*[@data-testid="chat-message-list"]/*');
    expect(await nodes.count()).toBe(1 + B12_ROWS.length + 1);
    expect(await page.getByTestId("chat-bubble").count()).toBe(B12_ROWS.length);
    expect(await status.locator('[data-testid="chat-bubble"]').count()).toBe(0);
    expect(await status.evaluate((el) => el.parentElement?.getAttribute("data-testid"))).toBe("chat-message-list");
    const outline: string[] = [];
    for (let i = 0; i < (await nodes.count()); i++) {
      const node = nodes.nth(i);
      outline.push(`${(await node.getAttribute("data-testid")) ?? "(no-testid)"}=${(await node.innerText()).replace(/\s+/g, " ")}`);
    }
    console.log("[B12] list outline =", JSON.stringify(outline));
    expect(outline[1]).toContain(B12_ROWS[0].text);
    expect(outline[2]).toContain(B12_ROWS[1].text);
    expect(outline[3]).toContain(B12_ROWS[2].text);
    expect(outline[4].startsWith("session-status=")).toBe(true);
    // 消息数组的三个槽位都不被状态行占位，状态行只在它们之后
    expect(outline.slice(1, 4).filter((line) => line.startsWith("session-status="))).toHaveLength(0);

    // (c) 两行并存时容器规格与 LoadingIndicator 完全一致（同组件、同样式）
    await emitFrame(page, 101, "agent.status", { agentId: "a_developer", instanceId: "ta_1", status: "running", taskId: `team:${TEAM_ID}` });
    const loading = page.locator('div[data-testid="loading-indicator"]');
    await expect(loading).toHaveCount(1);
    await expect(status).toHaveCount(1); // 另一实例仍 running：loading 与 status 两行并存
    expect(await containerSignature(status)).toEqual(await containerSignature(loading));

    await page.screenshot({ path: path.join(B12_DIR, "task-8-status-container.png") });
  });

  test("2. system 消息传入 time 时在 pill 内以元信息样式渲染，降噪契约不回退", async ({ page }) => {
    await openB12List(page, ["idle", "idle", "idle"]);

    const systemRoot = page.locator('[data-testid="chat-bubble"][data-type="system"]');
    await expect(systemRoot).toHaveCount(1);
    await expect(systemRoot).toContainText(B12_ROWS[1].text);

    // (a) time 不再被 system 分支吞掉：出现在 pill 内
    const pill = systemRoot.locator("> div");
    await expect(pill).toHaveCount(1);
    const time = pill.getByTestId("chat-bubble-time");
    await expect(time).toHaveCount(1);
    await expect(time).toHaveText(B12_SYSTEM_TIME);

    // (b) 元信息样式：与 agent 行时间同为 messageFontSize.meta(11px)，且不是 14px 正文
    const timeStyle = await time.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, display: cs.display };
    });
    const agentTime = page.getByTestId("message-identity").getByTestId("chat-bubble-time");
    await expect(agentTime).toHaveCount(1);
    const agentTimeFontSize = await agentTime.evaluate((el) => getComputedStyle(el).fontSize);
    console.log("[B12] system time style =", JSON.stringify(timeStyle), "agent time fontSize =", agentTimeFontSize);
    expect(timeStyle.fontSize).toBe("11px");
    expect(timeStyle.fontSize).toBe(agentTimeFontSize);
    const bodyFontSize = await page.getByTestId("chat-bubble-content").first().evaluate((el) => getComputedStyle(el).fontSize);
    expect(bodyFontSize).toBe("14px");
    expect(timeStyle.fontSize).not.toBe(bodyFontSize);

    // (c) B1/B4 契约不回退：system 仍无身份/头像/作者/折叠节点，data-type=system 与正文保留
    await expect(systemRoot).toHaveAttribute("data-type", "system");
    await expect(systemRoot.getByTestId("message-identity")).toHaveCount(0);
    await expect(systemRoot.getByTestId("agent-avatar")).toHaveCount(0);
    await expect(systemRoot.getByTestId("chat-bubble-author")).toHaveCount(0);
    await expect(systemRoot.getByTestId("chat-bubble-content")).toHaveCount(0);
    await expect(systemRoot.getByTestId("chat-bubble-toggle")).toHaveCount(0);
    await expect(systemRoot).toContainText(B12_ROWS[1].text);
    expect(await page.getByTestId("chat-bubble").count()).toBe(B12_ROWS.length);

    await page.screenshot({ path: path.join(B12_DIR, "task-8-system-time.png") });
  });

  test("3. loading/error 起落与终结事件下 status 行清理行为不变", async ({ page }) => {
    await installSseStub(page);
    await openB12List(page, ["running", "idle", "idle"]);

    const status = page.locator('div[data-testid="session-status"]');
    const loading = page.locator('div[data-testid="loading-indicator"]');
    await expect(status).toHaveCount(1);
    await expect(loading).toHaveCount(0);

    // 起工：agent.status=running → loading 行出现，同 key 的 session 状态行按既有逻辑收敛掉
    await emitFrame(page, 201, "agent.status", { agentId: "a_developer", instanceId: "ta_1", status: "running", taskId: `team:${TEAM_ID}` });
    await expect(loading).toHaveCount(1);
    await expect(status).toHaveCount(0);

    // 完工：agent.status=completed → loading 行移除；session 仍 running → status 行恢复
    await emitFrame(page, 202, "agent.status", { agentId: "a_developer", instanceId: "ta_1", status: "completed", taskId: `team:${TEAM_ID}` });
    await expect(loading).toHaveCount(0);
    await expect(status).toHaveCount(1);

    // 出错：agent.error → 错误行出现（默认不折叠），status 行不被吞
    await emitFrame(page, 203, "agent.error", { agentId: "a_developer", instanceId: "ta_1", error: "B12 故障", taskId: `team:${TEAM_ID}` });
    await expect(page.getByTestId("msg-error")).toHaveCount(1);
    await expect(page.getByTestId("msg-error")).toContainText("B12 故障");
    await expect(status).toHaveCount(1);

    // 终结消息：既有清理把 error 与 running 一并收掉，消息照常入列
    await emitFrame(page, 204, "chat.message.new", newMessagePayload(CHANNEL_ID, "b12_final", "ta_1", "a_developer", "B12 终结回复"));
    await expect(page.getByTestId("msg-error")).toHaveCount(0);
    await expect(loading).toHaveCount(0);
    await expect(status).toHaveCount(0);
    await expect(page.getByTestId("chat-bubble")).toHaveCount(B12_ROWS.length + 1);

    await page.screenshot({ path: path.join(B12_DIR, "task-8-status-cleanup.png") });
  });
});
