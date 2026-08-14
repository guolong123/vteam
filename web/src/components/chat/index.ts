/**
 * 群聊过程消息组件统一出口（Phase 2 group-chat 页面局部组件迁移）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移的 5 类过程消息
 * （thinking / tool / error / aborted / loading），视觉与原型一致，
 * token 引用统一走 src/theme/tokens.ts。ChatBubble（user/agent/system 三态）
 * 复用共享组件 src/components/ui/chat-bubble.tsx，不在此重复导出。
 *
 * 引入方式：
 *   import { LoadingIndicator, MsgThinking, MsgTool, MsgError, MsgAborted } from "@/src/components/chat";
 */
export { LoadingDots, LoadingIndicator } from "./loading-indicator";
export type { LoadingDotsProps, LoadingIndicatorProps } from "./loading-indicator";
export { MsgThinking } from "./msg-thinking";
export type { MsgThinkingProps } from "./msg-thinking";
export { MsgTool } from "./msg-tool";
export type { MsgToolProps } from "./msg-tool";
export { MsgError } from "./msg-error";
export type { MsgErrorProps } from "./msg-error";
export { MsgAborted } from "./msg-aborted";
export type { MsgAbortedProps } from "./msg-aborted";
export { MsgParts } from "./msg-parts";
export type { MsgPartsProps, PartShape } from "./msg-parts";
export { QuestionModal } from "./question-modal";
export type { QuestionModalProps, QuestionModalData } from "./question-modal";
