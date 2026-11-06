/**
 * Members API 封装（成员库，37 篇 §5.1）
 * =============================================
 * 对齐 server/src/members：列表/详情/创建/更新/删除/所在群聊/克隆。
 * 成员是平台级资源；席位（TeamMember）仍由 teams API 管理。
 */
import { api } from "@/lib/api";

export interface MemberRoleRef {
  id: string;
  key: string;
  name: string;
}

export interface MemberAgentRef {
  id: string;
  name: string;
  agentKey?: string | null;
}

export interface MemberModelRef {
  id: string;
  name: string;
  modelID?: string;
}

export interface MemberWorkerRef {
  id: string;
  name: string | null;
  status: string;
}

export interface MemberDto {
  id: string;
  name: string;
  status: "active" | "disabled";
  description: string | null;
  privateWorkDir: string | null;
  defaultRoleId: string;
  agentId: string;
  defaultModelId: string | null;
  preferredWorkerId: string | null;
  role: MemberRoleRef | null;
  agent: MemberAgentRef | null;
  defaultModel: MemberModelRef | null;
  preferredWorker: MemberWorkerRef | null;
  groupCount: number;
  notificationChannelCount: number;
  /** P3 全局会话摘要（列表/详情均返回；null = 尚未建立会话）。 */
  session?: MemberSessionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemberGroupRef {
  teamId: string;
  teamName: string | null;
  seatId: string;
  alias: string | null;
  seq: number;
  roleId: string | null;
}

export interface MemberNotificationChannelRef {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

export interface MemberSessionSummary {
  id: string;
  status: string;
  workerId: string | null;
  instanceRef: string | null;
  busyState: string;
  busySince: string | null;
  turnSeq: number;
  lastTurnOutcome: string | null;
}

export interface MemberDetailDto extends MemberDto {
  groups: MemberGroupRef[];
  notificationChannels: MemberNotificationChannelRef[];
  /** P3 全局会话摘要（null = 尚未建立会话）。 */
  session?: MemberSessionSummary | null;
}

export interface MembersPage {
  items: MemberDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateMemberPayload {
  name: string;
  roleId: string;
  agentId?: string;
  defaultModelId?: string;
  preferredWorkerId?: string;
  privateWorkDir?: string;
  description?: string;
}

export type UpdateMemberPayload = Partial<CreateMemberPayload> & {
  status?: "active" | "disabled";
};

export const membersApi = {
  list(params: {
    keyword?: string;
    roleId?: string;
    status?: "active" | "disabled";
    page?: number;
    pageSize?: number;
  }): Promise<MembersPage> {
    return api.get<MembersPage>("/members", {
      query: params as Record<string, string | number | undefined>,
    });
  },
  get(id: string): Promise<MemberDetailDto> {
    return api.get<MemberDetailDto>(`/members/${id}`);
  },
  create(payload: CreateMemberPayload): Promise<MemberDetailDto> {
    return api.post<MemberDetailDto>("/members", payload);
  },
  update(id: string, payload: UpdateMemberPayload): Promise<MemberDetailDto> {
    return api.patch<MemberDetailDto>(`/members/${id}`, payload);
  },
  remove(id: string): Promise<{ deleted: boolean; id: string }> {
    return api.delete<{ deleted: boolean; id: string }>(`/members/${id}`);
  },
  listTeams(id: string): Promise<{ items: MemberGroupRef[]; total: number }> {
    return api.get<{ items: MemberGroupRef[]; total: number }>(
      `/members/${id}/teams`,
    );
  },
  clone(id: string): Promise<MemberDetailDto> {
    return api.post<MemberDetailDto>(`/members/${id}/clone`);
  },
  /** P3：重置成员全局会话（不动消息/记忆；任务完成不再自动重置）。 */
  resetSession(id: string): Promise<{ reset: number; sessionId: string | null }> {
    return api.post<{ reset: number; sessionId: string | null }>(
      `/members/${id}/reset-session`,
    );
  },
};
