/**
 * 外部渠道用户 API 封装（外部渠道用户管理，契约 3.1）
 * =============================================
 * 对齐 server/src/external-users：目录列表 / 详情 / 资料维护 / 只读消息回看。
 * 外部用户由入站消息（企微 / 通用 webhook 等）自动沉淀，前端只做只读回看 +
 * 人工维护资料（姓名 / 岗位 / 所属公司 / 联系方式），不新增发送能力。
 */
import { api } from "@/lib/api";

/** 左侧目录行：name 由后端解析为 name ?? displayName。 */
export interface ExternalUserListItem {
  id: string;
  /** 展示名：管理字段 name 优先，未填写时回落渠道 displayName。 */
  name: string;
  /** 渠道展示名（企微用户名/昵称，入站可更新）。 */
  displayName: string;
  position: string | null;
  company: string | null;
  contact: string | null;
  /** 来源渠道类型：wecom_aibot / generic_webhook / legacy。 */
  source: string;
  /** 外部平台稳定标识：id:<企微 userid> 或 name:<展示名>。 */
  externalId: string;
  messageCount: number;
  groupCount: number;
  lastMessageAt: string | null;
  lastMessageText: string | null;
}

/** 详情里的群聊分布项。 */
export interface ExternalUserGroupRef {
  teamId: string;
  /** 团队名在团队被删/历史数据下可能为空，展示时回落 teamId。 */
  teamName: string | null;
  channelId: string;
  messageCount: number;
  lastMessageAt: string | null;
}

/** 详情 = 列表项 + 首次发言/创建时间/群聊分布。 */
export interface ExternalUserDetail extends ExternalUserListItem {
  firstMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  groups: ExternalUserGroupRef[];
}

export interface ExternalUserMessageAttachment {
  url: string;
  name?: string | null;
  size?: number | null;
  ext?: string | null;
}

/** 只读消息回看条目（不含发送者字段：固定是该外部用户所发）。 */
export interface ExternalUserMessage {
  id: string;
  channelId: string;
  /** 频道所属团队（按可见性查询必然命中；后端防御性可空）。 */
  teamId: string | null;
  teamName: string | null;
  /** 正文；历史空消息的 bodyText 可能为 null，渲染时兜底空串。 */
  text: string | null;
  attachments?: ExternalUserMessageAttachment[] | null;
  status: string;
  createdAt: string;
}

export interface ExternalUserMessagesPage {
  items: ExternalUserMessage[];
  nextCursor: string | null;
}

/** 资料维护入参：全部可选，空串由后端视为清空（存 null）。 */
export interface UpdateExternalUserPayload {
  name?: string;
  position?: string;
  company?: string;
  contact?: string;
}

export interface ExternalUsersPage {
  items: ExternalUserListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const externalUsersApi = {
  list(params?: {
    keyword?: string;
    page?: number;
    pageSize?: number;
  }): Promise<ExternalUsersPage> {
    return api.get<ExternalUsersPage>("/external-users", {
      query: params as Record<string, string | number | undefined>,
    });
  },
  get(id: string): Promise<ExternalUserDetail> {
    return api.get<ExternalUserDetail>(
      `/external-users/${encodeURIComponent(id)}`,
    );
  },
  update(
    id: string,
    payload: UpdateExternalUserPayload,
  ): Promise<ExternalUserDetail> {
    return api.patch<ExternalUserDetail>(
      `/external-users/${encodeURIComponent(id)}`,
      payload,
    );
  },
  messages(
    id: string,
    params?: { cursor?: string; limit?: number },
  ): Promise<ExternalUserMessagesPage> {
    return api.get<ExternalUserMessagesPage>(
      `/external-users/${encodeURIComponent(id)}/messages`,
      { query: params as Record<string, string | number | undefined> },
    );
  },
};
