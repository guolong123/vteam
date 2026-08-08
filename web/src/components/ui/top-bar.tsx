/**
 * TopBar：顶部栏（页面标题 + 用户信息占位）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 */
import type { CSSProperties } from "react";
import {
  neutral,
  space,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface TopBarProps {
  title?: string;
  subtitle?: string;
  userName?: string;
  userRole?: string;
  style?: CSSProperties;
  className?: string;
}

export function TopBar({
  title = "任务看板",
  subtitle,
  userName = "运营者",
  userRole = "项目管理员",
  style,
  className,
}: TopBarProps) {
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
        padding: `0 ${space.xl}px`,
        backgroundColor: "#FFFFFF",
        borderBottom: `1px solid ${neutral[200]}`,
        ...baseFont,
        ...style,
      }}
    >
      <div>
        <div
          style={{
            fontSize: fontSize.lg,
            fontWeight: 600,
            color: neutral[900],
            lineHeight: 1.3,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: 1 }}>
            {subtitle}
          </div>
        )}
      </div>

      {/* 用户信息占位 */}
      <div
        data-testid="topbar-user"
        style={{ display: "flex", alignItems: "center", gap: space.sm }}
      >
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 500 }}>
            {userName}
          </div>
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
          }}
        >
          {initials}
        </span>
      </div>
    </header>
  );
}