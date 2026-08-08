/**
 * 原型：导航方案-融合版（Dock 悬浮导航 + Cmd+K 命令面板）
 * ============================================================
 * 将变体 A（Dock / Rail 悬浮导航）与变体 B（Command Palette 主导航）合二为一：
 * - **左侧 Dock 悬浮导航条**（来自 nav-rail）：毛玻璃胶囊、hover 展开 56→248px
 *   浮层面板、4 个图标、当前页高亮 + Activity Bar 指示条。默认收起。
 * - **浅色顶栏**（来自 nav-cmdk）：左侧面包屑 + 居中 Cmd+K 触发框（⌘K 徽标）
 *   + 右侧用户头像。
 * - **Cmd+K 命令面板**（来自 nav-cmdk）：居中毛玻璃浮层、默认可见（模拟按下 ⌘K
 *   状态）。命令分组「导航（切换项目 ▤ / 任务看板 ☰ / Agent 管理 ◉）——图标与
 *   Dock 一一对应」「操作（新建任务 / 查看产出物 / 查看 Agent 会话）」。
 * - Dock 与命令面板交互呼应：面板「导航」组即 Dock 图标集的可检索文字形态。
 * - 层叠设计：命令面板容器 z-index 40，Dock z-index 50 —— 面板弹出时 Dock 仍
 *   浮于遮罩之上可 hover 展开，体现「两者共存不冲突」的融合心智。
 * - 演示场景：任务群聊「通知中心迭代」（复用 PRD 03 @触发消息流，7 条消息）。
 * - ⚠️ T15 教训：全部浮层 position: absolute 相对 root（relative + height:100%），
 *   严禁 fixed / 100vh / 100vw。
 */
import type { CSSProperties } from "react";
import type { PrototypeDef, PrototypeRenderProps } from "@md-docs/prototypes/types";
import {
  AgentAvatar,
  ChatBubble,
  MessageInput,
  StatusBadge,
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

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 数据（复用 PRD 03 场景） ------------------------------ */

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

/* Dock 导航项（active = 消息中心，当前任务群聊场景） */
const NAV_ITEMS: { key: string; label: string; icon: string }[] = [
  { key: "project", label: "项目", icon: "▤" },
  { key: "board", label: "任务看板", icon: "☰" },
  { key: "agents", label: "Agent 管理", icon: "◉" },
  { key: "messages", label: "消息中心", icon: "✉" },
];

const ACTIVE_KEY = "messages";

/* 命令面板数据：导航组图标与 Dock 一一对应（▤ ☰ ◉） */
interface CommandItem {
  id: string;
  icon: string;
  label: string;
  desc: string;
  key: string;
}

interface CommandGroup {
  title: string;
  items: CommandItem[];
}

const commandGroups: CommandGroup[] = [
  {
    title: "导航",
    items: [
      { id: "switch-project", icon: "▤", label: "切换项目", desc: "在项目之间快速跳转", key: "⌘1" },
      { id: "task-board", icon: "☰", label: "任务看板", desc: "查看全部任务与状态流转", key: "⌘2" },
      { id: "agent-manage", icon: "◉", label: "Agent 管理", desc: "配置角色、技能与权限", key: "⌘3" },
    ],
  },
  {
    title: "操作",
    items: [
      { id: "new-task", icon: "＋", label: "新建任务", desc: "创建任务并指派给 Agent 团队", key: "⌘N" },
      { id: "view-artifacts", icon: "▦", label: "查看产出物", desc: "浏览当前任务文档库与版本", key: "⌘⇧A" },
      { id: "view-sessions", icon: "◷", label: "查看 Agent 会话", desc: "实时查看协作过程与上下文", key: "⌘⇧S" },
    ],
  },
];

/* ------------------------------ Dock 常量（对齐 nav-rail） ------------------------------ */

const ACTIVE = "#3B82F6";
const ACTIVE_DEEP = "#2563EB";
const RAIL_W = 56;
const RAIL_OPEN_W = 248;
const PANEL_W = RAIL_OPEN_W - RAIL_W;

/* scoped 动画：navhybrid 前缀避免污染其他原型 */
const protoStyle = `
  @keyframes navhybrid-blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes navhybrid-pop { from{opacity:0; transform:translateY(8px) scale(.985)} to{opacity:1; transform:none} }
  @keyframes navhybrid-fade { from{opacity:0} to{opacity:1} }
`;

/* ------------------------------ Dock 悬浮导航条（absolute，复用 nav-rail 设计） ------------------------------ */

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
.rail-product { display: flex; align-items: center; gap: ${space.sm}px; }
.rail-product-mark {
  width: 32px; height: 32px; flex-shrink: 0;
  border-radius: ${radius.md}px;
  background: linear-gradient(135deg, #3B82F6, #8B5CF6);
  color: #FFFFFF;
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: ${fontSize.md}px;
  box-shadow: ${shadow.sm};
}
.rail-product-name { font-size: ${fontSize.md}px; font-weight: 600; color: ${neutral[900]}; line-height: 1.3; }
.rail-product-sub { font-size: ${fontSize.xs}px; color: ${neutral[400]}; margin-top: 1px; }
.rail-section-label { font-size: ${fontSize.xs}px; font-weight: 600; color: ${neutral[400]}; letter-spacing: .04em; }
.rail-nav { display: flex; flex-direction: column; gap: 2px; }
.rail-nav-item {
  display: flex; align-items: center; gap: ${space.sm + 2}px;
  padding: ${space.sm}px ${space.sm + 2}px;
  border: none; border-radius: ${radius.md}px; background: transparent;
  color: ${neutral[600]}; font-size: ${fontSize.md}px; text-align: left;
  cursor: pointer; font-family: ${fontFamily.body};
  transition: background-color .15s ease, color .15s ease;
}
.rail-nav-item:hover { background: rgba(15,23,42,.05); color: ${neutral[900]}; }
.rail-nav-item[data-active="true"] { background: rgba(59,130,246,.1); color: ${ACTIVE_DEEP}; font-weight: 600; }
.rail-nav-item-icon { font-size: ${fontSize.md}px; line-height: 1; width: 18px; text-align: center; opacity: .9; }
.rail-nav-item[data-active="true"] .rail-nav-item-icon { opacity: 1; }
.rail-members { display: flex; flex-direction: column; gap: ${space.xs + 2}px; }
.rail-member {
  display: flex; align-items: center; gap: ${space.sm + 2}px;
  padding: ${space.xs + 1}px ${space.xs}px; border-radius: ${radius.md}px;
}
.rail-member-name { font-size: ${fontSize.sm}px; color: ${neutral[700]}; font-weight: 500; }
.rail-member-note { font-size: ${fontSize.xs}px; color: ${neutral[400]}; }
.rail-user {
  margin-top: auto; display: flex; align-items: center; gap: ${space.sm}px;
  padding: ${space.sm}px; border-radius: ${radius.md}px; background: rgba(15,23,42,.04);
}
.rail-user-name { font-size: ${fontSize.sm}px; color: ${neutral[800]}; font-weight: 600; line-height: 1.3; }
.rail-user-role { font-size: ${fontSize.xs}px; color: ${neutral[400]}; line-height: 1.4; }
`;

function RailBar() {
  return (
    <div data-testid="rail-bar" className="rail-dock">
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

      <div data-testid="rail-panel" className="rail-panel">
        <div className="rail-panel-inner">
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

/* ------------------------------ 浅色顶栏：面包屑 + Cmd+K 触发框 + 用户 ------------------------------ */

function HybridTopBar() {
  return (
    <header
      style={{
        height: 60,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space.xl,
        padding: `0 ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {/* 左侧面包屑 */}
      <nav
        data-testid="top-breadcrumb"
        aria-label="面包屑"
        style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}
      >
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[500],
            fontWeight: 500,
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          Agent 协作平台
        </span>
        <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.lg, lineHeight: 1 }}>
          ›
        </span>
        <span
          style={{
            fontSize: fontSize.md,
            color: neutral[900],
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          T-1041 通知中心迭代
        </span>
      </nav>

      {/* 中部：Cmd+K 触发框 */}
      <button
        type="button"
        data-testid="cmdk-trigger"
        aria-label="打开命令面板（⌘K）"
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          width: 280,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[50],
          border: `1px solid ${neutral[200]}`,
          cursor: "pointer",
          fontFamily: fontFamily.body,
          boxShadow: shadow.sm,
        }}
      >
        <span aria-hidden style={{ fontSize: fontSize.lg, color: neutral[400], lineHeight: 1 }}>
          ⌕
        </span>
        <span
          style={{
            flex: 1,
            textAlign: "left",
            fontSize: fontSize.md,
            color: neutral[400],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          搜索或输入命令…
        </span>
        <span
          aria-hidden
          style={{
            fontSize: fontSize.xs,
            fontWeight: 600,
            color: neutral[500],
            backgroundColor: "#FFFFFF",
            border: `1px solid ${neutral[200]}`,
            padding: "1px 6px",
            borderRadius: radius.sm,
          }}
        >
          ⌘K
        </span>
      </button>

      {/* 右侧用户 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 500 }}>运营者</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>项目管理员</div>
        </div>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: "50%",
            backgroundColor: neutral[900],
            color: "#FFFFFF",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: fontSize.md,
            fontWeight: 600,
            userSelect: "none",
          }}
        >
          运
        </span>
      </div>
    </header>
  );
}

/* ------------------------------ Cmd+K 命令面板（居中毛玻璃 · 默认可见） ------------------------------ */

function CmdItem({ item, active }: { item: CommandItem; active: boolean }) {
  return (
    <button
      type="button"
      data-testid="cmdk-item"
      data-command-id={item.id}
      data-active={active ? "true" : "false"}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: space.md,
        padding: `${space.sm + 2}px ${space.md}px`,
        borderRadius: radius.md,
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        backgroundColor: active ? "#2563EB" : "transparent",
        fontFamily: fontFamily.body,
        transition: "background-color .1s ease",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: radius.sm,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: fontSize.lg,
          lineHeight: 1,
          backgroundColor: active ? "rgba(255,255,255,.18)" : neutral[100],
          color: active ? "#FFFFFF" : roleText.product,
        }}
      >
        {item.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span
          style={{
            fontSize: fontSize.md,
            fontWeight: 600,
            color: active ? "#FFFFFF" : neutral[800],
          }}
        >
          {item.label}
        </span>
        <span
          style={{
            fontSize: fontSize.xs,
            color: active ? "rgba(255,255,255,.78)" : neutral[400],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.desc}
        </span>
      </span>
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          fontSize: fontSize.xs,
          fontWeight: 500,
          color: active ? "rgba(255,255,255,.88)" : neutral[400],
          backgroundColor: active ? "rgba(255,255,255,.16)" : neutral[100],
          padding: "2px 7px",
          borderRadius: radius.sm,
        }}
      >
        {item.key}
      </span>
    </button>
  );
}

function CmdKPanel() {
  return (
    <div
      data-testid="cmdk-panel"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12%",
        ...baseFont,
      }}
    >
      {/* 轻遮罩：主体内容仍然可辨 */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(15,23,42,.32)",
          animation: "navhybrid-fade .18s ease-out",
        }}
      />
      {/* 面板：毛玻璃 + 圆角 + 阴影 */}
      <div
        style={{
          position: "relative",
          width: 600,
          maxWidth: "calc(100% - 48px)",
          maxHeight: "min(560px, 74%)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: radius.lg,
          backgroundColor: "rgba(255,255,255,.84)",
          backdropFilter: "blur(20px) saturate(1.5)",
          WebkitBackdropFilter: "blur(20px) saturate(1.5)",
          border: "1px solid rgba(255,255,255,.72)",
          boxShadow: "0 24px 64px rgba(15,23,42,.26), 0 4px 16px rgba(15,23,42,.10)",
          animation: "navhybrid-pop .16s ease-out",
        }}
      >
        {/* 搜索输入（focus 状态 + 光标闪烁） */}
        <div
          data-testid="cmdk-search"
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.lg}px ${space.xl}px`,
            borderBottom: `1px solid ${neutral[200]}`,
            backgroundColor: "rgba(255,255,255,.55)",
          }}
        >
          <span aria-hidden style={{ fontSize: 18, color: neutral[400], lineHeight: 1 }}>
            ⌕
          </span>
          <input
            autoFocus
            readOnly
            value="任务"
            aria-label="搜索命令"
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: fontSize.xl,
              fontWeight: 500,
              color: neutral[900],
              fontFamily: fontFamily.body,
              padding: 0,
            }}
          />
          <span
            aria-hidden
            style={{
              width: 2,
              height: 18,
              flexShrink: 0,
              borderRadius: 1,
              backgroundColor: roleText.product,
              animation: "navhybrid-blink 1.05s step-end infinite",
            }}
          />
          <span
            style={{
              fontSize: fontSize.xs,
              color: neutral[400],
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.sm,
              padding: "1px 6px",
              flexShrink: 0,
            }}
          >
            ESC
          </span>
        </div>

        {/* 命令分组列表 */}
        <div style={{ flex: 1, overflow: "auto", padding: space.sm }}>
          {commandGroups.map((group) => (
            <div key={group.title}>
              <div
                style={{
                  padding: `${space.sm}px ${space.md}px ${space.xs}px`,
                  fontSize: fontSize.xs,
                  fontWeight: 600,
                  color: neutral[400],
                  textTransform: "uppercase",
                  letterSpacing: 0.06,
                }}
              >
                {group.title}
              </div>
              {group.items.map((item) => (
                <CmdItem key={item.id} item={item} active={item.id === "switch-project"} />
              ))}
            </div>
          ))}
        </div>

        {/* 底部提示：融合提示 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.lg,
            padding: `${space.sm}px ${space.lg}px`,
            borderTop: `1px solid ${neutral[200]}`,
            backgroundColor: "rgba(255,255,255,.55)",
            fontSize: fontSize.xs,
            color: neutral[400],
          }}
        >
          <span>↑↓ 选择</span>
          <span>↵ 打开</span>
          <span>⌘K 唤起</span>
          <span style={{ marginLeft: "auto" }}>Dock 常驻 · ⌘K 全览</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 内容区：任务群聊（对齐 nav-rail） ------------------------------ */

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
            Dock 常驻承载导航，⌘K 随时全览命令——两者融合，内容区保持最大化。
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

/* ------------------------------ 原型主组件 ------------------------------ */

function NavHybridPage(_: PrototypeRenderProps) {
  return (
    <div
      data-testid="nav-hybrid-root"
      style={{ height: "100%", minHeight: 720, position: "relative", backgroundColor: neutral[50], ...baseFont }}
    >
      <style>{protoStyle}</style>
      <style>{railCss}</style>

      {/* 顶栏（文档流顶部） */}
      <HybridTopBar />

      {/* 内容区：任务群聊 + 产出物面板，左侧留白避开 Dock */}
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

      {/* 左侧 Dock 悬浮导航条：默认收起，hover 展开（z-index 50，浮于命令面板遮罩之上） */}
      <RailBar />

      {/* Cmd+K 命令面板：默认可见，模拟按下 ⌘K 状态（z-index 40） */}
      <CmdKPanel />
    </div>
  );
}

export default {
  meta: {
    id: "nav-hybrid",
    name: "导航方案-融合版",
    group: "导航变体",
    description: "Dock 悬浮导航 + Cmd+K 命令面板合二为一：两者共存不冲突，内容区最大化",
    device: "desktop",
  },
  Component: NavHybridPage,
} satisfies PrototypeDef;
