/**
 * EmptyState：空状态占位（图标 + 标题 + 描述）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 */
import type { CSSProperties, ReactNode } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  testid?: string;
  style?: CSSProperties;
  className?: string;
}

export function EmptyState({
  title = "暂无数据",
  description = "当前还没有内容，稍后再来看看。",
  icon,
  action,
  testid,
  style,
  className,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testid ?? "empty-state"}
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: space.md,
        padding: `${space.xxl}px`,
        textAlign: "center",
        ...baseFont,
        ...style,
      }}
    >
      <div
        aria-hidden
        style={{
          width: 64,
          height: 64,
          borderRadius: radius.lg,
          backgroundColor: neutral[100],
          border: `1px dashed ${neutral[300]}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 26,
          color: neutral[500],
        }}
      >
        {icon ?? "◌"}
      </div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: neutral[800] }}>
          {title}
        </div>
        <div style={{ fontSize: fontSize.md, color: neutral[500], marginTop: space.xs, lineHeight: 1.6 }}>
          {description}
        </div>
      </div>
      {action}
    </div>
  );
}