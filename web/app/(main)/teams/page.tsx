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
import { AgentAvatar, ConfirmDialog, EmptyState, PageWindow, Pagination, PrimaryButton, RowAction } from "@/src/components/ui";
import {
  type RoleKey,
  ROLE_KEYS,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
  layout,
} from "@/src/theme/tokens";

/** 数据表格统一观感（视觉优化清单 AES-08）：
 * - hover 浅底：此前行背景全透明、hover 无任何变化，长表容易串行；
 * - 表头 sticky：此前 position:static，表体滚动后列名消失；
 * - 行高统一 56（原 teams 57 / members 55 / users 69）。 */
const TABLE_CSS = `
.table-row { transition: background-color .15s ease; }
.table-row:hover { background-color: var(--color-neutral-50); }
.table-head { position: sticky; top: 0; z-index: 1; }
`;

const PAGE_SIZE = 12;
// 团队列收窄到 minmax(200px,1.5fr)、数值列对齐用等宽数字（视觉优化清单 AES-09）
const GRID = "minmax(200px,1.5fr) 80px 150px 90px 90px 120px 190px";

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
    <PageWindow testId="teams-list-root" maxWidth={layout.wide} gap={space.md} fill style={{ position: "relative" }}>
      <style>{TABLE_CSS}</style>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: radius.md, backgroundColor: neutral[100], border: `1px solid ${neutral[200]}` }}>
          <button type="button" data-testid="unified-tab-teams" style={{ padding: "5px 16px", border: "none", borderRadius: radius.sm, backgroundColor: "var(--color-surface)", color: "var(--color-accent-text)", fontSize: fontSize.sm, fontWeight: 700, cursor: "pointer", fontFamily: fontFamily.body, boxShadow: shadow.sm }}>团队</button>
          <button type="button" data-testid="unified-tab-members" onClick={() => router.push("/members")} style={{ padding: "5px 16px", border: "none", borderRadius: radius.sm, backgroundColor: "transparent", color: neutral[500], fontSize: fontSize.sm, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}>成员</button>
        </div>
        <span style={{ flex: 1 }} />
        <PrimaryButton testid="create-team-button" onClick={() => router.push("/teams/new")}>＋ 新建团队</PrimaryButton>
      </div>

      {/* 页内不再重复顶栏的「团队与成员」（视觉优化清单 AES-06）：
          顶栏已给出模块名，这里只留真正有信息量的说明，避免同一屏出现两次同一个标题。 */}
      <div style={{ fontSize: fontSize.sm, color: neutral[500], lineHeight: 1.6 }}>
        团队是成员的集合；成员是平台级资产，可加入多个团队。
      </div>

      <div style={{ display: "flex", gap: space.sm, alignItems: "center" }}>
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="搜索团队名" style={{ width: 280, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.sm, color: neutral[800], fontFamily: fontFamily.body, outline: "none" }} />
        <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400] }}>搜索按团队名过滤</span>
      </div>

      {/* 列表卡：flex:1 撑满可用高度 + 表体独立滚动（视觉优化清单 AES-03）
          此前卡片按内容高度渲染 → 只有 3~5 行时下方空出 340px 页面底色，像没加载完。 */}
      <div style={{ flexShrink: 0, maxHeight: "100%", minHeight: 0, display: "flex", flexDirection: "column", border: `1px solid ${neutral[200]}`, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "var(--color-surface)" }}>
        <div className="table-head" style={{ flexShrink: 0, display: "grid", gridTemplateColumns: GRID, gap: space.sm, padding: `${space.sm}px ${space.md}px`, backgroundColor: neutral[50], borderBottom: `1px solid ${neutral[200]}`, fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}>
          <span>团队</span><span style={{ textAlign: "right" }}>成员</span><span>主 Agent</span><span style={{ textAlign: "right" }}>活跃任务</span><span style={{ textAlign: "center" }}>会话复用</span><span>更新时间</span><span style={{ textAlign: "right" }}>操作</span>
        </div>
        {teamsQuery.isPending ? (
          <div style={{ padding: space.xl, textAlign: "center", color: neutral[400], fontSize: fontSize.sm }}>加载中…</div>
        ) : items.length === 0 ? (
          <EmptyState title="还没有团队" description="点击右上角「新建团队」创建第一个团队" />
        ) : (
          <div style={{ minHeight: 0, overflowY: "auto" }}>
          {items.map((team) => {
            const mainSeat = team.members.find((m) => m.id === team.mainAgentMemberId);
            return (
              <div key={team.id} data-testid="team-row" data-team-id={team.id} onClick={() => openTeam(team)} className="table-row" style={{ display: "grid", gridTemplateColumns: GRID, gap: space.sm, padding: `${space.sm + 2}px ${space.md}px`, alignItems: "center", borderBottom: `1px solid ${neutral[100]}`, cursor: "pointer", minHeight: 56 }}>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
                  <AgentAvatar role="product" size="md" shape="square" dot={false} initials={team.name.slice(0, 1)} style={{ backgroundImage: "linear-gradient(135deg, var(--color-brand-fill-hover), var(--color-brand-fill))", color: "#FFF", border: "none" }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{team.name}</div>
                    <div style={{ fontSize: 10, color: neutral[400], fontFamily: fontFamily.mono }}>{team.id}</div>
                  </div>
                </div>
                <span style={{ textAlign: "right", fontSize: fontSize.sm, color: neutral[700], fontVariantNumeric: "tabular-nums" }}>{team.members.length}</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[700], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mainSeat?.member?.name ?? mainSeat?.alias ?? "—"}</span>
                <span style={{ textAlign: "right", fontSize: fontSize.sm, color: team.activeTaskCount ? "var(--color-accent-text)" : neutral[400], fontVariantNumeric: "tabular-nums" }}>{team.activeTaskCount ?? 0}</span>
                <span style={{ textAlign: "center", fontSize: fontSize.xs, color: team.reuseSession ? "var(--color-success-text)" : neutral[400] }}>{team.reuseSession ? "开启" : "关闭"}</span>
                <span style={{ fontSize: 10, color: neutral[400] }}>{new Date(team.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                  <RowAction
                    tone="accent"
                    onClick={(e) => { e.stopPropagation(); router.push(`/chat?c=${encodeURIComponent(`group:${team.id}`)}`); }}
                  >
                    会话
                  </RowAction>
                  <RowAction
                    tone="accent"
                    onClick={(e) => { e.stopPropagation(); openTeam(team); }}
                  >
                    编辑
                  </RowAction>
                  <RowAction
                    tone="danger"
                    testid="team-row-delete"
                    onClick={(e) => { e.stopPropagation(); setError(null); setDeleteTarget(team); }}
                  >
                    删除
                  </RowAction>
                </div>
              </div>
            );
          })}
          {/* 列表收尾提示：数据不足一屏时，用一条弱文案给滚动区收口，
              避免大片纯白看起来像「没加载完」（AES-03） */}
          {items.length < PAGE_SIZE && (
            <div
              style={{
                padding: `${space.lg}px 0`,
                textAlign: "center",
                fontSize: fontSize.xs,
                color: neutral[300],
                letterSpacing: "0.02em",
              }}
            >
              — 已显示全部 {items.length} 个团队 —
            </div>
          )}
          </div>
        )}
        {/* 卡片固定底条：统计 + 分页（视觉优化清单 AES-03 —— 让撑满的容器底部有内容锚点，
            而不是一整块空白；分页也从上方的浮动块收进表格内，符合数据表格的通行布局） */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.sm}px ${space.md}px`,
            borderTop: `1px solid ${neutral[100]}`,
            backgroundColor: "var(--color-surface)",
            fontSize: fontSize.xs,
            color: neutral[500],
          }}
        >
          <span>共 {total} 个团队 · 每页 {PAGE_SIZE} 条</span>
          <span style={{ flex: 1 }} />
          {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
        </div>
      </div>

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
              {error && <div style={{ fontSize: fontSize.xs, color: "var(--color-danger-text)" }}>{error}</div>}
            </div>
            <div style={{ padding: `${space.md}px ${space.xl}px`, borderTop: `1px solid ${neutral[100]}`, display: "flex", alignItems: "center", gap: space.sm }}>
              <button type="button" onClick={() => router.push(`/teams/${selected.id}`)} style={{ border: "none", background: "none", color: "var(--color-accent-text)", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}>完整管理 →</button>
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