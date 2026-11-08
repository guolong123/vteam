"use client";

/**
 * 会话页 /chat（微信式布局，P2 前端骨架）
 * =============================================
 * - 左侧：GET /conversations 聚合列表（群聊 + 成员平铺、类型徽章、未读、置顶排序由服务端给出）。
 * - 中间：消息区。群聊显示群头 + 成员切换条（当前仅高亮，不做过滤）；私聊显示成员头。
 * - 右侧：群聊显示群信息/成员；私聊显示成员信息（GET /members/:id）。
 * - 消息：复用既有 ChatBubble / MsgParts / SystemMarker；历史用 /channels/:id/messages，
 *   发送用 /channels/:id/messages（POST）。SSE 订阅与未读清零（PATCH /channels/:id/read）
 *   留到下一步接入，当前 5s 轮询兜底。
 * - 路由：/chat?c=group:<teamId> | dm:<memberId>；URL 驱动选中态，可刷新/分享。
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRealtimeEvents } from "@/hooks/use-realtime";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentAvatar, ChatBubble, SearchableSelect } from "@/src/components/ui";
import { MsgParts } from "@/src/components/chat";
import {
  conversationsApi,
  type ConversationItemDto,
} from "@/src/api/conversations";
import { membersApi, type MemberDetailDto, type MemberDto } from "@/src/api/members";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import { agentRolesApi } from "@/src/api/agent-roles";
import { stripInjectedContext } from "@/lib/strip-injected-context";
import { TeamSessionView } from "@/src/features/team-session/TeamSessionView";
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

interface ChatMessage {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string | null;
  senderInstanceId?: string | null;
  content: { text?: string; parts?: unknown[] } | string | null;
  status?: string;
  createdAt: string;
}

function toRoleKey(key: string | null | undefined): RoleKey {
  return key && (ROLE_KEYS as readonly string[]).includes(key)
    ? (key as RoleKey)
    : "developer";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function ChatPageContent() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get("c") ?? "";
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [showDmPicker, setShowDmPicker] = useState(false);
  const [dmSearch, setDmSearch] = useState("");
  const [search, setSearch] = useState("");
  const [convFilter, setConvFilter] = useState<"all" | "group" | "dm">("all");
  const [filterMemberId, setFilterMemberId] = useState<string | null>(null);
  /** 右栏视图：full = 旧完整任务面板（默认，保留全部既有功能）；compact = 原型三 Tab。 */
  const [rightPanelMode, setRightPanelMode] = useState<"full" | "compact">("full");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [showMembersDrawer, setShowMembersDrawer] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const conversationsQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: () => conversationsApi.list(),
    enabled: !!user?.id,
    refetchInterval: 5000,
  });
  const items = useMemo(
    () => conversationsQuery.data?.items ?? [],
    [conversationsQuery.data],
  );

  // 无选中会话时自动落到第一条（仅替换 URL，不新增历史栈）。
  useEffect(() => {
    if (!selected && items.length > 0) {
      router.replace(`/chat?c=${encodeURIComponent(items[0].id)}`);
    }
  }, [items, selected, router]);

  const active =
    items.find((item) => item.id === selected) ?? items[0] ?? null;
  const isGroup = active?.type === "group";
  const teamId = isGroup ? active?.id.replace("group:", "") ?? "" : "";
  const memberId = !isGroup ? active?.id.replace("dm:", "") ?? "" : "";

  const teamQuery = useQuery({
    queryKey: ["team", teamId],
    queryFn: () => teamsApi.get(teamId),
    enabled: !!user?.id && isGroup && !!teamId,
  });
  const memberQuery = useQuery({
    queryKey: ["member", memberId],
    queryFn: () => membersApi.get(memberId),
    enabled: !!user?.id && !isGroup && !!memberId,
  });

  const channelId = active?.channelId ?? null;
  const messagesQuery = useQuery({
    // 群聊按频道；私聊按成员跨群聚合（P4：一个成员一个 DM，历史消息不搬家）。
    queryKey: isGroup
      ? ["channel", channelId, "messages"]
      : ["member-messages", memberId],
    queryFn: () =>
      isGroup
        ? api.get<{ items: ChatMessage[] }>(`/channels/${channelId}/messages`, {
            query: { limit: 50 },
          })
        : api.get<{ items: ChatMessage[] }>(`/members/${memberId}/messages`, {
            query: { limit: 50 },
          }),
    enabled: !!user?.id && (isGroup ? !!channelId : !!memberId),
    refetchInterval: 5000,
  });
  const messages = messagesQuery.data?.items ?? [];

  const teamTasksQuery = useQuery({
    queryKey: ["team-tasks", teamId, "chat-right"],
    queryFn: () =>
      api.get<{
        items: Array<{ id: string; title: string; status: string }>;
      }>("/tasks", { query: { teamId, page: 1, pageSize: 20 } }),
    enabled: !!user?.id && isGroup && !!teamId,
  });
  const teamTasks = teamTasksQuery.data?.items ?? [];

  // 成员目录：会话头像角色色、成员切换条忙碌态、右侧成员 Tab 共用。
  const directoryQuery = useQuery({
    queryKey: ["members", "directory"],
    queryFn: () => membersApi.list({ page: 1, pageSize: 100 }),
    enabled: !!user?.id,
    // 成员运行状态（黄点）跟随轮询刷新；会话列表本身也 5s 轮询。
    refetchInterval: 5000,
  });
  const directory = useMemo<MemberDto[]>(
    () => directoryQuery.data?.items ?? [],
    [directoryQuery.data],
  );
  const memberById = useMemo(
    () => new Map(directory.map((m) => [m.id, m])),
    [directory],
  );
  const allTeamsQuery = useQuery({
    queryKey: ["teams", "chat-directory"],
    queryFn: () => teamsApi.list({ page: 1, pageSize: 100 }),
    enabled: !!user?.id,
  });
  const teamNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of allTeamsQuery.data?.items ?? []) map.set(t.id, t.name);
    return map;
  }, [allTeamsQuery.data]);

  const rolesQuery = useQuery({
    queryKey: ["agent-roles", "chat"],
    queryFn: () => agentRolesApi.list({ page: 1, pageSize: 100 }),
    enabled: !!user?.id && isGroup,
  });
  const roleKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const role of rolesQuery.data?.items ?? []) map.set(role.id, role.key);
    return map;
  }, [rolesQuery.data]);

  const pickerMembersQuery = useQuery({
    queryKey: ["members", "dm-picker"],
    queryFn: () => membersApi.list({ page: 1, pageSize: 100, status: "active" }),
    enabled: !!user?.id && showDmPicker,
  });
  const pickerMembers = useMemo<MemberDto[]>(
    () => pickerMembersQuery.data?.items ?? [],
    [pickerMembersQuery.data],
  );
  const filteredPickerMembers = useMemo(() => {
    const kw = dmSearch.trim().toLowerCase();
    if (!kw) return pickerMembers;
    return pickerMembers.filter(
      (m) =>
        m.name.toLowerCase().includes(kw) ||
        (m.agent?.name ?? "").toLowerCase().includes(kw),
    );
  }, [pickerMembers, dmSearch]);

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      api.post(`/channels/${channelId}/messages`, { text }),
    onSuccess: () => {
      setInput("");
      setSendError(null);
      queryClient.invalidateQueries(
        isGroup
          ? { queryKey: ["channel", channelId, "messages"] }
          : { queryKey: ["member-messages", memberId] },
      );
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err) => setSendError(errorText(err)),
  });

  const markReadMutation = useMutation({
    // 群聊：频道级已读；私聊：成员私聊一次全部已读（跨群聚合）。
    mutationFn: () =>
      isGroup
        ? api.patch(`/channels/${channelId}/read`)
        : api.patch(`/members/${memberId}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });

  const startDmMutation = useMutation({
    mutationFn: (memberId: string) =>
      api.post<{ id: string; memberId?: string | null }>("/dm-channels", {
        memberId,
      }),
    onSuccess: (_channel, memberId) => {
      setShowDmPicker(false);
      setDmSearch("");
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      router.replace(`/chat?c=${encodeURIComponent(`dm:${memberId}`)}`);
    },
    onError: (err) => setSendError(errorText(err)),
  });

  const dmTeamId = !isGroup
    ? (active?.contextTeamId ?? memberQuery.data?.groups?.[0]?.teamId ?? "")
    : "";
  const dmTeamQuery = useQuery({
    queryKey: ["team", dmTeamId],
    queryFn: () => teamsApi.get(dmTeamId),
    enabled: !!user?.id && !!dmTeamId,
  });
  const dmTeamName = dmTeamQuery.data?.name ?? null;
  const [dmNotice, setDmNotice] = useState<string | null>(null);
  const resetSessionMutation = useMutation({
    mutationFn: () => membersApi.resetSession(memberId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["member", memberId] });
      queryClient.invalidateQueries({ queryKey: ["members"] });
      setDmNotice(
        result.reset > 0
          ? "已重置该成员的全局会话，下一轮将开新引擎会话（消息/记忆保留）"
          : "该成员尚未建立会话",
      );
    },
    onError: (err) => setDmNotice(errorText(err)),
  });

  const resetMemberSessionMutation = useMutation({
    mutationFn: (memberId: string) => membersApi.resetSession(memberId),
    onSuccess: (_r, memberId) => {
      setDmNotice(null);
      queryClient.invalidateQueries({ queryKey: ["members"] });
      queryClient.invalidateQueries({ queryKey: ["member", memberId] });
    },
    onError: (err) => setDmNotice(errorText(err)),
  });

  const createGroupMutation = useMutation({
    mutationFn: () =>
      teamsApi.create({
        name: groupName.trim(),
        members: groupMemberIds.map((id) => ({ memberId: id })),
      }),
    onSuccess: (team) => {
      setShowNewGroup(false);
      setGroupName("");
      setGroupMemberIds([]);
      setGroupError(null);
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["teams"] });
      router.replace(`/chat?c=${encodeURIComponent(`group:${team.id}`)}`);
    },
    onError: (err) => setGroupError(errorText(err)),
  });

  // 打开会话时清零未读（channel 级已读；重复点开幂等）。
  useEffect(() => {
    if (!active || !channelId) return;
    if (active.unreadCount > 0) {
      markReadMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.unreadCount, channelId]);

  // 切换会话时清空「成员过滤」，避免把上一个群的视角带到新会话。
  useEffect(() => {
    setFilterMemberId(null);
  }, [active?.id]);

  // SSE：新消息自动 upsert 到 ["channel", channelId, "messages"]（hook 内建），
  // 这里额外刷新左列表并滚动到底；agent.loading 事件只用来更新占位（下一步细化）。
  useRealtimeEvents({
    scope: channelId ? `channel:${channelId},global` : "global",
    enabled: !!user?.id && !!channelId,
    onMessage: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (active && active.unreadCount >= 0) {
        // 当前会话可见 → 新消息到达即视为已读，避免自己开着还累积未读
        markReadMutation.mutate();
      }
      if (!isGroup && memberId) {
        queryClient.invalidateQueries({
          queryKey: ["member-messages", memberId],
        });
      }
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  });

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, active?.id]);

  const roleBySender = useMemo(() => {
    const map = new Map<string, { name: string; role: RoleKey }>();
    for (const member of teamQuery.data?.members ?? []) {
      const role = toRoleKey(
        member.roleId ? member.member?.defaultRoleId ?? null : null,
      );
      if (member.member?.id) {
        map.set(member.member.id, { name: member.member.name, role });
      }
      map.set(member.id, {
        name: member.member?.name ?? member.alias,
        role,
      });
    }
    return map;
  }, [teamQuery.data]);

  const memberRole = toRoleKey(memberQuery.data?.role?.key ?? null);
  const team = teamQuery.data;
  const member = memberQuery.data;

  const title = active?.title ?? "会话";
  const subtitle =
    active?.type === "group"
      ? `群聊 · ${team?.members.length ?? active?.memberCount ?? 0} 人`
      : member
        ? `${member.role?.name ?? "成员"} · ${member.status === "active" ? "启用中" : "已停用"}`
        : "成员私聊";

  const submit = () => {
    const text = input.trim();
    if (!text || !channelId) return;
    sendMutation.mutate(text);
  };

  const keyword = search.trim().toLowerCase();
  const filteredItems = items.filter((item) => {
    if (convFilter === "group" && item.type !== "group") return false;
    if (convFilter === "dm" && item.type !== "dm") return false;
    if (!keyword) return true;
    return (
      item.title.toLowerCase().includes(keyword) ||
      (item.lastMessage?.text ?? "").toLowerCase().includes(keyword)
    );
  });
  const pinnedItems = filteredItems.filter(
    (item) => item.type === "group" && item.pinned,
  );
  const restItems = filteredItems.filter(
    (item) => !(item.type === "group" && item.pinned),
  );
  const groupCount = items.filter((i) => i.type === "group").length;
  const dmCount = items.filter((i) => i.type === "dm").length;
  const busySeats = (team?.members ?? []).filter(
    (seat) =>
      memberById.get(seat.memberId ?? "")?.session?.busyState === "running",
  );
  const busyTeamName = (memberId: string): string | null => {
    const currentTeamId = memberById.get(memberId)?.session?.currentTeamId ?? null;
    return currentTeamId ? (teamNameById.get(currentTeamId) ?? null) : null;
  };

  return (
    <main style={{ flex: 1, minHeight: 0, display: "flex", position: "relative", backgroundColor: "var(--color-bg, #F8FAFC)" }}>
      {/* 左侧会话列表 */}
      <aside style={{ width: 300, flexShrink: 0, borderRight: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: `${space.lg}px ${space.lg}px ${space.sm}px`, display: "flex", flexDirection: "column", gap: space.sm }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: fontSize.lg, fontWeight: 700, color: neutral[900] }}>会话</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" data-testid="new-group-chat" title="新建群聊" onClick={() => setShowNewGroup(true)} style={{ border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: "#0F766E", borderRadius: radius.sm, padding: "2px 8px", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}>＋ 群聊</button>
              <button type="button" data-testid="new-dm-button" title="发起新私聊" onClick={() => setShowDmPicker(true)} style={{ border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: "#0F766E", borderRadius: radius.sm, padding: "2px 8px", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}>＋ 私聊</button>
            </div>
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            {groupCount} 个群聊 · {dmCount} 位成员
          </div>
          <input
            data-testid="conversation-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索群聊 / 成员"
            style={{ width: "100%", boxSizing: "border-box", padding: `6px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, fontFamily: fontFamily.body, outline: "none", backgroundColor: neutral[50] }}
          />
          <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: radius.md, backgroundColor: neutral[100], border: `1px solid ${neutral[200]}` }}>
            {([
              { key: "all", label: "全部", count: items.length },
              { key: "group", label: "群聊", count: groupCount },
              { key: "dm", label: "成员", count: dmCount },
            ] as const).map((tab) => (
              <button
                key={tab.key}
                type="button"
                data-testid={`conversation-filter-${tab.key}`}
                onClick={() => setConvFilter(tab.key)}
                style={{ flex: 1, padding: "4px 0", border: "none", borderRadius: radius.sm, cursor: "pointer", fontSize: fontSize.xs, fontWeight: 600, fontFamily: fontFamily.body, backgroundColor: convFilter === tab.key ? "var(--color-surface)" : "transparent", color: convFilter === tab.key ? "#0F766E" : neutral[500], boxShadow: convFilter === tab.key ? shadow.sm : undefined }}
              >
                {tab.label} {tab.count}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: `0 8px ${space.md}px` }}>
          {conversationsQuery.isPending ? (
            <div style={{ padding: space.lg, color: neutral[400], fontSize: fontSize.sm }}>加载中…</div>
          ) : filteredItems.length === 0 ? (
            <div style={{ padding: space.lg, color: neutral[400], fontSize: fontSize.sm }}>
              {items.length === 0 ? "还没有会话：先加入一个团队，或在成员库中发起私聊。" : "没有匹配的会话"}
            </div>
          ) : (
            <>
              {pinnedItems.length > 0 && (
                <>
                  <div style={{ padding: `${space.sm}px ${space.sm}px 4px`, fontSize: 10, color: neutral[400], fontWeight: 600 }}>置顶</div>
                  {pinnedItems.map((item) => (
                    <ConversationRow
                      key={item.id}
                      item={item}
                      active={active?.id === item.id}
                      roleKey={conversationRole(item, memberById)}
                      busy={item.type === "dm" && memberById.get(item.id.replace("dm:", ""))?.session?.busyState === "running"}
                      onClick={() => { setSendError(null); router.replace(`/chat?c=${encodeURIComponent(item.id)}`); }}
                    />
                  ))}
                </>
              )}
              <div style={{ padding: `${space.sm}px ${space.sm}px 4px`, fontSize: 10, color: neutral[400], fontWeight: 600 }}>{pinnedItems.length > 0 ? "全部会话" : "会话"}</div>
              {restItems.map((item) => (
                <ConversationRow
                  key={item.id}
                  item={item}
                  active={active?.id === item.id}
                  roleKey={conversationRole(item, memberById)}
                  onClick={() => { setSendError(null); router.replace(`/chat?c=${encodeURIComponent(item.id)}`); }}
                />
              ))}
            </>
          )}
        </div>
      </aside>

      {isGroup && teamId ? (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <header style={{ padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", display: "flex", alignItems: "center", gap: space.sm }}>
              <AgentAvatar role="product" size="md" shape="square" dot={false} initials={title.slice(0, 1)} style={groupAvatarPalette(title)} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
                  {(() => {
                    const running = teamTasks.find(
                      (t) => t.status === "in_progress" || t.status === "blocked",
                    );
                    if (!running) return null;
                    return (
                      <span style={{ fontSize: 10, fontWeight: 700, color: running.status === "blocked" ? "#B91C1C" : "#0F766E", backgroundColor: running.status === "blocked" ? "rgba(239,68,68,0.10)" : "rgba(13,148,136,0.10)", border: `1px solid ${running.status === "blocked" ? "rgba(239,68,68,0.25)" : "rgba(13,148,136,0.22)"}`, borderRadius: radius.pill, padding: "1px 8px" }}>
                        {running.status === "blocked" ? "阻塞中" : "进行中"}
                      </span>
                    );
                  })()}
                </div>
                <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>群聊 · {team?.members.length ?? active?.memberCount ?? 0} 个成员 · 仅被 @ 的成员会收到消息</div>
              </div>
              <span style={{ flex: 1 }} />
              <div style={{ display: "flex", alignItems: "center", gap: -4, marginRight: space.sm }}>
                {(team?.members ?? []).slice(0, 5).map((seat) => (
                  <span key={seat.id} style={{ marginLeft: -6 }} title={seat.member?.name ?? seat.alias}>
                    <AgentAvatar role={toRoleKey(roleKeyById.get(seat.roleId ?? "") ?? null)} size="sm" />
                  </span>
                ))}
              </div>
              <button type="button" onClick={() => setRightPanelMode((v) => (v === "full" ? "compact" : "full"))} style={{ fontSize: fontSize.xs, color: neutral[600], border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: "3px 10px", background: "var(--color-surface)", cursor: "pointer", fontFamily: fontFamily.body }}>{rightPanelMode === "full" ? "精简面板" : "完整面板"}</button>
              <button type="button" data-testid="group-settings-button" onClick={() => setShowMembersDrawer(true)} style={{ fontSize: fontSize.xs, color: "#0F766E", border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: "3px 10px", background: "var(--color-surface)", cursor: "pointer", fontFamily: fontFamily.body }}>群设置</button>
            </header>

            <div data-testid="group-member-switcher" style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.sm}px ${space.lg}px`, borderBottom: `1px solid ${neutral[100]}`, backgroundColor: "var(--color-surface)", overflowX: "auto" }}>
              <span style={{ fontSize: 10, color: neutral[400], whiteSpace: "nowrap" }}>成员切换</span>
              <button type="button" onClick={() => setFilterMemberId(null)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, border: "none", background: "none", cursor: "pointer", padding: 0, fontFamily: fontFamily.body }}>
                <span style={{ width: 28, height: 28, borderRadius: "50%", backgroundColor: !filterMemberId ? "#0D9488" : neutral[100], color: !filterMemberId ? "#FFF" : neutral[500], display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>全</span>
                <span style={{ fontSize: 10, color: !filterMemberId ? "#0F766E" : neutral[500], fontWeight: !filterMemberId ? 700 : 400 }}>全部</span>
              </button>
              {(team?.members ?? []).map((seat) => {
                const memberId = seat.memberId ?? "";
                const roleKey = toRoleKey(roleKeyById.get(seat.roleId ?? "") ?? null);
                const busy = memberById.get(memberId)?.session?.busyState === "running";
                const selected = filterMemberId === seat.id;
                return (
                  <button key={seat.id} type="button" data-testid="group-member-chip" onClick={() => setFilterMemberId(selected ? null : seat.id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, border: "none", background: "none", cursor: "pointer", padding: 0, fontFamily: fontFamily.body, opacity: 1 }}>
                    <span style={{ position: "relative" }}>
                      <AgentAvatar role={roleKey} size="sm" />
                      {busy && <span title="在其他群处理中（消息照常送达）" style={{ position: "absolute", right: -1, top: -1, width: 8, height: 8, borderRadius: "50%", backgroundColor: "#F59E0B", border: "1.5px solid #FFF" }} />}
                    </span>
                    <span style={{ fontSize: 10, color: selected ? "#0F766E" : neutral[500], fontWeight: selected ? 700 : 400, maxWidth: 56, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seat.member?.name ?? seat.alias}</span>
                  </button>
                );
              })}
              <span style={{ marginLeft: "auto", fontSize: 10, color: neutral[400], whiteSpace: "nowrap" }}>⊙ 橙标=忙碌于其他群（照常送达）</span>
            </div>

            {busySeats.length > 0 && (
              <div data-testid="group-busy-banner" style={{ display: "flex", alignItems: "center", gap: 8, padding: `${space.xs + 2}px ${space.lg}px`, backgroundColor: "#FFFBEB", borderBottom: "1px solid #FDE68A", fontSize: fontSize.xs, color: "#92400E" }}>
                <span>⏳</span>
                <span style={{ fontWeight: 600 }}>
                  {busySeats.map((s) => {
                    const name = memberById.get(s.memberId ?? "")?.name ?? s.alias;
                    const group = busyTeamName(s.memberId ?? "");
                    return group ? `${name} 正在「${group}」处理消息` : `${name} 正在其他群处理消息`;
                  }).join("；")}
                </span>
                <span style={{ color: "#B45309" }}>消息照常送达，不拦截，成员自行安排先后</span>
              </div>
            )}

            <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              <TeamSessionView teamId={teamId} embedded hideRightPanel={rightPanelMode !== "full"} filterMemberId={filterMemberId} />
            </div>
          </div>

          {rightPanelMode === "compact" && <GroupContextPanel
            team={team}
            active={active}
            tasks={teamTasks}
            tasksLoading={teamTasksQuery.isPending}
            roleKeyById={roleKeyById}
            memberById={memberById}
            filterMemberId={filterMemberId}
            onFilterMember={(seatId: string | null) => setFilterMemberId(seatId)}
          />}
        </div>
      ) : memberId && dmTeamId ? (
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <header style={{ padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", display: "flex", alignItems: "center", gap: space.sm }}>
              <AgentAvatar role={memberRole} size="sm" />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900] }}>{member?.name ?? title}</span>
                  <span style={{ fontSize: 10, color: member?.status === "active" ? "#0F766E" : neutral[400], backgroundColor: member?.status === "active" ? "rgba(13,148,136,0.10)" : neutral[100], borderRadius: radius.pill, padding: "1px 8px" }}>
                    {member?.status === "active" ? "启用中" : "已停用"}
                  </span>
                </div>
                <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>
                  私聊 · 全局会话：{member?.session ? (member.session.busyState === "running" ? "处理中" : "空闲") : "未建立"}
                  {dmTeamName ? ` · 最近活跃群：${dmTeamName}` : ""}
                </div>
              </div>
              <span style={{ flex: 1 }} />
              {dmNotice && <span style={{ fontSize: 10, color: "#0F766E", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dmNotice}</span>}
              {member?.session?.busyState === "running" && (
                <span data-testid="dm-processing" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: fontSize.xs, color: "#B45309", backgroundColor: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: radius.pill, padding: "2px 10px" }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: "#F59E0B", animation: "pulse 1.2s infinite" }} />
                  处理中…
                </span>
              )}
              <button type="button" disabled={resetSessionMutation.isPending} onClick={() => { if (window.confirm("确认重置该成员的全局会话？消息与记忆不受影响。")) resetSessionMutation.mutate(); }} style={{ border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: neutral[600], borderRadius: radius.md, padding: "3px 10px", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}>{resetSessionMutation.isPending ? "重置中…" : "重置会话"}</button>
            </header>
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              <TeamSessionView teamId={dmTeamId} embedded hideRightPanel privateMemberId={memberId} hideInlineStatus />
            </div>
          </div>
          <MemberContextPanel
            member={member}
            session={member?.session ?? null}
            teamName={dmTeamName}
            onReset={() => { if (window.confirm("确认重置该成员的全局会话？消息与记忆不受影响。")) resetSessionMutation.mutate(); }}
            resetting={resetSessionMutation.isPending}
          />
        </div>
      ) : (
      <>
      {/* 中间消息区 */}
      <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <header style={{ padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <AgentAvatar role={isGroup ? "product" : memberRole} size="sm" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
              <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{subtitle}</div>
            </div>
            {active?.pinned && <span style={{ marginLeft: "auto", fontSize: 10, color: "#B45309", backgroundColor: "#FEF3C7", borderRadius: radius.pill, padding: "1px 8px" }}>置顶</span>}
          </div>
        </header>

        {isGroup && (team?.members.length ?? 0) > 0 && (
          <div style={{ display: "flex", gap: 10, padding: `${space.sm}px ${space.lg}px`, borderBottom: `1px solid ${neutral[100]}`, backgroundColor: "var(--color-surface)", overflowX: "auto" }}>
            <MemberChip name="全部" role="product" active />
            {team?.members.map((seat) => (
              <MemberChip
                key={seat.id}
                name={seat.member?.name ?? seat.alias}
                role={toRoleKey(roleKeyById.get(seat.roleId ?? "") ?? null)}
                active={false}
              />
            ))}
          </div>
        )}

        <div ref={listRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: `${space.lg}px ${space.xl}px`, display: "flex", flexDirection: "column", gap: space.md }}>
          {messagesQuery.isPending ? (
            <div style={{ color: neutral[400], fontSize: fontSize.sm }}>加载消息中…</div>
          ) : messages.length === 0 ? (
            <div style={{ margin: "auto", color: neutral[400], fontSize: fontSize.sm }}>
              {isGroup ? "还没有消息，@ 一位成员开始协作" : `和「${title}」的私聊还没有消息`}
            </div>
          ) : (
            messages.map((msg) => {
              const text = typeof msg.content === "string" ? msg.content : msg.content?.text ?? "";
              const parts = typeof msg.content === "object" && msg.content?.parts ? msg.content.parts : [];
              if (msg.senderType === "system") {
                return (
                  <div key={msg.id} style={{ alignSelf: "center", fontSize: fontSize.xs, color: neutral[400], backgroundColor: neutral[100], borderRadius: radius.pill, padding: "2px 10px" }}>
                    {text || "系统消息"}
                  </div>
                );
              }
              if (msg.senderType === "agent") {
                const sender = msg.senderInstanceId
                  ? roleBySender.get(msg.senderInstanceId)
                  : msg.senderId
                    ? roleBySender.get(msg.senderId)
                    : undefined;
                const role = sender?.role ?? (isGroup ? "developer" : memberRole);
                return (
                  <MsgParts
                    key={msg.id}
                    parts={parts}
                    bodyText={text}
                    author={sender?.name ?? (isGroup ? "Agent" : title)}
                    role={role}
                    time={formatTime(msg.createdAt)}
                    messageStatus={msg.status}
                  />
                );
              }
              return (
                <ChatBubble
                  key={msg.id}
                  text={text}
                  type="user"
                  time={formatTime(msg.createdAt)}
                  status={msg.status}
                />
              );
            })
          )}
        </div>

        <footer style={{ borderTop: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", padding: `${space.sm}px ${space.lg}px ${space.md}px` }}>
          {sendError && <div style={{ fontSize: fontSize.xs, color: "#B91C1C", marginBottom: 6 }}>{sendError}</div>}
          <div style={{ display: "flex", gap: space.sm, alignItems: "flex-end" }}>
            <textarea
              data-testid="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={isGroup ? "输入消息，@ 提及群内成员…" : `发送私聊消息给 ${title}…`}
              rows={2}
              style={{ flex: 1, resize: "none", padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, fontFamily: fontFamily.body, outline: "none" }}
            />
            <button
              type="button"
              data-testid="chat-send"
              disabled={!input.trim() || sendMutation.isPending}
              onClick={submit}
              style={{ padding: `${space.sm + 2}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: input.trim() ? "#0D9488" : neutral[200], color: "#FFF", fontWeight: 600, fontSize: fontSize.sm, cursor: input.trim() ? "pointer" : "default", fontFamily: fontFamily.body }}
            >
              {sendMutation.isPending ? "发送中…" : "发送"}
            </button>
          </div>
        </footer>
      </section>

      {/* 右侧栏 */}
      <aside style={{ width: 280, flexShrink: 0, borderLeft: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", minHeight: 0, overflow: "auto", padding: space.lg }}>
        <MemberSidePanel member={member} fallbackTitle={title} />
      </aside>

      </>
      )}

      {showMembersDrawer && isGroup && (
        <div style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,0.28)", display: "flex", justifyContent: "flex-end", zIndex: 45 }} onClick={() => setShowMembersDrawer(false)}>
          <div data-testid="group-members-drawer" onClick={(e) => e.stopPropagation()} style={{ width: 380, height: "100%", display: "flex", flexDirection: "column", backgroundColor: "var(--color-surface)", boxShadow: shadow.lg }}>
            <div style={{ padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${neutral[100]}`, display: "flex", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900] }}>成员管理</div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>{team?.name} · {team?.members.length ?? 0} 位成员</div>
              </div>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => setShowMembersDrawer(false)} style={{ border: "none", background: "none", fontSize: fontSize.lg, color: neutral[400], cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: space.md, borderBottom: `1px solid ${neutral[100]}` }}>
              <a href={`/teams/${teamId}`} style={{ display: "block", textAlign: "center", padding: "6px 0", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, color: "#0F766E", fontSize: fontSize.xs, fontWeight: 600, textDecoration: "none" }}>＋ 添加成员 / 完整管理 →</a>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: space.md, display: "flex", flexDirection: "column", gap: 6 }}>
              {(team?.members ?? []).map((seat) => {
                const m = memberById.get(seat.memberId ?? "");
                const busy = m?.session?.busyState === "running";
                const groupName = busyTeamName(seat.memberId ?? "");
                return (
                  <div key={seat.id} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>
                    <AgentAvatar role={toRoleKey(roleKeyById.get(seat.roleId ?? "") ?? null)} size="sm" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m?.name ?? seat.member?.name ?? seat.alias}</div>
                      <div style={{ fontSize: 10, color: busy ? "#B45309" : neutral[400] }}>
                        {m?.role?.name ?? "成员"} · {busy ? (groupName ? `正在「${groupName}」处理` : "其他群处理中") : "空闲"}
                      </div>
                    </div>
                    {seat.memberId && (
                      <button type="button" disabled={resetMemberSessionMutation.isPending} onClick={() => { if (window.confirm(`确认重置成员「${m?.name ?? seat.alias}」的全局会话？消息/记忆保留。`)) resetMemberSessionMutation.mutate(seat.memberId as string); }} style={{ border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: "#B45309", borderRadius: radius.sm, padding: "2px 8px", fontSize: 10, cursor: "pointer", fontFamily: fontFamily.body }}>重置会话</button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {showNewGroup && (
        <div style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ width: 520, maxHeight: "82%", display: "flex", flexDirection: "column", backgroundColor: "var(--color-surface)", borderRadius: radius.lg, boxShadow: shadow.lg, overflow: "hidden" }}>
            <div style={{ padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${neutral[100]}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900] }}>新建群聊</div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>选择成员库里的成员，创建后即可开始群聊</div>
              </div>
              <button type="button" onClick={() => { setShowNewGroup(false); setGroupError(null); }} style={{ border: "none", background: "none", fontSize: fontSize.lg, color: neutral[400], cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: space.md, display: "flex", flexDirection: "column", gap: space.sm }}>
              <input data-testid="new-group-name" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="群聊名称（例如：通知中心迭代）" style={{ width: "100%", boxSizing: "border-box", padding: `8px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, fontFamily: fontFamily.body, outline: "none" }} />
              <input value={dmSearch} onChange={(e) => setDmSearch(e.target.value)} placeholder="搜索成员" style={{ width: "100%", boxSizing: "border-box", padding: `6px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, fontSize: fontSize.xs, fontFamily: fontFamily.body, outline: "none", backgroundColor: neutral[50] }} />
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: `0 ${space.md}px ${space.md}px`, display: "flex", flexDirection: "column", gap: 6 }}>
              {(directoryQuery.isPending ? [] : directory.filter((m) => !dmSearch.trim() || m.name.toLowerCase().includes(dmSearch.trim().toLowerCase()))).map((member) => {
                const checked = groupMemberIds.includes(member.id);
                return (
                  <label key={member.id} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${checked ? "#0D9488" : neutral[200]}`, backgroundColor: checked ? "rgba(13,148,136,0.06)" : "var(--color-surface)", cursor: "pointer" }}>
                    <input type="checkbox" checked={checked} onChange={(e) => setGroupMemberIds((prev) => e.target.checked ? [...prev, member.id] : prev.filter((id) => id !== member.id))} />
                    <AgentAvatar role={toRoleKey(member.role?.key ?? null)} size="sm" />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>{member.name}</span>
                      <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>{member.role?.name ?? "成员"} · 已在 {member.groupCount} 个群</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {groupError && <div style={{ padding: `0 ${space.md}px`, fontSize: fontSize.xs, color: "#B91C1C" }}>{groupError}</div>}
            <div style={{ padding: space.md, borderTop: `1px solid ${neutral[100]}`, display: "flex", alignItems: "center", gap: space.sm }}>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>已选 {groupMemberIds.length} 位成员</span>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => setShowNewGroup(false)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.sm, cursor: "pointer", fontFamily: fontFamily.body }}>取消</button>
              <button type="button" data-testid="create-group-submit" disabled={createGroupMutation.isPending} onClick={() => { if (!groupName.trim()) { setGroupError("请输入群聊名称"); return; } if (groupMemberIds.length === 0) { setGroupError("至少选择一位成员"); return; } createGroupMutation.mutate(); }} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", fontSize: fontSize.sm, fontWeight: 600, cursor: createGroupMutation.isPending ? "default" : "pointer", fontFamily: fontFamily.body }}>{createGroupMutation.isPending ? "创建中…" : "创建群聊"}</button>
            </div>
          </div>
        </div>
      )}

      {showDmPicker && (
        <div style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ width: 480, maxHeight: "80%", display: "flex", flexDirection: "column", backgroundColor: "var(--color-surface)", borderRadius: radius.lg, boxShadow: shadow.lg, overflow: "hidden" }}>
            <div style={{ padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${neutral[100]}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900] }}>发起新私聊</div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>从成员库选择一位成员；已有私聊会直接打开</div>
              </div>
              <button type="button" onClick={() => { setShowDmPicker(false); setDmSearch(""); }} style={{ border: "none", background: "none", fontSize: fontSize.lg, color: neutral[400], cursor: "pointer" }}>×</button>
            </div>
            <div style={{ padding: space.md }}>
              <input data-testid="dm-picker-search" value={dmSearch} onChange={(e) => setDmSearch(e.target.value)} placeholder="搜索成员名 / Agent" style={{ width: "100%", boxSizing: "border-box", padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, fontFamily: fontFamily.body, outline: "none" }} />
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: `0 ${space.md}px ${space.md}px`, display: "flex", flexDirection: "column", gap: 6 }}>
              {pickerMembersQuery.isPending ? (
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>加载中…</span>
              ) : filteredPickerMembers.length === 0 ? (
                <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>没有匹配的成员</span>
              ) : (
                filteredPickerMembers.map((member) => (
                  <button key={member.id} type="button" data-testid="dm-picker-member" disabled={startDmMutation.isPending} onClick={() => startDmMutation.mutate(member.id)} style={{ textAlign: "left", display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontFamily: fontFamily.body }}>
                    <AgentAvatar role={toRoleKey(member.role?.key ?? null)} size="sm" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>{member.name}</div>
                      <div style={{ fontSize: 10, color: neutral[400] }}>{member.role?.name ?? "成员"} · 已在 {member.groupCount} 个群</div>
                    </div>
                    <span style={{ fontSize: 10, color: "#0F766E" }}>发起私聊 →</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/** useSearchParams 需要 Suspense 边界（Next App Router CSR bailout）。 */
export default function ChatPage() {
  return (
    <Suspense
      fallback={
        <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: neutral[400], fontSize: fontSize.sm }}>
          加载会话…
        </main>
      }
    >
      <ChatPageContent />
    </Suspense>
  );
}

function conversationRole(
  item: ConversationItemDto,
  memberById: Map<string, MemberDto>,
): RoleKey {
  if (item.type === "group") return "product";
  const memberId = item.id.replace("dm:", "");
  return toRoleKey(memberById.get(memberId)?.role?.key ?? null);
}

/** 群头像配色（按群名哈希从固定色板取，稳定且区分度足够）。 */
function groupAvatarPalette(title: string): {
  backgroundImage: string;
  backgroundColor: string;
  color: string;
  border: string;
} {
  // 原型群头像为渐变圆角方块：按群名哈希取一组渐变，白字。
  const palettes = [
    { from: "#818CF8", to: "#4F46E5" },
    { from: "#2DD4BF", to: "#0D9488" },
    { from: "#60A5FA", to: "#2563EB" },
    { from: "#FBBF24", to: "#EA580C" },
    { from: "#A78BFA", to: "#7C3AED" },
  ];
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  const p = palettes[hash % palettes.length];
  return {
    backgroundImage: `linear-gradient(135deg, ${p.from}, ${p.to})`,
    backgroundColor: p.to,
    color: "#FFFFFF",
    border: "none",
  };
}

function ConversationRow({
  item,
  active,
  roleKey,
  busy = false,
  onClick,
}: {
  item: ConversationItemDto;
  active: boolean;
  roleKey: RoleKey;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="conversation-item"
      data-conv-id={item.id}
      style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer", display: "flex", gap: space.sm, alignItems: "center", padding: `${space.sm}px ${space.sm}px`, borderRadius: radius.md, backgroundColor: active ? "rgba(13,148,136,0.10)" : "transparent", fontFamily: fontFamily.body }}
    >
      <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
        {item.type === "group" ? (
          <AgentAvatar role="product" size="md" shape="square" dot={false} initials={item.title.slice(0, 1)} style={groupAvatarPalette(item.title)} />
        ) : (
          <AgentAvatar role={roleKey} size="md" />
        )}
        {busy && (
          <span data-testid="conversation-busy-dot" title="处理中" style={{ position: "absolute", right: -1, bottom: -1, width: 9, height: 9, borderRadius: "50%", backgroundColor: "#F59E0B", border: "1.5px solid var(--color-surface)" }} />
        )}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
          <span style={{ flexShrink: 0, fontSize: 10, color: item.type === "group" ? "#0F766E" : "#7C3AED", backgroundColor: item.type === "group" ? "rgba(13,148,136,0.10)" : "rgba(124,58,237,0.10)", borderRadius: radius.pill, padding: "0 6px" }}>
            {item.badge}
          </span>
          {item.pinned && <span style={{ fontSize: 10, color: "#B45309" }}>置顶</span>}
          <span style={{ marginLeft: "auto", fontSize: 10, color: neutral[400] }}>{item.lastMessage ? formatTime(item.lastMessage.createdAt) : ""}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {stripInjectedContext(item.lastMessage?.text ?? "暂无消息")}
          </span>
          {item.unreadCount > 0 && (
            <span style={{ marginLeft: "auto", minWidth: 18, height: 18, borderRadius: 9, backgroundColor: "#DC2626", color: "#FFF", fontSize: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 4px" }}>
              {item.unreadCount > 99 ? "99+" : item.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function MemberChip({ name, role, active }: { name: string; role: RoleKey; active: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 44 }}>
      <AgentAvatar role={role} size="sm" />
      <span style={{ fontSize: 10, color: active ? "#0F766E" : neutral[500], fontWeight: active ? 700 : 400, maxWidth: 52, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
    </div>
  );
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "待开始",
    queued: "排队中",
    in_progress: "进行中",
    blocked: "阻塞",
    pending_review: "待验收",
    completed: "已完成",
    archived: "已归档",
  };
  return map[status] ?? status;
}

function statusColor(status: string): string {
  if (status === "in_progress") return "#0F766E";
  if (status === "blocked") return "#B91C1C";
  if (status === "pending_review") return "#B45309";
  if (status === "completed") return neutral[400];
  return neutral[500];
}

function GroupContextPanel({
  team,
  active,
  tasks,
  tasksLoading,
  roleKeyById,
  memberById,
  filterMemberId,
  onFilterMember,
}: {
  team?: TeamDto;
  active: ConversationItemDto | null;
  tasks: Array<{ id: string; title: string; status: string }>;
  tasksLoading: boolean;
  roleKeyById: Map<string, string>;
  memberById: Map<string, MemberDto>;
  filterMemberId: string | null;
  onFilterMember: (seatId: string | null) => void;
}) {
  const [tab, setTab] = useState<"tasks" | "members" | "outputs">("tasks");
  const activeTask = tasks.find(
    (t) => t.status === "in_progress" || t.status === "pending_review",
  );
  const outputsQuery = useQuery({
    queryKey: ["chat-group-artifacts", team?.id, activeTask?.id],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; title: string; type: string }> }>(
        `/tasks/${activeTask?.id}/artifacts`,
      ),
    enabled: tab === "outputs" && !!activeTask?.id,
  });
  const tabs: Array<{ key: typeof tab; label: string }> = [
    { key: "tasks", label: "任务" },
    { key: "members", label: "成员" },
    { key: "outputs", label: "产出" },
  ];
  return (
    <aside data-testid="group-context-panel" style={{ width: 300, flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: "var(--color-surface)", borderLeft: `1px solid ${neutral[200]}` }}>
      <div style={{ display: "flex", borderBottom: `1px solid ${neutral[100]}`, flexShrink: 0 }}>
        {tabs.map((t) => (
          <button key={t.key} type="button" data-testid={`group-context-tab-${t.key}`} onClick={() => setTab(t.key)} style={{ flex: 1, padding: `${space.md}px 0`, border: "none", borderBottom: tab === t.key ? "2px solid #0D9488" : "2px solid transparent", background: "none", cursor: "pointer", fontSize: fontSize.sm, fontWeight: tab === t.key ? 700 : 500, color: tab === t.key ? "#0F766E" : neutral[500], fontFamily: fontFamily.body }}>{t.label}</button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: space.lg, display: "flex", flexDirection: "column", gap: space.md }}>
        {tab === "tasks" && (
          <>
            <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>关联任务</div>
            {tasksLoading ? (
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>加载中…</span>
            ) : tasks.length === 0 ? (
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无任务</span>
            ) : (
              tasks.slice(0, 6).map((task) => (
                <a key={task.id} href={`/teams/${team?.id ?? ""}/tasks`} style={{ textDecoration: "none", display: "flex", flexDirection: "column", gap: 4, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)" }}>
                  <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: statusColor(task.status) }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: statusColor(task.status) }} />
                    {statusLabel(task.status)}
                  </span>
                </a>
              ))
            )}
            <a href={`/teams/${team?.id ?? ""}/tasks`} style={{ textAlign: "center", padding: "6px 0", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, color: "#0F766E", fontSize: fontSize.xs, fontWeight: 600, textDecoration: "none" }}>查看全部任务 →</a>
          </>
        )}

        {tab === "members" && (
          <>
            <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>参与成员 · {team?.members.length ?? 0}</div>
            {(team?.members ?? []).map((seat) => {
              const member = memberById.get(seat.memberId ?? "");
              const busy = member?.session?.busyState === "running";
              const selected = filterMemberId === seat.id;
              return (
                <button key={seat.id} type="button" onClick={() => onFilterMember(selected ? null : seat.id)} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${selected ? "#0F766E" : neutral[200]}`, backgroundColor: selected ? "rgba(13,148,136,0.06)" : "var(--color-surface)", cursor: "pointer", textAlign: "left", fontFamily: fontFamily.body }}>
                  <AgentAvatar role={toRoleKey(roleKeyById.get(seat.roleId ?? "") ?? null)} size="sm" />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{member?.name ?? seat.member?.name ?? seat.alias}</span>
                    <span style={{ display: "block", fontSize: 10, color: busy ? "#B45309" : neutral[400] }}>{member?.role?.name ?? "成员"} · {busy ? "其他群处理中" : "在线/空闲"}</span>
                  </span>
                </button>
              );
            })}
          </>
        )}

        {tab === "outputs" && (
          <>
            <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>产出物{activeTask ? ` · ${activeTask.title}` : ""}</div>
            {!activeTask ? (
              <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无进行中任务</div>
            ) : outputsQuery.isPending ? (
              <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>加载中…</div>
            ) : (outputsQuery.data?.items ?? []).length === 0 ? (
              <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>该任务暂无产出物</div>
            ) : (
              (outputsQuery.data?.items ?? []).slice(0, 8).map((item) => (
                <a key={item.id} href={`/docs/${activeTask.id}`} style={{ textDecoration: "none", display: "flex", flexDirection: "column", gap: 2, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>
                  <span style={{ fontSize: fontSize.xs, fontWeight: 600, color: neutral[800], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
                  <span style={{ fontSize: 10, color: neutral[400] }}>{item.type}</span>
                </a>
              ))
            )}
            <a href={`/docs?teamId=${team?.id ?? active?.contextTeamId ?? ""}`} style={{ textAlign: "center", padding: "6px 0", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, color: "#0F766E", fontSize: fontSize.xs, fontWeight: 600, textDecoration: "none" }}>打开团队文档站 →</a>
          </>
        )}
      </div>

      <div style={{ flexShrink: 0, margin: space.md, padding: space.md, borderRadius: radius.md, border: `1px dashed ${neutral[300]}`, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: fontSize.xs, fontWeight: 700, color: neutral[700] }}>查看 Agent 会话</div>
        <div style={{ fontSize: 10, color: neutral[400], lineHeight: 1.6 }}>Agent 内部推理过程不广播到群聊，仅最终回复展示。</div>
        <a href={`/chat?c=${encodeURIComponent(`dm:${(team?.members ?? [])[0]?.memberId ?? ""}`)}`} style={{ fontSize: fontSize.xs, color: "#0F766E", textDecoration: "none", fontWeight: 600 }}>打开成员会话 →</a>
      </div>
    </aside>
  );
}

function MemberContextPanel({
  member,
  session,
  teamName,
  onReset,
  resetting,
}: {
  member?: MemberDetailDto;
  session?: MemberDetailDto["session"];
  teamName: string | null;
  onReset: () => void;
  resetting: boolean;
}) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState(member?.agentId ?? "");
  const [modelId, setModelId] = useState(member?.defaultModelId ?? "");
  const [workerId, setWorkerId] = useState(member?.preferredWorkerId ?? "");
  useEffect(() => {
    setAgentId(member?.agentId ?? "");
    setModelId(member?.defaultModelId ?? "");
    setWorkerId(member?.preferredWorkerId ?? "");
  }, [member?.id, member?.agentId, member?.defaultModelId, member?.preferredWorkerId]);
  const agentsQuery = useQuery({
    queryKey: ["agents", "chat-member-panel"],
    queryFn: () => api.get<{ items: Array<{ id: string; name: string; agentKey: string | null }> }>("/agents", { query: { page: 1, pageSize: 100 } }),
    enabled: !!member,
  });
  const modelsQuery = useQuery({
    queryKey: ["models", "chat-member-panel"],
    queryFn: () => api.get<{ items: Array<{ id: string; name: string; providerID: string }> }>("/models", { query: { page: 1, pageSize: 100 } }),
    enabled: !!member,
  });
  const workersQuery = useQuery({
    queryKey: ["workers", "chat-member-panel"],
    queryFn: () => api.get<Array<{ id: string; name: string | null; status: string }>>("/workers"),
    enabled: !!member,
  });
  const currentWorker = (workersQuery.data ?? []).find((w) => w.id === session?.workerId) ?? null;
  const saveMemberConfig = useMutation({
    mutationFn: (updates: { agentId?: string; defaultModelId?: string; preferredWorkerId?: string }) =>
      membersApi.update(member!.id, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["member", member?.id] });
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });


  return (
    <aside data-testid="member-context-panel" style={{ width: 300, flexShrink: 0, minHeight: 0, overflow: "auto", backgroundColor: "var(--color-surface)", borderLeft: `1px solid ${neutral[200]}`, padding: space.lg, display: "flex", flexDirection: "column", gap: space.md }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.lg, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}` }}>
        <AgentAvatar role={toRoleKey(member?.role?.key ?? null)} size="md" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900] }}>{member?.name ?? "成员"}</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{member?.role?.name ?? "成员"} · {member?.status === "active" ? "启用中" : "已停用"}</div>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>全局会话（只读）</div>
        <div style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: "4px 8px", fontSize: fontSize.xs }}>
          <span style={{ color: neutral[400] }}>状态</span>
          <span style={{ color: session?.busyState === "running" ? "#B45309" : "#0F766E" }}>{session ? (session.busyState === "running" ? "处理中" : "空闲") : "未建立"}</span>
          <span style={{ color: neutral[400] }}>会话 id</span>
          <span style={{ color: neutral[700], fontFamily: fontFamily.mono, wordBreak: "break-all" }}>{session?.id ?? "—"}</span>
          <span style={{ color: neutral[400] }}>最近活跃群</span>
          <span style={{ color: neutral[700] }}>
            {member?.groups?.find((g) => g.teamId === session?.currentTeamId)?.teamName ?? teamName ?? "—"}
          </span>
          <span style={{ color: neutral[400] }}>最近结果</span>
          <span style={{ color: neutral[700] }}>{session?.lastTurnOutcome ?? "—"}</span>
        </div>
        <div style={{ fontSize: 10, color: neutral[400], lineHeight: 1.6 }}>跨群共享同一会话；会话不随任务完成自动重置，只可手动重置。</div>
      </div>

      <div style={{ borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: fontSize.xs, fontWeight: 700, color: neutral[700] }}>运行配置</span>
          <span style={{ flex: 1 }} />
          <span data-testid="member-config-autosave" style={{ fontSize: 10, color: saveMemberConfig.isPending ? "#B45309" : neutral[400] }}>
            {saveMemberConfig.isPending ? "保存中…" : "修改自动保存"}
          </span>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>执行 Agent</span>
          <select value={agentId} onChange={(e) => { const v = e.target.value; setAgentId(v); if (member) saveMemberConfig.mutate({ agentId: v || undefined }); }} style={{ padding: "5px 8px", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.xs, color: neutral[700], fontFamily: fontFamily.body }}>
            {!agentId && <option value="">跟随岗位默认</option>}
            {(agentsQuery.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>默认模型</span>
          <SearchableSelect
            testId="member-model-select"
            value={modelId}
            onChange={(v) => { setModelId(v); if (member) saveMemberConfig.mutate({ defaultModelId: v || undefined }); }}
            placeholder="跟随 Agent / Worker"
            searchPlaceholder="搜索模型 / provider"
            options={[
              { value: "", label: "跟随 Agent / Worker" },
              ...(modelsQuery.data?.items ?? []).map((m) => ({
                value: m.id,
                label: `${m.providerID} · ${m.name}`,
                keywords: `${m.providerID} ${m.name}`,
              })),
            ]}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 10, color: neutral[400] }}>首选 Worker 节点</span>
          <select value={workerId} onChange={(e) => { const v = e.target.value; setWorkerId(v); if (member) saveMemberConfig.mutate({ preferredWorkerId: v || undefined }); }} style={{ padding: "5px 8px", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", fontSize: fontSize.xs, color: neutral[700], fontFamily: fontFamily.body }}>
            <option value="">自动调度</option>
            {(workersQuery.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name ?? w.id}{w.status !== "online" ? "（离线）" : ""}</option>)}
          </select>
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: "4px 8px", fontSize: fontSize.xs }}>
          <span style={{ color: neutral[400] }}>当前节点</span>
          <span style={{ color: neutral[700] }}>{currentWorker ? `${currentWorker.name ?? currentWorker.id}（${currentWorker.status}）` : session?.workerId ?? "尚未绑定"}</span>
          <span style={{ color: neutral[400] }}>私有目录</span>
          <span style={{ color: neutral[700], fontFamily: fontFamily.mono, wordBreak: "break-all" }}>{member?.privateWorkDir ?? "—"}</span>
          <span style={{ color: neutral[400] }}>所在群聊</span>
          <span style={{ color: neutral[700] }}>{member?.groupCount ?? 0} 个</span>
        </div>
        {saveMemberConfig.isError && <span style={{ fontSize: 10, color: "#B91C1C" }}>{errorText(saveMemberConfig.error)}</span>}
      </div>

      {(member?.groups ?? []).length > 0 && (
        <div style={{ borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>所在群聊</div>
          {(member?.groups ?? []).map((g) => (
            <a key={g.teamId} href={`/chat?c=${encodeURIComponent(`group:${g.teamId}`)}`} style={{ textDecoration: "none", display: "flex", justifyContent: "space-between", fontSize: fontSize.xs, color: "#0F766E", padding: "4px 8px", borderRadius: radius.sm, backgroundColor: "rgba(13,148,136,0.06)" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.teamName ?? g.teamId}</span>
              <span style={{ color: neutral[400] }}>#{g.seq}</span>
            </a>
          ))}
        </div>
      )}

      {(member?.notificationChannels ?? []).length > 0 && (
        <div style={{ borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>通知渠道</div>
          {(member?.notificationChannels ?? []).map((ch) => (
            <span key={ch.id} style={{ fontSize: fontSize.xs, color: ch.enabled ? neutral[700] : neutral[400] }}>{ch.name} <span style={{ color: neutral[400] }}>({ch.type})</span></span>
          ))}
        </div>
      )}

      <div style={{ marginTop: "auto", borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm, display: "flex", flexDirection: "column", gap: 6 }}>
        <a href={`/tasks/new?teamId=${member?.groups?.[0]?.teamId ?? ""}`} style={{ textAlign: "center", padding: "6px 10px", borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", fontSize: fontSize.xs, fontWeight: 700, textDecoration: "none" }}>发任务</a>
        <button type="button" data-testid="reset-global-session" disabled={resetting} onClick={onReset} style={{ padding: "6px 10px", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: "#B45309", fontSize: fontSize.xs, fontWeight: 600, cursor: resetting ? "default" : "pointer", fontFamily: fontFamily.body }}>{resetting ? "重置中…" : "重置全局会话"}</button>
        <a href="/members" style={{ textAlign: "center", padding: "6px 10px", borderRadius: radius.md, border: `1px solid ${neutral[200]}`, color: "#0F766E", fontSize: fontSize.xs, fontWeight: 600, textDecoration: "none" }}>打开成员库 →</a>
      </div>
    </aside>
  );
}

function MemberSidePanel({ member, fallbackTitle }: { member?: MemberDetailDto; fallbackTitle: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <AgentAvatar role={toRoleKey(member?.role?.key ?? null)} size="md" />
        <div>
          <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900] }}>{member?.name ?? fallbackTitle}</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>{member?.role?.name ?? "成员"} · {member?.status === "active" ? "启用中" : "已停用"}</div>
        </div>
      </div>
      <div style={{ borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm, display: "grid", gridTemplateColumns: "76px 1fr", gap: "6px 8px", fontSize: fontSize.xs }}>
        <span style={{ color: neutral[400] }}>绑定 Agent</span><span style={{ color: neutral[700] }}>{member?.agent?.name ?? "—"}</span>
        <span style={{ color: neutral[400] }}>默认模型</span><span style={{ color: neutral[700] }}>{member?.defaultModel?.name ?? "—"}</span>
        <span style={{ color: neutral[400] }}>私有目录</span><span style={{ color: neutral[700], fontFamily: fontFamily.mono, wordBreak: "break-all" }}>{member?.privateWorkDir ?? "—"}</span>
        <span style={{ color: neutral[400] }}>所在群聊</span><span style={{ color: neutral[700] }}>{member?.groupCount ?? 0} 个</span>
      </div>
      <div style={{ fontSize: 10, color: neutral[400], borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm }}>
        全局会话状态、重置入口与通知渠道绑定将在 P3/P5 接入。
      </div>
    </div>
  );
}

function errorText(err: unknown): string {
  if (isApiError(err)) return err.message;
  return err instanceof Error ? err.message : "操作失败";
}
