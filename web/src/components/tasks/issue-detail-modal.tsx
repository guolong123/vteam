"use client";

/**
 * Issue 详情弹窗（is_0000000012 共享组件）
 * =============================================================
 * 双入口复用：会话页右侧 TaskPanel「待办 Issue」点击 + issue 列表页 IssueRow 主列点击。
 * - 数据源：useQuery(["issue", issueId]) → GET /issues/:id（详情 DTO，含任务标题/指派/创建者名）。
 * - 详情区：标题 / 状态徽章 / 标签 / 描述 / 指派（实例别名）/ 创建者 / 时间。
 * - 操作区：IssueStatusActions（状态流转按钮组，onSettled 失效 ["issue", id] 缓存联动）。
 * - 编辑区：编辑模式复用 IssueFormModal 同款字段（标题/描述/标签/指派）→ PATCH /issues/:id。
 * - 样式对齐 issues 页弹窗范式（absolute 相对宿主 + 轻遮罩，铁律 T15 无 fixed）。
 * - is_0000000013 扩展点：status=rejected 主题、拒绝原因展示、操作记录列表（见 issues 域类型）。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { neutral, space, radius, fontSize, fontFamily, shadow, roles, type RoleKey } from "@/src/theme/tokens";
import { IssueStatusActions } from "@/src/components/tasks/issue-status-actions";
import type {
  IssueStatus,
  IssueItem,
  UpdateIssuePayload,
} from "@/src/types/issues";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Issue 状态徽章（对齐 issues 页 ISSUE_STATUS_THEME；is_0000000013 增 rejected 主题）。 */
const ISSUE_STATUS_THEME: Record<IssueStatus, { label: string; color: string; bg: string; border: string }> = {
  open: { label: "待处理", color: "var(--color-neutral-600)", bg: "var(--color-neutral-50)", border: "var(--color-neutral-300)" },
  in_progress: { label: "进行中", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  resolved: { label: "已解决", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  closed: { label: "已关闭", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
  rejected: { label: "已拒绝", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
};

/** 操作记录动作中文文案（is_0000000013）。 */
const ACTIVITY_ACTION_LABEL: Record<string, string> = {
  create: "创建",
  update: "编辑",
  transition: "状态流转",
};

/** 操作记录状态中文（缺省原值）。 */
function statusLabel(status: string | null): string {
  if (!status) return "—";
  const map: Record<string, string> = {
    open: "待处理",
    in_progress: "进行中",
    resolved: "已解决",
    closed: "已关闭",
    rejected: "已拒绝",
  };
  return map[status] ?? status;
}

/** 状态徽章（对齐 issues 页 IssueStatusBadge 视觉）。 */
function IssueStatusBadge({ status }: { status: IssueStatus }) {
  const theme = ISSUE_STATUS_THEME[status] ?? ISSUE_STATUS_THEME.open;
  return (
    <span
      data-testid="issue-detail-status-badge"
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
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: theme.color, flexShrink: 0 }} />
      {theme.label}
    </span>
  );
}

/** tags 标签徽章（多彩，按 index 循环取色，对齐 issues 页 TAG_THEMES）。 */
const TAG_THEMES: { color: string; bg: string; border: string }[] = [
  { color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  { color: "#7C3AED", bg: "rgba(124,58,237,0.10)", border: "rgba(124,58,237,0.22)" },
  { color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  { color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
  { color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
  { color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4" },
];

function TagBadge({ tag, idx }: { tag: string; idx: number }) {
  const theme = TAG_THEMES[idx % TAG_THEMES.length];
  return (
    <span
      data-testid="issue-detail-tag"
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

/** ISO 时间 → 展示串（YYYY-MM-DD HH:mm）。 */
function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface IssueDetailModalProps {
  /** 目标 issue id；null 关闭。 */
  issueId: string | null;
  open: boolean;
  onClose: () => void;
  /** 指派候选：任务团队实例（[{id:实例 id, name:别名, role}]）。 */
  agents: { id: string; name: string; role: string | null }[];
  /** 数据变更后外部联动（失效列表缓存等）。 */
  onChanged?: () => void;
}

const inputBase: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${space.md}px ${space.lg}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  fontSize: fontSize.md,
  color: neutral[800],
  outline: "none",
  fontFamily: fontFamily.body,
};

export function IssueDetailModal({ issueId, open, onClose, agents, onChanged }: IssueDetailModalProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [assigneeInstanceId, setAssigneeInstanceId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["issue", issueId],
    queryFn: () => api.get<IssueItem>(`/issues/${issueId}`),
    enabled: open && !!issueId,
    retry: false,
  });
  const issue = detailQuery.data;

  // Esc 关闭（对齐 issues 页弹窗模式）
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // issue 变化 → 重置编辑态表单（进入编辑时预填）
  useEffect(() => {
    if (!issue) return;
    setTitle(issue.title);
    setDescription(issue.description ?? "");
    setTags((issue.tags ?? []).join(", "));
    setAssigneeInstanceId(issue.assigneeInstanceId ?? issue.assigneeAgentId ?? "");
    setFormError(null);
  }, [issue]);

  // 编辑保存：PATCH /issues/:id → 失效 ["issue", id] + 外部联动
  const updateMutation = useMutation({
    mutationFn: (payload: UpdateIssuePayload) =>
      api.patch<IssueItem>(`/issues/${issueId}`, payload),
    onSuccess: () => {
      setEditing(false);
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: ["issue", issueId] });
      onChanged?.();
    },
    onError: (err) => {
      setFormError(isApiError(err) ? err.message : "保存失败，请稍后重试");
    },
  });

  const handleSave = () => {
    if (updateMutation.isPending) return;
    if (!title.trim()) {
      setFormError("请填写 issue 标题");
      return;
    }
    const tagList = tags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    setFormError(null);
    updateMutation.mutate({
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      tags: tagList,
      assigneeInstanceId: assigneeInstanceId || null,
    });
  };

  if (!open) return null;

  return (
    <div
      data-testid="issue-detail-overlay"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "6%",
        ...baseFont,
      }}
    >
      {/* 轻遮罩：点击关闭 */}
      <div
        aria-hidden
        data-testid="issue-detail-mask"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />

      <div
        data-testid="issue-detail-modal"
        style={{
          position: "relative",
          width: 620,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "calc(100% - 12%)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        {detailQuery.isPending ? (
          <div style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0`, textAlign: "center" }}>
            加载中…
          </div>
        ) : detailQuery.isError || !issue ? (
          <div role="alert" style={{ fontSize: fontSize.md, color: "#DC2626", padding: `${space.xl}px 0`, textAlign: "center" }}>
            {isApiError(detailQuery.error) ? detailQuery.error.message : "加载 issue 详情失败"}
          </div>
        ) : (
          <>
            {/* 头部：标题 + 状态徽章 + id */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: space.md }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  data-testid="issue-detail-title"
                  style={{
                    fontSize: fontSize.xl,
                    fontWeight: 600,
                    color: neutral[900],
                    lineHeight: 1.4,
                    wordBreak: "break-word",
                  }}
                >
                  {editing ? (
                    <input
                      data-testid="issue-detail-title-input"
                      value={title}
                      maxLength={128}
                      onChange={(e) => setTitle(e.target.value)}
                      style={inputBase}
                    />
                  ) : (
                    issue.title
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm, flexWrap: "wrap" }}>
                  <IssueStatusBadge status={issue.status} />
                  <span style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono }}>{issue.id}</span>
                </div>
              </div>
              <button
                type="button"
                data-testid="issue-detail-close"
                aria-label="关闭详情"
                onClick={onClose}
                style={{
                  border: "none",
                  background: "none",
                  fontSize: fontSize.lg,
                  color: neutral[400],
                  cursor: "pointer",
                  padding: space.xs,
                  flexShrink: 0,
                  fontFamily: fontFamily.body,
                }}
              >
                ✕
              </button>
            </div>

            {/* 标签 */}
            {issue.tags.length > 0 && (
              <div data-testid="issue-detail-tags" style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                {issue.tags.map((tag, idx) => (
                  <TagBadge key={`${tag}-${idx}`} tag={tag} idx={idx} />
                ))}
              </div>
            )}

            {/* 描述 */}
            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.xs }}>描述</div>
              {editing ? (
                <textarea
                  data-testid="issue-detail-description-input"
                  value={description}
                  rows={4}
                  maxLength={2048}
                  onChange={(e) => setDescription(e.target.value)}
                  style={{ ...inputBase, resize: "vertical", lineHeight: 1.6 }}
                />
              ) : (
                <div
                  data-testid="issue-detail-description"
                  style={{
                    fontSize: fontSize.md,
                    color: neutral[700],
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    lineHeight: 1.6,
                    backgroundColor: neutral[50],
                    border: `1px solid ${neutral[200]}`,
                    borderRadius: radius.md,
                    padding: `${space.md}px ${space.lg}px`,
                    minHeight: 48,
                  }}
                >
                  {issue.description || <span style={{ color: neutral[400] }}>暂无描述</span>}
                </div>
              )}
            </div>

            {/* 标签（编辑态） */}
            {editing && (
              <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>
                  标签 <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>（逗号分隔，如 需求,缺陷）</span>
                </span>
                <input
                  data-testid="issue-detail-tags-input"
                  value={tags}
                  placeholder="需求, 缺陷, 优化…"
                  onChange={(e) => setTags(e.target.value)}
                  style={inputBase}
                />
              </label>
            )}

            {/* 指派（编辑态下拉） */}
            <div>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.xs }}>指派</div>
              {editing ? (
                <select
                  data-testid="issue-detail-assignee-select"
                  value={assigneeInstanceId}
                  onChange={(e) => setAssigneeInstanceId(e.target.value)}
                  style={{ ...inputBase, cursor: "pointer" }}
                >
                  <option value="">不指派</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.role ? `（${roles[a.role as RoleKey]?.label ?? a.role}）` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div data-testid="issue-detail-assignee" style={{ fontSize: fontSize.md, color: neutral[700] }}>
                  {issue.assigneeInstanceId
                    ? (() => {
                        const inst = agents.find((a) => a.id === issue.assigneeInstanceId);
                        return inst
                          ? `${inst.name}${inst.role ? `（${roles[inst.role as RoleKey]?.label ?? inst.role}）` : ""}`
                          : issue.assigneeAgentName ?? issue.assigneeUserName ?? "—";
                      })()
                    : issue.assigneeAgentName ?? issue.assigneeUserName ?? "—"}
                </div>
              )}
            </div>

            {/* 元信息：创建者 / 创建时间 */}
            <div style={{ display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap", fontSize: fontSize.sm, color: neutral[500] }}>
              <span data-testid="issue-detail-creator">
                创建者：{issue.creatorUserName ?? issue.creatorAgentName ?? "—"}
              </span>
              <span aria-hidden style={{ color: neutral[300] }}>·</span>
              <span data-testid="issue-detail-created-at">{formatTime(issue.createdAt)}</span>
              <span aria-hidden style={{ color: neutral[300] }}>·</span>
              <span data-testid="issue-detail-task">{issue.taskTitle ?? issue.taskId}</span>
            </div>

            {/* 拒绝原因（is_0000000013：status=rejected 时展示拒绝信息） */}
            {issue.status === "rejected" && (
              <div
                data-testid="issue-detail-reject-reason"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: space.xs,
                  padding: `${space.md}px ${space.lg}px`,
                  borderRadius: radius.md,
                  backgroundColor: "rgba(239,68,68,0.10)",
                  border: `1px solid rgba(239,68,68,0.22)`,
                }}
              >
                <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: "#B91C1C" }}>
                  拒绝原因
                </div>
                <div style={{ fontSize: fontSize.md, color: neutral[700], whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.6 }}>
                  {issue.rejectReason || <span style={{ color: neutral[400] }}>—</span>}
                </div>
                <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>
                  {formatTime(issue.rejectedAt)}
                </div>
              </div>
            )}

            {/* 操作记录（is_0000000013：每次操作含操作人） */}
            <div style={{ paddingTop: space.md, borderTop: `1px solid ${neutral[200]}` }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.sm }}>
                操作记录 · {issue.activities.length}
              </div>
              {issue.activities.length > 0 ? (
                <div data-testid="issue-detail-activities" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                  {issue.activities.map((act) => (
                    <div
                      key={act.id}
                      data-testid="issue-detail-activity"
                      data-action={act.action}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: space.sm,
                        padding: `${space.sm + 1}px ${space.md}px`,
                        borderRadius: radius.md,
                        backgroundColor: neutral[50],
                        border: `1px solid ${neutral[200]}`,
                        fontSize: fontSize.sm,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          backgroundColor:
                            act.action === "transition"
                              ? "#2563EB"
                              : act.action === "update"
                                ? "#D97706"
                                : "#059669",
                          flexShrink: 0,
                          marginTop: 5,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap", color: neutral[700] }}>
                          <span style={{ fontWeight: 600 }}>{act.actorName || act.actorId || "—"}</span>
                          <span style={{ color: neutral[400] }}>{ACTIVITY_ACTION_LABEL[act.action] ?? act.action}</span>
                          {act.action === "transition" && (
                            <span style={{ color: neutral[500] }}>
                              {statusLabel(act.fromStatus)} → {statusLabel(act.toStatus)}
                            </span>
                          )}
                          <span style={{ color: neutral[400], marginLeft: "auto" }}>{formatTime(act.createdAt)}</span>
                        </div>
                        {act.action === "transition" && act.metadata && typeof act.metadata.reason === "string" && (
                          <div style={{ color: neutral[500], marginTop: 2, lineHeight: 1.5 }}>
                            原因：{act.metadata.reason}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: fontSize.sm, color: neutral[400] }}>暂无操作记录</div>
              )}
            </div>

            {/* 状态流转操作区 */}
            <div style={{ paddingTop: space.md, borderTop: `1px solid ${neutral[200]}` }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.sm }}>状态操作</div>
              <IssueStatusActions
                issueId={issue.id}
                status={issue.status}
                onSettled={() => queryClient.invalidateQueries({ queryKey: ["issue", issueId] })}
              />
            </div>

            {(formError || updateMutation.isError) && (
              <div role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", fontWeight: 500 }}>
                {formError ?? (isApiError(updateMutation.error) ? updateMutation.error.message : "保存失败")}
              </div>
            )}

            {/* 操作：编辑 / 保存 */}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
              {editing ? (
                <>
                  <button
                    type="button"
                    data-testid="issue-detail-cancel"
                    onClick={() => {
                      setEditing(false);
                      setFormError(null);
                      if (issue) {
                        setTitle(issue.title);
                        setDescription(issue.description ?? "");
                        setTags((issue.tags ?? []).join(", "));
                        setAssigneeInstanceId(issue.assigneeInstanceId ?? issue.assigneeAgentId ?? "");
                      }
                    }}
                    disabled={updateMutation.isPending}
                    style={{
                      padding: `${space.sm + 1}px ${space.lg}px`,
                      borderRadius: radius.pill,
                      border: `1px solid ${neutral[200]}`,
                      backgroundColor: "var(--color-surface)",
                      color: neutral[600],
                      fontSize: fontSize.md,
                      cursor: updateMutation.isPending ? "default" : "pointer",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    data-testid="issue-detail-save"
                    onClick={handleSave}
                    disabled={updateMutation.isPending}
                    style={{
                      padding: `${space.sm + 1}px ${space.lg}px`,
                      borderRadius: radius.pill,
                      border: "none",
                      backgroundColor: "#2563EB",
                      color: "#FFFFFF",
                      fontSize: fontSize.md,
                      fontWeight: 500,
                      cursor: updateMutation.isPending ? "default" : "pointer",
                      opacity: updateMutation.isPending ? 0.6 : 1,
                      boxShadow: "0 6px 16px rgba(37,99,235,.3)",
                      fontFamily: fontFamily.body,
                    }}
                  >
                    {updateMutation.isPending ? "保存中…" : "保存"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="issue-detail-edit"
                  onClick={() => {
                    setFormError(null);
                    setEditing(true);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: space.xs,
                    padding: `${space.sm + 1}px ${space.lg}px`,
                    borderRadius: radius.pill,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                    color: neutral[600],
                    fontSize: fontSize.md,
                    fontWeight: 500,
                    cursor: "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  ✎ 编辑
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
