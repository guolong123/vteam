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
import type { AgentStatusEvent, SessionUpdatedEvent } from "@/hooks/use-realtime";
import { AgentAvatar, AgentBadge, ChatBubble, MessageInput } from "@/src/components/ui";
import type { SendMessagePayload } from "@/src/components/ui";
import {
  LoadingIndicator,
  MsgError,
  MsgParts,
} from "@/src/components/chat";
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
  task?: { id: string; title: string; status: string; projectId: string } | null;
  agent?: { id: string; name: string; role: string | null } | null;
  agentMembers: { id: string; name: string; role: string | null }[];
  createdAt: string;
}

/** GET /channels/:id/messages 游标分页响应（对齐 use-realtime ChannelMessagesCache 结构）。 */
interface MessagesResponse {
  items: RealtimeChatMessage[];
  nextCursor: string | null;
}

/** seed 模板 Agent id → 角色 key（对齐 board AGENT_ID_ROLE）。 */
const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "architect", "developer", "tester"];

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
        padding: `${space.lg}px ${space.xl}px`,
        backgroundColor: "#FFFFFF",
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
  return (
    <div
      data-testid="chat-message-list"
      ref={listRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: `${space.xl}px`,
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
              backgroundColor: "#FFFFFF",
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
        const parts = Array.isArray(msg.content.parts) ? (msg.content.parts as unknown[]) : [];

        // Agent 消息：parts 过程片段（thinking/tool/error/aborted）+ 正文置底（MsgParts，T14）
        if (msg.senderType === "agent") {
          return (
            <MsgParts
              key={msg.id}
              parts={parts}
              bodyText={(msg.content.text ?? "") as string}
              author={author}
              role={role}
              time={formatTime(msg.createdAt)}
            />
          );
        }

        // 基础三型：user=右 / agent=左 / system=居中（复用共享 ChatBubble）
        if (msg.senderType === "system") {
          return (
            <ChatBubble key={msg.id} text={(msg.content.text ?? "") as string} type="system" time={formatTime(msg.createdAt)} />
          );
        }
        return (
          <ChatBubble
            key={msg.id}
            text={(msg.content.text ?? "") as string}
            type={msg.senderType === "user" ? "user" : "agent"}
            author={msg.senderType === "user" ? undefined : author}
            role={msg.senderType === "user" ? undefined : role}
            time={formatTime(msg.createdAt)}
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
  // agent.error：agentId → errorType
  const [errorByAgent, setErrorByAgent] = useState<Record<string, string>>({});
  // 会话状态：agentId → session.updated status（active=运行中 / frozen|archived=已结束，T14）
  const [sessionByAgent, setSessionByAgent] = useState<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);

  /* ---------- 1. 频道详情：channel（agent/task）+ agentMembers（任务团队） ---------- */
  const channelQuery = useQuery({
    queryKey: ["channel", channelId],
    queryFn: () => api.get<ChannelDetail>(`/channels/${channelId}`),
    enabled: !!channelId && !!user?.id,
  });
  const channel = channelQuery.data;

  /* ---------- 2. 消息历史：queryKey 与 use-realtime 追加 key 一致（['channel', id, 'messages']） ---------- */
  const messagesQuery = useQuery({
    queryKey: ["channel", channelId, "messages"],
    queryFn: () => api.get<MessagesResponse>(`/channels/${channelId}/messages`, { query: { limit: 50 } }),
    enabled: !!channelId && !!user?.id && !!channelQuery.data,
  });

  /** 主 Agent（私聊对象）：private 频道 channel.agent；task_group 直达降级为任务标题。 */
  const mainAgent = useMemo(
    () => (channel?.agent ? { id: channel.agent.id, name: channel.agent.name, role: resolveRole(channel.agent, channel.agent.id) } : null),
    [channel],
  );

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
  const headerStatus = mainAgent && (mainAgent.id in loadingByAgent || sessionByAgent[mainAgent.id] === "active")
    ? "处理中"
    : "在线";

  /** 滚到底：新消息（SSE onMessage / 发送成功）后调用 */
  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /* ---------- 3. SSE 实时（单连接多 scope，逗号分隔） ---------- */
  // channel 段恒有；task 段仅当 channel?.taskId 存在时加入（channel 异步加载后才有）；
  // filter(Boolean) 剔除空段，避免 scope 出现 ",task:" 或尾逗号。
  const realtimeScope = [
    `channel:${channelId}`,
    channel?.taskId ? `task:${channel?.taskId}` : null,
  ]
    .filter(Boolean)
    .join(",");
  useRealtimeEvents({
    scope: realtimeScope,
    enabled: !!channelId,
    onMessage: (payload) => {
      scrollToBottom();
      const m = payload.message;
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
        setSessionByAgent((prev) => {
          if (prev[m.senderId!] !== "active") return prev;
          const next = { ...prev };
          delete next[m.senderId!];
          return next;
        });
      }
    },
    onAgentLoading: (payload) => {
      setLoadingByAgent((prev) => ({ ...prev, [payload.agentId]: payload.phase }));
    },
    onAgentError: (payload) => {
      setErrorByAgent((prev) => ({ ...prev, [payload.agentId]: payload.errorType }));
    },
    onAgentStatus: (payload: AgentStatusEvent) => {
      // agent.status 终结态收敛：running 开始 / completed|failed 结束（与 agent.loading 同 task scope）
      if (payload.taskId && channel?.taskId && payload.taskId !== channel.taskId) return;
      const agentId = payload.agentId;
      if (!agentId) return;
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
      // session.updated 展示 Agent 会话状态：active=运行中，frozen|archived=已结束
      if (payload.taskId && channel?.taskId && payload.taskId !== channel.taskId) return;
      const agentId = payload.agentId;
      if (!agentId) return;
      setSessionByAgent((prev) => ({ ...prev, [agentId]: payload.status }));
      if (payload.status === "frozen" || payload.status === "archived") {
        setLoadingByAgent((prev) => {
          if (!(agentId in prev)) return prev;
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }
    },
  });

  /** 历史 loading 收敛：首连补拉会重放历史 loading（task scope）与回复（channel scope），
   *  两连接顺序不定可能导致「回复先收敛、loading 后设置」→ 恒「处理中」。
   *  依赖 loadingByAgent/errorByAgent：无论 loading 重放在历史回复之前还是之后到达，
   *  只要最终状态里某 Agent 的历史最后一条是 agent 回复，其残留 loading/error 一律清除。 */
  useEffect(() => {
    if (!messagesQuery.isSuccess) return;
    const items = messagesQuery.data?.items ?? [];
    const lastByAgent = new Map<string, RealtimeChatMessage>();
    for (const m of items) {
      if (m.senderId) lastByAgent.set(m.senderId, m);
    }
    setLoadingByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const [agentId, m] of lastByAgent) {
        if (m.senderType === "agent" && agentId in prev) {
          if (!next) next = { ...prev };
          delete next[agentId];
        }
      }
      return next ?? prev;
    });
    setErrorByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const [agentId, m] of lastByAgent) {
        if (m.senderType === "agent" && agentId in prev) {
          if (!next) next = { ...prev };
          delete next[agentId];
        }
      }
      return next ?? prev;
    });
    // 会话状态残留收敛：历史最后一条是 agent 回复 → 该 Agent 会话已结束（active 状态清除）
    setSessionByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const [agentId, m] of lastByAgent) {
        if (m.senderType === "agent" && prev[agentId] === "active") {
          if (!next) next = { ...prev };
          delete next[agentId];
        }
      }
      return next ?? prev;
    });
  }, [messagesQuery.isSuccess, messagesQuery.data, loadingByAgent, errorByAgent, sessionByAgent]);

  /* ---------- 4. 发送：POST /channels/:id/messages ---------- */
  // 私聊语义：无需手动 @（mentionable=[]），自动附带主 Agent 的 mention；
  // 仅当其仍在任务团队（agentMembers）内才附加，避免 400 MENTION_AGENT_NOT_IN_TEAM。
  const sendMutation = useMutation({
    mutationFn: (payload: SendMessagePayload) =>
      api.post(`/channels/${channelId}/messages`, {
        text: payload.text,
        mentions: mainAgent && agentMembers.some((a) => a.id === mainAgent.id)
          ? [{ type: "agent" as const, agentId: mainAgent.id }]
          : [],
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

  /** agent.error → 错误态（isRetryable 类型 → 琥珀重试，其余 → 红色升级引导）。 */
  const errorLabel = useMemo<{ kind: "retry" | "quota"; detail: string } | null>(() => {
    const entries = Object.entries(errorByAgent);
    if (entries.length === 0) return null;
    const [agentId, errorType] = entries[0];
    const name = agentMap.get(agentId)?.name ?? agentId;
    const isRetryable = ["auth_failed", "model_busy", "context_overflow"].includes(errorType);
    return {
      kind: isRetryable ? "retry" : "quota",
      detail: isRetryable ? `${name} 处理失败（模型繁忙），自动重试中` : `${name} 处理失败（${errorType}）`,
    };
  }, [errorByAgent, agentMap]);

  /** 会话运行状态条（T14）：session.updated status=active 的 Agent →「XX 会话运行中…」 */
  const sessionLabel = useMemo(() => {
    const entries = Object.entries(sessionByAgent).filter(
      ([agentId, status]) => status === "active" && !(agentId in loadingByAgent),
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
            backgroundColor: "#FFFFFF",
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

  const messages = messagesQuery.data?.items ?? [];

  return (
    <div
      data-testid="dm-chat-root"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
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

      {/* Footer（对齐原型 DmFooter）：查看历史会话入口 + 简化输入框 */}
      <div
        style={{
          flexShrink: 0,
          backgroundColor: "#FFFFFF",
          borderTop: `1px solid ${neutral[200]}`,
          ...baseFont,
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", paddingTop: space.md }}>
          <span
            data-testid="view-session-link"
            role="link"
            aria-label="查看历史会话"
            title="会话面板（Phase 3）"
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
              cursor: "pointer",
              boxShadow: shadow.sm,
            }}
          >
            查看历史会话
            <span aria-hidden>↗</span>
          </span>
        </div>
        <MessageInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          mentionable={[]}
          sending={sendMutation.isPending}
          placeholder={`发送私聊消息给 ${headerName}…`}
          style={{ border: "none", borderTop: `1px solid ${neutral[200]}`, borderRadius: 0 }}
        />
      </div>
    </div>
  );
}
