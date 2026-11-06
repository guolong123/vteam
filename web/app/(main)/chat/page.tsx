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
import { AgentAvatar, ChatBubble } from "@/src/components/ui";
import { MsgParts } from "@/src/components/chat";
import {
  conversationsApi,
  type ConversationItemDto,
} from "@/src/api/conversations";
import { membersApi, type MemberDetailDto, type MemberDto } from "@/src/api/members";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import { agentRolesApi } from "@/src/api/agent-roles";
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
    queryKey: ["channel", channelId, "messages"],
    queryFn: () =>
      api.get<{ items: ChatMessage[] }>(`/channels/${channelId}/messages`, {
        query: { limit: 50 },
      }),
    enabled: !!user?.id && !!channelId,
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
      queryClient.invalidateQueries({
        queryKey: ["channel", channelId, "messages"],
      });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err) => setSendError(errorText(err)),
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/channels/${id}/read`),
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

  // 打开会话时清零未读（channel 级已读；重复点开幂等）。
  useEffect(() => {
    if (!active || !channelId) return;
    if (active.unreadCount > 0) {
      markReadMutation.mutate(channelId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.unreadCount, channelId]);

  // SSE：新消息自动 upsert 到 ["channel", channelId, "messages"]（hook 内建），
  // 这里额外刷新左列表并滚动到底；agent.loading 事件只用来更新占位（下一步细化）。
  useRealtimeEvents({
    scope: channelId ? `channel:${channelId},global` : "global",
    enabled: !!user?.id && !!channelId,
    onMessage: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (active && active.unreadCount >= 0) {
        // 当前会话可见 → 新消息到达即视为已读，避免自己开着还累积未读
        markReadMutation.mutate(channelId as string);
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

  return (
    <main style={{ flex: 1, minHeight: 0, display: "flex", position: "relative", backgroundColor: "var(--color-bg, #F8FAFC)" }}>
      {/* 左侧会话列表 */}
      <aside style={{ width: 300, flexShrink: 0, borderRight: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: `${space.lg}px ${space.lg}px ${space.sm}px` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: fontSize.lg, fontWeight: 700, color: neutral[900] }}>会话</div>
            <button type="button" data-testid="new-dm-button" onClick={() => setShowDmPicker(true)} title="发起新私聊" style={{ border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: "#0F766E", borderRadius: radius.sm, padding: "2px 8px", fontSize: fontSize.xs, cursor: "pointer", fontFamily: fontFamily.body }}>＋ 新私聊</button>
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
            {items.filter((i) => i.type === "group").length} 个群聊 · {items.filter((i) => i.type === "dm").length} 位成员
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: `0 8px ${space.md}px` }}>
          {conversationsQuery.isPending ? (
            <div style={{ padding: space.lg, color: neutral[400], fontSize: fontSize.sm }}>加载中…</div>
          ) : items.length === 0 ? (
            <div style={{ padding: space.lg, color: neutral[400], fontSize: fontSize.sm }}>
              还没有会话：先加入一个团队，或在成员库中发起私聊。
            </div>
          ) : (
            items.map((item) => (
              <ConversationRow
                key={item.id}
                item={item}
                active={active?.id === item.id}
                onClick={() => {
                  setSendError(null);
                  router.replace(`/chat?c=${encodeURIComponent(item.id)}`);
                }}
              />
            ))
          )}
        </div>
      </aside>

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
        {isGroup ? (
          <GroupSidePanel team={team} active={active} tasks={teamTasks} tasksLoading={teamTasksQuery.isPending} roleKeyById={roleKeyById} />
        ) : (
          <MemberSidePanel member={member} fallbackTitle={title} />
        )}
      </aside>

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

function ConversationRow({ item, active, onClick }: { item: ConversationItemDto; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="conversation-item"
      data-conv-id={item.id}
      style={{ width: "100%", textAlign: "left", border: "none", cursor: "pointer", display: "flex", gap: space.sm, alignItems: "center", padding: `${space.sm}px ${space.sm}px`, borderRadius: radius.md, backgroundColor: active ? "rgba(13,148,136,0.10)" : "transparent", fontFamily: fontFamily.body }}
    >
      <AgentAvatar role={item.type === "group" ? "product" : "developer"} size="sm" />
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
            {item.lastMessage?.text ?? "暂无消息"}
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

function GroupSidePanel({
  team,
  active,
  tasks,
  tasksLoading,
  roleKeyById,
}: {
  team?: TeamDto;
  active: ConversationItemDto | null;
  tasks: Array<{ id: string; title: string; status: string }>;
  tasksLoading: boolean;
  roleKeyById: Map<string, string>;
}) {
  const [tab, setTab] = useState<"tasks" | "members" | "outputs">("tasks");
  const tabs: Array<{ key: typeof tab; label: string }> = [
    { key: "tasks", label: "任务" },
    { key: "members", label: "成员" },
    { key: "outputs", label: "产出" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>群聊信息</div>
        <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900], marginTop: 2 }}>{team?.name ?? active?.title}</div>
        <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: 2 }}>{team?.members.length ?? active?.memberCount ?? 0} 位成员</div>
      </div>
      <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: radius.md, backgroundColor: neutral[100], border: `1px solid ${neutral[200]}` }}>
        {tabs.map((t) => (
          <button key={t.key} type="button" data-testid={`chat-right-tab-${t.key}`} onClick={() => setTab(t.key)} style={{ flex: 1, padding: `${space.xs + 1}px 0`, border: "none", borderRadius: radius.sm, cursor: "pointer", backgroundColor: tab === t.key ? "var(--color-surface)" : "transparent", color: tab === t.key ? "#0F766E" : neutral[500], fontSize: fontSize.xs, fontWeight: 600, fontFamily: fontFamily.body, boxShadow: tab === t.key ? shadow.sm : undefined }}>{t.label}</button>
        ))}
      </div>

      {tab === "tasks" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tasksLoading ? (
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>加载中…</span>
          ) : tasks.length === 0 ? (
            <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无任务</span>
          ) : (
            tasks.map((task) => (
              <a key={task.id} href={`/teams/${team?.id ?? active?.contextTeamId ?? ""}/tasks`} style={{ textDecoration: "none", display: "flex", flexDirection: "column", gap: 2, padding: `${space.xs + 1}px ${space.sm}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}` }}>
                <span style={{ fontSize: fontSize.xs, color: neutral[700], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</span>
                <span style={{ fontSize: 10, color: statusColor(task.status) }}>{statusLabel(task.status)}</span>
              </a>
            ))
          )}
        </div>
      )}

      {tab === "members" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(team?.members ?? []).map((seat) => (
            <div key={seat.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AgentAvatar role={toRoleKey(roleKeyById.get(seat.roleId ?? "") ?? null)} size="sm" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: fontSize.xs, color: neutral[700], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seat.member?.name ?? seat.alias}</div>
                <div style={{ fontSize: 10, color: neutral[400] }}>{seat.member ? "平台成员" : "旧席位"} · #{seat.seq}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "outputs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.6 }}>产出物按任务归档。打开任务文档站查看版本与预览。</span>
          <a href={`/docs?teamId=${team?.id ?? active?.contextTeamId ?? ""}`} style={{ textDecoration: "none", textAlign: "center", padding: `${space.xs + 2}px ${space.sm}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, color: "#0F766E", fontSize: fontSize.xs, fontWeight: 600 }}>打开团队文档站 →</a>
        </div>
      )}

      <div style={{ fontSize: 10, color: neutral[400], borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm }}>
        实时消息已接入（SSE）；任务/产出深度操作仍在旧会话页，后续迁移。
      </div>
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
