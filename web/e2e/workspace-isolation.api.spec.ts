import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_SEED_ADMIN_PASSWORD,
} from "./e2e-credentials";

/**
 * 多账号 · 多工作空间隔离 E2E（API 级，设计文档 §5 矩阵的核心断言）。
 *
 * 覆盖：
 * - 两空间数据互不可见（团队成员隔离）
 * - 普通用户跨空间越权（X-Workspace-Id）→ 403
 * - 管理员跨空间只读：可读、写 → 403
 * - 管理员只读查看其它空间成员列表（只读旁路）
 * - 邀请成员后可见性变化
 * - 资源迁移到系统空间（发布共享）后所有空间可见；非管理员迁移 → 403
 *
 * 前置：后端运行在 WORKSPACE_API_BASE（默认 http://127.0.0.1:13100/api/v1），
 * 库已 migrate + seed（admin/admin123、seed-member/Admin@123456）。
 */
const BASE =
  process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13100/api/v1";

async function login(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${BASE}/auth/login`, {
    data: { username, password },
  });
  expect(res.status(), `login ${username}`).toBe(200);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

function auth(token: string, workspaceId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
  };
}

test("多账号 · 空间隔离 / 跨空间只读 / 邀请 / 迁移", async ({ request }) => {
  const ts = Date.now();
  const admin = await login(request, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
  const member = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);

  // ── 准备两个空间：W（管理员创建）、M（普通成员创建） ────────────────────
  const wRes = await request.post(`${BASE}/workspaces`, {
    headers: auth(admin),
    data: { name: `E2E空间-${ts}` },
  });
  expect(wRes.status()).toBe(201);
  const W = (await wRes.json()) as { id: string; name: string };

  const mRes = await request.post(`${BASE}/workspaces`, {
    headers: auth(member),
    data: { name: `成员空间-${ts}` },
  });
  expect(mRes.status()).toBe(201);
  const M = (await mRes.json()) as { id: string; name: string };

  // 管理员切到 W 后建团队；成员切到 M 后建团队
  const adminWSwitch = await request.post(`${BASE}/auth/workspace`, {
    headers: auth(admin),
    data: { workspaceId: W.id },
  });
  const adminW = ((await adminWSwitch.json()) as { accessToken: string })
    .accessToken;
  const memberMSwitch = await request.post(`${BASE}/auth/workspace`, {
    headers: auth(member),
    data: { workspaceId: M.id },
  });
  const memberM = ((await memberMSwitch.json()) as { accessToken: string })
    .accessToken;

  const teamW = `W团队-${ts}`;
  const teamM = `M团队-${ts}`;
  expect(
    (
      await request.post(`${BASE}/teams`, {
        headers: auth(adminW),
        data: { name: teamW },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await request.post(`${BASE}/teams`, {
        headers: auth(memberM),
        data: { name: teamM },
      })
    ).status(),
  ).toBe(201);

  // ── 1) 数据隔离：各自空间只看到自己的团队 ──────────────────────────────
  const adminTeams = (await (
    await request.get(`${BASE}/teams?pageSize=100`, { headers: auth(adminW) })
  ).json()) as { items: Array<{ name: string }> };
  expect(adminTeams.items.map((t) => t.name)).toContain(teamW);
  expect(adminTeams.items.map((t) => t.name)).not.toContain(teamM);

  const memberTeams = (await (
    await request.get(`${BASE}/teams?pageSize=100`, { headers: auth(memberM) })
  ).json()) as { items: Array<{ name: string }> };
  expect(memberTeams.items.map((t) => t.name)).toContain(teamM);
  expect(memberTeams.items.map((t) => t.name)).not.toContain(teamW);

  // ── 2) 普通用户跨空间越权（伪造 X-Workspace-Id）→ 403 ──────────────────
  expect(
    (
      await request.get(`${BASE}/teams`, {
        headers: auth(memberM, W.id),
      })
    ).status(),
  ).toBe(403);

  // ── 3) 管理员跨空间只读：可读「非本人空间」M 的团队、写被拒 ────────────
  // 注意：W 是管理员自己创建的空间（owner），对 W 的请求是正常可写；
  // 只读语义只对「管理员不是成员」的空间生效 —— 这里用成员创建的 M 验证。
  const crossRead = (await (
    await request.get(`${BASE}/teams?pageSize=100`, {
      headers: auth(admin, M.id),
    })
  ).json()) as { items: Array<{ name: string }> };
  expect(crossRead.items.map((t) => t.name)).toContain(teamM);

  const crossWrite = await request.post(`${BASE}/teams`, {
    headers: auth(admin, M.id),
    data: { name: `越权写-${ts}` },
  });
  expect(crossWrite.status()).toBe(403);

  // ── 4) 管理员只读查看其它空间成员列表 ──────────────────────────────────
  const crossMembers = await request.get(`${BASE}/workspaces/${M.id}/members`, {
    headers: auth(admin, M.id),
  });
  expect(crossMembers.status()).toBe(200);
  const membersBody = (await crossMembers.json()) as Array<{ userId: string }>;
  expect(membersBody.some((m) => m.userId === "u_seed_member")).toBe(true);

  // ── 5) 邀请成员：加入 W 后可读 W 数据 ─────────────────────────────────
  const invite = await request.post(`${BASE}/workspaces/${W.id}/members`, {
    headers: auth(adminW),
    data: { userId: "u_seed_member" },
  });
  expect(invite.status()).toBe(201);
  const invitedRead = (await (
    await request.get(`${BASE}/teams?pageSize=100`, {
      headers: auth(memberM, W.id),
    })
  ).json()) as { items: Array<{ name: string }> };
  expect(invitedRead.items.map((t) => t.name)).toContain(teamW);

  // ── 6) 资源迁移到系统空间（发布共享）→ 其它空间可见 ────────────────────
  const agentRes = await request.post(`${BASE}/agents`, {
    headers: auth(admin),
    data: {
      name: `E2E-Agent-${ts}`,
      type: "custom",
      agentKey: `e2e-agent-${ts}`,
      prompt: "e2e",
    },
  });
  expect(agentRes.status()).toBe(201);
  const agent = (await agentRes.json()) as { id: string };

  const reloc = await request.post(`${BASE}/workspaces/relocations`, {
    headers: auth(admin),
    data: {
      resourceType: "agent",
      resourceId: agent.id,
      targetWorkspaceId: "ws_system",
      reason: "e2e share",
    },
  });
  expect(reloc.status()).toBe(201);
  expect((await reloc.json()) as { moved: boolean }).toMatchObject({
    moved: true,
  });

  const memberAgents = (await (
    await request.get(`${BASE}/agents?pageSize=200`, { headers: auth(memberM) })
  ).json()) as { items: Array<{ id: string }> };
  expect(memberAgents.items.some((a) => a.id === agent.id)).toBe(true);

  // 审计可查
  const audit = await request.get(`${BASE}/workspaces/relocations?limit=10`, {
    headers: auth(admin),
  });
  expect(audit.status()).toBe(200);
  const auditRows = (await audit.json()) as Array<{ resourceId: string }>;
  expect(auditRows.some((r) => r.resourceId === agent.id)).toBe(true);

  // ── 7) 非管理员迁移 → 403 ──────────────────────────────────────────────
  expect(
    (
      await request.post(`${BASE}/workspaces/relocations`, {
        headers: auth(memberM),
        data: {
          resourceType: "agent",
          resourceId: agent.id,
          targetWorkspaceId: M.id,
        },
      })
    ).status(),
  ).toBe(403);
});
