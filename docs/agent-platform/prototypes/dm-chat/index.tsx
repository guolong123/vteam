/**
 * 私聊原型（融合导航版 · 消息类型扩展）
 * ============================================================
 * 与群聊同一会话模型：私聊仅 1 对 1，消息不带 @。
 * 消息类型对齐 opencode 真实消息体系（已研究确认）：
 * - **思考中**（msg-thinking）：agent 私聊中先显示思考，灰色斜体可折叠（ReasoningPart）。
 * - **工具调用**（msg-tool）：agent 执行工具卡片，状态 运行中→成功（ToolPart 生命周期）。
 * - **错误反馈**（msg-error）：模型繁忙（APIError isRetryable:true，重试中）/ 余额不足
 *   （insufficient_quota isRetryable:false，升级引导），对应消息级 AssistantMessage.error。
 * - **Loading 指示**（loading-indicator）：agent 处理中 / 重试中动画。
 * 导航采用用户已确认的融合方案（nav-hybrid）：
 * - **NavDock**（_shared/nav）：左侧 Dock 悬浮导航条，activeKey="messages" 消息中心高亮
 *   + Activity Bar 指示条，hover 展开 56→248px，浮于命令面板遮罩之上（z-50）。
 * - **NavTopBar**（_shared/nav）：浅色顶栏（标题「私聊」+ 居中 Cmd+K 触发框 + 用户头像）。
 * - **CmdKPanel**（_shared/nav）：Cmd+K 命令面板浮层，受控开关（T19）：useState 管理 cmdkOpen
 *   默认关闭，点击顶栏 cmdk-trigger 打开，✕ / 遮罩 / Esc 关闭（onClose）。
 * - 内容区：Agent 信息条（头像 / 角色 / 状态）+ 对话区 + 「查看历史会话」入口 + 简化输入框。
 * - ⚠️ T15 铁律：root `height:100%; position:relative`，浮层全部 absolute，零 fixed / vh / vw。
 */
import { useState } from "react";
import type { CSSProperties } from "react";
import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import {
  AgentAvatar,
  AgentBadge,
  ChatBubble,
  MessageInput,
} from "../_shared/components";
import { NavDock, NavTopBar, CmdKPanel } from "../_shared/nav";
import {
  type RoleKey,
  roles,
  roleText,
  statusColors,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "../_shared/styles";

const AGENT = {
  role: "product" as const,
  name: "产品经理",
  status: "在线",
  meta: "正在整理「通知中心迭代」需求清单",
};

/* ----------------------------- 消息类型 mock ----------------------------- */

type DmMessage =
  | { kind: "text"; type: "user" | "agent"; text: string; author?: string; role?: RoleKey; time?: string }
  | { kind: "thinking"; text: string; time: string }
  | { kind: "tool"; name: string; detail: string; status: "running" | "success"; time: string }
  | { kind: "error"; title: string; body: string; variant: "retry" | "fatal"; action?: string; time: string }
  | { kind: "loading"; text: string };

/** 私聊消息流：保留原 3 条文本消息，后续扩展 thinking / tool / error / loading，
 *  体现 1 对 1 深入讨论（与群聊共用同一 session，过程可见）。 */
const MESSAGES: DmMessage[] = [
  {
    kind: "text",
    type: "agent",
    author: "产品经理",
    role: "product",
    text: "「通知中心迭代」的需求清单已经梳理好了，P0 未读角标的核心场景和边界条件都写进去了，发你过目。",
    time: "10:05",
  },
  {
    kind: "text",
    type: "user",
    text: "收到，交互稿你直接挂到产出物里，我这边让开发者接着做。",
    time: "10:07",
  },
  {
    kind: "text",
    type: "agent",
    author: "产品经理",
    role: "product",
    text: "好，已更新《通知中心需求清单》v1.2 并通知开发者。验收口径也一并补充了。",
    time: "10:09",
  },
  {
    kind: "text",
    type: "user",
    text: "分组折叠 P1 的实现方案定了吗？我担心和历史通知列表的渲染有冲突。",
    time: "10:11",
  },
  {
    kind: "thinking",
    text: "收到。我先在代码库中定位分组折叠与通知列表渲染的交叉点，确认是否存在冲突，再给出结论。",
    time: "10:11",
  },
  {
    kind: "tool",
    name: "查询代码",
    detail: "notify/grouping.ts · 折叠分组逻辑",
    status: "running",
    time: "10:11",
  },
  {
    kind: "thinking",
    text: "折叠逻辑在渲染层做聚合，未发现与历史列表的冲突。继续分析通知写入链路，确认批量通知对未读角标计数的影响…",
    time: "10:12",
  },
  {
    kind: "tool",
    name: "分析日志",
    detail: "notify-write · 批量写入链路",
    status: "success",
    time: "10:12",
  },
  {
    kind: "text",
    type: "agent",
    author: "产品经理",
    role: "product",
    text: "确认过了：折叠分组在渲染层做聚合，与历史通知列表互不干扰；批量写入也不影响未读角标计数，可以并行开发。方案已补充进需求清单 v1.3。",
    time: "10:12",
  },
  {
    kind: "error",
    title: "模型繁忙，正在重试",
    body: "请求超时（APIError · isRetryable）。已自动重试，请稍候…",
    variant: "retry",
    time: "10:13",
  },
  {
    kind: "loading",
    text: "正在重新连接模型，重试第 2 次…",
  },
  {
    kind: "text",
    type: "agent",
    author: "产品经理",
    role: "product",
    text: "抱歉刚才服务繁忙。已恢复：批量写入经确认不影响角标计数，链路正常。",
    time: "10:14",
  },
  {
    kind: "thinking",
    text: "汇总本次私聊结论，整理为《分组折叠实现确认》附到会话产出物…",
    time: "10:15",
  },
  {
    kind: "error",
    title: "余额不足，任务中断",
    body: "API 配额已用尽（insufficient_quota · isRetryable=false）。需要升级配额后继续。",
    variant: "fatal",
    action: "升级配额 ↗",
    time: "10:15",
  },
];

/* ----------------------------- 局部样式常量 ----------------------------- */

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 内容区左缘留白：避让悬浮 Dock（NavDock 收起 56px + left 12px + 间距） */
const DOCK_PAD = 80;

/** 错误语义色（页面内局部，与 styles.ts 色板同族）：
 *  fatal=红（余额不足/不可重试）、retry=琥珀（模型繁忙/可重试）、success=绿（工具成功） */
const errColors = {
  fatal: { color: "#DC2626", bg: "#FEF2F2", border: "#FECACA" },
  retry: {
    color: statusColors["待验收"].color,
    bg: statusColors["待验收"].bg,
    border: statusColors["待验收"].border,
  },
  success: { color: roleText.developer, bg: "#ECFDF5", border: "#A7F3D0" },
} as const;

/** scoped 动画（组件内 style 注入，dm- 前缀防污染其他原型） */
const dmAnimCss = `
@keyframes dm-spin { to { transform: rotate(360deg); } }
.dm-spinner {
  display: inline-block;
  width: 10px; height: 10px;
  border: 2px solid ${neutral[300]};
  border-top-color: ${roleText.developer};
  border-radius: 50%;
  animation: dm-spin .7s linear infinite;
  vertical-align: -1px;
}
@keyframes dm-dot { 0%,80%,100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
.dm-dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: ${neutral[500]};
  display: inline-block;
  animation: dm-dot 1.2s ease-in-out infinite;
}
.dm-dot:nth-child(2) { animation-delay: .15s; }
.dm-dot:nth-child(3) { animation-delay: .3s; }
`;

/* ----------------------------- 新增消息类型组件 ----------------------------- */

/** 思考中（msg-thinking）：灰斜体可折叠，对齐 opencode ReasoningPart */
function MsgThinking({ text, time }: { text: string; time: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div data-testid="msg-thinking" data-open={open ? "true" : "false"} style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}>
      <AgentAvatar role={AGENT.role} size="sm" dot={false} style={{ marginTop: 2 }} />
      <div style={{ maxWidth: "78%", flex: 1, minWidth: 0 }}>
        <button
          type="button"
          role="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.xs}px ${space.sm}px`,
            border: `1px solid ${neutral[200]}`,
            borderRadius: radius.pill,
            backgroundColor: "#FFFFFF",
            color: neutral[500],
            fontSize: fontSize.xs,
            fontWeight: 500,
            cursor: "pointer",
            ...baseFont,
          }}
        >
          <span aria-hidden style={{ color: neutral[400], fontSize: fontSize.xs }}>◌</span>
          思考中
          <span aria-hidden style={{ fontSize: fontSize.xs, color: neutral[400] }}>{open ? "▾" : "▸"}</span>
          {time && <span style={{ color: neutral[300] }}>{time}</span>}
        </button>
        {open && (
          <div
            style={{
              marginTop: space.xs,
              padding: `${space.sm}px ${space.md}px`,
              borderLeft: `2px solid ${neutral[200]}`,
              color: neutral[500],
              fontSize: fontSize.sm,
              fontStyle: "italic",
              lineHeight: 1.7,
              ...baseFont,
            }}
          >
            {text}
          </div>
        )}
      </div>
    </div>
  );
}

/** 工具调用（msg-tool）：卡片带状态徽标（运行中=spinner / 成功=✓），对齐 opencode ToolPart */
function MsgTool({
  name,
  detail,
  status,
  time,
}: {
  name: string;
  detail: string;
  status: "running" | "success";
  time: string;
}) {
  const running = status === "running";
  const statusColor = running ? errColors.retry.color : errColors.success.color;
  return (
    <div data-testid="msg-tool" data-status={status} style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}>
      <AgentAvatar role={AGENT.role} size="sm" dot={false} style={{ marginTop: 2 }} />
      <div
        style={{
          maxWidth: "78%",
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: space.md,
          padding: `${space.sm + 2}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.sm,
          ...baseFont,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: radius.sm,
            backgroundColor: neutral[100],
            color: neutral[500],
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: fontSize.md,
            flexShrink: 0,
          }}
        >
          ▦
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: fontSize.md, color: neutral[800], fontWeight: 500, lineHeight: 1.4 }}>
            {name}
          </span>
          <span
            style={{
              display: "block",
              fontSize: fontSize.xs,
              color: neutral[400],
              lineHeight: 1.5,
              fontFamily: fontFamily.mono,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {detail}
          </span>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: space.xs, flexShrink: 0 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.xs - 1}px ${space.sm}px`,
              borderRadius: radius.pill,
              backgroundColor: running ? errColors.retry.bg : errColors.success.bg,
              border: `1px solid ${running ? errColors.retry.border : errColors.success.border}`,
              color: statusColor,
              fontSize: fontSize.xs,
              fontWeight: 500,
            }}
          >
            {running ? <span className="dm-spinner" aria-hidden /> : <span aria-hidden>✓</span>}
            {running ? "运行中" : "成功"}
          </span>
          <span style={{ fontSize: fontSize.xs, color: neutral[300], whiteSpace: "nowrap" }}>{time}</span>
        </span>
      </div>
    </div>
  );
}

/** 错误反馈（msg-error）：模型繁忙=琥珀可重试 / 余额不足=红 + 升级引导，对齐 AssistantMessage.error */
function MsgError({
  title,
  body,
  variant,
  action,
  time,
}: {
  title: string;
  body: string;
  variant: "retry" | "fatal";
  action?: string;
  time: string;
}) {
  const c = variant === "fatal" ? errColors.fatal : errColors.retry;
  return (
    <div data-testid="msg-error" data-variant={variant} style={{ display: "flex", alignItems: "flex-start", gap: space.sm }}>
      <AgentAvatar role={AGENT.role} size="sm" dot={false} style={{ marginTop: 2 }} />
      <div
        style={{
          maxWidth: "78%",
          flex: 1,
          minWidth: 0,
          padding: `${space.md}px ${space.lg}px`,
          borderRadius: radius.md,
          backgroundColor: c.bg,
          border: `1px solid ${c.border}`,
          ...baseFont,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span aria-hidden style={{ color: c.color, fontSize: fontSize.md, lineHeight: 1 }}>⚠</span>
          <span style={{ fontSize: fontSize.md, color: c.color, fontWeight: 600, lineHeight: 1.4 }}>{title}</span>
          <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400], whiteSpace: "nowrap" }}>{time}</span>
        </div>
        <div style={{ fontSize: fontSize.sm, color: neutral[600], lineHeight: 1.7, marginTop: space.xs }}>{body}</div>
        {action && (
          <span
            data-testid="msg-error-action"
            role="link"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              marginTop: space.sm,
              padding: `${space.xs}px ${space.md}px`,
              borderRadius: radius.pill,
              backgroundColor: c.color,
              color: "#FFFFFF",
              fontSize: fontSize.xs,
              fontWeight: 600,
              cursor: "pointer",
              ...baseFont,
            }}
          >
            {action}
          </span>
        )}
      </div>
    </div>
  );
}

/** Loading 指示（loading-indicator）：三点跳动动画，agent 处理中 / 重试中 */
function LoadingIndicator({ text }: { text: string }) {
  return (
    <div
      data-testid="loading-indicator"
      role="status"
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.sm,
        padding: `${space.sm}px ${space.lg}px`,
        borderRadius: radius.pill,
        backgroundColor: "#FFFFFF",
        border: `1px solid ${neutral[200]}`,
        color: neutral[500],
        fontSize: fontSize.sm,
        alignSelf: "flex-start",
        marginLeft: space.xl,
        boxShadow: shadow.sm,
        ...baseFont,
      }}
    >
      <span aria-hidden className="dm-dots" style={{ display: "inline-flex", gap: 3 }}>
        <span className="dm-dot" />
        <span className="dm-dot" />
        <span className="dm-dot" />
      </span>
      {text}
    </div>
  );
}

/* ----------------------------- 布局子块 ----------------------------- */

function AgentInfoBar() {
  return (
    <header
      data-testid="dm-agent-info"
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.lg}px ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      <AgentAvatar role={AGENT.role} size="lg" />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            {AGENT.name}
          </span>
          <AgentBadge role={AGENT.role} />
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              fontSize: fontSize.xs,
              color: neutral[500],
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                backgroundColor: roleText.developer,
                display: "inline-block",
              }}
            />
            {AGENT.status}
          </span>
        </div>
        <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: 2, lineHeight: 1.5 }}>
          {AGENT.meta} · 私聊会话（与群聊共用同一 session）
        </div>
      </div>
    </header>
  );
}

function DmMessageList() {
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
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>今天 · 私聊</span>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
      </div>

      {MESSAGES.map((msg, i) => {
        switch (msg.kind) {
          case "text":
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
          case "thinking":
            return <MsgThinking key={i} text={msg.text} time={msg.time} />;
          case "tool":
            return <MsgTool key={i} name={msg.name} detail={msg.detail} status={msg.status} time={msg.time} />;
          case "error":
            return (
              <MsgError
                key={i}
                title={msg.title}
                body={msg.body}
                variant={msg.variant}
                action={msg.action}
                time={msg.time}
              />
            );
          case "loading":
            return <LoadingIndicator key={i} text={msg.text} />;
        }
      })}
    </div>
  );
}

function DmFooter() {
  return (
    <div
      style={{
        flexShrink: 0,
        backgroundColor: "#FFFFFF",
        borderTop: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {/* 查看历史会话入口 */}
      <div style={{ display: "flex", justifyContent: "center", paddingTop: space.md }}>
        <span
          data-testid="view-session-link"
          role="link"
          aria-label="查看历史会话"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: space.xs,
            padding: `${space.sm}px ${space.lg}px`,
            borderRadius: radius.pill,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: neutral[50],
            color: neutral[600],
            fontSize: fontSize.sm,
            fontWeight: 500,
            cursor: "pointer",
            boxShadow: shadow.sm,
          }}
        >
          查看历史会话
          <span aria-hidden>↗</span>
        </span>
      </div>
      <MessageInput
        mentionable={[]}
        placeholder={`发送私聊消息给 ${roles[AGENT.role].label}…`}
        style={{ border: "none", borderRadius: 0 }}
      />
    </div>
  );
}

function DmChat(_: PrototypeRenderProps) {
  const [cmdkOpen, setCmdkOpen] = useState(false);

  return (
    <div
      data-testid="dm-chat-root"
      style={{ height: "100%", minHeight: 720, position: "relative", backgroundColor: neutral[50], ...baseFont }}
    >
      {/* scoped 动画 */}
      <style>{dmAnimCss}</style>

      {/* 浅色顶栏（文档流顶部，height 60）：标题 + Cmd+K 触发框 + 用户头像 */}
      <NavTopBar
        title="私聊"
        subtitle="与单个 Agent 的 1 对 1 会话"
        onCmdKClick={() => setCmdkOpen(true)}
      />

      {/* 内容区：绝对定位填满顶栏以下，paddingLeft 留白避让悬浮 Dock */}
      <div
        style={{
          position: "absolute",
          top: 60,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          paddingLeft: DOCK_PAD,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            backgroundColor: neutral[50],
          }}
        >
          <AgentInfoBar />
          <DmMessageList />
          <DmFooter />
        </div>
      </div>

      {/* 左侧 Dock 悬浮导航条：active=消息中心，默认收起 hover 展开（z-index 50） */}
      <NavDock activeKey="messages" />

      {/* Cmd+K 命令面板：受控开关（z-index 40），cmdkOpen=false 默认关闭 */}
      <CmdKPanel open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "dm-chat",
    name: "私聊",
    group: "消息协作",
    description: "与单个 Agent 的 1 对 1 私聊：思考/工具/错误/loading 消息类型（对齐 opencode 消息体系）+ Dock 悬浮导航 + Cmd+K",
    device: "desktop",
  },
  Component: DmChat,
};

export default def;
