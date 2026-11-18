import { test, expect, type Page, type Route } from "@playwright/test";
import path from "node:path";

/**
 * small-screen-panels 视觉证据（非断言型，仅落截图到 e2e-evidence/）
 * =============================================
 * 覆盖四张对照图：
 *  1. 900px 小屏首次进入：左右面板默认收起，聊天区拿到宽度；
 *  2. 900px 同一页面：左侧展开（点恢复条）+ 右侧面板收起 → 中间更宽；
 *  3. 1280px 桌面：两块面板都展开（既有习惯不变）；
 *  4. 900x600 小屏敏感输入弹窗：长模板 + 3 个变量，「取消 / 确认」常驻可见。
 *
 * 跑法：npx playwright test --project=small-screen-evidence
 */

const TEAM_ID = "tm_0000000001";
const CHANNEL_ID = "c_0000000001";
const TASK_ID = "t_0000000001";
const SEAT_ID = "tmm_0000000002";
const iso = "2026-11-18T03:00:00.000Z";
const OUT_DIR = path.join(process.cwd(), "..", "e2e-evidence");

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
    title: "缺陷 0128 重新验证 · 供应商转合格复核",
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

const LONG_TEMPLATE = [
  "python3 - <<'PY'",
  "import json,os,urllib.request",
  "pw='{{CRM_PASSWORD}}'",
  "os.makedirs('/tmp/opencode/login',exist_ok=True)",
  "p='/tmp/opencode/login/pw'",
  "fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)",
  ""
]
  .concat(Array.from({ length: 18 }, (_, i) => `payload_${i + 1} = "placeholder-${i + 1}"; os.write(fd, payload_${i + 1}.encode())`))
  .concat([
    "os.close(fd)",
    "req=urllib.request.Request('https://crm-test5.example.com/api/login')",
    "with urllib.request.urlopen(req) as r:",
    "    print(r.status)",
    "PY",
  ])
  .join("\n");

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
        "需要 crm-test5 工号 03181 的密码，仅注入本机受限文件并直接用于登录接口，" +
        "不会在回执、日志、群聊或证据中打印明文。用途：登录后执行供应商转合格复核（只读 + 单次提交）。",
      variables: [
        { name: "CRM_PASSWORD", secret: true },
        { name: "CRM_USER", secret: false },
        { name: "CRM_REGION", secret: false },
      ],
    },
  };
}

async function installMocks(page: Page, withQuestion = false): Promise<void> {
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
            title: "测试团队",
            badge: "群",
            channelId: CHANNEL_ID,
            contextTeamId: TEAM_ID,
            memberCount: SEATS.length,
            unreadCount: 0,
            pinned: false,
            processing: false,
            lastMessage: { text: "测试3 正在本群处理消息", createdAt: iso },
          },
          {
            id: "dm:m_2",
            type: "dm",
            title: "dslt-team2",
            badge: "成员",
            channelId: "c_dm",
            contextTeamId: TEAM_ID,
            memberCount: 1,
            unreadCount: 5,
            pinned: false,
            processing: false,
            lastMessage: { text: "连通性确认结论", createdAt: iso },
          },
        ],
        total: 2,
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
            title: "缺陷 0128 重新验证",
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
            content: {
              text:
                "复验记录已收到并核过（art_0000000419/0420，结论=阻塞 前置不满足：无登录态），" +
                "已回填 issue is_0000000128，未做任何升降级。执行方式是对的：没猜口令、没反复登录、零提交零脏数据。" +
                "下一步：走安全通道拿口令，不要猜、不要试。",
              parts: [
                {
                  type: "text",
                  text:
                    "复验记录已收到并核过（art_0000000419/0420，结论=阻塞 前置不满足：无登录态），" +
                    "已回填 issue is_0000000128，未做任何升降级。执行方式是对的：没猜口令、没反复登录、零提交零脏数据。" +
                    "下一步：走安全通道拿口令，不要猜、不要试。",
                },
              ],
            },
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
  await page.route((url) => url.pathname === "/api/v1/questions", (route) =>
    route.fulfill({ json: withQuestion ? [secretQuestion()] : [] }),
  );
}

/**
 * 只清面板偏好键。
 * 不能用 localStorage.clear()：登录态（agent-platform-auth）也在 localStorage，
 * 清空后页面守卫会直接跳 /login，截图全变成登录页（实测踩过）。
 */
const PANEL_KEYS = [
  "chat-conversation-list-width",
  "chat-conversation-list-width-collapsed",
  "chat-right-panel-width",
  "chat-right-panel-width-collapsed",
  "team-session-right-width",
  "team-session-right-width-collapsed",
  "team-session-members-width",
  "team-session-members-width-collapsed",
];

async function resetPrefs(page: Page): Promise<void> {
  await page.addInitScript((keys) => {
    try {
      for (const key of keys) window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }, PANEL_KEYS);
}

test.describe("小屏适配视觉证据", () => {
  test.use({ storageState: path.join(process.cwd(), ".auth", "user.json") });

  test("1. 900px：左右面板默认收起", async ({ page }) => {
    await resetPrefs(page);
    await page.setViewportSize({ width: 900, height: 620 });
    await installMocks(page);
    await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
    await expect(page.getByTestId("conversation-list-rail")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-panel-rail")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, "small-screen-900-collapsed.png") });
  });

  test("2. 900px：左展开 + 右收起", async ({ page }) => {
    await resetPrefs(page);
    await page.setViewportSize({ width: 900, height: 620 });
    await installMocks(page);
    await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
    await page.getByTestId("conversation-list-rail").getByRole("button").click();
    await expect(page.getByTestId("conversation-list-panel")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, "small-screen-900-left-open.png") });
  });

  test("3. 1280px：默认两块都展开", async ({ page }) => {
    await resetPrefs(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await installMocks(page);
    await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
    await expect(page.getByTestId("conversation-list-panel")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("task-panel")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT_DIR, "small-screen-1280-default.png") });
  });

  test("4. 900x600 敏感输入弹窗：按钮常驻可见", async ({ page }) => {
    await resetPrefs(page);
    await page.setViewportSize({ width: 900, height: 600 });
    await installMocks(page, true);
    await page.goto(`/chat?c=${encodeURIComponent(`group:${TEAM_ID}`)}`);
    const modal = page.getByTestId("question-modal");
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("question-secret-input-0").fill("placeholder");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, "small-screen-600-secret-modal.png") });
    await expect(page.getByTestId("question-secret-submit")).toBeVisible();
  });
});
