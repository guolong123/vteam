import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

/**
 * opencode-native-permissions-and-fixes · task-15 · 团队创建页岗位列表（web 切片）
 * ================================================================================
 * 对 live compose stack（web :13001 + server :13000；admin/admin123）证明：
 *
 *  (a) /teams/new 的岗位卡**全部**来自 GET /agent-roles：每个 role（含 type=custom）
 *      都渲染一张 [data-testid="role-card"][data-role=<key>]，卡片数 = 岗位数且 > 6。
 *  (b) 勾选一张**自定义岗位**卡（defaultAgentId=a_tester）即可建团：POST /teams 请求体
 *      成员只带 roleId（无 agentId）→ 落库成员 roleId = 该岗位、agentId = 岗位绑定的
 *      defaultAgentId（服务端规则 2 预填）。
 *  (c) 外部绑定岗位（仅 defaultOpencodeAgentName）不再要求另选内部执行 Agent：勾选后
 *      卡片内**零** `<select>`（无执行 Agent 下拉）与外部提示；直接 roleId-only 建团成功，
 *      落库成员 agentId = 平台占位系统 Agent `a_external`、opencodeAgentName = 岗位外部名。
 *
 * 一次性 team/role 全部在 finally 里 DELETE（先 team 后 role，防角色 in-use 409）；
 * 不留任何 fixture。运行：web 下临时 config（同 scripts/e2e-roles-members.sh 模式），
 * baseURL 指向 compose web :13001，channel=chrome。
 */

const SERVER_URL = "http://localhost:13000";
const RUN_TAG = `t15-${Date.now().toString(36)}`;

interface AgentRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
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

async function listRoles(
  request: APIRequestContext,
  token: string,
): Promise<AgentRole[]> {
  const res = await request.get(
    `${SERVER_URL}/api/v1/agent-roles?page=1&pageSize=100`,
    { headers: authHeaders(token) },
  );
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { items: AgentRole[] }).items;
}

async function createRole(
  request: APIRequestContext,
  token: string,
  payload: { name: string; key: string; description: string; defaultAgentId: string },
): Promise<AgentRole> {
  const res = await request.post(`${SERVER_URL}/api/v1/agent-roles`, {
    headers: authHeaders(token),
    data: { type: "custom", ...payload },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as AgentRole;
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

/** 记录浏览器发出的 POST /teams 请求体（role-only 提交断言的原始证据）。 */
function recordTeamPosts(page: Page): { body: Record<string, unknown> }[] {
  const posts: { body: Record<string, unknown> }[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    if (new URL(req.url()).pathname !== "/api/v1/teams") return;
    let body: Record<string, unknown> = {};
    try {
      body = ((req.postDataJSON() as Record<string, unknown> | null) ?? {}) as Record<
        string,
        unknown
      >;
    } catch {
      body = {};
    }
    posts.push({ body });
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

function roleCard(page: Page, role: AgentRole) {
  return page.locator(`[data-testid="role-card"][data-role="${role.key}"]`);
}

test.describe("task-15 · 团队创建页岗位列表（/agent-roles 单一来源）", () => {
  test("(a+b) 岗位卡 = /agent-roles 全量；勾选自定义岗位建团 → roleId-only + agentId 预填", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const role = await createRole(request, token, {
      name: `qa-t15-role-${RUN_TAG}`,
      key: `qa-t15-role-${RUN_TAG}`,
      description: `qa-t15 自定义岗位 ${RUN_TAG}`,
      defaultAgentId: "a_tester",
    });
    const roles = await listRoles(request, token);
    expect(roles.length).toBeGreaterThan(6);
    expect(roles.some((r) => r.type === "custom")).toBe(true);
    let teamId: string | null = null;
    try {
      await loginAsAdmin(page);
      const posts = recordTeamPosts(page);
      await page.goto("/teams/new");
      await expect(page.getByTestId("team-create-root")).toBeVisible({ timeout: 20_000 });

      // (a) 每个岗位（内置 + 自定义）一张卡，key 一一对应，卡片数 = 岗位数 > 6
      await expect(page.getByTestId("role-card")).toHaveCount(roles.length, {
        timeout: 20_000,
      });
      for (const r of roles) {
        await expect(roleCard(page, r)).toHaveCount(1);
      }

      // (b) 自定义岗位卡：标题 = role.name、副标题 = role.description、绑定 = defaultAgentId
      const card = roleCard(page, role);
      await expect(card).toContainText(role.name);
      await expect(card).toContainText(role.description!);
      await expect(card.getByTestId("role-binding")).toHaveAttribute(
        "data-role-id",
        role.id,
      );
      await card.getByTestId("role-toggle").click();
      await expect(card.getByTestId("instance-row")).toHaveCount(1);
      await expect(page.getByTestId("selected-member")).toHaveCount(1);

      const teamName = `qa-t15-team-${RUN_TAG}`;
      await page.getByTestId("team-name-input").fill(teamName);
      await page.getByTestId("create-team-submit").click();

      await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
      const body = posts[0].body;
      expect(body.name).toBe(teamName);
      const members = body.members as { roleId?: string; agentId?: string }[];
      expect(members).toHaveLength(1);
      expect(members[0].roleId).toBe(role.id);
      expect("agentId" in members[0]).toBe(false);

      await expect(page).toHaveURL(/\/teams\/tm_[A-Za-z0-9]+/, { timeout: 20_000 });
      teamId = new URL(page.url()).pathname.split("/").pop()!;

      // 落库回读：roleId = 自定义岗位，agentId = 岗位绑定的 defaultAgentId（规则 2 预填）
      const reread = await getTeam(request, token, teamId);
      const member = reread.members.find((m) => m.roleId === role.id);
      expect(member).toBeTruthy();
      expect(member!.agentId).toBe(role.defaultAgentId);
      expect(member!.agentId).toBe("a_tester");
      expect(member!.opencodeAgentName ?? null).toBe(null);
    } finally {
      await cleanup(request, token, teamId ? [teamId] : [], [role.id]);
    }
  });

  test("(c) 外部绑定岗位：无执行 Agent 选择器/提示；roleId-only 建团成功（落占位系统 Agent）", async ({
    page,
    request,
  }) => {
    const token = await adminToken(request);
    const roles = await listRoles(request, token);
    const external = roles.find(
      (r) => !r.defaultAgentId && !!r.defaultOpencodeAgentName,
    );
    test.skip(!external, "live 岗位清单无外部绑定岗位（defaultOpencodeAgentName）");

    let teamId: string | null = null;
    try {
      await loginAsAdmin(page);
      const posts = recordTeamPosts(page);
      await page.goto("/teams/new");
      await expect(page.getByTestId("team-create-root")).toBeVisible({ timeout: 20_000 });

      const card = roleCard(page, external!);
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.getByTestId("role-toggle").click();

      // 移除「外部岗位必须另选内部执行 Agent」的要求后：卡片内无任何执行 Agent 下拉。
      await expect(card.locator("select")).toHaveCount(0);

      const teamName = `qa-t15-external-${RUN_TAG}`;
      await page.getByTestId("team-name-input").fill(teamName);
      await page.getByTestId("create-team-submit").click();

      await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);
      const members = posts[0].body.members as { roleId?: string; agentId?: string }[];
      expect(members).toHaveLength(1);
      expect(members[0].roleId).toBe(external!.id);
      expect("agentId" in members[0]).toBe(false);

      await expect(page).toHaveURL(/\/teams\/tm_[A-Za-z0-9]+/, { timeout: 20_000 });
      teamId = new URL(page.url()).pathname.split("/").pop()!;

      const reread = await getTeam(request, token, teamId);
      const member = reread.members.find((m) => m.roleId === external!.id);
      expect(member).toBeTruthy();
      expect(member!.agentId).toBe("a_external");
      expect(member!.opencodeAgentName).toBe(external!.defaultOpencodeAgentName);
      expect(member!.alias.startsWith(external!.name)).toBe(true);
    } finally {
      await cleanup(request, token, teamId ? [teamId] : [], []);
    }
  });
});
