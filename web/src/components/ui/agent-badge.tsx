/**
 * AgentBadge：角色标签（产品经理 / 架构师 / 开发者 / 测试）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 */
import type { CSSProperties } from "react";
import {
  type RoleKey,
  roles,
  roleText,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface AgentBadgeProps {
  role: RoleKey;
  /** 是否显示前置小圆点 */
  dot?: boolean;
  style?: CSSProperties;
  className?: string;
}

export function AgentBadge({ role, dot = true, style, className }: AgentBadgeProps) {
  // 防御：role 非法/缺失时兜底 developer 主题（roles[非法] undefined → theme.label 崩溃）
  const theme = roles[role] ?? roles.developer;
  return (
    <span
      data-testid="agent-badge"
      data-role={role}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs - 1}px ${space.sm}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: roleText[role],
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
        ...style,
      }}
    >
      {dot && (
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: theme.color,
            flexShrink: 0,
          }}
        />
      )}
      {theme.label}
    </span>
  );
}