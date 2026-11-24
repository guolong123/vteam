"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { ConfirmDialog, PageWindow, SegmentedTabs } from "@/src/components/ui";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";
import { EmptyState, PrimaryButton, SectionTitle } from "@/src/components/ui";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ---------------- Webhook 消息策略（过滤 + 模板 + 路由）前端类型 ----------------
 * 与 server/src/message-channels/message-policy.util.ts 对齐；
 * config.messagePolicies[event] 存储（per-event，零迁移）。
 */
type PolicyAction = "deliver" | "discard";
type PolicyOp = "eq" | "neq" | "contains" | "regex" | "exists" | "in";
interface PolicyCondition { id: string; path: string; op: PolicyOp; value: string }
interface PolicyRule {
  id: string; name: string; enabled: boolean; logic: "and" | "or";
  conditions: PolicyCondition[]; action: PolicyAction;
}
interface PolicyVar { id: string; name: string; path: string; fallback: string }
interface PolicyTargets { mode: "teams" | "member"; teams: string[]; member?: string; route: "main" | "mention" }
interface MessagePolicy {
  enabled: boolean; defaultAction: PolicyAction;
  filters: PolicyRule[];
  template: { variables: PolicyVar[]; content: string };
  targets: PolicyTargets;
}
const POLICY_OP_LABELS: Record<PolicyOp, string> = {
  eq: "等于", neq: "不等于", contains: "包含", regex: "正则匹配", exists: "存在", in: "属于",
};
/** 按渠道类型预填充的事件列表（与后端 adapter 的内置模板 key 对齐） */
const EVENTS_BY_TYPE: Record<string, string[]> = {
  gitee_webhook: ["push_hooks", "tag_push_hooks", "issue_hooks", "merge_request_hooks", "note_hooks", "_default"],
  github_webhook: ["push", "pull_request", "issues", "issue_comment", "pull_request_review", "release", "star", "create", "delete", "fork", "ping", "check_run", "deployment", "_default"],
  generic_webhook: ["push_hooks", "issue_hooks", "issue_comment", "push", "pull_request", "issues", "_default"],
};
const DEFAULT_EVENTS = EVENTS_BY_TYPE.generic_webhook;

/** 内置字段模板（与后端 GITEE_BUILTIN_TEMPLATES / GITHUB_BUILTIN_TEMPLATES 对齐），用于新事件预填充 */
type BuiltinTpl = { content: string; source: string; user: string };
const BUILTIN_TPL: Record<string, Record<string, BuiltinTpl>> = {
  gitee_webhook: {
    push_hooks: { content: "{{ head_commit.message }}", source: "{{ project.path_with_namespace }}", user: "{{ pusher.name }}" },
    tag_push_hooks: { content: "{{ ref }}", source: "{{ project.path_with_namespace }}", user: "{{ pusher.name }}" },
    issue_hooks: { content: "{{ issue.title }}", source: "{{ project.path_with_namespace }}", user: "{{ sender.login }}" },
    merge_request_hooks: { content: "{{ pull_request.title }}", source: "{{ project.path_with_namespace }}", user: "{{ sender.login }}" },
    note_hooks: { content: "{{ comment.body }}", source: "{{ project.path_with_namespace }}", user: "{{ sender.login }}" },
  },
  github_webhook: {
    push: { content: "{{ head_commit.message }}", source: "{{ repository.full_name }}", user: "{{ pusher.name }}" },
    pull_request: { content: "{{ pull_request.title }} - {{ pull_request.body }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
    issues: { content: "{{ issue.title }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
    issue_comment: { content: "{{ comment.body }}", source: "{{ repository.full_name }}", user: "{{ comment.user.login }}" },
    pull_request_review: { content: "{{ review.body }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
    release: { content: "{{ release.tag_name }} {{ release.name }}", source: "{{ repository.full_name }}", user: "{{ sender.login }}" },
  },
  generic_webhook: {
    _default: { content: "{{ text }}", source: "{{ source }}", user: "{{ sender }}" },
  },
};

/** 渠道在当前类型下已配置策略的事件数（用于列表徽标） */
function configuredEventCount(ch: any): number {
  const policies = ch?.config?.messagePolicies ?? {};
  const typeEvents = EVENTS_BY_TYPE[ch?.type] ?? DEFAULT_EVENTS;
  return typeEvents.filter((k) => !!policies[k]).length;
}

/** 从 "{{ issue.title }}" 提取 "issue.title" */
function tplPath(tpl: string): string {
  const m = tpl.match(/\{\{\s*([^}]+)\s*\}\}/);
  return m ? m[1].trim() : "";
}

/** 为某渠道类型/事件生成预填充策略（变量+正文来自内置模板，默认放行） */
function presetPolicy(channelType: string, event: string): MessagePolicy {
  const tpl = (BUILTIN_TPL[channelType] ?? {})[event];
  if (!tpl) return clonePolicy(EMPTY_POLICY);
  return {
    enabled: true,
    defaultAction: "deliver",
    filters: [],
    template: {
      variables: [
        { id: `v_c_${event}`, name: "content", path: tplPath(tpl.content), fallback: "" },
        { id: `v_s_${event}`, name: "source", path: tplPath(tpl.source), fallback: "" },
        { id: `v_u_${event}`, name: "user", path: tplPath(tpl.user), fallback: "" },
      ],
      content: "[{{source}}] {{user}}: {{content}}",
    },
    targets: { mode: "teams", teams: [], route: "main" },
  };
}

const EMPTY_POLICY: MessagePolicy = {
  enabled: true, defaultAction: "discard", filters: [],
  template: { variables: [], content: "" },
  targets: { mode: "teams", teams: [], route: "main" },
};

function pGet(data: any, path: string): any {
  if (!path) return undefined;
  const parts = path.split(".");
  let cur: any = data;
  for (const p of parts) {
    if (cur == null) return undefined;
    const normalized = p.replace(/\[(\d+)\]/g, ".$1");
    for (const sp of normalized.split(".")) {
      if (sp === "") continue;
      if (cur == null) return undefined;
      cur = Array.isArray(cur) && /^\d+$/.test(sp) ? cur[Number(sp)] : cur[sp];
      if (cur === undefined) return undefined;
    }
  }
  return cur;
}
function pMatchCondition(cond: PolicyCondition, data: any): boolean {
  const raw = pGet(data, cond.path);
  if (cond.op === "exists") return raw !== undefined && raw !== null;
  const val = String(raw ?? "");
  switch (cond.op) {
    case "eq": return val === cond.value;
    case "neq": return val !== cond.value;
    case "contains": return val.includes(cond.value);
    case "regex": try { return new RegExp(cond.value).test(val); } catch { return false; }
    case "in": return cond.value.split(",").map((s) => s.trim()).includes(val);
    default: return false;
  }
}
function pExtractVars(vars: PolicyVar[], data: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars ?? []) {
    const raw = pGet(data, v.path);
    out[v.name] = raw === undefined || raw === null || raw === "" ? (v.fallback ?? "") : String(raw);
  }
  return out;
}
function pRender(template: string, vars: Record<string, string>): string {
  return (template ?? "").replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, k: string) => vars[k.trim()] ?? "");
}
interface PolicyTestResult {
  action: PolicyAction; matchedRule?: PolicyRule;
  variables: Record<string, string>; rendered: string;
}
function pRunTest(policy: MessagePolicy, sample: string): PolicyTestResult | { error: string } {
  let data: any;
  try { data = JSON.parse(sample); } catch { return { error: "示例 JSON 解析失败，请检查格式" }; }
  let matchedRule: PolicyRule | undefined;
  let action: PolicyAction = policy.defaultAction;
  for (const rule of policy.filters ?? []) {
    if (!rule.enabled || rule.conditions.length === 0) continue;
    const results = rule.conditions.map((c) => pMatchCondition(c, data));
    const ok = rule.logic === "and" ? results.every(Boolean) : results.some(Boolean);
    if (ok) { matchedRule = rule; action = rule.action; break; }
  }
  const variables = pExtractVars(policy.template.variables, data);
  return { action, matchedRule, variables, rendered: pRender(policy.template.content, variables) };
}

function clonePolicy(p: MessagePolicy): MessagePolicy {
  return JSON.parse(JSON.stringify(p));
}

/** 抽屉左边缘拖拽调整宽度：返回宽度与 mousedown 处理器 */
function useResizableWidth(initial: number, min = 360, max = 1200) {
  const [width, setWidth] = useState(initial);
  const dragging = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      // 抽屉在右侧：鼠标左移（e.clientX 变小）→ 宽度变大
      const delta = dragging.current.startX - e.clientX;
      const next = Math.min(max, Math.max(min, dragging.current.startW + delta));
      setWidth(next);
    };
    const onUp = () => { dragging.current = null; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [min, max]);
  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = { startX: e.clientX, startW: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  };
  return { width, onMouseDown };
}

/** 抽屉左边缘拖拽手柄 */
function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div data-testid="drawer-resize-handle" onMouseDown={onMouseDown} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      title="拖拽调整宽度"
      style={{ position: "absolute", left: -4, top: 0, bottom: 0, width: 10, cursor: "col-resize", zIndex: 2, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 3, height: 36, borderRadius: 2, background: hover ? "var(--color-accent-text)" : neutral[300], transition: "background .15s" }} />
    </div>
  );
}

/** 根据渠道类型/事件/示例载荷生成可直接执行的 curl 测试命令（验签头给占位提示，secret 前端不可见） */
function buildCurlSample(channel: any, event: string, sample: string): string {
  const inbound = `${typeof window !== "undefined" ? window.location.origin.replace(":13001", ":13000") : ""}/api/v1/message-channels/${channel?.id ?? "{id}"}/inbound`;
  const eventHeader =
    channel?.type === "gitee_webhook" ? "X-Gitee-Event" :
    channel?.type === "github_webhook" ? "X-GitHub-Event" : "X-Vteam-Event";
  let signHint = "";
  if (channel?.type === "gitee_webhook") signHint = "  -H 'X-Gitee-Token: <你的 Secret>' \\\n";
  else if (channel?.type === "github_webhook") signHint = "  -H 'X-Hub-Signature-256: sha256=<用 Secret 对 body 算 HMAC-SHA256>' \\\n";
  else signHint = "  -H 'X-Vteam-Signature: sha256=<用 Secret 对 body 算 HMAC-SHA256>' \\\n";
  // body 内单引号做 shell 转义，保证 -d '...' 不破
  const body = sample.replace(/'/g, "'\\''");
  return [
    `curl -X POST '${inbound}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H '${eventHeader}: ${event}' \\`,
    signHint.replace(/\n$/, ""),
    `  -d '${body}'`,
  ].join("\n");
}

const messageTypeTheme: Record<string, { label: string; color: string; bg: string; border: string; iconBg: string }> = {
  generic_webhook: { label: "通用 Webhook", color: "#0D9488", bg: "var(--color-accent-soft)", border: "rgba(13,148,136,0.22)", iconBg: "var(--color-accent-soft)" },
  wecom_aibot: { label: "企微机器人", color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4", iconBg: "rgba(13,148,136,0.12)" },
  // GitHub 用主题自适应中性色，避免暗色模式下深灰图标/白底徽章看不清
  github_webhook: { label: "GitHub", color: neutral[700], bg: neutral[100], border: neutral[200], iconBg: neutral[100] },
  // Gitee 用主题自适应中性色（避免红色在深色主题下像异常/错误状态）
  gitee_webhook: { label: "Gitee", color: neutral[700], bg: neutral[100], border: neutral[200], iconBg: neutral[100] },
};

const notifTypeTheme: Record<string, { label: string; color: string; bg: string; border: string; iconBg: string }> = {
  webhook: { label: "Webhook", color: "#0D9488", bg: "var(--color-accent-soft)", border: "rgba(13,148,136,0.22)", iconBg: "var(--color-accent-soft)" },
  wecom_group_robot: { label: "企微群机器人", color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4", iconBg: "rgba(13,148,136,0.12)" },
};

const messageStatusTheme: Record<string, { label: string; color: string; bg: string; border: string }> = {
  connecting: { label: "连接中", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.24)" },
  connected: { label: "已连接", color: "var(--color-success-text)", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  reconnecting: { label: "重连中", color: "#D97706", bg: "rgba(251,191,36,0.12)", border: "rgba(251,191,36,0.32)" },
  error: { label: "连接失败", color: "var(--color-danger-text)", bg: "var(--color-danger-soft)", border: "rgba(239,68,68,0.22)" },
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

/** 投递日志展开详情：请求信息 / 策略执行 / 返回信息 */
function DeliveryDetail({ d }: { d: any }) {
  const meta = d.meta ?? {};
  const req = meta.requestInfo;
  const resp = meta.responseInfo;
  const section: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)" };
  const label: CSSProperties = { fontSize: fontSize.xs, color: neutral[500] };
  const code: CSSProperties = { fontFamily: fontFamily.mono, fontSize: fontSize.xs, color: neutral[700], wordBreak: "break-all", whiteSpace: "pre-wrap" };
  const json = (o: any) => { try { return JSON.stringify(o, null, 2); } catch { return String(o); } };
  return (
    <div data-testid="integration-delivery-meta" style={{ marginTop: space.sm, paddingTop: space.sm, borderTop: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.sm }}>
      {/* 请求信息 */}
      <div style={section}>
        <div style={{ fontSize: fontSize.xs, fontWeight: 600, color: "var(--color-accent-text)", marginBottom: 2 }}>请求信息</div>
        {req ? (
          <>
            <div style={label}>{`${req.method ?? "POST"} ${req.contentType ?? ""}`}</div>
            {req.headers && Object.keys(req.headers).length > 0 && (
              <div style={label}>Headers：<code data-testid="delivery-detail-headers" style={code}>{json(req.headers)}</code></div>
            )}
          </>
        ) : <div style={label}>（本条无策略请求信息，可能为旧数据 / 非策略消息 / 其他 kind）</div>}
        {meta.rawPayload && (
          <div style={label}>原始 Webhook JSON：<code data-testid="delivery-detail-raw" style={code}>{json(meta.rawPayload)}</code></div>
        )}
        {d.payload && !meta.rawPayload && (
          <div style={label}>归一化载荷：<code style={code}>{json(d.payload)}</code></div>
        )}
      </div>

      {/* 策略执行 */}
      {(meta.event || meta.action || meta.variables || meta.rendered || meta.ruleReason) && (
        <div style={section}>
          <div style={{ fontSize: fontSize.xs, fontWeight: 600, color: "var(--color-accent-text)", marginBottom: 2 }}>策略执行</div>
          {meta.event && <div style={label}>事件：<code style={code}>{String(meta.event)}</code></div>}
          {meta.matchedRuleId && <div style={label}>命中规则：<code style={code}>{String(meta.matchedRuleId)}</code></div>}
          {meta.action && <div style={label}>动作：<span style={{ color: meta.action === "deliver" ? "var(--color-success-text)" : "var(--color-danger-text)" }}>{String(meta.action)}</span></div>}
          {meta.ruleReason && <div style={label}>原因：{String(meta.ruleReason)}</div>}
          {meta.variables && Object.keys(meta.variables).length > 0 && <div style={label}>提取变量：<code data-testid="delivery-detail-vars" style={code}>{json(meta.variables)}</code></div>}
          {meta.rendered && <div style={label}>渲染正文：<code style={code}>{String(meta.rendered)}</code></div>}
          {meta.deliveryTarget && <div style={label}>投递目标：<code style={code}>{json(meta.deliveryTarget)}</code></div>}
        </div>
      )}

      {/* 返回信息 */}
      <div style={section}>
        <div style={{ fontSize: fontSize.xs, fontWeight: 600, color: "var(--color-accent-text)", marginBottom: 2 }}>返回信息</div>
        <div style={label}>状态：<span style={{ color: d.status === "ok" ? "var(--color-success-text)" : d.status === "failed" ? "var(--color-danger-text)" : neutral[500] }}>{String(d.status)}</span>{d.error ? ` · ${String(d.error)}` : ""}</div>
        {resp && (
          <>
            <div style={label}>HTTP：<code style={code}>{resp.httpStatus ?? 200}</code> · ok=<code style={code}>{String(resp.ok)}</code> · delivered=<code style={code}>{String(resp.delivered)}</code></div>
            {resp.internalMessageId && <div style={label}>内部消息 ID：<code data-testid="delivery-detail-msg-id" style={code}>{String(resp.internalMessageId)}</code></div>}
            {resp.target && <div style={label}>投递目标：<code style={code}>{json(resp.target)}</code></div>}
            {resp.error && <div style={label}>错误：<span style={{ color: "var(--color-danger-text)" }}>{String(resp.error)}</span></div>}
          </>
        )}
        {d.externalId && <div style={label}>externalId：<code style={code}>{String(d.externalId)}</code></div>}
        <div style={label}>时间：<code style={code}>{new Date(d.createdAt).toLocaleString()}</code></div>
      </div>
    </div>
  );
}

// ---------- Generic Delivery Drawer ----------
function DeliveryDrawer({ channelId, basePath, channelName, onClose }: { channelId: string; basePath: string; channelName: string; onClose: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { width, onMouseDown } = useResizableWidth(480);
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
      <div style={{ position: "relative", width, maxWidth: "92%", backgroundColor: "var(--color-surface)", borderLeft: `1px solid ${neutral[200]}`, boxShadow: shadow.lg, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ResizeHandle onMouseDown={onMouseDown} />
        <div style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.lg}px ${space.xl}px`, borderBottom: `1px solid ${neutral[200]}` }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], flex: 1 }}>{`投递日志 · ${channelName}`}</span>
          <button type="button" data-testid="integration-delivery-close" onClick={onClose} style={{ width: 32, height: 32, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: space.lg, display: "flex", flexDirection: "column", gap: space.sm }}>
          {q.isPending && items.length === 0 ? <div style={{ color: neutral[400], textAlign: "center", padding: space.xl }}>加载中…</div> : items.length === 0 ? <div data-testid="integration-delivery-empty" style={{ color: neutral[400], textAlign: "center", padding: space.xl }}>暂无投递记录</div> : items.map((d: any) => (
            <div key={d.id} data-testid="integration-delivery-item" onClick={() => setExpanded(expanded === d.id ? null : d.id)} style={{ padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, display: "flex", flexDirection: "column", gap: space.xs, fontSize: fontSize.sm, cursor: "pointer" }}>
              <div style={{ display: "flex", gap: space.sm, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ color: neutral[500], fontSize: fontSize.xs }}>{new Date(d.createdAt).toLocaleString()}</span>
                <span style={{ padding: "1px 6px", borderRadius: radius.pill, backgroundColor: d.direction === "inbound" ? "rgba(124,58,237,0.10)" : "var(--color-accent-soft)", color: d.direction === "inbound" ? "#7C3AED" : "#0D9488", fontSize: fontSize.xs, border: "1px solid rgba(13,148,136,0.22)" }}>{d.direction ?? d.status}</span>
                <span style={{ padding: "1px 6px", borderRadius: radius.pill, backgroundColor: d.status === "ok" ? "rgba(16,185,129,0.10)" : d.status === "failed" ? "var(--color-danger-soft)" : neutral[100], color: d.status === "ok" ? "var(--color-success-text)" : d.status === "failed" ? "var(--color-danger-text)" : neutral[500], fontSize: fontSize.xs, border: "1px solid rgba(16,185,129,0.28)" }}>{d.status}</span>
              </div>
              {d.error && <div style={{ color: "var(--color-danger-text)", fontSize: fontSize.xs, wordBreak: "break-all" }}>{String(d.error)}</div>}
              {expanded === d.id && (d.meta || d.payload) && <DeliveryDetail d={d} />}
            </div>
          ))}
          {q.isError && <div role="alert" style={{ color: "var(--color-danger-text)", textAlign: "center", fontSize: fontSize.sm }}>{isApiError(q.error) ? q.error.message : "加载失败"}</div>}
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

/* ---------- Webhook 消息规则抽屉（过滤规则 + 模板 + 路由 + 测试） ---------- */
function PolicyDrawer({
  channel, teams, members, onClose, onSave,
}: {
  channel: any;
  teams: Array<{ id: string; name: string }>;
  members: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (policies: Record<string, MessagePolicy>) => void;
}) {
  const allPolicies: Record<string, MessagePolicy> = (channel.config?.messagePolicies ?? {}) as Record<string, MessagePolicy>;
  // 事件列表严格按渠道类型显示（让用户一眼看清当前渠道处理哪些消息类型）
  const typeEvents = EVENTS_BY_TYPE[channel?.type] ?? DEFAULT_EVENTS;
  const eventKeys = typeEvents;
  // 已保存但不属于本类型的历史配置（提示用户，但不混入列表）
  const hiddenLegacy = Object.keys(allPolicies).filter((k) => !typeEvents.includes(k));
  const firstConfigured = typeEvents.find((k) => !!allPolicies[k]);
  const [activeEvent, setActiveEvent] = useState<string>(firstConfigured ?? typeEvents[0]);
  const [policies, setPolicies] = useState<Record<string, MessagePolicy>>(() => {
    const init: Record<string, MessagePolicy> = {};
    for (const k of eventKeys) init[k] = allPolicies[k] ? clonePolicy(allPolicies[k]) : presetPolicy(channel?.type, k);
    return init;
  });
  const [dirtyEvents, setDirtyEvents] = useState<Set<string>>(() => new Set(Object.keys(allPolicies)));
  const [sample, setSample] = useState<string>(() => {
    const isGitee = channel?.type === "gitee_webhook";
    return isGitee
      ? "{\n  \"action\": \"opened\",\n  \"issue\": { \"title\": \"修复登录超时\", \"state\": \"open\", \"html_url\": \"https://gitee.com/acme/web/issues/128\" },\n  \"project\": { \"path_with_namespace\": \"acme/web\" },\n  \"sender\": { \"login\": \"alice\", \"type\": \"User\" }\n}"
      : "{\n  \"action\": \"opened\",\n  \"issue\": { \"title\": \"修复登录超时\", \"state\": \"open\", \"html_url\": \"https://github.com/acme/web/issues/128\" },\n  \"repository\": { \"full_name\": \"acme/web\" },\n  \"sender\": { \"login\": \"alice\", \"type\": \"User\" }\n}";
  });
  const [testResult, setTestResult] = useState<PolicyTestResult | { error: string } | null>(null);
  const [curlCopied, setCurlCopied] = useState(false);
  // 「开始监听」：轮询投递日志，采集真实 Webhook 原始载荷作为测试来源数据
  const [listening, setListening] = useState(false);
  const [captured, setCaptured] = useState<Array<{ id: string; at: string; event: string; raw: string; status: string }>>([]);
  const listenTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const cur = policies[activeEvent] ?? clonePolicy(EMPTY_POLICY);

  async function pollDeliveries() {
    try {
      const res = await api.get<{ items: any[] }>(`/message-channels/${channel.id}/deliveries`, { query: { limit: "20" } });
      const withRaw = (res.items ?? []).filter((d: any) => d.meta?.rawPayload);
      const news = withRaw.filter((d: any) => !seenIds.current.has(d.id));
      if (news.length === 0) return;
      news.forEach((d: any) => seenIds.current.add(d.id));
      const mapped = news.map((d: any) => ({
        id: d.id,
        at: new Date(d.createdAt).toLocaleTimeString(),
        event: String(d.meta?.event ?? "-"),
        status: String(d.status ?? "-"),
        raw: JSON.stringify(d.meta.rawPayload, null, 2),
      }));
      setCaptured((prev) => [...mapped.reverse(), ...prev].slice(0, 30));
    } catch { /* 监听期间单次轮询失败不影响后续 */ }
  }
  function toggleListen() {
    if (listening) {
      if (listenTimer.current) { clearInterval(listenTimer.current); listenTimer.current = null; }
      setListening(false);
    } else {
      // 首次开启时把已有带 rawPayload 的日志作为基线（不重复弹出）
      api.get<{ items: any[] }>(`/message-channels/${channel.id}/deliveries`, { query: { limit: "20" } })
        .then((res) => { (res.items ?? []).filter((d: any) => d.meta?.rawPayload).forEach((d: any) => seenIds.current.add(d.id)); })
        .catch(() => {});
      listenTimer.current = setInterval(pollDeliveries, 3000);
      setListening(true);
    }
  }
  useEffect(() => () => { if (listenTimer.current) clearInterval(listenTimer.current); }, []);

  function copyCurl() {
    const cmd = buildCurlSample(channel, activeEvent, sample);
    const done = () => { setCurlCopied(true); window.setTimeout(() => setCurlCopied(false), 1600); };
    const legacyCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = cmd; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      if (ok) done();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(cmd).then(done).catch(legacyCopy);
    else legacyCopy();
  }

  function updateCur(patch: Partial<MessagePolicy>) {
    setPolicies((prev) => ({ ...prev, [activeEvent]: { ...(prev[activeEvent] ?? clonePolicy(EMPTY_POLICY)), ...patch } }));
    setDirtyEvents((prev) => new Set(prev).add(activeEvent));
  }
  function updRule(ruleId: string, patch: Partial<PolicyRule>) {
    updateCur({ filters: cur.filters.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)) });
  }
  function updCond(ruleId: string, condId: string, patch: Partial<PolicyCondition>) {
    updateCur({ filters: cur.filters.map((r) => r.id === ruleId
      ? { ...r, conditions: r.conditions.map((c) => (c.id === condId ? { ...c, ...patch } : c)) } : r) });
  }
  const tinyBtn: CSSProperties = { padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.xs, color: neutral[600], ...baseFont };
  const tinyInput: CSSProperties = { ...modalInputStyle, padding: `${space.xs}px ${space.sm}px`, fontSize: fontSize.xs };
  const { width, onMouseDown } = useResizableWidth(720);

  return (
    <div data-testid="integration-policy-drawer" style={{ position: "absolute", inset: 0, zIndex: 45, display: "flex", justifyContent: "flex-end", ...baseFont }}>
      <div aria-hidden onClick={onClose} style={{ flex: 1, backgroundColor: "rgba(15,23,42,.32)" }} />
      <div style={{ position: "relative", width, maxWidth: "94%", height: "100%", backgroundColor: "var(--color-surface)", borderLeft: `1px solid ${neutral[200]}`, boxShadow: shadow.lg, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ResizeHandle onMouseDown={onMouseDown} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${space.lg}px ${space.xl}px`, borderBottom: `1px solid ${neutral[200]}` }}>
          <div>
            <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>{`消息处理 · ${channel.name}`}</div>
            <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: 2 }}>过滤规则 → 字段提取 → 消息模板 → 投递目标，按事件独立配置</div>
          </div>
          <button type="button" data-testid="integration-policy-close" onClick={onClose} style={{ width: 32, height: 32, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>×</button>
        </div>

        <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
          {/* 事件列表 */}
          <aside style={{ width: 160, flexShrink: 0, borderRight: `1px solid ${neutral[200]}`, background: neutral[50], padding: space.md, overflowY: "auto" }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".04em", color: neutral[400], marginBottom: 2 }}>{messageTypeTheme[channel?.type]?.label ?? "Webhook"} 事件</div>
            <div style={{ fontSize: 10, color: neutral[400], marginBottom: space.sm }}>已配置 {eventKeys.filter((k) => !!allPolicies[k]).length} 个</div>
            {hiddenLegacy.length > 0 && (
              <div style={{ fontSize: 10, color: neutral[400], background: neutral[100], borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px`, marginBottom: space.sm, lineHeight: 1.5 }}>
                另有 {hiddenLegacy.length} 个非本类型历史事件配置已隐藏
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {eventKeys.map((k) => (
                <button key={k} type="button" data-testid={`integration-policy-event-${k}`}
                  onClick={() => { setActiveEvent(k); setTestResult(null); }}
                  style={{ width: "100%", textAlign: "left", padding: `${space.sm}px ${space.md}px`, border: "none", borderRadius: radius.sm, cursor: "pointer",
                    background: k === activeEvent ? "var(--color-accent-soft)" : "transparent", color: k === activeEvent ? "var(--color-accent-text)" : neutral[600],
                    fontSize: fontSize.xs, fontWeight: k === activeEvent ? 600 : 400, fontFamily: fontFamily.mono }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: allPolicies[k] ? "var(--color-accent-text)" : "transparent", border: allPolicies[k] ? "none" : `1px solid ${neutral[300]}`, flexShrink: 0 }} />
                    {k}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {/* 配置主体 */}
          <div style={{ minWidth: 0, flex: 1, overflowY: "auto", padding: `${space.lg}px ${space.xl}px`, display: "flex", flexDirection: "column", gap: space.xl }}>
            {/* ① 过滤规则 */}
            <section>
              <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900], marginBottom: space.md }}>① 过滤规则 <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>顺序匹配，首条命中即生效</span></div>
              <div style={{ marginBottom: space.md, padding: `${space.xs}px ${space.md}px`, borderRadius: radius.sm, background: "var(--color-accent-soft)", color: "var(--color-accent-text)", fontSize: fontSize.xs }}>
                ⚠ 规则自上而下匹配，首条命中即停止：请把「丢弃」类规则排在「放行」类规则之前，否则宽泛的放行规则会先命中导致丢弃规则失效。
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.sm}px ${space.md}px`, marginBottom: space.md, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, background: neutral[50] }}>
                <span style={{ fontSize: fontSize.xs, color: neutral[600] }}>启用策略</span>
                <input type="checkbox" data-testid="integration-policy-enabled" checked={cur.enabled} onChange={(e) => updateCur({ enabled: e.target.checked })} />
                <span style={{ fontSize: fontSize.xs, color: neutral[600], marginLeft: space.md }}>无规则命中时</span>
                <select data-testid="integration-policy-default-action" value={cur.defaultAction} onChange={(e) => updateCur({ defaultAction: e.target.value as PolicyAction })} style={tinyInput}>
                  <option value="discard">丢弃</option><option value="deliver">放行</option>
                </select>
                <button type="button" data-testid="integration-policy-rule-add" style={{ ...tinyBtn, marginLeft: "auto" }}
                  onClick={() => updateCur({ filters: [...cur.filters, { id: `r${Date.now()}`, name: "新规则", enabled: true, logic: "and", action: "deliver", conditions: [{ id: `c${Date.now()}`, path: "", op: "eq", value: "" }] }] })}>
                  ＋ 新增规则
                </button>
              </div>
              {cur.filters.length === 0 && <div style={{ padding: space.lg, textAlign: "center", fontSize: fontSize.xs, color: neutral[400], border: `1px dashed ${neutral[200]}`, borderRadius: radius.md }}>暂无规则，所有消息按「默认动作」处理</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
                {cur.filters.map((rule, ri) => (
                  <div key={rule.id} data-testid="integration-policy-rule" style={{ padding: space.md, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                      <span style={{ width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: radius.sm, background: neutral[100], color: neutral[500], fontSize: 10 }}>{ri + 1}</span>
                      <input data-testid="integration-policy-rule-name" value={rule.name} onChange={(e) => updRule(rule.id, { name: e.target.value })} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], ...baseFont }} />
                      <input type="checkbox" checked={rule.enabled} onChange={(e) => updRule(rule.id, { enabled: e.target.checked })} />
                      <button type="button" onClick={() => updateCur({ filters: cur.filters.filter((r) => r.id !== rule.id) })} style={{ ...tinyBtn, fontSize: fontSize.xs }}>删除</button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: space.sm }}>
                      {rule.conditions.map((cond, ci) => (
                        <div key={cond.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ width: 32, fontSize: fontSize.xs, color: neutral[400] }}>{ci === 0 ? "当" : rule.logic === "and" ? "并且" : "或者"}</span>
                          <input data-testid="integration-policy-cond-path" value={cond.path} placeholder="issue.state" onChange={(e) => updCond(rule.id, cond.id, { path: e.target.value })} style={{ ...tinyInput, width: 140, fontFamily: fontFamily.mono }} />
                          <select value={cond.op} onChange={(e) => updCond(rule.id, cond.id, { op: e.target.value as PolicyOp })} style={{ ...tinyInput, width: 88 }}>
                            {(Object.keys(POLICY_OP_LABELS) as PolicyOp[]).map((op) => <option key={op} value={op}>{POLICY_OP_LABELS[op]}</option>)}
                          </select>
                          {cond.op !== "exists" && <input value={cond.value} placeholder="值" onChange={(e) => updCond(rule.id, cond.id, { value: e.target.value })} style={{ ...tinyInput, width: 80 }} />}
                          <button type="button" onClick={() => updRule(rule.id, { conditions: rule.conditions.filter((c) => c.id !== cond.id) })} style={{ border: "none", background: "transparent", cursor: "pointer", color: neutral[400] }}>×</button>
                        </div>
                      ))}
                      <button type="button" onClick={() => updRule(rule.id, { conditions: [...rule.conditions, { id: `c${Date.now()}`, path: "", op: "eq", value: "" }] })} style={{ ...tinyBtn, marginLeft: 32, border: "none", color: "var(--color-accent-text)" }}>＋ 添加条件</button>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: space.sm, borderTop: `1px solid ${neutral[100]}`, marginTop: space.sm, paddingTop: space.sm }}>
                      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>命中后</span>
                      <select data-testid="integration-policy-rule-action" value={rule.action} onChange={(e) => updRule(rule.id, { action: e.target.value as PolicyAction })} style={tinyInput}>
                        <option value="deliver">放行</option><option value="discard">丢弃</option>
                      </select>
                      <select value={rule.logic} onChange={(e) => updRule(rule.id, { logic: e.target.value as "and" | "or" })} style={tinyInput}>
                        <option value="and">条件间 AND</option><option value="or">条件间 OR</option>
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* ② 消息模板 */}
            <section>
              <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900], marginBottom: space.md }}>② 消息模板 <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>从 JSON 提取变量，组合成一条用户消息</span></div>
              <div style={{ borderRadius: radius.md, border: `1px solid ${neutral[200]}`, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 90px 24px", gap: 6, padding: `${space.xs}px ${space.md}px`, background: neutral[50], fontSize: fontSize.xs, color: neutral[500] }}>
                  <span>变量名</span><span>JSON 路径</span><span>默认值</span><span />
                </div>
                {cur.template.variables.map((v) => (
                  <div key={v.id} style={{ display: "grid", gridTemplateColumns: "80px 1fr 90px 24px", gap: 6, padding: `${space.xs}px ${space.md}px`, borderTop: `1px solid ${neutral[100]}`, alignItems: "center" }}>
                    <input data-testid="integration-policy-var-name" value={v.name} onChange={(e) => updateCur({ template: { ...cur.template, variables: cur.template.variables.map((x) => x.id === v.id ? { ...x, name: e.target.value } : x) } })} style={{ ...tinyInput, fontFamily: fontFamily.mono }} />
                    <input data-testid="integration-policy-var-path" value={v.path} placeholder="issue.title" onChange={(e) => updateCur({ template: { ...cur.template, variables: cur.template.variables.map((x) => x.id === v.id ? { ...x, path: e.target.value } : x) } })} style={{ ...tinyInput, fontFamily: fontFamily.mono }} />
                    <input value={v.fallback} placeholder="默认值" onChange={(e) => updateCur({ template: { ...cur.template, variables: cur.template.variables.map((x) => x.id === v.id ? { ...x, fallback: e.target.value } : x) } })} style={tinyInput} />
                    <button type="button" onClick={() => updateCur({ template: { ...cur.template, variables: cur.template.variables.filter((x) => x.id !== v.id) } })} style={{ border: "none", background: "transparent", cursor: "pointer", color: neutral[400] }}>×</button>
                  </div>
                ))}
                <div style={{ padding: `${space.xs}px ${space.md}px`, borderTop: `1px solid ${neutral[100]}` }}>
                  <button type="button" data-testid="integration-policy-var-add" onClick={() => updateCur({ template: { ...cur.template, variables: [...cur.template.variables, { id: `v${Date.now()}`, name: "newVar", path: "", fallback: "" }] } })} style={{ ...tinyBtn, border: "none", color: "var(--color-accent-text)" }}>＋ 添加变量</button>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md, marginTop: space.md }}>
                <div>
                  <div style={{ fontSize: fontSize.xs, color: neutral[600], marginBottom: 6 }}>正文模板（{'{{变量名}}'}）</div>
                  <textarea data-testid="integration-policy-template" value={cur.template.content} onChange={(e) => updateCur({ template: { ...cur.template, content: e.target.value } })} rows={7}
                    style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: space.sm, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, fontFamily: fontFamily.mono, fontSize: fontSize.xs, lineHeight: 1.6, color: neutral[800], background: "var(--color-surface)", outline: "none" }} />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {cur.template.variables.map((v) => (
                      <button key={v.id} type="button" onClick={() => updateCur({ template: { ...cur.template, content: `${cur.template.content}{{${v.name}}}` } })} style={{ ...tinyBtn, fontFamily: fontFamily.mono, fontSize: 10 }}>{`{{${v.name}}}`}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: fontSize.xs, color: neutral[600], marginBottom: 6 }}>消息预览</div>
                  <div data-testid="integration-policy-preview" style={{ minHeight: 150, padding: space.md, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: neutral[50], fontSize: fontSize.sm, lineHeight: 1.9, color: neutral[700], whiteSpace: "pre-wrap" }}>
                    {pRender(cur.template.content, pExtractVars(cur.template.variables, (() => { try { return JSON.parse(sample); } catch { return {}; } })()))}
                  </div>
                </div>
              </div>
            </section>

            {/* ③ 投递目标 */}
            <section>
              <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900], marginBottom: space.md }}>③ 投递目标 <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>团队群聊（可多选）/ 成员私聊（唯一），二者互斥；不选则沿用渠道绑定</span></div>
              <button type="button" data-testid="integration-policy-mode-teams" onClick={() => updateCur({ targets: { ...cur.targets, mode: "teams", member: undefined } })}
                style={{ ...tinyBtn, borderColor: cur.targets.mode === "teams" ? "var(--color-accent-text)" : neutral[200], background: cur.targets.mode === "teams" ? "var(--color-accent-soft)" : "var(--color-surface)", color: cur.targets.mode === "teams" ? "var(--color-accent-text)" : neutral[600] }}>团队群聊</button>
              <button type="button" data-testid="integration-policy-mode-member" onClick={() => updateCur({ targets: { ...cur.targets, mode: "member", teams: [] } })}
                style={{ ...tinyBtn, marginLeft: space.sm, borderColor: cur.targets.mode === "member" ? "var(--color-accent-text)" : neutral[200], background: cur.targets.mode === "member" ? "var(--color-accent-soft)" : "var(--color-surface)", color: cur.targets.mode === "member" ? "var(--color-accent-text)" : neutral[600] }}>成员私聊</button>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: space.md }}>
                {cur.targets.mode === "teams" ? (
                  <>
                    {teams.map((t) => {
                      const checked = cur.targets.teams.includes(t.id);
                      return <label key={t.id} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${checked ? "var(--color-accent-text)" : neutral[200]}`, background: checked ? "var(--color-accent-soft)" : "transparent", cursor: "pointer", fontSize: fontSize.xs, color: neutral[700] }}>
                        <input type="checkbox" data-testid={`integration-policy-target-team-${t.id}`} checked={checked} onChange={(e) => updateCur({ targets: { ...cur.targets, teams: e.target.checked ? [...cur.targets.teams, t.id] : cur.targets.teams.filter((x) => x !== t.id) } })} />
                        {t.name}
                      </label>;
                    })}
                    {teams.length === 0 && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无团队，请先在团队管理中创建</span>}
                    <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: space.sm, marginTop: space.xs }}>
                      <span style={{ fontSize: fontSize.xs, color: neutral[500] }}>接入方式</span>
                      <select data-testid="integration-policy-route" value={cur.targets.route} onChange={(e) => updateCur({ targets: { ...cur.targets, route: e.target.value as "main" | "mention" } })} style={tinyInput}>
                        <option value="main">路由到主 Agent（群内默认触发）</option>
                        <option value="mention">消息带 @Agent名 mention 路由</option>
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    {members.map((m) => (
                      <label key={m.id} style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${cur.targets.member === m.id ? "var(--color-accent-text)" : neutral[200]}`, background: cur.targets.member === m.id ? "var(--color-accent-soft)" : "transparent", cursor: "pointer", fontSize: fontSize.xs, color: neutral[700] }}>
                        <input type="radio" name="policy-member" data-testid={`integration-policy-target-member-${m.id}`} checked={cur.targets.member === m.id} onChange={() => updateCur({ targets: { ...cur.targets, member: m.id } })} />
                        {m.name}
                      </label>
                    ))}
                    {members.length === 0 && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>暂无成员，请先在成员管理中创建</span>}
                  </>
                )}
              </div>
            </section>

            {/* ④ 测试 */}
            <section>
              <div style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900], marginBottom: space.md }}>④ 测试 <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 400 }}>不产生真实投递，仅校验配置</span></div>
              <div style={{ padding: space.md, borderRadius: radius.md, border: `1px solid ${neutral[200]}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <span style={{ fontSize: fontSize.xs, color: neutral[600] }}>示例 Webhook 载荷（JSON）</span>
                  <div style={{ display: "flex", gap: space.sm }}>
                    <button type="button" data-testid="integration-policy-listen" onClick={toggleListen}
                      style={{ ...tinyBtn, borderColor: listening ? "var(--color-danger-text)" : neutral[200], color: listening ? "var(--color-danger-text)" : neutral[600], background: listening ? "var(--color-danger-soft)" : "var(--color-surface)" }}>
                      {listening ? "■ 停止监听" : "● 开始监听"}
                    </button>
                    <button type="button" data-testid="integration-policy-copy-curl" onClick={copyCurl} title="复制可直接执行的 curl 命令（secret 需自行替换）"
                      style={{ ...tinyBtn, borderColor: "var(--color-accent-text)", color: "var(--color-accent-text)", background: curlCopied ? "var(--color-accent-soft)" : "var(--color-surface)" }}>
                      {curlCopied ? "✓ 已复制" : "复制 curl"}
                    </button>
                    <button type="button" data-testid="integration-policy-run-test" onClick={() => setTestResult(pRunTest(cur, sample))} style={{ ...tinyBtn, background: "#0D9488", color: "#FFF", border: "none" }}>运行测试</button>
                  </div>
                </div>
                <textarea data-testid="integration-policy-sample" value={sample} onChange={(e) => setSample(e.target.value)} rows={7}
                  style={{ width: "100%", boxSizing: "border-box", resize: "vertical", marginTop: space.sm, padding: space.sm, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, fontFamily: fontFamily.mono, fontSize: fontSize.xs, lineHeight: 1.6, color: neutral[800], background: "var(--color-surface)", outline: "none" }} />
                {listening && (
                  <div data-testid="integration-policy-captured" style={{ marginTop: space.sm, borderTop: `1px solid ${neutral[200]}`, paddingTop: space.sm }}>
                    <div style={{ fontSize: fontSize.xs, color: neutral[500], marginBottom: space.sm }}>
                      {captured.length === 0 ? "监听中…等待 Webhook 消息（向入站地址发送请求即可采集）" : `已采集 ${captured.length} 条真实消息（点击「载入」作为测试来源）`}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                      {captured.map((c) => (
                        <div key={c.id} data-testid="integration-policy-captured-item" style={{ display: "flex", alignItems: "center", gap: space.sm, padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, background: neutral[50] }}>
                          <span style={{ fontSize: 10, color: neutral[400], fontFamily: fontFamily.mono }}>{c.at}</span>
                          <span style={{ fontSize: 10, color: c.status === "ok" ? "var(--color-success-text)" : neutral[500] }}>{c.event} · {c.status}</span>
                          <code style={{ flex: 1, minWidth: 0, fontSize: 10, color: neutral[500], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: fontFamily.mono }}>{c.raw.replace(/\s+/g, " ").slice(0, 80)}</code>
                          <button type="button" data-testid="integration-policy-captured-load" onClick={() => { setSample(c.raw); setTestResult(null); }} style={{ ...tinyBtn, fontSize: 10, color: "var(--color-accent-text)", borderColor: "var(--color-accent-text)" }}>载入</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {testResult && (
                  <div data-testid="integration-policy-test-result" style={{ marginTop: space.md, padding: space.md, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, background: neutral[50], display: "flex", flexDirection: "column", gap: space.sm }}>
                    {"error" in testResult ? (
                      <span style={{ fontSize: fontSize.xs, color: "var(--color-danger-text)" }}>{testResult.error}</span>
                    ) : (
                      <>
                        <div style={{ fontSize: fontSize.xs }}>
                          过滤结果：<span data-testid="integration-policy-test-action" style={{ fontWeight: 600, color: testResult.action === "deliver" ? "var(--color-success-text)" : "var(--color-danger-text)" }}>{testResult.action === "deliver" ? "放行" : "丢弃"}</span>
                          <span style={{ color: neutral[400], marginLeft: 6 }}>{testResult.matchedRule ? `命中规则「${testResult.matchedRule.name}」` : "无规则命中，按默认动作处理"}</span>
                        </div>
                        {testResult.action === "deliver" && (
                          <>
                            <div data-testid="integration-policy-test-vars" style={{ fontSize: fontSize.xs, color: neutral[600], fontFamily: fontFamily.mono }}>
                              变量：{Object.entries(testResult.variables).map(([k, v]) => `${k}=${v || "(空)"}`).join("  ")}
                            </div>
                            <div data-testid="integration-policy-test-rendered" style={{ padding: space.sm, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, background: "var(--color-surface)", fontSize: fontSize.sm, lineHeight: 1.7, color: neutral[800], whiteSpace: "pre-wrap" }}>{testResult.rendered}</div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${space.md}px ${space.xl}px`, borderTop: `1px solid ${neutral[200]}` }}>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{`策略保存在渠道 config.messagePolicies["${activeEvent}"]`}</span>
          <div style={{ display: "flex", gap: space.sm }}>
            <button type="button" data-testid="integration-policy-cancel" onClick={onClose} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>取消</button>
            <button type="button" data-testid="integration-policy-save" onClick={() => {
              const toSave: Record<string, MessagePolicy> = {};
              for (const k of dirtyEvents) if (policies[k]) toSave[k] = policies[k];
              onSave(toSave);
            }} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", cursor: "pointer" }}>保存配置</button>
          </div>
        </div>
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
  const [deliveryCh, setDeliveryCh] = useState<any | null>(null);
  const [policyCh, setPolicyCh] = useState<any | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  const channelsQuery = useQuery({ queryKey: ["message-channels"], queryFn: () => api.get<any[]>("/message-channels") });
  // 投递目标候选：团队群聊（团队列表）/ 成员私聊（成员列表）
  const teamsQuery = useQuery({ queryKey: ["teams-for-policy"], queryFn: () => api.get<{ items: any[] } | any[]>("/teams", { query: { pageSize: "100" } }) });
  const membersQuery = useQuery({ queryKey: ["members-for-policy"], queryFn: () => api.get<{ items: any[] } | any[]>("/members", { query: { pageSize: "100" } }) });
  const teamOptions: Array<{ id: string; name: string }> = ((Array.isArray(teamsQuery.data) ? teamsQuery.data : teamsQuery.data?.items) ?? []).map((t: any) => ({ id: t.id, name: t.name }));
  const memberOptions: Array<{ id: string; name: string }> = ((Array.isArray(membersQuery.data) ? membersQuery.data : membersQuery.data?.items) ?? []).map((m: any) => ({ id: m.id, name: m.name }));

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
        <div style={{ flex: 1 }}><SectionTitle subtitle="入站 Webhook，按任务绑定分发，支持 fieldMapping">消息渠道（入站）</SectionTitle></div>
        {isAdmin && <PrimaryButton testid="create-message-channel-button" onClick={() => setModal({ mode: "create" })}>＋ 新建消息渠道</PrimaryButton>}
      </div>
      {notice && <div role="status" data-testid="integration-notice" data-kind={notice.kind} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: notice.kind === "success" ? "rgba(16,185,129,0.10)" : "var(--color-danger-soft)", border: "1px solid rgba(16,185,129,0.28)", color: notice.kind === "success" ? "#065F46" : "var(--color-danger-text)", fontSize: fontSize.sm }}>{notice.text}</div>}
      {channelsQuery.isPending ? <div style={{ color: neutral[400], textAlign: "center", padding: space.xl }}>加载中…</div> : channels.length === 0 ? <EmptyState
        testid="integration-empty"
        icon="✉"
        title="还没有消息渠道"
        description={isAdmin ? "新建消息渠道后，任务可绑定渠道做双向同步（企微机器人 / 通用 Webhook）" : "请管理员配置消息渠道"}
        action={isAdmin ? <PrimaryButton testid="integration-empty-add" onClick={() => setModal({ mode: "create" })}>＋ 新建消息渠道</PrimaryButton> : undefined}
      /> : (
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
                <span aria-hidden style={{ width: 40, height: 40, borderRadius: radius.md, display: "inline-flex", alignItems: "center", justifyContent: "center", backgroundColor: theme.iconBg, color: theme.color }}>◈</span>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
                  <span data-testid="integration-inbound-url-display" style={{ fontSize: fontSize.xs, color: neutral[500], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inboundUrl}</span>
                </div>
                <Pill theme={theme} label={theme.label} testid="integration-type-badge" status={ch.type} />
                <button type="button" data-testid="integration-copy-inboundUrl" onClick={() => navigator.clipboard.writeText(inboundUrl)} style={{ padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.sm, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.xs }}>复制</button>
                {isAdmin ? (
                  <button type="button" data-testid="integration-enabled-toggle" data-enabled={ch.enabled ? "true" : "false"} onClick={() => toggleMut.mutate({ id: ch.id, enabled: !ch.enabled })} style={{ padding: `${space.xs}px ${space.sm + 2}px`, borderRadius: radius.pill, border: `1px solid ${ch.enabled ? "rgba(16,185,129,0.28)" : neutral[200]}`, backgroundColor: ch.enabled ? "rgba(16,185,129,0.10)" : neutral[100], color: ch.enabled ? "var(--color-success-text)" : neutral[500], cursor: "pointer", fontSize: fontSize.sm }}>{ch.enabled ? "已启用" : "已停用"}</button>
                ) : <Pill theme={{ color: ch.enabled ? "var(--color-success-text)" : neutral[500], bg: ch.enabled ? "rgba(16,185,129,0.10)" : neutral[100], border: ch.enabled ? "rgba(16,185,129,0.28)" : neutral[200] }} label={ch.enabled ? "已启用" : "已停用"} testid="integration-enabled-badge" status={ch.enabled ? "enabled" : "disabled"} />}
                {ch.type === 'wecom_aibot' && (
                  <>
                    <Pill theme={statusTheme} label={statusTheme.label} testid="message-channel-status-badge" status={normalizedStatus} />
                    {ch.lastError ? <span data-testid="message-channel-error-text" title={String(ch.lastError)} style={{ fontSize: fontSize.xs, color: "var(--color-danger-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{String(ch.lastError)}</span> : null}
                    {!isConnected ? (
                      <button type="button" data-testid="message-channel-connect-button" onClick={() => connectMut.mutate(ch.id)} disabled={connectMut.isPending} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: "1px solid #0D9488", backgroundColor: "#0D9488", color: "#FFF", cursor: "pointer", fontSize: fontSize.sm, opacity: connectMut.isPending ? 0.6 : 1 }}>连接</button>
                    ) : (
                      <button type="button" data-testid="message-channel-disconnect-button" onClick={() => disconnectMut.mutate(ch.id)} disabled={disconnectMut.isPending} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], cursor: "pointer", fontSize: fontSize.sm, opacity: disconnectMut.isPending ? 0.6 : 1 }}>断开</button>
                    )}
                  </>
                )}
                <div style={{ display: "flex", gap: space.xs }}>
                  {isAdmin && (ch.type === "generic_webhook" || ch.type === "github_webhook" || ch.type === "gitee_webhook") && (
                    <button type="button" data-testid="integration-policy-button" onClick={() => setPolicyCh(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid var(--color-accent-text)`, backgroundColor: "var(--color-accent-soft)", color: "var(--color-accent-text)", cursor: "pointer", fontSize: fontSize.sm }}>消息规则{configuredEventCount(ch) > 0 ? ` · ${configuredEventCount(ch)} 个事件` : ""}</button>
                  )}
                  <button type="button" data-testid="integration-delivery-button" onClick={() => setDeliveryCh(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.sm }}>投递</button>
                  {isAdmin && (
                    <>
                      <button type="button" data-testid="integration-edit-button" onClick={() => setModal({ mode: "edit", ch })} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.sm }}>编辑</button>
                      <button type="button" data-testid="integration-delete-button" onClick={() => setDeleting(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-danger-soft)", color: "var(--color-danger-text)", cursor: "pointer", fontSize: fontSize.sm }}>删除</button>
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
      {policyCh && <PolicyDrawer channel={policyCh} teams={teamOptions} members={memberOptions}
        onClose={() => setPolicyCh(null)}
        onSave={(messagePolicies) => {
          updateMut.mutate({ id: policyCh.id, payload: { name: policyCh.name, type: policyCh.type, config: { ...(policyCh.config ?? {}), messagePolicies } } });
          setPolicyCh(null);
        }} />}
    </div>
  );
}

function MessageChannelModal({ mode, channel, submitting, error, onClose, onSave }: { mode: "create" | "edit"; channel?: any; submitting: boolean; error: string | null; onClose: () => void; onSave: (p: any) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("generic_webhook");
  const [secret, setSecret] = useState("");
  const [botId, setBotId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const isWebhookType = type === "generic_webhook" || type === "github_webhook" || type === "gitee_webhook";

  useEffect(() => {
    if (channel) {
      setName(channel.name ?? "");
      setType(channel.type ?? "generic_webhook");
      setSecret("");
      setBotId("");
    } else {
      setName(""); setType("generic_webhook"); setSecret(""); setBotId("");
    }
    setFormError(null);
  }, [channel, mode]);

  const handleSubmit = () => {
    if (!name.trim()) { setFormError("请填写渠道名称"); return; }
    if (type === "wecom_aibot" && mode === "create") {
      if (!botId.trim()) { setFormError("请填写 BotID"); return; }
      if (!secret.trim()) { setFormError("请填写 Secret"); return; }
    }
    // 编辑时保留原 config（含 messagePolicies 与存量 fieldMappings），避免被空 config 冲掉；
    // 消息过滤/模板配置统一在右侧「消息规则」抽屉中维护。
    const config: any = { ...(channel?.config ?? {}) };
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
              <button key={t} type="button" data-testid={`integration-type-${t}`} data-active={type === t ? "true" : "false"} onClick={() => setType(t)} style={{ flex: 1, minWidth: 110, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: type === t ? "1px solid var(--color-accent-text)" : `1px solid ${neutral[200]}`, backgroundColor: type === t ? "var(--color-accent-soft)" : "var(--color-surface)", color: type === t ? "var(--color-accent-text)" : neutral[600], cursor: "pointer", fontSize: fontSize.sm, fontWeight: type === t ? 600 : 500 }}>{messageTypeTheme[t].label}</button>
            ))}
          </div>
        </FieldRow>
        <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>消息的过滤 / 模板 / 路由配置请点击渠道行的「消息规则」按钮，在右侧抽屉中维护。</div>
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
        {(error || formError) && <div role="alert" data-testid="integration-modal-error" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-danger-soft)", border: "1px solid rgba(239,68,68,0.22)", color: "var(--color-danger-text)", fontSize: fontSize.sm }}>{error ?? formError}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button type="button" data-testid="integration-modal-cancel" onClick={onClose} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>取消</button>
          <button type="button" data-testid="integration-modal-confirm" disabled={submitting} onClick={handleSubmit} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", cursor: "pointer", opacity: submitting ? 0.6 : 1 }}>{submitting ? "保存中…" : mode === "create" ? "创建" : "保存"}</button>
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
        {isAdmin && <button type="button" data-testid="create-notification-channel-button" onClick={() => setModal({ mode: "create" })} style={{ padding: `${space.sm + 1}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", cursor: "pointer", fontFamily: fontFamily.body }}>＋ 新建通知渠道</button>}
      </div>
      {notice && <div role="status" data-testid="notification-notice" data-kind={notice.kind} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, backgroundColor: notice.kind === "success" ? "rgba(16,185,129,0.10)" : "var(--color-danger-soft)", border: "1px solid rgba(16,185,129,0.28)", color: notice.kind === "success" ? "#065F46" : "var(--color-danger-text)", fontSize: fontSize.sm }}>{notice.text}</div>}
      {q.isPending ? <div style={{ color: neutral[400], textAlign: "center", padding: space.xl }}>加载中…</div> : channels.length === 0 ? <EmptyState
        testid="notification-empty"
        icon="◈"
        title="还没有通知渠道"
        description="通知渠道用于把 Agent 的完成/阻塞事件推送到外部群"
      /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          {channels.map((ch) => {
            const theme = notifTypeTheme[ch.type] ?? notifTypeTheme.webhook;
            const events = (ch.config as any)?.events ?? [];
            const targetUrl = (ch.config as any)?.targetUrl ?? "";
            return (
              <div key={ch.id} data-testid="notification-channel-item" data-channel-id={ch.id} data-type={ch.type} style={{ display: "flex", alignItems: "center", gap: space.lg, padding: `${space.lg}px ${space.xl}px`, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.sm, ...baseFont }}>
                <span aria-hidden style={{ width: 40, height: 40, borderRadius: radius.md, display: "inline-flex", alignItems: "center", justifyContent: "center", backgroundColor: theme.iconBg, color: theme.color }}>◈</span>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[500], fontFamily: fontFamily.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{targetUrl || (events as string[]).join(", ") || "—"}</span>
                </div>
                <Pill theme={theme} label={theme.label} testid="notification-type-badge" status={ch.type} />
                {isAdmin ? <button type="button" data-testid="notification-enabled-toggle" data-enabled={ch.enabled ? "true" : "false"} onClick={() => toggleMut.mutate({ id: ch.id, enabled: !ch.enabled })} style={{ padding: `${space.xs}px ${space.sm + 2}px`, borderRadius: radius.pill, border: `1px solid ${ch.enabled ? "rgba(16,185,129,0.28)" : neutral[200]}`, backgroundColor: ch.enabled ? "rgba(16,185,129,0.10)" : neutral[100], color: ch.enabled ? "var(--color-success-text)" : neutral[500], cursor: "pointer", fontSize: fontSize.sm }}>{ch.enabled ? "已启用" : "已停用"}</button> : <Pill theme={{ color: ch.enabled ? "var(--color-success-text)" : neutral[500], bg: ch.enabled ? "rgba(16,185,129,0.10)" : neutral[100], border: ch.enabled ? "rgba(16,185,129,0.28)" : neutral[200] }} label={ch.enabled ? "已启用" : "已停用"} testid="notification-enabled-badge" status={ch.enabled ? "enabled" : "disabled"} />}
                <div style={{ display: "flex", gap: space.xs }}>
                  <button type="button" data-testid="notification-delivery-button" onClick={() => setDeliveryCh(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.sm }}>投递</button>
                  {isAdmin && <>
                    <button type="button" data-testid="notification-edit-button" onClick={() => setModal({ mode: "edit", ch })} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer", fontSize: fontSize.sm }}>编辑</button>
                    <button type="button" data-testid="notification-test-send-button" onClick={() => testMut.mutate(ch.id)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: "#0D9488", cursor: "pointer", fontSize: fontSize.sm }}>测试推送</button>
                    <button type="button" data-testid="notification-delete-button" onClick={() => setDeleting(ch)} style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-danger-soft)", color: "var(--color-danger-text)", cursor: "pointer", fontSize: fontSize.sm }}>删除</button>
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
              <button key={t} type="button" data-testid={`notification-type-${t}`} data-active={type === t ? "true" : "false"} onClick={() => setType(t)} style={{ flex: 1, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, border: type === t ? "1px solid var(--color-accent-text)" : `1px solid ${neutral[200]}`, backgroundColor: type === t ? "var(--color-accent-soft)" : "var(--color-surface)", color: type === t ? "var(--color-accent-text)" : neutral[600], cursor: "pointer", fontSize: fontSize.sm, fontWeight: type === t ? 600 : 500 }}>{notifTypeTheme[t].label}</button>
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
        {(error || formError) && <div role="alert" data-testid="notification-modal-error" style={{ padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md, backgroundColor: "var(--color-danger-soft)", border: "1px solid rgba(239,68,68,0.22)", color: "var(--color-danger-text)", fontSize: fontSize.sm }}>{error ?? formError}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
          <button type="button" data-testid="notification-modal-cancel" onClick={onClose} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", cursor: "pointer" }}>取消</button>
          <button type="button" data-testid="notification-modal-confirm" disabled={submitting} onClick={handleSubmit} style={{ padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, border: "none", backgroundColor: "#0D9488", color: "#FFF", cursor: "pointer", opacity: submitting ? 0.6 : 1 }}>{submitting ? "保存中…" : mode === "create" ? "创建" : "保存"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Main Page with dual tabs ----------
export default function IntegrationsPage() {
  const [activeTab, setActiveTab] = useState<"message" | "notification">("message");
  return (
    <PageWindow style={{ position: "relative", backgroundColor: neutral[50], ...baseFont }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: fontSize.xxl, fontWeight: 700, color: neutral[900], lineHeight: 1.2 }}>外部渠道</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[500], marginTop: space.xs }}>消息渠道（入站）与通知渠道（出站）统一管理，任务侧绑定生效</div>
        </div>
      </div>
      <SegmentedTabs
        items={[
          { key: "message", label: "消息渠道", icon: "✉" },
          { key: "notification", label: "通知渠道", icon: "◎" },
        ]}
        active={activeTab}
        onChange={(k) => setActiveTab(k as "message" | "notification")}
      />
      <div data-testid="integration-tab-panel" data-tab={activeTab}>
        {activeTab === "message" ? <MessageChannelsTab /> : <NotificationChannelsTab />}
      </div>
    </PageWindow>
  );
}
