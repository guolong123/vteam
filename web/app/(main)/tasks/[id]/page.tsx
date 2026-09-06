"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 任务详情页（任务与聊天分离后：去聊天化详情页）
 * =============================================
 * 看板点击任务卡片打开抽屉（TaskDetailDrawer），深度编辑可跳本路由。
 * - 三栏布局：members-panel（224px 团队 Agent + 状态）｜任务详情区（标题/状态/描述/
 *   元信息/状态操作/执行模式）｜task-info-panel（300px TaskRightTabs + 队列/记忆卡片）。
 * - 中央聊天区（MessageList/MessageInput/SSE 消息订阅/私聊 Tabs）已移除；
 *   聊天唯一入口为 /teams/:teamId/session（团队会话）。
 * - 实时保留任务域订阅（team/task/global）：成员状态、任务/团队/产出物/Issue/提问刷新。
 * - 铁律（T15）：无 fixed / 100vh / 100vw，高度由 AppShell main（flex column + overflow auto）
 *   接管，本页根 flex:1 + minHeight:0，详情区内部滚动。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import type { AgentStatusEvent, RealtimeQuestionEvent, SessionUpdatedEvent } from "@/hooks/use-realtime";
import { AgentAvatar, StatusBadge } from "@/src/components/ui";
import { TaskStatusActions } from "@/src/components/tasks/task-status-actions";
import { IssueDetailModal } from "@/src/components/tasks/issue-detail-modal";
import { TaskInfoEditModal } from "@/src/components/tasks/TaskInfoEditModal";
import { PlanSection } from "@/src/components/tasks/PlanSection";
import { ReviewDialog } from "@/src/components/tasks/ReviewDialog";
import {
  TeamQueueCard,
  TeamMemoryCard,
  TaskRightTabs,
} from "@/src/components/teams/TeamRightPanel";
import { ResizeHandle } from "@/src/components/teams/ResizeHandle";
import type {
  TaskApiStatus,
  TaskDetail,
  ArtifactApiType,
  ArtifactItem,
  ArtifactsResponse,
  TaskIssueItem,
  TaskIssuesResponse,
  PlanWithTasks,
} from "@/src/components/tasks/task-detail-types";
import { docIdFor } from "@/src/components/tasks/task-detail-types";
import { TeamMembersPanel, customAgentsOf, roleOptionsOf } from "@/src/components/teams/TeamMembersPanel";
import type { AgentItem } from "@/src/components/teams/TeamMembersPanel";
import { useResizableWidth } from "@/src/hooks/use-resizable";
import { teamsApi } from "@/src/api/teams";
import type { TeamMemberDto } from "@/src/api/teams";
import {
  QuestionModal,
} from "@/src/components/chat";
import type { QuestionModalData } from "@/src/components/chat";
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
@keyframes groupchat-spin { to { transform: rotate(360deg) } }
`;

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
  open: { label: "待处理", color: "var(--color-neutral-600)", bg: "var(--color-neutral-50)", border: "var(--color-neutral-300)" },
  in_progress: { label: "进行中", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  resolved: { label: "已解决", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  closed: { label: "已关闭", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
  rejected: { label: "已拒绝", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
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

const STATUS_LABEL: Record<TaskApiStatus, string> = {
  queued: "排队中",
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

interface AgentsResponse {
  items: AgentItem[];
  total: number;
}

/** agent id / role 字符串 → RoleKey（未知/自定义 Agent 跳过）。 */
function toRole(agentId: string): RoleKey | null {
  const direct = AGENT_ID_ROLE[agentId];
  if (direct) return direct;
  const rest = agentId.startsWith("a_") ? agentId.slice(2) : agentId;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
}

/** ISO 时间 → HH:MM（任务元信息创建时间展示）。 */
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
        backgroundColor: "var(--color-neutral-50)",
        border: "1px solid var(--color-neutral-300)",
        color: "var(--color-neutral-600)",
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
          backgroundColor: "var(--color-neutral-600)",
          flexShrink: 0,
        }}
      />
      待开始
    </span>
  );
}

function QueuedBadge() {
  return (
    <span data-testid="status-badge" data-status="排队中" style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.xs}px ${space.sm + 2}px`, borderRadius: radius.pill, backgroundColor: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.28)", color: "#D97706", fontSize: fontSize.sm, fontWeight: 500, lineHeight: 1.4, whiteSpace: "nowrap", ...baseFont }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: "#D97706", flexShrink: 0 }} />排队中
    </span>
  );
}
function renderStatusBadge(status: string) {
  if (status === "待开始") return <WaitingBadge />;
  if (status === "排队中") return <QueuedBadge />;
  return <StatusBadge status={status as StatusKey} />;
}

function TaskChannelBindingSection({ taskId }: { taskId: string }) {
  const [msgIds, setMsgIds] = useState<string[]>([]);
  const [notifIds, setNotifIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const allMsgQ = useQuery({ queryKey: ["message-channels"], queryFn: () => api.get<any[]>("/message-channels") });
  const allNotifQ = useQuery({ queryKey: ["notification-channels"], queryFn: () => api.get<any[]>("/notification-channels") });
  const boundMsgQ = useQuery({ queryKey: ["task", taskId, "message-channels"], queryFn: () => api.get<any[]>(`/tasks/${taskId}/message-channels`), enabled: !!taskId });
  const boundNotifQ = useQuery({ queryKey: ["task", taskId, "notification-channels"], queryFn: () => api.get<any[]>(`/tasks/${taskId}/notification-channels`), enabled: !!taskId });
  useEffect(() => { if (boundMsgQ.data) setMsgIds((boundMsgQ.data as any[]).map((c: any) => c.id)); }, [boundMsgQ.data]);
  useEffect(() => { if (boundNotifQ.data) setNotifIds((boundNotifQ.data as any[]).map((c: any) => c.id)); }, [boundNotifQ.data]);
  const handleSave = async () => {
    setSaving(true); setMsg(null);
    try {
      await api.post(`/tasks/${taskId}/message-channels`, { messageChannelIds: msgIds });
      await api.post(`/tasks/${taskId}/notification-channels`, { notificationChannelIds: notifIds });
      setMsg("绑定已保存");
    } catch (e) { setMsg(isApiError(e) ? e.message : "保存失败"); }
    setSaving(false);
    setTimeout(() => setMsg(null), 2500);
  };
  return (
    <div data-testid="task-channel-binding-section" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.md }}>
      <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>渠道绑定</div>
      <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>消息渠道</span>
        {(allMsgQ.data as any[] ?? []).length === 0 ? <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{allMsgQ.isPending ? "加载中…" : "暂无"}</span> : (allMsgQ.data as any[]).map((c: any) => (
          <label key={c.id} style={{ display: "flex", alignItems: "center", gap: space.sm, cursor: "pointer" }}>
            <input type="checkbox" data-testid="task-message-channel-checkbox" data-channel-id={c.id} checked={msgIds.includes(c.id)} onChange={(e) => setMsgIds((prev) => e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id))} />
            <span style={{ fontSize: fontSize.sm, color: neutral[700] }}>{c.name}</span>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>通知渠道</span>
        {(allNotifQ.data as any[] ?? []).length === 0 ? <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{allNotifQ.isPending ? "加载中…" : "暂无"}</span> : (allNotifQ.data as any[]).map((c: any) => (
          <label key={c.id} style={{ display: "flex", alignItems: "center", gap: space.sm, cursor: "pointer" }}>
            <input type="checkbox" data-testid="task-notification-channel-checkbox" data-channel-id={c.id} checked={notifIds.includes(c.id)} onChange={(e) => setNotifIds((prev) => e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id))} />
            <span style={{ fontSize: fontSize.sm, color: neutral[700] }}>{c.name}</span>
          </label>
        ))}
      </div>
      <button type="button" data-testid="task-channel-binding-save" disabled={saving} onClick={handleSave} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1, fontSize: fontSize.sm, fontWeight: 500 }}>{saving ? "保存中…" : "保存绑定"}</button>
      {msg && <div data-testid="task-channel-binding-msg" style={{ fontSize: fontSize.xs, color: msg === "绑定已保存" ? "#059669" : "#DC2626" }}>{msg}</div>}
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
  onOpenDocs,
  onOpenProto,
  plan,
  planLoading,
  planError,
  onReviewPlan,
  reviewPending,
}: {
  task: TaskDetail;
  agents: { id: string; name: string; role: RoleKey }[];
  onOpenArtifacts?: () => void;
  onOpenDocs?: (docSlug?: string) => void;
  onOpenProto?: (protoId?: string) => void;
  artifacts: ArtifactItem[];
  artifactsTotal: number;
  artifactsLoading?: boolean;
  onOpenIssues?: () => void;
  issues: TaskIssueItem[];
  issuesTotal: number;
  issuesLoading?: boolean;
  onOpenIssueDetail?: (issueId: string) => void;
  onEditTaskInfo?: () => void;
  width?: number;
  onToggleManagedMode?: (managed: boolean) => void;
  plan: PlanWithTasks | null;
  planLoading: boolean;
  planError: unknown;
  onReviewPlan: (planId: string) => void;
  reviewPending: boolean;
}) {
  const mainAgent = task.mainAgentId ? agents.find((a) => a.id === task.mainAgentId) : undefined;
  /** 主实例（T5：instances[].main 或 id===mainAgentInstanceId；别名优先展示） */
  const mainInstance = (task.instances ?? []).find(
    (i) => i.main || i.id === task.mainAgentInstanceId,
  );
  const statusLabel = STATUS_LABEL[task.status] ?? "进行中";

  const sortedIssues = useMemo(
    () =>
      [...issues].sort(
        (a, b) => (ISSUE_STATUS_ORDER[a.status] ?? 9) - (ISSUE_STATUS_ORDER[b.status] ?? 9),
      ),
    [issues],
  );

  const [activeTab, setActiveTab] = useState<"artifacts" | "issues">("artifacts");
  const [descExpanded, setDescExpanded] = useState(false);
  useEffect(() => {
    setDescExpanded(false);
  }, [task.id, task.description]);

  /** 产出物条目点击（is_0000000033/0036，file 型 .md 并入 is_0000000024 TC-044）：
   *  - doc 或 file 型 .md（含 .MD/.markdown）→ 跳文档站 /docs/:taskId?doc=<slug>，文档站初始定位该文档
   *  - file 型 .tsx / .prototype.json（原型）→ 跳文档站原型 tab /docs/:taskId?proto=<id>（按 fileUrl 文件名取原型 id）
   *  - 其余 file 带可访问 fileUrl → 新窗口打开/下载（同源 /uploads/ 自动触发下载）
   *  - text 或无 fileUrl → 跳产出物聚合页查看。 */
  const handleArtifactClick = (item: ArtifactItem) => {
    const isMarkdownFile =
      item.type === "file" && !!item.fileUrl && /\.(md|markdown)$/i.test(item.fileUrl);
    if (item.type === "doc" || isMarkdownFile) {
      onOpenDocs?.(docIdFor(item.title, item.id, artifacts));
      return;
    }
    const isProtoFile =
      item.type === "file" && !!item.fileUrl && (/\.tsx$/i.test(item.fileUrl) || /\.prototype\.json$/i.test(item.fileUrl));
    if (isProtoFile && item.fileUrl) {
      const raw = item.fileUrl.split("/").pop() ?? "";
      const protoId = raw
        .replace(/\.tsx$/i, "")
        .replace(/\.prototype\.json$/i, "")
        .replace(/\.json$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "proto";
      onOpenProto?.(protoId);
      return;
    }
    if (item.type === "file" && item.fileUrl) {
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
        backgroundColor: "var(--color-surface)",
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        padding: space.xl,
        overflowY: "auto",
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
              background: "var(--color-surface)",
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
        <div style={{ marginTop: space.sm, display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          {renderStatusBadge(statusLabel)}
          <span
            data-testid="execution-mode-badge"
            style={{
              display: "inline-flex", alignItems: "center", gap: space.xs,
              padding: `${space.xs - 1}px ${space.sm + 1}px`,
              borderRadius: radius.pill,
              backgroundColor: task.executionMode === "plan" ? "rgba(37,99,235,0.10)" : neutral[100],
              border: `1px solid ${task.executionMode === "plan" ? "rgba(37,99,235,0.22)" : neutral[200]}`,
              color: task.executionMode === "plan" ? "#2563EB" : neutral[500],
              fontSize: fontSize.xs, fontWeight: 500, lineHeight: 1.4, whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: task.executionMode === "plan" ? "#2563EB" : neutral[400], flexShrink: 0 }} />
            {task.executionMode === "plan" ? "计划驱动" : "轻量执行"}
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>更新于 {formatTime(task.createdAt)}</span>
        </div>
      </div>

      {task.description && (
        <div
          data-testid="task-description-panel"
          style={{
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.md,
            padding: `${space.sm + 2}px ${space.md}px`,
            ...baseFont,
          }}
        >
          <div
            data-testid="task-description-content"
            style={{
              fontSize: fontSize.sm,
              color: neutral[600],
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              display: descExpanded ? "block" : "-webkit-box",
              WebkitLineClamp: (descExpanded ? undefined : 3) as unknown as number,
              WebkitBoxOrient: "vertical" as unknown as string,
              overflow: descExpanded ? "visible" : "hidden",
              maxHeight: descExpanded ? "none" : "4.8em",
            } as unknown as CSSProperties}
          >
            {task.description}
          </div>
          {task.description.length > 120 && (
            <button
              type="button"
              data-testid="task-description-toggle"
              aria-expanded={descExpanded}
              onClick={() => setDescExpanded((v) => !v)}
              style={{
                marginTop: space.xs,
                padding: 0,
                border: "none",
                background: "none",
                color: "#2563EB",
                fontSize: fontSize.sm,
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              {descExpanded ? "收起 ▲" : "展开 ▼"}
            </button>
          )}
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

      {/* 产出物 + 待办 Issue tab 切换 */}
      <div data-testid="artifacts-issues-tab">
        <div style={{ display: "flex", gap: space.xs, marginBottom: space.sm, borderBottom: `1px solid ${neutral[200]}` }}>
          <button
            type="button"
            data-testid="artifacts-tab"
            onClick={() => setActiveTab("artifacts")}
            style={{
              padding: `${space.xs}px ${space.sm}px`,
              borderBottom: `2px solid ${activeTab === "artifacts" ? "#2563EB" : "transparent"}`,
              backgroundColor: "transparent",
              color: activeTab === "artifacts" ? "#2563EB" : neutral[500],
              fontSize: fontSize.sm,
              fontWeight: activeTab === "artifacts" ? 600 : 400,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              border: "none",
              transition: "color .15s ease, border-color .15s ease",
            }}
          >
            产出物
          </button>
          <button
            type="button"
            data-testid="issues-tab"
            onClick={() => setActiveTab("issues")}
            style={{
              padding: `${space.xs}px ${space.sm}px`,
              borderBottom: `2px solid ${activeTab === "issues" ? "#2563EB" : "transparent"}`,
              backgroundColor: "transparent",
              color: activeTab === "issues" ? "#2563EB" : neutral[500],
              fontSize: fontSize.sm,
              fontWeight: activeTab === "issues" ? 600 : 400,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              border: "none",
              transition: "color .15s ease, border-color .15s ease",
            }}
          >
            待办 Issue
          </button>
          {/* 预留扩展位 */}
          <div style={{ flex: 1 }} />
          {activeTab === "artifacts" && (
            <button
              type="button"
              data-testid="task-docs-entry"
              aria-label="文档站"
              title="以文档站视图查看本任务产出物文档"
              onClick={() => onOpenDocs?.()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                border: `1px solid ${neutral[200]}`,
                background: "var(--color-surface)",
                color: neutral[600],
                fontSize: fontSize.sm,
                borderRadius: radius.pill,
                padding: `${space.xs - 1}px ${space.sm}px`,
                cursor: "pointer",
                fontFamily: fontFamily.body,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>▤</span>
              文档站
            </button>
          )}
        </div>

        {/* 产出物 tab 内容 */}
        {activeTab === "artifacts" && (
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
                      title={item.type === "doc" ? `在文档站查看 ${item.title}` : item.fileUrl ? `打开 ${item.title}` : `查看产出物 ${item.title}`}
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
        )}

        {/* 待办 Issue tab 内容 */}
        {activeTab === "issues" && (
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
                      (e.currentTarget as HTMLDivElement).style.backgroundColor = "var(--color-surface)";
                      (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(37,99,235,0.22)";
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
        )}
      </div>

      {/* 执行计划区块 */}
      <PlanSection
        plan={plan}
        loading={planLoading}
        error={planError}
        onReview={onReviewPlan}
        reviewPending={reviewPending}
        taskExecutionMode={task.executionMode}
      />

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
                  backgroundColor: "var(--color-surface)",
                  transition: "left .2s",
                  boxShadow: shadow.sm,
                }}
              />
            </span>
          </div>
        )}
      </div>
      <TaskChannelBindingSection taskId={task.id} />

    </aside>
  );
}

/* ================================ 页面（AppShell 内容区三栏） ================================ */
export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const taskId = params?.id ?? "";
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  // Loading 两阶段：agentId → phase（thinking/operating）
  const [loadingByAgent, setLoadingByAgent] = useState<Record<string, string>>({});
  // 会话状态：agentId → session.updated status（running=工作中 / idle=空闲 / frozen|archived=已结束）
  const [sessionByAgent, setSessionByAgent] = useState<Record<string, string>>({});
  // sessionId → agentId 映射（session.updated payload 仅 {sessionId, status, workerId}，无 agentId，
  // 须经 agent.loading/agent.status 事件（payload 带 sessionId+agentId）建立后再关联成员）
  const agentIdBySessionRef = useRef<Record<string, string>>({});
  // sessionId → instanceId 映射（同 agent 多实例时 session.updated 收敛 key 需按实例精确命中）
  const instanceIdBySessionRef = useRef<Record<string, string | null>>({});
  // 添加实例失败提示（members-panel 添加面板内展示）
  const [addError, setAddError] = useState<string | null>(null);
  // Agent 提问/权限确认弹窗：SSE agent.question 事件 / 进入页补拉设置（resolved 事件收敛关闭）
  const [pendingQuestion, setPendingQuestion] = useState<QuestionModalData | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  // Issue 详情弹窗（is_0000000012：TaskPanel 待办 Issue 点击）
  const [detailIssueId, setDetailIssueId] = useState<string | null>(null);
  // 任务信息编辑弹窗（is_0000000011）
  const [taskEditOpen, setTaskEditOpen] = useState(false);
  // 执行模式切换 409 引导弹窗（direct→plan 未批准时）
  const [executionModeError, setExecutionModeError] = useState<string | null>(null);
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
  /** is_0000000035：自定义/clone agent（type !== template）→ 添加实例面板可选。 */
  const customAgents = useMemo(
    () => customAgentsOf(agentsQuery.data?.items ?? []),
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

  /* ---------- 1d. 执行计划：GET /plans?taskId=（右侧面板「执行计划」区）。
       实时性：30s 轮询兜底 + SSE chat.message.new 失效（计划提交/评审为 system 消息）。 ---------- */
  const plansQuery = useQuery({
    queryKey: ["plans", taskId],
    queryFn: () => api.get<PlanWithTasks>("/plans", { query: { taskId } }),
    enabled: !!taskId && !!user?.id,
    refetchInterval: 30_000,
    retry: false,
  });

  const teamId = task?.teamId ?? null;
  const teamQuery = useQuery({
    queryKey: ["team", teamId],
    queryFn: () => teamsApi.get(teamId!),
    enabled: !!teamId && !!user?.id,
  });
  const team = teamQuery.data;

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

  const agentMembers = useMemo(() => {
    if (team?.members && team.members.length > 0) {
      return team.members.map((m: TeamMemberDto) => {
        const role = m.agent?.role && (ROLE_KEYS as readonly string[]).includes(m.agent.role)
          ? (m.agent.role as RoleKey)
          : toRole(m.agentId) ?? "developer";
        // 主 Agent 判定：优先 team.mainAgentMemberId（团队成员维度），与团队详情页一致
        const isMain = !!team.mainAgentMemberId && team.mainAgentMemberId === m.id;
        return {
          id: m.agentId,
          instanceId: m.id,
          name: m.alias ?? m.agent?.name ?? m.agentId,
          role,
          seq: m.seq,
          main: isMain,
          enabled: true,
          overrideModelId: null,
        };
      });
    }
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
          enabled: (inst as { enabled?: boolean | null }).enabled ?? true,
          overrideModelId: inst.overrideModelId ?? null,
        };
      });
    }
    return [];
  }, [team, task]);

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

  /* ---------- 5. SSE 实时（任务域订阅：team + task + global；消息订阅已随聊天区移除） ---------- */
  // 后端 realtime.controller 支持逗号分隔多 scope，一条连接收到全部订阅 scope 的事件：
  // agent.loading / agent.error / agent.status / session.updated / team.changed /
  // task.status.changed / artifact.submitted / issue.changed / agent.question。
  // 回调内保留 payload.taskId === taskId 过滤（多 scope 下事件会跨 scope 混流，必须逐条过滤）。
  useRealtimeEvents({
    scope: `team:${teamId ?? ""},task:${taskId},global`,
    enabled: !!teamId && !!taskId,
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
      const p = payload as { sessionId?: string | null };
      if (p.sessionId) {
        agentIdBySessionRef.current[p.sessionId] = payload.agentId;
        instanceIdBySessionRef.current[p.sessionId] = payload.instanceId ?? null;
      }
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
    onTeamChanged: (payload: any) => {
      if (payload.teamId) queryClient.invalidateQueries({ queryKey: ["team", teamId] });
      if (payload.teamId === teamId) {
        queryClient.invalidateQueries({ queryKey: ["team", teamId] });
        queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      }
    },
    onTaskStatusChanged: (payload) => {
      if (payload.taskId === taskId) {
        queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      }
    },
    onArtifactSubmitted: (payload) => {
      if (payload.taskId === taskId) {
        queryClient.invalidateQueries({ queryKey: ["task", taskId, "artifacts"] });
      }
    },
    onIssueChanged: (payload) => {
      if (payload.taskId === taskId) {
        queryClient.invalidateQueries({ queryKey: ["task-issues", taskId] });
        queryClient.invalidateQueries({ queryKey: ["issues"] });
      }
    },
    onAgentQuestion: (payload: RealtimeQuestionEvent) => {
      if (payload.resolved) {
        setPendingQuestion((prev) =>
          prev && prev.id === payload.question.id ? null : prev,
        );
        return;
      }
      if (payload.question.status !== "pending") return;
      if (payload.taskId && payload.taskId !== taskId) return;
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

  const toggleEnabledMutation = useMutation({
    mutationFn: ({ instanceId, enabled }: { instanceId: string; enabled: boolean }) =>
      api.patch<TaskDetail>(`/tasks/${taskId}/instances/${instanceId}`, { enabled }),
    onSuccess: (updated) => {
      queryClient.setQueryData<TaskDetail>(["task", taskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

  const instanceModelMutation = useMutation({
    mutationFn: ({ instanceId, modelId }: { instanceId: string; modelId: string | null }) =>
      api.patch<TaskDetail>(`/tasks/${taskId}/instances/${instanceId}`, { overrideModelId: modelId ?? "" }),
    onSuccess: (updated) => {
      queryClient.setQueryData<TaskDetail>(["task", taskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

  const resetSessionMutation = useMutation({
    mutationFn: (instanceId: string) =>
      api.post<{ task: TaskDetail; session: unknown }>(`/tasks/${taskId}/instances/${instanceId}/reset-session`),
    onSuccess: (res) => {
      queryClient.setQueryData<TaskDetail>(["task", taskId], res.task);
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

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

  const executionModeMutation = useMutation({
    mutationFn: (mode: "direct" | "plan") =>
      api.patch<TaskDetail>(`/tasks/${taskId}/execution-mode`, { mode }),
    onSuccess: (updated) => {
      setExecutionModeError(null);
      queryClient.setQueryData<TaskDetail>(["task", taskId], updated);
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
    onError: (err) => {
      setExecutionModeError(isApiError(err) ? err.message : "切换失败，请稍后重试");
    },
  });
  const handleToggleExecutionMode = (mode: "direct" | "plan") => {
    if (executionModeMutation.isPending) return;
    setExecutionModeError(null);
    executionModeMutation.mutate(mode);
  };

  const [reviewDialogPlanId, setReviewDialogPlanId] = useState<string | null>(null);
  const [reviewDialogVerdict, setReviewDialogVerdict] = useState<"approved" | "rejected">("approved");
  const [reviewDialogReason, setReviewDialogReason] = useState("");
  const [reviewDialogError, setReviewDialogError] = useState<string | null>(null);

  const planReviewMutation = useMutation({
    mutationFn: (payload: { planId: string; verdict: "approved" | "rejected"; reason?: string }) =>
      api.patch(`/plans/${payload.planId}/review`, {
        verdict: payload.verdict,
        ...(payload.reason ? { reason: payload.reason } : {}),
      }),
    onSuccess: () => {
      setReviewDialogPlanId(null);
      setReviewDialogReason("");
      setReviewDialogError(null);
      queryClient.invalidateQueries({ queryKey: ["plans", taskId] });
    },
    onError: (err) => {
      setReviewDialogError(isApiError(err) ? err.message : "评审提交失败，请稍后重试");
    },
  });

  /** 当前处于 loading 的 Agent 集合（members-panel 状态 + 指示器 label） */
  const loadingAgentIds = useMemo(
    () => new Set(Object.keys(loadingByAgent)),
    [loadingByAgent],
  );
  const pageError = taskQuery.isError ? (isApiError(taskQuery.error) ? taskQuery.error.message : "加载任务失败") : null;

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
      <TeamMembersPanel
        agents={agentMembers}
        loadingAgentIds={loadingAgentIds}
        sessionStatusByAgent={sessionByAgent}
        teamEditable={!teamId && (task.status === "pending" || task.status === "in_progress")}
        agentOptions={agentOptions}
        customAgents={customAgents}
        adding={addInstanceMutation.isPending}
        addError={addError}
        onAddInstance={handleAddInstance}
        width={membersPanel.width}
        onToggleEnabled={(instanceId: string, enabled: boolean) => toggleEnabledMutation.mutate({ instanceId, enabled })}
        onResetSession={(instanceId: string) => resetSessionMutation.mutate(instanceId)}
        onChangeModel={(instanceId: string, modelId: string | null) => instanceModelMutation.mutate({ instanceId, modelId })}
      />

      {/* 左侧面板拖拽分隔条（is_0000000017） */}
      <ResizeHandle label="调整成员面板宽度" onResizeStart={membersPanel.onResizeStart} />

      {/* 任务详情区（去聊天化：消息区/MessageInput 已移除，聊天唯一入口为团队会话） */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", backgroundColor: neutral[50], overflowY: "auto" }}>
        <div
          data-testid="task-detail-header"
          style={{
            padding: `${space.lg}px ${space.xl}px`,
            borderBottom: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
          }}
        >
          <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
            {task.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
            <span
              data-testid="status-badge"
              data-status={statusLabel}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: `${space.xs}px ${space.sm + 2}px`,
                borderRadius: radius.pill,
                backgroundColor: "var(--color-neutral-50)",
                border: "1px solid var(--color-neutral-300)",
                color: "var(--color-neutral-600)",
                fontSize: fontSize.sm,
                fontWeight: 500,
                lineHeight: 1.4,
                whiteSpace: "nowrap",
                ...baseFont,
              }}
            >
              {statusLabel}
            </span>
            {task.executionMode === "plan" ? (
              <span style={{ fontSize: fontSize.xs, color: "#2563EB" }}>计划模式</span>
            ) : null}
          </div>
          {task.description ? (
            <div style={{ fontSize: fontSize.md, color: neutral[700], lineHeight: 1.6, marginTop: space.sm }}>
              {task.description}
            </div>
          ) : null}
        </div>
        {teamId && (
          <div
            data-testid="team-session-redirect-banner"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.sm}px ${space.xl}px`,
              backgroundColor: "rgba(37,99,235,0.08)",
              borderBottom: `1px solid rgba(37,99,235,0.14)`,
              fontSize: fontSize.sm,
              color: "#2563EB",
            }}
          >
            <span>此任务的群聊已迁移至团队会话（常驻群聊，按团队复用）</span>
            <button
              type="button"
              data-testid="goto-team-session"
              data-team-id={teamId}
              onClick={() => router.push(`/teams/${teamId}/session`)}
              style={{
                marginLeft: "auto",
                padding: `${space.xs}px ${space.md}px`,
                borderRadius: radius.pill,
                border: "1px solid #2563EB",
                backgroundColor: "#2563EB",
                color: "#FFF",
                fontSize: fontSize.sm,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              前往团队会话 →
            </button>
          </div>
        )}
        {/* 任务元信息（优先级/创建时间/所属团队/主 Agent/状态操作） */}
        <div
          data-testid="task-detail-meta"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.sm,
            padding: `${space.lg}px ${space.xl}px`,
            borderBottom: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            ...baseFont,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: space.lg, flexWrap: "wrap", fontSize: fontSize.sm, color: neutral[600] }}>
            <span>优先级：{task.priority}</span>
            <span>创建时间：{formatTime(task.createdAt)}</span>
            <span>所属团队：{team?.name ?? task.teamId ?? "未指派"}</span>
            <span>主 Agent：{task.mainAgentId ?? "未指定"}</span>
          </div>
          <TaskStatusActions taskId={taskId} status={task.status} />
        </div>
        {pageError ? (
          <div data-testid="chat-error" role="alert" style={{ padding: space.xl, color: "#DC2626" }}>
            {pageError}
          </div>
        ) : null}
        {!teamId ? (
          <div
            data-testid="task-chat-migrated"
            style={{
              margin: `${space.lg}px ${space.xl}px`,
              padding: `${space.lg}px ${space.xl}px`,
              borderRadius: radius.md,
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              fontSize: fontSize.sm,
              color: neutral[500],
              lineHeight: 1.6,
            }}
          >
            该任务尚未指派团队，指派团队后可在团队会话中与团队 Agent 协作。
          </div>
        ) : null}
        {/* 执行模式工具栏（任务详情区底部） */}
        <div
          data-testid="execution-mode-toolbar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.xs}px ${space.md}px`,
            borderTop: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
          }}
        >
          <span style={{ fontSize: fontSize.sm, color: neutral[500], flexShrink: 0 }}>模式</span>
          <select
            data-testid="execution-mode-select"
            value={task.executionMode}
            onChange={(e) => handleToggleExecutionMode(e.target.value as "direct" | "plan")}
            disabled={executionModeMutation.isPending}
            style={{
              padding: `${space.xs}px ${space.sm}px`,
              borderRadius: radius.sm,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              fontSize: fontSize.sm,
              color: neutral[700],
              cursor: executionModeMutation.isPending ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            <option value="direct">轻量执行</option>
            <option value="plan">计划驱动</option>
          </select>
          {executionModeError ? (
            <span style={{ fontSize: fontSize.xs, color: "#DC2626", flex: 1 }}>
              {executionModeError}
            </span>
          ) : task.executionMode === "plan" && !plansQuery.data ? (
            <span style={{ fontSize: fontSize.xs, color: neutral[500], flex: 1 }}>
              计划模式下，主 Agent 将调用 plan_submit 产出执行计划并提交您评审；评审通过后任务方可启动
            </span>
          ) : null}
          {/* 预留扩展位：后续可添加模型选择等 */}
          <div style={{ flex: 1 }} />
        </div>
      </div>

      <ResizeHandle label="调整任务面板宽度" onResizeStart={taskPanel.onResizeStart} />

      <div style={{ width: taskPanel.width, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden", backgroundColor: "var(--color-surface)", borderLeft: `1px solid ${neutral[200]}` }}>
        <TaskRightTabs team={team} task={task} taskId={taskId} artifactsQuery={artifactsQuery} issuesQuery={issuesQuery} plansQuery={plansQuery} agents={agentMembers} onEditTaskInfo={()=>setTaskEditOpen(true)} onOpenArtifacts={()=>router.push(`/artifacts?pid=${task.projectId}`)} onOpenIssues={()=>router.push(`/issues?taskId=${taskId}`)} onToggleManagedMode={handleToggleManagedMode} onToggleExecutionMode={handleToggleExecutionMode} onOpenArtifactDoc={(a)=>{ const items=(artifactsQuery.data?.items ?? []) as {id:string;title:string}[]; router.push(`/docs/${taskId}?doc=${docIdFor(a.title, a.id, items)}`); }} />
        <div style={{ display: "none" }}>
          <TeamQueueCard team={team} taskId={taskId} />
          <TeamMemoryCard team={team} task={task} />
        </div>
        <div style={{ display: "none", flex: 1, minHeight: 0, overflowY: "auto" }}>
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
          onOpenDocs={(docSlug) => router.push(docSlug ? `/docs/${taskId}?doc=${docSlug}` : `/docs/${taskId}`)}
          onOpenProto={(protoId) => router.push(protoId ? `/docs/${taskId}?proto=${protoId}` : `/docs/${taskId}?proto=1`)}
          plan={plansQuery.data ?? null}
          planLoading={plansQuery.isPending}
          planError={plansQuery.error}
          onReviewPlan={(planId) => {
            setReviewDialogPlanId(planId);
            setReviewDialogVerdict("approved");
            setReviewDialogReason("");
            setReviewDialogError(null);
          }}
          reviewPending={planReviewMutation.isPending}
        />
        </div>
      </div>

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

      {/* 评审弹窗（plan-section「评审计划」按钮触发） */}
      <ReviewDialog
        open={!!reviewDialogPlanId}
        planId={reviewDialogPlanId}
        verdict={reviewDialogVerdict}
        reason={reviewDialogReason}
        error={reviewDialogError}
        submitting={planReviewMutation.isPending}
        onClose={() => { setReviewDialogPlanId(null); setReviewDialogReason(""); setReviewDialogError(null); }}
        onVerdictChange={setReviewDialogVerdict}
        onReasonChange={setReviewDialogReason}
        onSubmit={() => {
          if (!reviewDialogPlanId) return;
          if (reviewDialogVerdict === "rejected" && !reviewDialogReason.trim()) {
            setReviewDialogError("驳回时请填写原因");
            return;
          }
          planReviewMutation.mutate({
            planId: reviewDialogPlanId,
            verdict: reviewDialogVerdict,
            ...(reviewDialogVerdict === "rejected" ? { reason: reviewDialogReason.trim() } : {}),
          });
        }}
      />
    </div>
  );
}
