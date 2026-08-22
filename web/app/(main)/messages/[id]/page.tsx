"use client";

/**
 * 私聊页（Phase 2 私聊能力 · FR-14，与群聊共用 Agent 会话）
 * =============================================
 * 唯一视觉来源：docs/agent-platform/prototypes/dm-chat/index.tsx（单栏布局 + AgentInfoBar + testid）。
 * - 单栏布局对齐原型：AgentInfoBar（头像/名/角色/状态 + 共用 session 标注）｜消息列表
 *   （chat-message-list，复用 ChatBubble + T13 chat 过程组件）｜Footer（查看历史会话 + MessageInput）。
 * - 数据链路：GET /channels/:id（channel 含 agent/task + agentMembers）→
 *   GET /channels/:id/messages?limit=50 游标分页（queryKey ['channel', id, 'messages'] 与 use-realtime 一致）。
 * - SSE 实时（09 篇 §4.2，两级 scope）：
 *   · channel:<id> → chat.message.new（useRealtimeEvents 默认追加缓存 + onMessage 滚到底/收敛 loading）
 *   · task:<taskId> → agent.loading（两阶段指示器）/ agent.error
 * - 私聊语义（原型「私聊不需要 @ 触发」）：mentionable=[]，发送时自动附带该 Agent 的 mention
 *   （仅当其仍在任务团队内，否则触发 400 MENTION_AGENT_NOT_IN_TEAM）→ 消息直接进入该 Agent 会话。
 * - 频道不存在（URL 直达 404）→ dm-error 提示 + 返回会话列表链接。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents, type RealtimeChatMessage } from "@/hooks/use-realtime";
import type { AgentStatusEvent, MessagePartDeltaEvent, RealtimeQuestionEvent, SessionUpdatedEvent } from "@/hooks/use-realtime";
import { AgentAvatar, AgentBadge, ChatBubble, MessageInput } from "@/src/components/ui";
import type { SendMessagePayload } from "@/src/components/ui";
import {
  LoadingIndicator,
  MsgError,
  MsgParts,
  QuestionModal,
} from "@/src/components/chat";
import type { QuestionModalData } from "@/src/components/chat";
import {
  type RoleKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** P4：processing 消息超时兜底阈值（0 表示禁用，已按需求禁用前端超时） */
const PROCESSING_TIMEOUT_MS = 0;

/** scoped CSS 动画（dm- 前缀防污染，对齐原型 dmAnimCss 的三连点弹跳） */
const dmCss = `
@keyframes dm-pulse { 0%, 100% { opacity: .3 } 50% { opacity: 1 } }
`;

/* ------------------------------ API 数据模型（对齐后端 toChannelDto） ------------------------------ */

/** GET /channels/:id 响应：频道信息 + 任务团队未 removed 成员。 */
interface ChannelDetail {
  id: string;
  type: "task_group" | "private";
  taskId: string;
  agentId: string | null;
  /** 私聊频道绑定的任务实例 id（ta_ 前缀；后端 toChannelDto 未输出，可选防御）。 */
  taskAgentId?: string | null;
  task?: { id: string; title: string; status: string; projectId: string } | null;
  agent?: { id: string; name: string; role: string | null } | null;
  agentMembers: { id: string; name: string; role: string | null }[];
  createdAt: string;
}

/** GET /tasks/:id 的 instances 条目（T5：实例列表，alias 展示唯一标识）。 */
interface TaskInstance {
  id: string;
  agentId: string;
  alias: string | null;
  seq: number;
  name: string;
  role: string | null;
  main: boolean;
}

/** GET /channels/:id/messages 游标分页响应（对齐 use-realtime ChannelMessagesCache 结构）。 */
interface MessagesResponse {
  items: RealtimeChatMessage[];
  nextCursor: string | null;
}

/** GET /channels/:id/session-history 私聊会话历史响应（serve 完整会话 or 平台表回退）。 */
interface SessionHistoryResponse {
  items: RealtimeChatMessage[];
  nextCursor?: string | null;
  source: "session" | "db";
}

/**
 * 私聊历史数据源（DM 需求）：私聊频道 → session-history（opencode serve 完整会话，
 * source=session 全量返回，含 agent 思考/工具 parts）；回退/群聊 → findMessages 平台表。
 */
async function fetchChannelMessages(channelId: string, channelType?: string): Promise<MessagesResponse> {
  if (channelType === "private") {
    const res = await api.get<SessionHistoryResponse>(`/channels/${channelId}/session-history`);
    if (res.source === "session") {
      // serve 会话全量（无游标，不再加载更多）
      return { items: res.items, nextCursor: null };
    }
    // 回退平台表：items + 游标复用 findMessages 契约
    return { items: res.items, nextCursor: res.nextCursor ?? null };
  }
  return api.get<MessagesResponse>(`/channels/${channelId}/messages`, { query: { limit: 50 } });
}

/**
 * 私聊历史合并去重：初始快照来自 serve 会话（id 为 msg_ 前缀或 ses- 合成），SSE 增量
 * 来自平台消息（id=m_ 前缀）。快照 moment 若 agent 仍在流式，快照含未完成（processing）
 * assistant 消息，与 SSE 推送的同 sender processing/终态消息逻辑同源 → 用 SSE 消息替换
 * （不做双重渲染）；其余平台消息（用户新消息 / 新轮次 agent 回复）正常追加。时间正序输出。
 */
function mergeSnapshotWithLive(items: RealtimeChatMessage[]): RealtimeChatMessage[] {
  const snapshot = items.filter((m) => !m.id.startsWith("m_"));
  const live = items.filter((m) => m.id.startsWith("m_"));
  const out = [...snapshot];
  for (const msg of live) {
    if (msg.senderType === "agent") {
      let replaceIdx = -1;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const m = out[i];
        if (m.senderType === "agent" && m.senderId === msg.senderId && m.status === "processing") {
          replaceIdx = i;
          break;
        }
      }
      if (replaceIdx !== -1) {
        out[replaceIdx] = msg;
        continue;
      }
    }
    out.push(msg);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** GET /channels?type=task_group 条目（后端 ChatService.toChannelDto，含 taskId 可匹配任务，tasks 页同款）。 */
interface ChannelItem {
  id: string;
  type: string;
  taskId: string;
  agentId: string | null;
  task?: {
    id: string;
    title: string;
    status: string;
    projectId: string;
  } | null;
  agent?: { id: string; name: string; role: string | null } | null;
  createdAt: string;
}

/** seed 模板 Agent id → 角色 key（对齐 board AGENT_ID_ROLE）。 */
const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_project_manager: "project_manager",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

/** agent id / role 字符串 → RoleKey（未知/自定义跳过）。 */
function toRole(input: string): RoleKey | null {
  const direct = AGENT_ID_ROLE[input];
  if (direct) return direct;
  const rest = input.startsWith("a_") ? input.slice(2) : input;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
}

/** Agent role / id → 渲染角色（未知 Agent 用 developer 兜底，对齐群聊页）。 */
function resolveRole(agent?: { role: string | null } | null, id?: string | null): RoleKey {
  if (agent?.role) {
    const r = toRole(agent.role);
    if (r) return r;
  }
  if (id) {
    const r = toRole(id);
    if (r) return r;
  }
  return "developer";
}

/** ISO 时间 → HH:MM（对齐原型 time 显示）。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/* ================================ Agent 信息条（对齐原型 AgentInfoBar） ================================ */

function AgentInfoBar({
  name,
  role,
  meta,
  status,
  backHref,
}: {
  name: string;
  role: RoleKey;
  meta: string;
  status: string;
  backHref?: string;
}) {
  return (
    <header
      data-testid="dm-agent-info"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.lg}px ${space.xl}px ${space.lg}px 80px`,
        backgroundColor: neutral[50],
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {backHref && (
        <Link
          href={backHref}
          data-testid="dm-back-group"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: neutral[50],
            color: neutral[600],
            fontSize: fontSize.sm,
            fontWeight: 500,
            textDecoration: "none",
            flexShrink: 0,
            fontFamily: fontFamily.body,
          }}
        >
          ← 返回群聊
        </Link>
      )}
      <AgentAvatar role={role} size="lg" />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            {name}
          </span>
          <AgentBadge role={role} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, fontSize: fontSize.xs, color: neutral[500] }}>
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                backgroundColor: status === "在线" ? "#059669" : "#2563EB",
                display: "inline-block",
                animation: status === "在线" ? undefined : "dm-pulse 1.2s ease-in-out infinite",
              }}
            />
            {status}
          </span>
        </div>
        <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2, lineHeight: 1.5 }}>
          {meta} · 私聊会话（与群聊共用同一 session）
        </div>
      </div>
    </header>
  );
}

/* ================================ 群聊上下文区（私聊对话起点：群聊里 @agent 的用户消息） ================================ */

function GroupContextBar({
  messages,
  userId,
  myName,
}: {
  messages: RealtimeChatMessage[];
  userId: string;
  myName: string;
}) {
  if (messages.length === 0) return null;
  return (
    <div
      data-testid="group-context"
      style={{
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: `${space.md}px ${space.xl}px ${space.md}px 80px`,
        backgroundColor: neutral[50],
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <span style={{ fontSize: fontSize.xs, fontWeight: 600, color: neutral[400] }}>群聊上下文</span>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[100] }} />
      </div>
      {messages.map((msg) => (
        <div
          key={msg.id}
          data-testid="group-context-item"
          style={{ display: "flex", alignItems: "flex-start", gap: space.sm, minWidth: 0 }}
        >
          <span
            style={{
              flexShrink: 0,
              fontSize: fontSize.xs,
              color: neutral[500],
              backgroundColor: neutral[100],
              borderRadius: radius.sm,
              padding: `${2}px ${space.sm}px`,
              lineHeight: 1.6,
            }}
          >
            来自群聊
          </span>
          <span style={{ flexShrink: 0, fontSize: fontSize.sm, fontWeight: 600, color: neutral[900] }}>
            {msg.senderId === userId ? myName : msg.senderId ?? "我"}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: fontSize.sm,
              color: neutral[600],
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {msg.content?.text ?? ""}
          </span>
          <span style={{ flexShrink: 0, fontSize: fontSize.xs, color: neutral[400] }}>
            {formatTime(msg.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ================================ 消息列表（游标分页 + 过程消息渲染，复用 T13 模式） ================================ */

function DmMessageList({
  messages,
  nextCursor,
  loadingMore,
  agentMap,
  onLoadMore,
  loadingLabel,
  errorLabel,
  sessionLabel,
  listRef,
}: {
  messages: RealtimeChatMessage[];
  nextCursor: string | null;
  loadingMore: boolean;
  agentMap: Map<string, { name: string; role: RoleKey }>;
  onLoadMore: () => void;
  loadingLabel: string | null;
  errorLabel: { kind: "retry" | "quota"; detail: string } | null;
  sessionLabel: string | null;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  // P4：超时兜底时钟——processing 消息无 SSE 回流时页面静止，周期 tick 强制重渲染，
  // 让超过 PROCESSING_TIMEOUT_MS 的消息自动切换为失败形态
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div
      data-testid="chat-message-list"
      ref={listRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: `${space.xl}px ${space.xl}px ${space.xl}px 80px`,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        backgroundColor: neutral[50],
        ...baseFont,
      }}
    >
      {/* 会话开始分隔（对齐原型「今天 · 私聊」） */}
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>今天 · 私聊</span>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
      </div>

      {/* 游标分页：还有更多时显示「加载更多」（取更新消息追加尾部） */}
      {nextCursor && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            type="button"
            data-testid="chat-load-more"
            disabled={loadingMore}
            onClick={onLoadMore}
            style={{
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              fontSize: fontSize.sm,
              fontWeight: 500,
              cursor: loadingMore ? "default" : "pointer",
              opacity: loadingMore ? 0.6 : 1,
              fontFamily: fontFamily.body,
            }}
          >
            {loadingMore ? "加载中…" : "加载更多历史消息"}
          </button>
        </div>
      )}

      {messages.map((msg) => {
        const agent = msg.senderId ? agentMap.get(msg.senderId) : undefined;
        const role = agent?.role ?? (msg.senderId ? toRole(msg.senderId) : null) ?? "developer";
        const author = agent?.name ?? msg.senderId ?? "";
        const parts = Array.isArray((msg as unknown as { content?: { parts?: unknown } })?.content?.parts) ? ((msg as unknown as { content?: { parts?: unknown } })?.content?.parts as unknown[]) : [];

        // Agent 消息：parts 过程片段（thinking/tool/error/aborted）+ 正文置底（MsgParts，T14）；
        // status=processing 为流式中间态（message.part.delta 累积），正文走「生成中」流式块
        if (msg.senderType === "agent") {
          // P4 超时兜底：processing 超过阈值（worker abort 后无事件回流）→ 视觉降级失败形态，
          // 不再显示流式「生成中」；不修改 SSE 状态管理，仅渲染层判定
          const processing = msg.status === "processing";
          const timedOut =
            PROCESSING_TIMEOUT_MS > 0 &&
            processing &&
            Date.now() - new Date(msg.createdAt).getTime() > PROCESSING_TIMEOUT_MS;
          if (timedOut) {
            return (
              <div
                key={msg.id}
                data-testid="msg-timeout"
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: space.sm,
                  maxWidth: "78%",
                  alignSelf: "flex-start",
                  ...baseFont,
                }}
              >
                {role && <AgentAvatar role={role} size="sm" dot={false} style={{ marginTop: 2 }} />}
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: space.md,
                    borderRadius: radius.md,
                    backgroundColor: "rgba(239,68,68,0.10)",
                    border: "1px solid rgba(239,68,68,0.22)",
                    boxShadow: shadow.sm,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                    <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1, color: "#B91C1C" }}>⚠</span>
                    <span style={{ fontSize: fontSize.md, color: "#B91C1C", fontWeight: 600 }}>
                      Agent 处理超时/失败
                    </span>
                  </div>
                  <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: space.sm }}>
                    {author && <span>{author}</span>}
                    <span style={{ color: neutral[400] }}> · {formatTime(msg.createdAt)}</span>
                  </div>
                </div>
              </div>
            );
          }
          return (
            <MsgParts
              key={msg.id}
              parts={parts}
              bodyText={(msg.content?.text ?? "") as string}
              author={author}
              role={role}
              time={formatTime(msg.createdAt)}
              streaming={processing}
            />
          );
        }

        // 基础三型：user=右 / agent=左 / system=居中（复用共享 ChatBubble）
        if (msg.senderType === "system") {
          return (
            <ChatBubble key={msg.id} text={(msg.content?.text ?? "") as string} type="system" time={formatTime(msg.createdAt)} />
          );
        }
        return (
          <ChatBubble
            key={msg.id}
            text={(msg.content?.text ?? "") as string}
            type={msg.senderType === "user" ? "user" : "agent"}
            author={msg.senderType === "user" ? undefined : author}
            role={msg.senderType === "user" ? undefined : role}
            time={formatTime(msg.createdAt)}
            attachment={
              msg.attachmentUrl
                ? {
                    url: msg.attachmentUrl,
                    name: msg.attachmentName ?? msg.attachmentUrl,
                    ext: msg.attachmentType ?? "",
                  }
                : undefined
            }
          />
        );
      })}

      {/* Loading 两阶段指示器（agent.loading thinking/operating，收到回复时收敛） */}
      {loadingLabel && <LoadingIndicator label={loadingLabel} />}

      {/* 会话运行状态条（T14：session.updated status=active，真实 worker 回流后展示） */}
      {sessionLabel && (
        <div
          data-testid="session-status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            color: neutral[500],
            fontSize: fontSize.sm,
            padding: `${space.xs}px ${space.sm}px`,
            ...baseFont,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              backgroundColor: "#2563EB",
              animation: "dm-pulse 1.2s ease-in-out infinite",
            }}
          />
          {sessionLabel}…
        </div>
      )}

      {/* 消息级错误态（agent.error；isRetryable → 琥珀重试，否则红色升级引导） */}
      {errorLabel && (
        <MsgError
          kind={errorLabel.kind}
          detail={errorLabel.detail}
          time={formatTime(new Date().toISOString())}
        />
      )}
    </div>
  );
}

/* ================================ 页面（AppShell 内容区单栏） ================================ */

export default function DmChatPage() {
  const params = useParams<{ id: string }>();
  const channelId = params?.id ?? "";
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement | null>(null);

  // 输入（受控 MessageInput）
  const [input, setInput] = useState("");
  // Loading 两阶段：agentId → phase（thinking/operating）
  const [loadingByAgent, setLoadingByAgent] = useState<Record<string, string>>({});
  // agent.error：agentId → 错误文本（error 优先，缺省 errorType/message；展示错误态）
  const [errorByAgent, setErrorByAgent] = useState<Record<string, string>>({});
  // 会话状态：agentId → session.updated status（active/running=运行中 / frozen|archived=已结束，T14）
  const [sessionByAgent, setSessionByAgent] = useState<Record<string, string>>({});
  // sessionId → agentId 映射（session.updated payload 仅 {sessionId, status, workerId} 无 agentId，
  // 且 task scope 对 session.updated 无条件放行——须经 agent.loading/agent.status 事件建映射，
  // 解析归属为主 Agent 才更新，防跨任务串扰污染本页状态）
  const agentIdBySessionRef = useRef<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  // 群聊上下文：groupId = 与私聊同 task 的群聊频道 id（经 GET /channels?type=task_group 匹配）
  const [groupId, setGroupId] = useState<string | null>(null);
  // 群聊频道最近 user 消息（limit 5，含 @agent 触发消息，SSE 实时追加）
  const [groupContextMessages, setGroupContextMessages] = useState<RealtimeChatMessage[]>([]);
  // Agent 提问/权限确认弹窗：SSE agent.question 事件 / 进入页补拉设置（resolved 事件收敛关闭）
  const [pendingQuestion, setPendingQuestion] = useState<QuestionModalData | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);

  /* ---------- 1. 频道详情：channel（agent/task）+ agentMembers（任务团队） ---------- */
  const channelQuery = useQuery({
    queryKey: ["channel", channelId],
    queryFn: () => api.get<ChannelDetail>(`/channels/${channelId}`),
    enabled: !!channelId && !!user?.id,
  });
  const channel = channelQuery.data;

  /* ---------- 1.5 任务详情：instances（T5 私聊对象按实例解析——别名/实例 id 展示） ---------- */
  const taskQuery = useQuery({
    queryKey: ["task", channel?.taskId ?? ""],
    queryFn: () => api.get<{ id: string; instances?: TaskInstance[] }>(`/tasks/${channel?.taskId}`),
    enabled: !!channel?.taskId && !!user?.id,
    retry: false,
  });
  const taskInstances = taskQuery.data?.instances ?? [];

  /* ---------- 2. 消息历史：queryKey 与 use-realtime 追加 key 一致（['channel', id, 'messages']） ---------- */
  // 私聊数据源 = serve 会话历史（session-history，全量含思考/工具）；群聊保持平台表（findMessages）
  const messagesQuery = useQuery({
    queryKey: ["channel", channelId, "messages"],
    queryFn: () => fetchChannelMessages(channelId, channelQuery.data?.type),
    enabled: !!channelId && !!user?.id && !!channelQuery.data,
  });

  /* ---------- 2.5 私聊历史合并：快照（serve 会话）+ SSE 平台增量去重（同源 processing 替换） ---------- */
  const messages = useMemo(
    () => mergeSnapshotWithLive(messagesQuery.data?.items ?? []),
    [messagesQuery.data],
  );

  /* ---------- 2.5 群聊上下文：GET /channels?type=task_group 按 taskId 匹配群聊频道（tasks 页同款） ---------- */
  const channelsQuery = useQuery({
    queryKey: ["channels", "task_group"],
    queryFn: () => api.get<{ items: ChannelItem[]; total: number }>("/channels", { query: { type: "task_group" } }),
    enabled: !!user?.id && !!channel?.taskId,
  });
  useEffect(() => {
    if (!channelsQuery.data) return;
    const g = channelsQuery.data.items.find((c) => c.taskId === channel?.taskId) ?? null;
    setGroupId((prev) => (prev === g?.id ? prev : (g?.id ?? null)));
  }, [channelsQuery.data, channel?.taskId]);

  /* ---------- 2.6 群聊上下文：群聊频道最近 user 消息（limit 5，queryKey 加 "context" 与主列表 limit=50 隔离） ---------- */
  const groupMessagesQuery = useQuery({
    queryKey: ["channel", groupId ?? "", "messages", "context"],
    queryFn: () => api.get<MessagesResponse>(`/channels/${groupId}/messages`, { query: { limit: 5 } }),
    enabled: !!groupId && !!user?.id,
  });

  /* ---------- 2.7 Agent 提问/权限确认补拉：进入页面/刷新时恢复未处理弹窗（落库持久化） ---------- */
  const questionsQuery = useQuery({
    queryKey: ["questions", channel?.taskId ?? "", "pending"],
    queryFn: () => api.get<QuestionModalData[]>(`/questions`, { query: { taskId: channel?.taskId ?? "", status: "pending" } }),
    enabled: !!channel?.taskId && !!user?.id,
  });
  useEffect(() => {
    const pending = questionsQuery.data;
    if (!pending || pending.length === 0) return;
    // 托管模式请求由主 Agent 确认，不弹窗给用户
    setPendingQuestion((prev) => prev ?? (pending[0]?.managedMode ? null : pending[0]));
  }, [questionsQuery.data]);
  // 初始/刷新同步：查询结果过滤 user 消息 → 上下文区；与 onMessage 实时追加合并去重（取最近 5 条）
  useEffect(() => {
    const items = groupMessagesQuery.data?.items ?? [];
    const userMsgs = items.filter((m) => m.senderType === "user");
    if (userMsgs.length === 0) return;
    setGroupContextMessages((prev) => {
      const merged = [...userMsgs, ...prev.filter((p) => !userMsgs.some((u) => u.id === p.id))];
      if (merged.length === prev.length && merged.every((m, i) => m.id === prev[i]?.id)) return prev;
      return merged.slice(-5);
    });
  }, [groupMessagesQuery.data]);

  /**
   * 主 Agent（私聊对象）：private 频道 channel.agent（agent id）→ 从任务 instances 匹配
   * T6 实例语义：channel.taskAgentId 精确命中实例（同 agent 多实例各自私聊独立，
   * 不再 find 首实例串扰）；taskAgentId 缺省（存量频道）回退该 agent 第一个实例。
   * instances 未就绪/未命中时回退 channel.agent 原始信息。task_group 直达降级为任务标题。
   */
  const mainAgent = useMemo(() => {
    if (!channel?.agent) return null;
    const inst = channel.taskAgentId
      ? taskInstances.find((i) => i.id === channel.taskAgentId)
      : taskInstances.find((i) => i.agentId === channel.agent?.id);
    return {
      id: channel.agent.id,
      name: inst ? (inst.alias ?? inst.name) : channel.agent.name,
      role: resolveRole(channel.agent, channel.agent.id),
      ...(inst ? { instanceId: inst.id } : {}),
    };
  }, [channel, taskInstances]);

  /** 团队 Agent（mention 合法性判定 + agentMap 名映射）。 */
  const agentMembers = useMemo(() => {
    const list = (channel?.agentMembers ?? []).map((a) => {
      const role = (a.role && (ROLE_KEYS as readonly string[]).includes(a.role))
        ? (a.role as RoleKey)
        : toRole(a.id) ?? "developer";
      return { id: a.id, name: a.name, role };
    });
    return list;
  }, [channel]);

  const agentMap = useMemo(() => {
    const map = new Map(agentMembers.map((a) => [a.id, { name: a.name, role: a.role }]));
    if (mainAgent && !map.has(mainAgent.id)) {
      map.set(mainAgent.id, { name: mainAgent.name, role: mainAgent.role });
    }
    return map;
  }, [agentMembers, mainAgent]);

  /** 会话标题：私聊=Agent 名 / 群聊直达=任务标题。 */
  const headerName = mainAgent?.name ?? channel?.task?.title ?? "私聊会话";
  const headerRole = mainAgent?.role ?? "developer";
  const meta = channel?.task?.title ? `正在协作「${channel.task.title}」` : "正在与 Agent 协作";
  const headerStatus = mainAgent && (mainAgent.id in loadingByAgent
    || sessionByAgent[mainAgent.id] === "active"
    || sessionByAgent[mainAgent.id] === "running")
    ? "处理中"
    : "在线";

  /** 滚到底：新消息（SSE onMessage / 发送成功）后调用 */
  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /* ---------- 3. SSE 实时（单连接多 scope，逗号分隔） ---------- */
  // channel 段恒有；task 段仅当 channel?.taskId 存在时加入（channel 异步加载后才有）；
  // group 段仅当群聊频道匹配到（groupId 就绪）时加入——群聊新 user 消息实时进上下文区；
  // filter(Boolean) 剔除空段，避免 scope 出现 ",task:" 或尾逗号。
  const realtimeScope = [
    `channel:${channelId}`,
    channel?.taskId ? `task:${channel?.taskId}` : null,
    groupId ? `channel:${groupId}` : null,
  ]
    .filter(Boolean)
    .join(",");
  useRealtimeEvents({
    scope: realtimeScope,
    enabled: !!channelId,
    onMessage: (payload) => {
      scrollToBottom();
      const m = payload.message;
      // 群聊上下文实时更新：群聊频道新 user 消息（含 @agent 触发）→ 上下文区（limit 5）
      if (groupId && m.channelId === groupId && m.senderType === "user") {
        setGroupContextMessages((prev) => {
          if (prev.some((p) => p.id === m.id)) return prev;
          return [...prev, m].slice(-5);
        });
      }
      // agent 回复到达 → 清除该 Agent 的 loading/error（多 scope 连接补拉顺序不定，须在收到回复时即生效）
      if (m.senderType === "agent" && m.senderId) {
        setLoadingByAgent((prev) => {
          if (!(m.senderId! in prev)) return prev;
          const next = { ...prev };
          delete next[m.senderId!];
          return next;
        });
        setErrorByAgent((prev) => {
          if (!(m.senderId! in prev)) return prev;
          const next = { ...prev };
          delete next[m.senderId!];
          return next;
        });
        // active（bind 初始态）/ running（执行中）在回复到达时一并收敛（执行已结束）
        setSessionByAgent((prev) => {
          const st = prev[m.senderId!];
          if (st !== "active" && st !== "running") return prev;
          const next = { ...prev };
          delete next[m.senderId!];
          return next;
        });
      }
    },
    onAgentLoading: (payload) => {
      // agent.loading 实际 payload 含 sessionId（ingress 透传 worker 负载）→ 建立会话映射
      const sessionId = (payload as { sessionId?: string | null }).sessionId;
      if (sessionId) agentIdBySessionRef.current[sessionId] = payload.agentId;
      setLoadingByAgent((prev) => ({ ...prev, [payload.agentId]: payload.phase }));
    },
    onAgentError: (payload) => {
      const p = payload as { sessionId?: string | null; error?: unknown; errorType?: unknown; message?: unknown };
      if (p.sessionId) agentIdBySessionRef.current[p.sessionId] = payload.agentId;
      const detail = [p.error, p.message, p.errorType]
        .map((x) => (typeof x === "string" && x.trim() ? x.trim() : null))
        .find(Boolean) ?? "agent error";
      setErrorByAgent((prev) => ({ ...prev, [payload.agentId]: detail }));
    },
    onAgentStatus: (payload: AgentStatusEvent) => {
      // agent.status 终结态收敛：running 开始 / completed|failed 结束（与 agent.loading 同 task scope）
      if (payload.taskId && channel?.taskId && payload.taskId !== channel.taskId) return;
      const agentId = payload.agentId;
      if (!agentId) return;
      if (payload.sessionId) agentIdBySessionRef.current[payload.sessionId] = agentId;
      if (payload.status === "running") {
        setLoadingByAgent((prev) => ({ ...prev, [agentId]: "operating" }));
      } else if (payload.status === "completed" || payload.status === "failed") {
        setLoadingByAgent((prev) => {
          if (!(agentId in prev)) return prev;
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }
    },
    onSessionUpdated: (payload: SessionUpdatedEvent) => {
      // session.updated payload 仅 {sessionId, status, workerId}（无 agentId/taskId），且 task scope
      // 无条件放行（跨任务串扰）——经映射解析归属，仅当属于本页主 Agent 才更新状态
      if (!payload.sessionId || !mainAgent) return;
      const agentId = agentIdBySessionRef.current[payload.sessionId];
      if (agentId !== mainAgent.id) return;
      setSessionByAgent((prev) => ({ ...prev, [mainAgent.id]: payload.status }));
      if (payload.status === "frozen" || payload.status === "archived") {
        setLoadingByAgent((prev) => {
          if (!(mainAgent.id in prev)) return prev;
          const next = { ...prev };
          delete next[mainAgent.id];
          return next;
        });
      }
    },
    onMessagePartDelta: (payload: MessagePartDeltaEvent) => {
      // 私聊全量 parts（reasoning/tool/text 流式增量）：缓存 upsert 已由 hook 默认完成，
      // 页面仅需滚到底（processing 消息插入/更新后展示最新内容）
      scrollToBottom();
    },
    onAgentQuestion: (payload: RealtimeQuestionEvent) => {
      // 模型提问/权限确认到达 → 弹窗；resolved=true（已回复收敛事件）→ 关闭
      if (payload.resolved) {
        setPendingQuestion((prev) =>
          prev && prev.id === payload.question.id ? null : prev,
        );
        return;
      }
      if (payload.question.status !== "pending") return;
      if (payload.taskId && channel?.taskId && payload.taskId !== channel.taskId) return;
      // 托管模式请求由主 Agent 确认，不弹窗给用户
      if (payload.question.managedMode) return;
      setPendingQuestion({
        id: payload.question.id,
        requestId: payload.question.requestId,
        kind: payload.question.kind,
        content: payload.question.content,
        status: payload.question.status,
        taskId: payload.question.taskId,
        agentId: payload.question.agentId,
        managedMode: payload.question.managedMode,
      });
    },
  });

  /* ---------- 4.5 Agent 提问/权限确认回复：POST /questions/:id/reply ---------- */
  const questionReplyMutation = useMutation({
    mutationFn: (payload: { answers?: string[][] | null; response?: "once" | "always" | "reject" }) =>
      api.post(`/questions/${pendingQuestion?.id}/reply`, payload),
    onSuccess: () => {
      setPendingQuestion(null);
      setQuestionSubmitting(false);
      queryClient.invalidateQueries({ queryKey: ["questions"] });
    },
    onError: (err) => {
      setQuestionSubmitting(false);
      // 僵尸/超期权限：serve 已无该请求（410 QUESTION_EXPIRED）→ 关闭弹窗 + 刷新列表（不无限卡）
      if (isApiError(err) && (err.status === 410 || err.code === "QUESTION_EXPIRED")) {
        setPendingQuestion(null);
        queryClient.invalidateQueries({ queryKey: ["questions"] });
      }
    },
  });
  const handleQuestionSubmit = (payload: { answers?: string[][] | null; response?: "once" | "always" | "reject" }) => {
    if (!pendingQuestion) return;
    setQuestionSubmitting(true);
    questionReplyMutation.mutate(payload);
  };

  /** 历史 loading 收敛：首连补拉会重放历史 loading（task scope）与回复（channel scope），
   *  两连接顺序不定可能导致「回复先收敛、loading 后设置」→ 恒「处理中」。
   *  依赖 loadingByAgent/errorByAgent：无论 loading 重放在历史回复之前还是之后到达，
   *  只要最终状态里某 Agent 的历史最后一条是 agent 回复，其残留 loading/error 一律清除。
   *  例外：历史最后一条是 status=processing 的 agent 消息（流式中间态，仍在生成）——
   *  刷新后内存状态（loadingByAgent/sessionByAgent）清空，server 无从通过 SSE 补推，
   *  须从历史消息恢复：① 主动为该 Agent 设置 loading=operating（AgentInfoBar 显示「处理中」），
   *  ② 且不参与下列收敛（processing 说明还在生成，残留状态不应被误清）。
   *  ⚠️ 仅首连执行一次（historySettledRef）：若依赖 loadingByAgent/sessionByAgent 反复
   *  触发，Agent 执行中的新状态（agent.loading / session.updated running）会被历史消息
   *  误清 → 执行中不显示「处理中/工作中」。 */
  const historySettledRef = useRef(false);
  useEffect(() => {
    if (!messagesQuery.isSuccess || historySettledRef.current) return;
    historySettledRef.current = true;
    // 用合并后消息（快照 serve + SSE 平台增量）：快照未完成 assistant 被 SSE 终态替换后
    // 不再误判 processing（historySettled 恢复 loading 语义与 merged 一致）
    const items = messages;
    const lastByAgent = new Map<string, RealtimeChatMessage>();
    for (const m of items) {
      if (m.senderId) lastByAgent.set(m.senderId, m);
    }
    // ① 刷新恢复：历史最后一条 agent 消息 status=processing（流式中间态）→ 该 Agent 正在运行，
    //    设置 loading=operating 从 server 恢复运行状态（刷新后内存清空）
    setLoadingByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const [agentId, m] of lastByAgent) {
        if (m.senderType === "agent" && m.status === "processing" && !(agentId in prev)) {
          if (!next) next = { ...prev };
          next[agentId] = "operating";
        }
      }
      return next ?? prev;
    });
    // ② loading 残留收敛：历史最后一条是终态 agent 回复（非 processing）→ 清除残留 loading
    setLoadingByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const [agentId, m] of lastByAgent) {
        if (m.senderType === "agent" && m.status !== "processing" && agentId in prev) {
          if (!next) next = { ...prev };
          delete next[agentId];
        }
      }
      return next ?? prev;
    });
    // ③ error 残留收敛：同上，processing（生成中）不参与收敛
    setErrorByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const [agentId, m] of lastByAgent) {
        if (m.senderType === "agent" && m.status !== "processing" && agentId in prev) {
          if (!next) next = { ...prev };
          delete next[agentId];
        }
      }
      return next ?? prev;
    });
    // ④ 会话状态残留收敛：历史最后一条是终态 agent 回复 → 该 Agent 会话已结束（active/running 清除）；
    //    processing（生成中）例外保留，与 ① 的 loading=operating 语义一致
    setSessionByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const [agentId, m] of lastByAgent) {
        if (m.senderType === "agent" && m.status !== "processing" && (prev[agentId] === "active" || prev[agentId] === "running")) {
          if (!next) next = { ...prev };
          delete next[agentId];
        }
      }
      return next ?? prev;
    });
  }, [messagesQuery.isSuccess, messages]);

  /* ---------- 4. 发送：POST /channels/:id/messages ---------- */
  // 私聊语义：无需手动 @（mentionable=[]），自动附带主 Agent 的 mention；
  // 仅当其仍在任务团队（agentMembers）内才附加，避免 400 MENTION_AGENT_NOT_IN_TEAM。
  // T5：mentions 附带主实例 instanceId（后端按 agentId 解析，instanceId 原样落库供展示）。
  const sendMutation = useMutation({
    mutationFn: (payload: SendMessagePayload) =>
      api.post(`/channels/${channelId}/messages`, {
        text: payload.text,
        mentions: mainAgent && agentMembers.some((a) => a.id === mainAgent.id)
          ? [
              {
                type: "agent" as const,
                agentId: mainAgent.id,
                ...(mainAgent.instanceId ? { instanceId: mainAgent.instanceId } : {}),
              },
            ]
          : [],
        // UX-10 附件：MessageInput 已先 POST /uploads 拿 url，随消息提交三字段
        ...(payload.attachment
          ? {
              attachmentUrl: payload.attachment.url,
              attachmentName: payload.attachment.name,
              attachmentType: payload.attachment.ext,
            }
          : {}),
      }),
    onSuccess: () => {
      setInput("");
      scrollToBottom();
    },
  });

  const handleSend = (payload: SendMessagePayload) => {
    sendMutation.mutate(payload);
  };

  /** 加载更多：cursor=nextCursor 取更新消息追加尾部（游标分页契约）。 */
  const handleLoadMore = async () => {
    if (!channelId || !messagesQuery.data?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.get<MessagesResponse>(`/channels/${channelId}/messages`, {
        query: { cursor: messagesQuery.data.nextCursor, limit: 50 },
      });
      queryClient.setQueryData<MessagesResponse>(["channel", channelId, "messages"], (old) =>
        old
          ? {
              items: [...old.items, ...next.items.filter((n) => !old.items.some((o) => o.id === n.id))],
              nextCursor: next.nextCursor,
            }
          : next,
      );
    } finally {
      setLoadingMore(false);
    }
  };

  /** 当前处于 loading 的 Agent 集合 + 指示器 label。 */
  const loadingLabel = useMemo(() => {
    const entries = Object.entries(loadingByAgent);
    if (entries.length === 0) return null;
    const [agentId, phase] = entries[0];
    const name = agentMap.get(agentId)?.name ?? agentId;
    return phase === "operating" ? `${name} 操作中` : `${name} 思考中`;
  }, [loadingByAgent, agentMap]);

  /** agent.error → 错误态（凭据/配额类硬错误 → 红色升级引导；模型繁忙/超时 → 琥珀重试）。 */
  const errorLabel = useMemo<{ kind: "retry" | "quota"; detail: string } | null>(() => {
    const entries = Object.entries(errorByAgent);
    if (entries.length === 0) return null;
    const [agentId, detail] = entries[0];
    const name = agentMap.get(agentId)?.name ?? agentId;
    const d = detail.toLowerCase();
    // 可重试：模型繁忙/限流/超时/上下文溢出；凭据/配额/计费类硬错误不可重试（走升级引导）
    const isRetryable =
      /model_busy|rate.?limit|timeout|context.?overflow|busy|unavailable|try again/i.test(d) &&
      !/invalid api key|unauthorized|401|quota|insufficient|billing|credential/i.test(d);
    return {
      kind: isRetryable ? "retry" : "quota",
      detail: isRetryable ? `${name} 处理失败（模型繁忙），自动重试中` : `${name} 处理失败：${detail}`,
    };
  }, [errorByAgent, agentMap]);

  /** 会话运行状态条（T14）：session.updated status=active/running 的 Agent →「XX 会话运行中…」 */
  const sessionLabel = useMemo(() => {
    const entries = Object.entries(sessionByAgent).filter(
      ([agentId, status]) => (status === "active" || status === "running") && !(agentId in loadingByAgent),
    );
    if (entries.length === 0) return null;
    const [agentId] = entries[0];
    const name = agentMap.get(agentId)?.name ?? agentId;
    return `${name} 会话运行中`;
  }, [sessionByAgent, loadingByAgent, agentMap]);

  // 首屏加载完成后滚到底（显示最新消息）
  useEffect(() => {
    if (messagesQuery.isSuccess) scrollToBottom();
  }, [messagesQuery.isSuccess, scrollToBottom]);

  /* ---------- 渲染：加载 / 错误 / 单栏 ---------- */
  if (!channelId) {
    return <div style={{ padding: space.xl, color: neutral[500] }}>缺少会话 ID</div>;
  }
  if (channelQuery.isPending) {
    return <div data-testid="dm-loading" style={{ padding: space.xl, color: neutral[400] }}>加载中…</div>;
  }
  if (channelQuery.isError || !channel) {
    const errMsg = isApiError(channelQuery.error) ? channelQuery.error.message : "加载会话失败";
    return (
      <div
        data-testid="dm-error"
        role="alert"
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: space.md,
          padding: space.xl,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>{errMsg}</div>
        <Link
          href="/messages"
          data-testid="dm-back-list"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: neutral[600],
            fontSize: fontSize.md,
            fontWeight: 500,
            textDecoration: "none",
            fontFamily: fontFamily.body,
          }}
        >
          ← 返回会话列表
        </Link>
      </div>
    );
  }

  return (
    <div
      data-testid="dm-chat-root"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        marginLeft: -80,
        ...baseFont,
      }}
    >
      <style>{dmCss}</style>

      <AgentInfoBar
        name={headerName}
        role={headerRole}
        meta={meta}
        status={headerStatus}
        backHref={channel?.taskId ? `/tasks/${channel.taskId}` : undefined}
      />

      {/* 群聊上下文区：群聊里 @agent 触发的 user 消息（对话起点）；空态（无群聊频道/user 消息）不渲染 */}
      <GroupContextBar
        messages={groupContextMessages}
        userId={user?.id ?? ""}
        myName={user?.username ?? "我"}
      />

      <DmMessageList
        messages={messages}
        nextCursor={messagesQuery.data?.nextCursor ?? null}
        loadingMore={loadingMore}
        agentMap={agentMap}
        onLoadMore={handleLoadMore}
        loadingLabel={loadingLabel}
        errorLabel={errorLabel}
        sessionLabel={sessionLabel}
        listRef={listRef}
      />

      {/* Footer（对齐原型 DmFooter）：简化输入框 */}
      <div
        style={{
          flexShrink: 0,
          backgroundColor: neutral[50],
          borderTop: `1px solid ${neutral[200]}`,
          ...baseFont,
        }}
      >
        <MessageInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          mentionable={[]}
          sending={sendMutation.isPending}
          taskId={channel?.taskId ?? undefined}
          placeholder={`发送私聊消息给 ${headerName}…`}
          style={{ border: "none", borderTop: `1px solid ${neutral[200]}`, borderRadius: 0 }}
        />
      </div>

      {/* Agent 提问/权限确认弹窗（absolute 相对宿主，不阻塞消息流） */}
      <QuestionModal
        open={!!pendingQuestion}
        question={pendingQuestion}
        submitting={questionSubmitting}
        onClose={() => setPendingQuestion(null)}
        onSubmit={handleQuestionSubmit}
      />
    </div>
  );
}
