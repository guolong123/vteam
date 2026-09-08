"use client";

/**
 * SegmentedTabs：统一样式分段选择器（对齐 skills 页 manage-tabs）。
 * =============================================================
 * - 容器：圆角边框盒（neutral[100] 底 + neutral[200] 边），子项无缝切换；
 * - 选中项：surface 底 + 细阴影 + 900 文字；未选中：透明底 + 600 文字；
 * - 可选图标 + 计数徽标（选中蓝底徽标，未选中灰底）。
 * - testid 透传（缺省 manage-tabs/manage-tab + data-kind），保 e2e 不变。
 * - token 引用统一走 src/theme/tokens.ts，不散落魔法值。
 */
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

export interface SegmentTabItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** 计数徽标（undefined = 不展示）。 */
  count?: number;
}

export interface SegmentedTabsProps {
  items: SegmentTabItem[];
  active: string;
  onChange: (key: string) => void;
  testId?: string;
  optionTestId?: string;
  style?: CSSProperties;
  className?: string;
}

export function SegmentedTabs({
  items,
  active,
  onChange,
  testId = "manage-tabs",
  optionTestId = "manage-tab",
  style,
  className,
}: SegmentedTabsProps) {
  return (
    <div
      data-testid={testId}
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: space.xs,
        padding: space.xs,
        borderRadius: radius.lg,
        backgroundColor: neutral[100],
        border: `1px solid ${neutral[200]}`,
        ...style,
      }}
    >
      {items.map((t) => {
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            type="button"
            data-testid={optionTestId}
            data-kind={t.key}
            data-active={isActive ? "true" : "false"}
            onClick={() => onChange(t.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: space.sm,
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: isActive ? "var(--color-segment-active)" : "transparent",
              boxShadow: isActive ? shadow.sm : "none",
              cursor: "pointer",
              fontFamily: fontFamily.body,
              fontSize: fontSize.md,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? neutral[900] : neutral[600],
            }}
          >
            {t.icon !== undefined && (
              <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
                {t.icon}
              </span>
            )}
            {t.label}
            {t.count !== undefined && (
              <span
                aria-hidden
                style={{
                  fontSize: fontSize.xs,
                  color: isActive ? "#2563EB" : neutral[400],
                  backgroundColor: isActive ? "rgba(37,99,235,0.10)" : neutral[100],
                  padding: "0 7px",
                  borderRadius: radius.pill,
                  lineHeight: "16px",
                  fontFamily: fontFamily.mono,
                }}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
