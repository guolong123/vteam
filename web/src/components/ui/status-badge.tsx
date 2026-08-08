/**
 * StatusBadge：任务状态徽章（进行中 / 待验收 / 已完成 / 已归档）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 */
import type { CSSProperties } from "react";
import {
  type StatusKey,
  statusColors,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface StatusBadgeProps {
  status: StatusKey;
  style?: CSSProperties;
  className?: string;
}

export function StatusBadge({ status, style, className }: StatusBadgeProps) {
  const theme = statusColors[status];
  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space.xs,
        padding: `${space.xs}px ${space.sm + 2}px`,
        borderRadius: radius.pill,
        backgroundColor: theme.bg,
        border: `1px solid ${theme.border}`,
        color: theme.color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        ...baseFont,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: theme.color,
          flexShrink: 0,
        }}
      />
      {status}
    </span>
  );
}