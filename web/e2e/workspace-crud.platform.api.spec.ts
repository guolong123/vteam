import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME } from "./e2e-credentials";

type JsonObj = Record<string, unknown>;

/** 平台/全局资源 CRUD 全面体检（平台管理员，在独立新空间内执行）。 */
const API_BASE = process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";
const ADMIN = { username: E2E_ADMIN_USERNAME, password: E2E_ADMIN_PASSWORD };

async function login(request: APIRequestContext, username: string, password: string) {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { username, password } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { accessToken: string; user: { id: string } };
}
async function createWorkspace(request: APIRequestContext, token: string, name: string) {
  const res = await request.post(`${API_BASE}/workspaces`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; name: string };
}
async function switchWorkspace(request: APIRequestContext, token: string, id: string) {
  const res = await request.post(`${API_BASE}/auth/workspace`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { workspaceId: id },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { accessToken: string }).accessToken;
}
const h = (token: string) => ({ Authorization: `Bearer ${token}` });
async function body(res: APIResponse) {
  try { return await res.json(); } catch { return await res.text(); }
}
async function expectStatus(res: APIResponse, code: number, label: string) {
  if (res.status() !== code) {
    throw new Error(`${label}: 期望 ${code}，实际 ${res.status()}，响应=${JSON.stringify(await body(res)).slice(0, 600)}`);
  }
}

test.describe.serial("平台资源 CRUD 全量体检", () => {
  const ts = Date.now();
  let adminToken = "";
  let token = "";
  let spaceId = "";

  test.beforeAll(async ({ request }) => {
    const a = await login(request, ADMIN.username, ADMIN.password);
    adminToken = a.accessToken;
    const ws = await createWorkspace(request, adminToken, `CRUD平台-${ts}`);
    spaceId = ws.id;
    token = await switchWorkspace(request, adminToken, spaceId);
  });

  test("ROLE：角色创建 → 查询 → 修改 → 删除", async ({ request }) => {
    const permissions = Object.fromEntries(
      ["tasks", "chats", "artifacts", "agents", "workers", "skills", "users", "roles"].map((r) => [
        r, { view: false, create: false, edit: false, delete: false, review: false, manage: false },
      ]),
    );
    ((permissions as unknown as JsonObj).tasks as JsonObj).view = true;
    const created = await request.post(`${API_BASE}/roles`, { headers: h(token), data: { name: `crud-role-${ts}`, permissions } });
    await expectStatus(created, 201, "创建角色");
    const role = (await created.json()) as { id: string };
    const list = await request.get(`${API_BASE}/roles`, { headers: h(token) });
    expect((await list.json()).some((r: JsonObj) => String(r.id) === role.id)).toBeTruthy();
    await expectStatus(await request.patch(`${API_BASE}/roles/${role.id}`, { headers: h(token), data: { name: `crud-role-${ts}-v2` } }), 200, "修改角色");
    await expectStatus(await request.delete(`${API_BASE}/roles/${role.id}`, { headers: h(token) }), 200, "删除角色");
  });

  test("AGENT-ROLE：岗位创建 → 查询 → 修改 → 删除", async ({ request }) => {
    const created = await request.post(`${API_BASE}/agent-roles`, {
      headers: h(token),
      data: { name: `CRUD岗位-${ts}`, key: `crud-role-${ts}`, type: "custom", rolePrompt: "CRUD 测试岗位" },
    });
    await expectStatus(created, 201, "创建岗位");
    const role = (await created.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/agent-roles/${role.id}`, { headers: h(token) }), 200, "查询岗位");
    await expectStatus(await request.patch(`${API_BASE}/agent-roles/${role.id}`, { headers: h(token), data: { description: "更新后的描述" } }), 200, "修改岗位");
    await expectStatus(await request.delete(`${API_BASE}/agent-roles/${role.id}`, { headers: h(token) }), 200, "删除岗位");
  });

  test("AGENT：Agent 创建 → 查询 → 修改 → 克隆 → 删除", async ({ request }) => {
    const created = await request.post(`${API_BASE}/agents`, {
      headers: h(token),
      data: { name: `CRUD Agent ${ts}`, type: "custom", agentKey: `crud-agent-${ts}`, prompt: "CRUD 测试 Agent" },
    });
    await expectStatus(created, 201, "创建 Agent");
    const agent = (await created.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/agents/${agent.id}`, { headers: h(token) }), 200, "查询 Agent");
    await expectStatus(await request.patch(`${API_BASE}/agents/${agent.id}`, { headers: h(token), data: { name: `CRUD Agent ${ts} v2` } }), 200, "修改 Agent");
    const cloned = await request.post(`${API_BASE}/agents/${agent.id}/clone`, {
      headers: h(token), data: { agentKey: `crud-agent-${ts}-clone` },
    });
    await expectStatus(cloned, 201, "克隆 Agent");
    const clone = (await cloned.json()) as { id: string };
    await expectStatus(await request.delete(`${API_BASE}/agents/${clone.id}`, { headers: h(token) }), 200, "删除克隆 Agent");
    await expectStatus(await request.delete(`${API_BASE}/agents/${agent.id}`, { headers: h(token) }), 200, "删除 Agent");
  });

  test("POLICY：执行策略创建 → 查询 → 修改 → 删除", async ({ request }) => {
    const created = await request.post(`${API_BASE}/execution-policies`, {
      headers: h(token),
      data: { name: `CRUD 策略 ${ts}`, type: "custom", config: { permission: { read: { "*": "allow" }, edit: { "*": "deny" } }, correction: {} } },
    });
    await expectStatus(created, 201, "创建策略");
    const policy = (await created.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/execution-policies/${policy.id}`, { headers: h(token) }), 200, "查询策略");
    await expectStatus(await request.patch(`${API_BASE}/execution-policies/${policy.id}`, { headers: h(token), data: { description: "更新后的策略描述" } }), 200, "修改策略");
    await expectStatus(await request.delete(`${API_BASE}/execution-policies/${policy.id}`, { headers: h(token) }), 200, "删除策略");
  });

  test("MODEL/PROVIDER：模型创建 → 查询 → Provider 修改 → Provider 删除", async ({ request }) => {
    const providerID = `crud-provider-${ts}`;
    const created = await request.post(`${API_BASE}/models`, {
      headers: h(token), data: { providerID, modelID: "crud-model", name: "CRUD Model", providerType: "cloud" },
    });
    await expectStatus(created, 201, "创建模型");
    const model = (await created.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/models/${model.id}`, { headers: h(token) }), 200, "查询模型");
    const providers = await (await request.get(`${API_BASE}/models/providers`, { headers: h(token) })).json();
    expect(providers.some((p: JsonObj) => String(p.providerID) === providerID)).toBeTruthy();
    await expectStatus(await request.patch(`${API_BASE}/models/providers/${providerID}`, { headers: h(token), data: { baseUrl: "https://example.com/v1" } }), 200, "修改 Provider");
    await expectStatus(await request.delete(`${API_BASE}/models/providers/${providerID}`, { headers: h(token) }), 200, "删除 Provider");
  });

  test("SKILL：上传创建 → 内容读取 → 修改 → 启停", async ({ request }) => {
    const name = `crud-skill-${ts}`;
    const md = `---\nname: ${name}\ndescription: CRUD 测试技能\n---\n\n# CRUD Skill\n\n测试正文。\n`;
    const created = await request.post(`${API_BASE}/skills`, {
      headers: h(token),
      multipart: { file: { name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from(md, "utf-8") } },
    });
    await expectStatus(created, 201, "上传技能");
    const skill = (await created.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/skills/${skill.id}/content`, { headers: h(token) }), 200, "读取技能内容");
    await expectStatus(await request.patch(`${API_BASE}/skills/${skill.id}`, { headers: h(token), data: { description: "更新后的技能描述" } }), 200, "修改技能");
    await expectStatus(await request.patch(`${API_BASE}/skills/${skill.id}/status`, { headers: h(token), data: { enabled: true } }), 200, "启用技能");
  });

  test("TOOL：工具创建 → 列表 → 修改", async ({ request }) => {
    const created = await request.post(`${API_BASE}/tools`, {
      headers: h(token),
      data: { name: `CRUD 工具 ${ts}`, action: `crud-tool-${ts}`, execution: "code", schema: { type: "object", properties: {} }, initCommand: [] },
    });
    await expectStatus(created, 201, "创建工具");
    const tool = (await created.json()) as { id: string };
    const list = await request.get(`${API_BASE}/tools?pageSize=100&name=${encodeURIComponent(`CRUD 工具 ${ts}`)}`, { headers: h(token) });
    expect((await list.json()).items.some((t: JsonObj) => String(t.id) === tool.id)).toBeTruthy();
    await expectStatus(await request.patch(`${API_BASE}/tools/${tool.id}`, { headers: h(token), data: { enabled: false } }), 200, "修改工具");
  });

  test("MCP-SERVER：创建 → 查询 → 修改 → 删除", async ({ request }) => {
    const name = `crud-mcp-${ts}`;
    const created = await request.post(`${API_BASE}/mcp-servers`, { headers: h(token), data: { name, type: "remote", url: "https://example.com/mcp" } });
    await expectStatus(created, 201, "创建 MCP Server");
    const server = (await created.json()) as { id: string };
    await expectStatus(await request.get(`${API_BASE}/mcp-servers/${server.id}`, { headers: h(token) }), 200, "查询 MCP Server");
    await expectStatus(await request.patch(`${API_BASE}/mcp-servers/${server.id}`, { headers: h(token), data: { url: "https://example.com/mcp-v2" } }), 200, "修改 MCP Server");
    await expectStatus(await request.delete(`${API_BASE}/mcp-servers/${server.id}`, { headers: h(token) }), 200, "删除 MCP Server");
  });

  test("WORKER：注册创建 → 列表 → 修改 → 删除", async ({ request }) => {
    test.setTimeout(180_000);
    const workerId = `crud-worker-${ts}`;
    const issued = await request.post(`${API_BASE}/workspaces/${spaceId}/worker-token`, { headers: h(token) });
    await expectStatus(issued, 201, "签发空间注册令牌");
    const issuedBody = (await issued.json()) as { joinToken: string };
    const reg = await request.post(`${API_BASE}/workers/register`, {
      headers: { "X-Worker-Token": issuedBody.joinToken },
      data: { workerId, name: workerId, opencodeVersion: "2.0.32", capabilities: { maxInstances: 2, skills: [], tools: [] }, load: { instances: 0 } },
    });
    await expectStatus(reg, 201, "注册 worker");
    const list = await request.get(`${API_BASE}/workers`, { headers: h(token) });
    const workers = (await list.json()) as JsonObj;
    const workerItems = (Array.isArray(workers)
      ? workers
      : ((workers.items ?? []) as unknown[])) as JsonObj[];
    expect(workerItems.some((w: JsonObj) => String(w.id) === workerId)).toBeTruthy();
    await expectStatus(await request.patch(`${API_BASE}/workers/${workerId}`, { headers: h(token), data: { maxInstances: 3 } }), 200, "修改 worker");
    // 在线 worker 拒绝删除（409 WORKER_ONLINE_NOT_REMOVABLE）；心跳超时转 offline 后再删
    const onlineDel = await request.delete(`${API_BASE}/workers/${workerId}`, { headers: h(token) });
    expect([200, 409]).toContain(onlineDel.status());
    if (onlineDel.status() === 409) {
      let offline = false;
      for (let i = 0; i < 18 && !offline; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const rows = (await (await request.get(`${API_BASE}/workers`, { headers: h(token) })).json()) as JsonObj;
        const items = (Array.isArray(rows)
          ? rows
          : ((rows.items ?? []) as unknown[])) as JsonObj[];
        offline = items.some((w: JsonObj) => String(w.id) === workerId && String(w.status) === "offline");
      }
      await expectStatus(await request.delete(`${API_BASE}/workers/${workerId}`, { headers: h(token) }), 200, "删除离线 worker");
    }
  });

  test("UPLOAD：上传 → 读取签名 URL", async ({ request }) => {
    const up = await request.post(`${API_BASE}/uploads`, {
      headers: h(token),
      multipart: { file: { name: "crud.txt", mimeType: "text/plain", buffer: Buffer.from("crud upload", "utf-8") } },
    });
    await expectStatus(up, 201, "上传文件");
    const payload = (await up.json()) as { url: string };
    expect(payload.url).toBeTruthy();
    const origin = new URL(API_BASE).origin;
    const fileUrl = payload.url.startsWith("http") ? payload.url : `${origin}${payload.url}`;
    const got = await request.get(fileUrl);
    await expectStatus(got, 200, "读取上传文件");
    expect(await got.text()).toBe("crud upload");
  });
});
