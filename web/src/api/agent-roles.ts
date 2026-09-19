/**
 * AgentRole API 封装（agent-role-entity todo 6 的消费端）
 * =============================================
 * 对齐 server/src/agent-roles：GET /agent-roles（分页 + type 过滤）、GET /agent-roles/:id、
 * POST /agent-roles（仅 type=custom；key 唯一）、PATCH /agent-roles/:id、DELETE /agent-roles/:id
 * （内置 → 403 AGENT_ROLE_BUILTIN_READONLY；被成员引用 → 409 AGENT_ROLE_IN_USE）。
 * 角色**无任何能力字段**（permission/tools/model/worker 属 Agent / ExecutionPolicy）。
 */
import { api } from "@/lib/api";

export type AgentRoleType = "builtin" | "custom";

export interface AgentRoleDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: AgentRoleType | string;
  defaultAgentId: string | null;
  rolePrompt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRolesPage {
  items: AgentRoleDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateAgentRolePayload {
  name: string;
  key: string;
  type: "custom";
  description?: string;
  defaultAgentId?: string | null;
  rolePrompt?: string;
  sortOrder?: number;
}

export interface UpdateAgentRolePayload {
  name?: string;
  description?: string | null;
  defaultAgentId?: string | null;
  rolePrompt?: string | null;
  sortOrder?: number;
}

export const agentRolesApi = {
  list(params?: { page?: number; pageSize?: number; type?: AgentRoleType }): Promise<AgentRolesPage> {
    return api.get<AgentRolesPage>("/agent-roles", {
      query: params as Record<string, string | number | undefined>,
    });
  },
  get(id: string): Promise<AgentRoleDto> {
    return api.get<AgentRoleDto>(`/agent-roles/${id}`);
  },
  create(payload: CreateAgentRolePayload): Promise<AgentRoleDto> {
    return api.post<AgentRoleDto>("/agent-roles", payload);
  },
  update(id: string, payload: UpdateAgentRolePayload): Promise<AgentRoleDto> {
    return api.patch<AgentRoleDto>(`/agent-roles/${id}`, payload);
  },
  remove(id: string): Promise<void> {
    return api.delete<void>(`/agent-roles/${id}`);
  },
};
