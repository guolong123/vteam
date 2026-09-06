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
  alias: string;
  seq: number;
  workDir: string;
  agent?: { id: string; name: string; role: string | null };
  createdAt?: string;
}

export interface TeamQueueDto {
  id: string;
  teamId: string;
  taskId: string;
  position: number;
  enqueuedAt: string;
  taskTitle?: string | null;
  taskStatus?: string | null;
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
  currentTaskId: string | null;
  currentTaskTitle?: string | null;
  currentTaskStatus?: string | null;
  mainAgentMemberId: string | null;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: TeamMemberDto[];
  userMembers: TeamUserMemberDto[];
  queue: TeamQueueDto[];
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
  members?: { agentId: string; alias?: string; workDir?: string }[];
  mainAgentMemberId?: string;
}

export interface UpdateTeamPayload {
  name?: string;
  description?: string | null;
  reuseSession?: boolean;
  mainAgentMemberId?: string | null;
  version?: number;
}

export interface AddMemberPayload {
  agentId: string;
  alias?: string;
  workDir?: string;
}

export interface UpdateMemberPayload {
  alias?: string;
  workDir?: string;
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
  cancelQueue(teamId: string, taskId: string): Promise<TeamDto> {
    return api.delete<TeamDto>(`/teams/${teamId}/queue/${taskId}`);
  },
  enqueue(teamId: string, taskId: string): Promise<TeamDto> {
    return api.post<TeamDto>(`/teams/${teamId}/queue`, { taskId });
  },
};
