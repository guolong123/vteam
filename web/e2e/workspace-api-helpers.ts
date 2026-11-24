import { expect, type APIRequestContext } from "@playwright/test";

/**
 * 多工作空间隔离测试的 API 小工具（Playwright request 上下文）。
 * 仅依赖公开 HTTP API，不直接读写数据库。
 */
export const API_BASE =
  process.env.WORKSPACE_API_BASE ?? "http://127.0.0.1:13200/api/v1";

export interface LoginResult {
  token: string;
  user: {
    id: string;
    username: string;
    currentWorkspaceId?: string | null;
    workspaces?: Array<{ id: string; name: string; isSystem: boolean; role: string }>;
  };
}

export async function login(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<LoginResult> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { username, password },
  });
  expect(res.status(), `login ${username}`).toBe(200);
  const body = (await res.json()) as {
    accessToken: string;
    user: LoginResult["user"];
  };
  return { token: body.accessToken, user: body.user };
}

export function headers(token: string, workspaceId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
  };
}

export async function createWorkspace(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const res = await request.post(`${API_BASE}/workspaces`, {
    headers: headers(token),
    data: { name },
  });
  expect(res.status(), `create workspace ${name}`).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

export async function switchWorkspace(
  request: APIRequestContext,
  token: string,
  workspaceId: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/workspace`, {
    headers: headers(token),
    data: { workspaceId },
  });
  expect(res.status(), `switch workspace ${workspaceId}`).toBe(200);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

export async function createTeam(
  request: APIRequestContext,
  token: string,
  name: string,
  workspaceId?: string,
): Promise<{ id: string; name: string }> {
  const res = await request.post(`${API_BASE}/teams`, {
    headers: headers(token, workspaceId),
    data: { name },
  });
  expect(res.status(), `create team ${name}`).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

export async function listTeams(
  request: APIRequestContext,
  token: string,
  workspaceId?: string,
): Promise<{ total: number; items: Array<{ id: string; name: string }> }> {
  const res = await request.get(`${API_BASE}/teams?pageSize=200`, {
    headers: headers(token, workspaceId),
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    total: number;
    items: Array<{ id: string; name: string }>;
  };
}

export async function createAgent(
  request: APIRequestContext,
  token: string,
  name: string,
  agentKey: string,
  workspaceId?: string,
): Promise<{ id: string; agentKey: string }> {
  const res = await request.post(`${API_BASE}/agents`, {
    headers: headers(token, workspaceId),
    data: { name, type: "custom", agentKey, prompt: "test" },
  });
  expect(res.status(), `create agent ${name}`).toBe(201);
  return (await res.json()) as { id: string; agentKey: string };
}

export async function listAgents(
  request: APIRequestContext,
  token: string,
  workspaceId?: string,
): Promise<{ total: number; items: Array<{ id: string; agentKey?: string }> }> {
  const res = await request.get(`${API_BASE}/agents?pageSize=300`, {
    headers: headers(token, workspaceId),
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    total: number;
    items: Array<{ id: string; agentKey?: string }>;
  };
}
