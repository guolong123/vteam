"use client";

/**
 * Issue 管理页（issue-management plan todo 4）
 * =============================================================
 * 任务内 issue 协作管理：列表（任务/状态筛选 + 状态/标签徽章 + 指派 +
 * 任务标题 + 创建者 + 时间）+ 创建/编辑弹窗 + 状态流转按钮组 + 删除确认。
 *
 * - 项目上下文（Metis M1）：仿 board 页 `?pid=` 必填——进入无 pid → 重定向
 *   /projects；任务下拉数据源 GET /projects/:pid/tasks（**不是 GET /tasks**）。
 * - 数据源：
 *   · useQuery(["issues", taskId, status]) → GET /issues?taskId=&status=（选中任务后）
 *   · GET /projects/:pid/tasks → 任务筛选下拉
 *   · GET /tasks/:id → 团队实例（T5 指派下拉按实例：开发者-1/开发者-2 分开，提交 assigneeInstanceId）
 *   · 省略 GET /users 指派用户下拉——users 端点挂 AdminGuard（成员 403），
 *     assigneeUserId 仅经后端 DTO 透传支持，UI 仅保留成员实例指派。
 * - 工具条：任务筛选下拉 + 状态筛选下拉 + 新建按钮（已选任务即显示，
 *   成员可建——issue 是任务内协作，后端经 task.projectId 校验任务成员）。
 * - 状态流转：独立 IssueStatusActions（禁止复用 Task 的 start/reject 常量，
 *   Metis m6——两者 action 同名），POST /issues/:id/transition。
 * - 删除：ConfirmDialog → DELETE /issues/:id（软删）。
 * - 风格对齐 models/skills 管理页（白卡 + 徽章 + 弹窗 + token 引用，
 *   铁律 T15：无 fixed / 100vh / 100vw，弹窗 absolute 相对宿主）。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { ConfirmDialog, EmptyState } from "@/src/components/ui";
import { IssueStatusActions } from "@/src/components/tasks/issue-status-actions";
import { IssueDetailModal } from "@/src/components/tasks/issue-detail-modal";
import { neutral, space, radius, fontSize, fontFamily, shadow, roles, type RoleKey } from "@/src/theme/tokens";
import type {
  CreateIssuePayload,
  IssueItem,
  IssueStatus,
  IssuesResponse,
  UpdateIssuePayload,
} from "@/src/types/issues";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 页面内扩展 token（仿原型范式，不写 tokens.ts） ------------------------------ */

/** Issue 状态四色：open=灰蓝 / in_progress=蓝 / resolved=绿 / closed=灰（独立于任务四态语义）。 */
const ISSUE_STATUS_THEME: Record<IssueStatus, { label: string; color: string; bg: string; border: string }> = {
  open: { label: "待处理", color: "#475569", bg: "#F8FAFC", border: "#CBD5E1" },
  in_progress: { label: "进行中", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  resolved: { label: "已解决", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  closed: { label: "已关闭", color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
};

/** tags 标签徽章多彩循环色板（需求/缺陷/优化 等自由标签按 index 循环取色）。 */
const TAG_THEMES: { color: string; bg: string; border: string }[] = [
  { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  { color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4" },
];

/* ------------------------------ 子组件 ------------------------------ */

/** issue 状态徽章（对齐 models 凭据徽章视觉）。 */
function IssueStatusBadge({ status }: { status: IssueStatus }) {
  const theme = ISSUE_STATUS_THEME[status] ?? ISSUE_STATUS_THEME.open;
  return (
    <span
      data-testid="issue-status-badge"
      data-status={status}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        flexShrink: 0,
        ...baseFont,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: theme.color,
          flexShrink: 0,
        }}
      />
      {theme.label}
    </span>
  );
}

/** tags 标签徽章（多彩，按 index 循环取色）。 */
function TagBadge({ tag, idx }: { tag: string; idx: number }) {
  const theme = TAG_THEMES[idx % TAG_THEMES.length];
  return (
    <span
      data-testid="issue-tag-badge"
      data-tag={tag}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${space.xs - 1}px ${space.sm + 1}px`,
        borderRadius: radius.sm,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      {tag}
    </span>
  );
}

/** ISO 时间 → 展示串（YYYY-MM-DD HH:mm，对齐管理页时间展示）。 */
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------ 创建 / 编辑弹窗 ------------------------------ */

interface IssueFormModalProps {
  open: boolean;
  /** 非空 = 编辑（预填）；null = 创建 */
  editing: IssueItem | null;
  taskId: string;
  /** 指派候选：任务团队实例（T5：{id:实例 id, name:别名, role}，开发者-1/开发者-2 分开）。 */
  agents: { id: string; name: string; role: string | null }[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: CreateIssuePayload | UpdateIssuePayload) => void;
}

function IssueFormModal({ open, editing, taskId, agents, submitting, error, onClose, onSubmit }: IssueFormModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [assigneeInstanceId, setAssigneeInstanceId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Esc 关闭（对齐 user-form-overlay 模式）
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // 每次打开重置表单：编辑预填（T5：优先实例 id，兼容旧 agentId 数据），创建清空
  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? "");
    setDescription(editing?.description ?? "");
    setTags((editing?.tags ?? []).join(", "));
    setAssigneeInstanceId(editing?.assigneeInstanceId ?? editing?.assigneeAgentId ?? "");
    setFormError(null);
  }, [open, editing]);

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!title.trim()) {
      setFormError("请填写 issue 标题");
      return;
    }
    const tagList = tags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    setFormError(null);
    if (editing) {
      onSubmit({
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        tags: tagList,
        assigneeInstanceId: assigneeInstanceId || null,
      });
    } else {
      onSubmit({
        taskId,
        title: title.trim(),
        description: description.trim() ? description.trim() : undefined,
        tags: tagList,
        assigneeInstanceId: assigneeInstanceId || undefined,
      });
    }
  };

  return (
    <div
      data-testid="issue-form-overlay"
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
        data-testid="issue-form-mask"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />

      <form
        data-testid="issue-form"
        onSubmit={handleSubmit}
        noValidate
        style={{
          position: "relative",
          width: 520,
          maxWidth: "calc(100% - 48px)",
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
            {editing ? "编辑 Issue" : "新建 Issue"}
          </div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
            {editing ? "修改标题 / 描述 / 标签 / 指派（变更指派会重新校验任务团队）" : "在任务内创建 issue，指派任务团队成员处理"}
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>
            标题 <span style={{ color: "#DC2626" }}>*</span>
          </span>
          <input
            data-testid="issue-title-input"
            value={title}
            maxLength={128}
            placeholder="如：登录页适配深色模式"
            onChange={(e) => setTitle(e.target.value)}
            style={{
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
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>描述</span>
          <textarea
            data-testid="issue-description-input"
            value={description}
            rows={3}
            maxLength={2048}
            placeholder="补充 issue 背景 / 复现步骤 / 验收标准（可选）"
            onChange={(e) => setDescription(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: `${space.md}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              fontSize: fontSize.md,
              color: neutral[800],
              outline: "none",
              resize: "vertical",
              fontFamily: fontFamily.body,
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>
            标签 <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>（逗号分隔，如 需求,缺陷）</span>
          </span>
          <input
            data-testid="issue-tags-input"
            value={tags}
            placeholder="需求, 缺陷, 优化…"
            onChange={(e) => setTags(e.target.value)}
            style={{
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
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>指派成员</span>
          <select
            data-testid="issue-assignee-select"
            value={assigneeInstanceId}
            onChange={(e) => setAssigneeInstanceId(e.target.value)}
            style={{
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
            }}
          >
            <option value="">不指派</option>
            {/* T5：按实例列出（别名唯一标识，@开发者-1 与 @开发者-2 分开），value=实例 id */}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.role ? `（${roles[a.role as RoleKey]?.label ?? a.role}）` : ""}
              </option>
            ))}
          </select>
        </label>

        {(formError || error) && (
          <div role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", fontWeight: 500 }}>
            {formError ?? error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button
            type="button"
            data-testid="issue-form-cancel"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: submitting ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消
          </button>
          <button
            type="submit"
            data-testid="issue-form-submit"
            disabled={submitting}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.6 : 1,
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "保存中…" : editing ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------ 列表行 ------------------------------ */

interface IssueRowProps {
  issue: IssueItem;
  agents: { id: string; name: string; role: string | null }[];
  onEdit: (issue: IssueItem) => void;
  onDelete: (issue: IssueItem) => void;
  /** 主列点击 → 弹 Issue 详情（is_0000000012）。 */
  onOpenDetail?: (issue: IssueItem) => void;
}

function IssueRow({ issue, agents, onEdit, onDelete, onOpenDetail }: IssueRowProps) {
  // T5：指派实例展示别名（agents=任务实例列表）；存量/未命中回退 agent/user 名
  const assigneeInst = issue.assigneeInstanceId
    ? agents.find((a) => a.id === issue.assigneeInstanceId)
    : undefined;
  const assignee = assigneeInst
    ? `${assigneeInst.name}${assigneeInst.role ? `（${roles[assigneeInst.role as RoleKey]?.label ?? assigneeInst.role}）` : ""}`
    : (issue.assigneeAgentName ?? issue.assigneeUserName);
  const creator = issue.creatorUserName ?? issue.creatorAgentName ?? issue.creatorUserId;
  return (
    <div
      data-testid="issue-item"
      data-issue-id={issue.id}
      data-status={issue.status}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: space.lg,
        padding: `${space.lg}px ${space.xl}px`,
        borderRadius: radius.lg,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        transition: "border-color .15s ease, background-color .15s ease",
        ...baseFont,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = "#F8FAFC";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.backgroundColor = "#FFFFFF";
      }}
    >
      {/* 主列：标题 + 状态徽章 + 标签徽章 + 元信息（点击弹详情，is_0000000012） */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`查看 issue 详情：${issue.title}`}
        data-testid="issue-row-detail"
        title="点击查看详情"
        onClick={() => onOpenDetail?.(issue)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenDetail?.(issue);
          }
        }}
        style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.sm, cursor: "pointer" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
          <span
            data-testid="issue-title"
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {issue.title}
          </span>
          {issue.tags.length > 0 && (
            <span data-testid="issue-tags" style={{ display: "inline-flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              {issue.tags.map((tag, idx) => (
                <TagBadge key={`${tag}-${idx}`} tag={tag} idx={idx} />
              ))}
            </span>
          )}
          <IssueStatusBadge status={issue.status} />
          <span
            style={{
              fontSize: fontSize.xs,
              color: neutral[400],
              fontFamily: fontFamily.mono,
            }}
          >
            {issue.id}
          </span>
        </div>

        {issue.description && (
          <div
            data-testid="issue-description"
            style={{
              fontSize: fontSize.md,
              color: neutral[600],
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {issue.description}
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.md,
            flexWrap: "wrap",
            fontSize: fontSize.sm,
            color: neutral[500],
          }}
        >
          <span data-testid="issue-task" style={{ display: "inline-flex", alignItems: "center", gap: space.xs }}>
            <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>▤</span>
            {issue.taskTitle ?? issue.taskId}
          </span>
          <span aria-hidden style={{ color: neutral[300] }}>·</span>
          <span data-testid="issue-assignee">
            指派：{assignee ?? "—"}
          </span>
          <span aria-hidden style={{ color: neutral[300] }}>·</span>
          <span data-testid="issue-creator">
            创建者：{creator ?? "—"}
          </span>
          <span aria-hidden style={{ color: neutral[300] }}>·</span>
          <span data-testid="issue-created-at">{formatTime(issue.createdAt)}</span>
        </div>
      </div>

      {/* 操作列：编辑 / 删除 + 状态流转按钮组（横向一行，窄屏换行） */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          gap: space.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <button
            type="button"
            data-testid="issue-edit-button"
            onClick={() => onEdit(issue)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.xs + 1}px ${space.md}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.sm,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              transition: "border-color .15s ease, color .15s ease",
            }}
          >
            ✎ 编辑
          </button>
          <button
            type="button"
            data-testid="issue-delete-button"
            onClick={() => onDelete(issue)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.xs + 1}px ${space.md}px`,
              borderRadius: radius.pill,
              border: `1px solid #FECACA`,
              backgroundColor: "#FFFFFF",
              color: "#DC2626",
              fontSize: fontSize.sm,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              transition: "border-color .15s ease, color .15s ease",
            }}
          >
            ✕ 删除
          </button>
        </div>
        <IssueStatusActions issueId={issue.id} status={issue.status} />
      </div>
    </div>
  );
}

/* ================================ 页面主组件 ================================ */

interface TaskOption {
  id: string;
  title: string;
}

interface TasksResponse {
  items: { id: string; title: string }[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /tasks/:id → instances 条目（T5 指派候选：实例 id + 别名 + 角色）。 */
interface TaskAssigneeOption {
  id: string;
  agentId: string;
  alias: string | null;
  seq: number;
  name: string;
  role: string | null;
  main: boolean;
}

type StatusFilterKey = "all" | IssueStatus;

const STATUS_FILTERS: { key: StatusFilterKey; label: string }[] = [
  { key: "all", label: "全部状态" },
  { key: "open", label: "待处理" },
  { key: "in_progress", label: "进行中" },
  { key: "resolved", label: "已解决" },
  { key: "closed", label: "已关闭" },
];

export default function IssuesPage() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const queryClient = useQueryClient();

  // 项目上下文：URL ?pid= 必填；无 pid 且已登录 → 重定向 /projects（effect 内读 window）
  const [pid, setPid] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterKey>("all");

  useEffect(() => {
    const urlPid = new URLSearchParams(window.location.search).get("pid");
    if (urlPid) {
      setPid(urlPid);
    } else if (user?.id) {
      router.replace("/projects");
    }
  }, [user, router]);

  // 弹窗状态：创建（null 关闭）+ 编辑（issue 非空）
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<IssueItem | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<IssueItem | null>(null);
  // Issue 详情弹窗（is_0000000012：IssueRow 主列点击）
  const [detailIssueId, setDetailIssueId] = useState<string | null>(null);

  // 任务下拉：GET /projects/:pid/tasks
  const tasksQuery = useQuery({
    queryKey: ["project-tasks", pid],
    queryFn: () =>
      api.get<TasksResponse>(`/projects/${pid}/tasks`, { query: { page: 1, pageSize: 100 } }),
    enabled: !!pid,
  });
  const tasks: TaskOption[] = (tasksQuery.data?.items ?? []).map((t) => ({ id: t.id, title: t.title }));

  // pid 变化 → 重置任务选中（避免残留上项目任务）
  useEffect(() => {
    setTaskId("");
    setStatusFilter("all");
  }, [pid]);

  // issue 列表：默认「全部任务」→ 按项目过滤（GET /issues?projectId=）；选中具体任务 → 按任务过滤
  const issuesQuery = useQuery({
    queryKey: ["issues", taskId, statusFilter, pid],
    queryFn: () =>
      api.get<IssuesResponse>("/issues", {
        query: {
          ...(taskId ? { taskId } : { projectId: pid ?? undefined }),
          status: statusFilter === "all" ? undefined : statusFilter,
          page: 1,
          pageSize: 100,
        },
      }),
    enabled: !!pid,
  });
  const issues = issuesQuery.data?.items ?? [];

  // 指派成员下拉（T5 实例化）：数据源 = 任务团队实例（GET /tasks/:id → instances，
  // 同角色多实例分开列出 开发者-1/开发者-2）。编辑时用 issue.taskId（任务筛选中可为空）。
  const assigneeTaskId = taskId || editing?.taskId || "";
  const taskDetailQuery = useQuery({
    queryKey: ["task", assigneeTaskId],
    queryFn: () => api.get<{ instances: TaskAssigneeOption[] }>(`/tasks/${assigneeTaskId}`),
    enabled: !!assigneeTaskId,
    retry: false,
  });
  const assigneeAgents: { id: string; name: string; role: string | null }[] = useMemo(
    () =>
      (taskDetailQuery.data?.instances ?? []).map((i) => ({
        id: i.id,
        name: i.alias ?? i.name,
        role: i.role,
      })),
    [taskDetailQuery.data],
  );

  // 创建：POST /issues
  const createMutation = useMutation({
    mutationFn: (payload: CreateIssuePayload) => api.post<IssueItem>("/issues", payload),
    onSuccess: () => {
      setFormOpen(false);
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (err) => {
      setFormError(isApiError(err) ? err.message : "创建失败，请稍后重试");
    },
  });

  // 编辑：PATCH /issues/:id
  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateIssuePayload }) =>
      api.patch<IssueItem>(`/issues/${id}`, payload),
    onSuccess: () => {
      setFormOpen(false);
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
    onError: (err) => {
      setFormError(isApiError(err) ? err.message : "保存失败，请稍后重试");
    },
  });

  // 删除：DELETE /issues/:id（软删）
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ id: string; deleted: boolean }>(`/issues/${id}`),
    onSuccess: () => {
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    },
  });

  const handleFormSubmit = (payload: CreateIssuePayload | UpdateIssuePayload) => {
    if (editing) {
      updateMutation.mutate({ id: editing.id, payload: payload as UpdateIssuePayload });
    } else {
      createMutation.mutate(payload as CreateIssuePayload);
    }
  };

  return (
    <div
      data-testid="issues-root"
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        backgroundColor: neutral[50],
        fontFamily: fontFamily.body,
        overflow: "auto",
      }}
    >
      <main style={{ flex: 1, minHeight: 0, padding: `${space.xl}px` }}>
        <div
          style={{
            maxWidth: 1080,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: space.lg,
          }}
        >
          {/* ① 工具条：任务筛选 + 状态筛选 + 新建按钮 */}
          <div data-testid="issues-toolbar" style={{ display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
            {/* 任务筛选下拉（pid 下任务） */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.sm,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.md, color: neutral[400], lineHeight: 1 }}>▤</span>
              <select
                data-testid="issue-task-select"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
                disabled={tasksQuery.isPending}
                style={{
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: fontSize.md,
                  color: neutral[800],
                  fontFamily: fontFamily.body,
                  cursor: "pointer",
                }}
              >
                <option value="">{tasksQuery.isPending ? "任务加载中…" : "全部任务"}</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>

            {/* 状态筛选下拉 */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.sm,
              }}
            >
              <span aria-hidden style={{ fontSize: fontSize.md, color: neutral[400], lineHeight: 1 }}>◔</span>
              <select
                data-testid="issue-status-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilterKey)}
                style={{
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: fontSize.md,
                  color: neutral[800],
                  fontFamily: fontFamily.body,
                  cursor: "pointer",
                }}
              >
                {STATUS_FILTERS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 新建按钮：已选任务即显示（issue 是任务内协作，任务成员可建） */}
            {taskId && (
              <button
                type="button"
                data-testid="issue-create-button"
                onClick={() => {
                  setEditing(null);
                  setFormError(null);
                  setFormOpen(true);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: space.xs,
                  marginLeft: "auto",
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.pill,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor: "pointer",
                  boxShadow: "0 6px 16px rgba(37,99,235,.3)",
                  fontFamily: fontFamily.body,
                }}
              >
                <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>＋</span>
                新建 Issue
              </button>
            )}
          </div>

          {/* ② 列表区：未选项目引导（pid 缺失通常已重定向 /projects）；默认「全部任务」直接展示列表 */}
          {!pid ? (
            /* 未选项目：引导选择（空态） */
            <div
              data-testid="issues-no-task"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.xxl}px`,
                textAlign: "center",
                borderRadius: radius.lg,
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.md,
              }}
            >
              <span aria-hidden style={{ fontSize: 26, color: neutral[300] }}>☰</span>
              <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[700] }}>请先选择项目</div>
              <div style={{ fontSize: fontSize.md, color: neutral[400] }}>
                从项目卡片进入 Issue 管理，即可查看与管理该项目所有任务的 issue
              </div>
            </div>
          ) : issuesQuery.isPending ? (
            <div
              data-testid="issues-loading"
              style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xxl}px 0`, textAlign: "center" }}
            >
              加载中…
            </div>
          ) : issuesQuery.isError ? (
            <div
              data-testid="issues-error"
              role="alert"
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: space.md,
                padding: `${space.xl}px`,
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: fontSize.md, color: "#DC2626" }}>
                {isApiError(issuesQuery.error) ? issuesQuery.error.message : "加载 issue 列表失败"}
              </div>
              <button
                type="button"
                data-testid="issues-retry"
                onClick={() => issuesQuery.refetch()}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: neutral[600],
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                重试
              </button>
            </div>
          ) : (
            /* 白卡列表容器 + 表头 + 数据行 */
            <div
              data-testid="issue-list"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: space.sm,
                padding: space.md,
                borderRadius: radius.lg,
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                boxShadow: shadow.md,
              }}
            >
              {/* 列表头 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.md,
                  padding: `${space.sm}px ${space.md}px`,
                }}
              >
                <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>{taskId ? "任务 Issue" : "项目 Issue"}</span>
                <span
                  style={{
                    fontSize: fontSize.xs,
                    color: neutral[500],
                    backgroundColor: neutral[50],
                    border: `1px solid ${neutral[200]}`,
                    borderRadius: radius.pill,
                    padding: "2px 10px",
                    fontFamily: fontFamily.mono,
                  }}
                >
                  {issuesQuery.data?.total ?? 0} 个 issue
                </span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                  {taskId ? (tasks.find((t) => t.id === taskId)?.title ?? taskId) : "全部任务"}
                </span>
              </div>

              {issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  agents={assigneeAgents}
                  onEdit={(i) => {
                    setEditing(i);
                    setFormError(null);
                    setFormOpen(true);
                  }}
                  onDelete={setDeleteTarget}
                  onOpenDetail={(i) => setDetailIssueId(i.id)}
                />
              ))}

              {issues.length === 0 && (
                <EmptyState
                  title="暂无 Issue"
                  description={taskId ? "该任务还没有 issue，点击「新建 Issue」创建第一条（如需求 / 缺陷）" : "该项目还没有 issue"}
                  icon={<span aria-hidden>☰</span>}
                />
              )}
            </div>
          )}
        </div>
      </main>

      {/* 创建 / 编辑弹窗 */}
      <IssueFormModal
        open={formOpen}
        editing={editing}
        taskId={taskId}
        agents={assigneeAgents}
        submitting={createMutation.isPending || updateMutation.isPending}
        error={formError}
        onClose={() => {
          setFormOpen(false);
          setFormError(null);
        }}
        onSubmit={handleFormSubmit}
      />

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        testid="issue-delete"
        title={`删除 Issue「${deleteTarget?.title ?? ""}」？`}
        description="删除后该 issue 将从列表移除（软删，不影响任务与其他 issue）。"
        confirmLabel="确认删除"
        pendingLabel="删除中…"
        danger
        submitting={deleteMutation.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />

      {/* Issue 详情弹窗（is_0000000012：列表行主列点击） */}
      <IssueDetailModal
        issueId={detailIssueId}
        open={!!detailIssueId}
        onClose={() => setDetailIssueId(null)}
        agents={assigneeAgents}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ["issues"] })}
      />
    </div>
  );
}
