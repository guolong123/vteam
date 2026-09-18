"use client";

/**
 * SystemSidebar：/system 二级持久侧边栏（trigger-unification Todo 15）
 * =============================================================
 * 与 NavDock 同设计家族、 mutually 独立的组件：
 * - Dock 是 floating 56→248px hover rail（position:absolute）；本侧栏是常驻 208px
 *   in-page 左侧栏，随 /system/layout.tsx 文档流排布。
 * - 选中/hover 视觉与 Dock 逐字一致（常量/色值见下方 NAV_ACTIVE 系，
 *   与 nav-dock.tsx NAV_ACTIVE / NAV_ACTIVE_DEEP 同值；CSS 由 Dock
 *   `.navdock-nav-item[data-active]` / `:hover` / `.dark .navdock-nav-item` 原样改前缀）。
 * - 激活项由 usePathname() 真实路由派生（pathname === href 或以 href + "/" 开头）。
 * - 窄屏（<=1023px）：侧栏变为顶部横向可滚动 pill 行，内容区不被挤压。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；宽度 208px 精确值 + flex 布局。
 */
import { usePathname, useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { neutral, surface, border, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";
import { SYSTEM_NAV_ITEMS, type SystemNavItem } from "@/src/lib/system-nav";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 导航高亮青蓝（与 nav-dock.tsx NAV_ACTIVE 一致） */
const NAV_ACTIVE = "#0D9488";
/** 高亮深一档，用于选中文字（与 nav-dock.tsx NAV_ACTIVE_DEEP 一致） */
const NAV_ACTIVE_DEEP = "#0F766E";

/** /system 左侧栏宽度（精确 208px） */
export const SYSTEM_SIDEBAR_WIDTH = 208;

/** 窄屏断点：低于 1024px 侧栏收起为顶部横向 pill 行 */
const COLLAPSE_MAX = 1023;

export type { SystemNavItem };

/** 由 pathname 派生激活项 key（未知/无子段路径返回 ""，即无激活项） */
export function systemActiveKey(pathname: string): string {
  const hit = SYSTEM_NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return hit ? hit.key : "";
}

/** 由 pathname 派生当前子项 label（/system 本体或未知子段返回 null） */
export function systemCrumbLabel(pathname: string): string | null {
  const hit = SYSTEM_NAV_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return hit ? hit.label : null;
}

const sidebarCss = `
.sysnav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sysnav-item {
  position: relative;
  display: flex; align-items: center; gap: ${space.sm + 2}px;
  min-height: 36px;
  padding: ${space.sm}px ${space.sm + 2}px;
  border: none; border-radius: ${radius.md}px; background: transparent;
  color: ${neutral[600]}; font-size: ${fontSize.md}px; text-align: left;
  cursor: pointer; font-family: ${fontFamily.body};
  transition: background-color .15s ease, color .15s ease;
}
.sysnav-item:hover { background: rgba(15,23,42,.05); color: ${neutral[900]}; }
.sysnav-item[data-active="true"] { background: rgba(13,148,136,.1); color: ${NAV_ACTIVE_DEEP}; font-weight: 600; }
.sysnav-item[data-active="true"]::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: ${radius.pill}px;
  background: ${NAV_ACTIVE};
}
.sysnav-item-icon { font-size: ${fontSize.md}px; line-height: 1; width: 18px; text-align: center; opacity: .9; }
.sysnav-item[data-active="true"] .sysnav-item-icon { opacity: 1; }
.dark .sysnav-item:hover { background: rgba(255,255,255,.06); }
.sysnav-scroll {
  scrollbar-width: none;
}
.sysnav-scroll::-webkit-scrollbar { display: none; }
@media (max-width: ${COLLAPSE_MAX}px) {
  .sysnav-host {
    width: 100% !important;
    flex-shrink: 0;
    border-right: none !important;
    border-bottom: 1px solid ${border};
    padding: ${space.sm}px ${space.md}px !important;
  }
  .sysnav {
    flex-direction: row !important;
    overflow-x: auto;
    gap: ${space.sm}px !important;
  }
  .sysnav-item {
    white-space: nowrap;
    flex-shrink: 0;
  }
  .sysnav-item[data-active="true"]::before {
    left: 50%;
    top: auto;
    bottom: 0;
    transform: translateX(-50%);
    width: 18px;
    height: 3px;
  }
  .sysnav-label { display: none !important; }
}
`;

export interface SystemSidebarProps {
  /** 受控激活 key（缺省由 usePathname() 派生；测试可显式传入） */
  activeKey?: string;
  /** 点击导航项后的额外回调（路由跳转内置） */
  onNavigate?: (item: SystemNavItem) => void;
  style?: CSSProperties;
  className?: string;
}

export function SystemSidebar({ activeKey, onNavigate, style, className }: SystemSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const active = activeKey ?? systemActiveKey(pathname ?? "");

  const goto = (item: SystemNavItem) => {
    if (pathname !== item.href) router.push(item.href);
    onNavigate?.(item);
  };

  return (
    <>
      <style>{sidebarCss}</style>
      <aside
        data-testid="system-sidebar"
        aria-label="系统管理二级导航"
        className={`sysnav-host${className ? ` ${className}` : ""}`}
        style={{
          width: SYSTEM_SIDEBAR_WIDTH,
          flexShrink: 0,
          backgroundColor: surface,
          borderRight: `1px solid ${border}`,
          padding: `${space.lg}px ${space.md}px`,
          display: "flex",
          flexDirection: "column",
          gap: space.sm,
          overflowY: "auto",
          ...baseFont,
          ...style,
        }}
      >
        <div
          data-testid="system-sidebar-label"
          className="sysnav-label"
          style={{
            fontSize: fontSize.xs,
            fontWeight: 600,
            color: neutral[400],
            letterSpacing: ".04em",
            padding: `0 ${space.sm + 2}px`,
          }}
        >
          系统管理
        </div>
        <nav aria-label="系统管理" className="sysnav sysnav-scroll" style={{ display: "flex" }}>
          {SYSTEM_NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              data-testid="system-sidebar-item"
              data-nav={item.key}
              data-active={item.key === active ? "true" : "false"}
              aria-current={item.key === active ? "page" : undefined}
              className="sysnav-item"
              onClick={() => goto(item)}
            >
              <span className="sysnav-item-icon" aria-hidden>
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
    </>
  );
}
