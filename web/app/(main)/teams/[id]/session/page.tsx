"use client";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

/**
 * 团队常驻会话页（team-centric-session Todo1）
 * ==========================================
 * - 路由：/teams/:id/session，常驻团队群聊，不随任务切换而重建
 * - 频道：按 teamId 取 team_group 单例 GET /channels?teamId，消息按 teamId 分区
 * - 复用群聊组件：ChatBubble, MessageInput, useRealtimeEvents, SSE
 * - 订阅：team:<teamId> + channel:<channelId> 双订阅，权限按团队
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { useRealtimeEvents, type RealtimeChatMessage } from "@/hooks/use-realtime";
import { AgentAvatar, ChatBubble, MessageInput } from "@/src/components/ui";
import type { MentionableAgent, SendMessagePayload } from "@/src/components/ui";
import { teamsApi, type TeamDto } from "@/src/api/teams";
import { LoadingIndicator, MsgError } from "@/src/components/chat";
import { type RoleKey, neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: React.CSSProperties = { fontFamily: fontFamily.body };

const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_project_manager: "project_manager",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};
const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];
function toRole(agentId: string): RoleKey | null {
  const direct = AGENT_ID_ROLE[agentId];
  if (direct) return direct;
  const rest = agentId.startsWith("a_") ? agentId.slice(2) : agentId;
  if ((ROLE_KEYS as readonly string[]).includes(rest)) return rest as RoleKey;
  return null;
}
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

interface ChannelItem {
  id: string;
  type: string;
  teamId?: string | null;
  taskId?: string | null;
}
interface ChannelDetail extends ChannelItem {
  agentMembers: { id: string; name: string; role: string | null }[];
}
interface MessagesResponse {
  items: RealtimeChatMessage[];
  nextCursor: string | null;
}

export default function TeamSessionPage() {
  const params = useParams<{ id: string }>();
  const teamId = params?.id ?? "";
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [input, setInput] = useState("");
  const [loadingByAgent, setLoadingByAgent] = useState<Record<string, string>>({});
  const [errorByAgent, setErrorByAgent] = useState<Record<string, string>>({});
  const [loadingMore, setLoadingMore] = useState(false);

  const teamQuery = useQuery({
    queryKey: ["team", teamId],
    queryFn: () => teamsApi.get(teamId),
    enabled: !!teamId && !!user?.id,
  });
  const team: TeamDto | undefined = teamQuery.data;

  const channelsQuery = useQuery({
    queryKey: ["channels", "team_group", teamId],
    queryFn: () => api.get<{ items: ChannelItem[]; total: number }>("/channels", { query: { teamId } }),
    enabled: !!teamId && !!user?.id,
  });
  const channel = useMemo(() => {
    const items = channelsQuery.data?.items ?? [];
    const teamGroup = items.find((c) => c.type === "team_group" && (c.teamId ?? null) === teamId);
    if (teamGroup) return teamGroup;
    if (items.length === 1) return items[0];
    return items.find((c) => (c.teamId ?? null) === teamId) ?? items[0] ?? null;
  }, [channelsQuery.data, teamId]);
  const channelId = channel?.id ?? "";

  const channelDetailQuery = useQuery({
    queryKey: ["channel", channelId],
    queryFn: () => api.get<ChannelDetail>(`/channels/${channelId}`),
    enabled: !!channelId && !!user?.id,
  });

  const messagesQuery = useQuery({
    queryKey: ["channel", channelId, "messages"],
    queryFn: () => api.get<MessagesResponse>(`/channels/${channelId}/messages`, { query: { limit: 50 } }),
    enabled: !!channelId && !!user?.id,
  });

  const mentionableAgents: MentionableAgent[] = useMemo(() => {
    const members = channelDetailQuery.data?.agentMembers ?? [];
    return members.map((m) => ({
      id: m.id,
      name: m.name,
      role: (m.role && (ROLE_KEYS as readonly string[]).includes(m.role) ? m.role : "developer") as RoleKey,
    }));
  }, [channelDetailQuery.data]);

  const agentMap = useMemo(() => {
    const map = new Map<string, { name: string; role: RoleKey }>();
    for (const m of mentionableAgents) map.set(m.id, { name: m.name, role: m.role });
    return map;
  }, [mentionableAgents]);

  // SSE scope: team + channel
  const sseScope = useMemo(() => {
    if (!teamId || !channelId) return "";
    return `team:${teamId},channel:${channelId}`;
  }, [teamId, channelId]);

  useRealtimeEvents({
    scope: sseScope,
    enabled: !!sseScope && !!user?.id,
    onMessage: useCallback(() => {
      requestAnimationFrame(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      });
    }, []),
    onAgentLoading: useCallback((e: any) => {
      const key = e.instanceId ?? e.agentId;
      setLoadingByAgent((prev) => ({ ...prev, [key]: e.phase }));
      setErrorByAgent((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, []),
    onAgentError: useCallback((e: any) => {
      const key = e.instanceId ?? e.agentId;
      setErrorByAgent((prev) => ({ ...prev, [key]: e.error ?? e.message ?? "执行失败" }));
      setLoadingByAgent((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }, []),
    onSessionUpdated: useCallback(() => {}, []),
  });

  // Auto clear loading when message arrives from same agent
  useEffect(() => {
    const items = messagesQuery.data?.items ?? [];
    if (items.length === 0) return;
    const last = items[items.length - 1];
    if (last?.senderType === "agent" && last.senderId) {
      const key = (last as any).senderInstanceId ?? last.senderId;
      setLoadingByAgent((prev) => {
        if (prev[key]) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return prev;
      });
    }
  }, [messagesQuery.data]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messagesQuery.data?.items?.length]);

  const sendMutation = useMutation({
    mutationFn: (payload: SendMessagePayload) => {
      const mentions = payload.mentions ?? [];
      const apiMentions = mentions.map((m: any) => {
        if (m.type === "all") return { type: "all" };
        return { type: "agent", agentId: m.id ?? m.agentId };
      });
      // include @all if text contains @all
      if (payload.text.includes("@all") && !apiMentions.some((m: any) => m.type === "all")) {
        apiMentions.push({ type: "all" });
      }
      return api.post(`/channels/${channelId}/messages`, {
        content: payload.text,
        mentions: apiMentions,
      });
    },
    onSuccess: () => {
      setInput("");
      queryClient.invalidateQueries({ queryKey: ["channel", channelId, "messages"] });
    },
  });

  const handleLoadMore = useCallback(async () => {
    const nextCursor = (messagesQuery.data as MessagesResponse | undefined)?.nextCursor;
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.get<MessagesResponse>(`/channels/${channelId}/messages`, { query: { cursor: nextCursor, limit: 50 } });
      queryClient.setQueryData(["channel", channelId, "messages"], (old: any) => {
        if (!old) return res;
        return { items: [...res.items, ...old.items], nextCursor: res.nextCursor ?? old.nextCursor };
      });
    } finally {
      setLoadingMore(false);
    }
  }, [messagesQuery.data, channelId, loadingMore, queryClient]);

  const messages: RealtimeChatMessage[] = messagesQuery.data?.items ?? [];
  const nextCursor = (messagesQuery.data as MessagesResponse | undefined)?.nextCursor ?? null;
  const loadingLabel = Object.keys(loadingByAgent).length > 0 ? "思考中…" : null;
  const errorLabel = Object.keys(errorByAgent).length > 0 ? { kind: "retry" as const, detail: Object.values(errorByAgent)[0] } : null;

  const handleSend = useCallback(
    (payload: SendMessagePayload) => {
      if (!channelId) return;
      sendMutation.mutate(payload);
    },
    [channelId, sendMutation],
  );

  if (teamQuery.isPending) {
    return <div data-testid="team-session-loading" style={{ padding: space.xl, color: neutral[400], ...baseFont }}>加载团队中…</div>;
  }
  if (teamQuery.isError) {
    const msg = isApiError(teamQuery.error) ? teamQuery.error.message : "加载团队失败";
    const is404 = isApiError(teamQuery.error) && teamQuery.error.status === 404;
    return (
      <div data-testid="team-session-error" role="alert" style={{ padding: space.xl, ...baseFont }}>
        <div style={{ color: "#DC2626", fontSize: fontSize.md }}>{is404 ? "团队不存在" : msg}</div>
        <button type="button" onClick={() => router.push("/teams")} style={{ marginTop: space.md, padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", cursor: "pointer" }}>返回团队列表</button>
      </div>
    );
  }
  if (!team) return null;

  if (channelsQuery.isPending) {
    return <div data-testid="team-session-loading" style={{ padding: space.xl, color: neutral[400], ...baseFont }}>加载会话中…</div>;
  }
  if (!channel) {
    return (
      <div data-testid="team-session-empty" style={{ padding: space.xl, ...baseFont }}>
        <div style={{ color: neutral[600] }}>暂无团队群聊频道（team_group）</div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: space.sm }}>请确认团队已创建，稍后重试</div>
        <button type="button" onClick={() => channelsQuery.refetch()} style={{ marginTop: space.md, padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", cursor: "pointer" }}>重试</button>
      </div>
    );
  }

  return (
    <div data-testid="team-session-root" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", ...baseFont }}>
      <header style={{ height: 64, flexShrink: 0, display: "flex", alignItems: "center", gap: space.md, padding: `0 ${space.xl}px`, backgroundColor: "var(--color-surface)", borderBottom: `1px solid ${neutral[200]}` }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>{team.name} · 团队会话</span>
            <span style={{ fontSize: fontSize.xs, color: neutral[400], backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, padding: "1px 6px", borderRadius: radius.pill }}>{team.id.slice(0, 8)}…</span>
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>常驻群聊 · 按团队复用，切任务不切群 · {team.members.length} 成员</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: space.sm }}>
          <button type="button" data-testid="team-session-refresh" onClick={() => { queryClient.invalidateQueries({ queryKey: ["channel", channelId, "messages"] }); queryClient.invalidateQueries({ queryKey: ["channels", "team_group", teamId] }); }} style={{ width: 32, height: 32, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: neutral[500], cursor: "pointer" }}>↻</button>
          <div style={{ display: "flex" }}>{mentionableAgents.slice(0, 5).map((a, i) => (<span key={a.id} style={{ marginLeft: i === 0 ? 0 : -8 }}><AgentAvatar role={a.role} size="sm" style={{ border: "2px solid #FFF" }} /></span>))}</div>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* Members panel simplified */}
        <aside data-testid="team-session-members" style={{ width: 224, flexShrink: 0, borderRight: `1px solid ${neutral[200]}`, backgroundColor: neutral[50], display: "flex", flexDirection: "column" }}>
          <div style={{ padding: `${space.lg}px ${space.md}px`, fontSize: fontSize.sm, fontWeight: 600, color: neutral[500] }}>团队成员 · {mentionableAgents.length}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs, padding: `0 ${space.sm}px ${space.md}px`, overflowY: "auto" }}>
            {mentionableAgents.map((a) => (
              <div key={a.id} data-testid="member-item" data-role={a.role} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.sm}px`, borderRadius: radius.md, backgroundColor: "transparent" }}>
                <AgentAvatar role={a.role} size="sm" />
                <span style={{ fontSize: fontSize.md, color: neutral[800], fontWeight: 500 }}>{a.name}</span>
              </div>
            ))}
            {mentionableAgents.length === 0 && <div style={{ fontSize: fontSize.xs, color: neutral[400], padding: space.md }}>暂无成员</div>}
          </div>
          <div style={{ marginTop: "auto", padding: space.md, fontSize: fontSize.xs, color: neutral[400], borderTop: `1px dashed ${neutral[200]}` }}>
            当前任务：{team.currentTaskId ? <span style={{ color: "#2563EB" }}>{team.currentTaskId.slice(0, 10)}…</span> : "空闲"}
            <span style={{ display: "block", marginTop: 4 }}>等待队列：{team.queue.length} 个</span>
          </div>
        </aside>

        {/* Chat area */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", backgroundColor: neutral[50] }}>
          <div data-testid="chat-message-list" ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: `${space.xl}px`, display: "flex", flexDirection: "column", gap: space.lg }}>
            <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
              <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>团队会话 · 历史跨任务可见</span>
              <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
            </div>
            {nextCursor && (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <button type="button" data-testid="chat-load-more" disabled={loadingMore} onClick={handleLoadMore} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", color: neutral[600], fontSize: fontSize.sm, cursor: loadingMore ? "default" : "pointer", opacity: loadingMore ? 0.6 : 1 }}> {loadingMore ? "加载中…" : "加载更多历史消息"}</button>
              </div>
            )}
            {messages.map((msg) => {
              const agent = msg.senderId ? agentMap.get(msg.senderId) : undefined;
              const role = agent?.role ?? (msg.senderId ? toRole(msg.senderId) : null) ?? "developer";
              const author = agent?.name ?? msg.senderId ?? "";
              if (msg.senderType === "system") {
                return <ChatBubble key={msg.id} text={(msg.content?.text ?? "") as string} type="system" time={formatTime(msg.createdAt)} />;
              }
              if (msg.senderType === "agent") {
                return <ChatBubble key={msg.id} text={(msg.content?.text ?? "") as string} type="agent" author={author} role={role} time={formatTime(msg.createdAt)} />;
              }
              return <ChatBubble key={msg.id} text={(msg.content?.text ?? "") as string} type={msg.senderType === "user" ? "user" : "agent"} author={msg.senderType === "user" ? undefined : author} role={role} time={formatTime(msg.createdAt)} />;
            })}
            {loadingLabel && <LoadingIndicator label={loadingLabel} />}
            {errorLabel && <MsgError kind={errorLabel.kind} detail={errorLabel.detail} time={formatTime(new Date().toISOString())} />}
          </div>

          <div style={{ padding: `${space.md}px ${space.xl}px`, backgroundColor: "var(--color-surface)", borderTop: `1px solid ${neutral[200]}` }}>
            <MessageInput
              value={input}
              onChange={setInput}
              onSend={handleSend}
              mentionable={mentionableAgents}
              placeholder="输入消息，@ 成员或 @all 广播…"
              sending={sendMutation.isPending}
            />
            <div style={{ marginTop: space.xs, fontSize: fontSize.xs, color: neutral[400] }}>按团队复用 · 消息按 teamId 分区，firmly 属于 {team.name}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
