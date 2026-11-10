"use client";

/**
 * 团队与成员 · 团队 Tab（列表 + 右侧详情/编辑抽屉）
 * 与成员库共用同一入口：顶部 Tab 切换「团队 / 成员」，团队用列表展示。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import { isApiError } from "@/lib/errors";
import { AgentAvatar, ConfirmDialog, EmptyState, PageWindow, Pagination } from "@/src/components/ui";
import {
  type RoleKey,
  ROLE_KEYS,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const PAGE_SIZE = 12;
const GRID = "minmax(200px,2fr) 90px 140px 100px 110px 120px 120px";

function toAvatarRole(role: string | null | undefined): RoleKey {
  return role && (ROLE_KEYS as readonly string[]).includes(role) ? (role as RoleKey) : "developer";
}

function statusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    pending: "待开始", in_progress: "进行中", blocked: "阻塞", pending_review: "待验收", completed: "已完成", archived: "已归档",
  };
  return status ? map[status] ?? status : "空闲";
}

export default function TeamsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<TeamDto | null>(null);
  const [form, setForm] = useState({ name: "", description: "", reuseSession: true, mainAgentMemberId: "" });
  const [error, setError] = useState<string | null>(null);
  /** 待确认删除的团队（普通删除确认框）。 */
  const [deleteTarget, setDeleteTarget] = useState<TeamDto | null>(null);
  /** 有执行中任务 → 二次确认强制删除的目标团队。 */
  const [forceTarget, setForceTarget] = useState<TeamDto | null>(null);

  const teamsQuery = useQuery({
    queryKey: ["teams", "list", page, search],
    queryFn: () => teamsApi.list({ page, pageSize: PAGE_SIZE, name: search.trim() || undefined }),
  });
  const items = teamsQuery.data?.items ?? [];
  const total = teamsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const updateMutation = useMutation({
    mutationFn: () =>
      teamsApi.update(selected!.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        reuseSession: form.reuseSession,
        mainAgentMemberId: form.mainAgentMemberId || null,
        version: selected!.version,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      setSelected(null);
    },
    onError: (err) => setError(isApiError(err) ? err.message : "保存失败"),
  });

  /**
   * 删除团队：202 语义两段式。
   * 1) 先不带 force 调用；若团队有执行中任务（in_progress/blocked）服务端回 409
   *    TEAM_TASK_RUNNING + details.requiresForce，此时改为弹「强制删除」二次确认；
   * 2) 用户确认后带 force=true 重放。
   * 无执行中任务时一次删掉，直接关抽屉。
   */
  const deleteMutation = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      teamsApi.remove(id, { force }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      setDeleteTarget(null);
      setForceTarget(null);
      setSelected(null);
    },
    onError: (err) => {
      // 执行中任务 → 转成强制删除二次确认（而不是把错误抛给用户）
      if (isApiError(err) && err.code === "TEAM_TASK_RUNNING") {
        setForceTarget(deleteTarget);
        return;
      }
      setError(isApiError(err) ? err.message : "删除失败");
      setDeleteTarget(null);
      setForceTarget(null);
    },
  });

  const openTeam = (team: TeamDto) => {
    setSelected(team);
    setError(null);
    setForm({
      name: team.name,
      description: team.description ?? "",
      reuseSession: team.reuseSession,
      mainAgentMemberId: team.mainAgentMemberId ?? "",
    });
  };

  return (
    <PageWindow testId="teams-list-root" maxWidth={1200} gap={space.md} style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: radius.md, backgroundColor: neutral[100], border: `1px solid ${neutral[200]}` }}>
          <button type="button" data-testid="unified-tab-teams" style={{ padding: "5px 16px", border: "none", borderRadius: radius.sm, backgroundColor: "var(--color-surface)", color: "#0F766E", fontSize: fontSize.sm, fontWeight: 700, cursor: "pointer", fontFamily: fontFamily.body, boxShadow: shadow.sm }}>团队</button>
          <button type="button" data-testid="unified-tab-members" onClick={() => router.push("/members")} style={{ padding: "5px 16px", border: "none", borderRadius: radius.sm, backgroundColor: "transparent", color: neutral[500], fontSize: fontSize.sm, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}>成员</button>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" data-testid="create-team-button" onClick={() => router.push("/teams/new")} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", fontSize: fontSize.sm, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}>＋ 新建团队</button>
      </div>

      <div>
        <div style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>团队与成员</div>
        <div style={{ fontSize: fontSize.sm, color: neutral[500], marginTop: 4 }}>团队是成员的集合；成员是平台级资产，可加入多个团队。</div>
      </div>

      <div style={{ display: "flex", gap: space.sm, alignItems: "center" }}>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="搜索团队名" style={{ width: 280, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body, outline: "none" }} />
        <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400] }}>共 {total} 个团队</span>
      </div>

      <div style={{ border: `1px solid ${neutral[200]}`, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "var(--color-surface)" }}>
        <div style={{ display: "grid", gridTemplateColumns: GRID, gap: space.sm, padding: `${space.sm}px ${space.md}px`, backgroundColor: neutral[50], borderBottom: `1px solid ${neutral[200]}`, fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}>
          <span>团队</span><span style={{ textAlign: "center" }}>成员</span><span>主 Agent</span><span style={{ textAlign: "center" }}>活跃任务</span><span style={{ textAlign: "center" }}>会话复用</span><span>更新时间</span><span style={{ textAlign: "right" }}>操作</span>
        </div>
        {teamsQuery.isPending ? (
          <div style={{ padding: space.xl, textAlign: "center", color: neutral[400], fontSize: fontSize.sm }}>加载中…</div>
        ) : items.length === 0 ? (
          <EmptyState title="还没有团队" description="点击右上角「新建团队」创建第一个团队" />
        ) : (
          items.map((team) => {
            const mainSeat = team.members.find((m) => m.id === team.mainAgentMemberId);
            return (
              <div key={team.id} data-testid="team-row" data-team-id={team.id} onClick={() => openTeam(team)} style={{ display: "grid", gridTemplateColumns: GRID, gap: space.sm, padding: `${space.sm + 2}px ${space.md}px`, alignItems: "center", borderBottom: `1px solid ${neutral[100]}`, cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
                  <AgentAvatar role="product" size="md" shape="square" dot={false} initials={team.name.slice(0, 1)} style={{ backgroundImage: "linear-gradient(135deg,#2DD4BF,#0D9488)", color: "#FFF", border: "none" }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.name}</div>
                    <div style={{ fontSize: 10, color: neutral[400], fontFamily: fontFamily.mono }}>{team.id}</div>
                  </div>
                </div>
                <span style={{ textAlign: "center", fontSize: fontSize.sm, color: neutral[700] }}>{team.members.length}</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[700], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mainSeat?.member?.name ?? mainSeat?.alias ?? "—"}</span>
                <span style={{ textAlign: "center", fontSize: fontSize.xs, color: team.activeTaskCount ? "#0F766E" : neutral[400] }}>{team.activeTaskCount ?? 0}</span>
                <span style={{ textAlign: "center", fontSize: fontSize.xs, color: team.reuseSession ? "#059669" : neutral[400] }}>{team.reuseSession ? "开启" : "关闭"}</span>
                <span style={{ fontSize: 10, color: neutral[400] }}>{new Date(team.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                  <button type="button" onClick={(e) => { e.stopPropagation(); router.push(`/chat?c=${encodeURIComponent(`group:${team.id}`)}`); }} style={{ border: "none", background: "none", color: "#0F766E", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}>会话</button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); openTeam(team); }} style={{ border: "none", background: "none", color: "#0F766E", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}>编辑</button>
                  <button
                    type="button"
                    data-testid="team-row-delete"
                    onClick={(e) => { e.stopPropagation(); setError(null); setDeleteTarget(team); }}
                    style={{ border: "none", background: "none", color: "#B91C1C", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      )}

      {selected && (
        <div style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,0.32)", display: "flex", justifyContent: "flex-end", zIndex: 40 }}>
          <div style={{ width: 520, height: "100%", display: "flex", flexDirection: "column", backgroundColor: "var(--color-surface)", boxShadow: shadow.lg }}>
            <div style={{ padding: `${space.lg}px ${space.xl}px ${space.md}px`, borderBottom: `1px solid ${neutral[100]}`, display: "flex", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: fontSize.lg, fontWeight: 700, color: neutral[900] }}>团队详情</div>
                <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: 4 }}>{selected.id} · v{selected.version}</div>
              </div>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => setSelected(null)} style={{ border: "none", background: "none", fontSize: 20, color: neutral[400], cursor: "pointer" }}>×</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: space.xl, display: "flex", flexDirection: "column", gap: space.lg }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>团队名称</span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>描述</span>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body, resize: "vertical" }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>主 Agent</span>
                <select value={form.mainAgentMemberId} onChange={(e) => setForm({ ...form, mainAgentMemberId: e.target.value })} style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body }}>
                  <option value="">未指定</option>
                  {selected.members.map((m) => <option key={m.id} value={m.id}>{m.member?.name ?? m.alias}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.sm, color: neutral[700] }}>
                <input type="checkbox" checked={form.reuseSession} onChange={(e) => setForm({ ...form, reuseSession: e.target.checked })} />
                会话复用（任务完成后保留会话）
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>成员 · {selected.members.length}</span>
                {selected.members.map((m) => (
                  <div key={m.id} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>
                    <AgentAvatar role={toAvatarRole(m.member?.defaultRoleId ? null : null)} size="sm" />
                    <span style={{ flex: 1, fontSize: fontSize.sm, color: neutral[700] }}>{m.member?.name ?? m.alias}</span>
                    <span style={{ fontSize: 10, color: neutral[400] }}>#{m.seq}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>当前状态：{statusLabel(selected.currentTaskStatus)} · 活跃任务 {selected.activeTaskCount ?? 0}</div>
              {error && <div style={{ fontSize: fontSize.xs, color: "#B91C1C" }}>{error}</div>}
            </div>
            <div style={{ padding: `${space.md}px ${space.xl}px`, borderTop: `1px solid ${neutral[100]}`, display: "flex", alignItems: "center", gap: space.sm }}>
              <button type="button" onClick={() => router.push(`/teams/${selected.id}`)} style={{ border: "none", background: "none", color: "#0F766E", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}>完整管理 →</button>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => setSelected(null)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.sm, cursor: "pointer", fontFamily: fontFamily.body }}>取消</button>
              <button type="button" disabled={updateMutation.isPending} onClick={() => updateMutation.mutate()} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", fontSize: fontSize.sm, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}>{updateMutation.isPending ? "保存中…" : "保存修改"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除团队：普通确认（无执行中任务时一次删掉；有执行中任务则由 onError 转强制确认框） */}
      <ConfirmDialog
        open={!!deleteTarget}
        testid="team-delete-confirm"
        title="删除团队"
        description={(() => {
          if (!deleteTarget) return "";
          const taskName = deleteTarget.currentTaskTitle ?? deleteTarget.currentTaskId;
          const taskPart = taskName ? `该团队的关联任务「${taskName}」及其产出物、消息会一并删除。` : "该团队暂无关联任务。";
          return `确认删除团队「${deleteTarget.name}」？${taskPart}此操作不可恢复。`;
        })()}
        confirmLabel="删除"
        submitting={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id });
        }}
        onClose={() => setDeleteTarget(null)}
      />

      {/* 强制删除：团队有执行中任务时，二次确认后带 force=true 重放 */}
      <ConfirmDialog
        open={!!forceTarget}
        testid="team-force-delete-confirm"
        title="团队有执行中的任务"
        description={(() => {
          if (!forceTarget) return "";
          const taskName = forceTarget.currentTaskTitle ?? forceTarget.currentTaskId ?? "未知任务";
          return `团队「${forceTarget.name}」有正在执行的任务「${taskName}」。强制删除会连同该任务一起删除，正在执行的 Agent 输出将丢失且无法恢复。确认强制删除？`;
        })()}
        confirmLabel="强制删除"
        pendingLabel="删除中…"
        submitting={deleteMutation.isPending}
        onConfirm={() => {
          if (forceTarget) deleteMutation.mutate({ id: forceTarget.id, force: true });
        }}
        onClose={() => setForceTarget(null)}
      />
    </PageWindow>
  );
}