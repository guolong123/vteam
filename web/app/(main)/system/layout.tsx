"use client";

/**
 * /system 段布局（trigger-unification Todo 15：二级导航壳）
 * =============================================================
 * - 渲染常驻左侧 SystemSidebar（208px）+ 右侧内容列（面包屑 + children）。
 * - 本布局位于 (main) 路由组内：AppShell（NavTopBar + NavDock + CmdKPanel + 登录守卫）
 *   已由上层 app/(main)/layout.tsx 提供，此处不再渲染全局 chrome。
 * - 不强制 PageWindow：子页面自带容器约定（如 triggers/memories 页各自 root），
 *   本壳只负责分栏与面包屑。
 * - 面包屑由 usePathname() 真实路由派生：`系统管理 › <当前子项>`；
 *   /system 本体不渲染——落地页是服务端 redirect 到第一项，不会停留。
 * - 窄屏（<=1023px）：分栏转纵向，侧栏变为顶部横向 pill 行，内容区不被挤压裁剪。
 * - 铁律（T15）：无 fixed / 100vh / 100vw；flex 布局。
 */
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { CSSProperties } from "react";
import { neutral, space, fontSize, fontFamily } from "@/src/theme/tokens";
import { SystemSidebar, systemCrumbLabel } from "@/src/components/layout/system-sidebar";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

const layoutCss = `
.syslayout-wrap { display: flex; flex: 1; min-height: 0; flex-direction: row; }
@media (max-width: 1023px) {
  .syslayout-wrap { flex-direction: column !important; }
  .syslayout-content { min-width: 0; width: 100%; }
}
`;

export default function SystemLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const crumb = systemCrumbLabel(pathname);

  return (
    <>
      <style>{layoutCss}</style>
      <div data-testid="system-section" className="syslayout-wrap" style={baseFont}>
        <SystemSidebar />
        <div
          data-testid="system-content"
          className="syslayout-content"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "auto",
          }}
        >
          <div
            data-testid="system-breadcrumb"
            aria-label="面包屑导航"
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.md}px ${space.xl}px 0`,
              fontSize: fontSize.sm,
              color: neutral[500],
            }}
          >
            <span>系统管理</span>
            {crumb && (
              <>
                <span aria-hidden style={{ color: neutral[300] }}>
                  ›
                </span>
                <span data-testid="system-breadcrumb-current" style={{ color: neutral[900], fontWeight: 600 }}>
                  {crumb}
                </span>
              </>
            )}
          </div>
          {children}
        </div>
      </div>
    </>
  );
}
