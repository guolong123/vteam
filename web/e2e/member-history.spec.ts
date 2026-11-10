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
function memberHistoryFixture() {
  return {
    items: [
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
    nextCursor: null,
    source: "session",
  };
}

interface Seen {
  /** 带 teamMemberId 的 session-history 请求（期望恰好命中） */
  memberHistory: string[];
  /** 群聊消息列表请求 */
  groupMessages: string[];
}

async function installMocks(page: Page): Promise<Seen> {
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
      return route.fulfill({ json: memberHistoryFixture() });
    }

    if (method === "GET" && apiPath === `/channels/${CHANNEL_ID}/messages`) {
      seen.groupMessages.push(apiPath);
      return route.fulfill({ json: groupMessagesFixture() });
    }

    if (method === "GET" && apiPath === `/teams/${TEAM_ID}`) return route.fulfill({ json: teamFixture() });
    if (method === "GET" && apiPath === `/tasks/${TASK_ID}`) return route.fulfill({ json: taskFixture() });
    if (method === "GET" && apiPath === "/channels") {
      return route.fulfill({
        json: { items: [{ id: CHANNEL_ID, type: "team_group", teamId: TEAM_ID, taskId: null, agentId: null }], total: 1 },
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
    // 内容真的透传进来（不是空壳）
    await expect(tool).toContainText("bash");
    await expect(thinking).toContainText("先看看 config.json 里有没有这个字段");
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
