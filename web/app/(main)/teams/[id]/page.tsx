"use client";

/**
 * 团队详情页（Task 11）
 * =============================================
 * - 团队信息（name/description/reuseSession 开关 version 乐观锁）
 * - 当前任务卡片（currentTaskId）
 * - 队列预览（queue position/taskId/enqueuedAt）
 * - 成员列表（alias/workDir 行内编辑，增删改；多实例支持）
 * - 删除团队（仅空闲可点：currentTaskId==null && queue.length==0，否则 disabled + 提示）
 * - 添加成员：Agent 选择（复用角色卡片简化版 + 自定义）
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { teamsApi, type TeamDto, type TeamMemberDto, type TeamQueueDto } from "@/src/api/teams";
import { AgentAvatar, ConfirmDialog } from "@/src/components/ui";
import {
  type RoleKey,
  neutral,
  roles,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };
const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"] as const;
function toAvatarRole(role: string | null): RoleKey {
  return role && (ROLE_KEYS as readonly string[]).includes(role as RoleKey) ? (role as RoleKey) : "developer";
}


interface AgentItem { id: string; name: string; role: string; type: string }

function MemberRow({ member, isMain, onSave, onRemove, onSetMain }: { member: TeamMemberDto; isMain: boolean; onSave: (payload: { alias?: string; workDir?: string }) => void; onRemove: () => void; onSetMain: () => void }) {
  const [alias, setAlias] = useState(member.alias);
  const [workDir, setWorkDir] = useState(member.workDir);
  const dirty = alias !== member.alias || workDir !== member.workDir;
  useEffect(() => { setAlias(member.alias); setWorkDir(member.workDir); }, [member.alias, member.workDir]);
  const roleKey = toAvatarRole(member.agent?.role ?? null);
  const theme = roles[roleKey];
  return (
    <div data-testid="member-row" data-member-id={member.id} data-main={isMain ? "true" : "false"} style={{ display: "flex", flexDirection: "column", gap: space.xs, padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: isMain ? "#FFF7ED" : "var(--color-surface)", border: `1px solid ${isMain ? "#F59E0B" : neutral[200]}`, boxShadow: shadow.sm }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <AgentAvatar role={roleKey} size="sm" />
        <span style={{ fontSize: fontSize.xs, color: theme.color, backgroundColor: theme.bg, border: `1px solid ${theme.border}`, padding: "1px 6px", borderRadius: radius.pill }}>{theme.label}</span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>#{member.seq}</span>
        <span style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{member.agent?.name ?? member.agentId}</span>
        {isMain && <span data-testid="main-badge" style={{ fontSize: fontSize.xs, color: "#FFF", backgroundColor: "#F59E0B", padding: "1px 6px", borderRadius: radius.pill, fontWeight: 700 }}>★ 主 Agent</span>}
        {!isMain && <button type="button" data-testid="set-main-agent" onClick={onSetMain} style={{ border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: "#D97706", cursor: "pointer", padding: `${space.xs}px ${space.sm}px`, fontSize: fontSize.xs, fontWeight: 500, borderRadius: radius.pill, fontFamily: fontFamily.body }}>设为主 Agent</button>}
        <button type="button" data-testid="member-remove" onClick={onRemove} style={{ border: "none", background: "none", color: neutral[400], cursor: "pointer", padding: space.xs, fontSize: fontSize.sm, fontFamily: fontFamily.body }}>✕</button>
      </div>
      <div style={{ display: "flex", gap: space.sm, alignItems: "center" }}>
        <input data-testid="member-alias-input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="别名" aria-label="成员别名" style={{ flex: 1, minWidth: 0, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[800], outline: "none", fontFamily: fontFamily.body }} />
        <input data-testid="member-workdir-input" value={workDir} onChange={(e) => setWorkDir(e.target.value)} placeholder="/data/vteam-worker/…" aria-label="工作目录" style={{ flex: 1, minWidth: 0, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], fontSize: fontSize.xs, color: neutral[600], outline: "none", fontFamily: fontFamily.mono }} />
        <button type="button" data-testid="member-save" disabled={!dirty} onClick={() => onSave({ alias: alias.trim() || undefined, workDir: workDir.trim() || undefined })} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: "none", backgroundColor: dirty ? "#2563EB" : neutral[200], color: dirty ? "#FFF" : neutral[400], fontSize: fontSize.sm, fontWeight: 500, cursor: dirty ? "pointer" : "default", fontFamily: fontFamily.body, flexShrink: 0 }}>保存</button>
      </div>
    </div>
  );
}

export default function TeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [showAddMember, setShowAddMember] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [addAlias, setAddAlias] = useState("");
  const [addWorkDir, setAddWorkDir] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const teamQuery = useQuery({
    queryKey: ["team", id],
    queryFn: () => teamsApi.get(id),
    enabled: !!id,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<{ items: AgentItem[] }>("/agents"),
    enabled: showAddMember,
  });

  const team: TeamDto | undefined = teamQuery.data;

  useEffect(() => {
    if (team) { setEditName(team.name); setEditDesc(team.description ?? ""); }
  }, [team]);

  const isIdle = !!team && !team.currentTaskId && team.queue.length === 0;

  const patchMutation = useMutation({
    mutationFn: (payload: { name?: string; description?: string | null; reuseSession?: boolean; mainAgentMemberId?: string | null }) =>
      teamsApi.update(id, { ...payload, version: team?.version }),
  });

  const handleSetMainAgent = async (memberId: string) => {
    if (!team) return;
    setActionError(null);
    try {
      await patchMutation.mutateAsync({ mainAgentMemberId: memberId });
      queryClient.invalidateQueries({ queryKey: ["team", id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    } catch (err) {
      setActionError(isApiError(err) ? err.message : "设置主 Agent 失败");
    }
  };

  const handleToggleReuse = async () => {
    if (!team) return;
    setActionError(null);
    try {
      await patchMutation.mutateAsync({ reuseSession: !team.reuseSession });
      queryClient.invalidateQueries({ queryKey: ["team", id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    } catch (err) {
      setActionError(isApiError(err) ? err.message : "更新失败");
    }
  };

  const handleSaveName = async () => {
    if (!team || editName.trim() === team.name && editDesc.trim() === (team.description ?? "")) return;
    if (!editName.trim()) { setActionError("团队名称不能为空"); return; }
    setActionError(null);
    try {
      await patchMutation.mutateAsync({ name: editName.trim(), description: editDesc.trim() || null });
      queryClient.invalidateQueries({ queryKey: ["team", id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    } catch (err) { setActionError(isApiError(err) ? err.message : "更新失败"); }
  };

  const addMutation = useMutation({
    mutationFn: () => teamsApi.addMember(id, { agentId: selectedAgentId, alias: addAlias.trim() || undefined, workDir: addWorkDir.trim() || undefined }),
  });
  const handleAddMember = async () => {
    if (!selectedAgentId) { setActionError("请选择 Agent"); return; }
    setActionError(null);
    try {
      await addMutation.mutateAsync();
      setShowAddMember(false); setSelectedAgentId(""); setAddAlias(""); setAddWorkDir("");
      queryClient.invalidateQueries({ queryKey: ["team", id] });
    } catch (err) { setActionError(isApiError(err) ? err.message : "添加失败"); }
  };

  const updateMemberMutation = useMutation({
    mutationFn: ({ memberId, payload }: { memberId: string; payload: { alias?: string; workDir?: string } }) =>
      teamsApi.updateMember(id, memberId, payload),
  });
  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => teamsApi.removeMember(id, memberId),
  });

  const deleteMutation = useMutation({ mutationFn: () => teamsApi.remove(id) });

  const cancelQueueMutation = useMutation({
    mutationFn: (taskId: string) => teamsApi.cancelQueue(id, taskId),
  });
  const handleCancelQueue = async (taskId: string) => {
    setActionError(null);
    try {
      await cancelQueueMutation.mutateAsync(taskId);
      queryClient.invalidateQueries({ queryKey: ["team", id] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    } catch (err) {
      const msg = isApiError(err) ? err.message : "取消失败";
      const is409 = isApiError(err) && err.status === 409;
      setActionError(is409 ? `${msg}（仅排队中的任务可取消）` : msg);
    }
  };

  if (teamQuery.isPending) return <div data-testid="team-detail-loading" style={{ padding: space.xl, color: neutral[400], ...baseFont }}>加载中…</div>;
  if (teamQuery.isError) return (
    <div data-testid="team-detail-error" role="alert" style={{ padding: space.xl, ...baseFont, display: "flex", flexDirection: "column", gap: space.md }}>
      <span style={{ color: "#DC2626" }}>{isApiError(teamQuery.error) ? teamQuery.error.message : "加载失败"}</span>
      <button type="button" onClick={() => teamQuery.refetch()} style={{ alignSelf: "flex-start", padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", cursor: "pointer", fontFamily: fontFamily.body }}>重试</button>
    </div>
  );
  if (!team) return null;

  return (
    <div data-testid="team-detail-root" style={{ flex: 1, display: "flex", flexDirection: "column", padding: `${space.xl}px ${space.xl}px ${space.xl}px 0`, gap: space.xl, ...baseFont, overflow: "auto" }}>
      {/* 顶部：标题 + 操作 */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.lg }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <button type="button" data-testid="back-to-teams" onClick={() => router.push("/teams")} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, border: "none", background: "none", color: neutral[500], fontSize: fontSize.sm, cursor: "pointer", padding: 0, marginBottom: space.sm, fontFamily: fontFamily.body }}>← 返回团队列表</button>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <input data-testid="team-name-edit" value={editName} onChange={(e) => setEditName(e.target.value)} style={{ fontSize: fontSize.xxl, fontWeight: 600, color: neutral[900], border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: `${space.xs}px ${space.sm}px`, backgroundColor: "var(--color-surface)", fontFamily: fontFamily.body, flex: 1, minWidth: 0 }} />
            <button type="button" data-testid="team-save-name" onClick={handleSaveName} disabled={patchMutation.isPending} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer", opacity: patchMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body }}>保存</button>
          </div>
          <textarea data-testid="team-desc-edit" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={2} placeholder="团队描述" style={{ marginTop: space.sm, width: "100%", boxSizing: "border-box", padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[600], outline: "none", resize: "none", lineHeight: 1.6, fontFamily: fontFamily.body }} />
          <div style={{ marginTop: space.sm, fontSize: fontSize.xs, color: neutral[400], display: "flex", gap: space.md }}>
            <span>ID: {team.id}</span>
            <span>v{team.version}</span>
            <span>{new Date(team.updatedAt).toLocaleString()}</span>
          </div>
        </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.sm, flexShrink: 0, alignItems: "flex-end" }}>
          <button
            type="button"
            data-testid="enter-team-session"
            data-team-id={team.id}
            onClick={() => router.push(`/teams/${team.id}/session`)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.sm + 2}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: "#2563EB",
              color: "#FFF",
              fontSize: fontSize.md,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 6px 16px rgba(37,99,235,.3)",
              fontFamily: fontFamily.body,
              width: "100%",
              justifyContent: "center",
            }}
          >
            进入会话 →
          </button>
          <div data-testid="reuse-section" style={{ display: "flex", flexDirection: "column", gap: space.sm, padding: space.md, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, minWidth: 260 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>记忆开关 · 复用会话</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{team.reuseSession ? "默认保留 · 跨任务复用" : "每任务新会话 · 历史清空"}</span>
              </div>
              <span role="switch" aria-checked={team.reuseSession} data-testid="reuse-toggle" onClick={handleToggleReuse} style={{ width: 40, height: 22, borderRadius: 11, backgroundColor: team.reuseSession ? "#2563EB" : neutral[300], position: "relative", cursor: "pointer", flexShrink: 0 }}>
                <span style={{ position: "absolute", top: 2, left: team.reuseSession ? 20 : 2, width: 18, height: 18, borderRadius: "50%", backgroundColor: "#FFF", transition: "left .2s" }} />
              </span>
            </div>
            <div data-testid="reuse-desc" style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6, backgroundColor: team.reuseSession ? "rgba(37,99,235,0.06)" : "rgba(245,158,11,0.08)", border: `1px solid ${team.reuseSession ? "rgba(37,99,235,0.12)" : "rgba(245,158,11,0.14)"}`, borderRadius: radius.md, padding: `${space.sm}px ${space.md}px` }}>
              {team.reuseSession ? (
                <span><span style={{ fontWeight: 600, color: "#2563EB" }}>默认保留</span>：同一团队的会话跨任务延续，群聊/私聊历史与上下文保留，适合连续迭代。</span>
              ) : (
                <span><span style={{ fontWeight: 600, color: "#D97706" }}>每任务新会话</span>：每个任务为独立会话，历史与上下文隔离，适合强隔离场景。</span>
              )}
              <span style={{ display: "block", marginTop: space.xs, color: neutral[400] }}>任务级可勾选「完成后为下一任务开新会话」覆盖此团队默认。</span>
            </div>
          </div>
          <button
            type="button"
            data-testid="delete-team-button"
            disabled={!isIdle || deleteMutation.isPending}
            onClick={() => setDeleteConfirm(true)}
            title={!isIdle ? "仅空闲且队列为空时可删除" : undefined}
            style={{
              padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${!isIdle ? neutral[200] : "rgba(239,68,68,0.22)"}`,
              backgroundColor: !isIdle ? neutral[100] : "rgba(239,68,68,0.08)", color: !isIdle ? neutral[400] : "#DC2626",
              fontSize: fontSize.sm, fontWeight: 500, cursor: !isIdle ? "not-allowed" : "pointer", opacity: !isIdle ? 0.7 : 1, fontFamily: fontFamily.body,
            }}
          >
            删除团队
          </button>
          {!isIdle && <span data-testid="delete-disabled-hint" style={{ fontSize: fontSize.xs, color: neutral[400] }}>团队忙碌或队列非空，无法删除</span>}
        </div>
      </div>

      {actionError && <div data-testid="team-action-error" role="alert" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", color: "#B91C1C", fontSize: fontSize.sm }}>{actionError}</div>}

      {/* 两栏：当前任务 + 队列 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.lg }}>
        {/* 当前任务卡片 — 顶部当前任务卡明确显示“当前执行”+ 状态徽章，queued 脏数据兼容橙徽 */}
        {(() => {
          const rawStatus: string | null = (team as unknown as { currentTaskStatus?: string | null }).currentTaskStatus ?? null;
          const queueMatch = team.currentTaskId ? team.queue.find((q) => q.taskId === team.currentTaskId) : undefined;
          const effectiveStatus = rawStatus ?? queueMatch?.taskStatus ?? null;
          const isQueued = effectiveStatus === "queued";
          let badgeLabel = "执行中";
          let badgeStyle: CSSProperties = { color: "#2563EB", backgroundColor: "rgba(37,99,235,0.10)", border: "1px solid rgba(37,99,235,0.22)" };
          if (isQueued) {
            badgeLabel = "当前排队中";
            badgeStyle = { color: "#D97706", backgroundColor: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.28)" };
          } else if (effectiveStatus === "pending") {
            badgeLabel = "待开始";
            badgeStyle = { color: "#2563EB", backgroundColor: "rgba(37,99,235,0.10)", border: "1px solid rgba(37,99,235,0.22)" };
          } else if (effectiveStatus === "in_progress") {
            badgeLabel = "进行中";
            badgeStyle = { color: "#2563EB", backgroundColor: "rgba(37,99,235,0.10)", border: "1px solid rgba(37,99,235,0.22)" };
          } else if (effectiveStatus === "pending_review") {
            badgeLabel = "待验收";
            badgeStyle = { color: "#D97706", backgroundColor: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.22)" };
          } else if (team.currentTaskId) {
            badgeLabel = "执行中";
            badgeStyle = { color: "#2563EB", backgroundColor: "rgba(37,99,235,0.10)", border: "1px solid rgba(37,99,235,0.22)" };
          }
          return (
            <section data-testid="current-task-card" style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                  <span style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[800] }}>当前执行</span>
                  {team.currentTaskId && (
                    <span
                      data-testid="current-task-status-badge"
                      data-status={effectiveStatus ?? "executing"}
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: radius.pill,
                        lineHeight: 1.4,
                        ...badgeStyle,
                      } as CSSProperties}
                    >
                      {badgeLabel}
                    </span>
                  )}
                  {!team.currentTaskId && (
                    <span
                      data-testid="current-task-status-badge"
                      data-status="idle"
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: radius.pill,
                        color: neutral[500],
                        backgroundColor: neutral[100],
                        border: `1px solid ${neutral[200]}`,
                      }}
                    >
                      空闲
                    </span>
                  )}
                </div>
                {team.currentTaskId && (
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>队首任务</span>
                )}
              </div>
              {team.currentTaskId ? (
                <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
                  <span style={{ fontFamily: fontFamily.mono, fontSize: fontSize.sm, color: "#2563EB", backgroundColor: "rgba(37,99,235,0.08)", border: `1px solid rgba(37,99,235,0.14)`, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.md, wordBreak: "break-all" }}>
                    {(team as unknown as { currentTaskTitle?: string | null }).currentTaskTitle ? `${(team as unknown as { currentTaskTitle?: string | null }).currentTaskTitle} · ${team.currentTaskId}` : team.currentTaskId}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                    <button type="button" data-testid="goto-current-task" onClick={() => router.push(`/tasks/${team.currentTaskId}`)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: isQueued ? "rgba(245,158,11,0.08)" : "var(--color-surface)", color: isQueued ? "#D97706" : neutral[600], fontSize: fontSize.sm, cursor: "pointer", fontFamily: fontFamily.body, fontWeight: 500 }}>
                      查看任务 →
                    </button>
                    {isQueued && (
                      <span style={{ fontSize: fontSize.xs, color: "#D97706" }}>⚠ 该任务当前为排队中（脏数据兼容）</span>
                    )}
                  </div>
                </div>
              ) : (
                <div data-testid="no-current-task" style={{ fontSize: fontSize.sm, color: neutral[400], padding: `${space.md}px 0` }}>暂无进行中任务（空闲）</div>
              )}
            </section>
          );
        })()}

        {/* 队列预览 — FIFO 展示 + 取消排队（仅 queued 可取消） */}
        {(() => {
          const waitingQueue = team.queue.filter((q: TeamQueueDto) => {
            const s = q.taskStatus;
            return !s || s === "queued";
          });
          const waitingCount = waitingQueue.length;
          return (
            <section data-testid="queue-preview" style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                  <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[800] }}>等待队列（{waitingCount}）</div>
                  <span style={{ fontSize: 10, color: "#D97706", backgroundColor: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.22)", padding: "1px 6px", borderRadius: radius.pill, fontWeight: 600 }}>FIFO</span>
                </div>
                {waitingCount === 0 ? (
                  <span data-testid="queue-count-empty" style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无等待</span>
                ) : (
                  <span data-testid="queue-count" style={{ fontSize: fontSize.xs, color: neutral[500] }}>等待中 {waitingCount} 个 · 队首优先</span>
                )}
              </div>
              <div style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.5, backgroundColor: neutral[50], border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, padding: `${space.xs}px ${space.sm}px` }}>
                按入队时间 FIFO 排队，仅 <span style={{ color: "#D97706", fontWeight: 600 }}>排队中</span> 可取消；不支持拖拽重排。
              </div>
              {waitingCount === 0 ? (
                <div data-testid="queue-empty" style={{ fontSize: fontSize.sm, color: neutral[400], padding: `${space.md}px ${space.md}px`, textAlign: "center", border: `1px dashed ${neutral[200]}`, borderRadius: radius.md, backgroundColor: neutral[50], lineHeight: 1.6 }}>
                  暂无等待，当前任务可直接执行
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                  {waitingQueue.map((q: TeamQueueDto) => {
                const isQueued = q.taskStatus ? q.taskStatus === "queued" : true;
                return (
                  <div key={q.id} data-testid="queue-item" data-task-id={q.taskId} data-position={q.position} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: isQueued ? "rgba(245,158,11,0.06)" : neutral[50], border: `1px solid ${isQueued ? "rgba(245,158,11,0.18)" : neutral[200]}` }}>
                    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: "50%", backgroundColor: "#F59E0B", color: "#FFF", fontSize: fontSize.xs, fontWeight: 700, flexShrink: 0 }}>{q.position}</span>
                    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                      <span data-testid="queue-task-title" style={{ fontSize: fontSize.sm, color: neutral[800], fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.taskTitle ?? q.taskId}</span>
                      <span style={{ display: "flex", alignItems: "center", gap: space.xs, marginTop: 1 }}>
                        <span data-testid="queue-task-status" style={{ fontSize: 10, color: isQueued ? "#D97706" : neutral[500], backgroundColor: isQueued ? "rgba(245,158,11,0.12)" : neutral[100], border: `1px solid ${isQueued ? "rgba(245,158,11,0.22)" : neutral[200]}`, padding: "0 5px", borderRadius: radius.pill, fontWeight: 600 }}>{q.taskStatus === "queued" ? "排队中" : q.taskStatus ?? "排队中"}</span>
                        <span style={{ fontFamily: fontFamily.mono, fontSize: 10, color: neutral[400], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.taskId.slice(0, 10)}…</span>
                      </span>
                    </div>
                    <span style={{ fontSize: 10, color: neutral[400], flexShrink: 0, textAlign: "right", lineHeight: 1.3 }}>{new Date(q.enqueuedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                    <button
                      type="button"
                      data-testid="queue-cancel"
                      data-task-id={q.taskId}
                      disabled={!isQueued || cancelQueueMutation.isPending}
                      onClick={() => handleCancelQueue(q.taskId)}
                      title={!isQueued ? "仅排队中的任务可取消" : "取消排队"}
                      style={{
                        padding: `${space.xs}px ${space.sm}px`,
                        borderRadius: radius.pill,
                        border: `1px solid ${!isQueued ? neutral[200] : "rgba(239,68,68,0.22)"}`,
                        backgroundColor: !isQueued ? neutral[100] : "rgba(239,68,68,0.06)",
                        color: !isQueued ? neutral[400] : "#DC2626",
                        fontSize: fontSize.xs,
                        fontWeight: 500,
                        cursor: !isQueued || cancelQueueMutation.isPending ? "not-allowed" : "pointer",
                        opacity: !isQueued ? 0.6 : 1,
                        fontFamily: fontFamily.body,
                        flexShrink: 0,
                      }}
                    >
                      取消
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
          );
        })()}
      </div>

      {/* 成员管理 */}
      <section style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[800] }}>成员 <span style={{ fontSize: fontSize.sm, fontWeight: 400, color: neutral[400] }}>{team.members.length} 个实例</span>{team.mainAgentMemberId && <span data-testid="main-agent-indicator" style={{ marginLeft: space.sm, fontSize: fontSize.xs, color: "#D97706", backgroundColor: "#FFF7ED", border: "1px solid #F59E0B", padding: "1px 6px", borderRadius: radius.pill, fontWeight: 600 }}>★ {team.members.find((m) => m.id === team.mainAgentMemberId)?.alias ?? team.mainAgentMemberId}</span>}</div>
          <button type="button" data-testid="add-member-toggle" onClick={() => setShowAddMember(!showAddMember)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[700], fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer", fontFamily: fontFamily.body }}>{showAddMember ? "收起" : "＋ 添加成员"}</button>
        </div>

        {showAddMember && (
          <div data-testid="add-member-panel" style={{ display: "flex", flexDirection: "column", gap: space.md, padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm }}>
            <div style={{ display: "flex", gap: space.md, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: space.xs }}>
                <label style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>选择 Agent</label>
                <select data-testid="add-member-agent-select" value={selectedAgentId} onChange={(e) => setSelectedAgentId(e.target.value)} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[800], fontFamily: fontFamily.body }}>
                  <option value="">请选择</option>
                  {(agentsQuery.data?.items ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.role ?? a.type})</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: space.xs }}>
                <label style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>别名（可选）</label>
                <input data-testid="add-member-alias" value={addAlias} onChange={(e) => setAddAlias(e.target.value)} placeholder="默认 <角色名>-seq" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.md, color: neutral[800], outline: "none", fontFamily: fontFamily.body }} />
              </div>
              <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: space.xs }}>
                <label style={{ fontSize: fontSize.sm, fontWeight: 500, color: neutral[600] }}>工作目录（可选）</label>
                <input data-testid="add-member-workdir" value={addWorkDir} onChange={(e) => setAddWorkDir(e.target.value)} placeholder="/data/vteam-worker/…" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], fontSize: fontSize.xs, color: neutral[600], outline: "none", fontFamily: fontFamily.mono }} />
              </div>
              <button type="button" data-testid="add-member-confirm" disabled={addMutation.isPending} onClick={handleAddMember} style={{ padding: `${space.sm + 2}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", fontSize: fontSize.md, fontWeight: 500, cursor: addMutation.isPending ? "default" : "pointer", opacity: addMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body, alignSelf: "flex-end" }}>{addMutation.isPending ? "添加中…" : "确认添加"}</button>
            </div>
          </div>
        )}

        {team.members.length === 0 ? (
          <div data-testid="members-empty" style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px dashed ${neutral[300]}`, textAlign: "center", fontSize: fontSize.sm, color: neutral[400] }}>暂无成员，请添加</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
            {team.members.map((m) => (
              <MemberRow key={m.id} member={m} isMain={team.mainAgentMemberId === m.id} onSave={(payload) => {
                setActionError(null);
                updateMemberMutation.mutate({ memberId: m.id, payload }, {
                  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["team", id] }),
                  onError: (err) => setActionError(isApiError(err) ? err.message : "更新失败"),
                });
              }} onRemove={() => {
                setActionError(null);
                removeMemberMutation.mutate(m.id, {
                  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["team", id] }),
                  onError: (err) => setActionError(isApiError(err) ? err.message : "移除失败"),
                });
              }} onSetMain={() => handleSetMainAgent(m.id)} />
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={deleteConfirm}
        title="删除团队"
        description={`确认删除团队「${team.name}」？仅空闲且队列为空时可删除，此操作不可恢复。`}
        submitting={deleteMutation.isPending}
        onConfirm={async () => {
          try { await deleteMutation.mutateAsync(); router.push("/teams"); } catch (err) { setActionError(isApiError(err) ? err.message : "删除失败"); setDeleteConfirm(false); }
        }}
        onClose={() => setDeleteConfirm(false)}
      />
    </div>
  );
}
