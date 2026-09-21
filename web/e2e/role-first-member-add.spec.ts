import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

/**
 * opencode-native-permissions-and-fixes · task-14 · role-first member add（web 切片）
 * ================================================================================
 * 对 live compose stack（web :13001 + server :13000；admin/admin123）证明三件事：
 *
 *  (a) ROLE-first：只给 roleId 的成员创建——团队创建（POST /teams）与团队详情页
 *      「添加成员」两条入口——落库 `agentId === 角色绑定的 defaultAgentId`
 *      （服务端规则 2 预填），且浏览器请求体**不含 agentId**（role-only）。
 *  (b) 外部绑定角色（`defaultOpencodeAgentName`，如 `Prometheus - Plan Builder`）：
 *      详情页岗位下拉可选中（选项文案带「（外部）」）→ 出现外部提示与「执行 Agent」
 *      槽位 → 未选执行 Agent 时确认被守卫拦下（错误可见、零请求发出）→ 选定内部
 *      执行 Agent 后成员落库 `opencodeAgentName === 外部名`（规则 5）且
 *      `agentId === 执行 Agent`；reload 后新增成员行仍可见、API 回读逐字段一致。
 *  (c) 会话页 `/teams/tm_0000000001/session` 仍零 `<select>`、零 `message-agent-select`
 *      （no-agent-picker 的会话页保证不破）。
 *
 * 一次性 team/role 全部在 finally 里 DELETE（先 team 后 role，防角色 in-use 409）；
 * 不留任何 fixture。运行：web 下临时 config（同 scripts/e2e-roles-members.sh 模式），
 * baseURL 指向 compose web :13001，channel=chrome。
 */

const SERVER_URL = "http://localhost:13000";
const SEED_TEAM_ID = "tm_0000000001";
const RUN_TAG = `t14-${Date.now().toString(36)}`;
/** 任务要求举例的外部引擎名；实时清单里存在则用精确名，否则取首个可选项。 */
const EXTERNAL_PREFERRED = "Prometheus - Plan Builder";

interface AgentRole {
  id: string;
  key: string;
  name: string;
  type: string;
  defaultAgentId: string | null;
  defaultOpencodeAgentName: string | null;
}

interface TeamMember {
  id: string;
  agentId: string;
  roleId: string | null;
  alias: string;
  opencodeAgentName: string | null;
}

interface TeamDto {
  id: string;
  name: string;
  members: TeamMember[];
}

interface OpencodeAgentEntry {
  name: string;
  mode: string;
  governed: boolean;
  hidden?: boolean;
}

interface AgentItem {
  id: string;
  name: string;
  role: string;
  type: string;
}

function authHeaders(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("username").fill("admin");
  await page.getByTestId("password").fill("admin123");
  await page.getByTestId("login-button").click();
  await expect(page).toHaveURL(/\/teams/, { timeout: 15_000 });
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await request.post(`${SERVER_URL}/api/v1/auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(login.ok()).toBeTruthy();
  return ((await login.json()) as { accessToken: string }).accessToken;
}

async function createTeam(
  request: APIRequestContext,
  token: string,
  payload: { name: string; members?: { roleId?: string; agentId?: string }[] },
): Promise<TeamDto> {
  const res = await request.post(`${SERVER_URL}/api/v1/teams`, {
    headers: authHeaders(token),
    data: payload,
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as TeamDto;
}

async function getTeam(
  request: APIRequestContext,
  token: string,
  teamId: string,
): Promise<TeamDto> {
  const res = await request.get(`${SERVER_URL}/api/v1/teams/${teamId}`, {
    headers: authHeaders(token),
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as TeamDto;
}

async function createRole(
  request: APIRequestContext,
  token: string,
  payload: {
    name: string;
    key: string;
    defaultAgentId?: string;
    defaultOpencodeAgentName?: string;
  },
): Promise<AgentRole> {
  const res = await request.post(`${SERVER_URL}/api/v1/agent-roles`, {
    headers: authHeaders(token),
    data: { type: "custom", ...payload },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as AgentRole;
}

/** 实时外部引擎清单（!governed && !hidden && 非 subagent）；degraded/空 → 调用方 skip。 */
async function engineExternal(
  request: APIRequestContext,
  token: string,
): Promise<{ names: string[]; degraded: boolean }> {
  const res = await request.get(`${SERVER_URL}/api/v1/agents/opencode`, {
    headers: authHeaders(token),
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    agents: OpencodeAgentEntry[];
    degraded?: boolean;
  };
  return {
    degraded: !!body.degraded,
    names: body.agents
      .filter((a) => !a.governed && !a.hidden && a.mode !== "subagent")
      .map((a) => a.name),
  };
}

/** 执行 Agent 选择器里的内部模板 Agent（GET /agents 列表，供外部岗位必填槽位选值）。 */
async function internalAgentId(
  request: APIRequestContext,
  token: string,
  preferred = "a_developer",
): Promise<string> {
  const res = await request.get(`${SERVER_URL}/api/v1/agents`, {
    headers: authHeaders(token),
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: AgentItem[] };
  if (body.items.some((a) => a.id === preferred)) return preferred;
  const first = body.items.find((a) => a.type === "template");
  expect(first).toBeTruthy();
  return first!.id;
}

/** 记录浏览器发出的 POST /teams/:id/members 请求体（role-first 断言的原始证据）。 */
function recordMemberPosts(page: Page): { teamId: string; body: Record<string, unknown> }[] {
  const posts: { teamId: string; body: Record<string, unknown> }[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const m = new URL(req.url()).pathname.match(/^\/api\/v1\/teams\/([^/]+)\/members$/);
    if (!m) return;
    let body: Record<string, unknown> = {};
    try {
      body = ((req.postDataJSON() as Record<string, unknown> | null) ?? {}) as Record<
        string,
        unknown
      >;
    } catch {
      body = {};
    }
    posts.push({ teamId: m[1], body });
  });
  return posts;
}

/**
 * 清理一次性 fixture：DELETE 幂等（404 = 已删即达成），
 * 5xx（MySQL 写冲突/死锁等瞬时态）退避重试若干次，避免把噪声写进证据。
 * team 先删、role 后删：防角色被成员引用触发 409 AGENT_ROLE_IN_USE。
 */
async function deleteWithRetry(
  request: APIRequestContext,
  token: string,
  url: string,
  label: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const res = await request.delete(url, { headers: authHeaders(token) });
    const status = res.status();
    if (status < 400 || status === 404) {
      console.log(`[cleanup] ${label} DELETE -> ${status}`);
      return;
    }
    console.log(`[cleanup] ${label} DELETE -> ${status} (attempt ${attempt}/5, retrying)`);
    await new Promise((r) => setTimeout(r, 1_000 * attempt));
  }
  throw new Error(`[cleanup] ${label} DELETE 重试 5 次仍失败`);
}

async function cleanup(
  request: APIRequestContext,
  token: string,
  teamIds: string[],
  roleIds: string[],
) {
  for (const teamId of teamIds) {
    await deleteWithRetry(request, token, `${SERVER_URL}/api/v1/teams/${teamId}`, `team ${teamId}`);
  }
  for (const roleId of roleIds) {
    await deleteWithRetry(
      request,
      token,
      `${SERVER_URL}/api/v1/agent-roles/${roleId}`,
      `role ${roleId}`,
    );
  }
}

test.describe("task-14 · role-first member add", () => {
  test("(a) 团队创建 role-only：成员 agentId = 角色 defaultAgentId（请求体无 agentId）", async ({
    request,
  }) => {
    const token = await adminToken(request);
    const role = await createRole(request, token, {
      name: `qa-t14-internal-${RUN_TAG}`,
      key: `qa-t14-internal-${RUN_TAG}`,
      defaultAgentId: "a_tester",
    });
    let teamId: string | null = null;
    try {
      // 团队创建 surface：members 只给 roleId（role-only），服务端按规则 2 预填默认 Agent。
      const team = await createTeam(request, token, {
        name: `qa-t14-create-${RUN_TAG}`,
        members: [{ roleId: role.id }],
      });
      teamId = team.id;
      expect(team.members).toHaveLength(1);
      const member = team.members[0];
      expect(member.roleId).toBe(role.id);
      expect(member.agentId).toBe(role.defaultAgentId);
      expect(member.agentId).toBe("a_tester");
      expect(member.opencodeAgentName ?? null).toBe(null);

      // reload 等价的持久化回读：GET 单团队逐字段一致（非仅创建响应）。
      const reread = await getTeam(request, token, team.id);
      const persisted = reread.members.find((m) => m.roleId === role.id);
      expect(persisted).toBeTruthy();
      expect(persisted!.agentId).toBe(role.defaultAgentId);
      expect(persisted!.agentId).toBe("a_tester");
    } finally {
      await cleanup(request, token, teamId ? [teamId] : [], [role.id]);
    }
  });

  test("(a+b) 详情页添加成员：role-only 无 agentId；外部岗位守卫 → 执行 Agent → opencodeAgentName 持久化（reload）", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const { names, degraded } = await engineExternal(request, token);
    test.skip(
      degraded || names.length === 0,
      `GET /agents/opencode 不可用（degraded=${degraded}，外部条目=${names.length}）——无外部 Agent 可测`,
    );
    const externalName = names.includes(EXTERNAL_PREFERRED)
      ? EXTERNAL_PREFERRED
      : names[0];
    const executorAgentId = await internalAgentId(request, token, "a_developer");

    const internalRole = await createRole(request, token, {
      name: `qa-t14-internal-${RUN_TAG}`,
      key: `qa-t14-internal-${RUN_TAG}`,
      defaultAgentId: "a_tester",
    });
    const externalRole = await createRole(request, token, {
      name: `qa-t14-external-${RUN_TAG}`,
      key: `qa-t14-external-${RUN_TAG}`,
      defaultOpencodeAgentName: externalName,
    });
    let teamId: string | null = null;
    try {
      const team = await createTeam(request, token, {
        name: `qa-t14-detail-${RUN_TAG}`,
      });
      teamId = team.id;

      await loginAsAdmin(page);
      const posts = recordMemberPosts(page);
      await page.goto(`/teams/${team.id}`);
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 20_000 });

      // ---- (a) role-only：选岗位即提交就绪（无执行 Agent 槽位），请求体不带 agentId ----
      const aliasA = `qa-t14-role-only-${RUN_TAG}`;
      await page.getByTestId("add-member-toggle").click();
      await expect(page.getByTestId("add-member-panel")).toBeVisible();
      await expect(
        page.locator(`[data-testid="add-member-role-select"] option[value="${internalRole.id}"]`),
      ).toHaveCount(1, { timeout: 15_000 });
      await page.getByTestId("add-member-role-select").selectOption(internalRole.id);
      await expect(page.getByTestId("add-member-agent-select")).toHaveCount(0);
      await page.getByTestId("add-member-alias").fill(aliasA);
      await page.getByTestId("add-member-confirm").click();
      await expect(page.getByTestId("add-member-panel")).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1);
      expect(posts[0].teamId).toBe(team.id);
      expect(posts[0].body.roleId).toBe(internalRole.id);
      expect("agentId" in posts[0].body).toBe(false);
      expect(posts[0].body.alias).toBe(aliasA);

      // reload：新增成员行仍在（渲染面，别名是 input value 而非文本），
      // 且 API 回读 agentId = 角色 defaultAgentId。
      const afterA = await getTeam(request, token, team.id);
      const memberA = afterA.members.find((m) => m.alias === aliasA);
      expect(memberA).toBeTruthy();
      await page.reload();
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 20_000 });
      const rowA = page.locator(`[data-testid="member-row"][data-member-id="${memberA!.id}"]`);
      await expect(rowA).toBeVisible({ timeout: 15_000 });
      await expect(rowA.getByTestId("member-alias-input")).toHaveValue(aliasA);
      expect(memberA!.roleId).toBe(internalRole.id);
      expect(memberA!.agentId).toBe(internalRole.defaultAgentId);
      expect(memberA!.agentId).toBe("a_tester");
      expect(memberA!.opencodeAgentName ?? null).toBe(null);

      // ---- (b) 外部绑定岗位：可选中（文案「（外部）」）→ 守卫 → 执行 Agent → opencodeAgentName ----
      const aliasB = `qa-t14-external-${RUN_TAG}`;
      const roleOption = page.locator(
        `[data-testid="add-member-role-select"] option[value="${externalRole.id}"]`,
      );
      await page.getByTestId("add-member-toggle").click();
      await expect(page.getByTestId("add-member-panel")).toBeVisible();
      await expect(roleOption).toHaveCount(1, { timeout: 15_000 });
      await expect(roleOption).toContainText("（外部）");
      await page.getByTestId("add-member-role-select").selectOption(externalRole.id);

      // 外部提示 + 执行 Agent 槽位出现；未选执行 Agent 时确认被守卫拦下（零请求）。
      await expect(page.getByTestId("add-member-external-hint")).toBeVisible();
      const executorSelect = page.getByTestId("add-member-agent-select");
      await expect(executorSelect).toBeVisible();
      await page.getByTestId("add-member-alias").fill(aliasB);
      const postsBefore = posts.length;
      await page.getByTestId("add-member-confirm").click();
      await expect(page.getByTestId("team-action-error")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("team-action-error")).toContainText("外部绑定岗位");
      expect(posts.length).toBe(postsBefore);

      // 选定内部执行 Agent（agentId + roleId 走规则 1+5）→ 提交成功。
      await executorSelect.selectOption(executorAgentId);
      await page.getByTestId("add-member-confirm").click();
      await expect(page.getByTestId("add-member-panel")).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(postsBefore + 1);
      const bodyB = posts[posts.length - 1].body;
      expect(bodyB.roleId).toBe(externalRole.id);
      expect(bodyB.agentId).toBe(executorAgentId);

      // reload：成员行可见；API 回读 opencodeAgentName = 外部引擎名，且 role/agent 一致。
      const afterB = await getTeam(request, token, team.id);
      const memberB = afterB.members.find((m) => m.alias === aliasB);
      expect(memberB).toBeTruthy();
      await page.reload();
      await expect(page.getByTestId("team-detail-root")).toBeVisible({ timeout: 20_000 });
      const rowB = page.locator(`[data-testid="member-row"][data-member-id="${memberB!.id}"]`);
      await expect(rowB).toBeVisible({ timeout: 15_000 });
      await expect(rowB.getByTestId("member-alias-input")).toHaveValue(aliasB);
      expect(memberB!.roleId).toBe(externalRole.id);
      expect(memberB!.agentId).toBe(executorAgentId);
      expect(memberB!.opencodeAgentName).toBe(externalName);
    } finally {
      await cleanup(request, token, teamId ? [teamId] : [], [
        internalRole.id,
        externalRole.id,
      ]);
    }
  });

  test("(c) 会话页仍零 <select>、零 message-agent-select", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/teams/${SEED_TEAM_ID}/session`);
    await expect(page.getByTestId("team-session-root")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("message-agent-select")).toHaveCount(0);
    await expect(page.getByTestId("member-external-agent-select")).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);
  });
});
