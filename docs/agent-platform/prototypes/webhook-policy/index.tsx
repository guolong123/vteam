/**
 * 原型：Webhook 消息规则（过滤 + 字段提取 + 消息模板 + 投递目标）
 * =============================================
 * 对应 38 篇《Webhook 消息过滤与消息模板设计》，补齐 27 篇外部渠道集成
 * 的入站侧能力缺口：Gitee/GitHub 载荷字段多、事件杂，当前仅有
 * fieldMapping 的 content/source/user 三个固定字段，无法按事件过滤、
 * 无法编排正文、无法按事件路由到指定 Agent / 群聊。
 *
 * 页面内容（区块顺序）：
 * - 背景层「外部渠道」列表：三个入站渠道，每行「消息规则 · N」按钮（wpr-rule-button），
 *   点击打开右侧配置抽屉。
 * - 配置抽屉（wpr-drawer，absolute 相对 root）：左侧事件列表（Issue / PR / Push /
 *   默认），右侧四段式配置：
 *   ① 过滤规则：策略开关 + 默认动作 + 规则卡片（条件构建器 path/op/value，AND/OR，
 *      命中后放行/丢弃，可增删）；字段路径提供「从示例 JSON 选择」入口（wpr-path-pick）；
 *   ② 消息模板：变量提取表 name ← JSON path + 默认值 + 示例值（实时解析），
 *      正文模板编辑器（{{变量名}}）+ 实时消息预览；
 *   ③ 投递目标：团队群聊 / Agent / 成员私聊多选，为空则沿用渠道绑定；
 *   ④ 测试：粘贴示例载荷 + 运行测试（wpr-run-test），输出命中规则、提取变量、
 *      渲染正文、投递目标（不产生真实投递）。
 * - 底部：取消 / 保存配置（纯本地交互，toast 反馈）。
 * - 复用 ../_shared/nav（NavDock / NavTopBar / CmdKPanel）+ ../_shared/styles token。
 * - ⚠️ T15 铁律：root height:100% + minHeight:720 + position:relative，零 fixed/vh/vw；
 *   T20：CmdKPanel 受控开关默认关闭。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import { NavDock, NavTopBar, CmdKPanel, type CmdKItem } from "../_shared/nav";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };
const RAIL_W = 56;

/** 页面内语义色：放行=绿 / 丢弃=红 / 品牌蓝（与 _shared nav 高亮同族） */
const semantic = {
  deliver: { color: "#047857", bg: "#ECFDF5", border: "#A7F3D0" },
  discard: { color: "#B91C1C", bg: "#FEF2F2", border: "#FECACA" },
  brand: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  info: { color: "#0369A1", bg: "#F0F9FF", border: "#BAE6FD" },
} as const;

const CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉", active: true },
  { group: "操作", label: "新建消息渠道", icon: "✚" },
  { group: "操作", label: "配置消息规则", icon: "◷" },
];

/* ---------------------------------- 类型 ---------------------------------- */
type Action = "deliver" | "discard";
type Op = "eq" | "neq" | "contains" | "regex" | "exists" | "in";
type Logic = "and" | "or";

interface Condition { id: string; path: string; op: Op; value: string }
interface FilterRule {
  id: string; name: string; enabled: boolean; logic: Logic;
  conditions: Condition[]; action: Action;
}
interface Variable { id: string; name: string; path: string; fallback: string }
interface ChatTarget { id: string; name: string; desc: string }
interface MemberTarget { id: string; name: string; desc: string }
interface EventPreset {
  label: string; desc: string; rules: FilterRule[]; variables: Variable[];
  template: string; defaultAction: Action; chatTargets: string[]; sample: string;
}
interface DeliveryConfig {
  mode: "teams" | "member";       // 渠道绑定类型（互斥：团队群聊 / 成员私聊）
  teams: string[];                // 团队群聊 id 列表（多选）；空=沿用渠道现有绑定
  member?: string;                // 成员私聊 id（唯一成员）
  route: "main" | "mention";      // 群聊模式下的消息接入方式
}
interface TestResult {
  matchedRule: FilterRule | null; action: Action;
  extracted: Array<{ name: string; value: string; path: string }>;
  rendered: string; delivery: DeliveryConfig;
}

const OP_LABELS: Record<Op, string> = {
  eq: "等于", neq: "不等于", contains: "包含",
  regex: "正则匹配", exists: "存在", in: "属于",
};

const CHANNELS = [
  { id: "mc_11", name: "gitee-issue", tag: "Gitee", tagTone: "discard" as const, url: "https://vteam.ketaops.cc/api/v1/message-channels/mc_0000000011/inbound", rules: 3, status: "已停用" },
  { id: "mc_9", name: "郭龙的机器人", tag: "企微机器人", tagTone: "info" as const, url: "https://vteam.ketaops.cc/api/v1/message-channels/mc_0000000009/in…", rules: 1, status: "已启用" },
  { id: "mc_6", name: "ketabot-devops", tag: "企微机器人", tagTone: "info" as const, url: "https://vteam.ketaops.cc/api/v1/message-channels/mc_0000000006/in…", rules: 0, status: "已启用" },
];

/** 团队群聊渠道（渠道可绑多个团队，每团队一个群，入站时 fan-out） */
const CHAT_TARGETS: ChatTarget[] = [
  { id: "t_chat_1", name: "产品研发群", desc: "team_group · 12 名成员" },
  { id: "t_chat_2", name: "运维值班群", desc: "team_group · 5 名成员" },
];
/** 成员私聊渠道（渠道只能绑一个成员，渠道与团队群聊互斥） */
const MEMBER_TARGETS: MemberTarget[] = [
  { id: "t_member_1", name: "郭龙", desc: "DM · 企微机器人" },
  { id: "t_member_2", name: "产品经理A", desc: "DM · 企微机器人" },
];
/** 群聊模式下的 Agent 接入方式（消息中写 mention 路由派发给指定 Agent） */
const ROUTE_MODES: Array<{ value: "main" | "mention"; label: string; hint: string }> = [
  { value: "main", label: "路由到主 Agent", hint: "群内默认触发主 Agent 响应" },
  { value: "mention", label: "消息带 @Agent名的 mention 路由", hint: '模板里写 "@需求分析师 …" 将消息派发给指定 Agent' },
];

const SAMPLE_ISSUE = `{
  "action": "opened",
  "issue": {
    "title": "修复登录超时问题",
    "state": "open",
    "html_url": "https://gitee.com/acme/web/issues/128",
    "number": 128
  },
  "repository": { "full_name": "acme/web" },
  "sender": { "login": "alice", "type": "User" }
}`;

const PRESETS: Record<string, EventPreset> = {
  issue_hooks: {
    label: "Issue 事件", desc: "issues / issue_comment", defaultAction: "discard",
    rules: [
      { id: "r1", name: "只处理打开的 Issue", enabled: true, logic: "and", action: "deliver", conditions: [
        { id: "c1", path: "issue.state", op: "eq", value: "open" },
        { id: "c2", path: "action", op: "eq", value: "opened" },
      ] },
      { id: "r2", name: "丢弃机器人自动创建的 Issue", enabled: true, logic: "and", action: "discard", conditions: [
        { id: "c3", path: "sender.type", op: "eq", value: "Bot" },
      ] },
    ],
    variables: [
      { id: "v1", name: "title", path: "issue.title", fallback: "（无标题）" },
      { id: "v2", name: "repo", path: "repository.full_name", fallback: "未知仓库" },
      { id: "v3", name: "author", path: "sender.login", fallback: "未知用户" },
      { id: "v4", name: "url", path: "issue.html_url", fallback: "" },
    ],
    template: "🐛 新 Issue：{{title}}\n仓库：{{repo}} · 发起人：{{author}}\n链接：{{url}}\n\n请需求分析师先评估优先级。",
    chatTargets: ["t_chat_1"], sample: SAMPLE_ISSUE,
  },
  pull_request_hooks: {
    label: "PR 事件", desc: "pull_request / pull_request_review", defaultAction: "discard",
    rules: [
      { id: "r3", name: "只放行已合并的 PR", enabled: true, logic: "and", action: "deliver", conditions: [
        { id: "c4", path: "action", op: "eq", value: "closed" },
        { id: "c5", path: "pull_request.merged", op: "eq", value: "true" },
      ] },
    ],
    variables: [
      { id: "v5", name: "title", path: "pull_request.title", fallback: "（无标题）" },
      { id: "v6", name: "author", path: "sender.login", fallback: "未知用户" },
      { id: "v7", name: "url", path: "pull_request.html_url", fallback: "" },
    ],
    template: "✅ PR 已合并：{{title}}\n提交人：{{author}}\n{{url}}\n\n请触发回归检查。",
    chatTargets: ["t_chat_1"],
    sample: `{
  "action": "closed",
  "pull_request": { "title": "优化登录接口性能", "merged": true, "html_url": "https://gitee.com/acme/web/pulls/129" },
  "sender": { "login": "bob", "type": "User" }
}`,
  },
  push_hooks: {
    label: "Push 事件", desc: "push", defaultAction: "discard",
    rules: [
      { id: "r4", name: "忽略机器人推送", enabled: true, logic: "and", action: "discard", conditions: [
        { id: "c6", path: "sender.type", op: "eq", value: "Bot" },
      ] },
    ],
    variables: [
      { id: "v8", name: "branch", path: "ref", fallback: "未知分支" },
      { id: "v9", name: "user", path: "sender.name", fallback: "未知用户" },
      { id: "v10", name: "count", path: "commits.length", fallback: "0" },
    ],
    template: "📦 {{user}} 向 {{branch}} 推送了 {{count}} 个提交。",
    chatTargets: ["t_chat_2"],
    sample: `{
  "ref": "refs/heads/master",
  "commits": [{ "id": "a1b2c3", "message": "fix: 登录超时" }],
  "sender": { "name": "carol", "type": "User" }
}`,
  },
  _default: {
    label: "默认事件", desc: "未匹配的事件走这里", defaultAction: "deliver",
    rules: [], variables: [],
    template: "📨 收到 {{hook_name}} 事件：{{text}}", chatTargets: [],
    sample: `{\n  "hook_name": "issue_hooks",\n  "text": "默认事件示例"\n}`,
  },
};
const EVENT_KEYS = ["issue_hooks", "pull_request_hooks", "push_hooks", "_default"];

/* --------------------------- 简易 JSON 路径 / 模板引擎 --------------------------- */
function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object") return undefined;
    const m = key.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    let cur: unknown = (acc as Record<string, unknown>)[m[1]];
    for (const i of [...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]))) {
      cur = Array.isArray(cur) ? cur[i] : undefined;
    }
    return cur;
  }, obj);
}

function matchCondition(cond: Condition, data: unknown): boolean {
  const raw = getByPath(data, cond.path);
  if (cond.op === "exists") return raw !== undefined && raw !== null && raw !== "";
  const value = String(raw ?? "");
  switch (cond.op) {
    case "eq": return value === cond.value;
    case "neq": return value !== cond.value;
    case "contains": return value.includes(cond.value);
    case "regex":
      try { return new RegExp(cond.value).test(value); } catch { return false; }
    case "in": return cond.value.split(",").map((s) => s.trim()).includes(value);
    default: return false;
  }
}

function extractVariables(variables: Variable[], data: unknown) {
  return variables.map((v) => {
    const raw = getByPath(data, v.path);
    return {
      name: v.name, path: v.path,
      value: raw === undefined || raw === null || raw === "" ? v.fallback : String(raw),
    };
  });
}

function renderTemplate(template: string, extracted: Array<{ name: string; value: string }>) {
  const map = new Map(extracted.map((e) => [e.name, e.value]));
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, k: string) => map.get(k.trim()) ?? "");
}

function runTest(
  rules: FilterRule[], defaultAction: Action, variables: Variable[],
  template: string, delivery: DeliveryConfig, sample: string,
): TestResult | { error: string } {
  let data: unknown;
  try { data = JSON.parse(sample); } catch { return { error: "示例 JSON 解析失败，请检查格式" }; }
  let matchedRule: FilterRule | null = null;
  let action = defaultAction;
  for (const rule of rules) {
    if (!rule.enabled || rule.conditions.length === 0) continue;
    const results = rule.conditions.map((c) => matchCondition(c, data));
    if (rule.logic === "and" ? results.every(Boolean) : results.some(Boolean)) {
      matchedRule = rule; action = rule.action; break;
    }
  }
  const extracted = extractVariables(variables, data);
  const teamNames = CHAT_TARGETS.filter((t) => delivery.teams.includes(t.id)).map((t) => t.name);
  const member = delivery.member
    ? MEMBER_TARGETS.find((m) => m.id === delivery.member)?.name
    : undefined;
  return {
    matchedRule, action, extracted,
    rendered: renderTemplate(template, extracted),
    delivery: { mode: delivery.mode, teams: teamNames, member, route: delivery.route },
  };
}

/* ---------------------------------- 样式原子 ---------------------------------- */
const inputStyle: CSSProperties = {
  border: `1px solid ${neutral[200]}`, borderRadius: radius.sm, background: "#FFFFFF",
  padding: `${space.xs}px ${space.sm}px`, fontSize: fontSize.sm, color: neutral[700],
  ...baseFont, outline: "none",
};
const cardStyle: CSSProperties = {
  border: `1px solid ${neutral[200]}`, borderRadius: radius.md,
  background: "#FFFFFF", padding: space.md, boxShadow: shadow.sm,
};
const btnBase: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: space.xs,
  padding: `${space.xs}px ${space.md}px`, borderRadius: radius.sm,
  fontSize: fontSize.sm, cursor: "pointer", ...baseFont,
};
const primaryBtn: CSSProperties = { ...btnBase, border: "1px solid #2563EB", background: "#2563EB", color: "#FFFFFF" };
const outlineBtn: CSSProperties = { ...btnBase, border: `1px solid ${neutral[200]}`, background: "#FFFFFF", color: neutral[700] };
const ghostBtn: CSSProperties = { ...btnBase, border: "none", background: "transparent", color: neutral[500] };

function Badge({ tone, children }: { tone: keyof typeof semantic; children: React.ReactNode }) {
  const t = semantic[tone];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: `1px ${space.sm}px`, borderRadius: radius.pill,
      background: t.bg, border: `1px solid ${t.border}`, color: t.color,
      fontSize: fontSize.xs, fontWeight: 500, whiteSpace: "nowrap", ...baseFont,
    }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: t.color }} />
      {children}
    </span>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative", width: 32, height: 18, flexShrink: 0, padding: 0,
        borderRadius: radius.pill, border: "none", cursor: "pointer",
        background: checked ? "#2563EB" : neutral[300],
      }}>
      <span style={{
        position: "absolute", top: 2, left: checked ? 16 : 2,
        width: 14, height: 14, borderRadius: "50%", background: "#FFFFFF",
        boxShadow: shadow.sm, transition: "left .15s ease",
      }} />
    </button>
  );
}

function SectionTitle({ index, title, desc }: { index: string; title: string; desc?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: space.sm, marginBottom: space.md }}>
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 20, height: 20, flexShrink: 0, borderRadius: radius.sm,
        background: semantic.brand.bg, color: semantic.brand.color,
        fontSize: fontSize.xs, fontWeight: 600,
      }}>{index}</span>
      <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>{title}</span>
      {desc && <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{desc}</span>}
    </div>
  );
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span style={{ width: 16, height: 16, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: radius.sm, border: `1px solid ${checked ? "#2563EB" : neutral[300]}`,
      background: checked ? "#2563EB" : "#FFFFFF", color: "#FFFFFF", fontSize: 10 }}>
      {checked ? "✓" : ""}
    </span>
  );
}

/** 投递类型切换卡片（团队群聊 / 成员私聊，互斥） */
function DeliveryModeTile({ mode, checked, onChange, title, subtitle }: {
  mode: DeliveryConfig["mode"]; checked: boolean;
  onChange: () => void; title: string; subtitle: string;
}) {
  return (
    <button data-testid={`wpr-mode-${mode}`} onClick={onChange}
      style={{ display: "flex", flexDirection: "column", gap: 2, padding: `${space.sm}px ${space.md}px`, textAlign: "left", cursor: "pointer",
        border: `1px solid ${checked ? "#93C5FD" : neutral[200]}`, borderRadius: radius.md, background: checked ? semantic.brand.bg : "#FFFFFF",
        transition: "all .15s", ...baseFont }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Checkbox checked={checked} />
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800] }}>{title}</span>
      </span>
      <span style={{ fontSize: 10, color: checked ? semantic.brand.color : neutral[400], marginLeft: 22 }}>{subtitle}</span>
    </button>
  );
}

/* ================================ 原型组件 ================================ */
function WebhookPolicyPage({ device }: PrototypeRenderProps) {
  const isMobile = device === "mobile";
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [openChannel, setOpenChannel] = useState<string | null>("mc_11");
  const [activeEvent, setActiveEvent] = useState("issue_hooks");
  const [rules, setRules] = useState<FilterRule[]>(PRESETS.issue_hooks.rules);
  const [variables, setVariables] = useState<Variable[]>(PRESETS.issue_hooks.variables);
  const [template, setTemplate] = useState(PRESETS.issue_hooks.template);
  const [defaultAction, setDefaultAction] = useState<Action>(PRESETS.issue_hooks.defaultAction);
  const [targetMode, setTargetMode] = useState<DeliveryConfig["mode"]>("teams");
  const [targetTeams, setTargetTeams] = useState<string[]>(PRESETS.issue_hooks.chatTargets);
  const [targetMember, setTargetMember] = useState<string>("t_member_1");
  const [routeMode, setRouteMode] = useState<DeliveryConfig["route"]>("main");
  const [sample, setSample] = useState(PRESETS.issue_hooks.sample);
  const [testResult, setTestResult] = useState<TestResult | { error: string } | null>(null);
  const [toast, setToast] = useState("");

  const channel = CHANNELS.find((c) => c.id === openChannel) ?? null;
  let parsedSample: unknown = {};
  try { parsedSample = JSON.parse(sample); } catch { /* 非法 JSON 时按空数据处理 */ }
  const previewExtracted = extractVariables(variables, parsedSample);
  const previewText = renderTemplate(template, previewExtracted);
  const delivery: DeliveryConfig = {
    mode: targetMode, teams: targetMode === "teams" ? targetTeams : [],
    member: targetMode === "member" ? targetMember : undefined, route: routeMode,
  };

  function toastMsg(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(""), 1800);
  }

  function selectEvent(key: string) {
    const p = PRESETS[key];
    setActiveEvent(key);
    setRules(p.rules); setVariables(p.variables); setTemplate(p.template);
    setDefaultAction(p.defaultAction);
    setTargetMode("teams"); setTargetTeams(p.chatTargets);
    setTargetMember("t_member_1"); setRouteMode("main");
    setSample(p.sample); setTestResult(null);
  }

  function updateRule(id: string, patch: Partial<FilterRule>) {
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function updateCondition(ruleId: string, condId: string, patch: Partial<Condition>) {
    setRules((rs) => rs.map((r) => r.id === ruleId
      ? { ...r, conditions: r.conditions.map((c) => (c.id === condId ? { ...c, ...patch } : c)) }
      : r));
  }

  return (
    <div style={{ height: "100%", minHeight: 720, position: "relative", background: neutral[50], overflow: "hidden", ...baseFont }}>
      {/* 背景层：外部渠道列表 */}
      <div style={{ position: "absolute", inset: 0, left: RAIL_W, overflow: "auto", padding: `${space.xl}px ${space.xl}px ${space.xxl}px` }}>
        <NavTopBar breadcrumb={["集成", "外部渠道"]} userName="seed-admin" userRole="管理员"
          onCmdKClick={() => setCmdkOpen(true)} />
        <div style={{ maxWidth: 900, marginTop: space.xl }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: neutral[900], margin: 0 }}>外部渠道</h1>
          <p style={{ fontSize: fontSize.sm, color: neutral[500], margin: `${space.xs}px 0 0` }}>
            消息渠道（入站）与通知渠道（出站）统一管理，任务侧绑定后生效
          </p>
          <div style={{ display: "inline-flex", gap: 2, padding: 2, marginTop: space.lg,
            border: `1px solid ${neutral[200]}`, borderRadius: radius.sm, background: "#FFFFFF" }}>
            <span style={{ padding: `${space.xs}px ${space.md}px`, borderRadius: radius.sm, background: semantic.brand.bg, color: semantic.brand.color, fontSize: fontSize.sm, fontWeight: 600 }}>消息渠道</span>
            <span style={{ padding: `${space.xs}px ${space.md}px`, fontSize: fontSize.sm, color: neutral[500] }}>通知渠道</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: space.lg }}>
            <div>
              <h2 style={{ fontSize: fontSize.lg, fontWeight: 600, margin: 0, color: neutral[900] }}>消息渠道（入站）</h2>
              <p style={{ fontSize: fontSize.xs, color: neutral[500], margin: "2px 0 0" }}>
                入站 Webhook，按任务绑定分发，支持 fieldMapping 与消息规则
              </p>
            </div>
            <button style={outlineBtn}>＋ 新建消息渠道</button>
          </div>
          <div style={{ display: "grid", gap: space.md, marginTop: space.md }}>
            {CHANNELS.map((ch) => (
              <div key={ch.id} data-testid="wpr-channel-item" style={cardStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
                  <span style={{ width: 34, height: 34, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: radius.md, background: neutral[100], fontSize: fontSize.lg }}>🔗</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                      <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>{ch.name}</span>
                      <Badge tone={ch.tagTone}>{ch.tag}</Badge>
                    </div>
                    <div style={{ fontFamily: fontFamily.mono, fontSize: fontSize.xs, color: neutral[400], marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.url}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexShrink: 0 }}>
                    <Badge tone={ch.status === "已启用" ? "deliver" : "brand"}>{ch.status}</Badge>
                    <button data-testid="wpr-rule-button" onClick={() => { setOpenChannel(ch.id); selectEvent("issue_hooks"); }}
                      style={{ ...outlineBtn, borderColor: semantic.brand.border, background: semantic.brand.bg, color: semantic.brand.color }}>
                      消息规则
                      {ch.rules > 0 && <span style={{ marginLeft: 4, padding: "0 5px", borderRadius: radius.pill, background: "#2563EB", color: "#FFFFFF", fontSize: 10 }}>{ch.rules}</span>}
                    </button>
                    <button style={ghostBtn}>投递</button>
                    <button style={ghostBtn}>编辑</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 配置抽屉：absolute 相对 root（T15 铁律） */}
      {channel && (
        <div style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", justifyContent: "flex-end", background: "rgba(15,23,42,.35)" }}
          onClick={() => setOpenChannel(null)}>
          <div data-testid="wpr-drawer" onClick={(e) => e.stopPropagation()}
            style={{ display: "flex", flexDirection: "column", height: "100%", width: isMobile ? "100%" : "min(760px, 92%)", background: "#FFFFFF", boxShadow: shadow.lg }}>
            {/* 抽屉头 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${neutral[100]}` }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                  <h2 style={{ fontSize: fontSize.lg, fontWeight: 600, margin: 0, color: neutral[900] }}>消息处理 · {channel.name}</h2>
                  <Badge tone="brand">Webhook</Badge>
                </div>
                <p style={{ fontSize: fontSize.xs, color: neutral[500], margin: "2px 0 0" }}>
                  过滤规则 → 字段提取 → 消息模板 → 投递目标，按事件独立配置
                </p>
              </div>
              <button onClick={() => setOpenChannel(null)} aria-label="关闭"
                style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: neutral[400], padding: 4 }}>✕</button>
            </div>

            <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
              {/* 事件列表 */}
              <aside style={{ width: isMobile ? "100%" : 144, flexShrink: 0, borderRight: isMobile ? "none" : `1px solid ${neutral[100]}`, background: neutral[50], padding: space.md }}>
                <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".04em", color: neutral[400], margin: `0 0 ${space.sm}px` }}>事件</p>
                <div style={{ display: isMobile ? "flex" : "block", gap: space.sm, overflowX: "auto" }}>
                  {EVENT_KEYS.map((key) => {
                    const p = PRESETS[key]; const active = key === activeEvent;
                    return (
                      <button key={key} data-testid={`wpr-event-${key}`} onClick={() => selectEvent(key)}
                        style={{
                          width: isMobile ? "auto" : "100%", flexShrink: isMobile ? 0 : undefined,
                          textAlign: "left", padding: `${space.sm}px ${space.md}px`, cursor: "pointer",
                          border: "none", borderRadius: radius.sm,
                          background: active ? semantic.brand.bg : "transparent",
                          color: active ? semantic.brand.color : neutral[600],
                          ...baseFont,
                        }}>
                        <div style={{ fontSize: fontSize.sm, fontWeight: active ? 600 : 400 }}>{p.label}</div>
                        {!isMobile && <div style={{ fontSize: 10, color: neutral[400], marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.desc}</div>}
                      </button>
                    );
                  })}
                </div>
              </aside>

              {/* 四段式配置 */}
              {!isMobile && (
              <div style={{ minWidth: 0, flex: 1, overflow: "auto", padding: `${space.lg}px ${space.xl}px`, display: "grid", gap: space.xl }}>
                {/* ① 过滤规则 */}
                <section>
                  <SectionTitle index="1" title="过滤规则" desc="顺序匹配，首条命中即生效" />
                  <div style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.sm}px ${space.md}px`, marginBottom: space.md,
                    border: `1px solid ${neutral[200]}`, borderRadius: radius.md, background: neutral[50] }}>
                    <span style={{ fontSize: fontSize.sm, color: neutral[600] }}>策略开关</span>
                    <Switch checked onChange={() => toastMsg("原型：策略开关已切换")} label="策略开关" />
                    <span style={{ fontSize: fontSize.sm, color: neutral[600], marginLeft: space.md }}>无规则命中时</span>
                    <select data-testid="wpr-default-action" value={defaultAction} onChange={(e) => setDefaultAction(e.target.value as Action)}
                      style={{ ...inputStyle, width: 76 }}>
                      <option value="discard">丢弃</option><option value="deliver">放行</option>
                    </select>
                    <button style={{ ...outlineBtn, marginLeft: "auto" }}
                      onClick={() => setRules((rs) => [...rs, { id: `r${Date.now()}`, name: "新规则", enabled: true, logic: "and", action: "deliver", conditions: [{ id: `c${Date.now()}`, path: "", op: "eq", value: "" }] }])}>
                      ＋ 新增规则
                    </button>
                  </div>

                  {rules.length === 0 && (
                    <div style={{ padding: space.xl, textAlign: "center", fontSize: fontSize.sm, color: neutral[400],
                      border: `1px dashed ${neutral[200]}`, borderRadius: radius.md }}>
                      暂无过滤规则，所有消息按「默认动作」处理
                    </div>
                  )}
                  <div style={{ display: "grid", gap: space.md }}>
                    {rules.map((rule, ri) => (
                      <div key={rule.id} data-testid="wpr-filter-rule" style={cardStyle}>
                        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                          <span style={{ width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: radius.sm, background: neutral[100], color: neutral[500], fontSize: 10 }}>{ri + 1}</span>
                          <input value={rule.name} onChange={(e) => updateRule(rule.id, { name: e.target.value })}
                            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], ...baseFont }} />
                          <Switch checked={rule.enabled} onChange={(v) => updateRule(rule.id, { enabled: v })} label={`规则${ri + 1}开关`} />
                          <button onClick={() => setRules((rs) => rs.filter((r) => r.id !== rule.id))}
                            style={{ ...ghostBtn, fontSize: fontSize.xs }}>删除</button>
                        </div>
                        <div style={{ display: "grid", gap: 6, marginTop: space.md }}>
                          {rule.conditions.map((cond, ci) => (
                            <div key={cond.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                              <span style={{ width: 32, fontSize: fontSize.xs, color: neutral[400] }}>
                                {ci === 0 ? "当" : rule.logic === "and" ? "并且" : "或者"}
                              </span>
                              <input data-testid="wpr-condition-path" value={cond.path} placeholder="issue.state"
                                onChange={(e) => updateCondition(rule.id, cond.id, { path: e.target.value })}
                                style={{ ...inputStyle, width: 150, fontFamily: fontFamily.mono }} />
                              <button data-testid="wpr-path-pick" title="从示例 JSON 选择字段"
                                onClick={() => toastMsg("原型：可点选字段树自动填入路径（解决复杂 JSON 路径难写）")}
                                style={{ ...outlineBtn, padding: `${space.xs}px 6px`, fontSize: fontSize.xs }}>⌄</button>
                              <select value={cond.op} onChange={(e) => updateCondition(rule.id, cond.id, { op: e.target.value as Op })} style={{ ...inputStyle, width: 88 }}>
                                {(Object.keys(OP_LABELS) as Op[]).map((op) => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
                              </select>
                              {cond.op !== "exists" && (
                                <input value={cond.value} placeholder="值"
                                  onChange={(e) => updateCondition(rule.id, cond.id, { value: e.target.value })}
                                  style={{ ...inputStyle, width: 80 }} />
                              )}
                              <button onClick={() => updateRule(rule.id, { conditions: rule.conditions.filter((c) => c.id !== cond.id) })}
                                style={{ border: "none", background: "transparent", cursor: "pointer", color: neutral[400], fontSize: 14 }}>×</button>
                            </div>
                          ))}
                          <button onClick={() => updateRule(rule.id, { conditions: [...rule.conditions, { id: `c${Date.now()}`, path: "", op: "eq", value: "" }] })}
                            style={{ ...ghostBtn, marginLeft: 32, fontSize: fontSize.xs, color: semantic.brand.color }}>＋ 添加条件</button>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: space.sm, borderTop: `1px solid ${neutral[100]}`, marginTop: space.md, paddingTop: space.md }}>
                          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>命中后</span>
                          <div style={{ display: "inline-flex", overflow: "hidden", border: `1px solid ${neutral[200]}`, borderRadius: radius.sm }}>
                            {(["deliver", "discard"] as Action[]).map((a) => {
                              const t = semantic[a]; const active = rule.action === a;
                              return <button key={a} onClick={() => updateRule(rule.id, { action: a })}
                                style={{ border: "none", cursor: "pointer", padding: `${space.xs}px ${space.md}px`, fontSize: fontSize.xs,
                                  background: active ? t.bg : "#FFFFFF", color: active ? t.color : neutral[500], fontWeight: active ? 600 : 400, ...baseFont }}>
                                {a === "deliver" ? "放行" : "丢弃"}
                              </button>;
                            })}
                          </div>
                          <select value={rule.logic} onChange={(e) => updateRule(rule.id, { logic: e.target.value as Logic })} style={{ ...inputStyle, width: 104 }}>
                            <option value="and">条件间 AND</option><option value="or">条件间 OR</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* ② 消息模板 */}
                <section>
                  <SectionTitle index="2" title="消息模板" desc="从 JSON 提取变量，组合成一条用户消息" />
                  <div style={{ border: `1px solid ${neutral[200]}`, borderRadius: radius.md, overflow: "hidden" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "90px 180px 100px 1fr 24px", gap: 6, padding: `${space.sm}px ${space.md}px`, background: neutral[50], color: neutral[500], fontSize: fontSize.xs }}>
                      <span>变量名</span><span>JSON 路径</span><span>默认值</span><span>示例值（实时解析）</span><span />
                    </div>
                    {variables.map((v) => {
                      const raw = getByPath(parsedSample, v.path);
                      const preview = raw === undefined || raw === null || raw === "" ? v.fallback : String(raw);
                      return (
                        <div key={v.id} style={{ display: "grid", gridTemplateColumns: "90px 180px 100px 1fr 24px", gap: 6, padding: `${space.xs}px ${space.md}px`, borderTop: `1px solid ${neutral[100]}`, alignItems: "center" }}>
                          <input data-testid="wpr-var-name" value={v.name} onChange={(e) => setVariables((vs) => vs.map((x) => x.id === v.id ? { ...x, name: e.target.value } : x))} style={{ ...inputStyle, fontFamily: fontFamily.mono }} />
                          <input data-testid="wpr-var-path" value={v.path} onChange={(e) => setVariables((vs) => vs.map((x) => x.id === v.id ? { ...x, path: e.target.value } : x))} style={{ ...inputStyle, fontFamily: fontFamily.mono }} />
                          <input value={v.fallback} onChange={(e) => setVariables((vs) => vs.map((x) => x.id === v.id ? { ...x, fallback: e.target.value } : x))} style={inputStyle} />
                          <span style={{ fontSize: fontSize.xs, color: neutral[500], overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={preview}>{preview || "—"}</span>
                          <button onClick={() => setVariables((vs) => vs.filter((x) => x.id !== v.id))} style={{ border: "none", background: "transparent", cursor: "pointer", color: neutral[400] }}>×</button>
                        </div>
                      );
                    })}
                    <div style={{ padding: `${space.sm}px ${space.md}px`, borderTop: `1px solid ${neutral[100]}` }}>
                      <button onClick={() => setVariables((vs) => [...vs, { id: `v${Date.now()}`, name: "newVar", path: "", fallback: "" }])}
                        style={{ ...ghostBtn, fontSize: fontSize.xs, color: semantic.brand.color }}>＋ 添加变量</button>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md, marginTop: space.md }}>
                    <div>
                      <label style={{ display: "block", fontSize: fontSize.xs, fontWeight: 500, color: neutral[600], marginBottom: 6 }}>正文模板（支持 {'{{变量名}}'}）</label>
                      <textarea data-testid="wpr-template" value={template} onChange={(e) => setTemplate(e.target.value)} rows={8}
                        style={{ width: "100%", boxSizing: "border-box", resize: "vertical", border: `1px solid ${neutral[200]}`, borderRadius: radius.md, padding: space.md,
                          fontFamily: fontFamily.mono, fontSize: fontSize.xs, lineHeight: 1.7, color: neutral[700], outline: "none" }} />
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                        {variables.map((v) => <button key={v.id} onClick={() => setTemplate((t) => `${t}{{${v.name}}}`)}
                          style={{ border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: radius.sm, background: neutral[100], color: neutral[600], fontFamily: fontFamily.mono, fontSize: 10 }}>
                          {`{{${v.name}}}`}
                        </button>)}
                      </div>
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: fontSize.xs, fontWeight: 500, color: neutral[600], marginBottom: 6 }}>消息预览</label>
                      <div data-testid="wpr-preview" style={{ minHeight: 168, padding: space.md, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, background: neutral[50],
                        fontSize: fontSize.sm, lineHeight: 1.9, color: neutral[700], whiteSpace: "pre-wrap" }}>
                        {previewText}
                      </div>
                    </div>
                  </div>
                </section>

                {/* ③ 投递目标 */}
                <section>
                  <SectionTitle index="3" title="投递目标" desc="渠道按「团队群聊（可多选）」或「成员私聊（唯一成员）」二选一，与渠道绑定互斥" />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.sm }}>
                    <DeliveryModeTile mode="teams" checked={targetMode === "teams"} onChange={() => setTargetMode("teams")}
                      title="团队群聊" subtitle="渠道可绑多个团队群聊（多群 fan-out）" />
                    <DeliveryModeTile mode="member" checked={targetMode === "member"} onChange={() => setTargetMode("member")}
                      title="成员私聊" subtitle="渠道只能绑一个成员（与团队群聊互斥）" />
                  </div>

                  {targetMode === "teams" ? (
                    <div style={{ display: "grid", gap: 6 }}>
                      <p style={{ fontSize: fontSize.xs, color: neutral[500], margin: `${space.md}px 0 ${space.sm}px` }}>团队群聊列表（多选，每团队一个群）</p>
                      {CHAT_TARGETS.map((t) => {
                        const checked = targetTeams.includes(t.id);
                        return (
                          <button key={t.id} data-testid={`wpr-target-${t.id}`}
                            onClick={() => setTargetTeams((ids) => checked ? ids.filter((x) => x !== t.id) : [...ids, t.id])}
                            style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.sm}px ${space.md}px`, textAlign: "left", cursor: "pointer",
                              border: `1px solid ${checked ? "#93C5FD" : neutral[200]}`, borderRadius: radius.md, background: checked ? semantic.brand.bg : "#FFFFFF", ...baseFont }}>
                            <Checkbox checked={checked} />
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: "block", fontSize: fontSize.sm, fontWeight: 500, color: neutral[800] }}>{t.name}</span>
                              <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>{t.desc}</span>
                            </span>
                          </button>
                        );
                      })}
                      {targetTeams.length === 0 && (
                        <p style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 6 }}>不选：沿用渠道现有团队绑定</p>
                      )}
                      <p style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: space.md }}>消息接入方式（可选，团队群聊模式）：</p>
                      {ROUTE_MODES.map((r) => {
                        const checked = routeMode === r.value;
                        return (
                          <button key={r.value} data-testid={`wpr-route-${r.value}`} onClick={() => setRouteMode(r.value)}
                            style={{ display: "flex", alignItems: "flex-start", gap: space.sm, padding: `${space.sm}px ${space.md}px`, textAlign: "left", cursor: "pointer",
                              border: `1px solid ${checked ? "#93C5FD" : neutral[200]}`, borderRadius: radius.md, background: checked ? semantic.brand.bg : "#FFFFFF", ...baseFont }}>
                            <Checkbox checked={checked} />
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: "block", fontSize: fontSize.sm, fontWeight: 500, color: neutral[800] }}>{r.label}</span>
                              <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>{r.hint}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ display: "grid", gap: 6 }}>
                      {MEMBER_TARGETS.map((t) => {
                        const checked = targetMember === t.id;
                        return (
                          <button key={t.id} data-testid={`wpr-target-${t.id}`}
                            onClick={() => setTargetMember((id) => (checked ? "" : t.id))}
                            style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.sm}px ${space.md}px`, textAlign: "left", cursor: "pointer",
                              border: `1px solid ${checked ? "#93C5FD" : neutral[200]}`, borderRadius: radius.md, background: checked ? semantic.brand.bg : "#FFFFFF", ...baseFont }}>
                            <Checkbox checked={checked} />
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: "block", fontSize: fontSize.sm, fontWeight: 500, color: neutral[800] }}>{t.name}</span>
                              <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>{t.desc}</span>
                            </span>
                          </button>
                        );
                      })}
                      {targetMember === "" && (
                        <p style={{ fontSize: fontSize.xs, color: neutral[400] }}>不选：沿用渠道现有绑定</p>
                      )}
                    </div>
                  )}
                </section>

                {/* ④ 测试 */}
                <section>
                  <SectionTitle index="4" title="测试" desc="不产生真实投递，仅校验配置" />
                  <div style={{ ...cardStyle, padding: space.md }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: fontSize.xs, fontWeight: 500, color: neutral[600] }}>示例 Webhook 载荷（JSON）</span>
                      <button data-testid="wpr-run-test" onClick={() => setTestResult(runTest(rules, defaultAction, variables, template, delivery, sample))}
                        style={primaryBtn}>运行测试</button>
                    </div>
                    <textarea data-testid="wpr-sample-json" value={sample} onChange={(e) => setSample(e.target.value)} rows={8}
                      style={{ width: "100%", boxSizing: "border-box", resize: "vertical", marginTop: space.sm, border: `1px solid ${neutral[200]}`, borderRadius: radius.md,
                        padding: space.md, fontFamily: fontFamily.mono, fontSize: fontSize.xs, lineHeight: 1.6, color: "#E2E8F0", background: neutral[900], outline: "none" }} />
                    {testResult && (
                      <div style={{ marginTop: space.md, padding: space.md, border: `1px solid ${neutral[200]}`, borderRadius: radius.md, background: neutral[50], display: "grid", gap: space.md }}>
                        {"error" in testResult ? (
                          <span style={{ fontSize: fontSize.sm, color: "#B91C1C" }}>{testResult.error}</span>
                        ) : (
                          <>
                            <div style={{ display: "flex", alignItems: "center", gap: space.sm, fontSize: fontSize.sm }}>
                              <span style={{ color: neutral[500] }}>过滤结果：</span>
                              <Badge tone={testResult.action}>{testResult.action === "deliver" ? "放行" : "丢弃"}</Badge>
                              <span style={{ color: neutral[400] }}>
                                {testResult.matchedRule ? `命中规则「${testResult.matchedRule.name}」` : "无规则命中，按默认动作处理"}
                              </span>
                            </div>
                            {testResult.action === "deliver" && (
                              <>
                                <div>
                                  <p style={{ fontSize: fontSize.xs, fontWeight: 500, color: neutral[500], margin: `0 0 ${space.sm}px` }}>提取变量</p>
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                    {testResult.extracted.map((e) => (
                                      <span key={e.name} style={{ padding: `${space.xs}px ${space.sm}px`, borderRadius: radius.sm, background: "#FFFFFF", border: `1px solid ${neutral[200]}`, fontFamily: fontFamily.mono, fontSize: 10, color: neutral[600] }}>
                                        {e.name}=<span style={{ color: semantic.brand.color }}>{e.value || "(空)"}</span>
                                      </span>
                                    ))}
                                  </div>
                                </div>
                                <div>
                                  <p style={{ fontSize: fontSize.xs, fontWeight: 500, color: neutral[500], margin: `0 0 ${space.sm}px` }}>渲染后的用户消息</p>
                                  <div style={{ padding: space.md, borderRadius: radius.sm, background: "#FFFFFF", border: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, lineHeight: 1.7, color: neutral[700], whiteSpace: "pre-wrap" }}>
                                    {testResult.rendered}
                                  </div>
                                </div>
                                <div style={{ fontSize: fontSize.xs, color: neutral[500] }}>
                                  投递目标：
                                  {testResult.delivery.mode === "teams" ? (
                                    <span style={{ color: neutral[700] }}>
                                      团队群聊：{testResult.delivery.teams.join("、") || "（沿用渠道绑定）"}
                                      {" → "}
                                      {testResult.delivery.route === "main"
                                        ? "路由到主 Agent（群内默认触发主 Agent 响应）"
                                        : "消息带 @Agent名的 mention 路由"}
                                    </span>
                                  ) : (
                                    <span style={{ color: neutral[700] }}>
                                      成员私聊：{MEMBER_TARGETS.find((m) => m.id === testResult.delivery.member)?.name ?? testResult.delivery.member ?? "（未指定）"}
                                    </span>
                                  )}
                                </div>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              </div>
              )}

              {/* 移动端：配置结构示意 */}
              {isMobile && (
                <div style={{ minWidth: 0, flex: 1, overflow: "auto", padding: space.lg, display: "grid", gap: space.xl }}>
                  <div style={{ padding: space.md, borderRadius: radius.md, background: semantic.info.bg, color: semantic.info.color, fontSize: fontSize.xs }}>
                    移动端仅展示配置结构示意，完整编辑建议在 PC 端进行。
                  </div>
                  <section>
                    <SectionTitle index="1" title="过滤规则" />
                    {rules.map((rule) => (
                      <div key={rule.id} style={{ ...cardStyle, marginBottom: space.sm }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: fontSize.sm, fontWeight: 600 }}>
                          <span>{rule.name}</span>
                          <Badge tone={rule.action}>{rule.action === "deliver" ? "放行" : "丢弃"}</Badge>
                        </div>
                        <p style={{ fontFamily: fontFamily.mono, fontSize: fontSize.xs, color: neutral[500], margin: "6px 0 0" }}>
                          {rule.conditions.map((c) => `${c.path} ${OP_LABELS[c.op]} ${c.value}`).join(rule.logic === "and" ? " AND " : " OR ")}
                        </p>
                      </div>
                    ))}
                  </section>
                  <section>
                    <SectionTitle index="2" title="消息模板" />
                    <div style={cardStyle}>
                      <p style={{ fontSize: fontSize.xs, fontWeight: 500, color: neutral[500], margin: `0 0 ${space.sm}px` }}>变量提取</p>
                      {variables.map((v) => <p key={v.id} style={{ fontFamily: fontFamily.mono, fontSize: fontSize.xs, color: neutral[600], margin: "3px 0" }}>{v.name} ← {v.path}</p>)}
                      <p style={{ fontSize: fontSize.xs, fontWeight: 500, color: neutral[500], margin: `${space.md}px 0 ${space.sm}px` }}>正文预览</p>
                      <div style={{ fontSize: fontSize.sm, lineHeight: 1.8, color: neutral[700], whiteSpace: "pre-wrap" }}>{previewText}</div>
                    </div>
                  </section>
                  <section>
                    <SectionTitle index="3" title="投递目标" />
                    <p style={{ fontSize: fontSize.xs, color: neutral[500] }}>
                      {targetMode === "teams"
                        ? `团队群聊（可多选）：${CHAT_TARGETS.filter((t) => targetTeams.includes(t.id)).map((t) => t.name).join("、") || "沿用渠道绑定"} · 路由：${routeMode === "main" ? "路由到主 Agent" : "消息带 @Agent名"}`
                        : `成员私聊：${MEMBER_TARGETS.find((m) => m.id === targetMember)?.name ?? targetMember ?? "未指定"}`}
                    </p>
                  </section>
                </div>
              )}
            </div>

            {/* 抽屉底栏 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${space.md}px ${space.lg}px`, borderTop: `1px solid ${neutral[100]}` }}>
              <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                策略保存在 <code style={{ fontFamily: fontFamily.mono }}>config.messagePolicies["{activeEvent}"]</code>，配置后即时生效
              </span>
              <div style={{ display: "flex", gap: space.sm }}>
                <button onClick={() => setOpenChannel(null)} style={outlineBtn}>取消</button>
                <button data-testid="wpr-save" onClick={() => { toastMsg(`已保存 ${PRESETS[activeEvent].label} 的消息处理策略`); setOpenChannel(null); }} style={primaryBtn}>保存配置</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 60,
          padding: `${space.sm}px ${space.lg}px`, borderRadius: radius.md, background: neutral[900], color: "#FFFFFF", fontSize: fontSize.sm, boxShadow: shadow.lg }}>
          {toast}
        </div>
      )}

      <NavDock activeKey="messages" projectName="Agent 协作平台" />
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} items={CMDK_ITEMS} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "webhook-policy",
    name: "Webhook 消息规则",
    group: "渠道集成",
    description:
      "入站 Webhook 消息处理策略配置：按事件（Issue / PR / Push / 默认）编排 ① 过滤规则（条件构建器 path/op/value + AND/OR + 放行/丢弃 + 默认动作 + 从示例 JSON 选字段）② 消息模板（变量提取 name ← JSON path + 默认值 + 示例值实时解析，正文模板 {{变量}} 插值 + 实时预览）③ 投递目标（团队群聊 / Agent / 成员私聊多选，为空沿用渠道绑定）④ 测试（示例载荷运行测试，输出命中规则 / 提取变量 / 渲染正文 / 投递目标，不产生真实投递）",
    device: "both",
  },
  Component: WebhookPolicyPage,
};

export default def;
