import { expect, test } from "@playwright/test";
import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_MEMBER_PASSWORD,
  E2E_SEED_ADMIN_PASSWORD,
} from "./e2e-credentials";
import {
  API_BASE,
  createAgent,
  createTeam,
  createWorkspace,
  headers,
  listAgents,
  listTeams,
  login,
  switchWorkspace,
} from "./workspace-api-helpers";

/**
 * 多工作空间隔离矩阵（API 级，设计文档 test-cases.md §1~§7）。
 *
 * 串行执行：先建两个空间（W=管理员、M=普通成员）与各自资源，再逐项断言隔离。
 * 依赖后端已迁移 + seed（compose 测试栈：WORKSPACE_API_BASE=http://127.0.0.1:13200/api/v1）。
 */
test.describe.serial("多用户隔离矩阵", () => {
  const ts = Date.now();
  let admin = "";
  let adminW = "";
  let memberM = "";
  let W: { id: string; name: string };
  let M: { id: string; name: string };
  let teamW: { id: string; name: string };
  let teamM: { id: string; name: string };
  const sameName = `同名团队-${ts}`;

  test.beforeAll(async ({ request }) => {
    const a = await login(request, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    const m = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);
    admin = a.token;
    W = await createWorkspace(request, admin, `矩阵W-${ts}`);
    M = await createWorkspace(request, m.token, `矩阵M-${ts}`);
    adminW = await switchWorkspace(request, admin, W.id);
    memberM = await switchWorkspace(request, m.token, M.id);

    teamW = await createTeam(request, adminW, `W唯一团队-${ts}`);
    teamM = await createTeam(request, memberM, `M唯一团队-${ts}`);
    // RES-L02：两个空间各建同名团队（空间内唯一键互不冲突）
    await createTeam(request, adminW, sameName);
    await createTeam(request, memberM, sameName);
    // 给成员 token 记下自己的空间 id（后续邀请切换用）
    expect(W.id).toBeTruthy();
    expect(M.id).toBeTruthy();
  });

  test("WS-02 空间列表只含「我加入的 + 系统空间」", async ({ request }) => {
    const m = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);
    const res = await request.get(`${API_BASE}/workspaces`, {
      headers: headers(m.token),
    });
    expect(res.status()).toBe(200);
    const list = (await res.json()) as Array<{ id: string; isSystem: boolean }>;
    expect(list.some((w) => w.isSystem)).toBe(true);
    expect(list.map((w) => w.id)).not.toContain(W.id);
  });

  test("WS-03 非成员不能切到他人空间（403）", async ({ request }) => {
    const m = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);
    const res = await request.post(`${API_BASE}/auth/workspace`, {
      headers: headers(m.token),
      data: { workspaceId: W.id },
    });
    expect(res.status()).toBe(403);
  });

  test("WS-07 普通用户伪造 X-Workspace-Id（非成员）→ 403", async ({
    request,
  }) => {
    const m = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);
    const res = await request.get(`${API_BASE}/teams`, {
      headers: headers(m.token, W.id),
    });
    expect(res.status()).toBe(403);
  });

  test("WS-06 管理员跨空间只读：读 200 / 写 403", async ({ request }) => {
    const read = await request.get(`${API_BASE}/teams?pageSize=100`, {
      headers: headers(admin, M.id),
    });
    expect(read.status()).toBe(200);
    const body = (await read.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((t) => t.name)).toContain(teamM.name);

    const write = await request.post(`${API_BASE}/teams`, {
      headers: headers(admin, M.id),
      data: { name: `跨空间越权写-${ts}` },
    });
    expect(write.status()).toBe(403);
  });

  test("RES-L01 团队列表隔离 + RES-L02 同名团队跨空间共存", async ({
    request,
  }) => {
    const wTeams = await listTeams(request, adminW);
    const mTeams = await listTeams(request, memberM);
    const wNames = wTeams.items.map((t) => t.name);
    const mNames = mTeams.items.map((t) => t.name);
    expect(wNames).toContain(teamW.name);
    expect(wNames).not.toContain(teamM.name);
    expect(mNames).toContain(teamM.name);
    expect(mNames).not.toContain(teamW.name);
    // 同名团队各自存在
    expect(wNames).toContain(sameName);
    expect(mNames).toContain(sameName);
  });

  test("RES-L03 同空间重复团队名 → 409", async ({ request }) => {
    const res = await request.post(`${API_BASE}/teams`, {
      headers: headers(adminW),
      data: { name: teamW.name },
    });
    expect(res.status()).toBe(409);
  });

  test("RES-D01/D02 跨空间团队详情/改名被拒，且原数据未变", async ({
    request,
  }) => {
    const detail = await request.get(`${API_BASE}/teams/${teamW.id}`, {
      headers: headers(memberM),
    });
    expect([403, 404]).toContain(detail.status());

    const patch = await request.patch(`${API_BASE}/teams/${teamW.id}`, {
      headers: headers(memberM),
      data: { name: `被篡改-${ts}` },
    });
    expect([403, 404]).toContain(patch.status());

    const stillMine = await listTeams(request, adminW);
    expect(stillMine.items.find((t) => t.id === teamW.id)?.name).toBe(
      teamW.name,
    );
  });

  test("RES-L04 / RES-D03 / RES-D04 跨空间 Agent 隔离", async ({ request }) => {
    const agent = await createAgent(
      request,
      adminW,
      `W私有Agent-${ts}`,
      `w-private-${ts}`,
    );

    const wAgents = await listAgents(request, adminW);
    expect(wAgents.items.map((a) => a.id)).toContain(agent.id);

    // M 空间列表不可见（系统模板仍可见，但不含 W 自建）
    const mAgents = await listAgents(request, memberM);
    expect(mAgents.items.map((a) => a.id)).not.toContain(agent.id);

    // 按 id 直接访问：404（不泄露存在性）
    expect(
      (
        await request.get(`${API_BASE}/agents/${agent.id}`, {
          headers: headers(memberM),
        })
      ).status(),
    ).toBe(404);

    // 编辑/克隆被拒
    expect(
      (
        await request.patch(`${API_BASE}/agents/${agent.id}`, {
          headers: headers(memberM),
          data: { name: `被篡改Agent-${ts}` },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await request.post(`${API_BASE}/agents/${agent.id}/clone`, {
          headers: headers(memberM),
          data: { name: `克隆-${ts}`, agentKey: `clone-${ts}` },
        })
      ).status(),
    ).toBe(404);

    // W 的 Agent 未被修改
    const after = await request.get(`${API_BASE}/agents/${agent.id}`, {
      headers: headers(adminW),
    });
    expect(after.status()).toBe(200);
    expect(((await after.json()) as { name: string }).name).not.toContain(
      "被篡改",
    );
  });

  test("RES-L05 成员库隔离（各空间独立，同名成员可跨空间共存）", async ({
    request,
  }) => {
    const memberName = `隔离成员-${ts}`;
    // 默认空间建成员
    const createdDefault = await request.post(`${API_BASE}/members`, {
      headers: headers(admin),
      data: { name: memberName, roleId: "ar_developer" },
    });
    expect(createdDefault.status()).toBe(201);

    // W 空间建同名成员（成员名唯一键按空间）
    const createdW = await request.post(`${API_BASE}/members`, {
      headers: headers(adminW),
      data: { name: memberName, roleId: "ar_developer" },
    });
    expect(createdW.status()).toBe(201);

    // 默认空间只看得到自己的成员
    const defaultRes = await request.get(`${API_BASE}/members?pageSize=100`, {
      headers: headers(admin),
    });
    expect(defaultRes.status()).toBe(200);
    const defaultList = (await defaultRes.json()) as {
      total: number;
      items: Array<{ id: string }>;
    };
    const defaultIds = defaultList.items.map((m) => m.id);
    expect(defaultIds).toContain(
      ((await createdDefault.json()) as { id: string }).id,
    );
    expect(defaultIds).not.toContain(
      ((await createdW.json()) as { id: string }).id,
    );

    // W 空间只看得到自己的成员；M 空间看不到 W 的成员
    const wRes = await request.get(`${API_BASE}/members?pageSize=100`, {
      headers: headers(adminW),
    });
    expect(wRes.status()).toBe(200);
    const wList = (await wRes.json()) as {
      total: number;
      items: Array<{ id: string }>;
    };
    expect(wList.items.map((m) => m.id)).toEqual([
      ((await createdW.json()) as { id: string }).id,
    ]);
    const mRes = await request.get(`${API_BASE}/members?pageSize=100`, {
      headers: headers(memberM),
    });
    expect(mRes.status()).toBe(200);
    const mList = (await mRes.json()) as { total: number };
    expect(Number(mList.total)).toBe(0);
  });

  test("RES-L06 Worker 列表隔离（W 空间没有节点，默认空间有）", async ({
    request,
  }) => {
    // 显式切到默认空间（登录态 lastWorkspaceId 可能已被其它用例改到别的空间）
    const a = await login(request, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    const adminDefault = await switchWorkspace(request, a.token, "ws_default");

    const wWorkers = await request.get(`${API_BASE}/workers`, {
      headers: headers(adminW),
    });
    expect(wWorkers.status()).toBe(200);
    expect(await wWorkers.json()).toEqual([]);

    const defaultWorkers = await request.get(`${API_BASE}/workers`, {
      headers: headers(adminDefault),
    });
    expect(defaultWorkers.status()).toBe(200);
    const list = (await defaultWorkers.json()) as Array<{ id: string }>;
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((w) => w.id)).toContain("w_ws_test");
  });

  test("GIT-REPO-01 新空间创建仓库：复合唯一键查重不 500（回归）", async ({
    request,
  }) => {
    const fresh = await createWorkspace(request, admin, `仓库空间-${ts}`);
    const tok = await switchWorkspace(request, admin, fresh.id);

    const cred = await request.post(`${API_BASE}/git-credentials`, {
      headers: headers(tok),
      data: {
        name: `e2e-cred-${ts}`,
        authType: "https_token",
        key: "tok-regression",
      },
    });
    expect(cred.status()).toBe(201);
    const credentialId = ((await cred.json()) as { id: string }).id;

    const repo = await request.post(`${API_BASE}/git-repos`, {
      headers: headers(tok),
      data: {
        repoUrl: `git@example.com:e2e/repo-${ts}.git`,
        credentialId,
        grantedAgents: [],
      },
    });
    expect(repo.status()).toBe(201);
    const body = (await repo.json()) as { id: string; workspaceId?: string };
    expect(body.id).toBeTruthy();
    expect(body.workspaceId).toBe(fresh.id);

    // 同空间重复创建 → 409（而不是 500）
    const dup = await request.post(`${API_BASE}/git-repos`, {
      headers: headers(tok),
      data: {
        repoUrl: `git@example.com:e2e/repo-${ts}.git`,
        credentialId,
        grantedAgents: [],
      },
    });
    expect(dup.status()).toBe(409);

    // 另一空间可以建同 URL 仓库（空间内唯一，不跨空间冲突）
    const fresh2 = await createWorkspace(request, admin, `仓库空间二-${ts}`);
    const tok2 = await switchWorkspace(request, admin, fresh2.id);
    const cred2 = await request.post(`${API_BASE}/git-credentials`, {
      headers: headers(tok2),
      data: {
        name: `e2e-cred2-${ts}`,
        authType: "https_token",
        key: "tok-regression-2",
      },
    });
    expect(cred2.status()).toBe(201);
    const credentialId2 = ((await cred2.json()) as { id: string }).id;
    const repo2 = await request.post(`${API_BASE}/git-repos`, {
      headers: headers(tok2),
      data: {
        repoUrl: `git@example.com:e2e/repo-${ts}.git`,
        credentialId: credentialId2,
        grantedAgents: [],
      },
    });
    expect(repo2.status()).toBe(201);
  });

  test("RES-L07 平台资源（技能/工具/模型目录）各空间共享只读", async ({
    request,
  }) => {
    for (const ep of ["skills", "tools", "models"]) {
      // skills/tools 默认可见性：平台管理员含停用、普通成员仅启用；统一 enabled=true
      // 才能比较「共享目录是否一致」，否则停用资源会制造假差异。
      const q = ep === "models" ? "?pageSize=1" : "?pageSize=1&enabled=true";
      const w = await request.get(`${API_BASE}/${ep}${q}`, {
        headers: headers(adminW),
      });
      const m = await request.get(`${API_BASE}/${ep}${q}`, {
        headers: headers(memberM),
      });
      expect(w.status()).toBe(200);
      expect(m.status()).toBe(200);
      const wt = Number(((await w.json()) as { total: number }).total);
      const mt = Number(((await m.json()) as { total: number }).total);
      // 平台资源所有空间看到的目录一致（系统空间只读共享）
      expect(wt).toBe(mt);
      // 技能必然有 seed 的 8 条；工具/模型目录允许为空（取决于部署/worker 上报）
      if (ep === "skills") expect(wt).toBeGreaterThan(0);
    }
  });

  test("FILE-01 上传文件按空间落盘且 URL 带空间段", async ({ request }) => {
    const upload = await request.post(`${API_BASE}/uploads`, {
      headers: headers(adminW),
      multipart: {
        file: {
          name: "isolation.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("workspace isolation"),
        },
      },
    });
    expect(upload.status()).toBe(201);
    const meta = (await upload.json()) as { url: string };
    expect(meta.url).toMatch(
      new RegExp(`^/uploads/workspaces/${W.id.replace(/[^A-Za-z0-9_-]/g, "-")}/`),
    );
    const origin = new URL(API_BASE).origin;
    const fetch = await request.get(`${origin}${meta.url}`);
    expect(fetch.status()).toBe(200);
  });

  test("WS-04/WS-05 邀请后可访问，移除后失去访问", async ({ request }) => {
    const a = await login(request, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    const m = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);
    const aW = await switchWorkspace(request, a.token, W.id);

    expect(
      (
        await request.post(`${API_BASE}/workspaces/${W.id}/members`, {
          headers: headers(aW),
          data: { userId: "u_seed_member" },
        })
      ).status(),
    ).toBe(201);

    // 被邀请后可切换并读取 W 数据
    const mW = await switchWorkspace(request, m.token, W.id);
    const teams = await listTeams(request, mW);
    expect(teams.items.map((t) => t.name)).toContain(teamW.name);

    // 移除后：切回自己空间（lastWorkspace 更新）+ header 越权 403
    expect(
      (
        await request.delete(
          `${API_BASE}/workspaces/${W.id}/members/u_seed_member`,
          { headers: headers(aW) },
        )
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.get(`${API_BASE}/teams`, {
          headers: headers(m.token, W.id),
        })
      ).status(),
    ).toBe(403);
  });

  test("SHARE-01/02 迁移到系统空间共享、再回收", async ({ request }) => {
    const a = await login(request, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    const m = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);
    const agent = await createAgent(
      request,
      adminW,
      `共享Agent-${ts}`,
      `share-${ts}`,
    );

    const share = await request.post(`${API_BASE}/workspaces/relocations`, {
      headers: headers(a.token),
      data: {
        resourceType: "agent",
        resourceId: agent.id,
        targetWorkspaceId: "ws_system",
        reason: "matrix share",
      },
    });
    expect(share.status()).toBe(201);
    expect(((await share.json()) as { moved: boolean }).moved).toBe(true);
    // M 空间可见（平台资源共享）
    expect(
      (await listAgents(request, m.token)).items.map((x) => x.id),
    ).toContain(agent.id);

    // 回收（无引用）
    const recycle = await request.post(`${API_BASE}/workspaces/relocations`, {
      headers: headers(a.token),
      data: {
        resourceType: "agent",
        resourceId: agent.id,
        targetWorkspaceId: W.id,
        reason: "matrix recycle",
      },
    });
    expect(recycle.status()).toBe(201);
    expect(
      (await listAgents(request, m.token)).items.map((x) => x.id),
    ).not.toContain(agent.id);
  });

  test("SHARE-03 迁移唯一键冲突 → 409", async ({ request }) => {
    const a = await login(request, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    const key = `dup-${ts}`;
    const agentW = await createAgent(request, adminW, `冲突W-${ts}`, key);
    await createAgent(request, memberM, `冲突M-${ts}`, key);

    const res = await request.post(`${API_BASE}/workspaces/relocations`, {
      headers: headers(a.token),
      data: {
        resourceType: "agent",
        resourceId: agentW.id,
        targetWorkspaceId: M.id,
      },
    });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      "WORKSPACE_RELOCATE_CONFLICT",
    );
  });

  test("SHARE-05/06/07 迁移权限、审计可见性、业务数据不可迁移", async ({
    request,
  }) => {
    const a = await login(request, E2E_ADMIN_USERNAME, E2E_ADMIN_PASSWORD);
    const m = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);

    // 非管理员迁移 → 403
    expect(
      (
        await request.post(`${API_BASE}/workspaces/relocations`, {
          headers: headers(m.token),
          data: {
            resourceType: "agent",
            resourceId: "a_0000000001",
            targetWorkspaceId: M.id,
          },
        })
      ).status(),
    ).toBe(403);
    // 非管理员审计 → 403；管理员 → 200
    expect(
      (
        await request.get(`${API_BASE}/workspaces/relocations`, {
          headers: headers(m.token),
        })
      ).status(),
    ).toBe(403);
    const audit = await request.get(`${API_BASE}/workspaces/relocations?limit=50`, {
      headers: headers(a.token),
    });
    expect(audit.status()).toBe(200);
    expect(((await audit.json()) as unknown[]).length).toBeGreaterThan(0);
    // 业务数据（team）不可迁移 → 400
    expect(
      (
        await request.post(`${API_BASE}/workspaces/relocations`, {
          headers: headers(a.token),
          data: {
            resourceType: "team",
            resourceId: teamW.id,
            targetWorkspaceId: M.id,
          },
        })
      ).status(),
    ).toBe(400);
  });


  test("JOIN-01 Worker 加入码：管理员签发、成员不可签发、注册强制校验", async ({
    request,
  }) => {
    const m = await login(request, "seed-member", E2E_SEED_ADMIN_PASSWORD);
    // 成员不能签发
    expect(
      (
        await request.post(`${API_BASE}/workspaces/${W.id}/worker-token`, {
          headers: headers(m.token),
        })
      ).status(),
    ).toBe(403);

    // 管理员签发（明文只返回一次）
    const issue = await request.post(
      `${API_BASE}/workspaces/${W.id}/worker-token`,
      { headers: headers(adminW) },
    );
    expect(issue.status()).toBe(201);
    const joinToken = ((await issue.json()) as { joinToken: string }).joinToken;
    expect(joinToken).toMatch(/^wst_[0-9a-f]{48}$/);

    const globalWorkerToken =
      process.env.WORKER_TOKEN ?? "ws-test-worker-token";
    const workerId = `w_e2e_join_${ts}`;
    const base = {
      workerId,
      name: "e2e-join-worker",
      opencodeVersion: "2.0.32",
      capabilities: { maxInstances: 1, skills: [], tools: [] },
      load: { instances: 0 },
      workspaceId: W.id,
    };
    // 未携带加入码 → 403
    const denied = await request.post(`${API_BASE}/workers/register`, {
      headers: { "X-Worker-Token": globalWorkerToken },
      data: base,
    });
    expect(denied.status()).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe(
      "WORKER_JOIN_TOKEN_INVALID",
    );
    // 携带正确加入码 → 201（并落 W 空间）
    const ok = await request.post(`${API_BASE}/workers/register`, {
      headers: { "X-Worker-Token": globalWorkerToken },
      data: { ...base, joinToken },
    });
    expect(ok.status()).toBe(201);
    const wWorkers = (await (
      await request.get(`${API_BASE}/workers`, { headers: headers(adminW) })
    ).json()) as Array<{ id: string }>;
    expect(wWorkers.map((w) => w.id)).toContain(workerId);
  });

  test("UPLOAD-SIGN-01 上传 URL 带签名；无签名/篡改访问 403", async ({
    request,
  }) => {
    const upload = await request.post(`${API_BASE}/uploads`, {
      headers: headers(adminW),
      multipart: {
        file: {
          name: "signed.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("signed upload"),
        },
      },
    });
    expect(upload.status()).toBe(201);
    const { url } = (await upload.json()) as { url: string };
    expect(url).toMatch(/\?exp=\d+&sig=[0-9a-f]{32}$/);

    const origin = new URL(API_BASE).origin;
    expect((await request.get(`${origin}${url}`)).status()).toBe(200);
    // 去掉签名 → 403
    expect(
      (await request.get(`${origin}${url.split("?")[0]}`)).status(),
    ).toBe(403);
    // 篡改签名 → 403
    const tampered = url.replace(/sig=([0-9a-f]{32})/, (_, s) =>
      `sig=${"f".repeat(32) === s ? "0".repeat(32) : "f".repeat(32)}`,
    );
    expect((await request.get(`${origin}${tampered}`)).status()).toBe(403);
  });


  test("USER-SPACE-PATCH-01 编辑用户空间：增删成员关系并切换当前空间", async ({
    request,
  }) => {
    const roles = (await (
      await request.get(`${API_BASE}/roles`, { headers: headers(admin) })
    ).json()) as Array<{ id: string; name: string }>;
    const memberRoleId = roles.find((r) => r.name === "member")?.id;
    expect(memberRoleId).toBeTruthy();

    const username = `e2e_space_edit_${ts}`;
    const password = E2E_MEMBER_PASSWORD;
    const created = (await (
      await request.post(`${API_BASE}/users`, {
        headers: headers(admin),
        data: {
          username,
          password,
          displayName: username,
          email: `${username}@example.com`,
          roleId: memberRoleId,
          workspaceId: M.id,
          workspaceRole: "member",
        },
      })
    ).json()) as { id: string };
    const userId = created.id;

    // 1) 加入 W 并把当前空间切到 W
    const patched = await request.patch(`${API_BASE}/users/${userId}`, {
      headers: headers(admin),
      data: { workspaceIds: [M.id, W.id], currentWorkspaceId: W.id },
    });
    expect(patched.status()).toBe(200);
    const patchedBody = (await patched.json()) as {
      lastWorkspaceId: string;
      workspaceMembers: Array<{ workspaceId: string }>;
    };
    expect(patchedBody.lastWorkspaceId).toBe(W.id);
    expect(patchedBody.workspaceMembers.map((m) => m.workspaceId).sort()).toEqual(
      [M.id, W.id].sort(),
    );

    // 2) 重新登录：当前空间 = W，空间列表包含 M/W
    const logged = await login(request, username, password);
    expect(logged.user.currentWorkspaceId).toBe(W.id);
    // ws_system（平台空间）对所有用户隐式只读可见，比较时排除
    const joinedIds = (logged.user.workspaces ?? [])
      .filter((w) => w.id !== "ws_system")
      .map((w) => w.id)
      .sort();
    expect(joinedIds).toEqual([M.id, W.id].sort());

    // 3) 移出 M（只留 W）：成员关系删除
    const removed = await request.patch(`${API_BASE}/users/${userId}`, {
      headers: headers(admin),
      data: { workspaceIds: [W.id], currentWorkspaceId: W.id },
    });
    expect(removed.status()).toBe(200);
    const removedBody = (await removed.json()) as {
      workspaceMembers: Array<{ workspaceId: string }>;
    };
    expect(removedBody.workspaceMembers.map((m) => m.workspaceId)).toEqual([
      W.id,
    ]);
    const relogin = await login(request, username, password);
    expect(
      (relogin.user.workspaces ?? [])
        .filter((w) => w.id !== "ws_system")
        .map((w) => w.id),
    ).toEqual([W.id]);

    // 4) 当前空间必须包含在集合内 / 空间必须存在
    const invalidCurrent = await request.patch(`${API_BASE}/users/${userId}`, {
      headers: headers(admin),
      data: { workspaceIds: [W.id], currentWorkspaceId: M.id },
    });
    expect(invalidCurrent.status()).toBe(400);
    const invalidSpace = await request.patch(`${API_BASE}/users/${userId}`, {
      headers: headers(admin),
      data: { workspaceIds: ["ws_not_exists"], currentWorkspaceId: null },
    });
    expect(invalidSpace.status()).toBe(400);
  });

  test("USER-WS-01 创建用户时选择空间：新用户登录即在该空间", async ({
    request,
  }) => {
    // 取内置 member 角色 id
    const roles = (await (
      await request.get(`${API_BASE}/roles`, { headers: headers(admin) })
    ).json()) as Array<{ id: string; name: string }>;
    const memberRoleId = roles.find((r) => r.name === "member")?.id;
    expect(memberRoleId).toBeTruthy();

    const username = `e2e_space_user_${ts}`;
    const password = E2E_MEMBER_PASSWORD;
    const created = await request.post(`${API_BASE}/users`, {
      headers: headers(admin),
      data: {
        username,
        password,
        displayName: username,
        email: `${username}@example.com`,
        roleId: memberRoleId,
        workspaceId: M.id,
        workspaceRole: "admin",
      },
    });
    expect(created.status()).toBe(201);

    // 新用户登录：当前空间 = 所选空间，且空间列表包含它
    const logged = await login(request, username, password);
    expect(logged.user.currentWorkspaceId).toBe(M.id);
    expect((logged.user.workspaces ?? []).map((w) => w.id)).toContain(M.id);

    // 能读到该空间的团队（说明成员关系生效）
    const teams = (await (
      await request.get(`${API_BASE}/teams?pageSize=100`, {
        headers: headers(logged.token),
      })
    ).json()) as { items: Array<{ name: string }> };
    expect(teams.items.map((t) => t.name)).toContain(teamM.name);

    // 平台空间不可加入
    const systemDenied = await request.post(`${API_BASE}/users`, {
      headers: headers(admin),
      data: {
        username: `e2e_sys_user_${ts}`,
        password,
        displayName: "sys-user",
        roleId: memberRoleId,
        workspaceId: "ws_system",
      },
    });
    expect(systemDenied.status()).toBe(400);
    expect(((await systemDenied.json()) as { code: string }).code).toBe(
      "USER_WORKSPACE_SYSTEM_NOT_JOINABLE",
    );
  });


  test("ROLE-01 空间管理员：可管本空间平台功能，不能跨空间/平台级操作", async ({
    request,
  }) => {
    const roles = (await (
      await request.get(`${API_BASE}/roles`, { headers: headers(admin) })
    ).json()) as Array<{ id: string; name: string }>;
    const memberRoleId = roles.find((r) => r.name === "member")?.id;

    // 平台管理员创建：平台角色=member，空间角色=M 的空间管理员
    const username = `e2e_space_admin_${ts}`;
    const password = E2E_MEMBER_PASSWORD;
    const created = await request.post(`${API_BASE}/users`, {
      headers: headers(admin),
      data: {
        username,
        password,
        displayName: username,
        roleId: memberRoleId,
        workspaceId: M.id,
        workspaceRole: "admin",
      },
    });
    expect(created.status()).toBe(201);

    const sa = await login(request, username, password);
    expect(sa.user.currentWorkspaceId).toBe(M.id);

    expect(
      (
        await request.get(`${API_BASE}/workspaces/all`, {
          headers: headers(sa.token),
        })
      ).status(),
    ).toBe(403);
    expect(
      (await request.get(`${API_BASE}/users`, { headers: headers(sa.token) }))
        .status(),
    ).toBe(403);
    expect(
      (
        await request.post(`${API_BASE}/workspaces/relocations`, {
          headers: headers(sa.token),
          data: {
            resourceType: "agent",
            resourceId: "a_0000000001",
            targetWorkspaceId: "ws_system",
          },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.get(`${API_BASE}/teams`, {
          headers: headers(sa.token, W.id),
        })
      ).status(),
    ).toBe(403);

    expect(
      (
        await request.post(`${API_BASE}/teams`, {
          headers: headers(sa.token),
          data: { name: `空间管理员团队-${ts}` },
        })
      ).status(),
    ).toBe(201);

    const mcp = await request.post(`${API_BASE}/mcp-servers`, {
      headers: headers(sa.token),
      data: {
        name: `e2e-space-admin-mcp-${ts}`,
        type: "remote",
        url: "https://example.com/mcp",
      },
    });
    expect(mcp.status()).toBe(201);
    const mcpInM = (await (
      await request.get(`${API_BASE}/mcp-servers?pageSize=100`, {
        headers: headers(sa.token),
      })
    ).json()) as { items?: Array<{ name: string }> } | Array<{ name: string }>;
    const mcpList = Array.isArray(mcpInM) ? mcpInM : (mcpInM.items ?? []);
    expect(mcpList.map((m) => m.name)).toContain(`e2e-space-admin-mcp-${ts}`);
    const mcpInW = (await (
      await request.get(`${API_BASE}/mcp-servers?pageSize=100`, {
        headers: headers(adminW),
      })
    ).json()) as { items?: Array<{ name: string }> } | Array<{ name: string }>;
    const mcpWList = Array.isArray(mcpInW) ? mcpInW : (mcpInW.items ?? []);
    expect(mcpWList.map((m) => m.name)).not.toContain(
      `e2e-space-admin-mcp-${ts}`,
    );
  });


  test("MCP-ISO-01 双通道 GET 隔离：JWT 与 worker 列表都不串空间", async ({
    request,
  }) => {
    // M 空间 owner（seed-member）创建一个 MCP server（空间管理员通道）
    const name = `e2e-mcp-iso-${ts}`;
    const created = await request.post(`${API_BASE}/mcp-servers`, {
      headers: headers(memberM),
      data: { name, type: "remote", url: "https://example.com/mcp" },
    });
    expect(created.status()).toBe(201);

    const namesOf = (body: unknown) => {
      const rows = Array.isArray(body)
        ? body
        : ((body as { items?: Array<{ name: string }> }).items ?? []);
      return rows.map((r) => r.name);
    };

    // JWT 通道：W 空间、默认空间都看不到 M 空间的自定义 MCP
    for (const token of [adminW, admin]) {
      const body = await (
        await request.get(`${API_BASE}/mcp-servers?pageSize=200`, {
          headers: headers(token),
        })
      ).json();
      expect(namesOf(body)).not.toContain(name);
    }
    // worker 通道：默认空间 worker 只应拿到「默认空间 + 系统空间」资源
    const workerRes = await request.get(`${API_BASE}/mcp-servers?pageSize=200`, {
      headers: {
        "X-Worker-Token": process.env.WORKER_TOKEN ?? "ws-test-worker-token",
        "x-worker-id": "w_ws_test",
      },
    });
    expect(workerRes.status()).toBe(200);
    expect(namesOf(await workerRes.json())).not.toContain(name);
  });


  test("TOKEN-SINGLE-01 空间注册令牌：单 token 注册、运行期鉴权、跨空间 403", async ({
    request,
  }) => {
    // 为 W 空间签发空间注册令牌（管理员）
    const issue = await request.post(`${API_BASE}/workspaces/${W.id}/worker-token`, {
      headers: headers(adminW),
    });
    expect(issue.status()).toBe(201);
    const spaceToken = ((await issue.json()) as { joinToken: string }).joinToken;
    expect(spaceToken).toMatch(/^wst_[0-9a-f]{48}$/);

    const workerId = `w_single_${ts}`;
    // 单令牌注册：只带 X-Worker-Token，不传 WORKSPACE_ID / WORKER_JOIN_TOKEN
    const reg = await request.post(`${API_BASE}/workers/register`, {
      headers: { "X-Worker-Token": spaceToken },
      data: {
        workerId,
        name: "single-token-worker",
        opencodeVersion: "2.0.32",
        capabilities: { maxInstances: 1, skills: [], tools: [] },
        load: { instances: 0 },
      },
    });
    expect(reg.status()).toBe(201);
    // 归属由令牌反查：只出现在 W 空间
    const wWorkers = (await (
      await request.get(`${API_BASE}/workers`, { headers: headers(adminW) })
    ).json()) as Array<{ id: string }>;
    expect(wWorkers.map((w) => w.id)).toContain(workerId);

    // 同一令牌可做运行期鉴权（心跳）
    const hb = await request.post(`${API_BASE}/workers/${workerId}/heartbeat`, {
      headers: { "X-Worker-Token": spaceToken },
      data: {
        workerId,
        load: { instances: 0 },
        health: "ok",
      },
    });
    expect(hb.status()).toBe(201);

    // 令牌不能冒充/操作其它空间的 worker（403 WORKER_SPACE_MISMATCH）
    const otherTokenIssue = await request.post(
      `${API_BASE}/workspaces/${M.id}/worker-token`,
      { headers: headers(memberM) },
    );
    const otherToken = ((await otherTokenIssue.json()) as { joinToken: string })
      .joinToken;
    const cross = await request.post(
      `${API_BASE}/workers/${workerId}/heartbeat`,
      {
        headers: { "X-Worker-Token": otherToken },
        data: { workerId, load: { instances: 0 }, health: "ok" },
      },
    );
    expect(cross.status()).toBe(403);
    expect(((await cross.json()) as { code: string }).code).toBe(
      "WORKER_SPACE_MISMATCH",
    );
  });


  test("TEAM-MEMBER-01 新空间按岗位建团队：自动创建成员不触发多空间唯一键冲突", async ({
    request,
  }) => {
    const fresh = await createWorkspace(request, admin, `团队重建-${ts}`);
    const tok = await switchWorkspace(request, admin, fresh.id);
    const created = await request.post(`${API_BASE}/teams`, {
      headers: headers(tok),
      data: {
        name: `岗位团队-${ts}`,
        members: [{ roleId: "ar_project_manager" }, { roleId: "ar_developer" }],
      },
    });
    expect(created.status()).toBe(201);
    const teamId = ((await created.json()) as { id: string }).id;

    const detail = (await (
      await request.get(`${API_BASE}/teams/${teamId}`, { headers: headers(tok) })
    ).json()) as { members: Array<{ memberId?: string; id?: string }> };
    expect(detail.members.length).toBeGreaterThanOrEqual(2);

    // 同名岗位再建一个团队：成员名自动加序号，不得 500
    const created2 = await request.post(`${API_BASE}/teams`, {
      headers: headers(tok),
      data: {
        name: `岗位团队二-${ts}`,
        members: [{ roleId: "ar_project_manager" }, { roleId: "ar_developer" }],
      },
    });
    expect(created2.status()).toBe(201);
    const members = (await (
      await request.get(`${API_BASE}/members?pageSize=100`, {
        headers: headers(tok),
      })
    ).json()) as { total: number };
    expect(Number(members.total)).toBeGreaterThanOrEqual(4);
  });
});