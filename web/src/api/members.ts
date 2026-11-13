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

/** 成员提示词与 Agent 提示词的关系（对齐后端 promptMode）。 */
export type MemberPromptMode = "append" | "override";

export interface MemberDto {
  id: string;
  name: string;
  status: "active" | "disabled";
  description: string | null;
  privateWorkDir: string | null;
  defaultRoleId: string;
  agentId: string;
  /** 成员性格（PERSONA_LIBRARY key；null=未配置；非空时优先于 Agent 性格）。 */
  persona: string | null;
  /** 成员专属提示词（成员级特殊行为描述；null=未配置）。 */
  prompt: string | null;
  /** 与 Agent 岗位职责提示词的关系：append=追加（默认）/ override=覆盖【职责】段。 */
  promptMode: MemberPromptMode;
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
  /** 该群聊席位的工作目录（团队工作目录）。 */
  workDir?: string | null;
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
  /** 最近活跃/处理中的团队（P3 全局会话上下文）。 */
  currentTeamId?: string | null;
}

export interface MemberDetailDto extends MemberDto {
  groups: MemberGroupRef[];
  notificationChannels: MemberNotificationChannelRef[];
  /**
   * 该成员绑定的入站消息渠道（2026-11-13 新增）：绑定后企微等渠道的消息
   * **直达该成员私聊**（全局一条 DM，与团队无关）。
   */
  messageChannels?: MemberNotificationChannelRef[];
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
  /** 缺省时后端按岗位自动生成（如 胡一开）。 */
  name?: string;
  roleId: string;
  agentId?: string;
  defaultModelId?: string;
  preferredWorkerId?: string;
  privateWorkDir?: string;
  description?: string;
  /** 成员性格 key（steady/strict/aggressive/conservative/innovative）；null=清除。 */
  persona?: string | null;
  /** 成员专属提示词；null=清除。 */
  prompt?: string | null;
  /** 成员提示词组合方式（缺省 append）。 */
  promptMode?: MemberPromptMode;
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
  /**
   * 删除成员。
   * 默认仍有席位 → 409 `MEMBER_IN_USE`（details.canCascade/teams 供前端提示）；
   * 用户确认「连同群聊席位一起删除」后带 `cascadeSeats` 重放，服务端在同一事务里
   * 先移出全部席位再删成员，返回里带上被移出的群聊。
   */
  remove(
    id: string,
    options?: { cascadeSeats?: boolean },
  ): Promise<{
    deleted: boolean;
    id: string;
    removedSeats?: Array<{ teamId: string; teamName: string | null }>;
  }> {
    return api.delete(`/members/${id}`, {
      query: options?.cascadeSeats ? { cascadeSeats: "true" } : undefined,
    });
  },
  listTeams(id: string): Promise<{ items: MemberGroupRef[]; total: number }> {
    return api.get<{ items: MemberGroupRef[]; total: number }>(
      `/members/${id}/teams`,
    );
  },
  clone(id: string): Promise<MemberDetailDto> {
    return api.post<MemberDetailDto>(`/members/${id}/clone`);
  },
  /** P5：成员已绑定通知渠道（脱敏）。 */
  listNotificationChannels(id: string): Promise<MemberNotificationChannelRef[]> {
    return api.get<MemberNotificationChannelRef[]>(
      `/members/${id}/notification-channels`,
    );
  },
  /** P5：绑定成员通知渠道（replace-all；默认独占校验，冲突 409）。 */
  bindNotificationChannels(
    id: string,
    payload: { notificationChannelIds: string[]; replaceExisting?: boolean },
  ): Promise<{ memberId: string; notificationChannelIds: string[] }> {
    return api.put<{ memberId: string; notificationChannelIds: string[] }>(
      `/members/${id}/notification-channels`,
      payload,
    );
  },
  /** 读取成员绑定的入站消息渠道（渠道 → 成员，消息直达该成员私聊）。 */
  listMemberMessageChannels(
    id: string,
  ): Promise<MemberNotificationChannelRef[]> {
    return api.get<MemberNotificationChannelRef[]>(
      `/members/${id}/message-channels`,
    );
  },
  /** 绑定入站消息渠道到成员（replace-all；冲突时抛 CHANNEL_ALREADY_BOUND）。 */
  bindMemberMessageChannels(
    id: string,
    payload: { messageChannelIds: string[]; replaceExisting?: boolean },
  ): Promise<{ memberId: string; messageChannelIds: string[] }> {
    return api.post<{ memberId: string; messageChannelIds: string[] }>(
      `/members/${id}/message-channels`,
      payload,
    );
  },
  /** P3：重置成员全局会话（不动消息/记忆；任务完成不再自动重置）。 */
  resetSession(id: string): Promise<{ reset: number; sessionId: string | null }> {
    return api.post<{ reset: number; sessionId: string | null }>(
      `/members/${id}/reset-session`,
    );
  },
};
