/**
 * Teams API 封装（全局团队域）
 * =============================================
 * 对齐 server/src/teams：GET /teams 分页搜索、POST /teams、GET/PATCH/DELETE /teams/:id、
 * POST/PATCH/DELETE /teams/:id/members、POST /teams/:id/reset-sessions。
 * 所有方法经 web/lib/api 统一鉴权与错误归一。
 */
import { api } from "@/lib/api";

export interface TeamMemberDto {
  id: string;
  teamId: string;
  agentId: string;
  roleId?: string | null;
  alias: string;
  seq: number;
  workDir: string;
  overrideModelId?: string | null;
  /** 成员级首选 worker id（null = 跟随团队级选择）。 */
  preferredWorkerId?: string | null;
  /** 成员会话当前实际绑定的 worker id（null = 尚无会话 / 未绑定任何节点）。
   *  与 preferredWorkerId 可能不一致：服务端在下一次派发时才把会话迁到首选节点，
   *  且仅当目标节点当前可用。 */
  currentWorkerId?: string | null;
  /** opencode 原生 agent 名（null = 不指定，用引擎默认 agent）。 */
  opencodeAgentName?: string | null;
  agent?: { id: string; name: string; role: string | null };
  createdAt?: string;
}

export interface TeamUserMemberDto {
  id: string;
  userId: string;
  role: string;
  joinedAt: string;
}

export interface TeamDto {
  id: string;
  name: string;
  description: string | null;
  reuseSession: boolean;
  managedMode: boolean;
  currentTaskId: string | null;
  currentTaskTitle?: string | null;
  currentTaskStatus?: string | null;
  /** 当前活跃任务数（in_progress + blocked，并行调度顶栏计数用）。 */
  activeTaskCount?: number;
  /**
   * 团队常驻群聊的最后活动时间（ISO 字符串；null = 从未活动）。
   * 团队切换器按它倒序排列（最近有对话的团队排最前，从未活动的排最后）。
   */
  lastActivityAt?: string | null;
  /** 团队并发上限（null = 不限；start 时后端校验 TEAM_PARALLEL_LIMIT）。 */
  maxConcurrentTasks?: number | null;
  mainAgentMemberId: string | null;
  /** 团队级首选 worker id（null = 自动调度到任意可用节点；节点删除后为悬空软引用）。 */
  preferredWorkerId?: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: TeamMemberDto[];
  userMembers: TeamUserMemberDto[];
}

export interface TeamsPage {
  items: TeamDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateTeamPayload {
  name: string;
  description?: string;
  reuseSession?: boolean;
  members?: { agentId?: string; roleId?: string; alias?: string; workDir?: string }[];
  mainAgentMemberId?: string;
}

export interface UpdateTeamPayload {
  name?: string;
  description?: string | null;
  reuseSession?: boolean;
  managedMode?: boolean;
  mainAgentMemberId?: string | null;
  /** 团队级首选 worker id（显式 null / 空串 = 清除选择，回自动调度；弱校验不校验节点存在性）。 */
  preferredWorkerId?: string | null;
  version?: number;
}

export interface AddMemberPayload {
  agentId?: string;
  roleId?: string;
  alias?: string;
  workDir?: string;
}

export interface UpdateMemberPayload {
  alias?: string;
  workDir?: string;
  overrideModelId?: string | null;
  /** opencode 原生 agent 名（空字符串/null = 清除选择，回引擎默认 agent）。 */
  opencodeAgentName?: string | null;
  roleId?: string | null;
  agentId?: string;
}

export interface AddUserMemberPayload {
  userId: string;
  role?: string;
}

export const teamsApi = {
  list(params: { page?: number; pageSize?: number; name?: string }): Promise<TeamsPage> {
    return api.get<TeamsPage>("/teams", { query: params as Record<string, string | number | undefined> });
  },
  get(id: string): Promise<TeamDto> {
    return api.get<TeamDto>(`/teams/${id}`);
  },
  create(payload: CreateTeamPayload): Promise<TeamDto> {
    return api.post<TeamDto>("/teams", payload);
  },
  update(id: string, payload: UpdateTeamPayload): Promise<TeamDto> {
    return api.patch<TeamDto>(`/teams/${id}`, payload);
  },
  remove(id: string): Promise<{ deleted: boolean; id: string }> {
    return api.delete<{ deleted: boolean; id: string }>(`/teams/${id}`);
  },
  addMember(teamId: string, payload: AddMemberPayload): Promise<TeamDto> {
    return api.post<TeamDto>(`/teams/${teamId}/members`, payload);
  },
  updateMember(teamId: string, memberId: string, payload: UpdateMemberPayload): Promise<TeamDto> {
    return api.patch<TeamDto>(`/teams/${teamId}/members/${memberId}`, payload);
  },
  removeMember(teamId: string, memberId: string): Promise<TeamDto> {
    return api.delete<TeamDto>(`/teams/${teamId}/members/${memberId}`);
  },
  addUserMember(teamId: string, payload: AddUserMemberPayload): Promise<TeamDto> {
    return api.post<TeamDto>(`/teams/${teamId}/users`, payload);
  },
  removeUserMember(teamId: string, userId: string): Promise<TeamDto> {
    return api.delete<TeamDto>(`/teams/${teamId}/users/${userId}`);
  },
  resetSessions(teamId: string): Promise<{ reset: number; teamId: string }> {
    return api.post<{ reset: number; teamId: string }>(`/teams/${teamId}/reset-sessions`);
  },
};
