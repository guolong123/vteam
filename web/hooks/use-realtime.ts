"use client";

/**
 * 实时事件 → Query 缓存桥（Phase 2 群聊/看板共享 hook，供 T13 群聊页直接 import）。
 * =============================================
 * 在 useSSE（T5，全站单例连接池）之上分发五类 Phase 2 业务事件（事件名对齐
 * server/src/common/constants/event.constants.ts 点号命名）：
 * - chat.message.new     → 默认追加至 ['channel', <channelId>, 'messages'] 缓存（幂等去重，
 *                          不覆盖已加载历史；无既有缓存时不凭空创建）
 * - task.status.changed  → 默认 invalidateQueries(['tasks'])（看板缓存前缀失效重取）
 * - agent.loading / agent.error → 仅回调（页面按 messageId/agentId 聚合 loading/失败状态）
 * - team.changed         → 仅回调（页面按 taskId 失效频道/团队缓存刷新成员面板）
 * 每个事件同时暴露 onXxx 回调，页面可在默认行为之外自行处理（如滚动到底）。
 *
 * 连接模型：全站共享 useSSE 单例连接（URL 恒 scope=all，按 token 分池，页面切换不重建），
 * 事件在 useSSE 层以连接级游标补拉重放给全部订阅者；本 hook 用 matchesScope 按
 * options.scope 前端过滤后分发（scope 支持逗号分隔多段，如 "channel:c1,task:t1,global"）。
 * 同一事件可能命中多个订阅实例，各页面回调内仍须按 payload.taskId / payload.channelId
 * 二次过滤（不能丢）；补拉重放的消息由 appendMessage 幂等去重兜底，安全。
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSSE, matchesScope, type SSEEvent } from "@/hooks/use-sse";

/** Phase 2 五类业务事件名（对齐后端 EVENT_TYPES，禁止下划线变体）。 */
const EVENT = {
  CHAT_MESSAGE_NEW: "chat.message.new",
  AGENT_LOADING: "agent.loading",
  AGENT_ERROR: "agent.error",
  TASK_STATUS_CHANGED: "task.status.changed",
  TEAM_CHANGED: "team.changed",
  ARTIFACT_SUBMITTED: "artifact.submitted",
  SESSION_UPDATED: "session.updated",
  AGENT_STATUS: "agent.status",
} as const;

/* ------------------------------ 事件 payload 类型（对齐后端） ------------------------------ */

/** 消息发送方（对齐 event.constants SENDER_TYPE）。 */
export type RealtimeSenderType = "user" | "agent" | "system";

/** 消息内容（后端 messages.content Json：{text, parts}；Phase 2 parts 恒空数组）。 */
export interface RealtimeMessageContent {
  text: string;
  parts?: unknown[];
}

/** chat.message.new payload.message（对齐 ChatService.toMessageDto）。 */
export interface RealtimeChatMessage {
  id: string;
  channelId: string;
  senderType: RealtimeSenderType;
  senderId: string | null;
  content: RealtimeMessageContent;
  mentions: unknown[];
  /** UX-10 附件（客户端先 POST /uploads 拿 url 随消息提交；无附件为 null） */
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentType?: string | null;
  status: string;
  createdAt: string;
}

/** chat.message.new 事件 payload：{ message }（08 篇 §7.3 先落库后广播）。 */
export interface ChatMessageEvent {
  message: RealtimeChatMessage;
}

/** task.status.changed 事件 payload（对齐 T7 transition 广播，task.status.changed 为 global scope）。 */
export interface TaskStatusEvent {
  taskId: string;
  from: string | null;
  to: string;
  actorType: string;
  actorId: string;
}

/** agent.loading 事件 payload（对齐 ChatService 第 7 步广播，task scope，phase=thinking）。 */
export interface AgentLoadingEvent {
  taskId: string;
  agentId: string;
  sessionId: string | null;
  phase: string;
}

/** agent.error 事件 payload（09 篇 §4.2；后端 worker 回流后 emit，Phase 3 前仅定义契约）。 */
export interface AgentErrorEvent {
  taskId: string;
  agentId: string;
  messageId?: string | null;
  level?: string;
  errorType: string;
}

/** team.changed 事件 payload（对齐 T8 updateTeam 广播，逐 Agent 一条，task scope）。 */
export interface TeamChangedEvent {
  taskId: string;
  action: "add" | "remove";
  agentId: string;
}

/** artifact.submitted 事件 payload（对齐 T12 产出物提交广播，task scope）。 */
export interface ArtifactSubmittedEvent {
  taskId: string;
  type: string;
  title: string;
  content?: string;
  fileRef?: string;
}

/**
 * session.updated 事件 payload（对齐 EVENT_TYPES.SESSION_UPDATED，T1 契约；worker 回流后 emit）。
 * status 对齐 SESSION_STATUS：created / active / frozen / archived。
 * - active（运行中）→ 页面展示「Agent 会话运行中」指示
 * - frozen / archived → 会话终止，收敛 loading 指示器
 */
export interface SessionUpdatedEvent {
  sessionId: string;
  taskId?: string | null;
  agentId?: string | null;
  status: string;
}

/**
 * agent.status 事件 payload（对齐 EVENT_TYPES.AGENT_STATUS，T1 契约；worker 回流后 emit）。
 * 与 agent.loading 的差异：loading 是阶段（thinking/operating），status 是终结态收敛信号，
 * status=running 表示会话开始执行、completed/failed 表示执行结束（可据此收敛 loading）。
 */
export interface AgentStatusEvent {
  taskId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  status: string;
}

/** 消息列表缓存结构（对齐 GET /channels/:id/messages 分页响应 {items, nextCursor}）。 */
export interface ChannelMessagesCache {
  items: RealtimeChatMessage[];
  nextCursor: string | null;
}

/* ------------------------------ hook 选项 ------------------------------ */

export interface UseRealtimeEventsOptions {
  /** 前端过滤规则（不再透传 useSSE 的 URL scope；连接 URL 恒 scope=all）：
   *  如 "channel:<id>" / "task:<id>"；支持逗号分隔多 scope
   *  （如 "channel:c1,task:t1,global"，前端 split(',') 过滤）；缺省 = 放行全部。 */
  scope?: string;
  /** 是否启用连接（透传 useSSE），默认 true。 */
  enabled?: boolean;
  /** 首连是否跳过历史重放（透传 useSSE，默认 true）：历史由 REST 加载，SSE 仅实时增量。 */
  skipHistory?: boolean;
  /** chat.message.new：默认已追加消息缓存，回调供页面额外处理（如滚动到底）。 */
  onMessage?: (payload: ChatMessageEvent, event: SSEEvent<ChatMessageEvent>) => void;
  /** task.status.changed：默认已 invalidate ['tasks']，回调供页面额外处理。 */
  onTaskStatusChanged?: (payload: TaskStatusEvent, event: SSEEvent<TaskStatusEvent>) => void;
  /** agent.loading：页面按 agentId/messageId 聚合 loading 状态。 */
  onAgentLoading?: (payload: AgentLoadingEvent, event: SSEEvent<AgentLoadingEvent>) => void;
  /** agent.error：页面按 messageId 标记失败。 */
  onAgentError?: (payload: AgentErrorEvent, event: SSEEvent<AgentErrorEvent>) => void;
  /** team.changed：页面按 taskId 失效团队/频道缓存（members-panel 刷新）。 */
  onTeamChanged?: (payload: TeamChangedEvent, event: SSEEvent<TeamChangedEvent>) => void;
  /** artifact.submitted：页面收到产出物提交事件后刷新聚合列表（如 /artifacts 页）。 */
  onArtifactSubmitted?: (payload: ArtifactSubmittedEvent, event: SSEEvent<ArtifactSubmittedEvent>) => void;
  /** session.updated：页面按 sessionId/agentId 展示 Agent 会话状态（运行中/已完成/已归档）。 */
  onSessionUpdated?: (payload: SessionUpdatedEvent, event: SSEEvent<SessionUpdatedEvent>) => void;
  /** agent.status：页面按 agentId 收敛 loading（status=running 开始 / completed|failed 结束）。 */
  onAgentStatus?: (payload: AgentStatusEvent, event: SSEEvent<AgentStatusEvent>) => void;
}

/**
 * Phase 2 实时事件桥：共享 useSSE 单例连接（scope=all），按 options.scope 前端过滤分发。
 * 回调与 useSSE 同语义：存于 ref，父组件 re-render 不重建连接。
 */
export function useRealtimeEvents(options: UseRealtimeEventsOptions): void {
  const {
    scope,
    enabled = true,
    skipHistory = true,
    onMessage,
    onTaskStatusChanged,
    onAgentLoading,
    onAgentError,
    onTeamChanged,
    onArtifactSubmitted,
    onSessionUpdated,
    onAgentStatus,
  } = options;
  const queryClient = useQueryClient();

  useSSE<unknown>({
    scope: "all",
    enabled,
    skipHistory,
    onEvent: (ev) => {
      if (!matchesScope(ev, scope)) return;
      switch (ev.type) {
        case EVENT.CHAT_MESSAGE_NEW: {
          const payload = ev.payload as ChatMessageEvent;
          appendMessage(queryClient, payload.message);
          onMessage?.(payload, ev as SSEEvent<ChatMessageEvent>);
          break;
        }
        case EVENT.TASK_STATUS_CHANGED: {
          const payload = ev.payload as TaskStatusEvent;
          // 看板缓存 queryKey 前缀 ["tasks", pid, status] 一并失效重取
          queryClient.invalidateQueries({ queryKey: ["tasks"] });
          onTaskStatusChanged?.(payload, ev as SSEEvent<TaskStatusEvent>);
          break;
        }
        case EVENT.AGENT_LOADING:
          onAgentLoading?.(ev.payload as AgentLoadingEvent, ev as SSEEvent<AgentLoadingEvent>);
          break;
        case EVENT.AGENT_ERROR:
          onAgentError?.(ev.payload as AgentErrorEvent, ev as SSEEvent<AgentErrorEvent>);
          break;
        case EVENT.TEAM_CHANGED:
          onTeamChanged?.(ev.payload as TeamChangedEvent, ev as SSEEvent<TeamChangedEvent>);
          break;
        case EVENT.ARTIFACT_SUBMITTED:
          onArtifactSubmitted?.(ev.payload as ArtifactSubmittedEvent, ev as SSEEvent<ArtifactSubmittedEvent>);
          break;
        case EVENT.SESSION_UPDATED:
          onSessionUpdated?.(ev.payload as SessionUpdatedEvent, ev as SSEEvent<SessionUpdatedEvent>);
          break;
        case EVENT.AGENT_STATUS:
          onAgentStatus?.(ev.payload as AgentStatusEvent, ev as SSEEvent<AgentStatusEvent>);
          break;
      }
    },
  });
}

/**
 * 消息追加（幂等）：SSE 断线重连经 since 补拉可能重复投递同一事件，按 id 去重；
 * 无既有缓存（页面尚未加载历史）时不凭空创建，交由页面 onMessage 自行处理。
 */
function appendMessage(queryClient: QueryClient, message: RealtimeChatMessage): void {
  queryClient.setQueryData<ChannelMessagesCache>(
    ["channel", message.channelId, "messages"],
    (old) => {
      if (!old) return old; // 无缓存：不创建，避免与页面首次 fetch 竞争
      if (old.items.some((m) => m.id === message.id)) return old; // 幂等去重
      return { ...old, items: [...old.items, message] };
    },
  );
}
