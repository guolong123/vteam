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
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { AgentAvatar, ChatBubble } from "@/src/components/ui";
import { MsgParts } from "@/src/components/chat";
import {
  conversationsApi,
  type ConversationItemDto,
} from "@/src/api/conversations";
import { membersApi, type MemberDetailDto } from "@/src/api/members";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import {
  type RoleKey,
  ROLE_KEYS,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
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

export default function ChatPage() {
  const user = useAuthStore((s) => s.user);
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected = searchParams.get("c") ?? "";
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

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
          <div style={{ fontSize: fontSize.lg, fontWeight: 700, color: neutral[900] }}>会话</div>
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
                role={toRoleKey(seat.member?.defaultRoleId ? null : null)}
                active={false}
              />
            ))}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: `${space.lg}px ${space.xl}px`, display: "flex", flexDirection: "column", gap: space.md }}>
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
          <GroupSidePanel team={team} active={active} />
        ) : (
          <MemberSidePanel member={member} fallbackTitle={title} />
        )}
      </aside>
    </main>
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

function GroupSidePanel({ team, active }: { team?: TeamDto; active: ConversationItemDto | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>群聊信息</div>
        <div style={{ fontSize: fontSize.md, fontWeight: 700, color: neutral[900], marginTop: 2 }}>{team?.name ?? active?.title}</div>
        <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: 2 }}>{team?.members.length ?? active?.memberCount ?? 0} 位成员 · {team?.activeTaskCount ?? 0} 个活跃任务</div>
      </div>
      <div style={{ borderTop: `1px solid ${neutral[100]}`, paddingTop: space.md }}>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], marginBottom: 6 }}>成员</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(team?.members ?? []).map((seat) => (
            <div key={seat.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AgentAvatar role="developer" size="sm" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: fontSize.xs, color: neutral[700], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seat.member?.name ?? seat.alias}</div>
                <div style={{ fontSize: 10, color: neutral[400] }}>{seat.member ? "平台成员" : "旧席位"} · #{seat.seq}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 10, color: neutral[400], borderTop: `1px solid ${neutral[100]}`, paddingTop: space.sm }}>
        任务/产出面板与实时流式输出将在下一步接入（当前 5s 轮询）。
      </div>
    </div>
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
