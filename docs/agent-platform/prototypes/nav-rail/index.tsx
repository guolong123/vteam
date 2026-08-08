import type { CSSProperties } from "react";
import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import {
  AgentAvatar,
  ChatBubble,
  MessageInput,
  StatusBadge,
  TopBar,
} from "../_shared/components";
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
 * 导航变体 A：Dock / Rail 悬浮导航
 * ============================================================
 * 突破传统整条深色侧边栏：左侧改为悬浮的窄图标 Dock（毛玻璃胶囊条，
 * 不占文档流、内容区从屏幕左缘铺满），hover 时从图标条展开浮层面板
 * （产品名 + 导航项文字标签 + 在线成员 + 底部用户信息），失焦自动收起。
 * - 展示场景：任务群聊「通知中心迭代」（复用 PRD 03 @触发消息流）。
 * - 纯 CSS hover 展开/收起（无 JS 状态），默认不报错。
 * - 复用 _shared 组件：ChatBubble / MessageInput / AgentAvatar / StatusBadge / TopBar。
 *   刻意不使用 Sidebar —— 本变体即为其替代方案。
 */

/* ----------------------------- mock 数据（复用 PRD 03 场景） ----------------------------- */

const MEMBERS: { role: RoleKey; status: string }[] = [
  { role: "product", status: "在线" },
  { role: "architect", status: "在线" },
  { role: "developer", status: "处理中" },
  { role: "tester", status: "空闲" },
];

interface MockMsg {
  type: "user" | "agent" | "system";
  text: string;
  author?: string;
  role?: RoleKey;
  time?: string;
}

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
];

const ARTIFACTS = [
  { name: "通知中心需求清单", detail: "v1.1 · 产品经理" },
  { name: "设计文档", detail: "v0.9 · 架构师" },
  { name: "测试用例", detail: "待产出 · 测试" },
];

/* ----------------------------- Dock / Rail 悬浮导航 ----------------------------- */

/** 导航项：图标（unicode 符号，无第三方库）+ 文字标签 + 当前页高亮 */
const NAV_ITEMS: { key: string; label: string; icon: string }[] = [
  { key: "project", label: "项目", icon: "▤" },
  { key: "board", label: "任务看板", icon: "☰" },
  { key: "agents", label: "Agent 管理", icon: "◉" },
  { key: "messages", label: "消息中心", icon: "✉" },
];

/** 当前页：消息中心（任务群聊场景） */
const ACTIVE_KEY = "messages";

const ACTIVE = "#3B82F6";
const ACTIVE_DEEP = "#2563EB";
const RAIL_W = 56;
const RAIL_OPEN_W = 248;
const PANEL_W = RAIL_OPEN_W - RAIL_W;

/**
 * Dock 悬浮导航条（纯 CSS hover 展开，无 JS 状态）
 * - 常驻图标列：56px，4 个图标，当前页高亮（角色色 #3B82F6 + 左侧指示条）
 * - hover：整体过渡展开至 248px，浮层面板淡入（产品名 / 导航文字 / 在线成员 / 底部用户）
 */
const railCss = `
.rail-dock {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: ${RAIL_W}px;
  display: flex;
  align-items: stretch;
  border-radius: 20px;
  background: rgba(255,255,255,.72);
  border: 1px solid rgba(15,23,42,.08);
  backdrop-filter: blur(14px) saturate(1.4);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  box-shadow: 0 14px 36px rgba(15,23,42,.14), 0 2px 8px rgba(15,23,42,.06);
  z-index: 50;
  overflow: hidden;
  transition: width .28s cubic-bezier(.22,1,.36,1), box-shadow .28s ease;
}
.rail-dock:hover {
  width: ${RAIL_OPEN_W}px;
  box-shadow: 0 18px 44px rgba(15,23,42,.18), 0 3px 10px rgba(15,23,42,.08);
}
/* 常驻图标列 */
.rail-icons {
  width: ${RAIL_W}px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${space.sm}px;
  padding: ${space.lg}px 0;
  position: relative;
  z-index: 2;
}
.rail-icon {
  position: relative;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: ${neutral[500]};
  font-size: ${fontSize.xl}px;
  line-height: 1;
  cursor: pointer;
  font-family: ${fontFamily.body};
  transition: background-color .15s ease, color .15s ease, transform .15s ease;
}
.rail-icon:hover { background: rgba(59,130,246,.1); color: ${ACTIVE_DEEP}; transform: translateY(-1px); }
.rail-icon[data-active="true"] { background: rgba(59,130,246,.12); color: ${ACTIVE}; }
/* 当前页左侧指示条（VS Code Activity Bar 风格） */
.rail-icon[data-active="true"]::before {
  content: "";
  position: absolute;
  left: -8px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: ${radius.pill}px;
  background: ${ACTIVE};
}
/* 悬浮展开面板 */
.rail-panel {
  width: 0;
  opacity: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width .28s cubic-bezier(.22,1,.36,1), opacity .18s ease .06s;
  border-left: 1px solid rgba(15,23,42,.06);
}
.rail-dock:hover .rail-panel {
  width: ${PANEL_W}px;
  opacity: 1;
}
.rail-panel-inner {
  width: ${PANEL_W}px;
  padding: ${space.lg}px ${space.md}px ${space.md}px;
  display: flex;
  flex-direction: column;
  gap: ${space.md}px;
  white-space: nowrap;
}
.rail-product {
  display: flex;
  align-items: center;
  gap: ${space.sm}px;
}
.rail-product-mark {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: ${radius.md}px;
  background: linear-gradient(135deg, #3B82F6, #8B5CF6);
  color: #FFFFFF;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: ${fontSize.md}px;
  box-shadow: ${shadow.sm};
}
.rail-product-name { font-size: ${fontSize.md}px; font-weight: 600; color: ${neutral[900]}; line-height: 1.3; }
.rail-product-sub { font-size: ${fontSize.xs}px; color: ${neutral[400]}; margin-top: 1px; }
.rail-section-label { font-size: ${fontSize.xs}px; font-weight: 600; color: ${neutral[400]}; letter-spacing: .04em; }
.rail-nav { display: flex; flex-direction: column; gap: 2px; }
.rail-nav-item {
  display: flex;
  align-items: center;
  gap: ${space.sm + 2}px;
  padding: ${space.sm}px ${space.sm + 2}px;
  border: none;
  border-radius: ${radius.md}px;
  background: transparent;
  color: ${neutral[600]};
  font-size: ${fontSize.md}px;
  text-align: left;
  cursor: pointer;
  font-family: ${fontFamily.body};
  transition: background-color .15s ease, color .15s ease;
}
.rail-nav-item:hover { background: rgba(15,23,42,.05); color: ${neutral[900]}; }
.rail-nav-item[data-active="true"] { background: rgba(59,130,246,.1); color: ${ACTIVE_DEEP}; font-weight: 600; }
.rail-nav-item-icon { font-size: ${fontSize.md}px; line-height: 1; width: 18px; text-align: center; opacity: .9; }
.rail-nav-item[data-active="true"] .rail-nav-item-icon { opacity: 1; }
.rail-members { display: flex; flex-direction: column; gap: ${space.xs + 2}px; }
.rail-member {
  display: flex;
  align-items: center;
  gap: ${space.sm + 2}px;
  padding: ${space.xs + 1}px ${space.xs}px;
  border-radius: ${radius.md}px;
}
.rail-member-name { font-size: ${fontSize.sm}px; color: ${neutral[700]}; font-weight: 500; }
.rail-member-note { font-size: ${fontSize.xs}px; color: ${neutral[400]}; }
.rail-user {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: ${space.sm}px;
  padding: ${space.sm}px;
  border-radius: ${radius.md}px;
  background: rgba(15,23,42,.04);
}
.rail-user-name { font-size: ${fontSize.sm}px; color: ${neutral[800]}; font-weight: 600; line-height: 1.3; }
.rail-user-role { font-size: ${fontSize.xs}px; color: ${neutral[400]}; line-height: 1.4; }
`;

/* ----------------------------- 布局子块 ----------------------------- */

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** Dock / Rail 悬浮导航条（absolute，相对原型容器定位，不占文档流） */
function RailBar() {
  return (
    <div data-testid="rail-bar" className="rail-dock">
      {/* 常驻图标列 */}
      <div className="rail-icons">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            data-testid="rail-icon"
            data-nav={item.key}
            data-active={item.key === ACTIVE_KEY ? "true" : "false"}
            aria-label={item.label}
            title={item.label}
            className="rail-icon"
          >
            <span aria-hidden>{item.icon}</span>
          </button>
        ))}
      </div>

      {/* 悬浮展开面板 */}
      <div data-testid="rail-panel" className="rail-panel">
        <div className="rail-panel-inner">
          {/* 产品名 */}
          <div className="rail-product">
            <span className="rail-product-mark" aria-hidden>
              A
            </span>
            <span>
              <span className="rail-product-name" style={{ display: "block" }}>
                Agent 协作平台
              </span>
              <span className="rail-product-sub" style={{ display: "block" }}>
                智能体协作工作区
              </span>
            </span>
          </div>

          {/* 导航项（带文字标签） */}
          <div>
            <div className="rail-section-label" style={{ marginBottom: space.sm }}>
              导航
            </div>
            <div className="rail-nav">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  data-testid="nav-item"
                  data-nav={item.key}
                  data-active={item.key === ACTIVE_KEY ? "true" : "false"}
                  className="rail-nav-item"
                >
                  <span className="rail-nav-item-icon" aria-hidden>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* 在线成员 */}
          <div>
            <div className="rail-section-label" style={{ marginBottom: space.sm }}>
              在线成员 · {MEMBERS.length}
            </div>
            <div className="rail-members">
              {MEMBERS.map((m) => (
                <div key={m.role} className="rail-member">
                  <AgentAvatar role={m.role} size="sm" />
                  <span>
                    <span className="rail-member-name" style={{ display: "block" }}>
                      {roles[m.role].label}
                    </span>
                    <span className="rail-member-note" style={{ display: "block" }}>
                      {m.status}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 底部用户信息 */}
          <div className="rail-user">
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                backgroundColor: neutral[900],
                color: "#FFFFFF",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: fontSize.sm,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              运
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="rail-user-name" style={{ display: "block" }}>
                运营者
              </span>
              <span className="rail-user-role" style={{ display: "block" }}>
                项目管理员
              </span>
            </span>
            <span style={{ color: neutral[400], fontSize: fontSize.md }} aria-hidden>
              ⚙
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 会话头部：任务名 + 状态 + 参与者头像堆叠 */
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

      <div aria-label="参与成员" style={{ display: "flex", alignItems: "center", marginLeft: "auto" }}>
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

/** 消息流：7 条消息覆盖 system / user / agent 三型 + 单 @ / 互 @ / @all */
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
      <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
        <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>今天 · 任务会话</span>
        <span style={{ flex: 1, height: 1, backgroundColor: neutral[200] }} />
      </div>

      {MESSAGES.map((msg, i) => (
        <ChatBubble
          key={i}
          text={msg.text}
          type={msg.type}
          author={msg.author}
          role={msg.role}
          time={msg.time}
        />
      ))}

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
        <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
          ⚙
        </span>
        Agent 内部推理过程不广播到群聊，仅最终回复展示；点击成员可实时查看其处理过程
      </div>
    </div>
  );
}

/** @all 提示条 */
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

/** 右侧任务信息面板 */
function TaskPanel() {
  return (
    <aside
      data-testid="task-info-panel"
      style={{
        width: 248,
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
            无需侧边栏即可专注协作——左缘悬浮 Dock 承载全部导航。
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

function NavRail({}: PrototypeRenderProps) {
  return (
    <div style={{ height: "100%", position: "relative", backgroundColor: neutral[50], ...baseFont }}>
      {/* 注入 Dock CSS（纯 CSS hover，无 JS 状态） */}
      <style>{railCss}</style>

      {/* 悬浮导航条：不占文档流，z-index 高于内容 */}
      <RailBar />

      {/* 内容区：从屏幕左缘开始（背景铺满），仅留出 Dock 悬浮宽度避免遮挡 */}
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          paddingLeft: RAIL_W + 24,
        }}
      >
        <TopBar
          title="消息中心"
          subtitle="任务群聊 · 通知中心迭代 · 导航变体 A（Dock / Rail）"
          userName="运营者"
          userRole="项目管理员"
        />
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              backgroundColor: neutral[50],
            }}
          >
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
      </div>
    </div>
  );
}

const def: PrototypeDef = {
  meta: {
    id: "nav-rail",
    name: "导航变体A-Dock悬浮导航",
    group: "导航变体",
    description: "突破传统深色侧边栏：左侧悬浮毛玻璃图标 Dock，hover 展开导航面板，内容区最大化",
    device: "desktop",
  },
  Component: NavRail,
};

export default def;
