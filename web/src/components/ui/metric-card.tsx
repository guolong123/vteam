"use client";

/**
 * MetricCard：KPI 指标卡的唯一规格
 * =============================================
 * 背景（视觉优化清单 AES-12）：同类「标签 + 数字」卡片此前有两种尺寸 ——
 *   成员库 291×95（pad 17/13、带副标题）
 *   Worker / 用户管理 261×56（更扁、无副标题）
 * 视觉重量差一倍，扫读时对不齐。
 *
 * 统一规格：高 76、内边距 16/14、数字 24px/700、标签 12px、副标题 11px。
 * 两种排布：
 * - 竖排（默认）：标签在上、数字在下、副标题在底 —— 适合宽度充裕的 4 列网格
 * - 横排（layout="inline"）：标签在左、数字在右 —— 适合窄卡片或强调数字的统计条
 */
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  /** 副标题（口径说明），11px 弱化 */
  hint?: string;
  /** 数值颜色（缺省 neutral[900]）；语义色卡片传 var(--color-*) */
  valueColor?: string;
  /** 标签左侧的语义圆点颜色 */
  dotColor?: string;
  /** 布局：stacked 竖排（默认）/ inline 横排 */
  layout?: "stacked" | "inline";
  testid?: string;
  /** 附加 data-*（如 data-stat，保持既有 e2e/埋点选择器可用） */
  dataAttrs?: Record<string, string | undefined>;
  style?: CSSProperties;
}

export function MetricCard({
  label,
  value,
  hint,
  valueColor,
  dotColor,
  layout = "stacked",
  testid,
  dataAttrs,
  style,
}: MetricCardProps) {
  const inline = layout === "inline";
  return (
    <div
      data-testid={testid}
      {...(dataAttrs ?? {})}
      style={{
        display: "flex",
        flexDirection: inline ? "row" : "column",
        alignItems: inline ? "center" : "flex-start",
        justifyContent: inline ? "space-between" : "flex-start",
        gap: inline ? space.md : 2,
        minHeight: 76,
        padding: `${space.lg}px 14px`,
        borderRadius: radius.lg,
        backgroundColor: "var(--color-surface)",
        border: `1px solid ${neutral[200]}`,
        boxShadow: shadow.sm,
        fontFamily: fontFamily.body,
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
        {dotColor && (
          <span
            aria-hidden
            style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, backgroundColor: dotColor }}
          />
        )}
        <span
          style={{
            fontSize: fontSize.sm,
            color: neutral[500],
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          lineHeight: 1.1,
          color: valueColor ?? neutral[900],
          fontVariantNumeric: "tabular-nums",
          marginLeft: inline ? "auto" : undefined,
        }}
      >
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.5 }}>{hint}</div>
      )}
    </div>
  );
}
