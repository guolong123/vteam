/**
 * Sidebar：左侧导航（项目名 + 导航项）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 *
 * 注意：原型中 Sidebar 已被 _shared/nav.tsx 的 NavDock 取代（0 页面使用）。
 * 此处作为历史组件保留导出，不用于导航用途；新页面请使用 NavDock / NavTopBar。
 */
import type { CSSProperties } from "react";
import {
  space,
  radius,
  fontSize,
  fontFamily,
  sidebarTheme,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export type SidebarNavKey = "tasks" | "agents";

export interface SidebarProps {
  projectName?: string;
  active?: SidebarNavKey;
  onNavClick?: (key: SidebarNavKey) => void;
  style?: CSSProperties;
  className?: string;
}

const NAV_ITEMS: { key: SidebarNavKey; label: string; icon: string }[] = [
  { key: "tasks", label: "任务", icon: "▤" },
  { key: "agents", label: "Agent 管理", icon: "◉" },
];

export function Sidebar({
  projectName = "Agent 协作平台",
  active = "tasks",
  onNavClick,
  style,
  className,
}: SidebarProps) {
  return (
    <aside
      data-testid="sidebar"
      className={className}
      style={{
        width: 220,
        flexShrink: 0,
        height: "100%",
        backgroundColor: sidebarTheme.bg,
        color: sidebarTheme.text,
        display: "flex",
        flexDirection: "column",
        ...baseFont,
        ...style,
      }}
    >
      {/* 项目名 */}
      <div
        data-testid="sidebar-project"
        style={{
          padding: space.xl,
          borderBottom: `1px solid ${sidebarTheme.border}`,
        }}
      >
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: radius.md,
            background: "linear-gradient(135deg,#3B82F6,#8B5CF6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#FFFFFF",
            fontWeight: 700,
            fontSize: fontSize.lg,
            marginBottom: space.md,
          }}
        >
          A
        </div>
        <div
          style={{
            color: sidebarTheme.textActive,
            fontSize: fontSize.md,
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          {projectName}
        </div>
        <div style={{ fontSize: fontSize.xs, color: sidebarTheme.text, marginTop: 2 }}>
          智能体协作工作区
        </div>
      </div>

      {/* 导航项 */}
      <nav style={{ padding: space.md, display: "flex", flexDirection: "column", gap: space.xs }}>
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === active;
          return (
            <button
              key={item.key}
              type="button"
              data-testid={`sidebar-nav-${item.key}`}
              data-active={isActive ? "true" : "false"}
              onClick={onNavClick ? () => onNavClick(item.key) : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: space.sm + 2,
                padding: `${space.sm + 2}px ${space.md}px`,
                borderRadius: radius.md,
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                backgroundColor: isActive ? sidebarTheme.bgActive : "transparent",
                color: isActive ? sidebarTheme.textActive : sidebarTheme.text,
                fontSize: fontSize.md,
                fontWeight: isActive ? 600 : 400,
                transition: "background-color .15s ease",
                fontFamily: fontFamily.body,
              }}
            >
              <span style={{ fontSize: fontSize.lg, lineHeight: 1, opacity: 0.9 }} aria-hidden>
                {item.icon}
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* 底部占位 */}
      <div
        style={{
          marginTop: "auto",
          padding: space.lg,
          borderTop: `1px solid ${sidebarTheme.border}`,
          fontSize: fontSize.xs,
          color: sidebarTheme.text,
          lineHeight: 1.5,
        }}
      >
        4 个 Agent 在线
      </div>
    </aside>
  );
}