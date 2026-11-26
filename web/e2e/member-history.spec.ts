import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";

/**
 * 群聊「点成员看完整会话」e2e（2026-11-10）
 * =============================================
 * 锁的是这条产品语义：**群聊里点成员头像，要看该成员完整的 agent 过程
 * （思考 reasoning + 工具调用 tool），而不是把群聊消息筛一遍**。
 *
 * 改动前实测缺陷链（三处叠加，缺一处都看不到过程）：
 * 1. 群聊读 `/channels/:id/messages`（平台消息表投影），没有完整 parts；
 * 2. `session-history` 对非 private 频道一律 400，前端无通道按成员取会话；
 * 3. `resolveMessage` 按 `isGroupTab` 把 parts 裁成只剩 text —— 即便前两步通了，
 *    界面依旧只有正文（接口已返回 reasoning+tool 却渲染不出来）。
 *
 * 本 spec 用全 route-mock（零后端接触），断言：
 * - 点成员后**必须**请求 `/channels/:c/session-history?teamMemberId=<席位>`（而非 /messages 筛选）；
 * - 该成员的过程组可展开，展开后渲染出 `msg-thinking` 与 `msg-tool` 及各自内容；
 * - 回到「全部」后恢复群聊消息列表（不发 teamMemberId 会话历史请求）。
 *
 * 运行：`npx playwright test --project=session-unification member-history.spec.ts`
 * 失败语义：改动前「点成员」只发 `GET /channels/:c/messages` 且渲染不出
 * msg-thinking / msg-tool → 本 spec 的多条断言在此红。
 */

const TEAM_ID = "tm_0000000001";
const CHANNEL_ID = "c_0000000001";
const PRIVATE_CHANNEL_ID = "c_0000000012";
const TASK_ID = "t_0000000001";
const SEAT_ID = "tmm_0000000002";
const iso = "2026-11-10T04:00:00.000Z";

function teamFixture() {
  return {
    id: TEAM_ID,
    name: "e2e 群聊团队",
    description: null,
    reuseSession: true,
    currentTaskId: TASK_ID,
    currentTaskTitle: "e2e 任务",
    currentTaskStatus: "in_progress",
    mainAgentMemberId: SEAT_ID,
    version: 1,
    createdBy: "u_seed_admin",
    createdAt: iso,
    updatedAt: iso,
    members: [
      {
        id: SEAT_ID,
        teamId: TEAM_ID,
        memberId: null,
        agentId: "a_project_manager",
        roleId: "ar_project_manager",
        alias: "周一项",
        seq: 1,
        workDir: "/tmp/e2e",
        member: null,
        agent: { id: "a_project_manager", name: "项目经理", role: "project_manager" },
        // 席级状态（成员头像状态点数据源）
        sessionStatus: { busyState: "idle", busySince: null, lastTurnOutcome: "ok", lastActivityAt: iso },
        createdAt: iso,
      },
    ],
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
    mainAgentMemberId: SEAT_ID,
    managedMode: false,
    backgroundDocs: [],
    teamAgentIds: ["a_project_manager"],
    instances: [
      {
        id: SEAT_ID,
        agentId: "a_project_manager",
        alias: "周一项",
        seq: 1,
        name: "项目经理",
        role: "project_manager",
        main: true,
        enabled: true,
        overrideModelId: null,
        sessionStatus: "idle",
        sessionId: "s_1",
      },
    ],
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

/** 群聊消息（平台表投影）：只有 text，**没有** reasoning/tool —— 这正是改动前的数据形状。 */
function groupMessagesFixture() {
  return {
    items: [
      {
        id: "m_group_1",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: { text: "群聊里只有这条结论", parts: [{ type: "text", text: "群聊里只有这条结论" }] },
        mentions: [],
        attachmentUrl: null,
        attachmentName: null,
        attachmentType: null,
        status: "sent",
        createdAt: iso,
      },
    ],
    nextCursor: null,
  };
}

/** 该成员完整会话（session-history）：text + reasoning + tool 三件套。 */
function memberHistoryFixture(
  items: Array<Record<string, unknown>> = [
    {
      id: "m_member_1",
      channelId: CHANNEL_ID,
      senderType: "agent",
      senderId: "a_project_manager",
      senderInstanceId: SEAT_ID,
      content: {
        text: "我查一下配置",
        parts: [
          { type: "reasoning", state: "done", text: "先看看 config.json 里有没有这个字段" },
          {
            type: "tool",
            name: "bash",
            state: { status: "success", input: "cat config.json", output: "{enabledModules: []}" },
          },
          { type: "text", text: "我查一下配置" },
        ],
      },
      mentions: [],
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      status: "sent",
      createdAt: iso,
    },
  ],
) {
  return { items, nextCursor: null, source: "session" };
}

/** 足量历史 + 最新一轮可展开思考：用于验证局部高度变化时的滚动门控。 */
function memberHistoryWithExpandableThinking() {
  const items: Array<Record<string, unknown>> = Array.from({ length: 24 }, (_, index) => {
    const text = `历史消息 ${index}：${"用于撑开成员历史列表的正文。".repeat(8)}`;
    return {
      id: `m_scroll_fill_${index}`,
      channelId: CHANNEL_ID,
      senderType: "agent",
      senderId: "a_project_manager",
      senderInstanceId: SEAT_ID,
      content: { text, parts: [{ type: "text", text }] },
      mentions: [],
      status: "sent",
      createdAt: iso,
    };
  });
  const thinkingText = `思考展开前摘要\n${"展开后的详细思考内容，用于验证内容高度增长后的贴底滚动。".repeat(80)}`;
  const bodyText = `最终结论：${"思考之后的正文也必须保持在可视区域内。".repeat(80)}`;
  items.push({
    id: "m_scroll_thinking",
    channelId: CHANNEL_ID,
    senderType: "agent",
    senderId: "a_project_manager",
    senderInstanceId: SEAT_ID,
    content: {
      text: bodyText,
      parts: [
        { id: "p_scroll_thinking", type: "reasoning", state: "done", text: thinkingText },
        { id: "p_scroll_body", type: "text", text: bodyText },
      ],
    },
    mentions: [],
    status: "sent",
    createdAt: iso,
  });
  return memberHistoryFixture(items);
}

/** 受控 EventSource：由测试显式投递私聊频道 delta，验证成员过程视图实时消费。 */
async function installSseStub(page: Page, style: "native" | "dsh"): Promise<void> {
  await page.addInitScript((streamStyle) => {
    localStorage.setItem(
      "vteam-chat-stream-style",
      JSON.stringify({ state: { streamStyle }, version: 0 }),
    );
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
    const scope = window as unknown as { __memberSseEmit?: (frame: unknown) => void };
    scope.__memberSseEmit = (frame) => {
      const target = instances.filter((item) => !item.closed).at(-1);
      if (!target?.onmessage) throw new Error("no live EventSource");
      target.onmessage({ data: JSON.stringify(frame) });
    };
  }, style);
}

async function emitMemberDelta(
  page: Page,
  message: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((payload) => {
    const scope = window as unknown as { __memberSseEmit?: (frame: unknown) => void };
    if (!scope.__memberSseEmit) throw new Error("EventSource stub 未安装");
    scope.__memberSseEmit({
      id: `ev_${payload.message.id}`,
      type: "message.part.delta",
      payload,
      timestamp: new Date().toISOString(),
    });
  }, { message, delta: (message.content as { parts: unknown[] }).parts });
}

interface Seen {
  /** 带 teamMemberId 的 session-history 请求（期望恰好命中） */
  memberHistory: string[];
  /** 群聊消息列表请求 */
  groupMessages: string[];
}

async function installMocks(
  page: Page,
  history: ReturnType<typeof memberHistoryFixture> = memberHistoryFixture(),
): Promise<Seen> {
  const seen: Seen = { memberHistory: [], groupMessages: [] };
  await page.route("**/api/v1/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const apiPath = url.pathname.replace(/^\/api\/v1/, "") || "/";
    const method = req.method();

    // SSE 直接 abort：页面走 REST 种子渲染，保持 hermetic
    if (apiPath === "/events") return route.abort();

    // ★ 核心断言点：群聊 + teamMemberId 的会话历史
    if (method === "GET" && apiPath === `/channels/${CHANNEL_ID}/session-history`) {
      const member = url.searchParams.get("teamMemberId");
      if (member) seen.memberHistory.push(member);
      return route.fulfill({ json: history });
    }

    if (method === "GET" && apiPath === `/channels/${CHANNEL_ID}/messages`) {
      seen.groupMessages.push(apiPath);
      return route.fulfill({ json: groupMessagesFixture() });
    }

    if (method === "GET" && apiPath === `/teams/${TEAM_ID}`) return route.fulfill({ json: teamFixture() });
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}`) return route.fulfill({ json: taskFixture() });
    if (method === "GET" && apiPath === "/channels") {
      return route.fulfill({
        json: {
          items: [
            { id: CHANNEL_ID, type: "team_group", teamId: TEAM_ID, taskId: null, agentId: null },
            {
              id: PRIVATE_CHANNEL_ID,
              type: "private",
              teamId: TEAM_ID,
              teamMemberId: SEAT_ID,
              taskId: null,
              agentId: "a_project_manager",
            },
          ],
          total: 2,
        },
      });
    }
    if (method === "GET" && apiPath === "/tasks") {
      return route.fulfill({
        json: {
          items: [
            { id: TASK_ID, title: "e2e 任务", status: "in_progress", createdAt: iso, startedAt: iso, pendingReviewAt: null, completedAt: null },
          ],
          total: 1,
          page: 1,
          pageSize: 100,
        },
      });
    }
    if (method === "GET" && apiPath === "/agents") return route.fulfill({ json: { items: [], total: 0 } });
    if (method === "GET" && apiPath === "/agent-roles") return route.fulfill({ json: { items: [], total: 0 } });
    if (method === "GET" && apiPath === "/members") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } });
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}/artifacts`) {
      return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 10 } });
    }
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}/plan-docs`) return route.fulfill({ json: { items: [], total: 0 } });
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}/plan-steps`) return route.fulfill({ json: { items: [], total: 0 } });
    if (method === "GET" && apiPath === "/issues") return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } });
    if (method === "GET" && apiPath === "/questions") return route.fulfill({ json: [] });
    /**
     * 会话列表必须把群聊列出来 —— `/chat` 的选中态与 `isGroup` 判定都来自它
     * （page.tsx: active = items.find(id === ?c=)）。返回空列表会让页面直接落到
     * 「还没有会话」空态，group-member-switcher / team-session-root 都不渲染。
     */
    if (method === "GET" && apiPath === "/conversations") {
      return route.fulfill({
        json: {
          items: [
            {
              id: `group:${TEAM_ID}`,
              type: "group",
              title: "e2e 群聊团队",
              badge: "群",
              channelId: CHANNEL_ID,
              contextTeamId: TEAM_ID,
              memberCount: 1,
              unreadCount: 0,
              pinned: false,
              processing: false,
              lastMessage: { text: "群聊里只有这条结论", createdAt: iso },
            },
          ],
          total: 1,
        },
      });
    }
    /**
     * 兜底**不能**返回 `{items: []}` —— 不同端点响应形状不同（有的期望数组、
     * 有的期望对象），喂错形状会让页面在 `.map` 处抛
     * `(intermediate value).map is not a function` → 整页 white-screen。
     * 用 404 让调用方走各自既有的 error/空态分支，本 spec 只关心会话链路。
     */
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND", message: `e2e 未 mock: ${apiPath}` } });
  });
  return seen;
}

test.describe("群聊点成员 → 该成员完整会话（含思考/工具）", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  test("点成员后走 session-history（带 teamMemberId），并渲染出 tool / thinking", async ({ page }) => {
    const seen = await installMocks(page);
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });

    // 「全部」视角：先看到群聊消息（只有结论文本）
    await expect(page.getByTestId("chat-message-list")).toContainText("群聊里只有这条结论");

    // 点成员
    const chip = page.getByTestId("group-member-chip").first();
    await expect(chip).toBeVisible();
    await chip.click();

    // ★ 1) 必须带 teamMemberId 请求 session-history（改动前这里恒为 0 次）
    await expect
      .poll(() => seen.memberHistory.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(seen.memberHistory).toContain(SEAT_ID);

    // ★ 2) 分隔文案切到「成员过程」
    await expect(page.getByTestId("chat-message-list")).toContainText("成员过程");

    // ★ 3) 过程组存在，展开后渲染出工具与思考卡片
    const group = page.getByTestId("msg-process-group").first();
    await expect(group).toBeVisible({ timeout: 15_000 });
    await group.locator("button").first().click();

    const tool = page.getByTestId("msg-tool").first();
    const thinking = page.getByTestId("msg-thinking").first();
    await expect(tool).toBeVisible({ timeout: 10_000 });
    await expect(thinking).toBeVisible({ timeout: 10_000 });
    // 工具默认只保留一行执行摘要，不把输出摊成卡片。
    await expect(tool).toContainText("运行命令");
    await expect(tool).toContainText("cat config.json");
    await expect(tool).toContainText("1 行输出");
    await expect(tool).not.toContainText("{enabledModules: []}");
    await expect(tool).not.toContainText("成功");
    await tool.locator("button[aria-expanded]").click();
    await expect(tool.getByTestId("msg-tool-io")).toContainText("{enabledModules: []}");
    await expect(thinking).toContainText("先看看 config.json 里有没有这个字段");
  });

  test("已贴底时展开最新思考仍保持贴底", async ({ page }) => {
    await installSseStub(page, "native");
    // 线上 Chromium 对“展开块自身位于底部”的本地高度变化不会补位；关闭浏览器
    // 原生 scroll anchoring，确保断言验证的是应用自己的贴底跟随逻辑。
    const seen = await installMocks(page, memberHistoryWithExpandableThinking());
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await page.addStyleTag({
      content: '[data-testid="chat-message-list"] { overflow-anchor: none; }',
    });
    await page.getByTestId("group-member-chip").first().click();
    await expect.poll(() => seen.memberHistory.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const list = page.getByTestId("chat-message-list");
    const distanceFromBottom = () =>
      list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(distanceFromBottom, { timeout: 15_000 }).toBeLessThan(48);
    // 初次切成员视角还有一次 150ms 的延迟滚底；等它结束后再触发展开，
    // 否则会把这次初始滚动误判成展开后的自动跟随。
    await page.waitForTimeout(250);

    const thinking = list.getByTestId("msg-thinking").last();
    await expect(thinking).toHaveAttribute("data-state", "done");
    const beforeHeight = await list.evaluate((el) => el.scrollHeight);
    await thinking.locator('button[aria-expanded="false"]').click();
    await expect(thinking.getByTestId("msg-thinking-detail")).toBeVisible();
    expect(await list.evaluate((el) => el.scrollHeight)).toBeGreaterThan(beforeHeight + 120);
    await expect
      .poll(distanceFromBottom, {
        timeout: 10_000,
        message: "思考展开增加高度后，原先贴底的列表应继续跟随到底部",
      })
      .toBeLessThan(48);
  });

  test("用户上翻后展开思考不强制拉回底部", async ({ page }) => {
    await installSseStub(page, "native");
    const seen = await installMocks(page, memberHistoryWithExpandableThinking());
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("group-member-chip").first().click();
    await expect.poll(() => seen.memberHistory.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const list = page.getByTestId("chat-message-list");
    await expect
      .poll(
        () => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
        { timeout: 15_000 },
      )
      .toBeLessThan(48);
    // 初次切成员视角还有一次 150ms 的延迟滚底，先让它结束再模拟用户上翻。
    await page.waitForTimeout(250);
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
    // 等滚动事件更新贴底门控，再触发展开，避免把初始滚底 effect 误算成强制回底。
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    const thinking = list.getByTestId("msg-thinking").last();
    await thinking.locator('button[aria-expanded="false"]').evaluate((el) => {
      (el as HTMLButtonElement).click();
    });
    await expect(thinking.getByTestId("msg-thinking-detail")).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  });

  test("主 Agent 私聊派发按用户消息右侧展示，并保持 createdAt 顺序", async ({ page }) => {
    await installSseStub(page, "native");
    const history = memberHistoryFixture([
      {
        id: "m_own_sent",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: { text: "成员已有回复", parts: [{ type: "text", text: "成员已有回复" }] },
        mentions: [],
        status: "sent",
        createdAt: "2026-11-10T04:00:00.000Z",
      },
      {
        id: "m_pm_dispatch",
        channelId: PRIVATE_CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: "tmm_other_agent",
        content: { text: "@开发者-1 这是新的派发指令", parts: [] },
        mentions: null,
        status: "sent",
        createdAt: "2026-11-10T04:01:00.000Z",
      },
      {
        id: "m_own_processing",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: { text: "成员正在处理", parts: [{ type: "text", text: "成员正在处理" }] },
        mentions: [],
        status: "processing",
        createdAt: "2026-11-10T04:02:00.000Z",
      },
    ]);
    const seen = await installMocks(page, history);
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("group-member-chip").first().click();
    await expect.poll(() => seen.memberHistory.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const dispatch = page.locator('[data-msg-nav-id="m_pm_dispatch"]');
    await expect(dispatch.getByTestId("chat-bubble")).toHaveAttribute("data-type", "user");
    await expect(dispatch.getByTestId("message-identity")).toHaveCount(0);
    await expect(dispatch.getByTestId("agent-avatar")).toHaveCount(0);
    await expect(dispatch).not.toContainText("项目经理-1");
    expect(
      await dispatch.getByTestId("chat-bubble").evaluate((el) => getComputedStyle(el).alignSelf),
    ).toBe("flex-end");

    const order = await page.getByTestId("chat-message-list").evaluate((list) =>
      [...list.querySelectorAll("[data-msg-nav-id]")].map((el) => el.getAttribute("data-msg-nav-id")),
    );
    expect(order).toEqual(["m_own_sent", "m_pm_dispatch", "m_own_processing"]);
  });

  test("成员历史实时过滤 group_post / notify_agent 的群消息投影", async ({ page }) => {
    await installSseStub(page, "native");
    const history = memberHistoryFixture([
      {
        id: "m_tool_turn",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: {
          text: "工具调用完成",
          parts: [
            {
              type: "tool",
              tool: "mcp__vteam__group_post",
              state: { status: "success", input: "{}", output: '{"messageId":"m_group_projection"}' },
            },
            {
              type: "tool",
              tool: "mcp__vteam__notify_agent",
              state: { status: "success", input: "{}", output: '{"messageId":"m_notify_projection"}' },
            },
          ],
        },
        mentions: [],
        status: "sent",
        createdAt: iso,
      },
    ]);
    const seen = await installMocks(page, history);
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("group-member-chip").first().click();
    await expect.poll(() => seen.memberHistory.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const list = page.getByTestId("chat-message-list");
    await expect(list).toContainText("工具调用完成");
    await page.evaluate((messages) => {
      const scope = window as unknown as { __memberSseEmit?: (frame: unknown) => void };
      if (!scope.__memberSseEmit) throw new Error("EventSource stub 未安装");
      for (const message of messages) {
        scope.__memberSseEmit({
          id: `ev_${message.id}`,
          type: "chat.message.new",
          payload: { message },
          timestamp: new Date().toISOString(),
        });
      }
    }, [
      {
        id: "m_group_projection",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: { text: "group_post 群投影不应出现", parts: [] },
        mentions: [],
        status: "sent",
        createdAt: "2026-11-10T04:01:00.000Z",
      },
      {
        id: "m_notify_projection",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: { text: "notify_agent 群投影不应出现", parts: [] },
        mentions: [],
        status: "sent",
        createdAt: "2026-11-10T04:02:00.000Z",
      },
    ]);

    await expect(list).not.toContainText("group_post 群投影不应出现");
    await expect(list).not.toContainText("notify_agent 群投影不应出现");
  });

  test("成员过程实时消费私聊 delta，原生气泡不混入 DSH，并展示 user 派发锚点", async ({ page }) => {
    await installSseStub(page, "native");
    const live = {
      id: "m_live",
      channelId: CHANNEL_ID,
      senderType: "agent",
      senderId: "a_project_manager",
      senderInstanceId: SEAT_ID,
      content: {
        text: "旧正文",
        parts: [
          { id: "p_think_old", type: "reasoning", text: "旧思考" },
          { id: "p_tool_old", type: "tool", tool: "bash", state: { status: "running", input: "echo old" } },
          { id: "p_text_old", type: "text", text: "旧正文" },
        ],
      },
      mentions: [],
      status: "processing",
      createdAt: "2026-11-10T04:10:00.000Z",
    };
    const history = memberHistoryFixture([
      {
        id: "m_private_user",
        channelId: PRIVATE_CHANNEL_ID,
        senderType: "user",
        senderId: "a_project_manager",
        senderInstanceId: null,
        content: { text: "主 Agent 派给成员的任务", parts: [] },
        mentions: null,
        status: "sent",
        createdAt: iso,
      },
      {
        id: "m_old",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: {
          text: "历史结论",
          parts: [
            { id: "p_old_think", type: "reasoning", text: "历史思考" },
            { id: "p_old_tool", type: "tool", tool: "bash", state: { status: "success", input: "echo old", output: "ok" } },
            { id: "p_old_text", type: "text", text: "历史结论" },
          ],
        },
        mentions: [],
        status: "sent",
        createdAt: iso,
      },
      {
        id: "m_process_only",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: {
          text: "",
          parts: [
            { id: "p_only_think", type: "reasoning", text: "上一轮纯过程思考" },
            { id: "p_only_tool", type: "tool", tool: "bash", state: { status: "success", input: "echo only", output: "ok" } },
          ],
        },
        mentions: [],
        status: "sent",
        createdAt: "2026-11-10T04:02:00.000Z",
      },
      live,
    ]);
    const seen = await installMocks(page, history);
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("group-member-chip").first().click();
    await expect.poll(() => seen.memberHistory.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const list = page.getByTestId("chat-message-list");
    await expect(list).toContainText("主 Agent 派给成员的任务");
    await expect(list).toContainText("旧正文");
    // 历史过程聚合必须属于下一条消息内部：身份栏在前，过程摘要在后，不能浮在头像上方。
    const liveAnchor = page.locator('[data-msg-nav-id="m_live"]');
    const aggregateInMessage = liveAnchor.getByTestId("msg-process-group").first();
    await expect(aggregateInMessage).toBeVisible();
    const identityInMessage = liveAnchor.getByTestId("message-identity").first();
    await expect(identityInMessage).toBeVisible();
    const order = await identityInMessage.evaluate((identity) => {
      const aggregate = identity
        .closest('[data-msg-nav-id="m_live"]')
        ?.querySelector('[data-testid="msg-process-group"]');
      if (!aggregate) return 0;
      return identity.compareDocumentPosition(aggregate) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).not.toBe(0);
    const identityBox = await identityInMessage.boundingBox();
    const aggregateBox = await aggregateInMessage.boundingBox();
    expect(identityBox).not.toBeNull();
    expect(aggregateBox).not.toBeNull();
    expect(aggregateBox!.y).toBeGreaterThanOrEqual(identityBox!.y);
    await liveAnchor.screenshot({
      path: path.join(
        process.cwd(),
        "..",
        ".omo",
        "evidence",
        "chat-ux-hierarchy-and-streaming",
        "member-process-order.png",
      ),
    });
    // native 模式的历史过程聚合必须走 msg-*，不能混入 dsh-*。
    await expect(list.getByTestId("msg-process-group").first()).toBeVisible();
    await expect(list.getByTestId("msg-process-group").last()).toHaveAttribute(
      "data-state",
      "expanded",
    );
    await expect(list.getByTestId("dsh-process-group")).toHaveCount(0);
    await expect(list.getByTestId("dsh-reasoning")).toHaveCount(0);
    await expect(list.getByTestId("dsh-tool")).toHaveCount(0);
    // reasoning 后面已经有工具和正文，不能因为整条消息仍在 processing 就继续显示思考中。
    await expect(list.getByTestId("msg-thinking").last()).toHaveAttribute("data-state", "done");
    await expect(list.getByTestId("msg-thinking").last()).toHaveAttribute("data-marquee-speed", "0");

    await emitMemberDelta(page, {
      ...live,
      content: {
        text: "新正文",
        parts: [
          { id: "p_think_old", type: "reasoning", text: "新思考：已经接收到流式增量" },
          { id: "p_tool_old", type: "tool", tool: "bash", state: { status: "success", input: "echo new", output: "ok" } },
          { id: "p_text_old", type: "text", text: "新正文" },
        ],
      },
    });

    await expect(list).toContainText("新正文");
    await expect(list).toContainText("新思考：已经接收到流式增量");
    await expect(list).toContainText("echo new");
  });

  test("native 思考跑马灯按 token 增量速度滚动，停止增长后暂停", async ({ page }) => {
    await installSseStub(page, "native");
    const initialText = "正在推理模型输出。".repeat(80);
    const live = {
      id: "m_marquee_live",
      channelId: CHANNEL_ID,
      senderType: "agent",
      senderId: "a_project_manager",
      senderInstanceId: SEAT_ID,
      content: {
        text: "",
        parts: [{ id: "p_marquee_think", type: "reasoning", text: initialText }],
      },
      mentions: [],
      status: "processing",
      createdAt: iso,
    };
    const seen = await installMocks(page, memberHistoryFixture([live]));
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("group-member-chip").first().click();
    await expect.poll(() => seen.memberHistory.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const thinking = page.getByTestId("chat-message-list").getByTestId("msg-thinking");
    await expect(thinking).toHaveAttribute("data-state", "pending");
    await expect(thinking).toHaveAttribute("data-marquee-speed", "0");

    await emitMemberDelta(page, {
      ...live,
      content: {
        text: "",
        parts: [
          {
            id: "p_marquee_think",
            type: "reasoning",
            text: initialText + "新增token输出。".repeat(120),
          },
        ],
      },
    });

    await expect
      .poll(async () => Number(await thinking.getAttribute("data-marquee-speed")), { timeout: 1_000 })
      .toBeGreaterThan(70);
    // 没有新增 token 后暂停，不再慢悠悠地滚动静态文本。
    await expect
      .poll(async () => Number(await thinking.getAttribute("data-marquee-speed")), { timeout: 2_000 })
      .toBe(0);
  });

  test("DSH 成员过程实时刷新，单行思考增量也有可见摘要", async ({ page }) => {
    await installSseStub(page, "dsh");
    const live = {
      id: "m_dsh_live",
      channelId: CHANNEL_ID,
      senderType: "agent",
      senderId: "a_project_manager",
      senderInstanceId: SEAT_ID,
      content: {
        text: "",
        parts: [
          { id: "p_dsh_think", type: "reasoning", text: "旧单行思考" },
        ],
      },
      mentions: [],
      status: "processing",
      createdAt: "2026-11-10T04:10:00.000Z",
    };
    const history = memberHistoryFixture([
      {
        id: "m_dsh_old_proc",
        channelId: CHANNEL_ID,
        senderType: "agent",
        senderId: "a_project_manager",
        senderInstanceId: SEAT_ID,
        content: {
          text: "",
          parts: [
            { id: "p_dsh_old_think", type: "reasoning", text: "上一轮 DSH 思考" },
            { id: "p_dsh_old_tool", type: "tool", tool: "bash", state: { status: "success", input: "echo old", output: "ok" } },
          ],
        },
        mentions: [],
        status: "sent",
        createdAt: iso,
      },
      live,
    ]);
    const seen = await installMocks(page, history);
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("group-member-chip").first().click();
    await expect.poll(() => seen.memberHistory.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const list = page.getByTestId("chat-message-list");
    const liveAnchor = page.locator('[data-msg-nav-id="m_dsh_live"]');
    const aggregateInMessage = liveAnchor.getByTestId("dsh-process-group").first();
    await expect(aggregateInMessage).toBeVisible();
    const identityInMessage = liveAnchor.getByTestId("message-identity").first();
    await expect(identityInMessage).toBeVisible();
    const order = await identityInMessage.evaluate((identity) => {
      const aggregate = identity
        .closest('[data-msg-nav-id="m_dsh_live"]')
        ?.querySelector('[data-testid="dsh-process-group"]');
      if (!aggregate) return 0;
      return identity.compareDocumentPosition(aggregate) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).not.toBe(0);
    await expect(list.getByTestId("dsh-reasoning")).toHaveAttribute("data-state", "running");
    await expect(list.getByTestId("dsh-reasoning-summary").first()).toContainText("旧单行思考");

    await emitMemberDelta(page, {
      ...live,
      content: {
        text: "",
        parts: [
          { id: "p_dsh_think", type: "reasoning", text: "新的单行思考增量" },
          { id: "p_dsh_tool", type: "tool", tool: "bash", state: { status: "success", input: "echo new", output: "ok" } },
        ],
      },
    });

    await expect(list.getByTestId("dsh-reasoning-summary").first()).toContainText(
      "新的单行思考增量",
    );
    await expect(list.getByTestId("dsh-tool").first()).toContainText("echo new");
    await expect(list.getByTestId("dsh-tool-output-lines").first()).toContainText("1 行输出");
    await expect(list.getByTestId("dsh-tool").first()).not.toContainText("ok");
    await expect(list.getByTestId("dsh-reasoning")).toHaveAttribute("data-state", "done");
    await expect(list.getByTestId("msg-process-group")).toHaveCount(0);
  });

  test("回到「全部」→ 恢复群聊消息列表", async ({ page }) => {
    const seen = await installMocks(page);
    await page.goto(`/chat?c=group:${TEAM_ID}`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("group-member-chip").first().click();
    await expect.poll(() => seen.memberHistory.length, { timeout: 15_000 }).toBeGreaterThan(0);

    // 回到全部（「全」按钮 = 成员切换条的第一个按钮）
    const switcher = page.getByTestId("group-member-switcher");
    await switcher.locator("button").first().click();

    await expect(page.getByTestId("chat-message-list")).toContainText("团队会话");
    await expect(page.getByTestId("chat-message-list")).toContainText("群聊里只有这条结论");
  });
});
