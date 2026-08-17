/**
 * Agent Platform 共享导航组件库
 * =============================================
 * 从演示原型 nav-hybrid（Dock 悬浮导航 + Cmd+K 命令面板 + 浅色顶栏）提取为
 * 可复用的共享组件，供业务页面（project-list / task-create / task-board /
 * group-chat / dm-chat / task-detail / agent-config / worker-list /
 * worker-install / skills-tools-manage / tool-register / user-management /
 * role-permission 等）统一复用，替换深色 Sidebar。
 *
 * 三个组件独立、可组合（页面可自由选择组合方式）：
 * - NavDock    左侧 Dock 悬浮导航条：毛玻璃胶囊，hover 展开 56→248px，纯 CSS 无 JS
 * - NavTopBar  浅色顶栏：左面包屑 + 居中 Cmd+K 触发框 + 右用户头像
 * - CmdKPanel  Cmd+K 命令面板浮层：居中毛玻璃 + 遮罩；受控开关（open 默认 false，
 *   页面用 useState 管理，onClose 关闭：✕ 按钮 / 遮罩点击 / Esc 键）
 *
 * 铁律（T15）：所有浮层 position: absolute 相对宿主容器（宿主需 position: relative），
 * 严禁 fixed / 100vh / 100vw。颜色 / 间距 / 圆角 / 字号 / 阴影一律取自 ./styles token，
 * 组件内不散落 magic number（导航高亮蓝 #3B82F6 与 styles.roles.product 一致，收敛为具名常量）。
 *
 * 引入方式（页面内相对 import）：
 *   import { NavDock, NavTopBar, CmdKPanel } from "../_shared/nav";
 */
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "./styles";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/* ------------------------------ 导航语义常量 ------------------------------ */
/** 导航高亮蓝（与 styles.roles.product.color 一致） */
const NAV_ACTIVE = "#3B82F6";
/** 高亮深一档（用于文字 / 选中态底色） */
const NAV_ACTIVE_DEEP = "#2563EB";

/** Dock 收起 / 展开宽度（56→248px） */
const RAIL_W = 56;
const RAIL_OPEN_W = 248;
const PANEL_W = RAIL_OPEN_W - RAIL_W;

/** Dock 导航项（图标与 Cmd+K 命令面板「导航」组一一对应） */
export interface NavItem {
  key: string;
  label: string;
  icon: string;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "project", label: "项目", icon: "▤" },
  { key: "board", label: "任务看板", icon: "☰" },
  { key: "agents", label: "Agent 管理", icon: "◉" },
  { key: "workers", label: "Worker 节点", icon: "⚙" },
  { key: "skills", label: "技能与工具", icon: "◫" },
  { key: "messages", label: "消息中心", icon: "✉" },
  { key: "users", label: "用户管理", icon: "☷" },
];

/* ------------------------------ scoped 动画与样式 ------------------------------ */
/** 共享 keyframes：navshared 前缀避免污染其他原型 */
const navAnimStyle = `
  @keyframes navshared-blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes navshared-pop { from{opacity:0; transform:translateY(8px) scale(.985)} to{opacity:1; transform:none} }
  @keyframes navshared-fade { from{opacity:0} to{opacity:1} }
`;

/* ================================ NavDock ================================
 * 左侧 Dock 悬浮导航条：毛玻璃胶囊、hover 展开 56→248px、activeKey 高亮 +
 * Activity Bar 指示条（::before）。纯 CSS 交互，无 JS 状态。
 * 宿主容器需 position: relative（本组件内部为 absolute 定位）。
 */
export interface NavDockProps {
  /** 当前激活导航 key（对应 NAV_ITEMS.key），命中项高亮 */
  activeKey?: string;
  /** 展开面板中的项目名 */
  projectName?: string;
  /** 点击导航项回调（key 为导航项 key） */
  onNavClick?: (key: string) => void;
  /** 面板内底部扩展插槽（如成员列表 / 在线状态） */
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

const dockCss = navAnimStyle + `
.navdock-dock {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: ${RAIL_W}px;
  display: flex;
  align-items: stretch;
  border-radius: ${radius.pill}px;
  background: rgba(255,255,255,.72);
  border: 1px solid rgba(15,23,42,.08);
  backdrop-filter: blur(14px) saturate(1.4);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  box-shadow: ${shadow.md};
  z-index: 50;
  overflow: hidden;
  transition: width .28s cubic-bezier(.22,1,.36,1), box-shadow .28s ease;
}
.navdock-dock:hover {
  width: ${RAIL_OPEN_W}px;
  box-shadow: ${shadow.lg};
}
.navdock-icons {
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
.navdock-icon {
  position: relative;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: ${radius.md}px;
  background: transparent;
  color: ${neutral[500]};
  font-size: ${fontSize.xl}px;
  line-height: 1;
  cursor: pointer;
  font-family: ${fontFamily.body};
  transition: background-color .15s ease, color .15s ease, transform .15s ease;
}
.navdock-icon:hover { background: rgba(59,130,246,.1); color: ${NAV_ACTIVE_DEEP}; transform: translateY(-1px); }
.navdock-icon[data-active="true"] { background: rgba(59,130,246,.12); color: ${NAV_ACTIVE}; }
/* Activity Bar 指示条 */
.navdock-icon[data-active="true"]::before {
  content: "";
  position: absolute;
  left: -8px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: ${radius.pill}px;
  background: ${NAV_ACTIVE};
}
.navdock-panel {
  width: 0;
  opacity: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width .28s cubic-bezier(.22,1,.36,1), opacity .18s ease .06s;
  border-left: 1px solid rgba(15,23,42,.06);
}
.navdock-dock:hover .navdock-panel {
  width: ${PANEL_W}px;
  opacity: 1;
}
.navdock-panel-inner {
  width: ${PANEL_W}px;
  padding: ${space.lg}px ${space.md}px ${space.md}px;
  display: flex;
  flex-direction: column;
  gap: ${space.md}px;
  white-space: nowrap;
}
.navdock-product { display: flex; align-items: center; gap: ${space.sm}px; }
.navdock-product-mark {
  width: 32px; height: 32px; flex-shrink: 0;
  border-radius: ${radius.md}px;
  background: linear-gradient(135deg, ${NAV_ACTIVE}, #8B5CF6);
  color: #FFFFFF;
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: ${fontSize.md}px;
  box-shadow: ${shadow.sm};
}
.navdock-product-name { font-size: ${fontSize.md}px; font-weight: 600; color: ${neutral[900]}; line-height: 1.3; }
.navdock-product-sub { font-size: ${fontSize.xs}px; color: ${neutral[400]}; margin-top: 1px; }
.navdock-section-label { font-size: ${fontSize.xs}px; font-weight: 600; color: ${neutral[400]}; letter-spacing: .04em; }
.navdock-nav { display: flex; flex-direction: column; gap: 2px; }
.navdock-nav-item {
  display: flex; align-items: center; gap: ${space.sm + 2}px;
  padding: ${space.sm}px ${space.sm + 2}px;
  border: none; border-radius: ${radius.md}px; background: transparent;
  color: ${neutral[600]}; font-size: ${fontSize.md}px; text-align: left;
  cursor: pointer; font-family: ${fontFamily.body};
  transition: background-color .15s ease, color .15s ease;
}
.navdock-nav-item:hover { background: rgba(15,23,42,.05); color: ${neutral[900]}; }
.navdock-nav-item[data-active="true"] { background: rgba(59,130,246,.1); color: ${NAV_ACTIVE_DEEP}; font-weight: 600; }
.navdock-nav-item-icon { font-size: ${fontSize.md}px; line-height: 1; width: 18px; text-align: center; opacity: .9; }
.navdock-nav-item[data-active="true"] .navdock-nav-item-icon { opacity: 1; }
.navdock-extra {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: ${space.xs + 2}px;
}
`;

export function NavDock({
  activeKey,
  projectName = "Agent 协作平台",
  onNavClick,
  children,
  style,
  className,
}: NavDockProps) {
  return (
    <>
      <style>{dockCss}</style>
      <div data-testid="rail-bar" className={`navdock-dock${className ? ` ${className}` : ""}`} style={style}>
        {/* 收起态：图标列（hover 高亮 + Activity Bar 指示条） */}
        <div className="navdock-icons">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              data-testid="rail-icon"
              data-nav={item.key}
              data-active={item.key === activeKey ? "true" : "false"}
              aria-label={item.label}
              title={item.label}
              className="navdock-icon"
              onClick={onNavClick ? () => onNavClick(item.key) : undefined}
            >
              <span aria-hidden>{item.icon}</span>
            </button>
          ))}
        </div>

        {/* 展开态：浮层面板（项目名 + 导航列表 + children 扩展槽） */}
        <div data-testid="rail-panel" className="navdock-panel">
          <div className="navdock-panel-inner" style={baseFont}>
            <div className="navdock-product">
              <span className="navdock-product-mark" aria-hidden>
                A
              </span>
              <span>
                <span className="navdock-product-name" style={{ display: "block" }}>
                  {projectName}
                </span>
                <span className="navdock-product-sub" style={{ display: "block" }}>
                  智能体协作工作区
                </span>
              </span>
            </div>

            <div>
              <div className="navdock-section-label" style={{ marginBottom: space.sm }}>
                导航
              </div>
              <div className="navdock-nav">
                {NAV_ITEMS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    data-testid="nav-item"
                    data-nav={item.key}
                    data-active={item.key === activeKey ? "true" : "false"}
                    className="navdock-nav-item"
                    onClick={onNavClick ? () => onNavClick(item.key) : undefined}
                  >
                    <span className="navdock-nav-item-icon" aria-hidden>
                      {item.icon}
                    </span>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {children && <div className="navdock-extra">{children}</div>}
          </div>
        </div>
      </div>
    </>
  );
}

/* ================================ NavTopBar ================================
 * 浅色顶栏：左面包屑（breadcrumb 数组用 › 连接；缺省回退 title/subtitle）+
 * 居中 Cmd+K 触发框（「搜索或输入命令…」+ ⌘K 徽标）+ 右用户头像。
 * 处于文档流（非浮层），height 60 固定。
 */
export interface NavTopBarProps {
  /** 面包屑路径（按序用 › 连接）；提供时替代 title/subtitle 展示 */
  breadcrumb?: string[];
  /** 无 breadcrumb 时的左侧标题 */
  title?: string;
  /** 无 breadcrumb 时的左侧副标题 */
  subtitle?: string;
  userName?: string;
  userRole?: string;
  /** 点击 Cmd+K 触发框回调（打开命令面板） */
  onCmdKClick?: () => void;
  /** 右侧用户头像后扩展插槽 */
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function NavTopBar({
  breadcrumb,
  title = "任务看板",
  subtitle,
  userName = "运营者",
  userRole = "项目管理员",
  onCmdKClick,
  children,
  style,
  className,
}: NavTopBarProps) {
  const hasBreadcrumb = !!breadcrumb && breadcrumb.length > 0;
  const initials = userName.slice(0, 1);
  return (
    <header
      data-testid="topbar"
      className={className}
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
        ...style,
      }}
    >
      {/* 左侧：面包屑 或 标题 */}
      {hasBreadcrumb ? (
        <nav
          data-testid="top-breadcrumb"
          aria-label="面包屑"
          style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}
        >
          {breadcrumb.map((crumb, i) => {
            const isLast = i === breadcrumb.length - 1;
            return (
              <span
                key={i}
                style={{ display: "inline-flex", alignItems: "center", gap: space.sm, minWidth: 0 }}
              >
                {i > 0 && (
                  <span aria-hidden style={{ color: neutral[300], fontSize: fontSize.lg, lineHeight: 1 }}>
                    ›
                  </span>
                )}
                <span
                  style={{
                    fontSize: fontSize.md,
                    fontWeight: isLast ? 600 : 500,
                    color: isLast ? neutral[900] : neutral[500],
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {crumb}
                </span>
              </span>
            );
          })}
        </nav>
      ) : (
        <div data-testid="top-title" style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: fontSize.lg,
              fontWeight: 600,
              color: neutral[900],
              lineHeight: 1.3,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>{subtitle}</div>
          )}
        </div>
      )}

      {/* 中部：Cmd+K 触发框 */}
      <button
        type="button"
        data-testid="cmdk-trigger"
        aria-label="打开命令面板（⌘K）"
        onClick={onCmdKClick}
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

      {/* 右侧：用户信息 + 头像 + children 插槽 */}
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 500 }}>{userName}</div>
          <div style={{ fontSize: fontSize.xs, color: neutral[400] }}>{userRole}</div>
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
          {initials}
        </span>
        {children}
      </div>
    </header>
  );
}

/* ================================ CmdKPanel ================================
 * Cmd+K 命令面板浮层：居中毛玻璃 + 遮罩（absolute inset:0），受控开关。
 * 页面以 useState 管理 open，点击 NavTopBar 的 cmdk-trigger（onCmdKClick）打开，
 * 通过 onClose 关闭（右上 ✕ / 遮罩点击 / Esc 键）。
 * items 按 group 分组渲染；icon 与 Dock 图标对应（导航组 ▤ ☰ ◉）。
 * 宿主容器需 position: relative。
 */
export interface CmdKItem {
  group: string;
  label: string;
  icon: string;
  /** 是否高亮（模拟键盘选中态） */
  active?: boolean;
}

export interface CmdKPanelProps {
  /** 是否展示（默认 false，受控开关；由父级 useState 管理） */
  open?: boolean;
  /** 关闭回调（✕ 按钮 / 遮罩点击 / Esc 键触发） */
  onClose?: () => void;
  /** 命令项（默认提供「导航 / 操作」两组，导航 7 条与 Dock 图标对应） */
  items?: CmdKItem[];
  /** 点击命令项回调 */
  onSelect?: (label: string) => void;
  /** 底部提示区扩展插槽 */
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

const DEFAULT_CMDK_ITEMS: CmdKItem[] = [
  { group: "导航", label: "切换项目", icon: "▤" },
  { group: "导航", label: "任务看板", icon: "☰" },
  { group: "导航", label: "Agent 管理", icon: "◉" },
  { group: "导航", label: "Worker 节点", icon: "⚙" },
  { group: "导航", label: "技能与工具", icon: "◫" },
  { group: "导航", label: "消息中心", icon: "✉" },
  { group: "导航", label: "用户管理", icon: "☷" },
  { group: "操作", label: "新建任务", icon: "＋" },
  { group: "操作", label: "查看产出物", icon: "▦" },
  { group: "操作", label: "查看 Agent 会话", icon: "◷" },
];

const panelCss = navAnimStyle + `
.navcmdk-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12%;
}
.navcmdk-mask {
  position: absolute;
  inset: 0;
  background-color: rgba(15,23,42,.32);
  animation: navshared-fade .18s ease-out;
}
.navcmdk-panel {
  position: relative;
  width: 600px;
  max-width: calc(100% - 48px);
  max-height: min(560px, 74%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: ${radius.lg}px;
  background-color: rgba(255,255,255,.84);
  backdrop-filter: blur(20px) saturate(1.5);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  border: 1px solid rgba(255,255,255,.72);
  box-shadow: ${shadow.lg};
  animation: navshared-pop .16s ease-out;
}
.navcmdk-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: ${space.md}px;
  padding: ${space.sm + 2}px ${space.md}px;
  border-radius: ${radius.md}px;
  border: none;
  cursor: pointer;
  text-align: left;
  background: transparent;
  color: ${neutral[700]};
  font-family: ${fontFamily.body};
  transition: background-color .15s ease, color .15s ease;
}
.navcmdk-item:hover { background: rgba(15,23,42,.05); color: ${neutral[900]}; }
.navcmdk-item[data-active="true"] { background: ${NAV_ACTIVE_DEEP}; color: #FFFFFF; }
.navcmdk-item-icon {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: ${radius.sm}px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: ${fontSize.lg}px;
  line-height: 1;
  background-color: ${neutral[100]};
  color: ${NAV_ACTIVE};
}
.navcmdk-item[data-active="true"] .navcmdk-item-icon { background: rgba(255,255,255,.18); color: #FFFFFF; }
.navcmdk-item-label {
  flex: 1;
  min-width: 0;
  font-size: ${fontSize.md}px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.navcmdk-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  margin-left: ${space.xs}px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: transparent;
  color: ${neutral[400]};
  font-size: ${fontSize.lg}px;
  line-height: 1;
  transition: background-color .15s ease, color .15s ease;
}
.navcmdk-close:hover { background-color: ${neutral[100]}; color: ${neutral[900]}; }
`;

export function CmdKPanel({
  open = false,
  items = DEFAULT_CMDK_ITEMS,
  onSelect,
  onClose,
  children,
  style,
  className,
}: CmdKPanelProps) {
  // Esc 键关闭：open 时才挂监听，卸载/关闭时清理
  useEffect(() => {
    if (!open || !onClose) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  // 按 group 保序分组
  const groups: { group: string; items: CmdKItem[] }[] = [];
  for (const item of items) {
    const g = groups.find((x) => x.group === item.group);
    if (g) g.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }

  return (
    <div
      data-testid="cmdk-panel"
      className={`navcmdk-overlay${className ? ` ${className}` : ""}`}
      style={baseFont}
    >
      <style>{panelCss}</style>
      {/* 轻遮罩：主体内容仍然可辨，点击关闭 */}
      <div aria-hidden className="navcmdk-mask" onClick={onClose} />

      {/* 面板：毛玻璃 + 圆角 + 阴影 */}
      <div className="navcmdk-panel" style={style}>
        {/* 搜索输入（光标闪烁模拟聚焦态） */}
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
            placeholder="搜索或输入命令…"
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
              backgroundColor: NAV_ACTIVE_DEEP,
              animation: "navshared-blink 1.05s step-end infinite",
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
          {/* 关闭按钮：右上角 ✕（圆形 hover） */}
          <button
            type="button"
            data-testid="cmdk-close"
            aria-label="关闭命令面板"
            className="navcmdk-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* 命令分组列表 */}
        <div style={{ flex: 1, overflow: "auto", padding: space.sm }}>
          {groups.map((g) => (
            <div key={g.group}>
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
                {g.group}
              </div>
              {g.items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  data-testid="cmdk-item"
                  data-active={item.active ? "true" : "false"}
                  className="navcmdk-item"
                  onClick={onSelect ? () => onSelect(item.label) : undefined}
                >
                  <span className="navcmdk-item-icon" aria-hidden>
                    {item.icon}
                  </span>
                  <span className="navcmdk-item-label">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* 底部提示（children 可覆盖） */}
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
          {children ?? (
            <>
              <span>↑↓ 选择</span>
              <span>↵ 打开</span>
              <span>⌘K 唤起</span>
              <span style={{ marginLeft: "auto" }}>Dock 常驻 · ⌘K 全览</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
