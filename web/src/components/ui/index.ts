/**
 * 共享 UI 组件库统一出口
 * =============================================
 * 8 个组件从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移，
 * 结构 / 样式 / data-testid 与原型一致，token 引用统一走 src/theme/tokens.ts。
 *
 * 引入方式：
 *   import { AgentAvatar, ChatBubble, ... } from "@/src/components/ui";
 */
export { AgentAvatar } from "./agent-avatar";
export type { AgentAvatarProps } from "./agent-avatar";
export { AgentBadge } from "./agent-badge";
export type { AgentBadgeProps } from "./agent-badge";
export { ChatBubble, AttachmentCard } from "./chat-bubble";
export type { ChatBubbleProps, ChatMessageType, ChatBubbleAttachment } from "./chat-bubble";
export { Markdown } from "./markdown";
export { MessageInput } from "./message-input";
export type {
  MessageInputProps,
  MentionableAgent,
  MessageMention,
  SendMessagePayload,
} from "./message-input";
export { StatusBadge } from "./status-badge";
export type { StatusBadgeProps } from "./status-badge";
export { EmptyState } from "./empty-state";
export type { EmptyStateProps } from "./empty-state";
export { ConfirmDialog } from "./confirm-dialog";
export type { ConfirmDialogProps } from "./confirm-dialog";
export { Pagination } from "./pagination";
export type { PaginationProps } from "./pagination";