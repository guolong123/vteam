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
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents, type RealtimeChatMessage } from "@/hooks/use-realtime";
import type { AgentStatusEvent, MessagePartDeltaEvent, RealtimeQuestionEvent, SessionUpdatedEvent } from "@/hooks/use-realtime";
import { AgentAvatar, ChatBubble, MessageInput, StatusBadge } from "@/src/components/ui";
import type { MentionableAgent, SendMessagePayload } from "@/src/components/ui";
import { TaskStatusActions } from "@/src/components/tasks/task-status-actions";
import { IssueDetailModal } from "@/src/components/tasks/issue-detail-modal";
import { useResizableWidth } from "@/src/hooks/use-resizable";
import {
  LoadingIndicator,
  MsgError,
  MsgParts,
  QuestionModal,
} from "@/src/components/chat";
import type { QuestionModalData } from "@/src/components/chat";
import {
  type RoleKey,
  type StatusKey,
  neutral,
  roles,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** P4：processing 消息超时兜底阈值（worker abort 后无 SSE 事件回流时，超过此阈值渲染失败形态） */
const PROCESSING_TIMEOUT_MS = 180_000;

/** scoped CSS 动画（groupchat- 前缀防污染，对齐原型 groupchatCss） */
const groupchatCss = `
@keyframes groupchat-pulse { 0%, 100% { opacity: .3 } 50% { opacity: 1 } }
@keyframes groupchat-spin { to { transform: rotate(360deg) } }
`;

/* ------------------------------ API 数据模型（对齐 T6/T10 DTO） ------------------------------ */

/** 后端五态（TASK_STATUS）。 */
type TaskApiStatus =
  | "pending"
  | "in_progress"
  | "pending_review"
  | "completed"
  | "archived";

/** 任务实例（T5 角色/实例分离：toTaskDto.instances 条目，main=主实例）。 */
interface TaskInstance {
  id: string;
  agentId: string;
  alias: string | null;
  seq: number;
  name: string;
  role: string | null;
  main: boolean;
  /** 会话状态快照（sessions.status 真实源：running=工作中 / idle=空闲；无会话=null）。 */
  sessionStatus: string | null;
  /** 实例会话 id（SSE session.updated 收敛映射需 sessionId→instanceId 建链）。 */
  sessionId: string | null;
}

/** GET /tasks/:id 任务详情（不含 channelId，见文件头「频道定位」）。 */
interface TaskDetail {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: string;
  status: TaskApiStatus;
  mainAgentId: string | null;
  /** 主实例 id（决策依据；mainAgentId 渲染兜底）。 */
  mainAgentInstanceId: string | null;
  /** 托管模式：成员 question/permission 请求由主 Agent 确认（不弹窗给用户）。 */
  managedMode: boolean;
  backgroundDocs: unknown[];
  teamAgentIds: string[];
  /** 团队实例列表（[{id, agentId, alias, seq, name, role, main}]，按 (agentId, seq) 排序）。 */
  instances: TaskInstance[];
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  pendingReviewAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

/* ------------------------------ 产出物模型（对齐 toArtifactListItem / artifacts 页） ------------------------------ */

/** 产出物 API 类型（对齐 ARTIFACT_TYPES：text/doc/file）。 */
type ArtifactApiType = "text" | "doc" | "file";

/**
 * GET /tasks/:id/artifacts 列表项（对齐 toArtifactListItem；doc/file 当前版本
 * filePath+contentRef 非空时后端附加可访问 fileUrl，可直接打开/下载）。
 */
interface ArtifactItem {
  id: string;
  taskId: string;
  type: ArtifactApiType;
  title: string;
  currentVersion: number;
  acceptedFlag: boolean;
  authorAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  fileUrl?: string;
}

/** GET /tasks/:id/artifacts 分页响应。 */
interface ArtifactsResponse {
  items: ArtifactItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /issues 列表项（TaskPanel 待办 Issue 区数据源，仅需 id/title/status）。 */
interface TaskIssueItem {
  id: string;
  taskId: string;
  title: string;
  status: "open" | "in_progress" | "resolved" | "closed" | "rejected";
}

/** GET /issues?taskId= 分页响应（TaskPanel 待办 Issue 区）。 */
interface TaskIssuesResponse {
  items: TaskIssueItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** issue 状态排序优先级（待办在前：open < in_progress < resolved < closed < rejected）。 */
const ISSUE_STATUS_ORDER: Record<TaskIssueItem["status"], number> = {
  open: 0,
  in_progress: 1,
  resolved: 2,
  closed: 3,
  rejected: 4,
};

/** issue 状态徽章主题（语义对齐 issues 页 ISSUE_STATUS_THEME，面板内小号渲染）。 */
const ISSUE_STATUS_BADGE: Record<TaskIssueItem["status"], { label: string; color: string; bg: string; border: string }> = {
  open: { label: "待处理", color: "#475569", bg: "#F8FAFC", border: "#CBD5E1" },
  in_progress: { label: "进行中", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  resolved: { label: "已解决", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  closed: { label: "已关闭", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
  rejected: { label: "已拒绝", color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
};

/** 待办 Issue 区状态小徽章（title 旁展示状态语义）。 */
function IssueStatusPill({ status }: { status: TaskIssueItem["status"] }) {
  const theme = ISSUE_STATUS_BADGE[status] ?? ISSUE_STATUS_BADGE.open;
  return (
    <span
      data-testid="task-issue-status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs - 1}px ${space.sm + 1}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.xs,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...baseFont,
      }}
    >
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: theme.color, flexShrink: 0 }} />
      {theme.label}
    </span>
  );
}

/** 产出物类型三色（与 artifacts 页 ARTIFACT_TYPE_THEME 同款页面内扩展 token）：结论文本=紫 / 文档=蓝 / 文件=绿。 */
const ARTIFACT_TYPE_THEME: Record<ArtifactApiType, { color: string }> = {
  text: { color: "#7C3AED" },
  doc: { color: "#2563EB" },
  file: { color: "#059669" },
};

/** 产出物类型中文名（条目次要行展示）。 */
const ARTIFACT_TYPE_LABEL: Record<ArtifactApiType, string> = {
  text: "结论文本",
  doc: "文档",
  file: "文件",
};

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
  a_project_manager: "project_manager",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

/* ------------------------------ 添加实例：模板角色选择（GET /agents，对齐创建页 T5） ------------------------------ */

/** GET /agents 响应条目（T4：{items:[{id,name,role,type,prompt}]}）。 */
interface AgentItem {
  id: string;
  name: string;
  role: string;
  type: string;
  prompt: string | null;
}

interface AgentsResponse {
  items: AgentItem[];
  total: number;
}

/** seed 模板 Agent 角色 → id 兜底（对齐创建页 ROLE_AGENT_ID；GET /agents 未就绪时添加不中断）。 */
const ROLE_AGENT_ID: Record<RoleKey, string> = {
  product: "a_product",
  project_manager: "a_project_manager",
  architect: "a_architect",
  developer: "a_developer",
  tester: "a_tester",
};

/** 角色选择项（每角色首个模板 agent；role 非法跳过，按 ROLE_KEYS 顺序稳定展示）。 */
interface AgentOption {
  id: string;
  role: RoleKey;
}

/** GET /agents 结果 → 角色选择项（按角色去重取首个，顺序对齐 ROLE_KEYS）。 */
function roleOptionsOf(items: AgentItem[]): AgentOption[] {
  const byRole = new Map<RoleKey, AgentItem>();
  for (const a of items) {
    const role = a.role && (ROLE_KEYS as readonly string[]).includes(a.role)
      ? (a.role as RoleKey)
      : toRole(a.id);
    if (role && !byRole.has(role)) byRole.set(role, a);
  }
  return ROLE_KEYS.flatMap((role) => {
    const item = byRole.get(role);
    return item ? [{ id: item.id, role }] : [];
  });
}

/** 角色 → 模板 agent id（API 兜底：优先 GET /agents，缺省 seed 预置 id）。 */
function agentIdForRole(role: RoleKey, options: AgentOption[]): string {
  return options.find((o) => o.role === role)?.id ?? ROLE_AGENT_ID[role];
}

/** agent id / role 字符串 → RoleKey（未知/自定义 Agent 跳过）。 */
function toRole(agentId: string): RoleKey | null {
  const direct = AGENT_ID_ROLE[agentId];
  if (direct) return direct;
  const rest = agentId.startsWith("a_") ? agentId.slice(2) : agentId;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
}

/**
 * 消息发送者别名兜底（T5）：后端消息 DTO 无 senderInstanceId，但 T4 notify_agent 落库
 * mentions 为实例形状 [{type:'agent', instanceId, agentId, name}]（name=目标实例别名）——
 * 当 senderId(agentId) 命中 mentions[].agentId 时用其 name（如 开发者-2），否则 null 走 agentMap。
 */
function senderNameFromMentions(msg: RealtimeChatMessage): string | null {
  if (!Array.isArray(msg.mentions) || !msg.senderId) return null;
  for (const m of msg.mentions as { type?: string; agentId?: string; name?: string }[]) {
    if (m?.type === "agent" && m.agentId === msg.senderId && typeof m.name === "string" && m.name) {
      return m.name;
    }
  }
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

/* ================================ 成员面板（224px，T5 按实例展示） ================================ */
function MembersPanel({
  agents,
  loadingAgentIds,
  sessionStatusByAgent,
  startingAgentId,
  onStartDm,
  dmError,
  teamEditable,
  agentOptions,
  adding,
  addError,
  onAddInstance,
  width,
}: {
  /** 团队实例（id=agent id 兼容状态 key；instanceId=实例 id 唯一键；main=主实例）。 */
  agents: { id: string; instanceId?: string; name: string; role: RoleKey; seq?: number; main?: boolean }[];
  loadingAgentIds: Set<string>;
  /** agentId → session.updated status（running=工作中 / idle=空闲，其余状态走现状） */
  sessionStatusByAgent: Record<string, string>;
  startingAgentId: string | null;
  onStartDm: (agentId: string, taskAgentId?: string) => void;
  dmError: string | null;
  /** 团队可编辑（仅 pending/in_progress 可添加实例，对齐后端 409 约束）。 */
  teamEditable: boolean;
  /** 模板角色选择项（GET /agents，每角色首 agent；缺省兜底 seed 预置 id）。 */
  agentOptions: AgentOption[];
  adding: boolean;
  /** 添加失败错误（agent 不存在等，后端 404 AGENT_NOT_FOUND / 409 TASK_TEAM_NOT_ALLOWED）。 */
  addError: string | null;
  /** 确认添加（返回是否成功；成功后面板关闭重置，失败保留面板展示错误）。 */
  onAddInstance: (agentId: string, alias?: string) => Promise<boolean>;
  /** 面板宽度（is_0000000017 可拖拽 resize，缺省 224）。 */
  width?: number;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<RoleKey | null>(null);
  const [alias, setAlias] = useState("");
  const theme = selectedRole ? roles[selectedRole] ?? roles.developer : null;

  const openPanel = () => {
    if (!teamEditable || adding) return;
    setSelectedRole(null);
    setAlias("");
    setAddOpen(true);
  };
  const closePanel = () => {
    if (adding) return;
    setAddOpen(false);
  };
  const confirmAdd = async () => {
    if (!selectedRole || adding) return;
    const ok = await onAddInstance(agentIdForRole(selectedRole, agentOptions), alias.trim() || undefined);
    if (ok) {
      setAddOpen(false);
      setSelectedRole(null);
      setAlias("");
    }
  };

  return (
    <aside
      data-testid="members-panel"
      style={{
        width: width ?? 224,
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
          // T6 实例语义：loading/starting 状态按实例 key 匹配（同 agent 多实例各自 loading），
          // 会话运行状态保留 agentId 维度（session.updated 事件无实例 id，旧协议）
          const processing = loadingAgentIds.has(a.instanceId ?? a.id) || loadingAgentIds.has(a.id);
          const starting = startingAgentId === (a.instanceId ?? a.id) || startingAgentId === a.id;
          const sessionStatus =
            sessionStatusByAgent[a.instanceId ?? a.id] ?? sessionStatusByAgent[a.id];
          const working = sessionStatus === "running";
          const idle = sessionStatus === "idle";
          const statusText = starting
            ? "创建中…"
            : processing
              ? "处理中"
              : working
                ? "工作中"
                : idle
                  ? "空闲"
                  : "就绪";
          return (
            <div
              key={a.instanceId ?? a.id}
              data-testid="member-item"
              data-role={a.role}
              data-main={a.main ? "true" : "false"}
              role="button"
              tabIndex={0}
              title={`与 ${a.name} 发起私聊`}
              aria-busy={starting}
              onClick={() => onStartDm(a.id, a.instanceId)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onStartDm(a.id, a.instanceId);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm}px ${space.sm}px`,
                borderRadius: radius.md,
                border: a.main ? `1px solid ${roles[a.role]?.border ?? neutral[200]}` : "none",
                background: starting || working || a.main ? neutral[100] : "transparent",
                textAlign: "left",
                fontFamily: fontFamily.body,
                cursor: starting ? "default" : "pointer",
                opacity: starting ? 0.6 : 1,
                transition: "background-color .15s ease, opacity .15s ease",
              }}
              onMouseEnter={(e) => {
                if (!starting && !working) e.currentTarget.style.backgroundColor = neutral[100];
              }}
              onMouseLeave={(e) => {
                if (!starting && !working) e.currentTarget.style.backgroundColor = a.main ? neutral[100] : "transparent";
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
                  {/* 主 Agent 徽章：挂在实例上（非角色），对齐创建页 ★ 主 Agent 视觉 */}
                  {a.main && (
                    <span
                      data-testid="member-main-tag"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 2,
                        marginLeft: space.xs,
                        padding: "0 6px",
                        borderRadius: radius.pill,
                        backgroundColor: roles[a.role]?.color ?? "#2563EB",
                        color: "#FFFFFF",
                        fontSize: fontSize.xs,
                        fontWeight: 600,
                        lineHeight: "15px",
                        verticalAlign: "1px",
                      }}
                    >
                      ★ 主 Agent
                    </span>
                  )}
                </span>
                <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.4 }}>
                  {typeof a.seq === "number" && `#${a.seq} · `}
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
                  {working && (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        border: "2px solid #BFDBFE",
                        borderTopColor: "#2563EB",
                        marginRight: space.xs,
                        verticalAlign: "-2px",
                        animation: "groupchat-spin .8s linear infinite",
                      }}
                    />
                  )}
                  {idle && (
                    <span
                      aria-hidden
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        backgroundColor: neutral[400],
                        marginRight: space.xs - 1,
                      }}
                    />
                  )}
                  {statusText}
                </span>
              </span>
              <span style={{ color: "#2563EB", fontSize: fontSize.lg, lineHeight: 1 }} aria-hidden>
                ›
              </span>
            </div>
          );
        })}

        {/* 添加实例：虚线入口（对齐创建页 add-instance-btn 视觉语言：1.5px dashed） */}
        <button
          type="button"
          data-testid="add-instance-entry"
          aria-label="添加实例"
          title={teamEditable ? "为任务添加 Agent 实例（自动建会话并绑定）" : "任务待验收/已完成/已归档后不允许调整团队"}
          onClick={openPanel}
          disabled={!teamEditable || adding}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: space.xs,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1.5px dashed ${teamEditable ? neutral[300] : neutral[200]}`,
            backgroundColor: "rgba(255,255,255,.6)",
            color: teamEditable ? "#2563EB" : neutral[300],
            fontSize: fontSize.sm,
            fontWeight: 500,
            cursor: teamEditable ? "pointer" : "not-allowed",
            fontFamily: fontFamily.body,
            transition: "border-color .15s ease, color .15s ease",
          }}
        >
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>＋</span>
          添加实例
        </button>

        {/* 添加实例面板（内联展开：角色选择 + 别名输入 + 确认，窄面板紧凑布局） */}
        {addOpen && (
          <div
            data-testid="add-instance-panel"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space.sm,
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.sm,
            }}
          >
            <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>添加实例</div>
            {/* 角色选择：五角色行（角色色点 + 中文名），点击选中（选中态 = 角色主题边框/背景） */}
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }} role="radiogroup" aria-label="选择角色">
              {ROLE_KEYS.map((role) => {
                const t = roles[role] ?? roles.developer;
                const selected = selectedRole === role;
                return (
                  <button
                    key={role}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid="add-instance-role"
                    data-role={role}
                    aria-label={`添加${t.label}实例`}
                    onClick={() => setSelectedRole(role)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.sm,
                      padding: `${space.xs}px ${space.sm}px`,
                      borderRadius: radius.sm,
                      border: `1px solid ${selected ? t.border : "transparent"}`,
                      backgroundColor: selected ? t.bg : "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: t.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: fontSize.md, color: neutral[700], fontWeight: selected ? 600 : 500 }}>
                      {t.label}
                    </span>
                    {selected && (
                      <span aria-hidden style={{ color: t.color, fontSize: fontSize.sm, fontWeight: 700 }}>✓</span>
                    )}
                  </button>
                );
              })}
            </div>
            {/* 别名（可选，缺省服务端生成 <角色中文名>-<seq>） */}
            <input
              data-testid="add-instance-alias"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder={theme ? `别名（缺省 ${theme.label}-N）` : "别名（缺省自动生成）"}
              disabled={adding}
              aria-label="实例别名（可选）"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: `${space.sm}px ${space.sm}px`,
                borderRadius: radius.sm,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "#FFFFFF",
                fontSize: fontSize.md,
                color: neutral[800],
                outline: "none",
                fontFamily: fontFamily.body,
              }}
            />
            {addError && (
              <div data-testid="add-instance-error" role="alert" style={{ fontSize: fontSize.xs, color: "#DC2626", lineHeight: 1.5 }}>
                {addError}
              </div>
            )}
            {/* 操作：取消 / 添加 */}
            <div style={{ display: "flex", gap: space.sm }}>
              <button
                type="button"
                data-testid="add-instance-cancel"
                onClick={closePanel}
                disabled={adding}
                style={{
                  flex: 1,
                  padding: `${space.sm - 1}px ${space.md}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: neutral[600],
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: adding ? "default" : "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                取消
              </button>
              <button
                type="button"
                data-testid="add-instance-confirm"
                onClick={confirmAdd}
                disabled={!selectedRole || adding}
                style={{
                  flex: 1,
                  padding: `${space.sm - 1}px ${space.md}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  cursor: !selectedRole || adding ? "default" : "pointer",
                  opacity: !selectedRole || adding ? 0.5 : 1,
                  fontFamily: fontFamily.body,
                }}
              >
                {adding ? "添加中…" : "添加"}
              </button>
            </div>
          </div>
        )}
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
        {dmError ?? "点击成员可发起与该实例的私聊"}
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

/* ================================ 面板拖拽分隔条（is_0000000017） ================================ */
function ResizeHandle({
  label,
  onResizeStart,
}: {
  label: string;
  onResizeStart: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-testid="panel-resize-handle"
      title={label}
      onMouseDown={onResizeStart}
      style={{
        flexShrink: 0,
        width: 6,
        cursor: "col-resize",
        backgroundColor: "transparent",
        transition: "background-color .15s ease",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = "#BFDBFE";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = "transparent";
      }}
    />
  );
}

/* ================================ 消息列表（游标分页 + 过程消息渲染） ================================ */
function MessageList({
  messages,
  nextCursor,
  loadingMore,
  agentMap,
  instanceNameById,
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
  instanceNameById: Map<string, string>;
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
        // T6 实例语义：senderInstanceId 精确归属实例别名（同 agent 多实例各自显示，
        // 如 开发者-2 的回复显示「开发者-2」而非 agent 名）；缺省回退 agentMap/mentions 兜底
        const author =
          (msg.senderInstanceId ? instanceNameById.get(msg.senderInstanceId) : null)
          ?? agent?.name
          ?? senderNameFromMentions(msg)
          ?? msg.senderId
          ?? "";

        // 群聊结论防御：初始加载（GET messages）同样只保留 text 结论 part——与
        // onMessagePartDelta 兜底一致（reasoning/tool 不渲染折叠卡片；后端终态化
        // 已滤，此处防御历史/残留数据，F3 缺陷①）
        const parts = Array.isArray(msg.content.parts)
          ? (msg.content.parts as unknown[]).filter(
              (p) => (p as { type?: string; synthetic?: boolean }).type === "text"
                && !(p as { type?: string; synthetic?: boolean }).synthetic,
            )
          : [];

        // Agent 消息：parts 过程片段（thinking/tool/error/aborted）+ 正文置底（MsgParts，T14）；
        // status=processing 为流式中间态（message.part.delta 累积），正文走「生成中」流式块
        if (msg.senderType === "agent") {
          // P4 超时兜底：processing 超过阈值（worker abort 后无事件回流）→ 视觉降级失败形态，
          // 不再显示流式「生成中」；不修改 SSE 状态管理，仅渲染层判定
          const processing = msg.status === "processing";
          const timedOut =
            processing && Date.now() - new Date(msg.createdAt).getTime() > PROCESSING_TIMEOUT_MS;
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
                    backgroundColor: "#FEF2F2",
                    border: "1px solid #FECACA",
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
              bodyText={(msg.content.text ?? "") as string}
              author={author}
              role={role}
              time={formatTime(msg.createdAt)}
              streaming={processing}
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
        Agent 内部推理过程不广播到群聊，仅最终回复展示
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

/* ================================ 任务信息编辑弹窗（is_0000000011：描述/标题/背景文档） ================================ */

/** POST /uploads 响应（server FileStorageService.describe：{url, name, size, ext}）。 */
interface UploadedFileMeta {
  url: string;
  name: string;
  size: number;
  ext: string;
}

/** 背景文档条目（TaskDetail.backgroundDocs 元素 + 新增上传）。 */
interface BackgroundDocItem {
  name: string;
  url: string;
}

/** 解析 task.backgroundDocs（unknown[] → {name, url}[]，非法元素忽略）。 */
function parseBackgroundDocs(docs: unknown[]): BackgroundDocItem[] {
  if (!Array.isArray(docs)) return [];
  return docs.flatMap((d) => {
    if (typeof d !== "object" || d === null) return [];
    const { name, url } = d as { name?: unknown; url?: unknown };
    return typeof name === "string" && typeof url === "string" && name && url
      ? [{ name, url }]
      : [];
  });
}

function TaskInfoEditModal({
  task,
  open,
  onClose,
  onSaved,
}: {
  task: TaskDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [docs, setDocs] = useState<BackgroundDocItem[]>(() =>
    parseBackgroundDocs(task.backgroundDocs),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 打开时重置为最新任务数据
  useEffect(() => {
    if (!open) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setDocs(parseBackgroundDocs(task.backgroundDocs));
    setFormError(null);
    setUploadError(null);
  }, [open, task]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // 上传：POST /uploads multipart（file 字段）→ {url,name,size,ext} → 加入 docs
  const uploadMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post<UploadedFileMeta>("/uploads", fd);
    },
    onSuccess: (meta) => {
      setDocs((prev) => [...prev, { name: meta.name, url: meta.url }]);
      setUploadError(null);
    },
    onError: (err) =>
      setUploadError(isApiError(err) ? err.message : "文档上传失败，请稍后重试"),
  });

  // 保存：PATCH /tasks/:id {title, description, backgroundDocs}
  const saveMutation = useMutation({
    mutationFn: (payload: { title: string; description: string; backgroundDocs: BackgroundDocItem[] }) =>
      api.patch<TaskDetail>(`/tasks/${task.id}`, payload),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => {
      setFormError(isApiError(err) ? err.message : "保存失败，请稍后重试");
    },
  });

  if (!open) return null;

  const handleSave = () => {
    if (saveMutation.isPending) return;
    if (!title.trim()) {
      setFormError("请填写任务标题");
      return;
    }
    setFormError(null);
    saveMutation.mutate({
      title: title.trim(),
      description: description.trim(),
      backgroundDocs: docs,
    });
  };

  const inputBase: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: "#FFFFFF",
    fontSize: fontSize.md,
    color: neutral[800],
    outline: "none",
    fontFamily: fontFamily.body,
  };

  return (
    <div
      data-testid="task-edit-overlay"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8%",
        ...baseFont,
      }}
    >
      {/* 轻遮罩：点击关闭 */}
      <div
        aria-hidden
        data-testid="task-edit-mask"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />

      <div
        data-testid="task-edit-modal"
        style={{
          position: "relative",
          width: 560,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 16%)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            编辑任务信息
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
            修改任务标题 / 描述 / 背景文档，保存后任务详情即时刷新
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>
            任务标题 <span style={{ color: "#DC2626" }}>*</span>
          </span>
          <input
            data-testid="task-edit-title-input"
            value={title}
            maxLength={128}
            onChange={(e) => setTitle(e.target.value)}
            style={inputBase}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>任务描述</span>
          <textarea
            data-testid="task-edit-description-input"
            value={description}
            rows={5}
            onChange={(e) => setDescription(e.target.value)}
            style={{ ...inputBase, resize: "vertical", lineHeight: 1.6 }}
          />
        </label>

        {/* 背景文档：已有列表 + 上传 */}
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>背景文档</span>

          {docs.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
              {docs.map((doc) => (
                <div
                  key={doc.url}
                  data-testid="task-edit-doc-item"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.xs}px ${space.md}px`,
                    borderRadius: radius.md,
                    backgroundColor: neutral[50],
                    border: `1px solid ${neutral[200]}`,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      backgroundColor: "#2563EB",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: fontSize.md,
                      color: neutral[700],
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {doc.name}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    data-testid="task-edit-doc-remove"
                    aria-label={`移除 ${doc.name}`}
                    onClick={() => setDocs((prev) => prev.filter((d) => d.url !== doc.url))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDocs((prev) => prev.filter((d) => d.url !== doc.url));
                      }
                    }}
                    style={{
                      fontSize: fontSize.sm,
                      color: neutral[400],
                      cursor: "pointer",
                      padding: space.xs,
                      flexShrink: 0,
                    }}
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            data-testid="task-edit-upload-btn"
            aria-label="上传背景文档"
            disabled={uploadMutation.isPending}
            onClick={() => fileInputRef.current?.click()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: space.xs,
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1.5px dashed ${neutral[300]}`,
              backgroundColor: neutral[50],
              color: neutral[500],
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: uploadMutation.isPending ? "default" : "pointer",
              opacity: uploadMutation.isPending ? 0.7 : 1,
              fontFamily: fontFamily.body,
            }}
          >
            <span aria-hidden style={{ color: "#2563EB" }}>↑</span>
            {uploadMutation.isPending ? "上传中…" : "上传背景文档"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            data-testid="task-edit-file-input"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.gif,.md,.txt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setUploadError(null);
                uploadMutation.mutate(file);
              }
              e.target.value = "";
            }}
            style={{ display: "none" }}
          />
          {uploadError && (
            <div role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", fontWeight: 500 }}>
              {uploadError}
            </div>
          )}
        </div>

        {(formError || saveMutation.isError) && (
          <div role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", fontWeight: 500 }}>
            {formError ?? (isApiError(saveMutation.error) ? saveMutation.error.message : "保存失败")}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button
            type="button"
            data-testid="task-edit-cancel"
            onClick={onClose}
            disabled={saveMutation.isPending}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: saveMutation.isPending ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="task-edit-save"
            onClick={handleSave}
            disabled={saveMutation.isPending}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: saveMutation.isPending ? "default" : "pointer",
              opacity: saveMutation.isPending ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {saveMutation.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================ 任务信息面板（268px，对齐原型 TaskPanel，静态展示） ================================ */
function TaskPanel({
  task,
  agents,
  onOpenArtifacts,
  artifacts,
  artifactsTotal,
  artifactsLoading,
  onOpenIssues,
  issues,
  issuesTotal,
  issuesLoading,
  onOpenIssueDetail,
  onEditTaskInfo,
  width,
  onToggleManagedMode,
}: {
  task: TaskDetail;
  agents: { id: string; name: string; role: RoleKey }[];
  /** 产出物入口：跳项目产出物页 /artifacts?pid= */
  onOpenArtifacts?: () => void;
  /** 任务实际产出物列表（GET /tasks/:id/artifacts）。 */
  artifacts: ArtifactItem[];
  artifactsTotal: number;
  artifactsLoading?: boolean;
  /** 待办 Issue 入口：跳项目 issue 页 /issues?pid= */
  onOpenIssues?: () => void;
  /** 任务全部 issue（GET /issues?taskId=，按状态排序后取前 5 展示）。 */
  issues: TaskIssueItem[];
  issuesTotal: number;
  issuesLoading?: boolean;
  /** 待办 Issue 项点击 → 弹 Issue 详情（is_0000000012）。 */
  onOpenIssueDetail?: (issueId: string) => void;
  /** 「编辑任务信息」入口（is_0000000011：描述/标题/背景文档）。 */
  onEditTaskInfo?: () => void;
  /** 面板宽度（is_0000000017 可拖拽 resize，缺省 300）。 */
  width?: number;
  /** 托管模式开关（PATCH /tasks/:id {managedMode}，父组件 mutation 写回缓存）。 */
  onToggleManagedMode?: (managed: boolean) => void;
}) {
  const mainAgent = task.mainAgentId ? agents.find((a) => a.id === task.mainAgentId) : undefined;
  /** 主实例（T5：instances[].main 或 id===mainAgentInstanceId；别名优先展示） */
  const mainInstance = (task.instances ?? []).find(
    (i) => i.main || i.id === task.mainAgentInstanceId,
  );
  const statusLabel = STATUS_LABEL[task.status] ?? "进行中";

  /** 待办 issue 按状态优先级排序（open 最前），供「待办 Issue」区取前 5。 */
  const sortedIssues = useMemo(
    () =>
      [...issues].sort(
        (a, b) => (ISSUE_STATUS_ORDER[a.status] ?? 9) - (ISSUE_STATUS_ORDER[b.status] ?? 9),
      ),
    [issues],
  );

  /** 产出物条目点击：doc/file 带可访问 fileUrl → 新窗口打开（同源 /uploads/ 自动触发下载）；
   *  text 或无 fileUrl → 跳产出物聚合页查看。 */
  const handleArtifactClick = (item: ArtifactItem) => {
    if ((item.type === "doc" || item.type === "file") && item.fileUrl) {
      window.open(item.fileUrl, "_blank", "noopener,noreferrer");
      return;
    }
    onOpenArtifacts?.();
  };

  /** 产出物条目键盘可达（Enter/空格等价点击）。 */
  const handleArtifactKeyDown = (item: ArtifactItem) => (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleArtifactClick(item);
    }
  };
  return (
    <aside
      data-testid="task-info-panel"
      style={{
        position: "relative",
        width: width ?? 300,
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
        <div style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.4 }}>
            {task.title}
          </div>
          {/* is_0000000011：编辑任务信息入口 */}
          <button
            type="button"
            data-testid="task-edit-entry"
            aria-label="编辑任务信息"
            title="编辑任务信息（标题/描述/背景文档）"
            onClick={onEditTaskInfo}
            style={{
              flexShrink: 0,
              border: `1px solid ${neutral[200]}`,
              background: "#FFFFFF",
              color: neutral[500],
              fontSize: fontSize.sm,
              borderRadius: radius.pill,
              padding: `${space.xs - 1}px ${space.sm}px`,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            ✎ 编辑
          </button>
        </div>
        <div style={{ marginTop: space.sm, display: "flex", alignItems: "center", gap: space.sm }}>
          {renderStatusBadge(statusLabel)}
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>更新于 {formatTime(task.createdAt)}</span>
        </div>
      </div>

      {/* 任务描述（is_0000000011：编辑后展示最新内容） */}
      {task.description && (
        <div
          data-testid="task-description-panel"
          style={{
            fontSize: fontSize.sm,
            color: neutral[600],
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.md,
            padding: `${space.sm + 2}px ${space.md}px`,
          }}
        >
          {task.description}
        </div>
      )}

      {/* 主 Agent / 团队 */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.sm, color: neutral[400], flexShrink: 0 }}>主 Agent</span>
          <span style={{ fontSize: fontSize.md, color: neutral[800], fontWeight: 600 }}>
            {mainInstance ? (mainInstance.alias ?? mainInstance.name) : mainAgent?.name ?? (task.mainAgentId || "未指定")}
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

      {/* 产出物：任务实际产出物文件列表（GET /tasks/:id/artifacts；doc/file 直开 fileUrl，
          超 5 个 →「更多 N 个」跳 /artifacts?pid= 聚合页；空 → 占位按钮） */}
      <div>
        <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.sm }}>
          产出物
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {artifactsLoading ? (
            <div
              style={{
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
                color: neutral[400],
                fontSize: fontSize.sm,
              }}
            >
              加载中…
            </div>
          ) : artifacts.length > 0 ? (
            <>
              {artifacts.slice(0, 5).map((item) => {
                const typeTheme = ARTIFACT_TYPE_THEME[item.type] ?? ARTIFACT_TYPE_THEME.file;
                return (
                  <div
                    key={item.id}
                    data-testid="artifact-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleArtifactClick(item)}
                    onKeyDown={handleArtifactKeyDown(item)}
                    title={item.fileUrl ? `打开 ${item.title}` : `查看产出物 ${item.title}`}
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
                        backgroundColor: typeTheme.color,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: fontSize.md,
                          color: neutral[800],
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.title}
                      </span>
                      <span
                        style={{
                          display: "block",
                          fontSize: fontSize.xs,
                          color: neutral[400],
                          lineHeight: 1.4,
                        }}
                      >
                        {ARTIFACT_TYPE_LABEL[item.type] ?? item.type} · v{item.currentVersion}
                      </span>
                    </span>
                    <span style={{ color: neutral[400], fontSize: fontSize.md }} aria-hidden>
                      ↗
                    </span>
                  </div>
                );
              })}
              {artifactsTotal > 5 && (
                <button
                  type="button"
                  data-testid="artifact-more"
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
                  更多 {artifactsTotal - 5} 个 →
                </button>
              )}
            </>
          ) : (
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

      {/* 待办 Issue：任务全部 issue 按状态排序（open 在前）展示前 5；超 5 →「更多 N 个」跳 /issues?pid=；空 → 占位 */}
      <div>
        <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.sm }}>
          待办 Issue
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {issuesLoading ? (
            <div
              style={{
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
                color: neutral[400],
                fontSize: fontSize.sm,
              }}
            >
              加载中…
            </div>
          ) : sortedIssues.length > 0 ? (
            <>
              {sortedIssues.slice(0, 5).map((issue) => (
                <div
                  key={issue.id}
                  data-testid="task-issue-item"
                  role="button"
                  tabIndex={0}
                  title={`查看 ${issue.title} 详情`}
                  onClick={() => onOpenIssueDetail?.(issue.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenIssueDetail?.(issue.id);
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
                    transition: "border-color .15s ease, background-color .15s ease",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.backgroundColor = "#FFFFFF";
                    (e.currentTarget as HTMLDivElement).style.borderColor = "#BFDBFE";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.backgroundColor = neutral[50];
                    (e.currentTarget as HTMLDivElement).style.borderColor = neutral[200];
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: fontSize.md,
                      color: neutral[800],
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {issue.title}
                  </span>
                  <IssueStatusPill status={issue.status} />
                </div>
              ))}
              {issuesTotal > 5 && (
                <button
                  type="button"
                  data-testid="task-issues-more"
                  onClick={onOpenIssues}
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
                  <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>☰</span>
                  更多 {issuesTotal - 5} 个 →
                </button>
              )}
            </>
          ) : (
            <div
              style={{
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
                color: neutral[400],
                fontSize: fontSize.sm,
              }}
            >
              暂无待办 issue
            </div>
          )}
        </div>
      </div>

      {/* 状态流转操作（OBS-010：与看板同款按钮组，共享 TaskStatusActions） */}
      <div>
        <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.sm }}>
          任务操作
        </div>
        <TaskStatusActions taskId={task.id} status={task.status} />

        {/* 托管模式开关：开启后成员 question/permission 请求由主 Agent 确认（不弹窗给用户） */}
        {onToggleManagedMode && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.md,
              marginTop: space.lg,
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              backgroundColor: neutral[50],
              border: `1px solid ${neutral[200]}`,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>
                托管模式
              </span>
              <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>
                成员提问/权限请求由主 Agent 确认
              </span>
            </div>
            <span
              role="switch"
              aria-checked={task.managedMode}
              data-testid="managed-mode-toggle"
              onClick={() => onToggleManagedMode(!task.managedMode)}
              style={{
                width: 40,
                height: 22,
                borderRadius: 11,
                border: "none",
                backgroundColor: task.managedMode ? "#2563EB" : neutral[300],
                position: "relative",
                flexShrink: 0,
                cursor: "pointer",
                transition: "background-color .2s",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: task.managedMode ? 20 : 2,
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  backgroundColor: "#FFFFFF",
                  transition: "left .2s",
                  boxShadow: shadow.sm,
                }}
              />
            </span>
          </div>
        )}
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
  // agent.error：agentId → 错误文本（error 优先，缺省 errorType/message；展示错误态）
  const [errorByAgent, setErrorByAgent] = useState<Record<string, string>>({});
  // 会话状态：agentId → session.updated status（running=工作中 / idle=空闲 / frozen|archived=已结束）
  const [sessionByAgent, setSessionByAgent] = useState<Record<string, string>>({});
  // sessionId → agentId 映射（session.updated payload 仅 {sessionId, status, workerId}，无 agentId，
  // 须经 agent.loading/agent.status 事件（payload 带 sessionId+agentId）建立后再关联成员）
  const agentIdBySessionRef = useRef<Record<string, string>>({});
  // sessionId → instanceId 映射（同 agent 多实例时 session.updated 收敛 key 需按实例精确命中）
  const instanceIdBySessionRef = useRef<Record<string, string | null>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  // 发起私聊失败提示（members-panel 底部说明区）
  const [dmError, setDmError] = useState<string | null>(null);
  // 添加实例失败提示（members-panel 添加面板内展示）
  const [addError, setAddError] = useState<string | null>(null);
  // Agent 提问/权限确认弹窗：SSE agent.question 事件 / 进入页补拉设置（resolved 事件收敛关闭）
  const [pendingQuestion, setPendingQuestion] = useState<QuestionModalData | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  // Issue 详情弹窗（is_0000000012：TaskPanel 待办 Issue 点击）
  const [detailIssueId, setDetailIssueId] = useState<string | null>(null);
  // 任务信息编辑弹窗（is_0000000011）
  const [taskEditOpen, setTaskEditOpen] = useState(false);
  // 面板可拖拽宽度（is_0000000017）：左成员面板 224 / 右任务面板 300，宽度持久化 localStorage
  const membersPanel = useResizableWidth({
    storageKey: "task-members-panel-width",
    defaultWidth: 224,
    min: 160,
    max: 400,
    direction: "normal",
  });
  const taskPanel = useResizableWidth({
    storageKey: "task-info-panel-width",
    defaultWidth: 300,
    min: 240,
    max: 520,
    direction: "inverse",
  });

  /* ---------- 1. 任务详情（无 channelId，仅标题/状态/主 Agent/团队） ---------- */
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.get<TaskDetail>(`/tasks/${taskId}`),
    enabled: !!taskId && !!user?.id,
  });
  const task = taskQuery.data;

  /* ---------- 1a. 模板角色：GET /agents（添加实例面板角色选择；queryKey 与创建页共享缓存） ---------- */
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<AgentsResponse>("/agents"),
    enabled: !!user?.id,
  });
  /** 角色选择项（每角色首 agent，按 ROLE_KEYS 顺序；API 缺失时回退 seed 预置 id）。 */
  const agentOptions = useMemo(
    () => roleOptionsOf(agentsQuery.data?.items ?? []),
    [agentsQuery.data],
  );

  /* ---------- 1b. 产出物列表：GET /tasks/:id/artifacts（右侧面板直接展示实际产出物文件）。
       实时性（is_0000000020）：SSE artifact.submitted 失效缓存 + 30s 轮询兜底（错过事件/用户侧改动）。 ---------- */
  const artifactsQuery = useQuery({
    queryKey: ["task", taskId, "artifacts"],
    queryFn: () =>
      api.get<ArtifactsResponse>(`/tasks/${taskId}/artifacts`, { query: { pageSize: 10 } }),
    enabled: !!taskId && !!user?.id,
    refetchInterval: 30_000,
  });

  /* ---------- 1c. 待办 issue：GET /issues?taskId=（右侧面板「待办 Issue」区，状态排序取前 5）。
       实时性（is_0000000020）：SSE issue.changed 失效缓存 + 30s 轮询兜底。 ---------- */
  const issuesQuery = useQuery({
    queryKey: ["task-issues", taskId],
    queryFn: () =>
      api.get<TaskIssuesResponse>("/issues", { query: { taskId, page: 1, pageSize: 100 } }),
    enabled: !!taskId && !!user?.id,
    refetchInterval: 30_000,
  });

  /* ---------- 2. 频道定位：GET /channels?type=task_group → 按 taskId 匹配 ---------- */
  const channelsQuery = useQuery({
    queryKey: ["channels", "task_group"],
    queryFn: () => api.get<{ items: ChannelItem[]; total: number }>("/channels", { query: { type: "task_group" } }),
    enabled: !!user?.id,
  });  const channel = useMemo(
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

  /* ---------- 4b. Agent 提问/权限确认补拉：进入页面/刷新时恢复未处理弹窗（落库持久化） ---------- */
  const questionsQuery = useQuery({
    queryKey: ["questions", taskId, "pending"],
    queryFn: () => api.get<QuestionModalData[]>(`/questions`, { query: { taskId, status: "pending" } }),
    enabled: !!taskId && !!user?.id,
  });
  useEffect(() => {
    const pending = questionsQuery.data;
    if (!pending || pending.length === 0) return;
    // 托管模式请求由主 Agent 确认，不弹窗给用户
    setPendingQuestion((prev) => prev ?? (pending[0]?.managedMode ? null : pending[0]));
  }, [questionsQuery.data]);

  /**
   * 团队实例（T5）：数据源 = task.instances（GET /tasks/:id，toTaskDto 已返回实例列表）。
   * 每实例一条：id=agent id（SSE 状态/私聊发起按 agent id，后端广播维度）、
   * instanceId=实例 id（唯一键）、name=实例别名（唯一展示标识，@开发者-1 与 @开发者-2 分开）。
   * 存量回退：instances 缺失时用频道 agentMembers（旧数据防御）。
   */
  const agentMembers = useMemo(() => {
    const instances = task?.instances ?? [];
    if (instances.length > 0) {
      return instances.map((inst) => {
        const role = inst.role && (ROLE_KEYS as readonly string[]).includes(inst.role)
          ? (inst.role as RoleKey)
          : toRole(inst.agentId) ?? "developer";
        return {
          id: inst.agentId,
          instanceId: inst.id,
          name: inst.alias ?? inst.name,
          role,
          seq: inst.seq,
          main: inst.main || inst.id === task?.mainAgentInstanceId,
        };
      });
    }
    return (channelQuery.data?.agentMembers ?? []).map((a) => {
      const role = (a.role && (ROLE_KEYS as readonly string[]).includes(a.role))
        ? (a.role as RoleKey)
        : toRole(a.id) ?? "developer";
      return { id: a.id, instanceId: undefined, name: a.name, role };
    });
  }, [task, channelQuery.data, task?.mainAgentInstanceId]);

  /** 实例 → agentMap（agentId → {name, role}；同 agent 多实例保留首个别名，防覆盖） */
  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string; role: RoleKey }>();
    for (const a of agentMembers) {
      if (!map.has(a.id)) map.set(a.id, { name: a.name, role: a.role });
    }
    return map;
  }, [agentMembers]);

  /** 实例 id → 实例别名（senderInstanceId 精确渲染；同 agent 多实例各自别名） */
  const instanceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentMembers) {
      if (a.instanceId) map.set(a.instanceId, a.name);
    }
    return map;
  }, [agentMembers]);

  /** Issue 详情弹窗指派候选（T5 实例：id=实例 id、name=别名、role）。 */
  const issueModalAgents = useMemo(
    () =>
      (task?.instances ?? []).map((i) => ({
        id: i.id,
        name: i.alias ?? i.name,
        role: i.role,
      })),
    [task],
  );

  /** @ 候选（T5 按实例）：name=实例别名（唯一），instanceId 透传（mentions 落库结构）。 */
  const mentionable: MentionableAgent[] = agentMembers.map((a) => ({
    id: a.id,
    agentId: a.id,
    instanceId: a.instanceId,
    name: a.name,
    role: a.role,
  }));

  /** 滚到底：新消息（SSE onMessage / 发送成功）后调用 */
  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  /**
   * 会话状态初始快照（T14）：SSE 增量驱动重连不重放 running，切页回来 sessionByAgent
   * 重置为空 → 执行中 Agent 误显「就绪」。挂载时以任务详情 instances.sessionStatus
   * （sessions.status 真实源）填充一次：仅补缺失 key（不覆盖已到的 SSE 实时状态），
   * 同时按 sessionId 建 session→instance 映射，保证后续 session.updated idle 能收敛。
   */
  const sessionSeedRef = useRef(false);
  useEffect(() => {
    if (!task?.instances?.length || sessionSeedRef.current) return;
    sessionSeedRef.current = true;
    setSessionByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const inst of task.instances) {
        if (inst.sessionStatus && !(inst.id in prev)) {
          if (!next) next = { ...prev };
          next[inst.id] = inst.sessionStatus;
        }
      }
      return next ?? prev;
    });
    for (const inst of task.instances) {
      if (inst.sessionId) {
        agentIdBySessionRef.current[inst.sessionId] = inst.agentId;
        instanceIdBySessionRef.current[inst.sessionId] = inst.id;
      }
    }
  }, [task]);

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
      // agent 回复到达 → 收敛该 Agent 的 loading 指示器与错误态（FR-20 处理完成替换）。
      // T6 实例语义：收敛 key 优先 senderInstanceId（回复精确归属实例），缺省回退 senderId。
      if (m.senderType === "agent" && m.senderId) {
        const senderKey = m.senderInstanceId ?? m.senderId;
        setLoadingByAgent((prev) => {
          if (!(senderKey in prev)) return prev;
          const next = { ...prev };
          delete next[senderKey];
          return next;
        });
        setErrorByAgent((prev) => {
          if (!(senderKey in prev)) return prev;
          const next = { ...prev };
          delete next[senderKey];
          return next;
        });
        // active（bind 初始态）/ running（执行中）在回复到达时一并收敛（执行已结束）
        setSessionByAgent((prev) => {
          const st = prev[senderKey];
          if (st !== "active" && st !== "running") return prev;
          const next = { ...prev };
          delete next[senderKey];
          return next;
        });
      }
    },
    onAgentLoading: (payload) => {
      // agent.loading 实际 payload 含 sessionId（ingress 透传 worker 负载）→ 建立会话映射
      const sessionId = (payload as { sessionId?: string | null }).sessionId;
      if (sessionId) {
        agentIdBySessionRef.current[sessionId] = payload.agentId;
        instanceIdBySessionRef.current[sessionId] = payload.instanceId ?? null;
      }
      // T6 实例语义：按 instanceId 消费（同 agent 多实例各自 loading），缺省回退 agentId
      const key = payload.instanceId ?? payload.agentId;
      setLoadingByAgent((prev) => ({ ...prev, [key]: payload.phase }));
    },
    onAgentError: (payload) => {
      const p = payload as { sessionId?: string | null; error?: unknown; errorType?: unknown; message?: unknown };
      if (p.sessionId) {
        agentIdBySessionRef.current[p.sessionId] = payload.agentId;
        instanceIdBySessionRef.current[p.sessionId] = payload.instanceId ?? null;
      }
      const detail = [p.error, p.message, p.errorType]
        .map((x) => (typeof x === "string" && x.trim() ? x.trim() : null))
        .find(Boolean) ?? "agent error";
      const key = payload.instanceId ?? payload.agentId;
      setErrorByAgent((prev) => ({ ...prev, [key]: detail }));
    },
    onAgentStatus: (payload: AgentStatusEvent) => {
      // agent.status 终结态收敛：running 开始 / completed|failed 结束（与 agent.loading 同 task scope）
      if (payload.taskId && payload.taskId !== taskId) return;
      const agentId = payload.agentId;
      if (!agentId) return;
      if (payload.sessionId) {
        agentIdBySessionRef.current[payload.sessionId] = agentId;
        instanceIdBySessionRef.current[payload.sessionId] = payload.instanceId ?? null;
      }
      const key = payload.instanceId ?? agentId;
      if (payload.status === "running") {
        setLoadingByAgent((prev) => ({ ...prev, [key]: "operating" }));
      } else if (payload.status === "completed" || payload.status === "failed") {
        setLoadingByAgent((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    onSessionUpdated: (payload: SessionUpdatedEvent) => {
      // session.updated payload 仅 {sessionId, status, workerId}（无 agentId/taskId），
      // 且 task scope 无条件放行（跨任务串扰）——经映射解析归属；解析不到（首次执行
      // 映射未建）丢弃，后续 agent.loading 事件会补建映射，idle/终态事件可命中
      if (!payload.sessionId) return;
      const agentId = agentIdBySessionRef.current[payload.sessionId];
      if (!agentId) return;
      // T6 实例语义：状态 key 与 loading/error/收敛 key 统一为 instanceId ?? agentId——
      // 同 agent 多实例时以实例 id 精确命中，避免 session.updated 用 agentId 覆盖/收敛错位
      const key = instanceIdBySessionRef.current[payload.sessionId] ?? agentId;
      setSessionByAgent((prev) => ({ ...prev, [key]: payload.status }));
      // idle = 本轮执行结束（agent 未声明 group_post 则不公开，群聊无回复到达）→ 清 loading，
      // 避免模型不公开时群聊页永久"处理中"；frozen/archived 终态同样收敛
      if (
        payload.status === "idle" ||
        payload.status === "frozen" ||
        payload.status === "archived"
      ) {
        setLoadingByAgent((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    onMessagePartDelta: (payload: MessagePartDeltaEvent) => {
      scrollToBottom();
      const m = payload.message;
      // 群聊结论防御：仅保留 text 结论 part（后端 extractConclusionParts 已滤 reasoning/tool，
      // 此处兜底——delta 带非 text parts 时也绝不渲染过程片段）
      const parts = Array.isArray(m.content.parts)
        ? (m.content.parts as unknown[]).filter(
            (p) => (p as { type?: string; synthetic?: boolean }).type === "text"
              && !(p as { type?: string; synthetic?: boolean }).synthetic,
          )
        : [];
      const text = parts
        .map((p) => (p as { text?: string }).text ?? "")
        .join("") || (m.content.text ?? "");
      queryClient.setQueryData<MessagesResponse>(["channel", channelId, "messages"], (old) => {
        if (!old) return old;
        const idx = old.items.findIndex((x) => x.id === m.id);
        const merged = { ...m, content: { text, parts } };
        if (idx === -1) return { ...old, items: [...old.items, merged] };
        if (old.items[idx].status !== "processing") return old; // 终态优先：重放不覆盖
        const items = [...old.items];
        items[idx] = merged;
        return { ...old, items };
      });
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
    onArtifactSubmitted: (payload) => {
      // 产出物归档（artifact.submitted，task scope）→ 失效产出物列表缓存，新文件自动出现
      if (payload.taskId === taskId) {
        queryClient.invalidateQueries({ queryKey: ["task", taskId, "artifacts"] });
      }
    },
    onIssueChanged: (payload) => {
      // issue 变更（issue.changed，task scope，is_0000000020）→ 失效待办 issue 缓存，右侧面板自动刷新
      if (payload.taskId === taskId) {
        queryClient.invalidateQueries({ queryKey: ["task-issues", taskId] });
        queryClient.invalidateQueries({ queryKey: ["issues"] });
      }
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
      if (payload.taskId && payload.taskId !== taskId) return;
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

  /* ---------- 4c. Agent 提问/权限确认回复：POST /questions/:id/reply ---------- */
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
   *  ⚠️ 仅首连执行一次（historySettledRef）：若依赖 loadingByAgent/sessionByAgent 反复
   *  触发，Agent 执行中的新状态（agent.loading / session.updated running）会被历史消息
   *  （该 Agent 上一条旧回复）误清 → 成员状态恒「就绪」，执行中不显示「工作中/处理中」。 */
  const historySettledRef = useRef(false);
  useEffect(() => {
    if (!messagesQuery.isSuccess || historySettledRef.current) return;
    historySettledRef.current = true;
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
    // 会话状态残留收敛：历史最后一条是 agent 回复 → 该 Agent 会话已结束（active/running 状态清除）
    setSessionByAgent((prev) => {
      let next: Record<string, string> | null = null;
      for (const [agentId, m] of lastByAgent) {
        if (m.senderType === "agent" && (prev[agentId] === "active" || prev[agentId] === "running")) {
          if (!next) next = { ...prev };
          delete next[agentId];
        }
      }
      return next ?? prev;
    });
  }, [messagesQuery.isSuccess, messagesQuery.data]);

  /* ---------- 6. 发送：POST /channels/:id/messages（mentions 转换 + @all 广播） ---------- */
  const sendMutation = useMutation({
    mutationFn: (payload: SendMessagePayload) =>
      api.post(`/channels/${channelId}/messages`, {
        text: payload.text,
        mentions: [
          ...payload.mentions.map((m) => ({
            type: "agent" as const,
            agentId: m.id,
            // T5：实例 id 透传（后端 CreateMessageDto 按 agentId 解析，instanceId 原样落库供展示）
            ...(m.instanceId ? { instanceId: m.instanceId } : {}),
          })),
          ...(payload.text.includes("@all") ? [{ type: "all" as const }] : []),
        ],
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

  /** 发起私聊：POST /dm-channels {taskId, agentId, taskAgentId} → 成功跳转 /messages/:id。
   *  T6 实例语义：taskAgentId=实例 id——同 agent 多实例各自独立私聊频道
   *  （后端 uk_channels_task_agent 按 task_agent_id 幂等），重复发起返回已有频道。 */
  const startDmMutation = useMutation({
    mutationFn: (target: { agentId: string; taskAgentId?: string }) =>
      api.post<ChannelItem>("/dm-channels", {
        taskId,
        agentId: target.agentId,
        ...(target.taskAgentId ? { taskAgentId: target.taskAgentId } : {}),
      }),
    onSuccess: (channel) => {
      setDmError(null);
      router.push(`/messages/${channel.id}`);
    },
    onError: (err) => {
      setDmError(isApiError(err) ? err.message : "发起私聊失败");
    },
  });

  const handleStartDm = (agentId: string, taskAgentId?: string) => {
    if (startDmMutation.isPending) return;
    setDmError(null);
    startDmMutation.mutate({ agentId, taskAgentId });
  };

  /* ---------- 5b. 添加实例：POST /tasks/:id/team {addInstances:[{agentId, alias?}]}（T2 后端已就绪） ---------- */
  // 成功返回刷新后的任务详情（toTaskDto.instances 含新实例）→ 直接写回 task 缓存：
  // 成员面板/@ 候选/issue 指派（数据源同 task.instances）即时联动，无需等待重取。
  const addInstanceMutation = useMutation({
    mutationFn: (payload: { agentId: string; alias?: string }) =>
      api.post<TaskDetail>(`/tasks/${taskId}/team`, {
        addInstances: [{ agentId: payload.agentId, ...(payload.alias ? { alias: payload.alias } : {}) }],
        removeInstanceIds: [],
      }),
    onSuccess: (updated) => {
      setAddError(null);
      queryClient.setQueryData<TaskDetail>(["task", taskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
    onError: (err) => {
      setAddError(isApiError(err) ? err.message : "添加实例失败，请稍后重试");
    },
  });

  /** 添加实例（返回是否成功；成功后面板关闭重置，失败保留面板展示错误） */
  const handleAddInstance = async (agentId: string, alias?: string): Promise<boolean> => {
    if (addInstanceMutation.isPending) return false;
    setAddError(null);
    return new Promise((resolve) => {
      addInstanceMutation.mutate(
        { agentId, alias },
        {
          onSuccess: () => resolve(true),
          onError: () => resolve(false),
        },
      );
    });
  };

  /* ---------- 5c. 托管模式开关：PATCH /tasks/:id {managedMode} → 写回任务缓存（参考 addInstance 模式） ---------- */
  const managedModeMutation = useMutation({
    mutationFn: (managed: boolean) => api.patch<TaskDetail>(`/tasks/${taskId}`, { managedMode: managed }),
    onSuccess: (updated) => {
      queryClient.setQueryData<TaskDetail>(["task", taskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
    onError: (err) => {
      // 开关失败：提示 + 缓存回滚（reload 兜底）
      const msg = isApiError(err) ? err.message : "托管模式切换失败，请稍后重试";
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      alert(msg);
    },
  });
  const handleToggleManagedMode = (managed: boolean) => {
    if (managedModeMutation.isPending) return;
    managedModeMutation.mutate(managed);
  };

  /** 当前处于 loading 的 Agent 集合（members-panel 状态 + 指示器 label） */
  const loadingAgentIds = useMemo(
    () => new Set(Object.keys(loadingByAgent)),
    [loadingByAgent],
  );
  /** T6 实例语义：状态 key（instanceId ?? agentId）→ 实例别名（loading/error label 反查用） */
  const nameByStateKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentMembers) {
      map.set(a.instanceId ?? a.id, a.name);
      map.set(a.id, a.name);
    }
    return map;
  }, [agentMembers]);
  const stateName = useCallback(
    (key: string) => nameByStateKey.get(key) ?? agentMap.get(key)?.name ?? key,
    [nameByStateKey, agentMap],
  );
  const loadingLabel = useMemo(() => {
    const entries = Object.entries(loadingByAgent);
    if (entries.length === 0) return null;
    const [agentId, phase] = entries[0];
    const name = stateName(agentId);
    return phase === "operating" ? `${name} 操作中` : `${name} 思考中`;
  }, [loadingByAgent, stateName]);

  /** agent.error → 错误态（凭据/配额类硬错误 → 红色升级引导；模型繁忙/超时 → 琥珀重试） */
  const errorLabel = useMemo<{ kind: "retry" | "quota"; detail: string } | null>(() => {
    const entries = Object.entries(errorByAgent);
    if (entries.length === 0) return null;
    const [agentId, detail] = entries[0];
    const name = stateName(agentId);
    const d = detail.toLowerCase();
    // 可重试：模型繁忙/限流/超时/上下文溢出；凭据/配额/计费类硬错误不可重试（走升级引导）
    const isRetryable =
      /model_busy|rate.?limit|timeout|context.?overflow|busy|unavailable|try again/i.test(d) &&
      !/invalid api key|unauthorized|401|quota|insufficient|billing|credential/i.test(d);
    return {
      kind: isRetryable ? "retry" : "quota",
      detail: isRetryable ? `${name} 处理失败（模型繁忙），自动重试中` : `${name} 处理失败：${detail}`,
    };
  }, [errorByAgent, stateName]);

  /** 会话运行状态条（T14）：session.updated status=active/running 的 Agent →「XX 会话运行中…」 */
  const sessionLabel = useMemo(() => {
    const entries = Object.entries(sessionByAgent).filter(
      ([agentId, status]) => (status === "active" || status === "running") && !(agentId in loadingByAgent),
    );
    if (entries.length === 0) return null;
    const [agentId] = entries[0];
    const name = stateName(agentId);
    return `${name} 会话运行中`;
  }, [sessionByAgent, loadingByAgent, stateName]);

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
        sessionStatusByAgent={sessionByAgent}
        startingAgentId={startDmMutation.isPending ? (startDmMutation.variables?.taskAgentId ?? startDmMutation.variables?.agentId ?? null) : null}
        onStartDm={handleStartDm}
        dmError={dmError}
        teamEditable={task.status === "pending" || task.status === "in_progress"}
        agentOptions={agentOptions}
        adding={addInstanceMutation.isPending}
        addError={addError}
        onAddInstance={handleAddInstance}
        width={membersPanel.width}
      />

      {/* 左侧面板拖拽分隔条（is_0000000017） */}
      <ResizeHandle label="调整成员面板宽度" onResizeStart={membersPanel.onResizeStart} />

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
            instanceNameById={instanceNameById}
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
          taskId={taskId}
          placeholder="输入消息，@ 提及某个 Agent…"
          style={{ border: "none", borderTop: `1px solid ${neutral[200]}`, borderRadius: 0 }}
        />
      </div>

      {/* 右侧面板拖拽分隔条（is_0000000017） */}
      <ResizeHandle label="调整任务面板宽度" onResizeStart={taskPanel.onResizeStart} />

      <TaskPanel
        task={task}
        agents={agentMembers}
        onOpenArtifacts={() => router.push(`/artifacts?pid=${task.projectId}`)}
        artifacts={artifactsQuery.data?.items ?? []}
        artifactsTotal={artifactsQuery.data?.total ?? 0}
        artifactsLoading={artifactsQuery.isPending}
        onOpenIssues={() => router.push(`/issues?pid=${task.projectId}`)}
        issues={issuesQuery.data?.items ?? []}
        issuesTotal={issuesQuery.data?.total ?? 0}
        issuesLoading={issuesQuery.isPending}
        onOpenIssueDetail={setDetailIssueId}
        onEditTaskInfo={() => setTaskEditOpen(true)}
        width={taskPanel.width}
        onToggleManagedMode={handleToggleManagedMode}
      />

      {/* 任务信息编辑弹窗（is_0000000011） */}
      <TaskInfoEditModal
        task={task}
        open={taskEditOpen}
        onClose={() => setTaskEditOpen(false)}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["task", taskId] })}
      />

      {/* Issue 详情弹窗（is_0000000012：TaskPanel 待办 Issue 点击，absolute 相对宿主） */}
      <IssueDetailModal
        issueId={detailIssueId}
        open={!!detailIssueId}
        onClose={() => setDetailIssueId(null)}
        agents={issueModalAgents}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ["task-issues", taskId] })}
      />

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
