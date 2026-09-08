"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 任务创建页（vteam-team-refactor Task 12）
 * =============================================
 * - 左栏任务表单：标题* / 描述 / 背景文档上传 / 优先级 / 执行模式（同原型；托管模式为团队级，不在此设置）
 * - 右栏团队选择：团队下拉（GET /teams）+ 选中团队成员预览（只读）+ resetAfterComplete 勾选
 * - 提交：POST /tasks {teamId, resetAfterComplete?, title, description, priority, executionMode, backgroundDocs}
 * - 移除 agents / 主 Agent 面板（团队域已全局复用）
 */
import { useMemo, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AgentAvatar } from "@/src/components/ui";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import {
  neutral,
  roles,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
  type RoleKey,
} from "@/src/theme/tokens";
import type { CSSProperties } from "react";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** URL ?teamId= 预选团队（board/团队会话页带入；缺失则用户手动选择）。 */
function getInitialTeamId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("teamId");
}

/* ------------------------------ 背景文档（同原型） ------------------------------ */
const docTypeColors = { pdf: "#EF4444", csv: "#10B981", docx: "#3B82F6" } as const;
const DEFAULT_DOC_COLOR = "var(--color-neutral-500)";
interface UploadedFileMeta { url: string; name: string; size: number; ext: string; }
interface BackgroundDoc { name: string; size: string; ext: string; color: string; url: string; }
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function colorOf(ext: string): string {
  return docTypeColors[ext as keyof typeof docTypeColors] ?? DEFAULT_DOC_COLOR;
}

const pendingColor = "#D97706";
const pendingBg = "rgba(245,158,11,0.10)";
const pendingBorder = "rgba(245,158,11,0.28)";

const priorities = ["低", "中", "高"] as const;
type Priority = (typeof priorities)[number];
const PRIORITY_API: Record<Priority, string> = { 低: "low", 中: "medium", 高: "high" };

type ExecutionMode = "direct" | "plan";
const executionModes: { value: ExecutionMode; label: string; desc: string }[] = [
  { value: "direct", label: "轻量执行（默认）", desc: "直接启动，无需预先制定计划" },
  { value: "plan", label: "计划驱动", desc: "任务启动前主 Agent 产出执行计划，评审通过后实施" },
];

/* ================================ 左栏：任务表单 ================================ */
function TaskForm({
  title, onTitleChange, description, onDescriptionChange, priority, onPriorityChange,
  executionMode, onExecutionModeChange,
  titleError, docs, onRemoveDoc, uploading, uploadError, onUploadFile, onDismissUploadError,
}: {
  title: string; onTitleChange: (v: string) => void; description: string; onDescriptionChange: (v: string) => void;
  priority: Priority; onPriorityChange: (v: Priority) => void;
  executionMode: ExecutionMode; onExecutionModeChange: (v: ExecutionMode) => void; titleError: string | null;
  docs: BackgroundDoc[]; onRemoveDoc: (url: string) => void; uploading: boolean; uploadError: string | null;
  onUploadFile: (file: File) => void; onDismissUploadError: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fieldLabel: CSSProperties = { fontSize: fontSize.sm, fontWeight: 500, color: neutral[600], marginBottom: space.xs };
  const inputBase: CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[800], outline: "none", fontFamily: fontFamily.body,
  };
  return (
    <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg, padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, ...baseFont }}>
      <div>
        <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>任务信息</div>
        <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>描述任务目标，平台将按需指派团队完成。</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="task-title-input" style={fieldLabel}>任务标题 <span style={{ color: "#DC2626" }}>*</span></label>
        <input id="task-title-input" data-testid="task-title" type="text" placeholder="例如：智能报表模块开发" aria-label="任务标题" value={title} onChange={(e) => onTitleChange(e.target.value)} style={inputBase} />
        {titleError && <div data-testid="title-error" role="alert" style={{ display: "flex", alignItems: "center", gap: space.xs, marginTop: space.xs, fontSize: fontSize.sm, color: "#DC2626" }}><span aria-hidden style={{ fontWeight: 700 }}>!</span>{titleError}</div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="task-desc-input" style={fieldLabel}>任务描述</label>
        <textarea id="task-desc-input" data-testid="task-description" rows={6} placeholder="描述任务背景、目标与验收预期，团队将基于此展开协作…" aria-label="任务描述" value={description} onChange={(e) => onDescriptionChange(e.target.value)} style={{ ...inputBase, resize: "none", lineHeight: 1.6 }} />
      </div>
      <div data-testid="doc-upload" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <label style={fieldLabel}>背景文档</label>
        <button type="button" data-testid="doc-upload-btn" aria-label="上传背景文档" disabled={uploading} onClick={() => fileInputRef.current?.click()} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: space.xs, padding: `${space.xl}px ${space.lg}px`, borderRadius: radius.md, border: `1.5px dashed ${neutral[300]}`, backgroundColor: neutral[50], color: neutral[500], cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.7 : 1, fontFamily: fontFamily.body }}>
          <span aria-hidden style={{ fontSize: fontSize.xl, lineHeight: 1, color: "#2563EB" }}>↑</span>
          <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[600] }}>{uploading ? "上传中…" : "点击或拖拽上传背景文档"}</span>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>支持 PDF / Word / CSV，文件将沉淀到任务文档库供团队查看</span>
        </button>
        <input ref={fileInputRef} type="file" data-testid="doc-file-input" accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.gif,.md,.txt" onChange={(e) => { const file = e.target.files?.[0]; if (file) onUploadFile(file); e.target.value = ""; }} style={{ display: "none" }} />
        {uploadError && <div data-testid="doc-upload-error" role="alert" style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", fontSize: fontSize.sm, color: "#B91C1C", lineHeight: 1.6 }}><span aria-hidden style={{ flexShrink: 0 }}>!</span><span style={{ flex: 1, minWidth: 0 }}>{uploadError}</span><button type="button" data-testid="doc-upload-error-dismiss" aria-label="关闭上传错误提示" onClick={onDismissUploadError} style={{ border: "none", background: "none", fontSize: fontSize.sm, color: neutral[400], cursor: "pointer", padding: space.xs, flexShrink: 0, fontFamily: fontFamily.body }}>✕</button></div>}
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {docs.map((doc) => (
            <div key={doc.url} data-testid="doc-file-item" style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}` }}>
              <span aria-hidden style={{ width: 34, height: 34, borderRadius: radius.sm, backgroundColor: doc.color, color: "#FFFFFF", fontSize: fontSize.xs, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{doc.ext}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: fontSize.md, color: neutral[700], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>{doc.size}</span>
              <span role="button" data-testid="doc-file-remove" aria-label={`移除 ${doc.name}`} onClick={() => onRemoveDoc(doc.url)} style={{ fontSize: fontSize.sm, color: neutral[400], cursor: "pointer", padding: space.xs, flexShrink: 0 }}>✕</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="priority-select" style={fieldLabel}>优先级</label>
        <select id="priority-select" data-testid="priority-select" value={priority} onChange={(e) => onPriorityChange(e.target.value as Priority)} aria-label="优先级" style={{ ...inputBase, width: 200, cursor: "pointer" }}>
          {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <label htmlFor="execution-mode-select" style={fieldLabel}>执行模式</label>
        <select id="execution-mode-select" data-testid="execution-mode-select" value={executionMode} onChange={(e) => onExecutionModeChange(e.target.value as ExecutionMode)} aria-label="执行模式" style={{ ...inputBase, width: 240, cursor: "pointer" }}>
          {executionModes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <span style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>{executionModes.find((m) => m.value === executionMode)?.desc}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, color: neutral[500], lineHeight: 1.6 }}>
        <span aria-hidden style={{ color: "#2563EB", fontWeight: 700, lineHeight: 1.6 }}>i</span>
        任务创建后进入「待开始」或「排队中」状态；团队忙时自动排队，完成按序拉起。
      </div>
    </section>
  );
}

/* ================================ 右栏：团队选择（替代 Agent 面板） ================================ */
function TeamSelectPanel({
  teams, teamsLoading, teamsError, onRetry,
  selectedTeamId, onSelectTeam, selectedTeam,
  resetAfterComplete, onResetChange,
  teamError, submitting, created, createError, onCreate,
}: {
  teams: TeamDto[]; teamsLoading: boolean; teamsError: boolean; onRetry: () => void;
  selectedTeamId: string | null; onSelectTeam: (id: string) => void; selectedTeam: TeamDto | null;
  resetAfterComplete: boolean; onResetChange: (v: boolean) => void;
  teamError: string | null; submitting: boolean; created: boolean; createError: string | null; onCreate: () => void;
}) {
  const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];
  const toRole = (r: string | null): RoleKey => (r && (ROLE_KEYS as readonly string[]).includes(r) ? r as RoleKey : "developer");
  return (
    <section style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column", gap: space.lg, ...baseFont }}>
      <div style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md }}>
        <div>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>选择团队</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs, lineHeight: 1.6 }}>团队全局复用，同一团队串行执行，群聊跨任务复用。</div>
        </div>
        {teamsLoading ? (
          <div data-testid="teams-loading" style={{ fontSize: fontSize.sm, color: neutral[400] }}>加载团队中…</div>
        ) : teamsError ? (
          <div data-testid="teams-error" role="alert" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
            <span style={{ fontSize: fontSize.sm, color: "#DC2626" }}>团队列表加载失败</span>
            <button type="button" data-testid="teams-retry" onClick={onRetry} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.md, cursor: "pointer", fontFamily: fontFamily.body }}>重试</button>
          </div>
        ) : teams.length === 0 ? (
          <div data-testid="teams-empty" style={{ fontSize: fontSize.sm, color: neutral[400], padding: `${space.md}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}` }}>
            暂无团队，请先在「团队」页创建
            <Link data-testid="goto-teams" href="/teams" style={{ display: "inline-block", marginTop: space.sm, fontSize: fontSize.sm, color: "#2563EB", textDecoration: "none" }}>去创建团队 →</Link>
          </div>
        ) : (
          <>
            <label htmlFor="team-select" style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>团队 <span style={{ color: "#DC2626" }}>*</span></label>
            <select
              id="team-select"
              data-testid="team-select"
              value={selectedTeamId ?? ""}
              onChange={(e) => onSelectTeam(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${teamError ? "#DC2626" : neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[800], fontSize: fontSize.md, fontWeight: 500, outline: "none", cursor: "pointer", fontFamily: fontFamily.body }}
            >
              <option value="">请选择团队</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id} data-testid="team-option" data-team-id={t.id}>{t.name}（{t.members.length}人{t.currentTaskId ? " · 忙碌中" : " · 空闲"}）</option>
              ))}
            </select>
            {teamError && <div data-testid="team-error" role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626" }}>{teamError}</div>}
          </>
        )}

        {/* 选中团队成员预览（只读） */}
        {selectedTeam && (
          <div data-testid="team-member-preview" style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>成员预览</span>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{selectedTeam.members.length} 个实例 · {selectedTeam.reuseSession ? "复用会话" : "每任务新会话"}</span>
            </div>
            {selectedTeam.members.length === 0 ? (
              <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>该团队暂无成员</span>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                {selectedTeam.members.map((m) => {
                  const role = toRole(m.agent?.role ?? null);
                  const theme = roles[role];
                  return (
                    <div key={m.id} data-testid="team-member-preview-item" data-member-id={m.id} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.md, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}` }}>
                      <AgentAvatar role={role} size="sm" />
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fontSize.md, color: neutral[700], fontWeight: 500 }}>{m.alias}</span>
                      <span style={{ fontSize: fontSize.xs, color: theme.color, backgroundColor: theme.bg, border: `1px solid ${theme.border}`, borderRadius: radius.pill, padding: "1px 6px", flexShrink: 0 }}>{theme.label}</span>
                      <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>#{m.seq}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5 }}>成员为只读预览，如需调整请至「团队」页编辑。</div>
          </div>
        )}

        {/* resetAfterComplete 勾选 */}
        <label style={{ display: "flex", alignItems: "center", gap: space.md, cursor: "pointer", padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}` }}>
          <input type="checkbox" data-testid="reset-after-complete-toggle" checked={resetAfterComplete} onChange={(e) => onResetChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: "#2563EB" }} />
          <span style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>完成后重置会话</span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>覆盖团队 reuseSession，为下一任务开新会话</span>
          </span>
        </label>
      </div>

      <button type="button" data-testid="create-task-button" disabled={submitting} onClick={onCreate} style={{ width: "100%", padding: `${space.md + 2}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFFFFF", fontSize: fontSize.lg, fontWeight: 600, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1, boxShadow: "0 6px 16px rgba(37,99,235,.3)", fontFamily: fontFamily.body }}>
        {submitting ? "创建中…" : "创建任务"}
      </button>
      {created && <div data-testid="create-success" role="status" style={{ display: "flex", flexDirection: "column", gap: space.xs, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "rgba(16,185,129,0.10)", border: "1px solid rgba(16,185,129,0.28)", fontSize: fontSize.sm, color: "#065F46", lineHeight: 1.6 }}><span style={{ fontWeight: 600 }}>✓ 任务已创建</span><span>进入「待开始/排队中」状态，排队时按序自动拉起。</span></div>}
      {createError && <div data-testid="create-error" role="alert" style={{ display: "flex", alignItems: "flex-start", gap: space.xs, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", fontSize: fontSize.sm, color: "#B91C1C", lineHeight: 1.6 }}><span aria-hidden style={{ fontWeight: 700 }}>!</span>{createError}</div>}
      <div data-testid="create-hint" role="note" style={{ display: "flex", alignItems: "flex-start", gap: space.sm, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: pendingBg, border: `1px solid ${pendingBorder}`, fontSize: fontSize.sm, color: neutral[600], lineHeight: 1.6 }}>
        <span aria-hidden style={{ color: pendingColor, fontWeight: 700, lineHeight: 1.6 }}>⏱</span>
        <span>团队忙时任务自动<span style={{ fontWeight: 600, color: pendingColor }}>「排队中」</span>，完成后队首自动拉起；群聊按团队复用，历史跨任务可见。</span>
      </div>
    </section>
  );
}

/* ================================ 页面 ================================ */
export default function TaskCreatePage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("中");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("direct");
  const [selectedMessageChannelIds, setSelectedMessageChannelIds] = useState<string[]>([]);
  const [selectedNotificationChannelIds, setSelectedNotificationChannelIds] = useState<string[]>([]);
  const [backgroundDocs, setBackgroundDocs] = useState<BackgroundDoc[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append("file", file); return api.post<UploadedFileMeta>("/uploads", fd); },
    onSuccess: (meta) => setBackgroundDocs((prev) => [...prev, { name: meta.name, size: formatFileSize(meta.size), ext: meta.ext.toUpperCase(), color: colorOf(meta.ext), url: meta.url }]),
    onError: (err) => setUploadError(isApiError(err) ? err.message : "文档上传失败，请稍后重试"),
  });

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(() => getInitialTeamId());
  const [resetAfterComplete, setResetAfterComplete] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const teamsQuery = useQuery({
    queryKey: ["teams", "list", "task-create"],
    queryFn: () => teamsApi.list({ page: 1, pageSize: 100 }),
    enabled: !!user?.id,
  });
  const teams: TeamDto[] = teamsQuery.data?.items ?? [];
  const selectedTeam = useMemo(() => (selectedTeamId ? teams.find((t) => t.id === selectedTeamId) ?? null : null), [teams, selectedTeamId]);

  const handleRemoveDoc = (url: string) => setBackgroundDocs((prev) => prev.filter((d) => d.url !== url));

  const messageChannelsQuery = useQuery({ queryKey: ["message-channels"], queryFn: () => api.get<any[]>("/message-channels"), enabled: !!user?.id });
  const notificationChannelsQuery = useQuery({ queryKey: ["notification-channels"], queryFn: () => api.get<any[]>("/notification-channels"), enabled: !!user?.id });

  const handleCreate = async () => {
    if (!title.trim()) { setTitleError("请输入任务标题"); return; }
    setTitleError(null);
    if (!selectedTeamId) { setTeamError("请选择团队"); return; }
    setTeamError(null);
    setSubmitting(true);
    setCreateError(null);
    try {
      const res = await api.post<{ id: string }>("/tasks", {
        title: title.trim(),
        description: description || undefined,
        priority: PRIORITY_API[priority],
        backgroundDocs: backgroundDocs.map((d) => ({ name: d.name, url: d.url })),
        executionMode,
        teamId: selectedTeamId,
        ...(resetAfterComplete ? { resetAfterComplete: true } : {}),
      });
      setCreated(true);
      const taskId = res.id;
      if (selectedMessageChannelIds.length > 0) { try { await api.post(`/tasks/${taskId}/message-channels`, { messageChannelIds: selectedMessageChannelIds }); } catch {} }
      if (selectedNotificationChannelIds.length > 0) { try { await api.post(`/tasks/${taskId}/notification-channels`, { notificationChannelIds: selectedNotificationChannelIds }); } catch {} }
      router.push(`/teams/${selectedTeamId}/session`);
    } catch (err) {
      setCreateError(isApiError(err) ? err.message : "创建任务失败，请稍后重试");
    } finally { setSubmitting(false); }
  };

  return (
    <div data-testid="task-create-root" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: neutral[100], ...baseFont }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`, display: "flex", gap: space.xl, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: space.lg }}>
          <TaskForm
            title={title} onTitleChange={setTitle}
            description={description} onDescriptionChange={setDescription}
            priority={priority} onPriorityChange={setPriority}
            executionMode={executionMode} onExecutionModeChange={setExecutionMode}
            titleError={titleError} docs={backgroundDocs} onRemoveDoc={handleRemoveDoc}
            uploading={uploadMutation.isPending} uploadError={uploadError}
            onUploadFile={(file) => { setUploadError(null); uploadMutation.mutate(file); }}
            onDismissUploadError={() => setUploadError(null)}
          />
          <div data-testid="task-channel-binding-section" style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md, ...baseFont }}>
            <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>渠道绑定</div>
            <div style={{ fontSize: fontSize.sm, color: neutral[400] }}>创建后自动绑定到任务，可在任务详情右侧栏调整</div>
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>消息渠道 (入站)</span>
              {(messageChannelsQuery.data as any[] ?? []).length === 0 ? <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>{messageChannelsQuery.isPending ? "加载中…" : "暂无消息渠道"}</span> : (messageChannelsQuery.data as any[]).map((ch: any) => (
                <label key={ch.id} style={{ display: "flex", alignItems: "center", gap: space.sm, cursor: "pointer" }}>
                  <input type="checkbox" data-testid="message-channel-checkbox" data-channel-id={ch.id} checked={selectedMessageChannelIds.includes(ch.id)} onChange={(e) => setSelectedMessageChannelIds((prev) => e.target.checked ? [...prev, ch.id] : prev.filter((id) => id !== ch.id))} />
                  <span style={{ fontSize: fontSize.sm, color: neutral[700] }}>{ch.name}</span><span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{ch.type}</span>
                </label>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>通知渠道 (出站)</span>
              {(notificationChannelsQuery.data as any[] ?? []).length === 0 ? <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>{notificationChannelsQuery.isPending ? "加载中…" : "暂无通知渠道"}</span> : (notificationChannelsQuery.data as any[]).map((ch: any) => (
                <label key={ch.id} style={{ display: "flex", alignItems: "center", gap: space.sm, cursor: "pointer" }}>
                  <input type="checkbox" data-testid="notification-channel-checkbox" data-channel-id={ch.id} checked={selectedNotificationChannelIds.includes(ch.id)} onChange={(e) => setSelectedNotificationChannelIds((prev) => e.target.checked ? [...prev, ch.id] : prev.filter((id) => id !== ch.id))} />
                  <span style={{ fontSize: fontSize.sm, color: neutral[700] }}>{ch.name}</span><span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{ch.type}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <TeamSelectPanel
          teams={teams}
          teamsLoading={teamsQuery.isPending}
          teamsError={teamsQuery.isError}
          onRetry={() => teamsQuery.refetch()}
          selectedTeamId={selectedTeamId}
          onSelectTeam={setSelectedTeamId}
          selectedTeam={selectedTeam}
          resetAfterComplete={resetAfterComplete}
          onResetChange={setResetAfterComplete}
          teamError={teamError}
          submitting={submitting}
          created={created}
          createError={createError}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
