/**
 * NavDock：左侧 Dock 悬浮导航条（毛玻璃胶囊，hover 展开 56→248px）
 *
 * 从 docs/agent-platform/prototypes/_shared/nav.tsx 原样迁移（rail 优先）。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 * 7 个导航项（project / agents / workers / skills / messages / users / roles），
 * 任务与项目为父子层级：任务从「项目」进入（/projects → /board?pid=），无独立看板入口。
 * 对齐 06 篇 Dock 导航与 Cmd+K 命令面板「导航」组。
 *
 * 铁律（T15）：浮层 position: absolute 相对宿主容器（宿主需 position: relative）。
 */
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

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
  { key: "agents", label: "Agent 管理", icon: "◉" },
  { key: "workers", label: "Worker 节点", icon: "⚙" },
  { key: "models", label: "模型管理", icon: "◇" },
  { key: "git-repos", label: "仓库管理", icon: "⌗" },
  { key: "skills", label: "技能与工具", icon: "◫" },
  { key: "messages", label: "消息中心", icon: "✉" },
  { key: "users", label: "用户管理", icon: "☷" },
  { key: "roles", label: "角色权限", icon: "⚖" },
];

/* ------------------------------ scoped 动画与样式 ------------------------------ */
/** 共享 keyframes：navshared 前缀避免污染其他原型 */
const navAnimStyle = `
  @keyframes navshared-blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes navshared-pop { from{opacity:0; transform:translateY(8px) scale(.985)} to{opacity:1; transform:none} }
  @keyframes navshared-fade { from{opacity:0} to{opacity:1} }
`;

export interface NavDockProps {
  /** 当前激活导航 key（对应 NAV_ITEMS.key），命中项高亮 */
  activeKey?: string;
  /** 展开面板中的项目名 */
  projectName?: string;
  /** 导航项（默认 NAV_ITEMS；调用方可按权限过滤后传入，ISSUE-005） */
  items?: NavItem[];
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
  /* 触边安全网：不超高宿主 100% 减上下安全边距，小圆角长方形永不被容器裁剪 */
  max-height: calc(100% - ${space.xxl}px);
  /* 收起态内容高度基线（7 图标 ≈360px），min() 保证小视口不超 max-height（CSS2.1 §10.7 冲突时 max 失效） */
  min-height: min(360px, calc(100% - 32px));
  border-radius: ${radius.lg}px;
  background: rgba(255,255,255,.72);
  border: 1px solid rgba(15,23,42,.08);
  backdrop-filter: blur(14px) saturate(1.4);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  box-shadow: ${shadow.md};
  z-index: 50;
  overflow: hidden;
  transition: width .28s cubic-bezier(.22,1,.36,1), min-height .28s cubic-bezier(.22,1,.36,1), box-shadow .28s ease;
}
.navdock-dock:hover {
  width: ${RAIL_OPEN_W}px;
  /* 展开态 440，小视口自动取 calc(100% - 32px)，min-height 永不超 max-height 封顶 */
  min-height: min(440px, calc(100% - 32px));
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
  /* 收起态超高兜底（7 图标一般不触发） */
  overflow-y: auto;
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
  /* 水平裁剪保宽度动画，垂直超高时内部滚动（max-height 兜底） */
  overflow: hidden auto;
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
  padding: ${space.xl}px ${space.md}px ${space.lg}px;
  display: flex;
  flex-direction: column;
  gap: ${space.md}px;
  white-space: nowrap;
  min-height: 0;
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
  items,
  onNavClick,
  children,
  style,
  className,
}: NavDockProps) {
  const navItems = items ?? NAV_ITEMS;
  // 展开态完全由 CSS :hover 驱动（.navdock-dock:hover）：鼠标移入 dock 胶囊本体（56px）即展开，
  // 移出 dock（含展开后的 panel）即收起。无热区，从内容区移向 dock 途中不触发展开。
  return (
    <>
      <style>{dockCss}</style>
      <div
        data-testid="rail-bar"
        className={`navdock-dock${className ? ` ${className}` : ""}`}
        style={style}
      >
        {/* 收起态：图标列（hover 高亮 + Activity Bar 指示条） */}
        <div className="navdock-icons">
          {navItems.map((item) => (
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
                {navItems.map((item) => (
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