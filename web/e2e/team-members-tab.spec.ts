import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";

/**
 * 团队右栏「成员」子页（2026-11-18）
 * =============================================
 * 需求四条，逐条锁死：
 *
 * 1. **子 Tab 里能看到成员列表** —— 团队主 Tab → 「成员」子 Tab 出现，
 *    列表逐席位渲染（名字/角色/主 Agent 标记/状态）；
 * 2. **快速添加成员** —— 从成员库挑一个加入团队（已在团队里的不出现在候选里），
 *    只打 `POST /teams/:id/members`；
 * 3. **配置成员模型 / 节点** —— 两个 SearchableSelect 直接 PATCH 席位，
 *    空白值提交 `null`（= 跟随团队），不是空串；
 * 4. **移除 = 踢出团队，不删成员** —— 这是本条需求最要紧的语义边界：
 *    - 只允许 `DELETE /api/v1/teams/<id>/members/<seatId>`；
 *    - **绝不能**出现 `DELETE /api/v1/members/<id>`（那才是删平台成员，
 *      `cascadeSeats` 还会把他从所有群聊里清掉）。
 *    用例用 request 监听把这条钉死，顺序无关、一眼可读。
 *
 * 全 route-mock（无后端），用 afterEach 统一清理。
 */

const TEAM_ID = "tm_members_tab";
const iso = "2026-11-18T05:00:00.000Z";

interface SeatSeed {
  id: string;
  alias: string;
  role: string;
  roleId: string;
  memberId: string;
  memberName: string;
}

const SEATS: SeatSeed[] = [
  { id: "tmm_tab_1", alias: "项目经理-1", role: "project_manager", roleId: "ar_pm", memberId: "mbr_pm", memberName: "项目经理甲" },
  { id: "tmm_tab_2", alias: "开发者-1", role: "developer", roleId: "ar_dev", memberId: "mbr_dev", memberName: "开发者乙" },
];

/** 成员库：两个已在团队 + 一个可加入的候选。 */
const LIBRARY = [
  { id: "mbr_pm", name: "项目经理甲", role: { id: "ar_pm", key: "project_manager", name: "项目经理" } },
  { id: "mbr_dev", name: "开发者乙", role: { id: "ar_dev", key: "developer", name: "开发者" } },
  { id: "mbr_qa", name: "测试丙", role: { id: "ar_tester", key: "tester", name: "测试" } },
];

function teamFixture(seats: SeatSeed[] = SEATS) {
  return {
    id: TEAM_ID,
    name: "e2e 成员子页团队",
    description: "成员子页回归",
    reuseSession: true,
    managedMode: true,
    currentTaskId: null,
    mainAgentMemberId: seats[0]?.id ?? null,
    preferredWorkerId: "w_team",
    defaultModelId: "md_team_default",
    version: 1,
    createdBy: "u_seed_admin",
    createdAt: iso,
    updatedAt: iso,
    members: seats.map((s, i) => ({
      id: s.id,
      teamId: TEAM_ID,
      memberId: s.memberId,
      agentId: `a_${s.role}`,
      roleId: s.roleId,
      alias: s.alias,
      seq: i + 1,
      workDir: `/data/vteam-worker/${s.alias}`,
      overrideModelId: s.id === "tmm_tab_2" ? "md_dev_override" : null,
      preferredWorkerId: s.id === "tmm_tab_2" ? "w_dev" : null,
      currentWorkerId: null,
      member: {
        id: s.memberId,
        name: s.memberName,
        status: "active",
        agentId: `a_${s.role}`,
        defaultRoleId: s.roleId,
      },
      agent: { id: `a_${s.role}`, name: s.alias, role: s.role },
      sessionStatus: {
        busyState: "idle",
        busySince: null,
        lastTurnOutcome: null,
        lastActivityAt: null,
      },
      createdAt: iso,
    })),
    userMembers: [],
  };
}

interface MockOptions {
  /** 当前团队（允许用例中途替换，模拟刷新后状态）。 */
  team?: () => ReturnType<typeof teamFixture>;
  /** 记录所有请求，供断言「打了哪个端点」。 */
  log?: Array<{ method: string; path: string; body: string | null }>;
}

async function installMocks(page: Page, options: MockOptions = {}): Promise<void> {
  const teamOf = options.team ?? (() => teamFixture());
  const log = options.log;

  // 兜底：其余接口给空分页
  await page.route("**/api/v1/**", (route: Route) => {
    if (log) {
      const req = route.request();
      log.push({
        method: req.method(),
        path: new URL(req.url()).pathname,
        body: req.postData(),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 100 }),
    });
  });
  await page.route("**/api/v1/events*", (route) => route.abort());
  await page.route((url) => url.pathname === "/api/v1/workers", (route) =>
    route.fulfill({
      json: [
        { id: "w_team", name: "keta-team", status: "online" },
        { id: "w_dev", name: "keta-dev", status: "online" },
        { id: "w_off", name: "keta-archive", status: "offline" },
      ],
    }),
  );
  await page.route((url) => url.pathname === "/api/v1/models", (route) =>
    route.fulfill({
      json: {
        items: [
          { id: "md_team_default", name: "deepseek-v4.1-flash", providerID: "commandcode" },
          { id: "md_dev_override", name: "deepseek-v4.1", providerID: "commandcode" },
          { id: "md_other", name: "glm-5", providerID: "zhipu" },
        ],
        total: 3,
        page: 1,
        pageSize: 100,
      },
    }),
  );
  await page.route("**/api/v1/agent-roles**", (route) =>
    route.fulfill({
      json: {
        items: [
          { id: "ar_pm", key: "project_manager", name: "项目经理", type: "builtin", defaultAgentId: "a_project_manager" },
          { id: "ar_dev", key: "developer", name: "开发者", type: "builtin", defaultAgentId: "a_developer" },
          { id: "ar_tester", key: "tester", name: "测试", type: "builtin", defaultAgentId: "a_tester" },
        ],
        total: 3,
        page: 1,
        pageSize: 100,
      },
    }),
  );
  await page.route((url) => url.pathname === "/api/v1/members", (route) =>
    route.fulfill({ json: { items: LIBRARY, total: LIBRARY.length, page: 1, pageSize: 200 } }),
  );
  await page.route((url) => url.pathname === "/api/v1/conversations", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: `group:${TEAM_ID}`,
            type: "group",
            title: "e2e 成员子页团队",
            badge: "群",
            channelId: "c_members_tab",
            contextTeamId: TEAM_ID,
            memberCount: SEATS.length,
            unreadCount: 0,
            pinned: false,
            processing: false,
            lastMessage: { text: "成员子页回归", createdAt: iso },
          },
        ],
        total: 1,
      },
    }),
  );
  await page.route((url) => url.pathname === `/api/v1/teams/${TEAM_ID}`, (route) =>
    route.fulfill({ json: teamOf() }),
  );
  await page.route((url) => url.pathname === `/api/v1/channels/c_members_tab/messages`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "m_1",
            channelId: "c_members_tab",
            senderType: "agent",
            senderId: "a_project_manager",
            senderInstanceId: SEATS[0].id,
            content: { text: "成员子页回归用例消息", parts: [{ type: "text", text: "成员子页回归用例消息" }] },
            mentions: [],
            status: "sent",
            createdAt: iso,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route((url) => url.pathname === "/api/v1/tasks", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );
  await page.route((url) => url.pathname === "/api/v1/channels", (route) =>
    route.fulfill({
      json: { items: [{ id: "c_members_tab", type: "team_group", teamId: TEAM_ID, taskId: null, agentId: null }], total: 1 },
    }),
  );
  await page.route((url) => url.pathname === `/api/v1/channels/c_members_tab/session-history`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route("**/api/v1/questions**", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/v1/issues**", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );
  await page.route("**/api/v1/triggers**", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );
}

/**
 * 清掉本会话可能残留的面板收起/宽度偏好。
 *
 * 为什么必须做：右栏任务面板的收起态是**持久化到 localStorage** 的
 * （small-screen-panels 那批用例会在小视口下把它收起并落盘，而 storageState
 * 的 origin 与这里相同）→ 后续跑成员子页时 `task-panel` 根本不渲染，
 * 表现成「找不到 task-panel」的假失败。这里只清面板键，不动登录态。
 */
const PANEL_PREF_KEYS = [
  "chat-conversation-list-width",
  "chat-conversation-list-width-collapsed",
  "chat-right-panel-width",
  "chat-right-panel-width-collapsed",
  "team-session-right-width",
  "team-session-right-width-collapsed",
  "team-session-members-width",
  "team-session-members-width-collapsed",
];

async function resetPanelPrefs(page: Page): Promise<void> {
  await page.addInitScript((keys) => {
    try {
      for (const key of keys) window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }, PANEL_PREF_KEYS);
}

/** 进入群聊会话页 → 切到右栏「团队」主 Tab → 切到「成员」子 Tab。 */
async function openMembersTab(page: Page): Promise<void> {
  await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
  await expect(page.getByTestId("task-panel")).toBeVisible({ timeout: 20_000 });
  const panel = page.getByTestId("task-panel");
  await panel.getByRole("button", { name: "团队", exact: true }).click();
  await expect(page.getByTestId("team-subtab-scroll")).toBeVisible();
  await panel.getByRole("button", { name: "成员", exact: true }).click();
  await expect(page.getByTestId("team-members-tab")).toBeVisible({ timeout: 10_000 });
}

test.describe("团队右栏 · 成员子页", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  test("1. 「成员」子 Tab 可见并逐席位渲染（角色/主 Agent/状态）", async ({ page }) => {
    await resetPanelPrefs(page);
    await installMocks(page);
    await openMembersTab(page);

    const panel = page.getByTestId("task-panel");
    // 子 Tab 存在（概览/成员/渠道/记忆/统计）
    for (const name of ["概览", "成员", "渠道", "记忆", "统计"]) {
      await expect(panel.getByRole("button", { name, exact: true })).toBeVisible();
    }

    // 两个席位各一张卡
    const seats = page.getByTestId("members-tab-seat");
    await expect(seats).toHaveCount(2);

    // 第 1 张：主 Agent 标记 + 名字
    const first = page.locator(`[data-testid="members-tab-seat"][data-seat-id="${SEATS[0].id}"]`);
    await expect(first).toContainText(SEATS[0].alias);
    await expect(first.getByTestId("members-tab-main-badge")).toBeVisible();
    await expect(first).toContainText("项目经理");

    // 第 2 张：非主 Agent（没有「设为主」以外的标记），带自己的模型/节点
    const second = page.locator(`[data-testid="members-tab-seat"][data-seat-id="${SEATS[1].id}"]`);
    await expect(second).toContainText(SEATS[1].alias);
    await expect(second.getByTestId("members-tab-main-badge")).toHaveCount(0);

    // 配置控件齐全（模型 + 节点）
    await expect(first.getByTestId(`members-tab-model-${SEATS[0].id}`)).toBeVisible();
    await expect(first.getByTestId(`members-tab-worker-${SEATS[0].id}`)).toBeVisible();
  });

  test("2. 改模型/节点：PATCH 席位，选「跟随团队」提交 null", async ({ page }) => {
    const log: Array<{ method: string; path: string; body: string | null }> = [];
    await resetPanelPrefs(page);
    await installMocks(page, { log });
    await openMembersTab(page);

    const seatId = SEATS[1].id;
    const seat = page.locator(`[data-testid="members-tab-seat"][data-seat-id="${seatId}"]`);

    // 模型：打开下拉，选 glm-5
    // 注意：触发按钮本身也含当前值文案，所以必须限定在「展开的面板内」点选，
    // 否则 getByRole(/glm-5/) 会同时命中触发器与选项（strict mode violation，实测踩过）。
    await seat.getByTestId(`members-tab-model-${seatId}`).click();
    await page
      .locator('[data-testid="members-tab-seat"]')
      .getByRole("button", { name: "zhipu · glm-5", exact: true })
      .click();
    await expect
      .poll(
        () =>
          log
            .filter((r) => r.method === "PATCH" && r.path === `/api/v1/teams/${TEAM_ID}/members/${seatId}`)
            .map((r) => r.body)
            .join("|"),
        { timeout: 10_000, message: "改模型应 PATCH 该席位" },
      )
      .toContain("md_other");
    expect(log.find((r) => r.method === "PATCH")?.body).toContain('"overrideModelId":"md_other"');

    // 「跟随团队」→ overrideModelId 提交 null（不是空串）
    await seat.getByTestId(`members-tab-model-${seatId}`).click();
    await seat.getByRole("button", { name: "跟随团队默认", exact: true }).last().click();
    await expect
      .poll(
        () =>
          log
            .filter((r) => r.method === "PATCH")
            .map((r) => r.body ?? "")
            .join("|"),
        { timeout: 10_000 },
      )
      .toContain('"overrideModelId":null');

    // 节点：选离线节点也应可配（软引用，纯配置不阻断）
    await seat.getByTestId(`members-tab-worker-${seatId}`).click();
    await seat.getByRole("button", { name: "keta-archive（离线）", exact: true }).click();
    await expect
      .poll(
        () =>
          log
            .filter((r) => r.method === "PATCH")
            .map((r) => r.body ?? "")
            .join("|"),
        { timeout: 10_000, message: "改节点应 PATCH 该席位" },
      )
      .toContain('"preferredWorkerId":"w_off"');
  });

  test("3. 添加成员：只列未入队的成员，POST /teams/:id/members", async ({ page }) => {
    const log: Array<{ method: string; path: string; body: string | null }> = [];
    await resetPanelPrefs(page);
    await installMocks(page, { log });
    await openMembersTab(page);

    await page.getByTestId("members-tab-add").click();
    const addPanel = page.getByTestId("members-tab-add-panel");
    await expect(addPanel).toBeVisible();

    // 候选里只有「测试丙」（另两位已在团队，被排除）
    const candidates = page.getByTestId("members-tab-add-candidate");
    await expect(candidates).toHaveCount(1);
    await expect(candidates.first()).toContainText("测试丙");

    // 未选成员时不可提交
    await expect(page.getByTestId("members-tab-add-confirm")).toBeDisabled();

    await candidates.first().click();
    await page.getByTestId("members-tab-add-alias").fill("测试-小组长");
    await expect(page.getByTestId("members-tab-add-confirm")).toBeEnabled();
    await page.getByTestId("members-tab-add-confirm").click();

    // 只打 team members 端点，且 body 带 memberId + alias
    await expect
      .poll(
        () =>
          log
            .filter((r) => r.method === "POST" && r.path === `/api/v1/teams/${TEAM_ID}/members`)
            .map((r) => r.body ?? "")
            .join("|"),
        { timeout: 10_000 },
      )
      .toContain("mbr_qa");
    const post = log.find((r) => r.method === "POST" && r.path === `/api/v1/teams/${TEAM_ID}/members`);
    expect(post?.body).toContain("测试-小组长");
    // 绝不应调用「新建平台成员」
    expect(log.some((r) => r.method === "POST" && r.path === "/api/v1/members")).toBe(false);
  });

  test("4. 移除 = 踢出团队：只 DELETE team members，绝不 DELETE /members/:id", async ({ page }) => {
    const log: Array<{ method: string; path: string; body: string | null }> = [];
    await resetPanelPrefs(page);
    await installMocks(page, { log });
    await openMembersTab(page);

    const seatId = SEATS[1].id;
    await page.getByTestId(`members-tab-kick-${seatId}`).click();

    // 确认弹窗：文案必须说明「移出团队 / 不删成员」
    const dialog = page.getByTestId("members-tab-kick-confirm-modal");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("移出团队");
    await expect(dialog).toContainText("平台成员记录不会被删除");

    await page.getByTestId("members-tab-kick-confirm-confirm").click();

    // ★ 只允许席位级 DELETE
    await expect
      .poll(
        () =>
          log
            .filter((r) => r.method === "DELETE")
            .map((r) => r.path)
            .join(","),
        { timeout: 10_000, message: "移除应走 DELETE /teams/:id/members/:seatId" },
      )
      .toContain(`/api/v1/teams/${TEAM_ID}/members/${seatId}`);

    const deletes = log.filter((r) => r.method === "DELETE").map((r) => r.path);
    // ★ 核心不变量：不得出现平台成员删除（DELETE /members/<id>）
    expect(
      deletes.filter((p) => /^\/api\/v1\/members\/[^/]+$/.test(p)),
      `移除不能删除平台成员，实际 DELETE: ${deletes.join(", ")}`,
    ).toEqual([]);

    // 弹窗关闭，并且在**当前（成员）子页**就能看到操作反馈——
    // 旧实现把提示塞进只在概览子页渲染的状态里，踢完一点反馈都没有。
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("team-subtab-notice")).toContainText("已将该成员移出团队");
  });

  test("5. 取消踢出：不发任何 DELETE", async ({ page }) => {
    const log: Array<{ method: string; path: string; body: string | null }> = [];
    await resetPanelPrefs(page);
    await installMocks(page, { log });
    await openMembersTab(page);

    await page.getByTestId(`members-tab-kick-${SEATS[0].id}`).click();
    await expect(page.getByTestId("members-tab-kick-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("members-tab-kick-confirm-cancel").click();
    await expect(page.getByTestId("members-tab-kick-confirm-modal")).toHaveCount(0);

    expect(log.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  test("7. 视觉证据：成员子页整页截图", async ({ page }) => {
    await resetPanelPrefs(page);
    await installMocks(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openMembersTab(page);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(process.cwd(), "..", "e2e-evidence", "team-members-tab.png"),
    });
    await page.getByTestId(`members-tab-kick-${SEATS[1].id}`).click();
    await expect(page.getByTestId("members-tab-kick-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(process.cwd(), "..", "e2e-evidence", "team-members-tab-kick-confirm.png"),
    });
    await page.getByTestId("members-tab-kick-confirm-cancel").click();
  });

  test("6. 空团队：显示空态且添加入口可达", async ({ page }) => {
    await resetPanelPrefs(page);
    await installMocks(page, { team: () => teamFixture([]) });
    await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
    await expect(page.getByTestId("task-panel")).toBeVisible({ timeout: 20_000 });
    const panel = page.getByTestId("task-panel");
    await panel.getByRole("button", { name: "团队", exact: true }).click();
    await panel.getByRole("button", { name: "成员", exact: true }).click();

    await expect(page.getByTestId("members-tab-empty")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("members-tab-add")).toBeVisible();
  });
});
