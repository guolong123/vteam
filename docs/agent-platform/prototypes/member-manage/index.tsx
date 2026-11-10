/**
 * 原型：成员库管理（member-manage）· 成员平台级 · 先建成员再建群
 * ============================================================
 * 背景：本迭代把「成员」从「群聊(Team)」中解耦出来：
 * - 成员是平台级资产，独立增删改查，不再依附于某个群聊；
 * - 群聊只是「引用」成员，一个成员可同时加入多个群聊；
 * - 因而产品流程变为「先在成员库建成员 → 建群时从成员库勾选」。
 *
 * 页面结构（桌面 1280×800 DeviceFrame 内）：
 * - 顶部：NavTopBar 面包屑（Agent 协作平台 › 成员库）+ Cmd+K。
 * - 概览条：成员总数 / 在线 / 已入群 / 全局会话数 + 解耦说明（成员与群聊多对多）。
 * - 成员列表：表格式（头像 / 名称+成员ID / 角色·岗位 / 绑定 Agent / 默认模型 /
 *   全局会话 / 所在群聊 / 状态 / 操作），支持搜索与角色筛选。
 * - 新建成员：右侧抽屉（名称、角色/岗位、执行 Agent、默认模型、首选 worker、
 *   工作目录、性格 persona、技能多选、是否主 Agent 候选）→ 创建后直接进列表。
 * - 加入群聊：弹窗多选（已在的群聊禁用并标注），体现一个成员可属多个群聊。
 * - 通知渠道归属（本迭代新增，产品裁决 Q25 独占）：出站通知渠道**归属唯一**——同一渠道只能
 *   属于一个团队或一个成员，不能同时绑定。成员抽屉里「已被团队/其他成员占用」的渠道禁用，
 *   显示归属徽章，只能通过「转移归属」二次确认后独占转移（原归属方将不再收到该渠道通知）。
 * - 双工作目录（设计 §3.6.4 / D3 / v1.3）：**私有目录是默认工作目录**（会话默认 cwd，
 *   个人工作台）；**团队目录可选、可切换（需授权）**——团队任务由模型在服务端按本轮席位
 *   授权后切换过去。抽屉内两行分开展示，私有目录为主字段。
 * - 全局会话（新版设计 §3.5）：**一个成员全局只有一个 session**，跨群共享上下文、
 *   不按群隔离。列表给出会话 ID / 上下文占用 / 最近活跃群（只读），并提供
 *   「重置全局会话」（二次确认，影响该成员所有群聊）；抽屉内同样只读展示。
 *
 * 可交互：搜索 / 角色筛选 / 新建成员（表单真实写入列表）/ 编辑（抽屉回填）/
 * 加入群聊多选 / 行操作（私聊示意）/ 轻提示反馈。
 * 复用 ../_shared 的 AgentAvatar / AgentBadge 与 styles token。
 *
 * ⚠️ 铁律：root height:100% + position:relative，浮层（抽屉 / 弹窗 / 提示）一律 absolute，
 * 零 fixed / 100vh / 100vw（md-docs DeviceFrame 内会溢出）。
 */
import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import { AgentAvatar, AgentBadge } from "../_shared/components";
import { NavDock, NavTopBar, CmdKPanel } from "../_shared/nav";
import {
  type RoleKey,
  roles,
  roleText,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

/* ============================================================================
 * 一、mock 数据（平台级成员库）
 * ==========================================================================*/

/** 成员状态（成员维度，非任务状态） */
type MemberState = "在线" | "处理中" | "空闲";

interface Member {
  id: string;
  /** 成员名（与 Agent 名区分：成员是「谁在协作」，Agent 是「用什么执行」） */
  name: string;
  role: RoleKey;
  state: MemberState;
  agentKey: string;
  model: string;
  worker: string;
  /** 团队（席位）工作目录：可选、可切换（需授权），团队任务执行时由模型按席位授权切换 */
  teamDir: string;
  /** 成员私有工作目录：默认工作目录（会话默认 cwd），个人工作台 */
  privateDir: string;
  persona: string;
  skills: string[];
  /** 已加入的群聊（★ 一个成员可属于多个群聊） */
  groups: string[];
  /** 是否主 Agent 候选 */
  mainCandidate: boolean;
  /** ★ 已绑定的通知渠道 id 列表（成员级，与团队级绑定互不影响） */
  notify: string[];
}

/** 通知渠道（出站）：mock 池，成员可多选绑定（团队级绑定不受影响） */
interface NotifyChannel {
  id: string;
  name: string;
  /** 渠道类型：企微群机器人 / Webhook / 钉钉 */
  type: "企微群机器人" | "Webhook" | "钉钉";
  /** ★ 归属（唯一）：团队或成员；undefined = 未归属，可自由绑定 */
  owner?: { kind: "team" | "member"; name: string };
}

const NOTIFY_CHANNELS: NotifyChannel[] = [
  // 归属唯一：团队或成员二选一，不能同时绑定
  { id: "ch-wecom-dev", name: "企微-研发群", type: "企微群机器人", owner: { kind: "team", name: "研发团队" } },
  { id: "ch-webhook-alert", name: "Webhook-告警", type: "Webhook", owner: { kind: "member", name: "陈默" } },
  { id: "ch-wecom-qa", name: "企微-测试群", type: "企微群机器人" },
  { id: "ch-dingtalk-duty", name: "钉钉-值班", type: "钉钉" },
];

const CHANNEL_MAP: Record<string, NotifyChannel> = Object.fromEntries(
  NOTIFY_CHANNELS.map((c) => [c.id, c]),
);

/** 渠道类型徽章语义色 */
const channelTypeTheme: Record<NotifyChannel["type"], { color: string; bg: string; border: string }> = {
  企微群机器人: { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  Webhook: { color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  钉钉: { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
};

/** 群聊池（成员加入群聊时可选；与 group-create 原型的成员库一致） */
const GROUP_POOL = ["通知中心迭代", "增长实验 · 埋点", "客户端重构二期", "设计规范梳理"];

/** 技能池（表单技能多选） */
const SKILL_POOL = [
  "需求拆解",
  "竞品分析",
  "验收标准",
  "架构评审",
  "存储方案",
  "接口设计",
  "React",
  "增量渲染",
  "单元测试",
  "回归测试",
  "用例设计",
  "性能压测",
];

const AGENT_POOL = [
  { key: "vteam-product", label: "vteam-product · 产品执行 Agent" },
  { key: "vteam-architect", label: "vteam-architect · 架构执行 Agent" },
  { key: "vteam-developer", label: "vteam-developer · 开发执行 Agent" },
  { key: "vteam-tester", label: "vteam-tester · 测试执行 Agent" },
];

const MODEL_POOL = ["claude-sonnet-4.5", "deepseek-v3.2", "gpt-5.2", "qwen3-max"];

const WORKER_POOL = ["worker-mac-01", "worker-mac-02", "worker-mac-03", "worker-win-01"];

const SEED_MEMBERS: Member[] = [
  {
    id: "m-lin",
    name: "林知远",
    role: "product",
    state: "在线",
    agentKey: "vteam-product",
    model: "claude-sonnet-4.5",
    worker: "worker-mac-01",
    teamDir: "/data/vteam-worker/notify-center",
    privateDir: "~/work/linzhiyuan",
    persona: "结论先行，先给判断再给依据",
    skills: ["需求拆解", "竞品分析", "验收标准"],
    groups: ["通知中心迭代", "增长实验 · 埋点"],
    mainCandidate: true,
    notify: [],
  },
  {
    id: "m-chen",
    name: "陈默",
    role: "architect",
    state: "在线",
    agentKey: "vteam-architect",
    model: "deepseek-v3.2",
    worker: "worker-mac-02",
    teamDir: "/data/vteam-worker/arch",
    privateDir: "~/work/chenmo",
    persona: "严谨，方案必须先讲清边界",
    skills: ["架构评审", "存储方案", "接口设计"],
    groups: ["通知中心迭代", "客户端重构二期"],
    mainCandidate: true,
    notify: ["ch-webhook-alert"],
  },
  {
    id: "m-zhou",
    name: "周野",
    role: "developer",
    state: "处理中",
    agentKey: "vteam-developer",
    model: "claude-sonnet-4.5",
    worker: "worker-mac-03",
    teamDir: "/data/vteam-worker/vteam-web",
    privateDir: "~/work/zhouye",
    persona: "先跑通再优化，重视可回归",
    skills: ["React", "增量渲染", "单元测试"],
    groups: ["通知中心迭代", "增长实验 · 埋点", "客户端重构二期"],
    mainCandidate: false,
    notify: [],
  },
  {
    id: "m-su",
    name: "苏打",
    role: "tester",
    state: "空闲",
    agentKey: "vteam-tester",
    model: "gpt-5.2",
    worker: "worker-win-01",
    teamDir: "/data/vteam-worker/qa",
    privateDir: "~/work/suda",
    persona: "挑剔，先写用例再动手",
    skills: ["回归测试", "用例设计", "性能压测"],
    groups: ["通知中心迭代"],
    mainCandidate: false,
    notify: [],
  },
  {
    id: "m-jiang",
    name: "江禾",
    role: "product",
    state: "空闲",
    agentKey: "vteam-product",
    model: "qwen3-max",
    worker: "worker-mac-01",
    teamDir: "/data/vteam-worker/growth",
    privateDir: "~/work/jianghe",
    persona: "数据驱动，喜欢用实验结果说话",
    skills: ["需求拆解", "竞品分析"],
    groups: [],
    mainCandidate: false,
    notify: [],
  },
  {
    id: "m-lu",
    name: "陆川",
    role: "developer",
    state: "在线",
    agentKey: "vteam-developer",
    model: "deepseek-v3.2",
    worker: "worker-mac-02",
    teamDir: "/data/vteam-worker/vteam-server",
    privateDir: "~/work/luchuan",
    persona: "稳，接口先定契约再实现",
    skills: ["增量渲染", "单元测试"],
    groups: ["客户端重构二期"],
    mainCandidate: false,
    notify: [],
  },
  {
    id: "m-he",
    name: "何星",
    role: "architect",
    state: "空闲",
    agentKey: "vteam-architect",
    model: "claude-sonnet-4.5",
    worker: "worker-mac-03",
    teamDir: "/data/vteam-worker/design-system",
    privateDir: "~/work/hexing",
    persona: "重视一致性，先看历史包袱",
    skills: ["架构评审", "接口设计"],
    groups: [],
    mainCandidate: false,
    notify: [],
  },
  {
    id: "m-tong",
    name: "童童",
    role: "tester",
    state: "在线",
    agentKey: "vteam-tester",
    model: "qwen3-max",
    worker: "worker-win-01",
    teamDir: "/data/vteam-worker/qa",
    privateDir: "~/work/tongtong",
    persona: "细致，边界条件一个不放过",
    skills: ["回归测试", "性能压测"],
    groups: ["增长实验 · 埋点"],
    mainCandidate: false,
    notify: [],
  },
];

/** 全局会话（★ 成员维度、跨群唯一）：一个成员只有 1 个 session，所有群聊共享同一份上下文 */
interface MemberSession {
  id: string;
  /** 上下文占用百分比（0-100） */
  percent: number;
  /** 上下文规模展示值 */
  tokens: string;
  /** 最近活跃群聊（只读信息，不代表「会话属于该群」） */
  lastActive: string;
}

/** 初始全局会话（与 wechat-chat 原型同一套语义） */
const SEED_SESSIONS: Record<string, MemberSession> = {
  "m-lin": { id: "mem-sess-7f3a", percent: 42, tokens: "18.6k tokens", lastActive: "通知中心迭代" },
  "m-chen": { id: "mem-sess-91c4", percent: 63, tokens: "27.4k tokens", lastActive: "客户端重构二期" },
  "m-zhou": { id: "mem-sess-4b82", percent: 55, tokens: "24.1k tokens", lastActive: "通知中心迭代" },
  "m-su": { id: "mem-sess-c05d", percent: 18, tokens: "7.9k tokens", lastActive: "通知中心迭代" },
  "m-jiang": { id: "mem-sess-1e77", percent: 6, tokens: "2.6k tokens", lastActive: "—" },
  "m-lu": { id: "mem-sess-9a31", percent: 31, tokens: "13.7k tokens", lastActive: "客户端重构二期" },
  "m-he": { id: "mem-sess-3d6b", percent: 4, tokens: "1.8k tokens", lastActive: "—" },
  "m-tong": { id: "mem-sess-b204", percent: 22, tokens: "9.4k tokens", lastActive: "增长实验 · 埋点" },
};

/* ============================================================================
 * 二、布局常量 / scoped 样式
 * ==========================================================================*/

const baseFont: CSSProperties = { fontFamily: fontFamily.body };
const RAIL_W = 56;

/** 成员表格列宽（表头与行共用，保证对齐） */
const COLS = "1.75fr 0.78fr 1fr 1.15fr 1.18fr 0.95fr 0.85fr 0.54fr 1.32fr";

/** scoped 动画（mm- 前缀防污染） */
const mmCss = `
@keyframes mm-pulse { 0%,100% { opacity:.35 } 50% { opacity:1 } }
@keyframes mm-slide { from { transform: translateX(24px); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes mm-pop { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
`;

/* ============================================================================
 * 三、通用小件
 * ==========================================================================*/

/** 在线状态点 + 文案（成员状态维度的语义色） */
function StateDot({ state, role }: { state: MemberState; role: RoleKey }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, fontSize: fontSize.xs }}>
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: state === "空闲" ? neutral[400] : roleText[role],
          animation: state === "处理中" ? "mm-pulse 1.2s ease-in-out infinite" : undefined,
          flexShrink: 0,
        }}
      />
      <span style={{ color: neutral[600], whiteSpace: "nowrap" }}>{state}</span>
    </span>
  );
}

/** 群聊 chip：先给「所在群聊数」，再给首个群名（悬停可见全部，体现成员可属多群） */
function GroupChips({ groups, max = 1 }: { groups: string[]; max?: number }) {
  if (groups.length === 0) {
    return <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>未加入群聊</span>;
  }
  const shown = groups.slice(0, max);
  return (
    <span
      title={`共 ${groups.length} 个群聊：${groups.join("、")}`}
      style={{ display: "inline-flex", alignItems: "center", gap: space.xs, minWidth: 0 }}
    >
      <span style={{ fontSize: 10, color: neutral[400], whiteSpace: "nowrap", flexShrink: 0 }}>
        {groups.length} 个
      </span>
      {shown.map((g) => (
        <span
          key={g}
          style={{
            padding: "1px 6px",
            borderRadius: radius.sm,
            backgroundColor: "#EFF6FF",
            border: "1px solid #BFDBFE",
            color: "#2563EB",
            fontSize: 10,
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 108,
          }}
        >
          {g}
        </span>
      ))}
      {/* 总数已在前面展示，其余群名放在 title 里，避免 +N 与「N 个」重复 */}
    </span>
  );
}

/** 主要操作按钮 */
function PrimaryBtn({
  label,
  onClick,
  disabled,
  testid,
  title,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  testid?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={title ?? label}
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: `${space.xs + 2}px ${space.lg}px`,
        borderRadius: radius.md,
        border: "none",
        backgroundColor: disabled ? neutral[200] : "#2563EB",
        color: disabled ? neutral[400] : "#FFFFFF",
        fontSize: fontSize.sm,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      {label}
    </button>
  );
}

/** 次要按钮 */
function SecondaryBtn({
  label,
  onClick,
  testid,
}: {
  label: string;
  onClick?: () => void;
  testid?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      style={{
        padding: `${space.xs + 2}px ${space.lg}px`,
        borderRadius: radius.md,
        border: `1px solid ${neutral[200]}`,
        backgroundColor: "#FFFFFF",
        color: neutral[600],
        fontSize: fontSize.sm,
        fontWeight: 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      {label}
    </button>
  );
}

/** 行内小操作（表格操作列） */
function RowAction({ label, title, onClick }: { label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="row-action"
      aria-label={title ?? label}
      title={title ?? label}
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        color: "#2563EB",
        fontSize: fontSize.xs,
        fontWeight: 500,
        cursor: "pointer",
        padding: `0 ${space.xs}px`,
        whiteSpace: "nowrap",
        ...baseFont,
      }}
    >
      {label}
    </button>
  );
}

/** 表单字段：label + 控件 */
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: space.xs }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700] }}>{label}</span>
        {hint && <span style={{ fontSize: 10, color: neutral[400] }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** 表单控件通用样式 */
const inputStyle: CSSProperties = {
  width: "100%",
  height: 34,
  padding: `0 ${space.sm + 2}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "#FFFFFF",
  color: neutral[800],
  fontSize: fontSize.sm,
  outline: "none",
  boxSizing: "border-box",
  ...baseFont,
};

/* ============================================================================
 * 四、主组件
 * ==========================================================================*/

/** 抽屉表单结构（新建 / 编辑共用） */
interface MemberForm {
  name: string;
  role: RoleKey;
  agentKey: string;
  model: string;
  worker: string;
  teamDir: string;
  privateDir: string;
  persona: string;
  skills: string[];
  mainCandidate: boolean;
  /** 成员级通知渠道绑定（多选） */
  notify: string[];
}

const EMPTY_FORM: MemberForm = {
  name: "",
  role: "developer",
  agentKey: "vteam-developer",
  model: "claude-sonnet-4.5",
  worker: "worker-mac-01",
  teamDir: "",
  privateDir: "~/work/",
  persona: "",
  skills: [],
  mainCandidate: false,
  notify: [],
};

/** 重置全局会话二次确认：影响该成员在所有群聊的上下文（不可恢复） */
function ResetSessionModal({
  member,
  session,
  onCancel,
  onConfirm,
}: {
  member: Member;
  session: MemberSession;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      data-testid="session-reset-overlay"
      onClick={onCancel}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 46,
        backgroundColor: "rgba(15,23,42,.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
      }}
    >
      <div
        data-testid="session-reset-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 470,
          maxWidth: "100%",
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          boxShadow: shadow.lg,
          padding: space.xl,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          animation: "mm-pop .16s ease-out",
          ...baseFont,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <AgentAvatar role={member.role} size="md" initials={member.name.slice(0, 1)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              重置「{member.name}」的全局会话
            </div>
            <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
              会话 {session.id} · {session.percent}% · {session.tokens}
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            style={{
              border: "none",
              background: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              cursor: "pointer",
              lineHeight: 1,
              padding: space.xs,
              ...baseFont,
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: "#FEF2F2",
            border: "1px solid #FECACA",
            color: "#B91C1C",
            fontSize: fontSize.xs,
            lineHeight: 1.75,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>⚠ 影响该成员在所有群聊的上下文</div>
          该成员在{" "}
          {member.groups.length > 0
            ? member.groups.map((g) => `「${g}」`).join("、")
            : "所有群聊（当前未加入群聊）"}{" "}
          中共享同一个全局会话；重置会清空全部上下文（当前 {session.tokens}），其他群聊里依赖该上下文的
          进行中任务会失去上下文，且不可恢复。
        </div>

        <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.7 }}>
          重置后：会话 ID 保持不变，上下文归零，状态变为空闲；该成员在私聊与所有群聊中同时生效。
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, paddingTop: space.xs }}>
          <button
            type="button"
            data-testid="reset-cancel"
            onClick={onCancel}
            style={{
              padding: `${space.xs + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.sm,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="reset-confirm"
            onClick={onConfirm}
            style={{
              padding: `${space.xs + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#DC2626",
              color: "#FFFFFF",
              fontSize: fontSize.sm,
              fontWeight: 600,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            确认重置（影响 {Math.max(1, member.groups.length)} 个群聊）
          </button>
        </div>
      </div>
    </div>
  );
}

/** 转移渠道归属二次确认：归属唯一，转移后原归属方将不再收到该渠道通知 */
function TransferChannelModal({
  channel,
  targetName,
  onCancel,
  onConfirm,
}: {
  channel: NotifyChannel;
  targetName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const owner = channel.owner;
  const fromText = owner
    ? owner.kind === "team"
      ? `团队「${owner.name}」`
      : `成员「${owner.name}」`
    : "未归属";
  return (
    <div
      data-testid="transfer-overlay"
      onClick={onCancel}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 47,
        backgroundColor: "rgba(15,23,42,.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
      }}
    >
      <div
        data-testid="transfer-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 470,
          maxWidth: "100%",
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          boxShadow: shadow.lg,
          padding: space.xl,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          animation: "mm-pop .16s ease-out",
          ...baseFont,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
              转移「{channel.name}」的归属
            </div>
            <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
              渠道归属唯一：同一渠道只能属于一个团队或一个成员
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            style={{
              border: "none",
              background: "transparent",
              color: neutral[400],
              fontSize: fontSize.lg,
              cursor: "pointer",
              lineHeight: 1,
              padding: space.xs,
              ...baseFont,
            }}
          >
            ✕
          </button>
        </div>

        {/* 渠道 + 归属变化（两行布局，避免窄宽下换行挤压） */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px solid ${neutral[200]}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
            <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[800], whiteSpace: "nowrap" }}>
              {channel.name}
            </span>
            <span
              style={{
                padding: "0 4px",
                height: 14,
                display: "inline-flex",
                alignItems: "center",
                borderRadius: 3,
                backgroundColor: channelTypeTheme[channel.type].bg,
                border: `1px solid ${channelTypeTheme[channel.type].border}`,
                color: channelTypeTheme[channel.type].color,
                fontSize: 9,
                fontWeight: 600,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {channel.type}
            </span>
          </div>
          <div style={{ fontSize: 10, color: neutral[500], lineHeight: 1.6 }}>
            当前归属：{fromText}
            <span style={{ color: neutral[300], margin: "0 4px" }}>→</span>
            转移后：成员「{targetName}」专属
          </div>
        </div>

        <div
          style={{
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: "#FFFBEB",
            border: "1px solid #FDE68A",
            color: "#B45309",
            fontSize: fontSize.xs,
            lineHeight: 1.75,
          }}
        >
          「{channel.name}」当前属于{fromText}。转为成员「{targetName}」专属后，
          {fromText}将不再收到该渠道通知（原归属方的绑定会被移除），且该渠道不会再出现在团队级通知里。
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, paddingTop: space.xs }}>
          <button
            type="button"
            data-testid="transfer-cancel"
            onClick={onCancel}
            style={{
              padding: `${space.xs + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.sm,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="transfer-confirm"
            onClick={onConfirm}
            style={{
              padding: `${space.xs + 2}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#D97706",
              color: "#FFFFFF",
              fontSize: fontSize.sm,
              fontWeight: 600,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            确认转移
          </button>
        </div>
      </div>
    </div>
  );
}

function MemberManage(_: PrototypeRenderProps) {
  const [members, setMembers] = useState<Member[]>(SEED_MEMBERS);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleKey | "all">("all");
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [toast, setToast] = useState("");

  /** 抽屉：null=关闭；新建时 memberId 为空 */
  const [drawer, setDrawer] = useState<{ memberId?: string } | null>(null);
  const [form, setForm] = useState<MemberForm>(EMPTY_FORM);
  /** 加入群聊弹窗：null=关闭 */
  const [groupPanel, setGroupPanel] = useState<string | null>(null);
  /** 加入群聊弹窗中的勾选 */
  const [pickedGroups, setPickedGroups] = useState<string[]>([]);
  /** 全局会话（成员维度、跨群唯一；重置只清空上下文，会话 ID 不变） */
  const [sessions, setSessions] = useState<Record<string, MemberSession>>(SEED_SESSIONS);
  /** 正在二次确认「重置全局会话」的成员 id（null = 无弹窗） */
  const [resetFor, setResetFor] = useState<string | null>(null);
  /** 通知渠道池（含归属，可因「转移归属」而变化） */
  const [channels, setChannels] = useState<NotifyChannel[]>(NOTIFY_CHANNELS);
  /** 正在二次确认「转移归属」的渠道 id（null = 无弹窗） */
  const [transferFor, setTransferFor] = useState<string | null>(null);

  const stats = useMemo(() => {
    const total = members.length;
    const online = members.filter((m) => m.state !== "空闲").length;
    const inGroup = members.filter((m) => m.groups.length > 0).length;
    const multiGroup = members.filter((m) => m.groups.length > 1).length;
    /** 已绑定通知渠道的成员数（成员级绑定，与团队级无关） */
    const notifyMembers = members.filter((m) => m.notify.length > 0).length;
    return { total, online, inGroup, multiGroup, notifyMembers };
  }, [members]);

  /** 取成员的全局会话（新建成员会即时分配，重置后 percent/tokens 归零） */
  const sessionOf = (m: Member): MemberSession =>
    sessions[m.id] ?? { id: `mem-sess-${m.id.slice(-4)}`, percent: 0, tokens: "0 tokens", lastActive: "—" };

  /** 当前抽屉对应的成员名（用于判断渠道是否已归属「本成员」） */
  const drawerMember = drawer?.memberId ? members.find((m) => m.id === drawer.memberId) ?? null : null;
  const drawerSelfName = drawerMember?.name ?? form.name.trim();

  const shown = useMemo(
    () =>
      members.filter((m) => {
        if (roleFilter !== "all" && m.role !== roleFilter) return false;
        if (!query.trim()) return true;
        const q = query.trim();
        return (
          m.name.includes(q) ||
          m.agentKey.includes(q) ||
          m.skills.some((s) => s.includes(q)) ||
          m.groups.some((g) => g.includes(q))
        );
      }),
    [members, query, roleFilter],
  );

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setDrawer({});
  };

  const openEdit = (m: Member) => {
    setForm({
      name: m.name,
      role: m.role,
      agentKey: m.agentKey,
      model: m.model,
      worker: m.worker,
      teamDir: m.teamDir,
      privateDir: m.privateDir,
      persona: m.persona,
      skills: [...m.skills],
      mainCandidate: m.mainCandidate,
      notify: [...m.notify],
    });
    setDrawer({ memberId: m.id });
  };

  /** 提交抽屉：新建追加到列表 / 编辑覆盖 */
  const submitDrawer = () => {
    if (!form.name.trim()) return;
    if (drawer?.memberId) {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === drawer.memberId
            ? {
                ...m,
                name: form.name.trim(),
                role: form.role,
                agentKey: form.agentKey,
                model: form.model,
                worker: form.worker,
                teamDir: form.teamDir,
                privateDir: form.privateDir,
                persona: form.persona,
                skills: form.skills,
                mainCandidate: form.mainCandidate,
                notify: form.notify,
              }
            : m,
        ),
      );
      setToast(`已更新成员「${form.name.trim()}」，群聊中的引用同步生效`);
    } else {
      const next: Member = {
        id: `m-${members.length + 1}-${Date.now().toString().slice(-4)}`,
        name: form.name.trim(),
        role: form.role,
        state: "空闲",
        agentKey: form.agentKey,
        model: form.model,
        worker: form.worker,
        teamDir: form.teamDir,
        privateDir: form.privateDir,
        persona: form.persona,
        skills: form.skills,
        groups: [],
        mainCandidate: form.mainCandidate,
        notify: form.notify,
      };
      setMembers((prev) => [next, ...prev]);
      // 新成员自动分配一个全局会话（跨群共享，不随群变化）
      setSessions((prev) => ({
        ...prev,
        [next.id]: { id: `mem-sess-${next.id.slice(-4)}`, percent: 0, tokens: "0 tokens", lastActive: "—" },
      }));
      setToast(`已创建成员「${next.name}」并分配全局会话；建群时可从成员库勾选（当前未加入任何群聊）`);
    }
    setDrawer(null);
  };

  /** 打开加入群聊弹窗：预勾选已在的群聊（disabled 展示） */
  const openGroupPanel = (m: Member) => {
    setGroupPanel(m.id);
    setPickedGroups([]);
  };

  const submitGroups = () => {
    if (!groupPanel) return;
    const m = members.find((x) => x.id === groupPanel);
    if (!m) return;
    if (pickedGroups.length === 0) {
      setGroupPanel(null);
      return;
    }
    setMembers((prev) =>
      prev.map((x) => (x.id === groupPanel ? { ...x, groups: [...x.groups, ...pickedGroups] } : x)),
    );
    setToast(`已将「${m.name}」加入 ${pickedGroups.map((g) => `「${g}」`).join("、")}（同一成员可在多个群聊中）`);
    setGroupPanel(null);
  };

  /** 转移归属：渠道原归属方被移除绑定，改为当前成员专属（归属唯一） */
  const transferChannel = (channelId: string) => {
    const ch = channels.find((c) => c.id === channelId);
    if (!ch || !ch.owner) return;
    const targetName = drawerSelfName || "当前成员";
    if (ch.owner.kind === "member" && ch.owner.name === targetName) return;
    const from = ch.owner;
    setChannels((prev) =>
      prev.map((c) => (c.id === channelId ? { ...c, owner: { kind: "member", name: targetName } } : c)),
    );
    setForm((f) => (f.notify.includes(channelId) ? f : { ...f, notify: [...f.notify, channelId] }));
    if (drawer?.memberId) {
      setMembers((prev) =>
        prev.map((m) =>
          m.id === drawer.memberId && !m.notify.includes(channelId)
            ? { ...m, notify: [...m.notify, channelId] }
            : m,
        ),
      );
    }
    setTransferFor(null);
    setToast(
      `已将「${ch.name}」转移为「${targetName}」的成员专属渠道；${
        from.kind === "team" ? `团队「${from.name}」` : `成员「${from.name}」`
      }将不再收到该渠道通知`,
    );
  };

  const panelMember = groupPanel ? members.find((m) => m.id === groupPanel) ?? null : null;

  return (
    <div
      data-testid="member-manage-root"
      style={{ height: "100%", minHeight: 720, position: "relative", backgroundColor: neutral[50], ...baseFont }}
    >
      <style>{mmCss}</style>

      <NavTopBar breadcrumb={["Agent 协作平台", "成员库"]} onCmdKClick={() => setCmdkOpen(true)} />

      {/* 内容区：顶栏以下绝对填满，paddingLeft 避让悬浮 Dock */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          paddingLeft: RAIL_W + 24,
          display: "flex",
          flexDirection: "column",
          gap: space.sm,
          padding: `${space.md}px ${space.lg}px ${space.md}px ${RAIL_W + 24}px`,
        }}
      >
        {/* 标题行 */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: space.md, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <span style={{ fontSize: fontSize.xxl, fontWeight: 600, color: neutral[900], lineHeight: 1.25 }}>
                成员库
              </span>
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: radius.sm,
                  backgroundColor: "#EFF6FF",
                  border: "1px solid #BFDBFE",
                  color: "#2563EB",
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                平台级
              </span>
            </div>
            <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 3, lineHeight: 1.5 }}>
              成员与群聊解耦：成员可先创建、独立管理；群聊只引用成员，一个成员可加入多个群聊。
              <span
                data-testid="member-source-note"
                style={{ display: "block", marginTop: 2, color: neutral[500] }}
              >
                在群聊/建群时新建的成员也会出现在这里，可统一编辑、停用、绑定通知渠道、加入其他群。
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
            <SecondaryBtn label="加入群聊说明" onClick={() => setToast("一个成员可同时在多个群聊：群聊侧只是引用，删除群聊不会删除成员")} />
            <PrimaryBtn
              label="＋ 新建成员"
              onClick={openCreate}
              testid="new-member-btn"
              title="新建的成员会直接保存到成员库；建群时新建的成员也会出现在这里，可统一编辑、停用、绑定通知渠道、加入其他群"
            />
          </div>
        </div>

        {/* 概览条 */}
        <div
          data-testid="member-stats"
          style={{
            flexShrink: 0,
            display: "grid",
            gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
            gap: space.md,
          }}
        >
          {[
            { label: "成员总数", value: stats.total, hint: "平台成员库" },
            { label: "在线 / 处理中", value: stats.online, hint: "可立即接任务" },
            { label: "已加入群聊", value: stats.inGroup, hint: `其中 ${stats.multiGroup} 位跨多个群聊` },
            { label: "全局会话", value: stats.total, hint: "每成员 1 个 · 跨群共享" },
            { label: "成员专属渠道", value: stats.notifyMembers, hint: `已绑定 / 共 ${stats.total} 位成员` },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                backgroundColor: "#FFFFFF",
                border: `1px solid ${neutral[200]}`,
                borderRadius: radius.lg,
                padding: `${space.sm + 2}px ${space.lg}px`,
                boxShadow: shadow.sm,
              }}
            >
              <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>{s.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: space.sm, marginTop: 2 }}>
                <span style={{ fontSize: fontSize.xxl, fontWeight: 600, color: neutral[900], lineHeight: 1.2 }}>
                  {s.value}
                </span>
                <span style={{ fontSize: 10, color: neutral[400] }}>{s.hint}</span>
              </div>
            </div>
          ))}
        </div>

        {/* 工具条：搜索 + 角色筛选 + 计数 */}
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: space.sm }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              height: 32,
              width: 280,
              padding: `0 ${space.sm + 2}px`,
              borderRadius: radius.md,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
            }}
          >
            <span aria-hidden style={{ color: neutral[400], fontSize: fontSize.md, lineHeight: 1 }}>
              ⌕
            </span>
            <input
              data-testid="member-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索成员 / Agent / 技能 / 群聊"
              aria-label="搜索成员"
              style={{
                flex: 1,
                minWidth: 0,
                height: "100%",
                border: "none",
                outline: "none",
                background: "transparent",
                color: neutral[700],
                fontSize: fontSize.sm,
                ...baseFont,
              }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: space.xs }}>
            {(["all", "product", "architect", "developer", "tester"] as const).map((r) => {
              const on = roleFilter === r;
              const label = r === "all" ? "全部角色" : roles[r].label;
              return (
                <button
                  key={r}
                  type="button"
                  data-testid="role-filter"
                  data-active={on ? "true" : "false"}
                  onClick={() => setRoleFilter(r)}
                  style={{
                    padding: `${space.xs}px ${space.sm + 2}px`,
                    borderRadius: radius.pill,
                    border: `1px solid ${on ? (r === "all" ? "#BFDBFE" : roles[r].border) : neutral[200]}`,
                    backgroundColor: on ? (r === "all" ? "#EFF6FF" : roles[r].bg) : "#FFFFFF",
                    color: on ? (r === "all" ? "#2563EB" : roleText[r]) : neutral[500],
                    fontSize: fontSize.xs,
                    fontWeight: on ? 600 : 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    ...baseFont,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400] }}>
            共 {shown.length} / {members.length} 位成员
          </span>
        </div>

        {/* 成员列表（表格卡片，超出滚动） */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.lg,
            boxShadow: shadow.sm,
            overflow: "hidden",
          }}
        >
          {/* 表头 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: space.md,
              alignItems: "center",
              padding: `${space.xs + 2}px ${space.lg}px`,
              backgroundColor: neutral[50],
              borderBottom: `1px solid ${neutral[200]}`,
              fontSize: 10,
              fontWeight: 600,
              color: neutral[500],
              letterSpacing: "0.02em",
              flexShrink: 0,
            }}
          >
            <span>成员</span>
            <span>角色 / 岗位</span>
            <span>绑定 Agent</span>
            <span>默认模型</span>
            <span>全局会话</span>
            <span>成员专属渠道</span>
            <span>所在群聊</span>
            <span>状态</span>
            <span style={{ textAlign: "right" }}>操作</span>
          </div>

          {/* 行 */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {shown.map((m) => (
              <div
                key={m.id}
                data-testid="member-row"
                data-id={m.id}
                title={`私有目录（默认 cwd）：${m.privateDir} ｜ 团队目录（可切换 · 需授权）：${m.teamDir || "未配置"} ｜ 成员专属渠道：${m.notify.length > 0 ? m.notify.map((id) => CHANNEL_MAP[id]?.name ?? id).join("、") : "无（团队渠道仍可用）"}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: COLS,
                  gap: space.md,
                  alignItems: "center",
                  padding: `${space.sm + 2}px ${space.lg}px`,
                  borderBottom: `1px solid ${neutral[100]}`,
                  fontSize: fontSize.sm,
                }}
              >
                {/* 成员 */}
                <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
                  <AgentAvatar role={m.role} size="md" initials={m.name.slice(0, 1)} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: space.xs }}>
                      <span style={{ fontSize: fontSize.md, fontWeight: 600, color: neutral[900] }}>{m.name}</span>
                      {m.mainCandidate && (
                        <span
                          data-testid="main-candidate-badge"
                          style={{
                            padding: "0 5px",
                            height: 15,
                            display: "inline-flex",
                            alignItems: "center",
                            borderRadius: 4,
                            backgroundColor: "#FFFBEB",
                            border: "1px solid #FDE68A",
                            color: "#B45309",
                            fontSize: 9,
                            fontWeight: 600,
                          }}
                        >
                          推荐主 Agent
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: neutral[400], fontFamily: fontFamily.mono }}>
                      {m.id} · {m.skills.length} 项技能
                    </div>
                  </div>
                </div>

                {/* 角色 */}
                <div>
                  <AgentBadge role={m.role} />
                </div>

                {/* 绑定 Agent（单行省略，避免窄列换行） */}
                <div
                  title={m.agentKey}
                  style={{
                    fontFamily: fontFamily.mono,
                    fontSize: 11,
                    color: neutral[600],
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.agentKey}
                </div>

                {/* 默认模型（单行省略） */}
                <div
                  title={m.model}
                  style={{
                    fontFamily: fontFamily.mono,
                    fontSize: 11,
                    color: neutral[600],
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.model}
                </div>

                {/* 全局会话（成员唯一、跨群共享；最近活跃群只读） */}
                <div data-testid="session-cell" style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: space.xs, minWidth: 0 }}>
                    <span
                      title={`会话 ID：${sessionOf(m).id}`}
                      style={{
                        fontFamily: fontFamily.mono,
                        fontSize: 10,
                        color: neutral[600],
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        minWidth: 0,
                      }}
                    >
                      {sessionOf(m).id}
                    </span>
                    <span style={{ fontSize: 9, color: neutral[400], flexShrink: 0 }}>
                      {sessionOf(m).percent}%
                    </span>
                  </div>
                  <div
                    title={`最近活跃：${sessionOf(m).lastActive}（只读，不代表会话归属该群）`}
                    style={{
                      fontSize: 10,
                      color: neutral[400],
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    最近活跃 {sessionOf(m).lastActive}
                  </div>
                </div>

                {/* 通知渠道（成员级绑定，与团队级互不影响） */}
                <div
                  data-testid="notify-cell"
                  title={
                    m.notify.length > 0
                      ? `成员专属渠道：${m.notify.map((id) => CHANNEL_MAP[id]?.name ?? id).join("、")}`
                      : "无成员专属渠道（团队渠道仍可用）"
                  }
                  style={{ minWidth: 0 }}
                >
                  {m.notify.length === 0 ? (
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>无</span>
                  ) : (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, minWidth: 0 }}>
                      <span
                        style={{
                          padding: "0 5px",
                          height: 16,
                          borderRadius: 4,
                          backgroundColor: "#EFF6FF",
                          border: "1px solid #BFDBFE",
                          color: "#2563EB",
                          fontSize: 9,
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {m.notify.length} 个
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: neutral[600],
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {CHANNEL_MAP[m.notify[0]]?.name ?? m.notify[0]}
                        {m.notify.length > 1 ? ` +${m.notify.length - 1}` : ""}
                      </span>
                    </span>
                  )}
                </div>

                {/* 所在群聊 */}
                <div style={{ minWidth: 0 }}>
                  <GroupChips groups={m.groups} max={1} />
                </div>

                {/* 状态 */}
                <div>
                  <StateDot state={m.state} role={m.role} />
                </div>

                {/* 操作 */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 0 }}>
                  <RowAction label="入群" title="加入群聊" onClick={() => openGroupPanel(m)} />
                  <RowAction label="编辑" onClick={() => openEdit(m)} />
                  <RowAction label="重置" title="重置全局会话" onClick={() => setResetFor(m.id)} />
                  <RowAction
                    label="私聊"
                    onClick={() => setToast(`打开与「${m.name}」的私聊（在会话页 wechat-chat 中查看）`)}
                  />
                </div>
              </div>
            ))}
            {shown.length === 0 && (
              <div style={{ padding: space.xxl, textAlign: "center", color: neutral[400], fontSize: fontSize.sm }}>
                没有匹配的成员，试试其他关键词或角色筛选
              </div>
            )}
          </div>

          {/* 表尾说明 */}
          <div
            style={{
              flexShrink: 0,
              padding: `${space.sm}px ${space.lg}px`,
              borderTop: `1px solid ${neutral[200]}`,
              backgroundColor: neutral[50],
              fontSize: 10,
              color: neutral[400],
              display: "flex",
              alignItems: "center",
              gap: space.sm,
            }}
          >
            <span aria-hidden style={{ color: "#2563EB" }}>
              ⓘ
            </span>
            成员删除不影响历史群聊消息；群聊解散不会删除成员（成员归属平台而非群聊）。在群聊/建群时新建的成员也会出现在这里。全局会话不随群变化，重置会影响该成员所有群聊。
            <span style={{ marginLeft: "auto" }}>下一步：在「新建群聊」中从成员库勾选成员</span>
          </div>
        </div>
      </div>

      {/* 左侧悬浮 Dock */}
      <NavDock activeKey="agents" projectName="Agent 协作平台" />

      {/* ---------------- 新建 / 编辑成员抽屉（absolute，右侧滑出） ---------------- */}
      {drawer && (
        <div
          data-testid="drawer-overlay"
          onClick={() => setDrawer(null)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 40,
            backgroundColor: "rgba(15,23,42,.24)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <div
            data-testid="member-drawer"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 470,
              maxWidth: "100%",
              height: "100%",
              backgroundColor: "#FFFFFF",
              boxShadow: shadow.lg,
              display: "flex",
              flexDirection: "column",
              animation: "mm-slide .18s ease-out",
              ...baseFont,
            }}
          >
            {/* 抽屉头 */}
            <div
              style={{
                flexShrink: 0,
                padding: `${space.lg}px ${space.xl}px`,
                borderBottom: `1px solid ${neutral[200]}`,
                display: "flex",
                alignItems: "flex-start",
                gap: space.sm,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
                  {drawer.memberId ? "编辑成员" : "新建成员"}
                </div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2, lineHeight: 1.5 }}>
                  成员属于平台，创建后可在任意群聊中被勾选；一个成员可加入多个群聊
                </div>
              </div>
              <button
                type="button"
                aria-label="关闭抽屉"
                onClick={() => setDrawer(null)}
                style={{
                  border: "none",
                  background: "transparent",
                  color: neutral[400],
                  fontSize: fontSize.lg,
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: space.xs,
                  ...baseFont,
                }}
              >
                ✕
              </button>
            </div>

            {/* 抽屉表单 */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                padding: `${space.lg}px ${space.xl}px`,
                display: "flex",
                flexDirection: "column",
                gap: space.lg,
              }}
            >
              <Field label="成员名称" hint="必填">
                <input
                  data-testid="field-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="如：林知远"
                  style={inputStyle}
                />
              </Field>

              <Field label="角色 / 岗位" hint="决定头像色与默认 Agent 策略">
                <div style={{ display: "flex", gap: space.xs, flexWrap: "wrap" }}>
                  {(Object.keys(roles) as RoleKey[]).map((r) => {
                    const on = form.role === r;
                    return (
                      <button
                        key={r}
                        type="button"
                        data-testid="form-role-option"
                        data-active={on ? "true" : "false"}
                        onClick={() =>
                          setForm({
                            ...form,
                            role: r,
                            agentKey: AGENT_POOL.find((a) => a.key.includes(r))?.key ?? form.agentKey,
                          })
                        }
                        style={{
                          padding: `${space.xs + 1}px ${space.md}px`,
                          borderRadius: radius.pill,
                          border: `1px solid ${on ? roles[r].border : neutral[200]}`,
                          backgroundColor: on ? roles[r].bg : "#FFFFFF",
                          color: on ? roleText[r] : neutral[600],
                          fontSize: fontSize.sm,
                          fontWeight: on ? 600 : 500,
                          cursor: "pointer",
                          ...baseFont,
                        }}
                      >
                        {roles[r].label}
                      </button>
                    );
                  })}
                </div>
              </Field>

              {/* 全局会话只读展示：会话不随群变化，重置影响所有群聊 */}
              <Field label="全局会话" hint="成员唯一 · 跨群共享上下文">
                {drawer.memberId ? (
                  (() => {
                    const m = members.find((x) => x.id === drawer.memberId);
                    if (!m) return null;
                    const ss = sessionOf(m);
                    return (
                      <div
                        data-testid="drawer-session"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: space.xs,
                          padding: space.sm,
                          borderRadius: radius.md,
                          backgroundColor: neutral[50],
                          border: `1px solid ${neutral[200]}`,
                        }}
                      >
                        <div style={{ display: "flex", gap: space.sm, fontSize: fontSize.xs }}>
                          <span style={{ color: neutral[400], width: 58, flexShrink: 0 }}>会话 ID</span>
                          <span style={{ fontFamily: fontFamily.mono, color: neutral[700] }}>{ss.id}</span>
                        </div>
                        <div style={{ display: "flex", gap: space.sm, fontSize: fontSize.xs }}>
                          <span style={{ color: neutral[400], width: 58, flexShrink: 0 }}>状态</span>
                          <span style={{ color: neutral[700] }}>{ss.percent > 0 ? "处理中" : "空闲"}</span>
                        </div>
                        <div style={{ display: "flex", gap: space.sm, fontSize: fontSize.xs }}>
                          <span style={{ color: neutral[400], width: 58, flexShrink: 0 }}>上下文</span>
                          <span style={{ color: neutral[700] }}>
                            {ss.percent}% · {ss.tokens}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: space.sm, fontSize: fontSize.xs }}>
                          <span style={{ color: neutral[400], width: 58, flexShrink: 0 }}>最近活跃</span>
                          <span style={{ color: neutral[700], flex: 1, minWidth: 0 }}>
                            {ss.lastActive}
                            <span style={{ color: neutral[400], fontSize: 9, marginLeft: 4 }}>只读</span>
                          </span>
                        </div>
                        <div style={{ fontSize: 9, color: neutral[400], lineHeight: 1.6 }}>
                          会话全局唯一：不随群聊变化，重置会清空该成员所有群聊的上下文。
                        </div>
                        <button
                          type="button"
                          data-testid="drawer-reset-session"
                          onClick={() => {
                            const target = members.find((x) => x.id === drawer.memberId);
                            setDrawer(null);
                            if (target) setResetFor(target.id);
                          }}
                          style={{
                            alignSelf: "flex-start",
                            padding: `2px ${space.sm}px`,
                            borderRadius: radius.sm,
                            border: "1px solid #FECACA",
                            backgroundColor: "#FEF2F2",
                            color: "#B91C1C",
                            fontSize: fontSize.xs,
                            cursor: "pointer",
                            ...baseFont,
                          }}
                        >
                          重置全局会话
                        </button>
                      </div>
                    );
                  })()
                ) : (
                  <div
                    data-testid="drawer-session"
                    style={{
                      padding: space.sm,
                      borderRadius: radius.md,
                      backgroundColor: neutral[50],
                      border: `1px dashed ${neutral[300]}`,
                      fontSize: fontSize.xs,
                      color: neutral[500],
                      lineHeight: 1.6,
                    }}
                  >
                    创建后自动分配一个全局会话（跨所有群聊共享上下文；会话不随群变化）。
                  </div>
                )}
              </Field>

              <Field label="执行 Agent" hint="成员用哪个 Agent 执行">
                <select
                  data-testid="field-agent"
                  value={form.agentKey}
                  onChange={(e) => setForm({ ...form, agentKey: e.target.value })}
                  style={inputStyle}
                >
                  {AGENT_POOL.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md }}>
                <Field label="默认模型">
                  <select
                    data-testid="field-model"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    style={inputStyle}
                  >
                    {MODEL_POOL.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="首选 Worker">
                  <select
                    data-testid="field-worker"
                    value={form.worker}
                    onChange={(e) => setForm({ ...form, worker: e.target.value })}
                    style={inputStyle}
                  >
                    {WORKER_POOL.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="私有工作目录" hint="默认工作目录（会话默认 cwd）；个人工作台">
                <input
                  data-testid="field-private-dir"
                  value={form.privateDir}
                  onChange={(e) => setForm({ ...form, privateDir: e.target.value })}
                  placeholder="~/work/<name>"
                  style={{ ...inputStyle, fontFamily: fontFamily.mono }}
                />
                <div style={{ fontSize: 9, color: neutral[400], lineHeight: 1.5 }}>
                  默认在私有目录执行；团队任务可在授权后切换到团队目录。
                </div>
              </Field>

              <Field label="团队工作目录" hint="可选 / 可切换（需授权）">
                <input
                  data-testid="field-team-dir"
                  value={form.teamDir}
                  onChange={(e) => setForm({ ...form, teamDir: e.target.value })}
                  placeholder="/data/vteam-worker/<team>（可选）"
                  style={{ ...inputStyle, fontFamily: fontFamily.mono }}
                />
                <div style={{ fontSize: 9, color: neutral[400], lineHeight: 1.5 }}>
                  仅作可切换目标：模型按需切换，服务端按本轮席位授权后生效。
                </div>
              </Field>

              <Field label="性格 / persona" hint="影响 Agent 的沟通与决策风格">
                <textarea
                  data-testid="field-persona"
                  value={form.persona}
                  onChange={(e) => setForm({ ...form, persona: e.target.value })}
                  placeholder="如：结论先行，先给判断再给依据"
                  rows={3}
                  style={{
                    ...inputStyle,
                    height: "auto",
                    padding: `${space.sm}px ${space.sm + 2}px`,
                    lineHeight: 1.6,
                    resize: "none",
                  }}
                />
              </Field>

              <Field label="技能" hint={`已选 ${form.skills.length} 项`}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}>
                  {SKILL_POOL.map((s) => {
                    const on = form.skills.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        data-testid="skill-option"
                        data-active={on ? "true" : "false"}
                        onClick={() =>
                          setForm({
                            ...form,
                            skills: on ? form.skills.filter((x) => x !== s) : [...form.skills, s],
                          })
                        }
                        style={{
                          padding: `3px ${space.sm}px`,
                          borderRadius: radius.pill,
                          border: `1px solid ${on ? "#A7F3D0" : neutral[200]}`,
                          backgroundColor: on ? "#ECFDF5" : "#FFFFFF",
                          color: on ? "#059669" : neutral[500],
                          fontSize: fontSize.xs,
                          cursor: "pointer",
                          ...baseFont,
                        }}
                      >
                        {on ? "✓ " : ""}
                        {s}
                      </button>
                    );
                  })}
                </div>
              </Field>

              {/* 通知渠道归属（唯一）：已被团队 / 其他成员占用的渠道禁用，只能「转移归属」 */}
              <Field label="成员专属渠道" hint="归属唯一 · 同一渠道只能属于一个团队或一个成员">
                <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
                  {/* 已归属当前成员的 chips：最多 2 个 +N，可直接解绑（解绑即释放归属） */}
                  <div
                    data-testid="notify-bound-chips"
                    style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.xs, minHeight: 20 }}
                  >
                    {form.notify.length === 0 ? (
                      <span style={{ fontSize: 10, color: neutral[400] }}>无成员专属渠道（团队渠道仍可用）</span>
                    ) : (
                      <>
                        {form.notify.slice(0, 2).map((id) => {
                          const ch = CHANNEL_MAP[id];
                          if (!ch) return null;
                          const t = channelTypeTheme[ch.type];
                          return (
                            <span
                              key={id}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                padding: "1px 4px 1px 7px",
                                borderRadius: radius.pill,
                                backgroundColor: t.bg,
                                border: `1px solid ${t.border}`,
                                color: t.color,
                                fontSize: 10,
                              }}
                            >
                              {ch.name}
                              <span style={{ fontSize: 9, opacity: 0.75 }}>{ch.type}</span>
                              <button
                                type="button"
                                aria-label={`解绑 ${ch.name}`}
                                onClick={() =>
                                  setForm((f) => ({ ...f, notify: f.notify.filter((x) => x !== id) }))
                                }
                                style={{
                                  border: "none",
                                  background: "transparent",
                                  color: t.color,
                                  fontSize: fontSize.sm,
                                  cursor: "pointer",
                                  lineHeight: 1,
                                  padding: 0,
                                  ...baseFont,
                                }}
                              >
                                ×
                              </button>
                            </span>
                          );
                        })}
                        {form.notify.length > 2 && (
                          <span
                            style={{
                              padding: "1px 6px",
                              borderRadius: radius.pill,
                              backgroundColor: neutral[100],
                              border: `1px solid ${neutral[200]}`,
                              color: neutral[500],
                              fontSize: 10,
                            }}
                          >
                            +{form.notify.length - 2}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {/* 渠道列表：未归属 / 归属当前成员可勾选；已被他人占用禁用并给出「转移归属」 */}
                  {channels.map((ch) => {
                    const on = form.notify.includes(ch.id);
                    const owner = ch.owner;
                    const ownedBySelf = !!owner && owner.kind === "member" && owner.name === drawerSelfName;
                    const occupied = !!owner && !ownedBySelf;
                    const t = channelTypeTheme[ch.type];
                    const ownerText = owner
                      ? `归属：${owner.kind === "team" ? "团队" : "成员"} ${owner.name}`
                      : "未归属";
                    return (
                      <div
                        key={ch.id}
                        data-testid="notify-option"
                        data-active={on ? "true" : "false"}
                        data-occupied={occupied ? "true" : "false"}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: space.sm,
                          padding: `${space.xs + 1}px ${space.sm}px`,
                          borderRadius: radius.md,
                          border: `1px solid ${occupied ? "#FDE68A" : on ? "#BFDBFE" : neutral[200]}`,
                          backgroundColor: occupied ? "#FFFBEB" : on ? "#EFF6FF" : "#FFFFFF",
                        }}
                      >
                        <button
                          type="button"
                          disabled={occupied}
                          title={occupied ? `${ownerText} · 归属唯一，需「转移归属」后才能绑定` : `绑定 ${ch.name}`}
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              notify: on ? f.notify.filter((x) => x !== ch.id) : [...f.notify, ch.id],
                            }))
                          }
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: space.sm,
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            cursor: occupied ? "not-allowed" : "pointer",
                            textAlign: "left",
                            opacity: occupied ? 0.9 : 1,
                            ...baseFont,
                          }}
                        >
                          <span
                            aria-hidden
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 4,
                              border: `1.5px solid ${occupied ? neutral[300] : on ? "#2563EB" : neutral[300]}`,
                              backgroundColor: occupied ? neutral[100] : on ? "#2563EB" : "#FFFFFF",
                              color: on ? "#FFFFFF" : neutral[400],
                              fontSize: 10,
                              lineHeight: "13px",
                              textAlign: "center",
                              flexShrink: 0,
                            }}
                          >
                            {occupied ? "–" : on ? "✓" : ""}
                          </span>
                          <span style={{ fontSize: fontSize.sm, color: occupied ? neutral[500] : neutral[800], fontWeight: 500 }}>
                            {ch.name}
                          </span>
                          <span
                            style={{
                              padding: "0 4px",
                              height: 14,
                              display: "inline-flex",
                              alignItems: "center",
                              borderRadius: 3,
                              backgroundColor: t.bg,
                              border: `1px solid ${t.border}`,
                              color: t.color,
                              fontSize: 9,
                              fontWeight: 600,
                              flexShrink: 0,
                            }}
                          >
                            {ch.type}
                          </span>
                          <span
                            data-testid="notify-owner-badge"
                            style={{
                              padding: "0 4px",
                              height: 14,
                              display: "inline-flex",
                              alignItems: "center",
                              borderRadius: 3,
                              backgroundColor: occupied ? "#FEF3C7" : ownedBySelf ? "#ECFDF5" : neutral[100],
                              border: `1px solid ${occupied ? "#FDE68A" : ownedBySelf ? "#A7F3D0" : neutral[200]}`,
                              color: occupied ? "#B45309" : ownedBySelf ? "#059669" : neutral[500],
                              fontSize: 9,
                              fontWeight: 600,
                              flexShrink: 0,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {ownedBySelf ? "成员专属（本成员）" : ownerText}
                          </span>
                        </button>
                        {occupied ? (
                          <button
                            type="button"
                            data-testid="notify-transfer"
                            onClick={() => setTransferFor(ch.id)}
                            style={{
                              border: `1px solid ${neutral[200]}`,
                              backgroundColor: "#FFFFFF",
                              borderRadius: radius.sm,
                              color: "#B45309",
                              fontSize: fontSize.xs,
                              fontWeight: 600,
                              cursor: "pointer",
                              padding: "1px 6px",
                              whiteSpace: "nowrap",
                              ...baseFont,
                            }}
                          >
                            转移归属
                          </button>
                        ) : (
                          <button
                            type="button"
                            data-testid="notify-test"
                            onClick={() => setToast(`已向「${ch.name}」发送测试通知（示意）`)}
                            style={{
                              border: "none",
                              background: "transparent",
                              color: "#2563EB",
                              fontSize: fontSize.xs,
                              fontWeight: 500,
                              cursor: "pointer",
                              padding: `0 ${space.xs}px`,
                              whiteSpace: "nowrap",
                              ...baseFont,
                            }}
                          >
                            测试发送
                          </button>
                        )}
                      </div>
                    );
                  })}

                  <div style={{ fontSize: 9, color: neutral[400], lineHeight: 1.6 }}>
                    渠道归属唯一：同一渠道只能属于一个团队或一个成员；转移归属会移除原归属方的绑定。
                  </div>
                </div>
              </Field>

              <Field label="主 Agent 候选" hint="仅平台侧推荐位；主 Agent 席位在建群时从已选成员中指定，仅对该群生效">
                <button
                  type="button"
                  data-testid="main-candidate-toggle"
                  data-active={form.mainCandidate ? "true" : "false"}
                  onClick={() => setForm({ ...form, mainCandidate: !form.mainCandidate })}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: space.sm,
                    padding: space.sm,
                    borderRadius: radius.md,
                    border: `1px solid ${form.mainCandidate ? "#FDE68A" : neutral[200]}`,
                    backgroundColor: form.mainCandidate ? "#FFFBEB" : neutral[50],
                    cursor: "pointer",
                    textAlign: "left",
                    ...baseFont,
                  }}
                >
                  <span
                    style={{
                      width: 34,
                      height: 18,
                      borderRadius: 9,
                      backgroundColor: form.mainCandidate ? "#F59E0B" : neutral[300],
                      display: "inline-flex",
                      alignItems: "center",
                      padding: 2,
                      justifyContent: form.mainCandidate ? "flex-end" : "flex-start",
                      flexShrink: 0,
                    }}
                  >
                    <span style={{ width: 14, height: 14, borderRadius: "50%", backgroundColor: "#FFFFFF" }} />
                  </span>
                  <span style={{ fontSize: fontSize.xs, color: neutral[600], lineHeight: 1.5 }}>
                    {form.mainCandidate
                      ? "已标记为推荐：新建群聊时会出现在「推荐主 Agent」位置；真正的主 Agent 席位在建群时指定，仅对该群生效"
                      : "未标记：建群时仍可从已选成员中指定其为主 Agent，只是不会出现在推荐位"}
                  </span>
                </button>
              </Field>
            </div>

            {/* 抽屉底 */}
            <div
              style={{
                flexShrink: 0,
                padding: space.md,
                borderTop: `1px solid ${neutral[200]}`,
                display: "flex",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <span style={{ fontSize: 10, color: neutral[400], flex: 1 }}>
                创建后不会自动加入任何群聊，需在群聊中勾选
              </span>
              <SecondaryBtn label="取消" onClick={() => setDrawer(null)} />
              <PrimaryBtn
                label={drawer.memberId ? "保存修改" : "创建成员"}
                onClick={submitDrawer}
                disabled={!form.name.trim()}
                testid="submit-member"
              />
            </div>
          </div>
        </div>
      )}

      {/* ---------------- 加入群聊弹窗（absolute 居中，多选） ---------------- */}
      {panelMember && (
        <div
          data-testid="group-panel-overlay"
          onClick={() => setGroupPanel(null)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 45,
            backgroundColor: "rgba(15,23,42,.28)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: space.xl,
          }}
        >
          <div
            data-testid="group-panel"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 460,
              maxWidth: "100%",
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              boxShadow: shadow.lg,
              display: "flex",
              flexDirection: "column",
              animation: "mm-pop .16s ease-out",
              ...baseFont,
            }}
          >
            <div
              style={{
                padding: `${space.lg}px ${space.xl}px`,
                borderBottom: `1px solid ${neutral[200]}`,
                display: "flex",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <AgentAvatar role={panelMember.role} size="md" initials={panelMember.name.slice(0, 1)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                  将「{panelMember.name}」加入群聊
                </div>
                <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
                  可多选；一个成员可同时存在于多个群聊
                </div>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setGroupPanel(null)}
                style={{
                  border: "none",
                  background: "transparent",
                  color: neutral[400],
                  fontSize: fontSize.lg,
                  cursor: "pointer",
                  lineHeight: 1,
                  padding: space.xs,
                  ...baseFont,
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: `${space.md}px ${space.xl}px`, display: "flex", flexDirection: "column", gap: space.xs }}>
              {GROUP_POOL.map((g) => {
                const already = panelMember.groups.includes(g);
                const picked = pickedGroups.includes(g);
                return (
                  <button
                    key={g}
                    type="button"
                    data-testid="group-option"
                    data-state={already ? "joined" : picked ? "picked" : "idle"}
                    disabled={already}
                    onClick={() =>
                      setPickedGroups((prev) => (picked ? prev.filter((x) => x !== g) : [...prev, g]))
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: space.sm,
                      padding: `${space.sm}px ${space.md}px`,
                      borderRadius: radius.md,
                      border: `1px solid ${already ? neutral[100] : picked ? "#BFDBFE" : neutral[200]}`,
                      backgroundColor: already ? neutral[50] : picked ? "#EFF6FF" : "#FFFFFF",
                      cursor: already ? "not-allowed" : "pointer",
                      textAlign: "left",
                      opacity: already ? 0.75 : 1,
                      ...baseFont,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        border: `1.5px solid ${already ? neutral[300] : picked ? "#2563EB" : neutral[300]}`,
                        backgroundColor: already || picked ? (already ? neutral[300] : "#2563EB") : "#FFFFFF",
                        color: "#FFFFFF",
                        fontSize: 10,
                        lineHeight: "13px",
                        textAlign: "center",
                        flexShrink: 0,
                      }}
                    >
                      {already || picked ? "✓" : ""}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: fontSize.sm, color: neutral[800], fontWeight: 500 }}>
                        {g}
                      </span>
                      <span style={{ display: "block", fontSize: 10, color: neutral[400] }}>
                        {already ? "已在群聊中 · 不会重复加入" : "点击勾选"}
                      </span>
                    </span>
                    <span style={{ fontSize: 10, color: neutral[400] }}>
                      {already ? "已加入" : ""}
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              style={{
                padding: space.md,
                borderTop: `1px solid ${neutral[200]}`,
                display: "flex",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <span style={{ fontSize: fontSize.xs, color: neutral[400], flex: 1 }}>
                已选 {pickedGroups.length} 个群聊
              </span>
              <SecondaryBtn label="取消" onClick={() => setGroupPanel(null)} />
              <PrimaryBtn label="确认加入" onClick={submitGroups} disabled={pickedGroups.length === 0} testid="submit-groups" />
            </div>
          </div>
        </div>
      )}

      {/* 转移渠道归属二次确认（absolute 居中，z-47） */}
      {transferFor && channels.find((c) => c.id === transferFor) && (
        <TransferChannelModal
          channel={channels.find((c) => c.id === transferFor)!}
          targetName={drawerSelfName || "当前成员"}
          onCancel={() => setTransferFor(null)}
          onConfirm={() => transferChannel(transferFor)}
        />
      )}

      {/* 重置全局会话二次确认（absolute 居中，z-46） */}
      {resetFor && members.find((x) => x.id === resetFor) && (
        <ResetSessionModal
          member={members.find((x) => x.id === resetFor)!}
          session={sessionOf(members.find((x) => x.id === resetFor)!)}
          onCancel={() => setResetFor(null)}
          onConfirm={() => {
            const target = members.find((x) => x.id === resetFor);
            if (!target) return;
            setSessions((prev) => ({
              ...prev,
              [target.id]: {
                ...sessionOf(target),
                percent: 0,
                tokens: "0 tokens",
              },
            }));
            setResetFor(null);
            setToast(`已重置「${target.name}」的全局会话：上下文已清空，影响其 ${target.groups.length} 个群聊`);
          }}
        />
      )}

      {/* 轻提示（absolute 底中） */}
      {toast && (
        <div
          data-testid="toast"
          style={{
            position: "absolute",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            zIndex: 50,
            maxWidth: 560,
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.pill,
            backgroundColor: "rgba(15,23,42,.9)",
            color: "#F8FAFC",
            fontSize: fontSize.xs,
            boxShadow: shadow.md,
            animation: "mm-pop .16s ease-out",
            ...baseFont,
          }}
        >
          <span>{toast}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setToast("")}
            style={{
              border: "none",
              background: "transparent",
              color: neutral[400],
              fontSize: fontSize.sm,
              cursor: "pointer",
              lineHeight: 1,
              padding: 0,
              ...baseFont,
            }}
          >
            ✕
          </button>
        </div>
      )}

      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "member-manage",
    name: "成员库",
    group: "成员与群聊",
    description:
      "平台级成员库：成员列表 / 新建成员抽屉（Agent、模型、worker、persona、技能、主 Agent 候选）/ 加入群聊多选",
    device: "desktop",
  },
  Component: MemberManage,
};

export default def;
