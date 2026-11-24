"use client";

/**
 * 工作空间管理页（M3，按现有页面设计语言重做）。
 *
 * 结构对齐 teams/agents/system 等资源页：PageWindow + 分区卡片
 * （surface / neutral[200] 边框 / shadow.sm / radius.lg / 主色 #0D9488）。
 *
 * 能力：
 * - 我的工作空间列表（当前空间高亮、角色/平台只读徽章、切换/管理员只读查看）
 * - 创建空间
 * - 当前空间成员管理（owner/admin 可邀请/移除）
 * - 平台管理员：资源空间迁移（发布共享到系统空间 / 回收）+ 迁移审计
 */
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/stores/authStore";
import { isPlatformAdmin } from "@/lib/permissions";
import { PageWindow, EmptyState } from "@/src/components/ui";
import {
  neutral,
  radius,
  space,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

interface WorkspaceRow {
  id: string;
  name: string;
  isSystem: boolean;
  status: string;
  role: string;
  ownerUserId: string | null;
  createdAt: string;
}

interface MemberRow {
  userId: string;
  role: string;
  joinedAt: string;
  user: { id: string; username: string; displayName: string; enabled: boolean };
}

interface AdminWorkspaceRow {
  id: string;
  name: string;
  isSystem: boolean;
  status: string;
  ownerUserId: string | null;
  createdAt: string;
  memberCount: number;
}

interface RelocationRow {
  id: string;
  resourceType: string;
  resourceId: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  reason: string | null;
  actorUserId: string;
  createdAt: string;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "空间所有者",
  admin: "空间管理员",
  member: "空间成员",
};

const RELOCATABLE_TYPES = [
  "agent",
  "agent_role",
  "skill",
  "tool",
  "execution_policy",
  "model",
  "model_credential",
  "mcp_server",
  "git_repo",
  "git_credential",
  "worker",
];

/* ----------------------------- 视觉常量（对齐现有页） ----------------------------- */

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

const cardStyle: CSSProperties = {
  padding: space.xl,
  borderRadius: radius.lg,
  backgroundColor: "var(--color-surface)",
  border: `1px solid ${neutral[200]}`,
  boxShadow: shadow.sm,
  display: "flex",
  flexDirection: "column",
  gap: space.md,
  ...baseFont,
};

const sectionTitle: CSSProperties = {
  fontSize: fontSize.xl,
  fontWeight: 600,
  color: neutral[800],
  margin: 0,
};

const sectionDesc: CSSProperties = {
  fontSize: fontSize.md,
  color: neutral[500],
  margin: 0,
  lineHeight: 1.6,
};

const inputStyle: CSSProperties = {
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[800],
  fontSize: fontSize.md,
  fontFamily: fontFamily.body,
  outline: "none",
  minWidth: 0,
};

const primaryButton: CSSProperties = {
  padding: `${space.sm}px ${space.lg}px`,
  borderRadius: radius.md,
  border: "none",
  backgroundColor: "#0D9488",
  color: "#FFFFFF",
  fontSize: fontSize.md,
  fontWeight: 600,
  fontFamily: fontFamily.body,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const secondaryButton: CSSProperties = {
  padding: `${space.xs + 2}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[600],
  fontSize: fontSize.sm,
  fontWeight: 500,
  fontFamily: fontFamily.body,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const muted: CSSProperties = {
  fontSize: fontSize.sm,
  color: neutral[500],
  ...baseFont,
};

const mono: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: fontSize.xs,
  color: neutral[400],
};

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "teal" | "amber";
}) {
  const palette = {
    neutral: { bg: neutral[100], fg: neutral[600], bd: neutral[200] },
    teal: { bg: "rgba(13,148,136,.10)", fg: "#0F766E", bd: "rgba(13,148,136,.25)" },
    amber: { bg: "rgba(217,119,6,.10)", fg: "#B45309", bd: "rgba(217,119,6,.25)" },
  }[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 8px",
        borderRadius: radius.pill,
        backgroundColor: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.bd}`,
        fontSize: fontSize.xs,
        fontWeight: 500,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      {children}
    </span>
  );
}

/** 空间首字图标（渐变方块，与团队/成员头像风格一致）。 */
function WorkspaceAvatar({ name, system }: { name: string; system: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        width: 40,
        height: 40,
        flexShrink: 0,
        borderRadius: radius.md,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: fontSize.lg,
        fontWeight: 700,
        color: "#FFFFFF",
        backgroundColor: system ? "#64748B" : "#0D9488",
        ...baseFont,
      }}
    >
      {(name || "空").slice(0, 1)}
    </div>
  );
}

/* ---------------------------------- 页面 ---------------------------------- */

export default function WorkspacesPage() {
  const user = useAuthStore((s) => s.user);
  const switchWorkspace = useAuthStore((s) => s.switchWorkspace);
  const viewWorkspace = useAuthStore((s) => s.viewWorkspace);
  const setViewWorkspace = useAuthStore((s) => s.setViewWorkspace);
  const queryClient = useQueryClient();
  const router = useRouter();
  const admin = isPlatformAdmin(user?.permissions);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [inviteUserId, setInviteUserId] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [busy, setBusy] = useState(false);
  // 操作反馈：固定右下角浮层（跨卡片操作也能立刻看到）
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [showAllSpaces, setShowAllSpaces] = useState(false);
  // 全部空间（管理员）搜索 + 分页
  const [allSpaceQuery, setAllSpaceQuery] = useState("");
  const [allSpaceLimit, setAllSpaceLimit] = useState(20);
  // 管理员迁移表单
  const [relocType, setRelocType] = useState("agent");
  const [relocId, setRelocId] = useState("");
  const [relocTarget, setRelocTarget] = useState("");
  const [relocReason, setRelocReason] = useState("");

  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.get<WorkspaceRow[]>("/workspaces"),
  });
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const currentId = user?.currentWorkspaceId ?? null;
  const selected =
    workspaces.find((w) => w.id === (selectedId ?? currentId)) ?? workspaces[0];

  const membersQuery = useQuery({
    queryKey: ["workspace-members", selected?.id],
    queryFn: () => api.get<MemberRow[]>(`/workspaces/${selected?.id}/members`),
    enabled: !!selected && !selected.isSystem,
  });

  const allWorkspacesQuery = useQuery({
    queryKey: ["workspaces-all"],
    queryFn: () => api.get<AdminWorkspaceRow[]>("/workspaces/all"),
    enabled: admin,
  });

  const relocationsQuery = useQuery({
    queryKey: ["workspace-relocations"],
    queryFn: () => api.get<RelocationRow[]>("/workspaces/relocations?limit=20"),
    enabled: admin,
  });

  const switchable = useMemo(
    () => (workspacesQuery.data ?? []).filter((w) => !w.isSystem),
    [workspacesQuery.data],
  );
  const canManage =
    !!selected &&
    !selected.isSystem &&
    ["owner", "admin"].includes(selected.role ?? "");

  // toast 4s 自动消失
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) setToast({ ok: true, text: ok });
    } catch (err) {
      setToast({
        ok: false,
        text: err instanceof Error ? err.message : "操作失败",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSwitch = (workspaceId: string) =>
    run(async () => {
      await switchWorkspace(workspaceId);
      queryClient.clear();
      router.refresh();
    }, "已切换工作空间");

  const handleCreate = () =>
    run(async () => {
      const created = await api.post<{ id: string; name: string }>(
        "/workspaces",
        { name: newName.trim() },
      );
      setNewName("");
      setShowAllSpaces(true);
      // 创建后直接进入新空间（就像新建文档后打开它）：token 重签 + 缓存清空，
      // 避免「服务端 lastWorkspace 已变、前端请求头还是旧空间」的错位。
      await switchWorkspace(created.id);
      queryClient.clear();
      router.refresh();
    }, "空间已创建，已切换到新空间");

  const handleInvite = () =>
    run(async () => {
      await api.post(`/workspaces/${selected?.id}/members`, {
        userId: inviteUserId.trim(),
        role: inviteRole,
      });
      setInviteUserId("");
      await queryClient.invalidateQueries({
        queryKey: ["workspace-members", selected?.id],
      });
    }, "成员已加入");

  const handleRemove = (userId: string) =>
    run(async () => {
      await api.delete(`/workspaces/${selected?.id}/members/${userId}`);
      await queryClient.invalidateQueries({
        queryKey: ["workspace-members", selected?.id],
      });
    }, "成员已移除");

  const handleRelocate = () =>
    run(async () => {
      await api.post("/workspaces/relocations", {
        resourceType: relocType,
        resourceId: relocId.trim(),
        targetWorkspaceId: relocTarget.trim(),
        reason: relocReason.trim() || undefined,
      });
      await queryClient.invalidateQueries({
        queryKey: ["workspace-relocations"],
      });
      setRelocId("");
    }, "资源已迁移（已写审计）");

  const allSpaces = useMemo(
    () => allWorkspacesQuery.data ?? [],
    [allWorkspacesQuery.data],
  );
  const filteredAllSpaces = useMemo(() => {
    const q = allSpaceQuery.trim().toLowerCase();
    if (!q) return allSpaces;
    return allSpaces.filter(
      (w) =>
        w.name.toLowerCase().includes(q) || w.id.toLowerCase().includes(q),
    );
  }, [allSpaces, allSpaceQuery]);
  const visibleAllSpaces = filteredAllSpaces.slice(0, allSpaceLimit);
  const readOnlyView = !!viewWorkspace;

  const systemWorkspace = workspaces.find((w) => w.isSystem);
  // 当前空间置顶 → 系统空间 → 其余（按名称）；默认折叠，避免空间多时把成员/迁移区推到很下面
  const sortedSpaces = useMemo(() => {
    const rank = (w: WorkspaceRow) =>
      w.id === currentId ? 0 : w.isSystem ? 1 : 2;
    return [...workspaces].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.name.localeCompare(b.name, "zh-Hans-CN"),
    );
  }, [workspaces, currentId]);
  const visibleSpaces = showAllSpaces
    ? sortedSpaces
    : sortedSpaces.slice(0, 6);
  const currentSpace = workspaces.find((w) => w.id === currentId) ?? null;

  return (
    <PageWindow testId="workspaces-page" maxWidth={1080} gap={space.lg}>
      {/* ───────────── 我的工作空间 ───────────── */}
      <section style={cardStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.lg,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <h2 style={sectionTitle}>我的工作空间</h2>
            <p style={sectionDesc}>
              空间 = 租户：模型、Worker、成员、团队、任务与产出物按空间隔离；
              平台内置资源（Agent 模板 / 技能 / 工具 / 模型目录）对所有空间只读可见。
            </p>
            {currentSpace ? (
              <div
                data-testid="workspace-current-summary"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  marginTop: space.xs,
                  flexWrap: "wrap",
                }}
              >
                <span style={muted}>当前使用：</span>
                <Badge tone="teal">{currentSpace.name}</Badge>
                {!currentSpace.isSystem ? (
                  <span style={muted}>
                    {ROLE_LABEL[currentSpace.role] ?? currentSpace.role}
                  </span>
                ) : null}
                {viewWorkspace ? (
                  <>
                    <Badge tone="amber">
                      只读查看：{viewWorkspace.name}
                    </Badge>
                    <span style={{ ...muted, color: "#B45309" }}>
                      写操作已禁用（服务端同样拒绝）
                    </span>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
            <input
              data-testid="workspace-create-name"
              style={{ ...inputStyle, width: 180 }}
              placeholder={readOnlyView ? "只读视图下不可创建空间" : "新空间名称"}
              value={newName}
              disabled={readOnlyView}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim() && !busy) handleCreate();
              }}
            />
            <button
              type="button"
              data-testid="workspace-create-submit"
              style={{
                ...primaryButton,
                opacity: busy || !newName.trim() || readOnlyView ? 0.6 : 1,
                cursor: readOnlyView ? "not-allowed" : "pointer",
              }}
              disabled={busy || !newName.trim() || readOnlyView}
              title={readOnlyView ? `只读视图（${viewWorkspace?.name}）下不可创建空间` : undefined}
              onClick={handleCreate}
            >
              创建空间
            </button>
          </div>
        </div>

        {workspacesQuery.isLoading ? (
          <p style={muted}>加载中…</p>
        ) : workspaces.length === 0 ? (
          <EmptyState
            title="还没有工作空间"
            description="创建第一个工作空间后，即可在其中组织团队、成员与模型。"
            icon={<span aria-hidden>⧉</span>}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
            {visibleSpaces.map((w) => {
              const isCurrent = w.id === currentId;
              const isSelected = w.id === selected?.id;
              return (
                <div
                  key={w.id}
                  data-testid={`workspace-row-${w.id}`}
                  onClick={() => setSelectedId(w.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.md,
                    padding: `${space.md}px ${space.lg}px`,
                    borderRadius: radius.md,
                    border: `1px solid ${
                      isCurrent ? "rgba(13,148,136,.45)" : neutral[200]
                    }`,
                    backgroundColor: isSelected
                      ? "rgba(13,148,136,.06)"
                      : "var(--color-surface)",
                    cursor: "pointer",
                    flexWrap: "wrap",
                  }}
                >
                  <WorkspaceAvatar name={w.name} system={w.isSystem} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                      <span
                        style={{
                          fontSize: fontSize.lg,
                          fontWeight: 600,
                          color: neutral[800],
                          ...baseFont,
                        }}
                      >
                        {w.name}
                      </span>
                      {isCurrent ? <Badge tone="teal">当前空间</Badge> : null}
                      {w.isSystem ? (
                        <Badge tone="amber">平台只读</Badge>
                      ) : (
                        <Badge>{ROLE_LABEL[w.role] ?? w.role}</Badge>
                      )}
                      {viewWorkspace?.id === w.id ? (
                        <Badge tone="amber">只读查看中</Badge>
                      ) : null}
                    </div>
                    <span style={mono}>id: {w.id}</span>
                  </div>
                  <div
                    style={{ display: "flex", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!w.isSystem && !isCurrent ? (
                      <button
                        type="button"
                        data-testid={`workspace-switch-${w.id}`}
                        style={secondaryButton}
                        disabled={busy}
                        onClick={() => handleSwitch(w.id)}
                      >
                        切换到该空间
                      </button>
                    ) : null}
                    {admin && !w.isSystem && !isCurrent ? (
                      <button
                        type="button"
                        data-testid={`workspace-view-${w.id}`}
                        style={secondaryButton}
                        disabled={busy}
                        onClick={() => {
                          setViewWorkspace({ id: w.id, name: w.name });
                          queryClient.clear();
                          router.refresh();
                        }}
                      >
                        管理员只读查看
                      </button>
                    ) : null}
                    {isCurrent ? (
                      <span style={{ ...muted, color: "#0F766E", fontWeight: 600 }}>
                        ✓ 使用中
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {sortedSpaces.length > 6 ? (
          <button
            type="button"
            data-testid="workspace-toggle-all"
            style={{ ...secondaryButton, alignSelf: "flex-start" }}
            onClick={() => setShowAllSpaces((v) => !v)}
          >
            {showAllSpaces
              ? "收起"
              : `展开全部（共 ${sortedSpaces.length} 个空间）`}
          </button>
        ) : null}
      </section>

      {/* ───────────── 全部空间（管理员） ───────────── */}
      {admin ? (
        <section style={cardStyle} data-testid="admin-workspaces">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h2 style={sectionTitle}>全部空间（仅平台管理员）</h2>
            <p style={sectionDesc}>
              仅<strong style={{ color: neutral[700] }}>平台管理员</strong>可跨空间只读查看
              （用于排障/协助用户），写操作会被服务端拒绝；空间管理员只能管理自己所在的空间。
            </p>
          </div>
          {allWorkspacesQuery.isLoading ? <p style={muted}>加载中…</p> : null}
          <input
            data-testid="admin-workspace-search"
            style={{ ...inputStyle, maxWidth: 320 }}
            placeholder="搜索空间名称 / id"
            value={allSpaceQuery}
            onChange={(e) => {
              setAllSpaceQuery(e.target.value);
              setAllSpaceLimit(20);
            }}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              overflow: "hidden",
            }}
          >
            {visibleAllSpaces.map((w, idx) => {
              const viewing = viewWorkspace?.id === w.id;
              return (
                <div
                  key={w.id}
                  data-testid={`admin-workspace-row-${w.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.md,
                    padding: `${space.md}px ${space.lg}px`,
                    borderTop: idx === 0 ? "none" : `1px solid ${neutral[100]}`,
                    flexWrap: "wrap",
                  }}
                >
                  <WorkspaceAvatar name={w.name} system={w.isSystem} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                      <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800], ...baseFont }}>
                        {w.name}
                      </span>
                      <Badge>{w.memberCount} 位成员</Badge>
                      {w.id === currentId ? <Badge tone="teal">当前空间</Badge> : null}
                      {viewing ? <Badge tone="amber">只读查看中</Badge> : null}
                    </div>
                    <span style={mono}>
                      id: {w.id}
                      {w.ownerUserId ? ` · owner: ${w.ownerUserId}` : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid={`admin-workspace-view-${w.id}`}
                    style={secondaryButton}
                    disabled={busy}
                    onClick={() => {
                      setViewWorkspace({ id: w.id, name: w.name });
                      queryClient.clear();
                      router.refresh();
                    }}
                  >
                    {viewing ? "只读查看中" : "平台管理员只读查看"}
                  </button>
                </div>
              );
            })}
          </div>
          {visibleAllSpaces.length === 0 && !allWorkspacesQuery.isLoading ? (
            <span style={muted}>没有匹配的空间。</span>
          ) : null}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.md,
              flexWrap: "wrap",
            }}
          >
            <span style={muted}>
              显示 {visibleAllSpaces.length} / {filteredAllSpaces.length}
              {allSpaceQuery.trim()
                ? `（共 ${allSpaces.length} 个空间）`
                : ""}
            </span>
            {visibleAllSpaces.length < filteredAllSpaces.length ? (
              <button
                type="button"
                data-testid="admin-workspace-load-more"
                style={secondaryButton}
                onClick={() => setAllSpaceLimit((n) => n + 20)}
              >
                加载更多
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ───────────── 成员管理 ───────────── */}
      {selected && !selected.isSystem ? (
        <section style={cardStyle} data-testid="workspace-members">
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: space.lg,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <h2 style={sectionTitle}>
                成员管理
                <span style={{ ...sectionDesc, marginLeft: space.sm, fontSize: fontSize.md }}>
                  · {selected.name}
                </span>
              </h2>
              <p style={sectionDesc}>
                空间内成员共享该空间的团队、任务与产出物；owner/admin 可邀请或移除成员。
              </p>
            </div>
            {canManage ? (
              <div style={{ display: "flex", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  data-testid="workspace-invite-userid"
                  style={{ ...inputStyle, width: 190 }}
                  placeholder={readOnlyView ? "只读视图下不可邀请" : "用户 id（如 u_0000000002）"}
                  value={inviteUserId}
                  disabled={readOnlyView}
                  onChange={(e) => setInviteUserId(e.target.value)}
                />
                <select
                  data-testid="workspace-invite-role"
                  style={{ ...inputStyle, width: 110 }}
                  disabled={readOnlyView}
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                >
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
                <button
                  type="button"
                  data-testid="workspace-invite-submit"
                  style={{
                    ...primaryButton,
                    opacity: busy || !inviteUserId.trim() || readOnlyView ? 0.6 : 1,
                    cursor: readOnlyView ? "not-allowed" : "pointer",
                  }}
                  disabled={busy || !inviteUserId.trim() || readOnlyView}
                  title={readOnlyView ? "只读视图下不可写" : undefined}
                  onClick={handleInvite}
                >
                  邀请
                </button>
              </div>
            ) : null}
          </div>

          {membersQuery.isLoading ? <p style={muted}>加载成员…</p> : null}
          {(membersQuery.data ?? []).length === 0 && !membersQuery.isLoading ? (
            <EmptyState
              title="还没有成员"
              description="邀请同事加入该空间后，即可协作处理团队与任务。"
              icon={<span aria-hidden>◉</span>}
            />
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                overflow: "hidden",
              }}
            >
              {(membersQuery.data ?? []).map((m, idx) => (
                <div
                  key={m.userId}
                  data-testid={`workspace-member-${m.userId}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.md,
                    padding: `${space.md}px ${space.lg}px`,
                    borderTop: idx === 0 ? "none" : `1px solid ${neutral[100]}`,
                    flexWrap: "wrap",
                  }}
                >
                  <div
                    aria-hidden
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: radius.pill,
                      backgroundColor: neutral[100],
                      color: neutral[600],
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: fontSize.sm,
                      fontWeight: 600,
                      ...baseFont,
                    }}
                  >
                    {(m.user.displayName || m.user.username || "?").slice(0, 1)}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800], ...baseFont }}>
                      {m.user.displayName}
                    </span>
                    <span style={muted}>@{m.user.username}</span>
                  </div>
                  <Badge tone={m.role === "owner" ? "teal" : "neutral"}>
                    {ROLE_LABEL[m.role] ?? m.role}
                  </Badge>
                  {canManage && m.role !== "owner" ? (
                    <button
                      type="button"
                      style={{ ...secondaryButton, color: "#B91C1C" }}
                      disabled={busy}
                      onClick={() => handleRemove(m.userId)}
                    >
                      移除
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* ───────────── 资源空间迁移（管理员） ───────────── */}
      {admin ? (
        <section style={cardStyle} data-testid="workspace-relocations">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <h2 style={sectionTitle}>资源空间迁移（仅平台管理员）</h2>
            <p style={sectionDesc}>
              目标填 <code style={{ ...mono, fontSize: fontSize.sm, color: neutral[600] }}>ws_system</code>{" "}
              = 发布为平台共享（如一个 Worker / 模型给多个空间用）；从系统空间移出 = 回收共享
              （需先解除其它空间引用）。仅配置 / 能力类资源可迁移。
            </p>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "150px minmax(140px,1fr) minmax(160px,1fr) minmax(140px,1fr) auto",
              gap: space.sm,
              alignItems: "center",
            }}
          >
            <select
              data-testid="reloc-type"
              style={inputStyle}
              value={relocType}
              onChange={(e) => setRelocType(e.target.value)}
            >
              {RELOCATABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <input
              data-testid="reloc-resource-id"
              style={inputStyle}
              placeholder="资源 id"
              value={relocId}
              onChange={(e) => setRelocId(e.target.value)}
            />
            <input
              data-testid="reloc-target"
              style={inputStyle}
              placeholder="目标空间 id（ws_system = 共享）"
              value={relocTarget}
              onChange={(e) => setRelocTarget(e.target.value)}
            />
            <input
              data-testid="reloc-reason"
              style={inputStyle}
              placeholder="原因（审计）"
              value={relocReason}
              onChange={(e) => setRelocReason(e.target.value)}
            />
            <button
              type="button"
              data-testid="reloc-submit"
              style={{
                ...primaryButton,
                opacity: busy || !relocId.trim() || !relocTarget.trim() || readOnlyView ? 0.6 : 1,
                cursor: readOnlyView ? "not-allowed" : "pointer",
              }}
              disabled={busy || !relocId.trim() || !relocTarget.trim() || readOnlyView}
              title={readOnlyView ? "只读视图下不可迁移资源" : undefined}
              onClick={handleRelocate}
            >
              迁移
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: space.xs, marginTop: space.xs }}>
            <span style={{ ...muted, fontWeight: 600, color: neutral[600] }}>最近迁移审计</span>
            {(relocationsQuery.data ?? []).length === 0 && !relocationsQuery.isLoading ? (
              <span style={muted}>暂无迁移记录</span>
            ) : (
              (relocationsQuery.data ?? []).map((r) => (
                <div
                  key={r.id}
                  data-testid={`relocation-${r.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: `${space.xs + 2}px ${space.md}px`,
                    borderRadius: radius.sm,
                    backgroundColor: neutral[50],
                    flexWrap: "wrap",
                  }}
                >
                  <span style={mono}>{new Date(r.createdAt).toLocaleString()}</span>
                  <Badge>{r.resourceType}</Badge>
                  <span style={{ ...muted, fontSize: fontSize.xs }}>{r.resourceId}</span>
                  <span style={{ ...muted, fontSize: fontSize.xs }}>
                    {r.fromWorkspaceId} → <strong>{r.toWorkspaceId}</strong>
                  </span>
                  {r.reason ? (
                    <span style={{ ...muted, fontSize: fontSize.xs, color: neutral[400] }}>
                      （{r.reason}）
                    </span>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}

      {systemWorkspace && switchable.length > 0 ? (
        <p style={{ ...muted, margin: 0 }} data-testid="workspace-system-note">
          提示：平台空间（{systemWorkspace.name}）不作为可切换工作空间；其中的内置 Agent 模板 /
          技能 / 工具 / 模型目录在每个空间都可见且只读。
        </p>
      ) : null}

      {/* 操作反馈浮层：跨卡片操作（切换/邀请/迁移）都能立刻看到结果 */}
      {toast ? (
        <div
          data-testid={toast.ok ? "workspace-notice" : "workspace-error"}
          role="status"
          style={{
            position: "fixed",
            right: space.xl,
            bottom: space.xl,
            zIndex: 60,
            maxWidth: 360,
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.md,
            backgroundColor: toast.ok ? "#0F766E" : "#B91C1C",
            color: "#FFFFFF",
            fontSize: fontSize.md,
            fontWeight: 500,
            boxShadow: shadow.md,
            ...baseFont,
          }}
        >
          {toast.ok ? "✓ " : "✕ "}
          {toast.text}
        </div>
      ) : null}
    </PageWindow>
  );
}
