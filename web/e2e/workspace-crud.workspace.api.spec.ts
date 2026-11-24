import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME, E2E_MEMBER_PASSWORD } from "./e2e-credentials";

type JsonObj = Record<string, unknown>;

/** 空间内资源 CRUD 全面体检（在独立新空间内执行，平台管理员）。 */
const API_BASE = process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";

async function login(request: APIRequestContext, username: string, password: string) {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { username, password } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { accessToken: string; user: { id: string } };
}
async function createWorkspace(request: APIRequestContext, token: string, name: string) {
  const res = await request.post(`${API_BASE}/workspaces`, { headers: { Authorization: `Bearer ${token}` }, data: { name } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; name: string };
}
async function switchWorkspace(request: APIRequestContext, token: string, id: string) {
  const res = await request.post(`${API_BASE}/auth/workspace`, { headers: { Authorization: `Bearer ${token}` }, data: { workspaceId: id } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { accessToken: string }).accessToken;
}
const h = (t: string) => ({ Authorization: `Bearer ${t}` });
async function body(res: APIResponse) { try { return await res.json(); } catch { return await res.text(); } }
async function expectStatus(res: APIResponse, code: number, label: string) {
  if (res.status() !== code) throw new Error(`${label}: 期望 ${code}，实际 ${res.status()}，响应=${JSON.stringify(await body(res)).slice(0, 600)}`);
}
async function firstArray(res: APIResponse): Promise<JsonObj[]> {
  const data = await res.json();
  return Array.isArray(data) ? data : (data.items ?? []);
}

test.describe.serial("空间内资源 CRUD 全量体检", () => {
  const ts = Date.now();
  let token = "";
  let spaceId = "";
  let memberRoleId = "";

  test.beforeAll(async ({ request }) => {
    const a = await login(request, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    const ws = await createWorkspace(request, a.accessToken, `CRUD空间-${ts}`);
    spaceId = ws.id;
    token = await switchWorkspace(request, a.accessToken, spaceId);
    const roles = await (await request.get(`${API_BASE}/roles`, { headers: h(token) })).json();
    memberRoleId = roles.find((r: JsonObj) => String(r.name) === "member")?.id;
    expect(memberRoleId).toBeTruthy();
  });

  test("WORKSPACE + USER：建用户/加成员/移除成员/改状态/改空间/重置密码", async ({ request }) => {
    const username = `crud-user-${ts}`;
    const created = await request.post(`${API_BASE}/users`, {
      headers: h(token),
      data: { username, password: E2E_MEMBER_PASSWORD, displayName: username, email: `${username}@example.com`, roleId: memberRoleId },
    });
    await expectStatus(created, 201, "创建用户");
    const user = (await created.json()) as { id: string };

    const users = await firstArray(await request.get(`${API_BASE}/users?pageSize=100`, { headers: h(token) }));
    expect(users.some((u: JsonObj) => String(u.id) === user.id)).toBe(true);
    await expectStatus(await request.get(`${API_BASE}/users/${user.id}`, { headers: h(token) }), 200, "查询用户");

    await expectStatus(
      await request.post(`${API_BASE}/workspaces/${spaceId}/members`, { headers: h(token), data: { userId: user.id, role: "member" } }),
      201, "空间加成员",
    );
    const members = await firstArray(await request.get(`${API_BASE}/workspaces/${spaceId}/members`, { headers: h(token) }));
    expect(members.some((m: JsonObj) => String((m.userId ?? (m.user as JsonObj | undefined)?.id)) === user.id)).toBe(true);
    await expectStatus(await request.delete(`${API_BASE}/workspaces/${spaceId}/members/${user.id}`, { headers: h(token) }), 200, "空间移除成员");

    await expectStatus(await request.patch(`${API_BASE}/users/${user.id}/status`, { headers: h(token), data: { enabled: false } }), 200, "禁用用户");
    await expectStatus(await request.patch(`${API_BASE}/users/${user.id}/status`, { headers: h(token), data: { enabled: true } }), 200, "启用用户");
    await expectStatus(
      await request.patch(`${API_BASE}/users/${user.id}`, {
        headers: h(token), data: { displayName: `${username}-v2`, workspaceIds: [spaceId], currentWorkspaceId: spaceId },
      }),
      200, "编辑用户（含空间）",
    );
    await expectStatus(
      await request.post(`${API_BASE}/users/${user.id}/reset-password`, { headers: h(token), data: { newPassword: E2E_MEMBER_PASSWORD } }),
      201, "重置密码",
    );
    const relogin = await request.post(`${API_BASE}/auth/login`, { data: { username, password: E2E_MEMBER_PASSWORD } });
    expect([200, 201]).toContain(relogin.status());
  });

  test("TEAM + MEMBER：建团队/改/加成员/移除成员/删团队；成员独立增改删", async ({ request }) => {
    const memberRes = await request.post(`${API_BASE}/members`, {
      headers: h(token), data: { roleId: "ar_developer", name: `crud-member-${ts}`, description: "CRUD 成员" },
    });
    await expectStatus(memberRes, 201, "创建成员");
    const member = (await memberRes.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/members/${member.id}`, { headers: h(token) }), 200, "查询成员");
    await expectStatus(await request.patch(`${API_BASE}/members/${member.id}`, { headers: h(token), data: { description: "更新成员描述" } }), 200, "修改成员");

    const teamRes = await request.post(`${API_BASE}/teams`, {
      headers: h(token), data: { name: `CRUD团队-${ts}`, members: [{ memberId: member.id }] },
    });
    await expectStatus(teamRes, 201, "创建团队");
    const team = (await teamRes.json()) as { id: string };

    const detail = await (await request.get(`${API_BASE}/teams/${team.id}`, { headers: h(token) })).json();
    expect(detail.name).toBe(`CRUD团队-${ts}`);
    await expectStatus(await request.patch(`${API_BASE}/teams/${team.id}`, { headers: h(token), data: { description: "更新团队描述" } }), 200, "修改团队");

    const added = await request.post(`${API_BASE}/teams/${team.id}/members`, {
      headers: h(token), data: { newMember: { name: `crud-team-member-${ts}`, roleId: "ar_tester" } },
    });
    expect([201, 200]).toContain(added.status());
    // addMember 返回团队详情；从 members 里按别名定位新席位（id=tmm_）
    const addedDetail = await added.json();
    const addedSeat = (addedDetail.members ?? []).find(
      (m: JsonObj) => m.alias === `crud-team-member-${ts}` || (m.member as JsonObj | undefined)?.name === `crud-team-member-${ts}`,
    );
    const addedSeatId = String(addedSeat?.id ?? "");
    expect(addedSeatId.startsWith("tmm_")).toBe(true);

    // 先移除新建的席位，再把初始成员席位也从团队移除，最后删成员
    await expectStatus(await request.delete(`${API_BASE}/teams/${team.id}/members/${addedSeatId}`, { headers: h(token) }), 200, "移除新加团队成员");
    const afterAdd = (await (await request.get(`${API_BASE}/teams/${team.id}`, { headers: h(token) })).json()) as JsonObj;
    const initialSeat = ((afterAdd.members ?? []) as JsonObj[]).find(
      (m: JsonObj) => String(m.memberId) === member.id,
    );
    if (initialSeat?.id) {
      await expectStatus(await request.delete(`${API_BASE}/teams/${team.id}/members/${initialSeat.id}`, { headers: h(token) }), 200, "移除初始团队成员席位");
    }
    await expectStatus(await request.delete(`${API_BASE}/members/${member.id}`, { headers: h(token) }), 200, "删除成员");
    await expectStatus(await request.delete(`${API_BASE}/teams/${team.id}`, { headers: h(token) }), 200, "删除团队");
  });

  test("GIT：凭证创建/改/删 + 仓库创建/查询/改授权/删", async ({ request }) => {
    const credRes = await request.post(`${API_BASE}/git-credentials`, {
      headers: h(token), data: { name: `crud-cred-${ts}`, authType: "https_token", key: "crud-token" },
    });
    await expectStatus(credRes, 201, "创建 Git 凭证");
    const cred = (await credRes.json()) as { id: string };
    await expectStatus(await request.patch(`${API_BASE}/git-credentials/${cred.id}`, { headers: h(token), data: { description: "更新凭证描述" } }), 200, "修改 Git 凭证");

    const repoRes = await request.post(`${API_BASE}/git-repos`, {
      headers: h(token), data: { repoUrl: `git@example.com:crud/repo-${ts}.git`, credentialId: cred.id, grantedAgents: [] },
    });
    await expectStatus(repoRes, 201, "创建 Git 仓库");
    const repo = (await repoRes.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/git-repos`, { headers: h(token) }), 200, "查询 Git 仓库列表");
    await expectStatus(await request.patch(`${API_BASE}/git-repos/${repo.id}`, { headers: h(token), data: { credentialId: cred.id } }), 200, "修改 Git 仓库");
    await expectStatus(await request.delete(`${API_BASE}/git-repos/${repo.id}`, { headers: h(token) }), 200, "删除 Git 仓库");
    await expectStatus(await request.delete(`${API_BASE}/git-credentials/${cred.id}`, { headers: h(token) }), 200, "删除 Git 凭证");
  });

  test("CHANNEL：消息渠道 + 通知渠道 创建/改/删", async ({ request }) => {
    const mcRes = await request.post(`${API_BASE}/message-channels`, {
      headers: h(token), data: { name: `crud-mc-${ts}`, type: "generic_webhook", config: {}, secrets: {} },
    });
    await expectStatus(mcRes, 201, "创建消息渠道");
    const mc = (await mcRes.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/message-channels/${mc.id}`, { headers: h(token) }), 200, "查询消息渠道");
    await expectStatus(await request.patch(`${API_BASE}/message-channels/${mc.id}`, { headers: h(token), data: { name: `crud-mc-${ts}-v2` } }), 200, "修改消息渠道");
    await expectStatus(await request.delete(`${API_BASE}/message-channels/${mc.id}`, { headers: h(token) }), 200, "删除消息渠道");

    const ncRes = await request.post(`${API_BASE}/notification-channels`, {
      headers: h(token),
      data: { name: `crud-nc-${ts}`, type: "webhook", config: { targetUrl: "https://example.com/hook", events: ["task.status_changed"] } },
    });
    await expectStatus(ncRes, 201, "创建通知渠道");
    const nc = (await ncRes.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/notification-channels/${nc.id}`, { headers: h(token) }), 200, "查询通知渠道");
    await expectStatus(await request.patch(`${API_BASE}/notification-channels/${nc.id}`, { headers: h(token), data: { name: `crud-nc-${ts}-v2` } }), 200, "修改通知渠道");
    await expectStatus(await request.delete(`${API_BASE}/notification-channels/${nc.id}`, { headers: h(token) }), 200, "删除通知渠道");
  });

  test("TASK + ISSUE：任务创建/查询/修改；问题创建/改/流转/删", async ({ request }) => {
    const teamRes = await request.post(`${API_BASE}/teams`, {
      headers: h(token),
      data: {
        name: `CRUD任务团队-${ts}`,
        members: [{ newMember: { name: `crud-task-member-${ts}`, roleId: "ar_developer" } }],
      },
    });
    await expectStatus(teamRes, 201, "创建任务所用团队");
    const team = (await teamRes.json()) as { id: string };

    const taskRes = await request.post(`${API_BASE}/tasks`, {
      headers: h(token), data: { title: `CRUD任务-${ts}`, teamId: team.id, priority: "medium" },
    });
    await expectStatus(taskRes, 201, "创建任务");
    const task = (await taskRes.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/tasks/${task.id}`, { headers: h(token) }), 200, "查询任务");
    await expectStatus(await request.patch(`${API_BASE}/tasks/${task.id}`, { headers: h(token), data: { title: `CRUD任务-${ts}-v2` } }), 200, "修改任务");

    const issueRes = await request.post(`${API_BASE}/issues`, { headers: h(token), data: { taskId: task.id, title: `CRUD问题-${ts}` } });
    await expectStatus(issueRes, 201, "创建问题");
    const issue = (await issueRes.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/issues/${issue.id}`, { headers: h(token) }), 200, "查询问题");
    await expectStatus(await request.patch(`${API_BASE}/issues/${issue.id}`, { headers: h(token), data: { title: `CRUD问题-${ts}-v2` } }), 200, "修改问题");
    const trans = await request.post(`${API_BASE}/issues/${issue.id}/transition`, { headers: h(token), data: { action: "accept" } });
    expect([200, 201, 400]).toContain(trans.status());
    await expectStatus(await request.delete(`${API_BASE}/issues/${issue.id}`, { headers: h(token) }), 200, "删除问题");
    await expectStatus(await request.delete(`${API_BASE}/teams/${team.id}`, { headers: h(token) }), 200, "删除任务团队");
  });

  test("CHAT：私聊创建 → 列表 → 删除", async ({ request }) => {
    const m = await request.post(`${API_BASE}/members`, { headers: h(token), data: { roleId: "ar_developer", name: `crud-chat-member-${ts}` } });
    await expectStatus(m, 201, "创建私聊成员");
    const member = (await m.json()) as { id: string };

    // 私聊要求成员已在某个团队群聊中（席位存在）
    const teamRes = await request.post(`${API_BASE}/teams`, {
      headers: h(token), data: { name: `CRUD私聊团队-${ts}`, members: [{ memberId: member.id }] },
    });
    await expectStatus(teamRes, 201, "创建私聊成员所在团队");
    const chatTeam = (await teamRes.json()) as { id: string };

    const dm = await request.post(`${API_BASE}/dm-channels`, { headers: h(token), data: { memberId: member.id } });
    if (![200, 201].includes(dm.status())) {
      throw new Error(`创建私聊失败: ${dm.status()} ${JSON.stringify(await body(dm)).slice(0, 400)}`);
    }
    const channel = (await dm.json()) as { id: string };
    const channels = await firstArray(await request.get(`${API_BASE}/channels`, { headers: h(token) }));
    expect(channels.some((c: JsonObj) => String(c.id) === channel.id)).toBe(true);
    await expectStatus(await request.delete(`${API_BASE}/channels/${channel.id}`, { headers: h(token) }), 200, "删除私聊频道");
    await expectStatus(await request.delete(`${API_BASE}/teams/${chatTeam.id}`, { headers: h(token) }), 200, "删除私聊成员所在团队");
    await expectStatus(await request.delete(`${API_BASE}/members/${member.id}`, { headers: h(token) }), 200, "删除私聊成员");
  });

  test("MEMORY：列表读取 + 不存在行的边界", async ({ request }) => {
    const list = await request.get(`${API_BASE}/memories?pageSize=20`, { headers: h(token) });
    await expectStatus(list, 200, "读取记忆列表");
    const payload = await list.json();
    expect(Array.isArray(payload.items)).toBe(true);
    const missing = await request.patch(`${API_BASE}/memories/mem_not_exists`, { headers: h(token), data: { description: "x" } });
    expect([400, 404]).toContain(missing.status());
  });

  test("UPLOAD：空间内上传并校验签名 URL 可读", async ({ request }) => {
    const up = await request.post(`${API_BASE}/uploads`, {
      headers: h(token),
      multipart: { file: { name: "crud-space.txt", mimeType: "text/plain", buffer: Buffer.from("space upload", "utf-8") } },
    });
    await expectStatus(up, 201, "空间上传文件");
    const { url } = (await up.json()) as { url: string };
    const origin = new URL(API_BASE).origin;
    await expectStatus(await request.get(url.startsWith("http") ? url : `${origin}${url}`), 200, "读取上传文件");
  });
});
