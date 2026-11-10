"use client";

/**
 * 团队详情页（Task 11）
 * =============================================
 * - 团队信息（name/description/reuseSession 开关 version 乐观锁）
 * - 当前任务卡片（currentTaskId）
 * - 当前任务卡（currentTaskId 聚焦指针 + 状态徽章；并行化后无队列预览）
 * - 成员列表（alias/workDir 行内编辑，增删改；多实例支持）
 * - 删除团队（执行中任务时禁用；其余关联任务随团队级联删除，确认框列出任务）
 * - 添加成员：ROLE-first 岗位选择（来源 GET /agent-roles；role-only 提交，
 *   外部绑定岗位由服务端落到平台占位系统 Agent，前端不再索要执行 Agent）
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { useAuthStore } from "@/lib/stores/authStore";
import { isApiError } from "@/lib/errors";
import { api } from "@/lib/api";
import { teamsApi, type TeamDto, type TeamMemberDto } from "@/src/api/teams";
import { agentRolesApi, type AgentRoleDto } from "@/src/api/agent-roles";
import { membersApi, type MemberDto } from "@/src/api/members";
import { UserMembersSection } from "./user-members";
import { AgentAvatar, ConfirmDialog } from "@/src/components/ui";
import {
  type RoleKey,
  ROLE_KEYS,
  neutral,
  roles,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** GET /workers 条目（团队首选 worker 选择 + 在线态）。 */
interface ApiWorkerRow {
  id: string;
  name: string | null;
  status: string;
}

function toAvatarRole(role: string | null): RoleKey {
  return role && (ROLE_KEYS as readonly string[]).includes(role as RoleKey) ? (role as RoleKey) : "developer";
}

function MemberRow({
  member,
  roleKey,
  isMain,
  onSave,
  onRemove,
  onSetMain,
}: {
  member: TeamMemberDto;
  roleKey: RoleKey;
  isMain: boolean;
  onSave: (payload: { alias?: string; workDir?: string }) => void;
  onRemove: () => void;
  onSetMain: () => void;
}) {
  const [alias, setAlias] = useState(member.alias ?? "");
  const [workDir, setWorkDir] = useState(member.workDir ?? "");
  const dirty = alias !== (member.alias ?? "") || workDir !== (member.workDir ?? "");
  useEffect(() => {
    setAlias(member.alias ?? "");
    setWorkDir(member.workDir ?? "");
  }, [member.alias, member.workDir]);
  const theme = roles[roleKey];
  const displayName = member.member?.name ?? member.alias ?? member.agent?.name ?? member.agentId;
  return (
    <div
      data-testid="member-row"
      data-member-id={member.id}
      data-main={isMain ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.lg,
        backgroundColor: isMain ? "rgba(245,158,11,0.06)" : "var(--color-surface)",
        border: `1px solid ${isMain ? "rgba(245,158,11,0.40)" : neutral[200]}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <AgentAvatar role={roleKey} size="md" />
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 700, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{displayName}</span>
            <span style={{ fontSize: 10, color: theme.color, backgroundColor: theme.bg, border: `1px solid ${theme.border}`, padding: "0 6px", borderRadius: radius.pill }}>{theme.label}</span>
            <span style={{ fontSize: 10, color: neutral[400] }}>#{member.seq}</span>
            {member.member ? (
              <span style={{ fontSize: 10, color: neutral[500], backgroundColor: neutral[100], border: `1px solid ${neutral[200]}`, padding: "0 6px", borderRadius: radius.pill }}>平台成员</span>
            ) : (
              <span style={{ fontSize: 10, color: "#B45309", backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", padding: "0 6px", borderRadius: radius.pill }}>旧席位</span>
            )}
            {isMain ? (
              <span data-testid="main-badge" style={{ fontSize: 10, color: "#FFF", backgroundColor: "#F59E0B", padding: "0 6px", borderRadius: radius.pill, fontWeight: 700 }}>★ 主 Agent</span>
            ) : (
              <button type="button" data-testid="set-main-agent" onClick={onSetMain} style={{ border: "none", background: "none", color: neutral[400], cursor: "pointer", padding: 0, fontSize: 10, fontWeight: 600, fontFamily: fontFamily.body }}>设为主</button>
            )}
          </div>
          <span style={{ fontSize: 10, color: neutral[400], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 340 }}>
            {member.agent?.name ?? member.agentId} · {member.id}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="member-save"
          disabled={!dirty}
          onClick={() => onSave({ alias: alias.trim() || undefined, workDir: workDir.trim() || undefined })}
          style={{ padding: `5px 12px`, borderRadius: radius.md, border: "none", backgroundColor: dirty ? "#0D9488" : neutral[100], color: dirty ? "#FFF" : neutral[400], fontSize: fontSize.xs, fontWeight: 600, cursor: dirty ? "pointer" : "default", fontFamily: fontFamily.body }}
        >
          {dirty ? "保存修改" : "已保存"}
        </button>
        <button type="button" data-testid="member-remove" onClick={onRemove} title="移除成员" style={{ border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: neutral[400], cursor: "pointer", padding: "5px 10px", fontSize: fontSize.xs, borderRadius: radius.md, fontFamily: fontFamily.body }}>移除</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)", gap: space.sm, paddingLeft: 44 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>群内别名</span>
          <input data-testid="member-alias-input" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="例如：架构-老周" aria-label="成员别名" style={{ padding: `6px 10px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>团队工作目录</span>
          <input data-testid="member-workdir-input" value={workDir} onChange={(e) => setWorkDir(e.target.value)} placeholder="/data/vteam-worker/…" aria-label="工作目录" style={{ padding: `6px 10px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], fontSize: fontSize.xs, color: neutral[600], fontFamily: fontFamily.mono }} />
        </label>
      </div>
    </div>
  );
}

export default function TeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.user?.id);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [showAddMember, setShowAddMember] = useState(false);
  /** D17 双入口：默认从成员库选，保留按岗位新建兼容旧形状 */
  const [addMode, setAddMode] = useState<"members" | "roles">("members");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [addAlias, setAddAlias] = useState("");
  const [addWorkDir, setAddWorkDir] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  /** 有执行中任务 → 二次确认强制删除（服务端 409 TEAM_TASK_RUNNING 后弹出）。 */
  const [forceDeleteConfirm, setForceDeleteConfirm] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState<TeamMemberDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const teamQuery = useQuery({
    queryKey: ["team", id],
    queryFn: () => teamsApi.get(id),
    enabled: !!id,
  });

  // ROLE-first：岗位为添加成员的主选择器（唯一来源 GET /agent-roles，与面板同口径）。
  const rolesQuery = useQuery({
    queryKey: ["agent-roles"],
    queryFn: () => agentRolesApi.list({ page: 1, pageSize: 100 }),
    enabled: showAddMember,
    retry: false,
  });
  const roleItems: AgentRoleDto[] = rolesQuery.data?.items ?? [];

  const addMembersQuery = useQuery({
    queryKey: ["members", "team-add"],
    queryFn: () => membersApi.list({ page: 1, pageSize: 100, status: "active" }),
    enabled: showAddMember && addMode === "members",
  });
  const addMemberOptions = addMembersQuery.data?.items ?? [];
  const roleLabelOf = (r: AgentRoleDto): string =>
    r.defaultAgentId ? `${r.name}` : r.defaultOpencodeAgentName ? `${r.name}（外部）` : r.name;

  // worker 列表：GET /workers（团队首选 worker 选择数据源，复用 ["workers"] 缓存，不新造请求）
  const workersQuery = useQuery({
    queryKey: ["workers"],
    queryFn: () => api.get<ApiWorkerRow[]>("/workers"),
    enabled: !!id,
  });
  const workers = workersQuery.data ?? [];
  // 在线优先 + 展示名排序（与 agents 页/模型页同一惯例）
  const sortedWorkers = [...workers].sort((a, b) => {
    if (a.status !== "offline" && b.status === "offline") return -1;
    if (a.status === "offline" && b.status !== "offline") return 1;
    return (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });

  const team: TeamDto | undefined = teamQuery.data;
  /** 已在群内的成员不再出现在添加下拉里（避免重复入群 409） */
  const usedMemberIds = new Set(
    (team?.members ?? [])
      .map((m) => m.memberId)
      .filter((id): id is string => !!id),
  );
  /** 席位 roleId → AgentRole.key（头像配色/岗位徽章用；旧席位无匹配时兜底 developer）。 */
  const roleKeyById = new Map(roleItems.map((r) => [r.id, r.key]));
  const currentTaskId = team?.currentTaskId ?? null;
  // 悬空软引用（节点已删除）：当前值不在清单里时仍以原始 id 渲染占位项，不得回退成空选中
  const danglingWorkerId = team?.preferredWorkerId && !workers.some((w) => w.id === team.preferredWorkerId)
    ? team.preferredWorkerId
    : null;

  useRealtimeEvents({
    scope: `team:${id},global`,
    enabled: !!id && !!userId,
    onTeamChanged: (payload) => {
      queryClient.invalidateQueries({ queryKey: ["team", id], exact: true });
      if (currentTaskId && payload.taskId === currentTaskId) {
        queryClient.invalidateQueries({ queryKey: ["task", currentTaskId], exact: true });
      }
    },
    onTaskStatusChanged: (payload) => {
      queryClient.invalidateQueries({ queryKey: ["team", id], exact: true });
      queryClient.invalidateQueries({ queryKey: ["team-tasks", id], exact: true });
      if (currentTaskId && payload.taskId === currentTaskId) {
        queryClient.invalidateQueries({ queryKey: ["task", currentTaskId], exact: true });
        queryClient.invalidateQueries({ queryKey: ["task", currentTaskId, "artifacts"], exact: true });
        queryClient.invalidateQueries({ queryKey: ["task", currentTaskId, "plan-docs"], exact: true });
        queryClient.invalidateQueries({ queryKey: ["task", currentTaskId, "plan-steps"], exact: true });
        queryClient.invalidateQueries({ queryKey: ["task-issues", currentTaskId], exact: true });
        queryClient.invalidateQueries({ queryKey: ["plans", currentTaskId], exact: true });
        queryClient.invalidateQueries({ queryKey: ["questions", currentTaskId, "pending"], exact: true });
      }
    },
  });

  useEffect(() => {
    if (team) { setEditName(team.name); setEditDesc(team.description ?? ""); }
  }, [team]);

  // 只有真正占用执行资源的任务会触发「强制删除」二次确认（pending_review 已执行完，不拦）
  const RUNNING_TASK_STATUS = ["in_progress", "blocked"];
  const hasRunningTask = !!team && RUNNING_TASK_STATUS.includes(team.currentTaskStatus ?? "");
  const hasTasks = !!team && !!team.currentTaskId;
  // 删除恒可用（产品确认 2026-11-10）：有执行中任务时走二次确认强制删除，而不是禁用按钮
  const deletable = !!team;

  const patchMutation = useMutation({
    mutationFn: (payload: { name?: string; description?: string | null; reuseSession?: boolean; mainAgentMemberId?: string | null; preferredWorkerId?: string | null }) =>
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

  // 团队级首选 worker：写既有 PATCH /teams/:id（带 version），成功后按既有键失效回显。
  const handleSetPreferredWorker = async (workerId: string) => {
    if (!team) return;
    setActionError(null);
    try {
      await patchMutation.mutateAsync({ preferredWorkerId: workerId || null });
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
    mutationFn: () =>
      teamsApi.addMember(
        id,
        addMode === "members"
          ? {
              memberId: selectedMemberId,
              alias: addAlias.trim() || undefined,
              workDir: addWorkDir.trim() || undefined,
            }
          : {
              ...(selectedRoleId ? { roleId: selectedRoleId } : {}),
              alias: addAlias.trim() || undefined,
              workDir: addWorkDir.trim() || undefined,
            },
      ),
  });
  const handleAddMember = async () => {
    if (addMode === "members" && !selectedMemberId) {
      setActionError("请选择成员");
      return;
    }
    if (addMode === "roles" && !selectedRoleId) {
      setActionError("请选择岗位");
      return;
    }
    setActionError(null);
    try {
      await addMutation.mutateAsync();
      setShowAddMember(false);
      setSelectedMemberId("");
      setSelectedRoleId("");
      setAddAlias("");
      setAddWorkDir("");
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

  /**
   * 删除团队（两段式）：先不带 force；若服务端回 409 `TEAM_TASK_RUNNING`（有 in_progress/
   * blocked 任务），转成「强制删除」二次确认，用户确认后带 force 重放。
   */
  const deleteMutation = useMutation({
    mutationFn: (force?: boolean) => teamsApi.remove(id, { force }),
    onSuccess: () => router.push("/teams"),
    onError: (err) => {
      if (isApiError(err) && err.code === "TEAM_TASK_RUNNING") {
        setForceDeleteConfirm(true);
        setDeleteConfirm(false);
        return;
      }
      setActionError(isApiError(err) ? err.message : "删除失败");
      setDeleteConfirm(false);
      setForceDeleteConfirm(false);
    },
  });

  if (teamQuery.isPending) return <div data-testid="team-detail-loading" style={{ padding: space.xl, color: neutral[400], ...baseFont }}>加载中…</div>;
  if (teamQuery.isError) return (
    <div data-testid="team-detail-error" role="alert" style={{ padding: space.xl, ...baseFont, display: "flex", flexDirection: "column", gap: space.md }}>
      <span style={{ color: "#DC2626" }}>{isApiError(teamQuery.error) ? teamQuery.error.message : "加载失败"}</span>
      <button type="button" onClick={() => teamQuery.refetch()} style={{ alignSelf: "flex-start", padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", cursor: "pointer", fontFamily: fontFamily.body }}>重试</button>
    </div>
  );
  if (!team) return null;

  return (
    <div data-testid="team-detail-root" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: `${space.xl}px`, overflow: "auto" }}>
    <div style={{ width: "100%", maxWidth: 1120, display: "flex", flexDirection: "column", gap: space.lg, ...baseFont }}>
      <button type="button" data-testid="back-to-teams" onClick={() => router.push("/teams")} style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: space.xs, border: "none", background: "none", color: neutral[500], fontSize: fontSize.sm, cursor: "pointer", padding: 0, fontFamily: fontFamily.body }}>← 返回团队列表</button>
      <div data-testid="team-task-entrypoints" style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <button type="button" data-testid="team-task-board-link" onClick={() => router.push(`/board?teamId=${encodeURIComponent(team.id)}`)} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.pill, border: "1px solid #0D9488", backgroundColor: "var(--color-surface)", color: "#0D9488", fontSize: fontSize.sm, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}>任务看板 →</button>
        <button type="button" data-testid="team-task-history-link" onClick={() => router.push(`/teams/${encodeURIComponent(team.id)}/tasks`)} style={{ display: "inline-flex", alignItems: "center", gap: space.xs, padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[700], fontSize: fontSize.sm, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}>历史任务 →</button>
      </div>
      {/* 头卡：名称 + 描述 + 操作同一行组 */}
      <section style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <input data-testid="team-name-edit" value={editName} onChange={(e) => setEditName(e.target.value)} aria-label="团队名称" style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900], border: `1px solid transparent`, borderRadius: radius.md, padding: `${space.xs}px ${space.sm}px`, backgroundColor: "transparent", fontFamily: fontFamily.body, flex: 1, minWidth: 0, }} onFocus={(e) => { e.currentTarget.style.borderColor = neutral[200]; e.currentTarget.style.backgroundColor = "var(--color-surface)"; }} onBlur={(e) => { e.currentTarget.style.borderColor = "transparent"; }} />
          <button type="button" data-testid="team-save-name" onClick={handleSaveName} disabled={patchMutation.isPending} style={{ padding: `6px ${space.md}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer", opacity: patchMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body, flexShrink: 0 }}>保存</button>
          <button
            type="button"
            data-testid="enter-team-session"
            data-team-id={team.id}
            onClick={() => router.push(`/teams/${team.id}/session`)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `6px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: "#0D9488",
              color: "#FFF",
              fontSize: fontSize.sm,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 4px 12px rgba(13,148,136,.3)",
              fontFamily: fontFamily.body,
              flexShrink: 0,
            }}
          >
            进入会话 →
          </button>
          <button
            type="button"
            data-testid="delete-team-button"
            disabled={!deletable || deleteMutation.isPending}
            onClick={() => setDeleteConfirm(true)}
            title={hasRunningTask ? "删除团队（有执行中任务，将二次确认强制删除）" : "删除团队（含关联任务）"}
            style={{
              padding: `6px ${space.md}px`, borderRadius: radius.sm, border: "none",
              backgroundColor: "transparent", color: !deletable ? neutral[300] : "#DC2626",
              fontSize: fontSize.sm, cursor: !deletable ? "not-allowed" : "pointer", fontFamily: fontFamily.body, flexShrink: 0,
            }}
          >
            删除
          </button>
        </div>
        <textarea data-testid="team-desc-edit" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={1} placeholder="添加团队描述…" aria-label="团队描述" style={{ width: "100%", boxSizing: "border-box", padding: `6px ${space.sm}px`, borderRadius: radius.sm, border: "1px solid transparent", backgroundColor: "transparent", fontSize: fontSize.sm, color: neutral[500],resize: "none", lineHeight: 1.6, fontFamily: fontFamily.body }} onFocus={(e) => { e.currentTarget.style.borderColor = neutral[200]; }} onBlur={(e) => { e.currentTarget.style.borderColor = "transparent"; }} />
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap", fontSize: 11, color: neutral[400] }}>
          <span style={{ fontFamily: fontFamily.mono, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, borderRadius: radius.sm, padding: "1px 6px" }}>{team.id}</span>
          <span>v{team.version}</span>
          <span>{new Date(team.updatedAt).toLocaleString()}</span>
          <span style={{ color: "#0D9488", fontWeight: 600 }}>{team.members.length} 成员</span>
          <span style={{ color: (team.activeTaskCount ?? 0) > 0 ? "#D97706" : neutral[400], fontWeight: 600 }}>{team.activeTaskCount ?? 0} 进行中</span>
          {hasRunningTask && (
            <span data-testid="delete-force-hint" style={{ color: "#D97706" }}>
              · 有执行中的任务，删除需二次确认强制删除
            </span>
          )}
          {!hasRunningTask && hasTasks && <span data-testid="delete-cascade-hint" style={{ color: "#D97706" }}>· 删除将一并删除关联任务</span>}
        </div>
        <div data-testid="reuse-section" style={{ display: "flex", alignItems: "center", gap: space.md, paddingTop: space.md, borderTop: `1px dashed ${neutral[200]}` }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], whiteSpace: "nowrap" }}>记忆开关</span>
          <span data-testid="reuse-desc" style={{ fontSize: fontSize.xs, color: neutral[500], flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {team.reuseSession ? "默认保留：会话跨任务延续，适合连续迭代" : "每任务新会话：历史隔离，适合强隔离场景"}
          </span>
          <span role="switch" aria-checked={team.reuseSession} data-testid="reuse-toggle" onClick={handleToggleReuse} style={{ width: 36, height: 20, borderRadius: 10, backgroundColor: team.reuseSession ? "#0D9488" : neutral[300], position: "relative", cursor: "pointer", flexShrink: 0 }}>
            <span style={{ position: "absolute", top: 2, left: team.reuseSession ? 18 : 2, width: 16, height: 16, borderRadius: "50%", backgroundColor: "#FFF", transition: "left .2s" }} />
          </span>
        </div>
        <div data-testid="team-worker-section" style={{ display: "flex", alignItems: "center", gap: space.md, paddingTop: space.md, borderTop: `1px dashed ${neutral[200]}` }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], whiteSpace: "nowrap" }}>首选 Worker 节点</span>
          <select
            data-testid="team-worker-select"
            value={team.preferredWorkerId ?? ""}
            disabled={patchMutation.isPending}
            onChange={(e) => handleSetPreferredWorker(e.target.value)}
            aria-label="团队首选 Worker（未选则自动调度）"
            style={{
              fontFamily: fontFamily.body,
              fontSize: fontSize.sm,
              color: neutral[800],
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[300]}`,
              borderRadius: radius.md,
              padding: `${space.xs}px ${space.sm}px`,
              cursor: "pointer",
              minWidth: 220,
            }}
          >
            <option value="">自动调度（默认）</option>
            {danglingWorkerId && <option value={danglingWorkerId}>{danglingWorkerId}</option>}
            {sortedWorkers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name ?? w.id} · {w.status !== "offline" ? "在线" : "离线"}
              </option>
            ))}
          </select>
          <span style={{ fontSize: fontSize.xs, color: neutral[500], flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            未选则自动调度到任意可用节点；成员可在会话页覆盖
          </span>
        </div>
      </section>

      {actionError && <div data-testid="team-action-error" role="alert" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", color: "#B91C1C", fontSize: fontSize.sm }}>{actionError}</div>}

      {/* 当前任务卡（并行化后无队列预览，聚焦指针 + 状态徽章） */}
      <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
        {/* 当前任务卡片 — 顶部当前任务卡明确显示“当前执行”+ 状态徽章 */}
        {(() => {
          const effectiveStatus: string | null = (team as unknown as { currentTaskStatus?: string | null }).currentTaskStatus ?? null;
          let badgeLabel = "执行中";
          let badgeStyle: CSSProperties = { color: "#0D9488", backgroundColor: "rgba(13,148,136,0.10)", border: "1px solid rgba(13,148,136,0.22)" };
          if (effectiveStatus === "pending") {
            badgeLabel = "待开始";
            badgeStyle = { color: "#0D9488", backgroundColor: "rgba(13,148,136,0.10)", border: "1px solid rgba(13,148,136,0.22)" };
          } else if (effectiveStatus === "in_progress") {
            badgeLabel = "待开始";
            badgeStyle = { color: "#0D9488", backgroundColor: "rgba(13,148,136,0.10)", border: "1px solid rgba(13,148,136,0.22)" };
          } else if (effectiveStatus === "in_progress") {
            badgeLabel = "进行中";
            badgeStyle = { color: "#0D9488", backgroundColor: "rgba(13,148,136,0.10)", border: "1px solid rgba(13,148,136,0.22)" };
          } else if (effectiveStatus === "blocked") {
            badgeLabel = "阻塞中";
            badgeStyle = { color: "#B91C1C", backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)" };
          } else if (effectiveStatus === "pending_review") {
            badgeLabel = "待验收";
            badgeStyle = { color: "#D97706", backgroundColor: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.22)" };
          } else if (team.currentTaskId) {
            badgeLabel = "执行中";
            badgeStyle = { color: "#0D9488", backgroundColor: "rgba(13,148,136,0.10)", border: "1px solid rgba(13,148,136,0.22)" };
          }
          return (
            <section data-testid="current-task-card" style={{ padding: space.lg, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.sm }}>
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 700, color: neutral[800] }}>当前执行</span>
                {team.currentTaskId && (
                  <span
                    data-testid="current-task-status-badge"
                    data-status={effectiveStatus ?? "executing"}
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "1px 8px",
                      borderRadius: radius.pill,
                      lineHeight: 1.5,
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
                      padding: "1px 8px",
                      borderRadius: radius.pill,
                      color: neutral[500],
                      backgroundColor: neutral[100],
                      border: `1px solid ${neutral[200]}`,
                    }}
                  >
                    空闲
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {team.currentTaskId && (
                  <button type="button" data-testid="goto-current-task" onClick={() => router.push(`/teams/${id}/session`)} style={{ padding: `2px ${space.md}px`, borderRadius: radius.pill, border: "none", background: "none", color: "#0D9488", fontSize: fontSize.xs, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}>
                    进入团队会话 →
                  </button>
                )}
              </div>
              {team.currentTaskId ? (
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {(team as unknown as { currentTaskTitle?: string | null }).currentTaskTitle ?? "任务"}
                  </div>
                  <div style={{ fontFamily: fontFamily.mono, fontSize: 11, color: neutral[400], marginTop: 2 }}>{team.currentTaskId}</div>
                </div>
              ) : (
                <div data-testid="no-current-task" style={{ fontSize: fontSize.sm, color: neutral[400] }}>暂无进行中任务（空闲）</div>
              )}
            </section>
          );
        })()}
      </div>

      {/* 成员管理 */}
      <section style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900] }}>团队成员</div>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{team.members.length} 位</span>
          {team.mainAgentMemberId && (
            <span data-testid="main-agent-indicator" style={{ fontSize: 10, color: "#B45309", backgroundColor: "#FEF3C7", border: "1px solid #FCD34D", padding: "0 8px", borderRadius: radius.pill, fontWeight: 600 }}>
              ★ 主 Agent：{team.members.find((m) => m.id === team.mainAgentMemberId)?.member?.name ?? team.members.find((m) => m.id === team.mainAgentMemberId)?.alias ?? team.mainAgentMemberId}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="add-member-toggle"
            onClick={() => { setShowAddMember((v) => !v); setActionError(null); }}
            style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: showAddMember ? neutral[100] : "#0D9488", color: showAddMember ? neutral[600] : "#FFF", fontSize: fontSize.sm, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}
          >
            {showAddMember ? "取消添加" : "＋ 添加成员"}
          </button>
        </div>

        {showAddMember && (
          <div data-testid="add-member-panel" style={{ padding: space.lg, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, display: "flex", flexDirection: "column", gap: space.md }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}>
              <div>
                <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900] }}>添加成员</div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>从成员库选择已有成员，或按岗位新建一个临时成员实例。</div>
              </div>
              <span style={{ flex: 1 }} />
              <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: radius.md, backgroundColor: neutral[100], border: `1px solid ${neutral[200]}` }}>
                {(["members", "roles"] as const).map((m) => (
                  <button key={m} type="button" data-testid={`add-member-mode-${m}`} onClick={() => { setAddMode(m); setActionError(null); }} style={{ padding: `${space.xs + 1}px ${space.md}px`, border: "none", borderRadius: radius.sm, cursor: "pointer", fontFamily: fontFamily.body, fontSize: fontSize.xs, fontWeight: 600, backgroundColor: addMode === m ? "var(--color-surface)" : "transparent", color: addMode === m ? "#0F766E" : neutral[500], boxShadow: addMode === m ? shadow.sm : undefined }}>
                    {m === "members" ? "从成员库选择" : "按岗位新建"}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: space.md }}>
              {addMode === "members" ? (
                <label style={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}>选择成员</span>
                  <select data-testid="add-member-select" value={selectedMemberId} onChange={(e) => setSelectedMemberId(e.target.value)} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body }}>
                    <option value="">{addMembersQuery.isPending ? "成员加载中…" : "请选择成员"}</option>
                    {addMemberOptions.filter((m: MemberDto) => !usedMemberIds.has(m.id)).map((m: MemberDto) => (
                      <option key={m.id} value={m.id}>{m.name} · {m.role?.name ?? "成员"} · 已在 {m.groupCount} 个群</option>
                    ))}
                  </select>
                  <span style={{ fontSize: 10, color: neutral[400] }}>
                    成员已在群内的会自动过滤；<a href="/members?new=1" target="_blank" rel="noreferrer" style={{ color: "#0F766E", textDecoration: "none" }}>去成员库新建 →</a>
                  </span>
                </label>
              ) : (
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}>选择岗位</span>
                  <select data-testid="add-member-role-select" value={selectedRoleId} onChange={(e) => setSelectedRoleId(e.target.value)} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body }}>
                    <option value="">请选择岗位</option>
                    {roleItems.map((r) => (
                      <option key={r.id} value={r.id}>{roleLabelOf(r)}</option>
                    ))}
                  </select>
                </label>
              )}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}>群内别名（可选）</span>
                <input data-testid="add-member-alias" value={addAlias} onChange={(e) => setAddAlias(e.target.value)} placeholder="默认使用成员名 / 岗位名-seq" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, gridColumn: addMode === "roles" ? "1 / -1" : undefined }}>
                <span style={{ fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}>团队工作目录（可选）</span>
                <input data-testid="add-member-workdir" value={addWorkDir} onChange={(e) => setAddWorkDir(e.target.value)} placeholder="/data/vteam-worker/…" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], fontSize: fontSize.xs, color: neutral[600], fontFamily: fontFamily.mono }} />
              </label>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: space.sm, borderTop: `1px solid ${neutral[100]}`, paddingTop: space.md }}>
              <span style={{ fontSize: 10, color: neutral[400] }}>
                {addMode === "members" ? "从成员库选择：复用平台成员配置；群内别名/工作目录可单独覆盖。" : "按岗位新建：创建新的成员实例（旧兼容形状）。"}
              </span>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => { setShowAddMember(false); setActionError(null); }} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.sm, cursor: "pointer", fontFamily: fontFamily.body }}>取消</button>
              <button type="button" data-testid="add-member-confirm" disabled={addMutation.isPending} onClick={handleAddMember} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", fontSize: fontSize.sm, fontWeight: 600, cursor: addMutation.isPending ? "default" : "pointer", opacity: addMutation.isPending ? 0.6 : 1, fontFamily: fontFamily.body }}>{addMutation.isPending ? "添加中…" : "确认添加"}</button>
            </div>
          </div>
        )}

        {team.members.length === 0 ? (
          <div data-testid="members-empty" style={{ padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px dashed ${neutral[300]}`, textAlign: "center", fontSize: fontSize.sm, color: neutral[400] }}>暂无成员，点击右上角「＋ 添加成员」开始</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
            {team.members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                roleKey={toAvatarRole(roleKeyById.get(m.roleId ?? "") ?? m.agent?.role ?? null)}
                isMain={team.mainAgentMemberId === m.id}
                onSave={(payload) => {
                  setActionError(null);
                  updateMemberMutation.mutate({ memberId: m.id, payload }, {
                    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["team", id] }),
                    onError: (err) => setActionError(isApiError(err) ? err.message : "更新失败"),
                  });
                }}
                onRemove={() => { setActionError(null); setRemoveConfirm(m); }}
                onSetMain={() => handleSetMainAgent(m.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 用户成员（独立于 Agent 成员区） */}
      <UserMembersSection teamId={team.id} members={team.userMembers ?? []} />

      <ConfirmDialog
        open={deleteConfirm}
        testid="team-delete-confirm"
        title="删除团队"
        description={(() => {
          const taskNames: string[] = [];
          if (team.currentTaskId) taskNames.push(team.currentTaskTitle ?? team.currentTaskId);
          const taskPart = taskNames.length > 0
            ? `以下 ${taskNames.length} 个关联任务将一并删除：${taskNames.slice(0, 5).join("、")}${taskNames.length > 5 ? "…" : ""}。`
            : "无关联任务。";
          return `确认删除团队「${team.name}」？${taskPart}此操作不可恢复。`;
        })()}
        confirmLabel="删除"
        submitting={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(false)}
        onClose={() => setDeleteConfirm(false)}
      />

      {/* 强制删除：服务端 409 TEAM_TASK_RUNNING（有 in_progress/blocked 任务）后弹出 */}
      <ConfirmDialog
        open={forceDeleteConfirm}
        testid="team-force-delete-confirm"
        title="团队有执行中的任务"
        description={(() => {
          const taskName = team.currentTaskTitle ?? team.currentTaskId ?? "未知任务";
          return `团队「${team.name}」有正在执行的任务「${taskName}」。强制删除会连同该任务一起删除，正在执行的 Agent 输出将丢失且无法恢复。确认强制删除？`;
        })()}
        confirmLabel="强制删除"
        pendingLabel="删除中…"
        submitting={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(true)}
        onClose={() => setForceDeleteConfirm(false)}
      />

      <ConfirmDialog
        open={!!removeConfirm}
        testid="confirm-remove-member"
        title="移除成员"
        description={`确认将「${removeConfirm?.alias ?? removeConfirm?.agentId ?? ""}」移出团队？该成员的会话/任务历史会保留，但不再归属该成员。`}
        confirmLabel="确认移除"
        submitting={removeMemberMutation.isPending}
        onConfirm={async () => {
          if (!removeConfirm) return;
          try {
            await removeMemberMutation.mutateAsync(removeConfirm.id);
            setRemoveConfirm(null);
            queryClient.invalidateQueries({ queryKey: ["team", id] });
          } catch (err) {
            setActionError(isApiError(err) ? err.message : "移除失败");
            setRemoveConfirm(null);
          }
        }}
        onClose={() => setRemoveConfirm(null)}
      />
    </div>
    </div>
  );
}
