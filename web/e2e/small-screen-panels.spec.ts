import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";

/**
 * 小屏适配回归（2026-11-18 用户反馈）
 * =============================================
 * 两条用户诉求，各锁一组断言：
 *
 * 1. **左右两侧工具栏要支持收起展示，支持拖拽调整大小**
 *    - `/chat` 左会话列表：`conversation-list-gutter` 内可拖拽（拖后宽度变、
 *      localStorage 落盘、刷新后保持）；`-collapse` 收起 → 列表消失 +
 *      `conversation-list-rail` 出现 → 点恢复条回到展开；
 *    - 右栏（任务面板 / 群信息 / 成员信息）同一套：`task-panel-gutter` /
 *      `task-panel-rail`，并验证键盘 ←/→ 也能调宽度（触屏/无鼠标场景）；
 *    - **小屏默认收起**：900px 视口首次进入（清空 localStorage）左侧恢复条即在，
 *      中间聊天区拿到宽度；1280px 视口默认两块都展开（不破坏既有大屏习惯）。
 *
 * 2. **弹窗时点不到确认按钮 → 需要能滑动下拉到按钮**
 *    - 敏感输入弹窗用「超长模板 + 多个变量」把内容撑到远超视口；
 *    - 断言 `question-secret-submit` 在 900x600 视口内**可见且可点击**
 *      （旧实现：卡片随内容长高、按钮被挤出宿主容器 → 不可见 / 点击超时）；
 *    - 断言主体区 `question-modal-body` 自身可滚（scrollHeight > clientHeight），
 *      且滚动后仍能提交；卡片底边不超出视口（按钮常驻底部而不是被滚走）。
 *
 * 全 route-mock，零后端接触（与 group-member-panel.spec.ts 同一套夹具风格）。
 */

const TEAM_ID = "tm_0000000001";
const CHANNEL_ID = "c_0000000001";
const TASK_ID = "t_0000000001";
const SEAT_ID = "tmm_0000000002";
const iso = "2026-11-18T03:00:00.000Z";

/** 小屏（用户截图里那种笔记本窗口） */
const NARROW = { width: 900, height: 620 };
/** 标准桌面（既有习惯，不应被小屏默认值影响） */
const WIDE = { width: 1280, height: 900 };

const SEATS = [
  { id: "tmm_0000000001", alias: "林一架", agent: "架构师", role: "architect" },
  { id: SEAT_ID, alias: "周一项", agent: "项目经理", role: "product_manager" },
  { id: "tmm_0000000003", alias: "文一知", agent: "文档", role: "doc_writer" },
];

function teamFixture() {
  return {
    id: TEAM_ID,
    name: "e2e 小屏团队",
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
      sessionStatus: { busyState: "idle", busySince: null, lastTurnOutcome: null, lastActivityAt: null },
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
    mainAgentMemberId: SEAT_ID,
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
      main: s.id === SEAT_ID,
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

/** 超长命令模板：目的就是让弹窗内容远远高过 620px 视口。 */
const LONG_TEMPLATE = [
  "python3 - <<'PY'",
  "import json,os,urllib.request",
  "pw='{{CRM_PASSWORD}}'",
  "os.makedirs('/tmp/opencode/login',exist_ok=True)",
  "p='/tmp/opencode/login/pw'",
  "fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)",
  ""
].concat(Array.from({ length: 22 }, (_, i) => `payload_${i + 1} = "placeholder-${i + 1}"; os.write(fd, payload_${i + 1}.encode())`))
  .concat([
    "os.close(fd)",
    "req=urllib.request.Request('https://crm.example.com/api/login')",
    "with urllib.request.urlopen(req) as r:",
    "    print(r.status)",
    "PY"
  ])
  .join("\n");

/** pending secret_input（GET /questions 补拉形状，server dto 同形）。 */
function secretQuestion() {
  return {
    id: "aq_narrow_1",
    requestId: "req_narrow_1",
    kind: "secret_input",
    sessionId: "ses_narrow",
    managedMode: false,
    taskId: null,
    agentId: null,
    status: "pending",
    content: {
      source: "secret_input",
      template: LONG_TEMPLATE,
      reason:
        "需要登录 crm-test5 复核工号 03181 的密码。仅注入本机受限文件并直接用于登录接口，" +
        "不会在回执、日志、群聊或证据中打印明文。用途：登录后执行供应商转合格复核（只读 + 单次提交）。"
        + "补充说明：".padEnd(1) + Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段说明文字用于把弹窗内容撑高。`).join(""),
      variables: [
        { name: "CRM_PASSWORD", secret: true },
        { name: "CRM_USER", secret: false },
        { name: "CRM_REGION", secret: false },
      ],
    },
  };
}

async function installMocks(page: Page): Promise<void> {
  // 兜底：未显式 mock 的接口给空分页，避免 401 触发全局登出跳落地页
  await page.route("**/api/v1/**", (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0, page: 1, pageSize: 100 }),
    }),
  );
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
            title: "e2e 小屏团队",
            badge: "群",
            channelId: CHANNEL_ID,
            contextTeamId: TEAM_ID,
            memberCount: SEATS.length,
            unreadCount: 0,
            pinned: false,
            processing: false,
            lastMessage: { text: "小屏适配回归", createdAt: iso },
          },
        ],
        total: 1,
      },
    }),
  );
  await page.route((url) => url.pathname === `/api/v1/teams/${TEAM_ID}`, (route) =>
    route.fulfill({ json: teamFixture() }),
  );
  await page.route((url) => url.pathname === `/api/v1/tasks/${TASK_ID}`, (route) =>
    route.fulfill({ json: taskFixture() }),
  );
  await page.route((url) => url.pathname === "/api/v1/tasks", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: TASK_ID,
            title: "e2e 任务",
            status: "in_progress",
            createdAt: iso,
            startedAt: iso,
            pendingReviewAt: null,
            completedAt: null,
          },
        ],
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
  await page.route((url) => url.pathname === `/api/v1/channels/${CHANNEL_ID}/messages`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "m_1",
            channelId: CHANNEL_ID,
            senderType: "agent",
            senderId: "a_product_manager",
            senderInstanceId: SEAT_ID,
            content: { text: "小屏适配回归用例消息", parts: [{ type: "text", text: "小屏适配回归用例消息" }] },
            mentions: [],
            status: "sent",
            createdAt: iso,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route((url) => url.pathname === `/api/v1/channels/${CHANNEL_ID}/session-history`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
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
  await page.route("**/api/v1/triggers**", (route) =>
    route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }),
  );
  await page.route("**/api/v1/questions**", (route) =>
    route.fulfill({ json: [] }),
  );
}

/** 进入群聊会话页并等骨架就绪。 */
async function openGroupChat(page: Page): Promise<void> {
  await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
  await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
}

/**
 * 清空本页相关的面板偏好，模拟「用户第一次来」。
 * 只在**首次导航**清一次（用 sessionStorage 打标）：否则 page.reload() 时
 * initScript 会把刚拖出来的宽度又抹掉，「刷新后保持」就永远断言不上。
 */
async function resetPanelPrefs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      if (window.sessionStorage.getItem("__panel_prefs_reset") === "1") return;
      window.sessionStorage.setItem("__panel_prefs_reset", "1");
      for (const key of [
        "chat-conversation-list-width",
        "chat-conversation-list-width-collapsed",
        "chat-right-panel-width",
        "chat-right-panel-width-collapsed",
        "team-session-right-width",
        "team-session-right-width-collapsed",
        "team-session-members-width",
        "team-session-members-width-collapsed",
      ]) {
        window.localStorage.removeItem(key);
      }
    } catch {
      // ignore
    }
  });
}

test.describe("小屏适配：面板收起/拖拽 + 弹窗按钮可达", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  test("1. 小屏首次进入：左右面板默认收起，中间聊天区拿到宽度", async ({ page }) => {
    await resetPanelPrefs(page);
    await page.setViewportSize(NARROW);
    await installMocks(page);
    await openGroupChat(page);

    // 左会话列表：收起态（恢复条在，列表不在），且可见
    await expect(page.getByTestId("conversation-list-rail")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("conversation-list-panel")).toHaveCount(0);

    // 右任务面板：同样默认收起
    await expect(page.getByTestId("task-panel-rail")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("task-panel")).toHaveCount(0);

    // 中间消息区拿到剩余宽度：比「两块面板都展开」时宽得多（>500px 于 900 视口）
    const list = page.getByTestId("chat-message-list");
    await expect(list).toBeVisible();
    const box = await list.boundingBox();
    expect(box, "消息列表应可见").not.toBeNull();
    expect(box!.width, "900px 视口下，左右收起后聊天区应拿到大部分宽度").toBeGreaterThan(500);

    // 恢复条可见且能点开
    await page.getByTestId("conversation-list-rail").getByRole("button").click();
    await expect(page.getByTestId("conversation-list-panel")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("conversation-list-rail")).toHaveCount(0);
  });

  test("2. 大屏首次进入：左右面板默认展开（不改变既有习惯）", async ({ page }) => {
    await resetPanelPrefs(page);
    await page.setViewportSize(WIDE);
    await installMocks(page);
    await openGroupChat(page);

    await expect(page.getByTestId("conversation-list-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("conversation-list-rail")).toHaveCount(0);
    await expect(page.getByTestId("task-panel")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("task-panel-rail")).toHaveCount(0);
  });

  test("3. 左会话列表：拖拽改宽 + 刷新后保持 + 收起再展开", async ({ page }) => {
    await resetPanelPrefs(page);
    await page.setViewportSize(WIDE);
    await installMocks(page);
    await openGroupChat(page);

    const panel = page.getByTestId("conversation-list-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const before = (await panel.boundingBox())!.width;

    // 拖右缘分隔条：向右 80px
    const handle = page.getByTestId("conversation-list-gutter").getByTestId("panel-resize-handle");
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 80, hb.y + hb.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await panel.boundingBox())?.width ?? 0, { timeout: 5000, message: "拖拽后宽度应变化" })
      .toBeGreaterThan(before + 40);

    const afterDrag = (await panel.boundingBox())!.width;
    // 宽度落盘（刷新保持）
    const stored = await page.evaluate(() => window.localStorage.getItem("chat-conversation-list-width"));
    expect(Number(stored), "拖拽结束应持久化宽度").toBeGreaterThan(before);

    await page.reload();
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => (await page.getByTestId("conversation-list-panel").boundingBox())?.width ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(Math.round(afterDrag) - 4);

    // 收起 → 恢复条 → 展开
    await page.getByTestId("conversation-list-gutter-collapse").click();
    await expect(page.getByTestId("conversation-list-rail")).toBeVisible();
    await expect(page.getByTestId("conversation-list-panel")).toHaveCount(0);
    await page.getByTestId("conversation-list-rail").getByRole("button").click();
    await expect(page.getByTestId("conversation-list-panel")).toBeVisible();
  });

  test("4. 右任务面板：键盘 ←/→ 调宽 + 收起后恢复条可展开", async ({ page }) => {
    await resetPanelPrefs(page);
    await page.setViewportSize(WIDE);
    await installMocks(page);
    await openGroupChat(page);

    const panel = page.getByTestId("task-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const before = (await panel.boundingBox())!.width;

    // 焦点到分隔条，按 ArrowLeft（右面板向左 = 变宽）
    const handle = page.getByTestId("task-panel-gutter").getByTestId("panel-resize-handle");
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => (await page.getByTestId("task-panel").boundingBox())?.width ?? 0, { timeout: 5000 })
      .toBeGreaterThan(before + 20);

    // 收起 → 只剩恢复条；点开恢复
    await page.getByTestId("task-panel-gutter-collapse").click();
    await expect(page.getByTestId("task-panel-rail")).toBeVisible();
    await expect(page.getByTestId("task-panel")).toHaveCount(0);
    await page.getByTestId("task-panel-rail").getByRole("button").click();
    await expect(page.getByTestId("task-panel")).toBeVisible({ timeout: 10_000 });
  });

  test("5. 小屏敏感输入弹窗：「确认」按钮在视口内可点（旧实现点不到）", async ({ page }) => {
    await resetPanelPrefs(page);
    await page.setViewportSize(NARROW);
    await installMocks(page);
    // 在进入页面后再换 pending 列表，保证 questions 补拉命中
    await page.route((url) => url.pathname === "/api/v1/questions", (route) =>
      route.fulfill({ json: [secretQuestion()] }),
    );
    await openGroupChat(page);

    const modal = page.getByTestId("question-modal");
    await expect(modal).toBeVisible({ timeout: 20_000 });

    // 模板确实很长（说明这条用例真的覆盖了「内容超高」的场景）
    const template = page.getByTestId("question-secret-template");
    await expect(template).toHaveValue(LONG_TEMPLATE);
    await expect(page.getByTestId("question-secret-input-0")).toBeVisible();

    // ★ 核心断言：确认按钮在视口内可见（旧实现被顶出容器 → not visible）
    const submit = page.getByTestId("question-secret-submit");
    await expect(submit).toBeVisible();
    const box = (await submit.boundingBox())!;
    expect(box.y, "确认按钮应在视口内（不被卡片内容挤出可视区）").toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, "确认按钮底边不应超出视口").toBeLessThanOrEqual(NARROW.height);

    // 主体区自身可滚（而不是整页/整层被锁死）
    const body = page.getByTestId("question-modal-body");
    const metrics = await body.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(metrics.overflowY, "主体区应可滚动").toBe("auto");
    expect(metrics.scrollHeight, "长内容应产生滚动空间").toBeGreaterThan(metrics.clientHeight);

    // 滚动到主体底部后仍可提交（按钮不随内容滚走）
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(submit).toBeVisible();

    // 填完变量 → 确认按钮启用 → 点击成功（提交请求被 mock 接收）
    await page.getByTestId("question-secret-input-0").fill("e2e-secret");
    await page.getByTestId("question-secret-input-1").fill("e2e-user");
    await page.getByTestId("question-secret-input-2").fill("cn-north");
    await expect(submit).toBeEnabled();
    await submit.click();

    // 提交后弹窗关闭（队列里没有下一条）
    await expect(modal).toHaveCount(0, { timeout: 10_000 });
  });
});
