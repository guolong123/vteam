"use client";

/**
 * 任务群聊页（Phase 2 核心页面 · M2 联调主入口）
 * =============================================
 * 唯一视觉来源：docs/agent-platform/prototypes/group-chat/index.tsx。
 * - 三栏布局对齐原型：members-panel（224px 团队 Agent + 状态）｜消息区（ChatBubble 列表
 *   + MentionHint + MessageInput）｜task-info-panel（300px 任务信息 + 产出物占位）。
 * - 频道定位：GET /tasks/:id 不含 channelId → GET /channels?type=task_group 按 taskId 匹配
 *   （items[].taskId === 当前任务 id，后端频道 DTO 含 taskId，不改后端）。
 * - 消息历史：GET /channels/:id/messages?cursor&limit=50 游标分页（首次 cursor 空取最早
 *   50 条，nextCursor=末条 id，「加载更多」取更新消息追加尾部）。
 * - SSE 实时（09 篇 §4.2，单连接多 scope，逗号分隔）：
 *   · scope="channel:<channelId>,task:<taskId>,global" 一条连接订阅三类事件
 *   · channel 段 → chat.message.new（useRealtimeEvents 默认追加
 *     ['channel', channelId, 'messages'] 缓存，本页 queryKey 一致命中）+ onMessage 滚到底
 *   · task 段 → agent.loading（两阶段 thinking/operating 指示器）+ agent.error
 *   · global 段 → task.status.changed（刷新任务信息面板）
 * - @ 发送：MessageInput onSend({text, mentions}) → POST /channels/:id/messages，
 *   mentions 转换 {type:'agent',agentId}；正文含 @all 时追加 {type:'all'} 广播。
 * - Loading 两阶段：agent.loading phase=thinking/operating → LoadingIndicator
 *   （「思考中…/操作中…」）；收到同 agent 的 chat.message.new（senderType=agent）时收敛。
 * - 铁律（T15）：无 fixed / 100vh / 100vw，高度由 AppShell main（flex column + overflow auto）
 *   接管，本页根 flex:1 + minHeight:0，消息列表内部滚动。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents, type RealtimeChatMessage } from "@/hooks/use-realtime";
import type { AgentStatusEvent, SessionUpdatedEvent } from "@/hooks/use-realtime";
import { AgentAvatar, ChatBubble, MessageInput, StatusBadge } from "@/src/components/ui";
import type { MentionableAgent, SendMessagePayload } from "@/src/components/ui";
import {
  LoadingIndicator,
  MsgError,
  MsgParts,
} from "@/src/components/chat";
import {
  type RoleKey,
  type StatusKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** scoped CSS 动画（groupchat- 前缀防污染，对齐原型 groupchatCss） */
const groupchatCss = `
@keyframes groupchat-pulse { 0%, 100% { opacity: .3 } 50% { opacity: 1 } }
`;

/* ------------------------------ API 数据模型（对齐 T6/T10 DTO） ------------------------------ */

/** 后端五态（TASK_STATUS）。 */
type TaskApiStatus =
  | "pending"
  | "in_progress"
  | "pending_review"
  | "completed"
  | "archived";

/** GET /tasks/:id 任务详情（不含 channelId，见文件头「频道定位」）。 */
interface TaskDetail {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: string;
  status: TaskApiStatus;
  mainAgentId: string | null;
  backgroundDocs: unknown[];
  teamAgentIds: string[];
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  pendingReviewAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

/** GET /channels?type=task_group 条目（后端 ChatService.toChannelDto，含 taskId 可匹配任务）。 */
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

/** GET /channels/:id 响应：频道信息 + agentMembers（任务团队未 removed Agent）。 */
interface ChannelDetail extends ChannelItem {
  agentMembers: { id: string; name: string; role: string | null }[];
}

/** GET /channels/:id/messages 游标分页响应（对齐 use-realtime ChannelMessagesCache 结构）。 */
interface MessagesResponse {
  items: RealtimeChatMessage[];
  nextCursor: string | null;
}

/** API 状态 → 中文状态（对齐 board 页 STATUS_LABEL；待开始不在 StatusKey，本地 Badge 处理）。 */
const STATUS_LABEL: Record<TaskApiStatus, string> = {
  pending: "待开始",
  in_progress: "进行中",
  pending_review: "待验收",
  completed: "已完成",
  archived: "已归档",
};

/** seed 模板 Agent id → 角色 key（对齐 board AGENT_ID_ROLE）。 */
const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "architect", "developer", "tester"];

/** agent id → RoleKey（未知/自定义 Agent 跳过）。 */
function toRole(agentId: string): RoleKey | null {
  const direct = AGENT_ID_ROLE[agentId];
  if (direct) return direct;
  const rest = agentId.startsWith("a_") ? agentId.slice(2) : agentId;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
}

/** ISO 时间 → HH:MM（对齐原型 time 显示）。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 待开始徽章（仿 StatusBadge 视觉，仅用于「待开始」，其余状态仍走共享 StatusBadge，对齐 board 页） */
function WaitingBadge() {
  return (
    <span
      data-testid="status-badge"
      data-status="待开始"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: "#F8FAFC",
        border: "1px solid #CBD5E1",
        color: "#475569",
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: "#475569",
          flexShrink: 0,
        }}
      />
      待开始
    </span>
  );
}

/** 按状态渲染徽章：「待开始」用 WaitingBadge，其余复用共享 StatusBadge */
function renderStatusBadge(status: string) {
  return status === "待开始" ? <WaitingBadge /> : <StatusBadge status={status as StatusKey} />;
}

/* ================================ 成员面板（196px，对齐原型） ================================ */
function MembersPanel({
  agents,
  loadingAgentIds,
  startingAgentId,
  onStartDm,
  dmError,
}: {
  agents: { id: string; name: string; role: RoleKey }[];
  loadingAgentIds: Set<string>;
  startingAgentId: string | null;
  onStartDm: (agentId: string) => void;
  dmError: string | null;
}) {
  return (
    <aside
      data-testid="members-panel"
      style={{
        width: 224,
        flexShrink: 0,
        borderRight: `1px solid ${neutral[200]}`,
        backgroundColor: neutral[50],
        display: "flex",
        flexDirection: "column",
        ...baseFont,
      }}
    >
      <div
        style={{
          padding: `${space.lg}px ${space.md}px`,
          fontSize: fontSize.sm,
          fontWeight: 600,
          color: neutral[500],
          letterSpacing: "0.02em",
        }}
      >
        任务成员 · {agents.length}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: space.xs, padding: `0 ${space.sm}px ${space.md}px` }}>
        {agents.map((a) => {
          const processing = loadingAgentIds.has(a.id);
          const starting = startingAgentId === a.id;
          return (
            <div
              key={a.id}
              data-testid="member-item"
              data-role={a.role}
              role="button"
              tabIndex={0}
              title={`与 ${a.name} 发起私聊`}
              aria-busy={starting}
              onClick={() => onStartDm(a.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onStartDm(a.id);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm}px ${space.sm}px`,
                borderRadius: radius.md,
                border: "none",
                background: starting ? neutral[100] : "transparent",
                textAlign: "left",
                fontFamily: fontFamily.body,
                cursor: starting ? "default" : "pointer",
                opacity: starting ? 0.6 : 1,
                transition: "background-color .15s ease, opacity .15s ease",
              }}
              onMouseEnter={(e) => {
                if (!starting) e.currentTarget.style.backgroundColor = neutral[100];
              }}
              onMouseLeave={(e) => {
                if (!starting) e.currentTarget.style.backgroundColor = "transparent";
              }}
            >
              <AgentAvatar role={a.role} size="sm" />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: fontSize.md,
                    color: neutral[800],
                    fontWeight: 500,
                    lineHeight: 1.3,
                  }}
                >
                  {a.name}
                </span>
                <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.4 }}>
                  {processing && (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: "#2563EB",
                        marginRight: space.xs - 1,
                        animation: "groupchat-pulse 1.2s ease-in-out infinite",
                      }}
                    />
                  )}
                  {starting ? "创建中…" : processing ? "处理中" : "在线"}
                </span>
              </span>
              <span style={{ color: "#2563EB", fontSize: fontSize.lg, lineHeight: 1 }} aria-hidden>
                ›
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: "auto",
          padding: space.md,
          fontSize: fontSize.xs,
          color: dmError ? "#DC2626" : neutral[400],
          lineHeight: 1.5,
          borderTop: `1px dashed ${neutral[200]}`,
        }}
      >
        {dmError ?? "点击成员可发起与该 Agent 的私聊"}
      </div>
    </aside>
  );
}

/* ================================ 频道头部（对齐原型 ChatHeader） ================================ */
function ChatHeader({ title, statusLabel, agents }: { title: string; statusLabel: string; agents: { role: RoleKey }[] }) {
  return (
    <header
      style={{
        height: 64,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `0 ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            {title}
          </span>
          {renderStatusBadge(statusLabel)}
        </div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
          群聊 · 仅被 @ 的 Agent 会收到消息
        </div>
      </div>

      {/* 参与者头像堆叠 */}
      <div
        aria-label="参与成员"
        style={{
          display: "flex",
          alignItems: "center",
          marginLeft: "auto",
        }}
      >
        {agents.map((a, i) => (
          <span key={i} style={{ marginLeft: i === 0 ? 0 : -8 }}>
            <AgentAvatar role={a.role} size="sm" style={{ border: "2px solid #FFFFFF" }} />
          </span>
        ))}
      </div>
    </header>
  );
}

/* ================================ 消息列表（游标分页 + 过程消息渲染） ================================ */
function MessageList({
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
      {/* 会话开始分隔 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>今天 · 任务会话</span>
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
              animation: "groupchat-pulse 1.2s ease-in-out infinite",
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

      {/* Agent 内部过程说明 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          marginTop: space.sm,
          padding: `${space.sm + 2}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[100],
          color: neutral[500],
          fontSize: fontSize.xs,
          lineHeight: 1.5,
        }}
      >
        <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>⚙</span>
        Agent 内部推理过程不广播到群聊，仅最终回复展示；点击右侧「查看 Agent 会话」可实时查看处理过程
      </div>
    </div>
  );
}

/* ================================ @ 提示条（对齐原型 MentionHint） ================================ */
function MentionHint() {
  return (
    <div
      data-testid="mention-hint"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        padding: `${space.xs + 1}px ${space.md}px`,
        backgroundColor: "#FFFFFF",
        ...baseFont,
      }}
    >
      <span
        style={{
          padding: `${space.xs - 1}px ${space.sm}px`,
          borderRadius: radius.pill,
          backgroundColor: neutral[100],
          color: neutral[600],
          fontSize: fontSize.xs,
          fontWeight: 600,
          border: `1px solid ${neutral[200]}`,
        }}
      >
        @all
      </span>
      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
        输入 @all 广播给全体成员；@ 单个角色仅其本人收到
      </span>
    </div>
  );
}

/* ================================ 任务信息面板（268px，对齐原型 TaskPanel，静态展示） ================================ */
function TaskPanel({
  task,
  agents,
  onOpenArtifacts,
}: {
  task: TaskDetail;
  agents: { id: string; name: string; role: RoleKey }[];
  /** 产出物入口：跳项目产出物页 /artifacts?pid= */
  onOpenArtifacts?: () => void;
}) {
  const mainAgent = task.mainAgentId ? agents.find((a) => a.id === task.mainAgentId) : undefined;
  const statusLabel = STATUS_LABEL[task.status] ?? "进行中";
  return (
    <aside
      data-testid="task-info-panel"
      style={{
        width: 300,
        flexShrink: 0,
        borderLeft: `1px solid ${neutral[200]}`,
        backgroundColor: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        padding: space.xl,
        ...baseFont,
      }}
    >
      <div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], marginBottom: space.xs }}>任务</div>
        <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.4 }}>
          {task.title}
        </div>
        <div style={{ marginTop: space.sm, display: "flex", alignItems: "center", gap: space.sm }}>
          {renderStatusBadge(statusLabel)}
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>更新于 {formatTime(task.createdAt)}</span>
        </div>
      </div>

      {/* 主 Agent / 团队 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.sm, color: neutral[400], flexShrink: 0 }}>主 Agent</span>
          <span style={{ fontSize: fontSize.md, color: neutral[800], fontWeight: 600 }}>
            {mainAgent?.name ?? (task.mainAgentId || "未指定")}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <span style={{ fontSize: fontSize.sm, color: neutral[400], flexShrink: 0 }}>团队</span>
          <span style={{ display: "flex", alignItems: "center" }}>
            {agents.map((a, i) => (
              <span key={a.id} style={{ marginLeft: i === 0 ? 0 : -6 }}>
                <AgentAvatar role={a.role} size="sm" style={{ border: "2px solid #FFFFFF" }} />
              </span>
            ))}
          </span>
        </div>
      </div>

      {/* 产出物入口：点击跳转项目产出物页 /artifacts?pid=（Phase 3 产出物模块） */}
      <div>
        <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.sm }}>
          产出物
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {(task.backgroundDocs?.length ? task.backgroundDocs : []).slice(0, 3).map((name, i) => (
            <div
              key={i}
              data-testid="artifact-link"
              role="button"
              tabIndex={0}
              onClick={onOpenArtifacts}
              onKeyDown={(e) => {
                if (onOpenArtifacts && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onOpenArtifacts();
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
                cursor: "pointer",
                transition: "border-color .15s ease",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  backgroundColor: "#059669",
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: fontSize.md, color: neutral[800], fontWeight: 500 }}>
                  {String(name)}
                </span>
              </span>
              <span style={{ color: neutral[400], fontSize: fontSize.md }} aria-hidden>
                ↗
              </span>
            </div>
          ))}
          {!(task.backgroundDocs?.length) && (
            <button
              type="button"
              data-testid="artifact-link"
              onClick={onOpenArtifacts}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
                color: neutral[600],
                fontSize: fontSize.md,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>▤</span>
              查看产出物
            </button>
          )}
        </div>
      </div>

      {/* 查看 Agent 会话入口（占位） */}
      <div style={{ marginTop: "auto" }}>
        <div
          style={{
            padding: space.lg,
            borderRadius: radius.lg,
            backgroundColor: neutral[50],
            border: `1px dashed ${neutral[300]}`,
          }}
        >
          <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.xs }}>
            查看 Agent 会话
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6, marginBottom: space.md }}>
            Agent 内部处理过程不广播到群聊，点击下方入口可实时查看其思考与执行步骤。
          </div>
          <div
            data-testid="view-session-link"
            role="link"
            aria-label="查看 Agent 会话"
            title="会话面板（Phase 3）"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.pill,
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: "pointer",
              boxShadow: shadow.sm,
            }}
          >
            打开会话面板
            <span aria-hidden>→</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ================================ 页面（AppShell 内容区三栏） ================================ */
export default function TaskChatPage() {
  const params = useParams<{ id: string }>();
  const taskId = params?.id ?? "";
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement | null>(null);

  // 输入（受控 MessageInput）
  const [input, setInput] = useState("");
  // Loading 两阶段：agentId → phase（thinking/operating）
  const [loadingByAgent, setLoadingByAgent] = useState<Record<string, string>>({});
  // agent.error：agentId → errorType（展示错误态）
  const [errorByAgent, setErrorByAgent] = useState<Record<string, string>>({});
  // 会话状态：agentId → session.updated status（active=运行中 / frozen|archived=已结束，T14）
  const [sessionByAgent, setSessionByAgent] = useState<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  // 发起私聊失败提示（members-panel 底部说明区）
  const [dmError, setDmError] = useState<string | null>(null);

  /* ---------- 1. 任务详情（无 channelId，仅标题/状态/主 Agent/团队） ---------- */
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.get<TaskDetail>(`/tasks/${taskId}`),
    enabled: !!taskId && !!user?.id,
  });
  const task = taskQuery.data;

  /* ---------- 2. 频道定位：GET /channels?type=task_group → 按 taskId 匹配 ---------- */
  const channelsQuery = useQuery({
    queryKey: ["channels", "task_group"],
    queryFn: () => api.get<{ items: ChannelItem[]; total: number }>("/channels", { query: { type: "task_group" } }),
    enabled: !!user?.id,
  });
  const channel = useMemo(
    () => channelsQuery.data?.items.find((c) => c.taskId === taskId) ?? null,
    [channelsQuery.data, taskId],
  );
  const channelId = channel?.id ?? "";

  /* ---------- 3. 频道详情：agentMembers（members-panel + @ mentionable + agent 名映射） ---------- */
  const channelQuery = useQuery({
    queryKey: ["channel", channelId],
    queryFn: () => api.get<ChannelDetail>(`/channels/${channelId}`),
    enabled: !!channelId,
  });

  /* ---------- 4. 消息历史：queryKey 与 use-realtime 追加 key 一致（['channel', id, 'messages']） ---------- */
  const messagesQuery = useQuery({
    queryKey: ["channel", channelId, "messages"],
    queryFn: () =>
      api.get<MessagesResponse>(`/channels/${channelId}/messages`, { query: { limit: 50 } }),
    enabled: !!channelId,
  });

  /** 团队 Agent → mentionable + agentMap（id → {name, role}） */
  const agentMembers = useMemo(() => {
    const list = (channelQuery.data?.agentMembers ?? []).map((a) => {
      const role = (a.role && (ROLE_KEYS as readonly string[]).includes(a.role))
        ? (a.role as RoleKey)
        : toRole(a.id) ?? "developer";
      return { id: a.id, name: a.name, role };
    });
    return list;
  }, [channelQuery.data]);

  const agentMap = useMemo(
    () => new Map(agentMembers.map((a) => [a.id, { name: a.name, role: a.role }])),
    [agentMembers],
  );

  const mentionable: MentionableAgent[] = agentMembers;

  /** 滚到底：新消息（SSE onMessage / 发送成功）后调用 */
  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /* ---------- 5. SSE 实时（单连接多 scope，逗号分隔：channel + task + global） ---------- */
  // 后端 realtime.controller 支持逗号分隔多 scope（scope=channel:<id>,task:<id>,global），
  // 一条连接收到全部订阅 scope 的事件：chat.message.new / agent.loading / agent.error /
  // team.changed / task.status.changed。前端按事件 type 分发（useRealtimeEvents），
  // 回调内保留 payload.taskId === taskId 过滤（多 scope 下事件会跨 scope 混流，必须逐条过滤）。
  useRealtimeEvents({
    scope: `channel:${channelId},task:${taskId},global`,
    enabled: !!channelId && !!taskId,
    onMessage: (payload) => {
      scrollToBottom();
      const m = payload.message;
      // agent 回复到达 → 收敛该 Agent 的 loading 指示器与错误态（FR-20 处理完成替换）
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
      if (payload.taskId && payload.taskId !== taskId) return;
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
      if (payload.taskId && payload.taskId !== taskId) return;
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
    onTeamChanged: (payload) => {
      if (payload.taskId === taskId) {
        // agentMembers 来自 GET /channels/:id（agentMembers），失效重取刷新 members-panel
        queryClient.invalidateQueries({ queryKey: ["channel", channelId] });
      }
    },
    onTaskStatusChanged: (payload) => {
      if (payload.taskId === taskId) {
        queryClient.invalidateQueries({ queryKey: ["task", taskId] });
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

  /* ---------- 6. 发送：POST /channels/:id/messages（mentions 转换 + @all 广播） ---------- */
  const sendMutation = useMutation({
    mutationFn: (payload: SendMessagePayload) =>
      api.post(`/channels/${channelId}/messages`, {
        text: payload.text,
        mentions: [
          ...payload.mentions.map((m) => ({ type: "agent" as const, agentId: m.id })),
          ...(payload.text.includes("@all") ? [{ type: "all" as const }] : []),
        ],
      }),
    onSuccess: () => {
      setInput("");
      // 等待 SSE chat.message.new 回显（channel scope 已订阅）；本地先滚到底
      scrollToBottom();
    },
  });

  const handleSend = (payload: SendMessagePayload) => {
    sendMutation.mutate(payload);
  };

  /** 加载更多：cursor=nextCursor 取更新消息追加尾部（游标分页契约） */
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

  /** 发起私聊：POST /dm-channels {taskId, agentId} → 成功跳转 /messages/:id。
   *  后端 uk_channels_task_agent 幂等——重复发起返回已有频道（非 409），同样跳转。 */
  const startDmMutation = useMutation({
    mutationFn: (agentId: string) => api.post<ChannelItem>("/dm-channels", { taskId, agentId }),
    onSuccess: (channel) => {
      setDmError(null);
      router.push(`/messages/${channel.id}`);
    },
    onError: (err) => {
      setDmError(isApiError(err) ? err.message : "发起私聊失败");
    },
  });

  const handleStartDm = (agentId: string) => {
    if (startDmMutation.isPending) return;
    setDmError(null);
    startDmMutation.mutate(agentId);
  };

  /** 当前处于 loading 的 Agent 集合（members-panel 状态 + 指示器 label） */
  const loadingAgentIds = useMemo(
    () => new Set(Object.keys(loadingByAgent)),
    [loadingByAgent],
  );
  const loadingLabel = useMemo(() => {
    const entries = Object.entries(loadingByAgent);
    if (entries.length === 0) return null;
    const [agentId, phase] = entries[0];
    const name = agentMap.get(agentId)?.name ?? agentId;
    return phase === "operating" ? `${name} 操作中` : `${name} 思考中`;
  }, [loadingByAgent, agentMap]);

  /** agent.error → 错误态（isRetryable 类型 → 琥珀重试，其余 → 红色升级引导） */
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

  /* ---------- 渲染：加载 / 错误 / 三栏 ---------- */
  const pageError = taskQuery.isError ? (isApiError(taskQuery.error) ? taskQuery.error.message : "加载任务失败")
    : channelsQuery.isError ? (isApiError(channelsQuery.error) ? channelsQuery.error.message : "加载频道失败")
    : channelId && channelQuery.isError ? (isApiError(channelQuery.error) ? channelQuery.error.message : "加载团队失败")
    : channelId && messagesQuery.isError ? (isApiError(messagesQuery.error) ? messagesQuery.error.message : "加载消息失败")
    : null;

  if (!taskId) {
    return <div style={{ padding: space.xl, color: neutral[500] }}>缺少任务 ID</div>;
  }
  if (taskQuery.isPending) {
    return <div data-testid="chat-loading" style={{ padding: space.xl, color: neutral[400] }}>加载中…</div>;
  }
  if (taskQuery.isError || !task) {
    return (
      <div data-testid="chat-error" role="alert" style={{ padding: space.xl, color: "#DC2626" }}>
        {pageError}
      </div>
    );
  }
  if (!channel) {
    return (
      <div data-testid="chat-error" style={{ padding: space.xl, color: neutral[500] }}>
        该任务暂无群聊频道（channelId 未找到）
      </div>
    );
  }

  const messages = messagesQuery.data?.items ?? [];
  const statusLabel = STATUS_LABEL[task.status] ?? "进行中";

  return (
    <div
      data-testid="group-chat-root"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        backgroundColor: neutral[50],
        ...baseFont,
      }}
    >
      <style>{groupchatCss}</style>
      <MembersPanel
        agents={agentMembers}
        loadingAgentIds={loadingAgentIds}
        startingAgentId={startDmMutation.isPending ? (startDmMutation.variables ?? null) : null}
        onStartDm={handleStartDm}
        dmError={dmError}
      />

      {/* 消息区 */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", backgroundColor: neutral[50] }}>
        <ChatHeader title={task.title} statusLabel={statusLabel} agents={agentMembers} />
        {pageError && channelId ? (
          <div data-testid="chat-error" role="alert" style={{ padding: space.xl, color: "#DC2626" }}>
            {pageError}
          </div>
        ) : (
          <MessageList
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
        )}
        <MentionHint />
        <MessageInput
          value={input}
          onChange={setInput}
          onSend={handleSend}
          mentionable={mentionable}
          sending={sendMutation.isPending}
          placeholder="输入消息，@ 提及某个 Agent…"
          style={{ border: "none", borderTop: `1px solid ${neutral[200]}`, borderRadius: 0 }}
        />
      </div>

      <TaskPanel
        task={task}
        agents={agentMembers}
        onOpenArtifacts={() => router.push(`/artifacts?pid=${task.projectId}`)}
      />
    </div>
  );
}
