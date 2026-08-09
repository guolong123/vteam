/**
 * 布局组件库统一出口
 * =============================================
 * 3 个导航组件从 docs/agent-platform/prototypes/_shared/nav.tsx 原样迁移，
 * 结构 / 样式 / data-testid 与原型一致，token 引用统一走 src/theme/tokens.ts。
 *
 * 引入方式：
 *   import { NavDock, NavTopBar, CmdKPanel } from "@/src/components/layout";
 */
export { NavDock, NAV_ITEMS } from "./nav-dock";
export type { NavDockProps, NavItem } from "./nav-dock";
export { NavTopBar } from "./nav-top-bar";
export type { NavTopBarProps } from "./nav-top-bar";
export { CmdKPanel, DEFAULT_CMDK_ITEMS } from "./cmdk-panel";
export type { CmdKPanelProps, CmdKItem } from "./cmdk-panel";