/**
 * Conversations API 封装（P2 会话聚合，37 篇 §5.3）
 * =============================================
 * 左列表唯一数据源：群聊 + 成员私聊平铺，含摘要/未读/置顶。
 * 消息历史继续用既有 /channels/:id/messages（条目里带 channelId）。
 */
import { api } from "@/lib/api";

export interface ConversationLastMessage {
  id: string;
  text: string;
  senderType: string;
  senderName: string | null;
  createdAt: string;
}

export interface ConversationItemDto {
  /** group:<teamId> | dm:<memberId> */
  id: string;
  type: "group" | "dm";
  title: string;
  badge: "群" | "成员";
  channelId: string | null;
  contextTeamId: string | null;
  memberCount?: number;
  unreadCount: number;
  pinned: boolean;
  lastMessage: ConversationLastMessage | null;
}

export interface ConversationsPage {
  items: ConversationItemDto[];
  total: number;
}

export const conversationsApi = {
  list(params?: {
    type?: "group" | "dm";
    keyword?: string;
    unreadOnly?: boolean;
  }): Promise<ConversationsPage> {
    return api.get<ConversationsPage>("/conversations", {
      query: params as Record<string, string | boolean | undefined>,
    });
  },
};
