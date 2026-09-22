/**
 * AgentRole API 封装（agent-role-entity todo 6 的消费端 + 平台能力点切片）
 * =============================================
 * 对齐 server/src/agent-roles：GET /agent-roles（分页 + type 过滤）、GET /agent-roles/:id、
 * POST /agent-roles（仅 type=custom；key 唯一）、PATCH /agent-roles/:id、DELETE /agent-roles/:id
 * （内置 → 403 AGENT_ROLE_BUILTIN_READONLY；被成员引用 → 409 AGENT_ROLE_IN_USE）。
 * 角色**无任何能力载荷字段**（permission/tools/model/worker 属 Agent / ExecutionPolicy）。
 * 平台 `vteam_*` MCP 工具的调用授权归**岗位的业务能力点**：`capabilities` 是
 * `{ 能力点 key: boolean }` 的**二进制** map（`false` = 拒绝；**缺失键 = 允许**；`null` =
 * 从未保存，按出厂默认展示）；保存提交完整 map（见 `role-capabilities.ts`）。
 * 本文件只做 DTO/传输，目录与归一化在 `role-capabilities.ts`。
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
  /** 外部引擎（opencode）agent 名；与 defaultAgentId 互斥（二者至多一个非空）。 */
  defaultOpencodeAgentName: string | null;
  /**
   * 平台能力点开关：能力点 key → 是否允许（`false` = 拒绝；缺失键 = 允许）。
   * `null` = 尚未保存过 → UI 展示出厂默认并明示；保存时提交完整 map。
   */
  capabilities: Record<string, boolean> | null;
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
  defaultOpencodeAgentName?: string | null;
  /** 完整能力点 map（目录内每个键都在；缺省不传 = 服务端保持/使用出厂默认）。 */
  capabilities?: Record<string, boolean> | null;
  rolePrompt?: string;
  sortOrder?: number;
}

export interface UpdateAgentRolePayload {
  name?: string;
  description?: string | null;
  defaultAgentId?: string | null;
  defaultOpencodeAgentName?: string | null;
  /** 完整能力点 map；内置岗位的 PATCH **只允许**携带本字段（身份字段仍只读）。 */
  capabilities?: Record<string, boolean> | null;
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
