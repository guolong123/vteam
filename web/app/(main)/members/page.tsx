"use client";

/**
 * 成员库页面（成员平台化 P0/P1 前端）
 * =============================================
 * - 数据源：GET /members（关键字/岗位/状态/分页）；GET /agent-roles 与 /agents 提供表单候选。
 * - 交互：新建 / 编辑 / 停用 / 恢复 / 删除（有席位由后端 409 拦截）；克隆保留给后续版本。
 * - 平台级资源：不做团队门；权限走 members.view/create/edit/delete（前端仅做体验收敛，服务端为准）。
 * - 布局与 token 对齐 agents/skills 等资源页；无 fixed / 100vh / 100vw。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { hasPermission } from "@/lib/permissions";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentAvatar, ConfirmDialog, EmptyState, PageWindow, SearchableSelect } from "@/src/components/ui";
import { NAV_TOPBAR_HEIGHT } from "@/src/components/layout";
import { agentRolesApi, type AgentRoleDto } from "@/src/api/agent-roles";
import {
  membersApi,
  type CreateMemberPayload,
  type MemberDto,
  type MemberPromptMode,
  type UpdateMemberPayload,
} from "@/src/api/members";
import { PERSONA_OPTIONS, personaPreview } from "@/src/lib/persona";
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

interface AgentOption {
  id: string;
  name: string;
  agentKey: string | null;
}

interface NotificationChannelOption {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  active: "启用中",
  disabled: "已停用",
};

function toRoleKey(roleKey: string | undefined | null): RoleKey {
  return roleKey && (ROLE_KEYS as readonly string[]).includes(roleKey)
    ? (roleKey as RoleKey)
    : "developer";
}

interface MemberFormState {
  name: string;
  roleId: string;
  agentId: string;
  defaultModelId: string;
  preferredWorkerId: string;
  privateWorkDir: string;
  description: string;
  /** 成员性格 key；"" = 未配置（提交时转 null）。 */
  persona: string;
  /** 成员专属提示词（成员级特殊行为描述）。 */
  prompt: string;
  /** 成员提示词组合方式：append=追加在 Agent 提示词之后 / override=覆盖 Agent 提示词。 */
  promptMode: MemberPromptMode;
}

const EMPTY_FORM: MemberFormState = {
  name: "",
  roleId: "",
  agentId: "",
  defaultModelId: "",
  preferredWorkerId: "",
  privateWorkDir: "",
  description: "",
  persona: "",
  prompt: "",
  promptMode: "append",
};

export default function MembersPage() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const perms = user?.permissions;
  const canCreate = hasPermission(perms, "members", "create");
  const canEdit = hasPermission(perms, "members", "edit");
  const canDelete = hasPermission(perms, "members", "delete");
  const queryClient = useQueryClient();

  const [keyword, setKeyword] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "" | "active" | "disabled"
  >("");
  const [editing, setEditing] = useState<MemberDto | "new" | null>(null);
  const [form, setForm] = useState<MemberFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<MemberDto | null>(null);
  /** 成员仍在群聊 → 二次确认「连带移出这些群聊后删除」。 */
  const [cascadeTarget, setCascadeTarget] = useState<{
    member: MemberDto;
    teams: Array<{ id: string; name: string | null }>;
  } | null>(null);
  const [resetTarget, setResetTarget] = useState<MemberDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const membersQuery = useQuery({
    queryKey: ["members", { keyword, roleFilter, statusFilter, page }],
    queryFn: () =>
      membersApi.list({
        keyword: keyword.trim() || undefined,
        roleId: roleFilter || undefined,
        status: statusFilter || undefined,
        page,
        pageSize,
      }),
    enabled: !!user?.id,
  });

  const rolesQuery = useQuery({
    queryKey: ["agent-roles", "members-page"],
    queryFn: () => agentRolesApi.list({ page: 1, pageSize: 100 }),
    enabled: !!user?.id,
  });

  const notificationChannelsQuery = useQuery({
    queryKey: ["notification-channels", "members-page"],
    queryFn: () =>
      api.get<NotificationChannelOption[] | { items: NotificationChannelOption[] }>(
        "/notification-channels",
      ),
    enabled: !!user?.id && !!editing && editing !== "new",
  });

  const editingMemberId = editing && editing !== "new" ? editing.id : "";
  const memberDetailQuery = useQuery({
    queryKey: ["member", editingMemberId],
    queryFn: () => membersApi.get(editingMemberId),
    enabled: !!user?.id && !!editingMemberId,
  });

  useEffect(() => {
    const detail = memberDetailQuery.data;
    if (detail) {
      setChannelIds(
        (detail.notificationChannels ?? []).map((channel) => channel.id),
      );
    }
  }, [memberDetailQuery.data]);

  const notificationChannels = (Array.isArray(notificationChannelsQuery.data)
    ? notificationChannelsQuery.data
    : notificationChannelsQuery.data?.items) ?? [];

  const agentsQuery = useQuery({
    queryKey: ["agents", "members-page"],
    queryFn: () =>
      api.get<{ items: AgentOption[] }>("/agents", {
        query: { page: 1, pageSize: 100 },
      }),
    enabled: !!user?.id,
  });

  const roleOptions = useMemo<AgentRoleDto[]>(
    () => rolesQuery.data?.items ?? [],
    [rolesQuery.data],
  );
  const agents: AgentOption[] = agentsQuery.data?.items ?? [];
  const modelsQuery = useQuery({
    queryKey: ["models", "members-page"],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string; providerID: string; modelID?: string }> }>(
        "/models",
        { query: { page: 1, pageSize: 200, available: 1 } },
      ),
    enabled: !!user?.id,
  });
  const workersQuery = useQuery({
    queryKey: ["workers", "members-page"],
    queryFn: () =>
      api.get<Array<{ id: string; name: string | null; status: string }>>(
        "/workers",
      ),
    enabled: !!user?.id,
  });
  const modelOptions = modelsQuery.data?.items ?? [];
  const workerOptions = workersQuery.data ?? [];

  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(null), 4000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [notice]);

  const openCreate = () => {
    const firstRole = roleOptions[0];
    setForm({
      ...EMPTY_FORM,
      roleId: firstRole?.id ?? "",
      agentId: firstRole?.defaultAgentId ?? "",
    });
    setFormError(null);
    setEditing("new");
  };

  // 从建群页「＋ 新建成员」跳转而来（/members?new=1）：角色候选就绪后自动打开新建弹窗。
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("new") !== "1") return;
    if (roleOptions.length === 0) return;
    autoOpenedRef.current = true;
    const firstRole = roleOptions[0];
    setForm({
      ...EMPTY_FORM,
      roleId: firstRole?.id ?? "",
      agentId: firstRole?.defaultAgentId ?? "",
    });
    setFormError(null);
    setEditing("new");
    window.history.replaceState(null, "", "/members");
  }, [roleOptions]);

  const openEdit = (member: MemberDto) => {
    setForm({
      name: member.name,
      roleId: member.defaultRoleId,
      agentId: member.agentId,
      defaultModelId: member.defaultModelId ?? "",
      preferredWorkerId: member.preferredWorkerId ?? "",
      privateWorkDir: member.privateWorkDir ?? "",
      description: member.description ?? "",
      persona: member.persona ?? "",
      prompt: member.prompt ?? "",
      promptMode: member.promptMode ?? "append",
    });
    setFormError(null);
    setEditing(member);
  };

  const closeForm = () => {
    setEditing(null);
    setFormError(null);
    setChannelIds([]);
  };

  const createMutation = useMutation({
    mutationFn: (payload: CreateMemberPayload) => membersApi.create(payload),
    onSuccess: (member) => {
      queryClient.invalidateQueries({ queryKey: ["members"] });
      setNotice(`已创建成员「${member.name}」`);
      closeForm();
    },
    onError: (err) => setFormError(errorText(err)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateMemberPayload }) =>
      membersApi.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members"] });
    },
    onError: (err) => setFormError(errorText(err)),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ member, status }: { member: MemberDto; status: "active" | "disabled" }) =>
      membersApi.update(member.id, { status }),
    onSuccess: (member) => {
      queryClient.invalidateQueries({ queryKey: ["members"] });
      setNotice(`已${member.status === "disabled" ? "停用" : "恢复"}成员「${member.name}」`);
    },
    onError: (err) => setNotice(errorText(err)),
  });

  const resetSessionMutation = useMutation({
    mutationFn: (member: MemberDto) => membersApi.resetSession(member.id),
    onSuccess: (result, member) => {
      queryClient.invalidateQueries({ queryKey: ["members"] });
      setNotice(
        result.reset > 0
          ? `已重置成员「${member.name}」的全局会话`
          : `成员「${member.name}」尚未建立会话`,
      );
      setResetTarget(null);
    },
    onError: (err) => {
      setNotice(errorText(err));
      setResetTarget(null);
    },
  });

  /**
   * 删除成员（产品确认 2026-11-10：允许级联）。
   * 默认不带 cascadeSeats；若成员仍在群聊里，服务端回 409 `MEMBER_IN_USE`
   * （details.teams 列出所在群聊），此时改用「连带移出群聊」的二次确认，
   * 用户确认后带 cascadeSeats=true 重放——服务端在同一事务里先移出席位再删成员。
   */
  const deleteMutation = useMutation({
    mutationFn: ({ member, cascadeSeats }: { member: MemberDto; cascadeSeats?: boolean }) =>
      membersApi.remove(member.id, { cascadeSeats }),
    onSuccess: (res, { member }) => {
      queryClient.invalidateQueries({ queryKey: ["members"] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      const seats = res.removedSeats?.length ?? 0;
      setNotice(
        seats > 0
          ? `已删除成员「${member.name}」，并移出 ${seats} 个群聊`
          : `已删除成员「${member.name}」`,
      );
      setDeleteTarget(null);
      setCascadeTarget(null);
    },
    onError: (err, { member }) => {
      // 仍在群聊 → 转成「连带移出群聊」的二次确认，而不是把 409 当失败报给用户
      if (isApiError(err) && err.code === "MEMBER_IN_USE") {
        const details = err.details as
          | { teams?: Array<{ id: string; name: string | null }> }
          | undefined;
        setCascadeTarget({ member, teams: details?.teams ?? [] });
        setDeleteTarget(null);
        return;
      }
      setNotice(errorText(err));
      setDeleteTarget(null);
      setCascadeTarget(null);
    },
  });

  const submitForm = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const name = form.name.trim();
    if (!form.roleId) {
      setFormError("请选择默认岗位");
      return;
    }
    if (editing === "new") {
      createMutation.mutate({
        ...(name ? { name } : {}),
        roleId: form.roleId,
        agentId: form.agentId || undefined,
        defaultModelId: form.defaultModelId || undefined,
        preferredWorkerId: form.preferredWorkerId || undefined,
        privateWorkDir: form.privateWorkDir.trim() || undefined,
        description: form.description.trim() || undefined,
        persona: form.persona || null,
        prompt: form.prompt.trim() || null,
        promptMode: form.promptMode,
      });
      return;
    }
    if (editing) {
      try {
        await updateMutation.mutateAsync({
          id: editing.id,
          payload: {
            name,
            roleId: form.roleId,
            agentId: form.agentId || undefined,
            defaultModelId: form.defaultModelId || undefined,
            preferredWorkerId: form.preferredWorkerId || undefined,
            privateWorkDir: form.privateWorkDir.trim() || undefined,
            description: form.description.trim() || undefined,
            persona: form.persona || null,
            prompt: form.prompt.trim() || null,
            promptMode: form.promptMode,
          },
        });
        try {
          await membersApi.bindNotificationChannels(editing.id, {
            notificationChannelIds: channelIds,
          });
        } catch (err) {
          // 渠道已被其他团队/成员占用 → 询问是否转移归属
          if (isApiError(err) && err.code === "CHANNEL_ALREADY_BOUND") {
            const transfer = window.confirm(
              "部分通知渠道已被其他团队或成员占用，是否转移归属到该成员？",
            );
            if (transfer) {
              await membersApi.bindNotificationChannels(editing.id, {
                notificationChannelIds: channelIds,
                replaceExisting: true,
              });
            }
          } else {
            throw err;
          }
        }
        queryClient.invalidateQueries({ queryKey: ["members"] });
        setNotice(`已保存成员「${name}」`);
        closeForm();
      } catch (err) {
        setFormError(errorText(err));
      }
    }
  };

  const items = membersQuery.data?.items ?? [];
  const total = membersQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeCount = items.filter((m) => m.status === "active").length;
  const groupLinked = items.filter((m) => m.groupCount > 0).length;
  const runningCount = items.filter(
    (m) => m.session?.busyState === "running",
  ).length;

  return (
    <PageWindow maxWidth={1200} gap={space.md} style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: radius.md, backgroundColor: neutral[100], border: `1px solid ${neutral[200]}` }}>
          <button type="button" data-testid="unified-tab-teams" onClick={() => router.push("/teams")} style={{ padding: "5px 16px", border: "none", borderRadius: radius.sm, backgroundColor: "transparent", color: neutral[500], fontSize: fontSize.sm, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}>团队</button>
          <button type="button" data-testid="unified-tab-members" style={{ padding: "5px 16px", border: "none", borderRadius: radius.sm, backgroundColor: "var(--color-surface)", color: "#0F766E", fontSize: fontSize.sm, fontWeight: 700, cursor: "pointer", fontFamily: fontFamily.body, boxShadow: shadow.sm }}>成员</button>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: space.md }}>
        <div>
          <div style={{ fontSize: fontSize.xl, fontWeight: 700, color: neutral[900] }}>成员库</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[500], marginTop: 4 }}>
            平台级成员：先建人、再建群；一个成员可加入多个群聊，随群切换时配置仍共享
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          {canCreate && (
            <button type="button" data-testid="create-member-button" onClick={openCreate} style={primaryButtonStyle}>
              ＋ 新建成员
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: space.md }}>
        <StatCard label="成员总数" value={total} hint="平台成员库" />
        <StatCard label="当前页启用" value={activeCount} hint={`共 ${items.length} 条`} />
        <StatCard label="已加入群聊" value={groupLinked} hint="当前页统计" />
        <StatCard label="处理中" value={runningCount} hint={`当前页 · ${activeCount} 位启用`} />
      </div>

      {notice && (
        <div data-testid="members-notice" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: "rgba(13,148,136,0.10)", border: "1px solid rgba(13,148,136,0.30)", color: "#0F766E", fontSize: fontSize.sm }}>
          {notice}
        </div>
      )}

      <div style={{ display: "flex", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
        <input
          data-testid="members-search"
          value={keyword}
          onChange={(event) => { setKeyword(event.target.value); setPage(1); }}
          placeholder="搜索成员名 / Agent"
          style={{ ...inputStyle, width: 260 }}
        />
        <select
          value={roleFilter}
          onChange={(event) => { setRoleFilter(event.target.value); setPage(1); }}
          style={{ ...inputStyle, width: 160 }}
        >
          <option value="">全部岗位</option>
          {roleOptions.map((role) => (
            <option key={role.id} value={role.id}>{role.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(event) => { setStatusFilter(event.target.value as "" | "active" | "disabled"); setPage(1); }}
          style={{ ...inputStyle, width: 140 }}
        >
          <option value="">全部状态</option>
          <option value="active">启用中</option>
          <option value="disabled">已停用</option>
        </select>
        <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400] }}>共 {total} 位成员</span>
      </div>

      <div style={{ border: `1px solid ${neutral[200]}`, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "var(--color-surface)" }}>
        <div style={{ display: "grid", gridTemplateColumns: GRID_COLUMNS, gap: space.sm, padding: `${space.sm}px ${space.md}px`, backgroundColor: neutral[50], borderBottom: `1px solid ${neutral[200]}`, fontSize: fontSize.xs, color: neutral[500], fontWeight: 600 }}>
          <span>成员</span>
          <span>岗位</span>
          <span>绑定 Agent</span>
          <span>私有工作目录 / 模型</span>
          <span style={{ textAlign: "center" }}>群聊</span>
          <span style={{ textAlign: "center" }}>状态</span>
          <span style={{ textAlign: "right" }}>操作</span>
        </div>
        {membersQuery.isPending ? (
          <div style={{ padding: space.xl, textAlign: "center", color: neutral[400], fontSize: fontSize.sm }}>加载中…</div>
        ) : items.length === 0 ? (
          <EmptyState title="还没有成员" description="先新建成员，再在创建群聊时从成员库中选择" />
        ) : (
          items.map((member) => {
            const roleKey = toRoleKey(member.role?.key);
            const theme = roles[roleKey];
            return (
              <div
                key={member.id}
                data-testid="member-row"
                data-member-id={member.id}
                style={{ display: "grid", gridTemplateColumns: GRID_COLUMNS, gap: space.sm, padding: `${space.sm + 2}px ${space.md}px`, alignItems: "center", borderBottom: `1px solid ${neutral[100]}` }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
                  <AgentAvatar role={roleKey} size="sm" />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.name}</div>
                    <div style={{ fontSize: 10, color: neutral[400], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.id}</div>
                  </div>
                </div>
                <span style={{ fontSize: fontSize.xs, color: theme.color, backgroundColor: theme.bg, border: `1px solid ${theme.border}`, padding: "1px 6px", borderRadius: radius.pill, justifySelf: "start" }}>
                  {member.role?.name ?? "未绑岗位"}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: fontSize.xs, color: neutral[700], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member.agent?.name ?? member.agentId}</div>
                  <div style={{ fontSize: 10, color: neutral[400], fontFamily: fontFamily.mono }}>{member.agent?.agentKey ?? ""}</div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div title={member.privateWorkDir ?? ""} style={{ fontSize: fontSize.xs, color: member.privateWorkDir ? neutral[700] : neutral[400], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {member.privateWorkDir ?? "默认目录（未设置）"}
                  </div>
                  <div style={{ fontSize: 10, color: neutral[400] }}>{member.defaultModel?.name ?? "默认模型未指定"}</div>
                </div>
                <span style={{ textAlign: "center", fontSize: fontSize.sm, color: member.groupCount > 0 ? "#0F766E" : neutral[400] }}>{member.groupCount}</span>
                <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
                  <span style={{ fontSize: fontSize.xs, color: member.status === "active" ? "#0F766E" : neutral[400] }}>
                    {STATUS_LABEL[member.status] ?? member.status}
                  </span>
                  <span
                    data-testid="member-session-state"
                    style={{
                      fontSize: 10,
                      color:
                        member.session?.busyState === "running"
                          ? "#B45309"
                          : member.session
                            ? neutral[400]
                            : neutral[300],
                    }}
                  >
                    {member.session
                      ? member.session.busyState === "running"
                        ? "● 处理中"
                        : "○ 空闲"
                      : "未建会话"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                  {canEdit && (
                    <button type="button" onClick={() => openEdit(member)} style={linkButtonStyle}>编辑</button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => toggleMutation.mutate({ member, status: member.status === "active" ? "disabled" : "active" })}
                      style={linkButtonStyle}
                    >
                      {member.status === "active" ? "停用" : "恢复"}
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" onClick={() => setResetTarget(member)} style={linkButtonStyle}>重置会话</button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      data-testid="member-delete"
                      onClick={() => setDeleteTarget(member)}
                      title={
                        member.groupCount > 0
                          ? `该成员在 ${member.groupCount} 个群聊中，删除时会一并移出`
                          : "删除成员"
                      }
                      style={{ ...linkButtonStyle, color: "#B91C1C" }}
                    >
                      删除
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, alignItems: "center" }}>
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} style={pagerStyle(page <= 1)}>上一页</button>
          <span style={{ fontSize: fontSize.xs, color: neutral[500] }}>{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} style={pagerStyle(page >= totalPages)}>下一页</button>
        </div>
      )}

      {editing && (
        // 编辑抽屉（右侧栏）：
        // fixed 钉住视口（top 让开顶栏），不随成员列表滚动而上下漂移 —— 之前用 absolute
        // 挂在可滚动的 page-window 上，列表滚到中段时抽屉会被顶栏裁掉上半截、底部悬空，
        // 看起来像"侧栏和页面高度不一致"。fixed 后抽屉恒定占满内容区高度，内部表单自行滚动。
        <div
          data-testid="member-edit-overlay"
          style={{
            position: "fixed",
            top: NAV_TOPBAR_HEIGHT,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: "rgba(15,23,42,0.32)",
            display: "flex",
            justifyContent: "flex-end",
            zIndex: 40,
          }}
        >
          <form
            data-testid="member-edit-drawer"
            onSubmit={submitForm}
            style={{ width: "min(560px, 100%)", height: "100%", display: "flex", flexDirection: "column", backgroundColor: "var(--color-surface)", borderLeft: `1px solid ${neutral[100]}`, boxShadow: shadow.lg }}
          >
            <div style={{ flexShrink: 0, padding: `${space.lg}px ${space.xl}px ${space.md}px`, borderBottom: `1px solid ${neutral[100]}` }}>
              <div style={{ display: "flex", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: fontSize.lg, fontWeight: 700, color: neutral[900] }}>{editing === "new" ? "新建成员" : "编辑成员"}</div>
                  <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: 4, lineHeight: 1.6 }}>成员属于平台，创建后可在任意群聊中被勾选；一个成员可加入多个群聊。</div>
                </div>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={closeForm} style={{ border: "none", background: "none", fontSize: 20, lineHeight: 1, color: neutral[400], cursor: "pointer" }}>×</button>
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: space.xl, display: "flex", flexDirection: "column", gap: space.lg }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>成员名称 <span style={{ color: "#DC2626" }}>必填</span></span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="留空自动生成，例如：胡一开" style={inputStyle} />
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>角色 / 岗位</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: -4 }}>决定头像色与默认 Agent 策略</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {roleOptions.filter((role) => role.type === "builtin").map((role) => {
                    const active = form.roleId === role.id;
                    return (
                      <button
                        key={role.id}
                        type="button"
                        data-testid="member-role-chip"
                        onClick={() => setForm({ ...form, roleId: role.id })}
                        style={{ padding: "5px 12px", borderRadius: radius.pill, border: `1px solid ${active ? "#0D9488" : neutral[200]}`, backgroundColor: active ? "rgba(13,148,136,0.10)" : "var(--color-surface)", color: active ? "#0F766E" : neutral[600], fontSize: fontSize.xs, fontWeight: active ? 700 : 500, cursor: "pointer", fontFamily: fontFamily.body }}
                      >
                        {role.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 性格配置（成员级：同一岗位的不同成员可有不同表达/协作风格） */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>性格配置</span>
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>影响该成员表达与协作风格（成员级，优先于 Agent 配置）</span>
                <select
                  data-testid="member-persona-select"
                  value={form.persona}
                  onChange={(e) => setForm({ ...form, persona: e.target.value })}
                  style={{ ...inputStyle, cursor: "pointer" }}
                >
                  {PERSONA_OPTIONS.map((option) => (
                    <option key={option.key ?? ""} value={option.key ?? ""}>{option.label}</option>
                  ))}
                </select>
                {form.persona && (
                  <div
                    data-testid="member-persona-preview"
                    style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6, padding: `${space.sm}px ${space.md}px`, backgroundColor: neutral[50], borderRadius: radius.sm, border: `1px solid ${neutral[100]}` }}
                  >
                    {personaPreview(form.persona)}
                  </div>
                )}
              </div>

              {/* 提示词配置（成员专属行为要求；Agent 提示词=岗位职责范围） */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>提示词配置</span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>成员级 · 与 Agent 岗位职责组合生效</span>
                </div>
                <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: radius.md, backgroundColor: neutral[100], border: `1px solid ${neutral[200]}` }}>
                  {([
                    { mode: "append", label: "追加在 Agent 提示词之后" },
                    { mode: "override", label: "覆盖 Agent 提示词" },
                  ] as const).map((item) => {
                    const active = form.promptMode === item.mode;
                    return (
                      <button
                        key={item.mode}
                        type="button"
                        data-testid={`member-prompt-mode-${item.mode}`}
                        aria-pressed={active}
                        onClick={() => setForm({ ...form, promptMode: item.mode })}
                        style={{ flex: 1, padding: "5px 10px", border: "none", borderRadius: radius.sm, backgroundColor: active ? "var(--color-surface)" : "transparent", color: active ? "#0F766E" : neutral[500], fontSize: fontSize.xs, fontWeight: active ? 700 : 500, cursor: "pointer", fontFamily: fontFamily.body, boxShadow: active ? shadow.sm : "none" }}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
                <textarea
                  data-testid="member-prompt-input"
                  rows={5}
                  value={form.prompt}
                  onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                  placeholder="例如：你只负责登录与鉴权模块，接口按 REST 规范输出。"
                  style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
                />
                <span style={{ fontSize: 10, color: neutral[400], lineHeight: 1.7 }}>
                  Agent 提示词描述岗位职责范围；成员提示词用于该成员的特殊行为要求（同岗位多个成员分工不同时使用）。追加=在岗位职责后补充；覆盖=用成员提示词替代 Agent 提示词（岗位职责【岗位职责】不受影响）。
                  <br />
                  提示词在建立会话时注入并锁定：保存后需在下方「全局会话」处重置该成员会话，才对下一轮生效。
                </span>
              </div>

              {editing !== "new" && (
                <div style={{ padding: space.md, borderRadius: radius.lg, border: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: fontSize.sm, fontWeight: 700, color: neutral[800] }}>全局会话</span>
                    <span style={{ fontSize: 10, color: neutral[400] }}>成员唯一 · 跨群共享上下文</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 72px 1fr", gap: "6px 8px", fontSize: fontSize.xs }}>
                    <span style={{ color: neutral[400] }}>会话 ID</span>
                    <span style={{ color: neutral[700], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{memberDetailQuery.data?.session?.id ?? "—"}</span>
                    <span style={{ color: neutral[400] }}>状态</span>
                    <span style={{ color: memberDetailQuery.data?.session?.busyState === "running" ? "#B45309" : "#0F766E" }}>
                      {memberDetailQuery.data?.session ? (memberDetailQuery.data.session.busyState === "running" ? "处理中" : "空闲") : "未建立"}
                    </span>
                    <span style={{ color: neutral[400] }}>上下文</span>
                    <span style={{ color: neutral[700] }}>{memberDetailQuery.data?.session ? `${memberDetailQuery.data.session.turnSeq} 轮` : "—"}</span>
                    <span style={{ color: neutral[400] }}>最近活跃</span>
                    <span style={{ color: neutral[700] }}>
                      {memberDetailQuery.data?.groups?.find(
                        (g) => g.teamId === memberDetailQuery.data?.session?.currentTeamId,
                      )?.teamName ?? memberDetailQuery.data?.groups?.[0]?.teamName ?? "—"}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: neutral[400], lineHeight: 1.6 }}>会话全局唯一：不随群聊变化，重置会清空该成员所有群聊的上下文。</div>
                  <button
                    type="button"
                    disabled={resetSessionMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`确认重置成员「${editing.name}」的全局会话？消息/记忆不受影响。`)) resetSessionMutation.mutate(editing);
                    }}
                    style={{ alignSelf: "flex-start", padding: "4px 12px", borderRadius: radius.md, border: "1px solid rgba(220,38,38,0.45)", backgroundColor: "var(--color-surface)", color: "#DC2626", fontSize: fontSize.xs, fontWeight: 600, cursor: "pointer", fontFamily: fontFamily.body }}
                  >
                    {resetSessionMutation.isPending ? "重置中…" : "重置全局会话"}
                  </button>
                </div>
              )}

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>执行 Agent</span>
                <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })} style={inputStyle}>
                  <option value="">跟随岗位默认 Agent</option>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{agent.agentKey ? ` · ${agent.agentKey}` : ""}</option>)}
                </select>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>默认模型</span>
                  <SearchableSelect
                    testId="member-edit-model-select"
                    value={form.defaultModelId}
                    onChange={(value) => setForm({ ...form, defaultModelId: value })}
                    placeholder="跟随 Agent / Worker"
                    searchPlaceholder="搜索模型 / provider"
                    options={[
                      { value: "", label: "跟随 Agent / Worker" },
                      ...modelOptions.map((m) => ({
                        value: m.id,
                        label: `${m.providerID} · ${m.name}`,
                        keywords: `${m.providerID} ${m.name}`,
                      })),
                    ]}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>首选 Worker</span>
                  <select value={form.preferredWorkerId} onChange={(e) => setForm({ ...form, preferredWorkerId: e.target.value })} style={inputStyle}>
                    <option value="">自动调度</option>
                    {workerOptions.map((w) => <option key={w.id} value={w.id}>{w.name ?? w.id}{w.status !== "online" ? "（离线）" : ""}</option>)}
                  </select>
                </label>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>私有工作目录</span>
                <input value={form.privateWorkDir} onChange={(e) => setForm({ ...form, privateWorkDir: e.target.value })} placeholder="~/work/<成员名>" style={{ ...inputStyle, fontFamily: fontFamily.mono }} />
                <span style={{ fontSize: 10, color: neutral[400] }}>默认工作目录（会话默认 cwd）：个人工作台。</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>团队工作目录 <span style={{ fontSize: 10, color: neutral[400], fontWeight: 400 }}>可选 / 可切换（需授权）</span></span>
                <input
                  value={
                    memberDetailQuery.data?.groups?.find(
                      (g) => g.teamId === memberDetailQuery.data?.session?.currentTeamId,
                    )?.workDir ??
                    memberDetailQuery.data?.groups?.[0]?.workDir ??
                    ""
                  }
                  readOnly
                  disabled
                  placeholder="由群聊席位决定"
                  style={{ ...inputStyle, fontFamily: fontFamily.mono, backgroundColor: neutral[50], color: neutral[500] }}
                />
                <span style={{ fontSize: 10, color: neutral[400] }}>仅可切换目标；模型按需切换，服务端按本轮席位授权后生效。</span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>备注 <span style={{ fontSize: 10, color: neutral[400], fontWeight: 400 }}>可选</span></span>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
              </div>

              {editing !== "new" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>通知渠道 <span style={{ fontSize: 10, color: neutral[400], fontWeight: 400 }}>可选</span></span>
                  {notificationChannelsQuery.isPending ? (
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>渠道加载中…</span>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 150, overflow: "auto", border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: space.sm }}>
                      {notificationChannels.length === 0 && (
                        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无通知渠道</span>
                      )}
                      {notificationChannels.map((channel) => (
                        <label key={channel.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: fontSize.xs, color: channel.enabled ? neutral[700] : neutral[400] }}>
                          <input type="checkbox" checked={channelIds.includes(channel.id)} onChange={(e) => setChannelIds((prev) => e.target.checked ? [...prev, channel.id] : prev.filter((id) => id !== channel.id))} />
                          {channel.name}
                          <span style={{ color: neutral[400] }}>({channel.type})</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <span style={{ fontSize: 10, color: neutral[400] }}>一个渠道只能归属一个团队或成员。</span>
                </div>
              )}

              {formError && <div style={{ fontSize: fontSize.xs, color: "#B91C1C" }}>{formError}</div>}
            </div>

            <div style={{ flexShrink: 0, padding: `${space.md}px ${space.xl}px`, borderTop: `1px solid ${neutral[100]}`, display: "flex", alignItems: "center", gap: space.sm }}>
              <span style={{ fontSize: 10, color: neutral[400] }}>{editing === "new" ? "创建后不会自动加入任何群聊，需在群聊中勾选" : "修改配置对所有已加入的群聊生效"}</span>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={closeForm} style={secondaryButtonStyle}>取消</button>
              <button type="submit" disabled={createMutation.isPending || updateMutation.isPending} style={primaryButtonStyle}>{createMutation.isPending || updateMutation.isPending ? "保存中…" : "保存修改"}</button>
            </div>
          </form>
        </div>
      )}

      {resetTarget && (
        <ConfirmDialog
          open
          onClose={() => setResetTarget(null)}
          onConfirm={() => resetSessionMutation.mutate(resetTarget)}
          title="重置全局会话"
          description={`确认重置成员「${resetTarget.name}」的全局会话？下一轮会开新引擎会话；聊天消息与记忆不受影响。`}
          confirmLabel="重置"
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          open
          testid="member-delete-confirm"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => deleteMutation.mutate({ member: deleteTarget })}
          title="删除成员"
          description={`确认删除成员「${deleteTarget.name}」？${deleteTarget.groupCount > 0 ? `该成员在 ${deleteTarget.groupCount} 个群聊中，删除时会一并移出。` : "该成员当前未加入任何群聊。"}此操作不可恢复。`}
          confirmLabel="删除"
          submitting={deleteMutation.isPending}
        />
      )}

      {/* 成员仍在群聊 → 二次确认连带移出全部席位后删除 */}
      {cascadeTarget && (
        <ConfirmDialog
          open
          testid="member-cascade-delete-confirm"
          onClose={() => setCascadeTarget(null)}
          onConfirm={() =>
            deleteMutation.mutate({ member: cascadeTarget.member, cascadeSeats: true })
          }
          title="成员仍在群聊中"
          description={(() => {
            const names = cascadeTarget.teams
              .map((t) => t.name ?? t.id)
              .slice(0, 5)
              .join("、");
            const more = cascadeTarget.teams.length > 5 ? "…" : "";
            const seatPart = cascadeTarget.teams.length > 0
              ? `将同时移出以下 ${cascadeTarget.teams.length} 个群聊：${names}${more}。`
              : `将同时移出该成员所在的 ${cascadeTarget.member.groupCount} 个群聊。`;
            return `成员「${cascadeTarget.member.name}」仍在群聊中。${seatPart}该成员的群内消息与会话历史会保留，但不再归属该成员。确认删除？`;
          })()}
          confirmLabel="移出并删除"
          pendingLabel="删除中…"
          submitting={deleteMutation.isPending}
        />
      )}
    </PageWindow>
  );
}

const GRID_COLUMNS = "minmax(180px,2.2fr) minmax(90px,1fr) minmax(120px,1.2fr) minmax(160px,1.6fr) 52px 76px minmax(120px,1.2fr)";

const inputStyle: CSSProperties = {
  width: "100%",
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  fontSize: fontSize.sm,
  color: neutral[800],
  fontFamily: fontFamily.body,
  outline: "none",
};

const primaryButtonStyle: CSSProperties = {
  padding: `${space.sm + 1}px ${space.lg}px`,
  borderRadius: radius.md,
  border: "none",
  backgroundColor: "#0D9488",
  color: "#FFF",
  fontSize: fontSize.sm,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: fontFamily.body,
};

const secondaryButtonStyle: CSSProperties = {
  padding: `${space.sm + 1}px ${space.lg}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[700],
  fontSize: fontSize.sm,
  cursor: "pointer",
  fontFamily: fontFamily.body,
};

const linkButtonStyle: CSSProperties = {
  border: "none",
  background: "none",
  padding: 0,
  color: "#0F766E",
  fontSize: fontSize.xs,
  cursor: "pointer",
  fontFamily: fontFamily.body,
};

function pagerStyle(disabled: boolean): CSSProperties {
  return {
    padding: `4px 10px`,
    borderRadius: radius.sm,
    border: `1px solid ${neutral[200]}`,
    backgroundColor: disabled ? neutral[50] : "var(--color-surface)",
    color: disabled ? neutral[300] : neutral[700],
    fontSize: fontSize.xs,
    cursor: disabled ? "default" : "pointer",
    fontFamily: fontFamily.body,
  };
}

function StatCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.lg, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)" }}>
      <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: neutral[900], marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 10, color: neutral[400], marginTop: 2 }}>{hint}</div>
    </div>
  );
}


function errorText(err: unknown): string {
  if (isApiError(err)) return err.message;
  return err instanceof Error ? err.message : "操作失败";
}
