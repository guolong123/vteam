import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import {
  AgentAvatar,
  ChatBubble,
  MessageInput,
  StatusBadge,
} from "../_shared/components";
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

/**
 * 群聊原型（本迭代核心页面 · 融合导航版）
 * ============================================================
 * 深色 Sidebar 已替换为 nav-hybrid 融合导航方案（用户已确认）：
 * - **NavDock** 悬浮 Dock 导航条（activeKey="messages" 消息中心高亮），
 *   毛玻璃胶囊 hover 展开，absolute 悬浮左缘，z-index 50。
 * - **NavTopBar** 浅色顶栏：面包屑（Agent 协作平台 › 任务）+ 居中 Cmd+K 触发框
 *   + 右侧用户。
 * - **CmdKPanel** 命令面板受控开关（T19 API）：open 默认 false，页面 useState 管理，
 *   点顶栏 cmdk-trigger 打开，✕ / 遮罩点击 / Esc 键关闭（absolute inset:0 轻遮罩
 *   + 居中毛玻璃，z-index 40 —— Dock 浮于遮罩之上两者共存）。
 * - 内容区保持三栏感：成员面板 | 消息区 | 任务面板（Dock 悬浮在成员面板左侧，
 *   paddingLeft 80 避让）。
 * - mock 消息体现 @ 触发协作流程（与 PRD 03 @触发模型一致）：
 *   用户 @产品经理 → 产品经理回复 → 开发者互 @架构师 → @all 广播（7 条）。
 * - 展示「查看 Agent 会话」入口：Agent 内部处理过程不广播群聊，仅最终回复展示。
 * - 纯静态展示，不实现 @ 弹出层 / 消息发送 / 路由跳转。
 * - ⚠️ T15 铁律：root height:100% + position:relative，浮层一律 absolute，
 *   零 fixed / 100vh / 100vw。
 */

/* ----------------------------- mock 数据 ----------------------------- */

const MEMBERS: { role: RoleKey; status: string; note: string }[] = [
  { role: "product", status: "在线", note: "处理需求清单" },
  { role: "architect", status: "在线", note: "评审存储方案" },
  { role: "developer", status: "处理中", note: "开发未读角标" },
  { role: "tester", status: "空闲", note: "等待验收用例" },
];

/**
 * 消息模型扩展（对齐 opencode 真实消息机制）：
 * - 基础三型沿用 ChatBubble：user / agent / system（文本气泡）
 * - 新增过程类消息（本页局部组件渲染，模拟「查看 Agent 会话」内部过程）：
 *   thinking —— reasoning 阶段：思考中（pending，带 loading）/ 已完成（done，可折叠）
 *   tool      —— 工具调用：卡片含工具名 + 输入/输出摘要 + 状态（运行中/成功/失败，失败=ToolStateError）
 *   error     —— 消息级错误：模型繁忙(APIError isRetryable:true → 琥珀重试中) /
 *                             余额不足(insufficient_quota isRetryable:false → 红色升级引导)
 *   aborted   —— 用户中断（MessageAbortedError → 灰「已中断」，区别于错误）
 *   loading   —— agent 处理中指示器（对应 session.status busy）
 */
type MockMsg =
  | { type: "user" | "agent" | "system"; text: string; author?: string; role?: RoleKey; time?: string }
  | { type: "thinking"; author: string; role: RoleKey; state: "pending" | "done"; text: string; time?: string }
  | {
      type: "tool";
      author: string;
      role: RoleKey;
      name: string;
      status: "running" | "success" | "failed";
      input: string;
      output: string;
      time?: string;
    }
  | { type: "error"; kind: "retry" | "quota"; author?: string; role?: RoleKey; detail: string; attempt?: number; time?: string }
  | { type: "aborted"; author: string; role: RoleKey; detail: string; time?: string }
  | { type: "loading"; label: string; time?: string };

const MESSAGES: MockMsg[] = [
  { type: "system", text: "开发者 加入了任务「通知中心迭代」", time: "09:58" },
  {
    type: "user",
    text: "@产品经理 本周要排期了，麻烦把「通知中心」的需求优先级梳理一份清单挂到产出物 🙏",
    time: "10:02",
  },
  {
    type: "agent",
    author: "产品经理",
    role: "product",
    text: "收到 @收到，已梳理核心 3 条：① 未读角标 P0 ② 分组折叠 P1 ③ 免打扰时段 P2。清单已更新至产出物《通知中心需求清单》v1.1。",
    time: "10:05",
  },
  {
    type: "agent",
    author: "开发者",
    role: "developer",
    text: "@产品经理 ①③ 可以并行开工。不过免打扰时段的配置存储方案需要 @架构师 帮忙确认，避免和现有用户配置冲突。",
    time: "10:08",
  },
  { type: "system", text: "架构师 加入了会话", time: "10:10" },
  {
    type: "agent",
    author: "架构师",
    role: "architect",
    text: "@开发者 免打扰时段复用现有用户配置表，新增一个 JSON 字段即可，无需新表。方案已补充到《设计文档》§3.2。",
    time: "10:13",
  },
  {
    type: "user",
    text: "@all 收到，辛苦 @产品经理 周五前输出自测验收清单，测试同学好接棒。",
    time: "10:15",
  },

  /* ---- 场景二：Agent 内部过程可视化（thinking / tool / error / aborted / loading）---- */
  {
    type: "user",
    text: "@产品经理 需求清单已冻结，麻烦把验收项核对一遍；@测试 同步准备回归。",
    time: "10:18",
  },
  {
    type: "thinking",
    author: "产品经理",
    role: "product",
    state: "done",
    text: "检查《通知中心需求清单》v1.1 与验收标准映射：未读角标 P0 / 分组折叠 P1 / 免打扰时段 P2，逐项比对 FR-01~FR-16…",
    time: "10:18",
  },
  {
    type: "tool",
    author: "产品经理",
    role: "product",
    name: "读取需求文档",
    status: "success",
    input: "产出物/通知中心需求清单 v1.1",
    output: "3 项验收点命中：未读角标 / 分组折叠 / 免打扰时段，与 FR 对齐",
    time: "10:19",
  },
  {
    type: "agent",
    author: "产品经理",
    role: "product",
    text: "@测试 核对完毕，3 条验收项已锁定至《自测验收清单》v1.0，可以开跑回归。",
    time: "10:19",
  },
  { type: "user", text: "@测试 收到，开始执行回归用例。", time: "10:20" },
  { type: "loading", label: "测试 Agent 处理中", time: "10:20" },
  {
    type: "thinking",
    author: "测试",
    role: "tester",
    state: "pending",
    text: "正在理解回归范围：通知中心 3 条验收项，先执行 P0 未读角标用例…",
    time: "10:20",
  },
  {
    type: "tool",
    author: "测试",
    role: "tester",
    name: "执行测试",
    status: "running",
    input: "pytest regression/test_notification_center.py -m p0",
    output: "…",
    time: "10:21",
  },
  {
    type: "tool",
    author: "测试",
    role: "tester",
    name: "执行测试",
    status: "failed",
    input: "pytest regression/test_notification_center.py -m p0",
    output: "ToolStateError: 未读角标用例断言失败 · expected 3 unread, got 0",
    time: "10:21",
  },
  {
    type: "error",
    author: "测试",
    role: "tester",
    kind: "retry",
    detail: "模型繁忙，自动重试中…",
    attempt: 1,
    time: "10:21",
  },
  {
    type: "error",
    author: "开发者",
    role: "developer",
    kind: "quota",
    detail: "余额不足，请充值后重试",
    time: "10:23",
  },
  {
    type: "aborted",
    author: "测试",
    role: "tester",
    detail: "用户中断了该 Agent 的处理",
    time: "10:24",
  },
];

const ARTIFACTS = [
  { name: "通知中心需求清单", detail: "v1.1 · 产品经理" },
  { name: "设计文档", detail: "v0.9 · 架构师" },
  { name: "测试用例", detail: "待产出 · 测试" },
];

/* ----------------------------- 布局常量 ----------------------------- */

/** Dock 收起宽度（对齐 _shared/nav NavDock RAIL_W=56），内容区 paddingLeft 避让 */
const RAIL_W = 56;

/* ------------------- 过程消息语义色（页面内收敛，不改 _shared） ------------------- */
/** 错误语义色：模型繁忙=琥珀（可重试）/ 余额不足=红（不可重试，需升级） */
const errorTheme = {
  retry: { color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" },
  quota: { color: "#B91C1C", bg: "#FEF2F2", border: "#FECACA" },
} as const;

/** 工具状态色：运行中=蓝 / 成功=绿 / 失败=红 */
const toolStatus: Record<"running" | "success" | "failed", { label: string; color: string; bg: string; border: string }> = {
  running: { label: "运行中", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  success: { label: "成功", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  failed: { label: "失败", color: "#B91C1C", bg: "#FEF2F2", border: "#FECACA" },
};

/** scoped CSS 动画（groupchat- 前缀防污染其他原型） */
const groupchatCss = `
@keyframes groupchat-bounce { 0%, 80%, 100% { transform: scale(.6); opacity: .45 } 40% { transform: scale(1); opacity: 1 } }
@keyframes groupchat-pulse { 0%, 100% { opacity: .3 } 50% { opacity: 1 } }
`;

/* ----------------------------- 布局子块 ----------------------------- */

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------ 过程消息局部组件（模拟 Agent 内部过程） ------------------------ */

/** 三连点 loading（思考中 / Agent 处理中指示器） */
function LoadingDots({ testid = "loading-indicator", color = neutral[400] }: { testid?: string; color?: string }) {
  return (
    <span data-testid={testid} aria-hidden style={{ display: "inline-flex", gap: 4, lineHeight: 0 }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            backgroundColor: color,
            animation: "groupchat-bounce 1.1s ease-in-out infinite",
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </span>
  );
}

/** Agent 处理中指示条（对应 session.status busy） */
function LoadingIndicator({ label, time }: { label: string; time?: string }) {
  return (
    <div
      data-testid="loading-indicator"
      style={{ display: "flex", alignItems: "center", gap: space.sm, color: neutral[500], fontSize: fontSize.sm, padding: `${space.xs}px ${space.sm}px` }}
    >
      <LoadingDots />
      {label}…
      {time ? <span style={{ color: neutral[400], marginLeft: "auto" }}>{time}</span> : null}
    </div>
  );
}

/** 思考中消息（reasoning 阶段）：pending=思考中带动画 / done=可折叠（收起「已思考 · 点击展开」） */
function MsgThinking({
  author,
  role,
  state,
  text,
  time,
}: {
  author: string;
  role: RoleKey;
  state: "pending" | "done";
  text: string;
  time?: string;
}) {
  const [open, setOpen] = useState(state === "done" ? false : true);
  const pending = state === "pending";
  return (
    <div
      data-testid="msg-thinking"
      data-state={state}
      style={{ display: "flex", alignItems: "flex-start", gap: space.sm, maxWidth: "78%" }}
    >
      <AgentAvatar role={role} size="sm" dot={false} style={{ marginTop: 2 }} />
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen(!open);
        }}
        style={{
          flex: 1,
          minWidth: 0,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[100],
          border: `1px dashed ${neutral[300]}`,
          cursor: pending ? "default" : "pointer",
          transition: "border-color .15s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginBottom: open ? space.xs : 0 }}>
          {pending ? <LoadingDots color={neutral[400]} /> : <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>💭</span>}
          <span style={{ fontSize: fontSize.sm, color: neutral[500], fontWeight: 500, fontStyle: "italic" }}>
            {pending ? "思考中…" : author}
          </span>
          {!pending && (
            <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto" }} aria-hidden>
              {open ? "▾ 收起" : "已思考 · 点击展开 ▸"}
            </span>
          )}
          {time && <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto" }}>{time}</span>}
        </div>
        {(open || pending) && (
          <div style={{ fontSize: fontSize.md, color: pending ? neutral[400] : neutral[600], fontStyle: "italic", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {text}
          </div>
        )}
      </div>
    </div>
  );
}

/** 工具调用消息（tool part）：工具名 + 输入/输出摘要 + 状态（运行中/成功/失败，失败=ToolStateError） */
function MsgTool({
  author,
  role,
  name,
  status,
  input,
  output,
  time,
}: {
  author: string;
  role: RoleKey;
  name: string;
  status: "running" | "success" | "failed";
  input: string;
  output: string;
  time?: string;
}) {
  const st = toolStatus[status];
  const failed = status === "failed";
  return (
    <div
      data-testid="msg-tool"
      data-status={status}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: space.sm,
        maxWidth: "78%",
        alignSelf: "flex-start",
      }}
    >
      <AgentAvatar role={role} size="sm" dot={false} style={{ marginTop: 2 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${failed ? errorTheme.quota.border : neutral[200]}`,
          boxShadow: shadow.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>{failed ? "✕" : "⚙"}</span>
          <span style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 600 }}>{name}</span>
          <span
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.xs - 1}px ${space.sm}px`,
              borderRadius: radius.pill,
              backgroundColor: st.bg,
              border: `1px solid ${st.border}`,
              color: st.color,
              fontSize: fontSize.xs,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {status === "running" && <LoadingDots color={st.color} />}
            {st.label}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: space.sm, fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6 }}>
          <div style={{ display: "flex", gap: space.sm }}>
            <span style={{ color: neutral[400], flexShrink: 0 }}>输入</span>
            <span style={{ fontFamily: fontFamily.mono, wordBreak: "break-all" }}>{input}</span>
          </div>
          <div style={{ display: "flex", gap: space.sm }}>
            <span style={{ color: neutral[400], flexShrink: 0 }}>输出</span>
            <span style={{ wordBreak: "break-word", color: failed ? errorTheme.quota.color : neutral[600] }}>{output}</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>{author} · {time}</span>
          {failed && (
            <span style={{ fontSize: fontSize.xs, color: errorTheme.quota.color, marginLeft: "auto" }}>ToolStateError</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 错误消息（消息级 error）：retry=模型繁忙琥珀重试中（RetryPart attempt）/ quota=余额不足红色升级引导 */
function MsgError({
  kind,
  author,
  role,
  detail,
  attempt,
  time,
}: {
  kind: "retry" | "quota";
  author?: string;
  role?: RoleKey;
  detail: string;
  attempt?: number;
  time?: string;
}) {
  const theme = errorTheme[kind];
  const isRetry = kind === "retry";
  return (
    <div data-testid="msg-error" data-kind={kind} style={{ display: "flex", alignItems: "flex-start", gap: space.sm, maxWidth: "78%", alignSelf: "flex-start" }}>
      {role && <AgentAvatar role={role} size="sm" dot={false} style={{ marginTop: 2 }} />}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: theme.bg,
          border: `1px solid ${theme.border}`,
          boxShadow: shadow.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1, color: theme.color }}>{isRetry ? "⟳" : "⚠"}</span>
          <span style={{ fontSize: fontSize.md, color: theme.color, fontWeight: 600 }}>{detail}</span>
          {isRetry && (
            <span style={{ fontSize: fontSize.xs, color: theme.color, marginLeft: "auto", whiteSpace: "nowrap" }}>
              RetryPart · attempt {attempt ?? 1}/3
            </span>
          )}
        </div>
        {isRetry ? (
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
            <LoadingDots color={theme.color} />
            <span style={{ fontSize: fontSize.xs, color: theme.color }}>APIError · isRetryable · 稍后自动重试</span>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
            <span style={{ fontSize: fontSize.xs, color: theme.color }}>insufficient_quota · 不可重试</span>
            <span
              role="link"
              aria-label="查看升级方案"
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                padding: `${space.xs}px ${space.md}px`,
                borderRadius: radius.pill,
                backgroundColor: theme.color,
                color: "#FFFFFF",
                fontSize: fontSize.sm,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              查看升级方案 <span aria-hidden>→</span>
            </span>
          </div>
        )}
        <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: space.sm }}>
          {author && <span>{author}</span>}
          {time ? <span style={{ color: neutral[400] }}> · {time}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** 中断消息（MessageAbortedError）：灰「已中断」，区别于错误 */
function MsgAborted({ author, role, detail, time }: { author: string; role: RoleKey; detail: string; time?: string }) {
  return (
    <div data-testid="msg-aborted" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: space.sm }}>
      <AgentAvatar role={role} size="sm" dot={false} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: space.xs,
          padding: `${space.xs}px ${space.md}px`,
          borderRadius: radius.pill,
          backgroundColor: neutral[200],
          color: neutral[600],
          fontSize: fontSize.sm,
          fontWeight: 500,
        }}
      >
        ▮▮ 已中断
      </span>
      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
        {author} 的处理被用户中断{time ? ` · ${time}` : ""} — {detail}
      </span>
    </div>
  );
}

function MembersPanel() {
  return (
    <aside
      data-testid="members-panel"
      style={{
        width: 196,
        flexShrink: 0,
        borderRight: `1px solid ${neutral[200]}`,
        backgroundColor: neutral[50],
        display: "flex",
        flexDirection: "column",
        ...baseFont,
      }}
    >
      <div
        style={{
          padding: `${space.lg}px ${space.md}px`,
          fontSize: fontSize.sm,
          fontWeight: 600,
          color: neutral[500],
          letterSpacing: "0.02em",
        }}
      >
        任务成员 · 4
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: space.xs, padding: `0 ${space.sm}px ${space.md}px` }}>
        {MEMBERS.map((m) => (
          <button
            key={m.role}
            type="button"
            data-testid="member-item"
            data-role={m.role}
            title="点击进入私聊（示意）"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.sm}px ${space.sm}px`,
              borderRadius: radius.md,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: fontFamily.body,
              transition: "background-color .15s ease",
            }}
          >
            <AgentAvatar role={m.role} size="sm" />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: fontSize.md,
                  color: neutral[800],
                  fontWeight: 500,
                  lineHeight: 1.3,
                }}
              >
                {roles[m.role].label}
              </span>
              <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400], lineHeight: 1.4 }}>
                {m.status === "处理中" && (
                  <span
                    aria-hidden
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: roleText[m.role],
                      marginRight: space.xs - 1,
                      animation: "groupchat-pulse 1.2s ease-in-out infinite",
                    }}
                  />
                )}
                {m.status} · {m.note}
              </span>
            </span>
            <span style={{ color: roleText[m.role], fontSize: fontSize.lg, lineHeight: 1 }} aria-hidden>
              ›
            </span>
          </button>
        ))}
      </div>
      <div
        style={{
          marginTop: "auto",
          padding: space.md,
          fontSize: fontSize.xs,
          color: neutral[400],
          lineHeight: 1.5,
          borderTop: `1px dashed ${neutral[200]}`,
        }}
      >
        点击成员可发起与该 Agent 的私聊
      </div>
    </aside>
  );
}

function ChatHeader() {
  return (
    <header
      style={{
        height: 64,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `0 ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            通知中心迭代
          </span>
          <StatusBadge status="进行中" />
        </div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 2 }}>
          群聊 · 仅被 @ 的 Agent 会收到消息
        </div>
      </div>

      {/* 参与者头像堆叠 */}
      <div
        aria-label="参与成员"
        style={{
          display: "flex",
          alignItems: "center",
          marginLeft: "auto",
        }}
      >
        {MEMBERS.map((m, i) => (
          <span key={m.role} style={{ marginLeft: i === 0 ? 0 : -8 }}>
            <AgentAvatar role={m.role} size="sm" style={{ border: "2px solid #FFFFFF" }} />
          </span>
        ))}
        <span
          style={{
            marginLeft: -8,
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "2px solid #FFFFFF",
            backgroundColor: neutral[100],
            color: neutral[500],
            fontSize: fontSize.xs,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          +1
        </span>
      </div>
    </header>
  );
}

function MessageList() {
  return (
    <div
      data-testid="chat-message-list"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: `${space.xl}px`,
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        backgroundColor: neutral[50],
        ...baseFont,
      }}
    >
      {/* 会话开始分隔 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>今天 · 任务会话</span>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
      </div>

      {MESSAGES.map((msg, i) => {
        switch (msg.type) {
          case "thinking":
            return <MsgThinking key={i} author={msg.author} role={msg.role} state={msg.state} text={msg.text} time={msg.time} />;
          case "tool":
            return <MsgTool key={i} author={msg.author} role={msg.role} name={msg.name} status={msg.status} input={msg.input} output={msg.output} time={msg.time} />;
          case "error":
            return <MsgError key={i} kind={msg.kind} author={msg.author} role={msg.role} detail={msg.detail} attempt={msg.attempt} time={msg.time} />;
          case "aborted":
            return <MsgAborted key={i} author={msg.author} role={msg.role} detail={msg.detail} time={msg.time} />;
          case "loading":
            return <LoadingIndicator key={i} label={msg.label} time={msg.time} />;
          default:
            return (
              <ChatBubble
                key={i}
                text={msg.text}
                type={msg.type}
                author={msg.author}
                role={msg.role}
                time={msg.time}
              />
            );
        }
      })}

      {/* Agent 内部过程说明 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          marginTop: space.sm,
          padding: `${space.sm + 2}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[100],
          color: neutral[500],
          fontSize: fontSize.xs,
          lineHeight: 1.5,
        }}
      >
        <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>⚙</span>
        Agent 内部推理过程不广播到群聊，仅最终回复展示；点击右侧「查看 Agent 会话」可实时查看处理过程
      </div>
    </div>
  );
}

function MentionHint() {
  return (
    <div
      data-testid="mention-hint"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        padding: `${space.xs + 1}px ${space.md}px`,
        backgroundColor: "#FFFFFF",
        ...baseFont,
      }}
    >
      <span
        style={{
          padding: `${space.xs - 1}px ${space.sm}px`,
          borderRadius: radius.pill,
          backgroundColor: neutral[100],
          color: neutral[600],
          fontSize: fontSize.xs,
          fontWeight: 600,
          border: `1px solid ${neutral[200]}`,
        }}
      >
        @all
      </span>
      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
        输入 @all 广播给全体成员；@ 单个角色仅其本人收到
      </span>
    </div>
  );
}

function TaskPanel() {
  return (
    <aside
      data-testid="task-info-panel"
      style={{
        width: 268,
        flexShrink: 0,
        borderLeft: `1px solid ${neutral[200]}`,
        backgroundColor: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        padding: space.xl,
        ...baseFont,
      }}
    >
      <div>
        <div style={{ fontSize: fontSize.xs, color: neutral[400], marginBottom: space.xs }}>任务</div>
        <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.4 }}>
          通知中心迭代
        </div>
        <div style={{ marginTop: space.sm, display: "flex", alignItems: "center", gap: space.sm }}>
          <StatusBadge status="进行中" />
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>更新于 10:15</span>
        </div>
      </div>

      {/* 产出物入口 */}
      <div>
        <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600], marginBottom: space.sm }}>
          产出物
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          {ARTIFACTS.map((a) => (
            <div
              key={a.name}
              data-testid="artifact-link"
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`,
                cursor: "pointer",
                transition: "border-color .15s ease",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  backgroundColor: roleText.developer,
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: fontSize.md, color: neutral[800], fontWeight: 500 }}>
                  {a.name}
                </span>
                <span style={{ display: "block", fontSize: fontSize.xs, color: neutral[400] }}>{a.detail}</span>
              </span>
              <span style={{ color: neutral[400], fontSize: fontSize.md }} aria-hidden>
                ↗
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 查看 Agent 会话入口 */}
      <div style={{ marginTop: "auto" }}>
        <div
          style={{
            padding: space.lg,
            borderRadius: radius.lg,
            backgroundColor: neutral[50],
            border: `1px dashed ${neutral[300]}`,
          }}
        >
          <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[700], marginBottom: space.xs }}>
            查看 Agent 会话
          </div>
          <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.6, marginBottom: space.md }}>
            Agent 内部处理过程不广播到群聊，点击下方入口可实时查看其思考与执行步骤。
          </div>
          <div
            data-testid="view-session-link"
            role="link"
            aria-label="查看 Agent 会话"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.pill,
              backgroundColor: "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: "pointer",
              boxShadow: shadow.sm,
            }}
          >
            打开会话面板
            <span aria-hidden>→</span>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ----------------------------- 原型组件 ----------------------------- */

function GroupChat({ device }: PrototypeRenderProps) {
  const isMobile = device === "mobile";
  // T19 受控开关：默认关闭，点顶栏 Cmd+K 触发框打开
  const [cmdkOpen, setCmdkOpen] = useState(false);

  if (isMobile) {
    return (
      <div
        style={{
          height: "100%",
          minHeight: 720,
          display: "flex",
          flexDirection: "column",
          backgroundColor: neutral[50],
          ...baseFont,
        }}
      >
        <style>{groupchatCss}</style>
        <ChatHeader />
        <MessageList />
        <MentionHint />
        <MessageInput placeholder="输入消息，@ 提及某个 Agent…" style={{ borderRadius: 0, border: "none", borderTop: `1px solid ${neutral[200]}` }} />
      </div>
    );
  }

  return (
    <div
      data-testid="group-chat-root"
      style={{ height: "100%", minHeight: 720, position: "relative", backgroundColor: neutral[50], ...baseFont }}
    >
      <style>{groupchatCss}</style>
      {/* 浅色顶栏（文档流顶部）：面包屑 + Cmd+K 触发框 + 用户 */}
      <NavTopBar
        breadcrumb={["Agent 协作平台", "T-1041 通知中心迭代"]}
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区三栏：成员面板 | 消息区 | 任务面板；paddingLeft 避让 Dock */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          paddingLeft: RAIL_W + 24,
        }}
      >
        <MembersPanel />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", backgroundColor: neutral[50] }}>
          <ChatHeader />
          <MessageList />
          <MentionHint />
          <MessageInput
            placeholder="输入消息，@ 提及某个 Agent…"
            style={{ border: "none", borderTop: `1px solid ${neutral[200]}`, borderRadius: 0 }}
          />
        </div>
        <TaskPanel />
      </div>

      {/* Dock 悬浮导航条：absolute 左缘垂直居中，activeKey 消息中心高亮（z-50，浮于命令面板遮罩之上） */}
      <NavDock activeKey="messages" projectName="Agent 协作平台" />

      {/* Cmd+K 命令面板：受控开关（z-40，Dock 仍可 hover 展开） */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "group-chat",
    name: "群聊",
    group: "消息协作",
    description: "任务群聊：@ 触发协作、成员列表、任务信息与产出物入口（融合导航 Dock + Cmd+K）",
    device: "both",
  },
  Component: GroupChat,
};

export default def;
