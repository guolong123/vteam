import { test, expect, type Page } from "@playwright/test";

/**
 * no-agent-picker Todo 2 · agent 选择器移除回归
 * ============================================================
 * 覆盖 37a1b0c（refactor(web): remove agent picker from message input）：
 * 1. 选择器消失：会话页输入区无 `message-agent-select` testid，全页零 `<select>`
 *   （message-input.tsx 的选择器渲染块 + 4 props 已删；唯一调用方即此页）。
 * 2. `@` 提及可用：输入 `@` 弹出候选（含计划员-1），点击插入 `@名称 `。
 * 3. 发送可用：POST /channels/:id/messages 走 mock fulfill（探针永不落库，
 *    共享频道零残留），消息渲染 + 输入清空 + console/pageerror 零错误。
 * 4. 计划员可达（API，不触发真实 LLM 执行）：GET /teams/tm_0000000001
 *    成员含 tmm_0000000006（计划员-1）且成员行保留 opencodeAgentName 键。
 *
 * M6 边界（third-party-agent-display Todo 3，review fix M6）：
 * ---------------------------------------------------------------
 * 保证被缩窄到它本来的范围：**会话页 / 消息输入区**永远零 picker（测试 1 原样保留）。
 * 团队详情页（`/teams/[id]`，成员管理设置面）是外部 Agent 选择器的**唯一合法宿主**：
 * third-party-agent-display Todo 3 恢复了 `member-external-agent-select`，位置是
 * 设置面而非消息输入。测试 5 把这条边界钉成机器可检的断言（允许设置面，但仅此一处）。
 * 不得对团队详情页断言零 `<select>`，也不得删除测试 1 的消息输入区保证。
 *
 * 方法：POST 发送类一律拦截 mock；GET 消息列表 mock（种子 1 条 + 发送后回显
 * 探针）；其余 /api/v1/* route.fallback 走真实后端只读（含团队/成员/SSE）。
 * 运行（仓库根）：`bash scripts/e2e-no-agent-picker.sh`（独立 tmp config，
 * 不碰 playwright.config.ts；baseURL 指向 compose web :13001）。
 */

const TEAM_ID = "tm_0000000001";
const PLAN_MEMBER_ID = "tmm_0000000006";
const SERVER_URL = "http://localhost:13000";
const PROBE_TEXT = "e2e-no-agent-picker probe (mocked, never persisted)";

const iso = "2026-09-14T10:00:00.000Z";

function dto(id: string, text: string) {
  return {
    id,
    channelId: "ch_group",
    senderType: "user",
    senderId: "u_admin",
    senderInstanceId: null,
    content: { text, parts: [] },
    mentions: [],
    attachmentUrl: null,
    attachmentName: null,
    attachmentType: null,
    status: "sent",
    createdAt: iso,
  };
}

/** 安装 mock；POST 发送永不落库（fulfill 回显），返回 POST 记录器。 */
async function installMocks(page: Page, state: { probeSent: boolean }) {
  const posted: { method: string; path: string; text: string }[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const apiPath = url.pathname.replace(/^\/api\/v1/, "") || "/";
    const method = req.method();
    if (method === "POST" && /\/channels\/.+\/messages$/.test(apiPath)) {
      const body = JSON.parse(req.postData() || "{}") as { text?: string };
      state.probeSent = true;
      posted.push({ method, path: apiPath, text: body.text ?? "" });
      return route.fulfill({ json: dto("m_probe", body.text ?? "") });
    }
    if (method === "GET" && /\/channels\/.+\/messages/.test(apiPath)) {
      return route.fulfill({
        json: {
          items: [
            dto("m_seed", "种子历史：方案先行"),
            ...(state.probeSent ? [dto("m_probe", PROBE_TEXT)] : []),
          ],
          nextCursor: null,
        },
      });
    }
    return route.fallback();
  });
  return posted;
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
}

test.describe("no-agent-picker 选择器移除回归", () => {
  test("1. 选择器消失：无 testid、无 select", async ({ page }) => {
    await loginAsAdmin(page);
    await installMocks(page, { probeSent: false });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    // 输入区存在（回归锚点：删的是选择器，不是整个输入块）
    await expect(page.getByTestId("message-input")).toBeVisible();
    await expect(page.getByTestId("message-input-send")).toBeVisible();
    // 断言本体：残留 testid 与全页 <select> 均为零（M6 保证被缩窄到会话页）
    await expect(page.getByTestId("message-agent-select")).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);
    // 反向探针：外部 Agent 选择器不得出现在会话页任何位置（含成员面板）
    await expect(page.getByTestId("member-external-agent-select")).toHaveCount(0);
  });

  test("2. @ 可用：候选含计划员-1，点击插入", async ({ page }) => {
    await loginAsAdmin(page);
    await installMocks(page, { probeSent: false });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const input = page.getByTestId("message-input");
    await input.click();
    await input.pressSequentially("@", { delay: 30 });
    const box = page.getByTestId("message-input-mentions");
    await expect(box).toBeVisible({ timeout: 10_000 });
    await expect(box.getByText("计划员-1")).toBeVisible();
    await box.getByText("计划员-1").click();
    await expect(input).toHaveValue(/@计划员-1 /);
  });

  test("3. 发送可用：探针渲染 + 输入清空 + 零 console 错误", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    await loginAsAdmin(page);
    const posted = await installMocks(page, { probeSent: false });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    const input = page.getByTestId("message-input");
    await input.fill(PROBE_TEXT);
    await page.getByTestId("message-input-send").click();
    // POST 真实发出（被 mock 吞掉，永不落库）
    await expect
      .poll(() => posted.length, { timeout: 10_000 })
      .toBe(1);
    expect(posted[0].text).toBe(PROBE_TEXT);
    // 渲染 + 输入清空
    await expect(
      page.getByTestId("chat-message-list").getByText(PROBE_TEXT).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue("");
    expect(errors).toEqual([]);
  });

  test("4. 计划员可达：团队成员含 tmm_0000000006 且保留 opencodeAgentName（无 LLM 执行）", async ({
    request,
  }) => {
    const login = await request.post(`${SERVER_URL}/api/v1/auth/login`, {
      data: { username: "admin", password: "admin123" },
    });
    expect(login.ok()).toBeTruthy();
    const { accessToken } = (await login.json()) as { accessToken: string };
    const team = await request.get(`${SERVER_URL}/api/v1/teams/${TEAM_ID}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(team.ok()).toBeTruthy();
    const body = (await team.json()) as {
      members: { id: string; alias: string }[];
    };
    const member = body.members.find((m) => m.id === PLAN_MEMBER_ID);
    expect(member).toBeTruthy();
    expect(member!.alias).toContain("计划员");
    // buildTeamMemberTrigger 按 (teamId, memberId) 定位成员（worker-dispatcher.ts:1290）：
    // 成员存在即触发链可达；opencodeAgentName 键保留即回退链载体未动。
    expect("opencodeAgentName" in member!).toBe(true);
  });

  // M6：设置面是外部 Agent 选择器的唯一合法宿主——边界显式化 + 机器可检。
  test("5. 边界：设置面（团队详情页）允许 member-external-agent-select，会话页不渲染它", async ({
    page,
  }) => {
    await loginAsAdmin(page);

    // 设置面：团队详情页 IS the sanctioned host
    await page.goto(`/teams/${TEAM_ID}`);
    await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 15_000 });
    const picker = page.getByTestId("member-external-agent-select");
    await expect(picker.first()).toBeVisible({ timeout: 15_000 });
    expect(await picker.count()).toBeGreaterThan(0);
    // 该设置面的选择器必须来自引擎清单（非硬编码）：至少含一个 option
    expect(await picker.first().locator("option").count()).toBeGreaterThan(1);

    // 会话页：同一 testid 零出现（保证缩窄到消息输入区，不泄漏到会话路由）
    await installMocks(page, { probeSent: false });
    await page.goto(`/teams/${TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("member-external-agent-select")).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);
  });
});
