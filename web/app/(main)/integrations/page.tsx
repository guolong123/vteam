"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { ConfirmDialog } from "@/src/components/ui";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

const messageTypeTheme: Record<string, { label: string; color: string; bg: string; border: string }> = {
  generic_webhook: { label: "通用 Webhook", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  wecom_aibot: { label: "企微机器人", color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4" },
  github_webhook: { label: "GitHub", color: "#1F2937", bg: "#F3F4F6", border: "#D1D5DB" },
  gitee_webhook: { label: "Gitee", color: "#C71E1E", bg: "rgba(199,30,30,0.08)", border: "rgba(199,30,30,0.22)" },
};

const notifTypeTheme: Record<string, { label: string; color: string; bg: string; border: string }> = {
  webhook: { label: "Webhook", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  wecom_group_robot: { label: "企微群机器人", color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4" },
};

const messageStatusTheme: Record<string, { label: string; color: string; bg: string; border: string }> = {
  connected: { label: "已连接", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  reconnecting: { label: "重连中", color: "#D97706", bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.32)" },
  error: { label: "连接失败", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
  disconnected: { label: "未连接", color: neutral[500], bg: neutral[100], border: neutral[200] },
};

const NOTIF_EVENTS = [
  { value: "task.status_changed", label: "任务状态变更" },
  { value: "agent.question", label: "Agent 提问" },
  { value: "agent.reply", label: "Agent 回复" },
] as const;

const modalInputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[800],
  fontSize: fontSize.md,
  fontFamily: fontFamily.body,
  outline: "none",
};

function Pill({ theme, label, testid, status }: { theme: { color: string; bg: string; border: string }; label: string; testid?: string; status?: string }) {
  return (
    <span data-testid={testid} data-status={status} style={{ display: "inline-flex", alignItems: "center", padding: `${space.xs}px ${space.sm + 2}px`, borderRadius: radius.pill, backgroundColor: theme.bg, border: `1px solid ${theme.border}`, color: theme.color, fontSize: fontSize.sm, fontWeight: 500, ...baseFont }}>
      {label}
    </span>
  );
}
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs + 2 }}>
      <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>{label}</span>
      {children}
    </div>
  );
}

// ---------- Generic Delivery Drawer ----------
function DeliveryDrawer({ channelId, basePath, channelName, onClose }: { channelId: string; basePath: string; channelName: string; onClose: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["deliveries", basePath, channelId, cursor],
    queryFn: () => {
      const query: Record<string, string> = { limit: "20" };
      if (cursor) query.cursor = cursor;
      return api.get<{ items: any[]; nextCursor: string | null }>(`${basePath}/${channelId}/deliveries`, { query });
    },
  });
  useEffect(() => {
    if (q.data) {
      if (!cursor) setItems(q.data.items ?? []);
      else setItems((prev) => [...prev, ...(q.data?.items ?? [])]);
      setNextCursor(q.data.nextCursor ?? null);
    }
  }, [q.data, cursor]);
  useEffect(() => {
    setCursor(null);
    setItems([]);
    setNextCursor(null);
  }, [channelId]);
  return (
    <div data-testid="integration-delivery-drawer" style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", justifyContent: "flex-end", ...baseFont }}>
      <div aria-hidden onClick={onClose} style={{ flex: 1, backgroundColor: "rgba(15,23,42,.32)" }} />
      <div style={{ width: 480, maxWidth: "92%", backgroundColor: "var(--color-surface)", borderLeft: `1px solid ${neutral[200]}`, boxShadow: shadow.lg, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.lg}px ${space.xl}px`, borderBottom: `1px solid ${neutral[200]}` }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], flex: 1 }}>{`投递日志 · ${channelName}`}</span>
          <button type="button" data-testid="integration-delivery-close" onClick={onClose} style={{ width: 32, height: 32, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: space.lg, display: "flex", flexDirection: "column", gap: space.sm }}>
          {q.isPending && items.length === 0 ? <div style={{ color: neutral[400], textAlign: "center", padding: space.xl }}>加载中…</div> : items.length === 0 ? <div data-testid="integration-delivery-empty" style={{ color: neutral[400], textAlign: "center", padding: space.xl }}>暂无投递记录</div> : items.map((d: any) => (
            <div key={d.id} data-testid="integration-delivery-item" style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.xs, fontSize: fontSize.sm }}>
              <div style={{ display: "flex", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ color: neutral[500], fontSize: fontSize.xs }}>{new Date(d.createdAt).toLocaleString()}</span>
                <span style={{ padding: "1px 6px", borderRadius: radius.pill, backgroundColor: d.direction === "inbound" ? "rgba(124,58,237,0.10)" : "rgba(37,99,235,0.10)", color: d.direction === "inbound" ? "#7C3AED" : "#2563EB", fontSize: fontSize.xs, border: "1px solid rgba(37,99,235,0.22)" }}>{d.direction ?? d.status}</span>
                <span style={{ padding: "1px 6px", borderRadius: radius.pill, backgroundColor: d.status === "ok" ? "rgba(16,185,129,0.10)" : d.status === "failed" ? "rgba(239,68,68,0.10)" : neutral[100], color: d.status === "ok" ? "#059669" : d.status === "failed" ? "#DC2626" : neutral[500], fontSize: fontSize.xs, border: "1px solid rgba(16,185,129,0.28)" }}>{d.status}</span>
              </div>
              {d.error && <div style={{ color: "#DC2626", fontSize: fontSize.xs, wordBreak: "break-all" }}>{String(d.error)}</div>}
            </div>
          ))}
          {q.isError && <div role="alert" style={{ color: "#DC2626", textAlign: "center", fontSize: fontSize.sm }}>{isApiError(q.error) ? q.error.message : "加载失败"}</div>}
        </div>
        {nextCursor && (
          <div style={{ padding: `${space.md}px ${space.xl}px`, borderTop: `1px solid ${neutral[200]}`, display: "flex", justifyContent: "center" }}>
            <button type="button" data-testid="integration-delivery-load-more" disabled={q.isFetching} onClick={() => setCursor(nextCursor)} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>{q.isFetching ? "加载中…" : "加载更多"}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Message Channels Tab ----------
function MessageChannelsTab() {
  const queryClient = useQueryClient();
  const isAdmin = useAuthStore((s) => s.user?.roleName === "admin");
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [modal, setModal] = useState<{ mode: "create" | "edit"; ch?: any } | null>(null);
  const [delCh, setDelCh] = useState<any | null>(null);
  const [deliveryCh, setDeliveryCh] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const channelsQuery = useQuery({ queryKey: ["message-channels"], queryFn: () => api.get<any[]>("/message-channels") });

  const createMut = useMutation({
    mutationFn: (payload: any) => api.post<any>("/message-channels", payload),
    onSuccess: (c) => { queryClient.invalidateQueries({ queryKey: ["message-channels"] }); setModal(null); setNotice({ kind: "success", text: `渠道「${c.name}」创建成功` }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "创建失败" }),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => api.patch<any>(`/message-channels/${id}`, payload),
    onSuccess: (c) => { queryClient.invalidateQueries({ queryKey: ["message-channels"] }); setModal(null); setNotice({ kind: "success", text: `渠道「${c.name}」保存成功` }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "保存失败" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/message-channels/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["message-channels"] }); setDeleting(null); setNotice({ kind: "success", text: "渠道已删除" }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "删除失败" }),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.post<any>(`/message-channels/${id}/${enabled ? "enable" : "disable"}`),
    onSuccess: (_d, v) => { queryClient.invalidateQueries({ queryKey: ["message-channels"] }); setNotice({ kind: "success", text: v.enabled ? "已启用" : "已停用" }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "操作失败" }),
  });
  const connectMut = useMutation({
    mutationFn: (id: string) => api.post<any>(`/message-channels/${id}/enable`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["message-channels"] }); setNotice({ kind: "success", text: "已触发连接" }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "连接失败" }),
  });
  const disconnectMut = useMutation({
    mutationFn: (id: string) => api.post<any>(`/message-channels/${id}/disable`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["message-channels"] }); setNotice({ kind: "success", text: "已断开" }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "断开失败" }),
  });

  const channels: any[] = (channelsQuery.data as any) ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <div style={{ flex: 1 }}><div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>消息渠道（入站）</div><div style={{ fontSize: fontSize.sm, color: neutral[500] }}>入站 Webhook，按任务绑定分发，支持 fieldMapping</div></div>
        {isAdmin && <button type="button" data-testid="create-message-channel-button" onClick={() => setModal({ mode: "create" })} style={{ padding: `${space.sm + 1}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", cursor: "pointer", fontFamily: fontFamily.body }}>＋ 新建消息渠道</button>}
      </div>
      {notice && <div role="status" data-testid="integration-notice" data-kind={notice.kind} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: notice.kind === "success" ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)", border: "1px solid rgba(16,185,129,0.28)", color: notice.kind === "success" ? "#065F46" : "#DC2626", fontSize: fontSize.sm }}>{notice.text}</div>}
      {channelsQuery.isPending ? <div style={{ color: neutral[400], textAlign: "center", padding: space.xl }}>加载中…</div> : channels.length === 0 ? <div data-testid="integration-empty" style={{ color: neutral[400], textAlign: "center", padding: space.xl, border: `1px dashed ${neutral[200]}`, borderRadius: radius.lg }}>暂无消息渠道</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          {channels.map((ch) => {
            const theme = messageTypeTheme[ch.type] ?? messageTypeTheme.generic_webhook;
            const inboundUrl = `${typeof window !== "undefined" ? window.location.origin.replace(":13001", ":13000") : ""}/api/v1/message-channels/${ch.id}/inbound`;
            const statusKey = (ch.lastStatus as string) ?? "disconnected";
            const normalizedStatus = messageStatusTheme[statusKey] ? statusKey : "disconnected";
            const statusTheme = messageStatusTheme[normalizedStatus] ?? messageStatusTheme.disconnected;
            const isConnected = ch.lastStatus === "connected";
            return (
              <div key={ch.id} data-testid="integration-channel-item" data-channel-id={ch.id} data-type={ch.type} style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.lg}px ${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, ...baseFont }}>
                <span aria-hidden style={{ width: 40, height: 40, borderRadius: radius.md, display: "inline-flex", alignItems: "center", justifyContent: "center", backgroundColor: theme.color + "14", color: theme.color }}>◈</span>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
                  <span data-testid="integration-inbound-url-display" style={{ fontSize: fontSize.xs, color: neutral[500], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inboundUrl}</span>
                </div>
                <Pill theme={theme} label={theme.label} testid="integration-type-badge" status={ch.type} />
                <button type="button" data-testid="integration-copy-inboundUrl" onClick={() => navigator.clipboard.writeText(inboundUrl)} style={{ padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.xs }}>复制</button>
                {isAdmin ? (
                  <button type="button" data-testid="integration-enabled-toggle" data-enabled={ch.enabled ? "true" : "false"} onClick={() => toggleMut.mutate({ id: ch.id, enabled: !ch.enabled })} style={{ padding: `${space.xs}px ${space.sm + 2}px`, borderRadius: radius.pill, border: `1px solid ${ch.enabled ? "rgba(16,185,129,0.28)" : neutral[200]}`, backgroundColor: ch.enabled ? "rgba(16,185,129,0.10)" : neutral[100], color: ch.enabled ? "#059669" : neutral[500], cursor: "pointer", fontSize: fontSize.sm }}>{ch.enabled ? "已启用" : "已停用"}</button>
                ) : <Pill theme={{ color: ch.enabled ? "#059669" : neutral[500], bg: ch.enabled ? "rgba(16,185,129,0.10)" : neutral[100], border: ch.enabled ? "rgba(16,185,129,0.28)" : neutral[200] }} label={ch.enabled ? "已启用" : "已停用"} testid="integration-enabled-badge" status={ch.enabled ? "enabled" : "disabled"} />}
                {ch.type === 'wecom_aibot' && (
                  <>
                    <Pill theme={statusTheme} label={statusTheme.label} testid="message-channel-status-badge" status={normalizedStatus} />
                    {ch.lastError ? <span data-testid="message-channel-error-text" title={String(ch.lastError)} style={{ fontSize: fontSize.xs, color: "#DC2626", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{String(ch.lastError)}</span> : null}
                    {!isConnected ? (
                      <button type="button" data-testid="message-channel-connect-button" onClick={() => connectMut.mutate(ch.id)} disabled={connectMut.isPending} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: "1px solid #2563EB", backgroundColor: "#2563EB", color: "#FFF", cursor: "pointer", fontSize: fontSize.sm, opacity: connectMut.isPending ? 0.6 : 1 }}>连接</button>
                    ) : (
                      <button type="button" data-testid="message-channel-disconnect-button" onClick={() => disconnectMut.mutate(ch.id)} disabled={disconnectMut.isPending} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], cursor: "pointer", fontSize: fontSize.sm, opacity: disconnectMut.isPending ? 0.6 : 1 }}>断开</button>
                    )}
                  </>
                )}
                <div style={{ display: "flex", gap: space.xs }}>
                  <button type="button" data-testid="integration-delivery-button" onClick={() => setDeliveryCh(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.sm }}>投递</button>
                  {isAdmin && (
                    <>
                      <button type="button" data-testid="integration-edit-button" onClick={() => setModal({ mode: "edit", ch })} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.sm }}>编辑</button>
                      <button type="button" data-testid="integration-delete-button" onClick={() => setDeleting(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "rgba(239,68,68,0.10)", color: "#DC2626", cursor: "pointer", fontSize: fontSize.sm }}>删除</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {modal && <MessageChannelModal mode={modal.mode} channel={modal.ch} submitting={createMut.isPending || updateMut.isPending} error={null} onClose={() => setModal(null)} onSave={(payload) => {
        if (modal.mode === "create") createMut.mutate(payload);
        else {
          const body: any = { name: payload.name, type: payload.type, config: payload.config };
          if (payload.secrets && Object.keys(payload.secrets).length) body.secrets = payload.secrets;
          updateMut.mutate({ id: modal.ch.id, payload: body });
        }
      }} />}
      {deleting && <ConfirmDialog open onClose={() => setDeleting(null)} onConfirm={() => deleteMut.mutate(deleting.id)} title="删除渠道" description={`确认删除「${deleting.name}」？`} confirmLabel="删除" />}
      {deliveryCh && <DeliveryDrawer channelId={deliveryCh.id} basePath="/message-channels" channelName={deliveryCh.name} onClose={() => setDeliveryCh(null)} />}
    </div>
  );
}

const GITHUB_BUILTIN_TEMPLATES: Record<string, { content: string; source: string; user: string }> = {
  push: { content: "{{ head_commit.message }}", source: "{{ repository.full_name }}", user: "{{ pusher.name }}" },
  pull_request: { content: "{{ pull_request.title }} - {{ pull_request.body }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  issues: { content: "{{ issue.title }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  issue_comment: { content: "{{ comment.body }}", source: "{{ repository.full_name }}", user: "{{ comment.user.login }}" },
  pull_request_review: { content: "{{ review.body }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  pull_request_review_comment: { content: "{{ comment.body }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  create: { content: "{{ ref }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  delete: { content: "{{ ref }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  fork: { content: "{{ forkee.full_name }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  release: { content: "{{ release.tag_name }} {{ release.name }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  star: { content: "{{ action }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  ping: { content: "{{ zen }}", source: "github", user: "{{ sender.login }}" },
  check_run: { content: "{{ check_run.name }} {{ check_run.conclusion }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  deployment: { content: "{{ deployment.environment }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
};
const GITEE_BUILTIN_TEMPLATES: Record<string, { content: string; source: string; user: string }> = {
  push_hooks: { content: "{{ head_commit.message }}", source: "{{ project.path_with_namespace }}", user: "{{ pusher.name }}" },
  tag_push_hooks: { content: "{{ ref }}", source: "{{ project.path_with_namespace }}", user: "{{ pusher.name }}" },
  issue_hooks: { content: "{{ issue.title }}", source: "{{ project.path_with_namespace }}", user: "{{ sender.login }}" },
  merge_request_hooks: { content: "{{ pull_request.title }}", source: "{{ project.path_with_namespace }}", user: "{{ sender.login }}" },
  note_hooks: { content: "{{ comment.body }}", source: "{{ project.path_with_namespace }}", user: "{{ sender.login }}" },
};
function getBuiltinForType(t: string): Record<string, { content: string; source: string; user: string }> {
  if (t === "github_webhook") return GITHUB_BUILTIN_TEMPLATES;
  if (t === "gitee_webhook") return GITEE_BUILTIN_TEMPLATES;
  if (t === "generic_webhook") return { ...GITHUB_BUILTIN_TEMPLATES, ...GITEE_BUILTIN_TEMPLATES, _default: { content: "{{ text }}", source: "{{ source }}", user: "{{ sender }}" } };
  return {};
}

function MessageChannelModal({ mode, channel, submitting, error, onClose, onSave }: { mode: "create" | "edit"; channel?: any; submitting: boolean; error: string | null; onClose: () => void; onSave: (p: any) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("generic_webhook");
  const [secret, setSecret] = useState("");
  const [botId, setBotId] = useState("");
  const [fmContent, setFmContent] = useState("");
  const [fmSource, setFmSource] = useState("");
  const [fmUser, setFmUser] = useState("");
  const [selectedEvent, setSelectedEvent] = useState("");
  const [dropdownValue, setDropdownValue] = useState("");
  const [customEventName, setCustomEventName] = useState("");
  const [fieldMappings, setFieldMappings] = useState<Record<string, any>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isWebhookType = type === "generic_webhook" || type === "github_webhook" || type === "gitee_webhook";

  useEffect(() => {
    if (channel) {
      setName(channel.name ?? "");
      const t = channel.type ?? "generic_webhook";
      setType(t);
      const cfg = (channel.config ?? {}) as any;
      const fmMap = (cfg.fieldMappings ?? {}) as Record<string, any>;
      const legacy = (cfg.fieldMapping ?? {}) as Record<string, any>;
      let initialMap: Record<string, any> = {};
      if (fmMap && typeof fmMap === "object" && Object.keys(fmMap).length) {
        initialMap = { ...fmMap };
      } else if (legacy && typeof legacy === "object" && Object.keys(legacy).length) {
        // migrate legacy single mapping to _default for generic, or push for github/gitee
        if (t === "generic_webhook") initialMap = { _default: { ...legacy } };
        else if (t === "github_webhook") initialMap = { push: { ...legacy } };
        else if (t === "gitee_webhook") initialMap = { push_hooks: { ...legacy } };
        else initialMap = { _default: { ...legacy } };
      }
      setFieldMappings(initialMap);
      const builtin = getBuiltinForType(t);
      const builtinKeys = Object.keys(builtin);
      let initEvent = "";
      if (Object.keys(initialMap).length) initEvent = Object.keys(initialMap)[0];
      else if (builtinKeys.length) initEvent = builtinKeys[0];
      else initEvent = "_default";
      const isBuiltin = !!builtin[initEvent];
      setSelectedEvent(initEvent);
      setDropdownValue(isBuiltin ? initEvent : "__custom");
      if (!isBuiltin) setCustomEventName(initEvent);
      else setCustomEventName("");
      const saved = initialMap[initEvent];
      const tpl = builtin[initEvent];
      if (saved) {
        setFmContent(saved.content ?? "");
        setFmSource(saved.source ?? "");
        setFmUser(saved.user ?? "");
      } else if (tpl) {
        setFmContent(tpl.content ?? "");
        setFmSource(tpl.source ?? "");
        setFmUser(tpl.user ?? "");
      } else {
        setFmContent("");
        setFmSource("");
        setFmUser("");
      }
      setSecret("");
      setBotId("");
    } else {
      setName(""); setType("generic_webhook"); setSecret(""); setBotId("");
      const builtin = getBuiltinForType("generic_webhook");
      const first = Object.keys(builtin)[0] ?? "_default";
      setFieldMappings({});
      setSelectedEvent(first);
      setDropdownValue(first);
      setCustomEventName("");
      const tpl = builtin[first];
      setFmContent(tpl?.content ?? "");
      setFmSource(tpl?.source ?? "");
      setFmUser(tpl?.user ?? "");
    }
    setFormError(null);
  }, [channel, mode]);

  // when type switches via buttons, reset event selection
  const handleTypeChange = (t: string) => {
    // persist current edits into map before switching
    if (isWebhookType && selectedEvent) {
      const fm: any = {};
      if (fmContent.trim()) fm.content = fmContent.trim();
      if (fmSource.trim()) fm.source = fmSource.trim();
      if (fmUser.trim()) fm.user = fmUser.trim();
      if (Object.keys(fm).length) {
        setFieldMappings((prev) => ({ ...prev, [selectedEvent]: fm }));
      }
    }
    setType(t);
    const builtin = getBuiltinForType(t);
    const keys = Object.keys(builtin);
    let nextEvent = keys[0] ?? "_default";
    // if existing mappings have a key that exists in new type's builtin, prefer it
    const existingKeys = Object.keys(fieldMappings);
    const intersect = existingKeys.find((k) => !!builtin[k]);
    if (intersect) nextEvent = intersect;
    else if (existingKeys.length) nextEvent = existingKeys[0];
    const isBuiltin = !!builtin[nextEvent];
    setSelectedEvent(nextEvent);
    setDropdownValue(isBuiltin ? nextEvent : "__custom");
    if (!isBuiltin) setCustomEventName(nextEvent);
    else setCustomEventName("");
    const saved = fieldMappings[nextEvent];
    const tpl = builtin[nextEvent];
    if (saved) {
      setFmContent(saved.content ?? "");
      setFmSource(saved.source ?? "");
      setFmUser(saved.user ?? "");
    } else if (tpl) {
      setFmContent(tpl.content ?? "");
      setFmSource(tpl.source ?? "");
      setFmUser(tpl.user ?? "");
    } else {
      setFmContent(""); setFmSource(""); setFmUser("");
    }
  };

  const handleEventSelect = (val: string) => {
    // persist current before switch
    if (selectedEvent) {
      const fm: any = {};
      if (fmContent.trim()) fm.content = fmContent.trim();
      if (fmSource.trim()) fm.source = fmSource.trim();
      if (fmUser.trim()) fm.user = fmUser.trim();
      if (Object.keys(fm).length) {
        setFieldMappings((prev) => ({ ...prev, [selectedEvent]: fm }));
      }
    }
    if (val === "__custom") {
      setDropdownValue("__custom");
      // keep customEventName as selectedEvent if exists else empty
      const cur = customEventName ? fieldMappings[customEventName] : undefined;
      if (cur) {
        setFmContent(cur.content ?? "");
        setFmSource(cur.source ?? "");
        setFmUser(cur.user ?? "");
        setSelectedEvent(customEventName);
      } else {
        setFmContent("");
        setFmSource("");
        setFmUser("");
        setSelectedEvent(customEventName || "");
      }
      return;
    }
    const builtin = getBuiltinForType(type);
    setDropdownValue(val);
    setSelectedEvent(val);
    setCustomEventName("");
    const saved = fieldMappings[val];
    const tpl = builtin[val];
    if (saved) {
      setFmContent(saved.content ?? "");
      setFmSource(saved.source ?? "");
      setFmUser(saved.user ?? "");
    } else if (tpl) {
      setFmContent(tpl.content ?? "");
      setFmSource(tpl.source ?? "");
      setFmUser(tpl.user ?? "");
    } else {
      setFmContent(""); setFmSource(""); setFmUser("");
    }
  };

  const handleCustomEventNameChange = (v: string) => {
    setCustomEventName(v);
    setSelectedEvent(v);
    const saved = fieldMappings[v];
    const builtin = getBuiltinForType(type);
    const tpl = builtin[v];
    if (saved) {
      setFmContent(saved.content ?? "");
      setFmSource(saved.source ?? "");
      setFmUser(saved.user ?? "");
    } else if (tpl) {
      setFmContent(tpl.content ?? "");
      setFmSource(tpl.source ?? "");
      setFmUser(tpl.user ?? "");
    }
  };

  const handleSubmit = () => {
    if (!name.trim()) { setFormError("请填写渠道名称"); return; }
    if (type === "wecom_aibot" && mode === "create") {
      if (!botId.trim()) { setFormError("请填写 BotID"); return; }
      if (!secret.trim()) { setFormError("请填写 Secret"); return; }
    }
    const config: any = {};
    if (type === "generic_webhook" || type === "github_webhook" || type === "gitee_webhook") {
      const currentMap: Record<string, any> = { ...fieldMappings };
      const targetEvent = dropdownValue === "__custom" ? customEventName.trim() : selectedEvent;
      if (targetEvent) {
        const fm: any = {};
        if (fmContent.trim()) fm.content = fmContent.trim();
        if (fmSource.trim()) fm.source = fmSource.trim();
        if (fmUser.trim()) fm.user = fmUser.trim();
        if (Object.keys(fm).length) currentMap[targetEvent] = fm;
      }
      const filteredMap: Record<string, any> = {};
      for (const [k, v] of Object.entries(currentMap)) {
        if (v && typeof v === "object" && (v.content || v.source || v.user)) filteredMap[k] = v;
      }
      if (Object.keys(filteredMap).length) {
        config.fieldMappings = filteredMap;
        // backward compat: also set legacy fieldMapping to the selected event's mapping or _default
        const legacyKey = filteredMap[targetEvent] ? targetEvent : Object.keys(filteredMap)[0];
        if (legacyKey && filteredMap[legacyKey]) config.fieldMapping = filteredMap[legacyKey];
      }
    }
    const secrets: any = {};
    if (type === "wecom_aibot") {
      if (botId.trim()) secrets.botId = botId.trim();
      if (secret.trim()) secrets.secret = secret.trim();
    } else {
      if (secret.trim()) secrets.secret = secret.trim();
    }
    const filtered: any = {};
    for (const [k, v] of Object.entries(secrets)) if (String(v).trim() !== "") filtered[k] = v;
    onSave({ name: name.trim(), type, config, secrets: filtered });
  };

  return (
    <div data-testid="integration-channel-modal" style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "6%" }}>
      <div aria-hidden onClick={onClose} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
      <div style={{ position: "relative", width: 520, maxWidth: "calc(100% - 48px)", maxHeight: "78vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: space.lg, padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg, fontFamily: fontFamily.body }}>
        <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>{mode === "create" ? "新建消息渠道" : `编辑渠道 ${channel?.name ?? ""}`}</div>
        <FieldRow label="名称">
          <input data-testid="integration-name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 webhook-prod" style={modalInputStyle} />
        </FieldRow>
        <FieldRow label="类型">
          <div style={{ display: "flex", gap: space.sm, flexWrap: "wrap" }}>
            {(["generic_webhook", "wecom_aibot", "github_webhook", "gitee_webhook"] as const).map((t) => (
              <button key={t} type="button" data-testid={`integration-type-${t}`} data-active={type === t ? "true" : "false"} onClick={() => handleTypeChange(t)} style={{ flex: 1, minWidth: 110, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: type === t ? "1px solid #2563EB" : `1px solid ${neutral[200]}`, backgroundColor: type === t ? "rgba(37,99,235,0.10)" : "var(--color-surface)", color: type === t ? "#1E40AF" : neutral[600], cursor: "pointer", fontSize: fontSize.sm, fontWeight: type === t ? 600 : 500 }}>{messageTypeTheme[t].label}</button>
            ))}
          </div>
        </FieldRow>
        {isWebhookType && (
          <>
            <FieldRow label="事件类型（内置模板）">
              <select
                data-testid="integration-event-type-select"
                value={dropdownValue}
                onChange={(e) => handleEventSelect(e.target.value)}
                style={{ ...modalInputStyle, fontFamily: fontFamily.body }}
              >
                {Object.keys(getBuiltinForType(type)).map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
                <option value="__custom">自定义 (Custom)</option>
              </select>
            </FieldRow>
            {dropdownValue === "__custom" && (
              <FieldRow label="自定义事件名">
                <input data-testid="integration-custom-event-input" value={customEventName} onChange={(e) => handleCustomEventNameChange(e.target.value)} placeholder="输入事件名，如 my_event" style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} />
              </FieldRow>
            )}
            <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>选择事件自动填充下方映射（可编辑），保存为 config.fieldMappings[事件]</div>
            <FieldRow label="字段映射 content">
              <input data-testid="integration-fieldMapping-content-input" value={fmContent} onChange={(e) => { setFmContent(e.target.value); if (dropdownValue !== "__custom" && selectedEvent) setFieldMappings((prev) => ({ ...prev, [selectedEvent]: { ...(prev[selectedEvent] ?? {}), content: e.target.value, source: fmSource, user: fmUser } })); else if (dropdownValue === "__custom" && customEventName.trim()) setFieldMappings((prev) => ({ ...prev, [customEventName.trim()]: { ...(prev[customEventName.trim()] ?? {}), content: e.target.value, source: fmSource, user: fmUser } })); }} placeholder="{{head_commit.message}} 或 {{issue.title}}" style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} />
            </FieldRow>
            <FieldRow label="字段映射 source">
              <input data-testid="integration-fieldMapping-source-input" value={fmSource} onChange={(e) => { setFmSource(e.target.value); if (dropdownValue !== "__custom" && selectedEvent) setFieldMappings((prev) => ({ ...prev, [selectedEvent]: { ...(prev[selectedEvent] ?? {}), content: fmContent, source: e.target.value, user: fmUser } })); else if (dropdownValue === "__custom" && customEventName.trim()) setFieldMappings((prev) => ({ ...prev, [customEventName.trim()]: { ...(prev[customEventName.trim()] ?? {}), content: fmContent, source: e.target.value, user: fmUser } })); }} placeholder="{{repository.full_name}} 或 {{project.path_with_namespace}}" style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} />
            </FieldRow>
            <FieldRow label="字段映射 user">
              <input data-testid="integration-fieldMapping-user-input" value={fmUser} onChange={(e) => { setFmUser(e.target.value); if (dropdownValue !== "__custom" && selectedEvent) setFieldMappings((prev) => ({ ...prev, [selectedEvent]: { ...(prev[selectedEvent] ?? {}), content: fmContent, source: fmSource, user: e.target.value } })); else if (dropdownValue === "__custom" && customEventName.trim()) setFieldMappings((prev) => ({ ...prev, [customEventName.trim()]: { ...(prev[customEventName.trim()] ?? {}), content: fmContent, source: fmSource, user: e.target.value } })); }} placeholder="{{sender.login}} 或 {{pusher.name}}" style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} />
            </FieldRow>
          </>
        )}
        {type === "wecom_aibot" ? (
          <>
            <FieldRow label="BotID">
              <input data-testid="integration-botId-input" value={botId} onChange={(e) => setBotId(e.target.value)} placeholder={mode === "edit" ? "•••••••• (保持不变)" : "企微后台 BotID"} style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} />
            </FieldRow>
            <FieldRow label="Secret">
              <input data-testid="integration-secret-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={mode === "edit" ? "•••••••• (保持不变)" : "企微长连接 Secret"} style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} />
            </FieldRow>
          </>
        ) : (
          <FieldRow label="Secret">
            <input data-testid="integration-secret-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={mode === "edit" ? "•••••••• (保持不变)" : "可选，用于签名校验"} style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} />
          </FieldRow>
        )}
        {isWebhookType && channel?.id && (
          <FieldRow label="入站地址">
            <div style={{ display: "flex", gap: 8, alignItems: "center", ...modalInputStyle, fontFamily: fontFamily.mono }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{`${typeof window !== "undefined" ? window.location.origin.replace(":13001", ":13000") : ""}/api/v1/message-channels/${channel.id}/inbound`}</span>
              <button type="button" data-testid="integration-copy-inboundUrl" onClick={() => navigator.clipboard.writeText(`${window.location.origin.replace(":13001", ":13000")}/api/v1/message-channels/${channel.id}/inbound`)} style={{ padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, cursor: "pointer", fontSize: fontSize.xs }}>复制</button>
            </div>
          </FieldRow>
        )}
        {isWebhookType && !channel?.id && (
          <FieldRow label="入站地址">
            <div data-testid="integration-inboundUrl" style={{ ...modalInputStyle, fontFamily: fontFamily.mono }}>创建后生成：/api/v1/message-channels/{"{id}"}/inbound</div>
          </FieldRow>
        )}
        {(error || formError) && <div role="alert" data-testid="integration-modal-error" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", color: "#DC2626", fontSize: fontSize.sm }}>{error ?? formError}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button type="button" data-testid="integration-modal-cancel" onClick={onClose} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>取消</button>
          <button type="button" data-testid="integration-modal-confirm" disabled={submitting} onClick={handleSubmit} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", cursor: "pointer", opacity: submitting ? 0.6 : 1 }}>{submitting ? "保存中…" : mode === "create" ? "创建" : "保存"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Notification Channels Tab ----------
function NotificationChannelsTab() {
  const queryClient = useQueryClient();
  const isAdmin = useAuthStore((s) => s.user?.roleName === "admin");
  const [notice, setNotice] = useState<{ kind: string; text: string } | null>(null);
  const [modal, setModal] = useState<{ mode: "create" | "edit"; ch?: any } | null>(null);
  const [deliveryCh, setDeliveryCh] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(null), 3000); return () => clearTimeout(t); }, [notice]);
  const q = useQuery({ queryKey: ["notification-channels"], queryFn: () => api.get<any[]>("/notification-channels") });
  const createMut = useMutation({
    mutationFn: (payload: any) => api.post<any>("/notification-channels", payload),
    onSuccess: (c) => { queryClient.invalidateQueries({ queryKey: ["notification-channels"] }); setModal(null); setNotice({ kind: "success", text: `通知渠道「${c.name}」创建成功` }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "创建失败" }),
  });
  const updateMut = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) => api.patch<any>(`/notification-channels/${id}`, payload),
    onSuccess: (c) => { queryClient.invalidateQueries({ queryKey: ["notification-channels"] }); setModal(null); setNotice({ kind: "success", text: `通知渠道「${c.name}」保存成功` }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "保存失败" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/notification-channels/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["notification-channels"] }); setDeleting(null); setNotice({ kind: "success", text: "通知渠道已删除" }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "删除失败" }),
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.post<any>(`/notification-channels/${id}/${enabled ? "enable" : "disable"}`),
    onSuccess: (_d, v) => { queryClient.invalidateQueries({ queryKey: ["notification-channels"] }); setNotice({ kind: "success", text: v.enabled ? "已启用" : "已停用" }); },
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "操作失败" }),
  });
  const testMut = useMutation({
    mutationFn: (id: string) => api.post<any>(`/notification-channels/${id}/test-send`),
    onSuccess: () => setNotice({ kind: "success", text: "测试推送已触发" }),
    onError: (e) => setNotice({ kind: "error", text: isApiError(e) ? e.message : "测试推送失败" }),
  });
  const channels: any[] = (q.data as any) ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <div style={{ flex: 1 }}><div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[800] }}>通知渠道（出站）</div><div style={{ fontSize: fontSize.sm, color: neutral[500] }}>出站通知，按任务绑定与事件分发</div></div>
        {isAdmin && <button type="button" data-testid="create-notification-channel-button" onClick={() => setModal({ mode: "create" })} style={{ padding: `${space.sm + 1}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", cursor: "pointer", fontFamily: fontFamily.body }}>＋ 新建通知渠道</button>}
      </div>
      {notice && <div role="status" data-testid="notification-notice" data-kind={notice.kind} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: notice.kind === "success" ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)", border: "1px solid rgba(16,185,129,0.28)", color: notice.kind === "success" ? "#065F46" : "#DC2626", fontSize: fontSize.sm }}>{notice.text}</div>}
      {q.isPending ? <div style={{ color: neutral[400], textAlign: "center", padding: space.xl }}>加载中…</div> : channels.length === 0 ? <div data-testid="notification-empty" style={{ color: neutral[400], textAlign: "center", padding: space.xl, border: `1px dashed ${neutral[200]}`, borderRadius: radius.lg }}>暂无通知渠道</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          {channels.map((ch) => {
            const theme = notifTypeTheme[ch.type] ?? notifTypeTheme.webhook;
            const events = (ch.config as any)?.events ?? [];
            const targetUrl = (ch.config as any)?.targetUrl ?? "";
            return (
              <div key={ch.id} data-testid="notification-channel-item" data-channel-id={ch.id} data-type={ch.type} style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.lg}px ${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, ...baseFont }}>
                <span aria-hidden style={{ width: 40, height: 40, borderRadius: radius.md, display: "inline-flex", alignItems: "center", justifyContent: "center", backgroundColor: theme.color + "14", color: theme.color }}>◈</span>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[500], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{targetUrl || (events as string[]).join(", ") || "—"}</span>
                </div>
                <Pill theme={theme} label={theme.label} testid="notification-type-badge" status={ch.type} />
                {isAdmin ? <button type="button" data-testid="notification-enabled-toggle" data-enabled={ch.enabled ? "true" : "false"} onClick={() => toggleMut.mutate({ id: ch.id, enabled: !ch.enabled })} style={{ padding: `${space.xs}px ${space.sm + 2}px`, borderRadius: radius.pill, border: `1px solid ${ch.enabled ? "rgba(16,185,129,0.28)" : neutral[200]}`, backgroundColor: ch.enabled ? "rgba(16,185,129,0.10)" : neutral[100], color: ch.enabled ? "#059669" : neutral[500], cursor: "pointer", fontSize: fontSize.sm }}>{ch.enabled ? "已启用" : "已停用"}</button> : <Pill theme={{ color: ch.enabled ? "#059669" : neutral[500], bg: ch.enabled ? "rgba(16,185,129,0.10)" : neutral[100], border: ch.enabled ? "rgba(16,185,129,0.28)" : neutral[200] }} label={ch.enabled ? "已启用" : "已停用"} testid="notification-enabled-badge" status={ch.enabled ? "enabled" : "disabled"} />}
                <div style={{ display: "flex", gap: space.xs }}>
                  <button type="button" data-testid="notification-delivery-button" onClick={() => setDeliveryCh(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.sm }}>投递</button>
                  {isAdmin && <>
                    <button type="button" data-testid="notification-edit-button" onClick={() => setModal({ mode: "edit", ch })} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.sm }}>编辑</button>
                    <button type="button" data-testid="notification-test-send-button" onClick={() => testMut.mutate(ch.id)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: "#2563EB", cursor: "pointer", fontSize: fontSize.sm }}>测试推送</button>
                    <button type="button" data-testid="notification-delete-button" onClick={() => setDeleting(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "rgba(239,68,68,0.10)", color: "#DC2626", cursor: "pointer", fontSize: fontSize.sm }}>删除</button>
                  </>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {modal && <NotificationChannelModal mode={modal.mode} channel={modal.ch} submitting={createMut.isPending || updateMut.isPending} error={null} onClose={() => setModal(null)} onSave={(payload) => {
        if (modal.mode === "create") createMut.mutate(payload);
        else {
          const body: any = { name: payload.name, type: payload.type, config: payload.config };
          if (payload.secrets && Object.keys(payload.secrets).length) body.secrets = payload.secrets;
          updateMut.mutate({ id: modal.ch.id, payload: body });
        }
      }} />}
      {deleting && <ConfirmDialog open onClose={() => setDeleting(null)} onConfirm={() => deleteMut.mutate(deleting.id)} title="删除通知渠道" description={`确认删除「${deleting.name}」？`} confirmLabel="删除" />}
      {deliveryCh && <DeliveryDrawer channelId={deliveryCh.id} basePath="/notification-channels" channelName={deliveryCh.name} onClose={() => setDeliveryCh(null)} />}
    </div>
  );
}

function NotificationChannelModal({ mode, channel, submitting, error, onClose, onSave }: { mode: "create" | "edit"; channel?: any; submitting: boolean; error: string | null; onClose: () => void; onSave: (p: any) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("webhook");
  const [targetUrl, setTargetUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["task.status_changed", "agent.question"]);
  const [secret, setSecret] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    if (channel) {
      setName(channel.name ?? "");
      setType(channel.type ?? "webhook");
      const cfg = (channel.config ?? {}) as any;
      setTargetUrl(cfg.targetUrl ?? "");
      setEvents(Array.isArray(cfg.events) ? cfg.events : ["task.status_changed"]);
      setSecret("");
    } else {
      setName(""); setType("webhook"); setTargetUrl(""); setEvents(["task.status_changed", "agent.question"]); setSecret("");
    }
    setFormError(null);
  }, [channel, mode]);
  const toggleEvent = (v: string) => setEvents((prev) => prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]);
  const handleSubmit = () => {
    if (!name.trim()) { setFormError("请填写渠道名称"); return; }
    if (type === "webhook" && !targetUrl.trim()) { setFormError("请填写 targetUrl"); return; }
    if (!events.length) { setFormError("请选择至少一个事件"); return; }
    try { if (targetUrl.trim()) { const u = new URL(targetUrl.trim()); if (!/^https?:$/.test(u.protocol)) throw new Error("invalid"); } } catch { setFormError("targetUrl 需为合法 http(s) 地址"); return; }
    const config: any = { events, targetUrl: targetUrl.trim() };
    const secrets: any = {};
    if (secret.trim()) secrets.secret = secret.trim();
    const filtered: any = {};
    for (const [k, v] of Object.entries(secrets)) if (String(v).trim() !== "") filtered[k] = v;
    onSave({ name: name.trim(), type, config, secrets: filtered });
  };
  return (
    <div data-testid="notification-channel-modal" style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "6%" }}>
      <div aria-hidden onClick={onClose} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
      <div style={{ position: "relative", width: 520, maxWidth: "calc(100% - 48px)", maxHeight: "78vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: space.lg, padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg, fontFamily: fontFamily.body }}>
        <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>{mode === "create" ? "新建通知渠道" : `编辑通知渠道 ${channel?.name ?? ""}`}</div>
        <FieldRow label="名称"><input data-testid="notification-name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如 notify-prod" style={modalInputStyle} /></FieldRow>
        <FieldRow label="类型">
          <div style={{ display: "flex", gap: space.sm }}>
            {(["webhook", "wecom_group_robot"] as const).map((t) => (
              <button key={t} type="button" data-testid={`notification-type-${t}`} data-active={type === t ? "true" : "false"} onClick={() => setType(t)} style={{ flex: 1, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: type === t ? "1px solid #2563EB" : `1px solid ${neutral[200]}`, backgroundColor: type === t ? "rgba(37,99,235,0.10)" : "var(--color-surface)", color: type === t ? "#1E40AF" : neutral[600], cursor: "pointer", fontSize: fontSize.sm, fontWeight: type === t ? 600 : 500 }}>{notifTypeTheme[t].label}</button>
            ))}
          </div>
        </FieldRow>
        <FieldRow label="目标 URL (targetUrl)">
          <input data-testid="notification-targetUrl-input" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="https://example.com/webhook" style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} />
        </FieldRow>
        <FieldRow label="事件订阅">
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
            {NOTIF_EVENTS.map((opt) => (
              <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: space.sm, cursor: "pointer", fontSize: fontSize.md, color: neutral[700] }}>
                <input type="checkbox" data-testid={`notification-event-${opt.value}`} checked={events.includes(opt.value)} onChange={() => toggleEvent(opt.value)} />
                <span style={{ fontFamily: fontFamily.mono, fontSize: fontSize.sm }}>{opt.value}</span><span style={{ color: neutral[500], fontSize: fontSize.sm }}>({opt.label})</span>
              </label>
            ))}
          </div>
        </FieldRow>
        <FieldRow label="密钥 (secret)"><input data-testid="notification-secret-input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={mode === "edit" ? "•••••••• (保持不变)" : "可选"} style={{ ...modalInputStyle, fontFamily: fontFamily.mono }} /></FieldRow>
        {(error || formError) && <div role="alert" data-testid="notification-modal-error" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", color: "#DC2626", fontSize: fontSize.sm }}>{error ?? formError}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button type="button" data-testid="notification-modal-cancel" onClick={onClose} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>取消</button>
          <button type="button" data-testid="notification-modal-confirm" disabled={submitting} onClick={handleSubmit} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#2563EB", color: "#FFF", cursor: "pointer", opacity: submitting ? 0.6 : 1 }}>{submitting ? "保存中…" : mode === "create" ? "创建" : "保存"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Main Page with dual tabs ----------
export default function IntegrationsPage() {
  const [activeTab, setActiveTab] = useState<"message" | "notification">("message");
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: space.lg, padding: `${space.xl}px`, backgroundColor: neutral[50], overflowY: "auto", ...baseFont }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: fontSize.xxl, fontWeight: 700, color: neutral[900], lineHeight: 1.2 }}>外部渠道</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[500], marginTop: space.xs }}>消息渠道（入站）与通知渠道（出站）统一管理，任务侧绑定生效</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: space.sm, borderBottom: `1px solid ${neutral[200]}`, paddingBottom: space.sm }}>
        <button type="button" data-testid="integration-tab-message" data-active={activeTab === "message" ? "true" : "false"} onClick={() => setActiveTab("message")} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: activeTab === "message" ? "1px solid #2563EB" : `1px solid ${neutral[200]}`, backgroundColor: activeTab === "message" ? "#2563EB" : "var(--color-surface)", color: activeTab === "message" ? "#FFF" : neutral[600], cursor: "pointer", fontWeight: activeTab === "message" ? 600 : 500, fontFamily: fontFamily.body }}>消息渠道</button>
        <button type="button" data-testid="integration-tab-notification" data-active={activeTab === "notification" ? "true" : "false"} onClick={() => setActiveTab("notification")} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: activeTab === "notification" ? "1px solid #2563EB" : `1px solid ${neutral[200]}`, backgroundColor: activeTab === "notification" ? "#2563EB" : "var(--color-surface)", color: activeTab === "notification" ? "#FFF" : neutral[600], cursor: "pointer", fontWeight: activeTab === "notification" ? 600 : 500, fontFamily: fontFamily.body }}>通知渠道</button>
      </div>
      <div data-testid="integration-tab-panel" data-tab={activeTab}>
        {activeTab === "message" ? <MessageChannelsTab /> : <NotificationChannelsTab />}
      </div>
    </div>
  );
}
