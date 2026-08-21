/**
 * Pagination：通用分页导航组件
 * =============================================
 * 纯展示型受控组件，用于列表分页导航。
 * 渲染格式：[‹ 上一页]  第 {page} / {totalPages} 页  [下一页 ›]
 *
 * - totalPages <= 1 时整体不渲染（返回 null）
 * - page <= 1 时上一页按钮 disabled；page >= totalPages 时下一页 disabled
 * - 禁用态使用 opacity 0.5 + cursor default
 * - 样式对齐现有 ui 组件（内联 style + design tokens）
 */
import type { CSSProperties } from "react";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

export interface PaginationProps {
  /** 当前页码（从 1 开始） */
  page: number;
  /** 总页数 */
  totalPages: number;
  /** 页码切换回调 */
  onPageChange: (page: number) => void;
  /** data-testid 前缀（可选，不传时容器不加 testid） */
  dataTestId?: string;
}

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

const btnStyle: CSSProperties = {
  padding: `${space.sm}px ${space.md}px`,
  borderRadius: radius.md,
  border: `1px solid ${neutral[200]}`,
  backgroundColor: "var(--color-surface)",
  color: neutral[600],
  fontSize: fontSize.sm,
  cursor: "pointer",
  ...baseFont,
};

const btnDisabledStyle: CSSProperties = {
  ...btnStyle,
  opacity: 0.5,
  cursor: "default",
};

export function Pagination({ page, totalPages, onPageChange, dataTestId }: PaginationProps) {
  if (totalPages <= 1) return null;

  const isPrevDisabled = page <= 1;
  const isNextDisabled = page >= totalPages;

  const handlePrev = () => {
    if (!isPrevDisabled) onPageChange(page - 1);
  };

  const handleNext = () => {
    if (!isNextDisabled) onPageChange(page + 1);
  };

  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      action();
    }
  };

  return (
    <div
      data-testid={dataTestId}
      role="navigation"
      aria-label="分页导航"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        ...baseFont,
      }}
    >
      <button
        type="button"
        data-testid={dataTestId ? `${dataTestId}-prev` : undefined}
        onClick={handlePrev}
        onKeyDown={(e) => handleKeyDown(e, handlePrev)}
        disabled={isPrevDisabled}
        style={isPrevDisabled ? btnDisabledStyle : btnStyle}
      >
        ‹ 上一页
      </button>

      <span
        style={{
          fontSize: fontSize.md,
          color: neutral[600],
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        第 {page} / {totalPages} 页
      </span>

      <button
        type="button"
        data-testid={dataTestId ? `${dataTestId}-next` : undefined}
        onClick={handleNext}
        onKeyDown={(e) => handleKeyDown(e, handleNext)}
        disabled={isNextDisabled}
        style={isNextDisabled ? btnDisabledStyle : btnStyle}
      >
        下一页 ›
      </button>
    </div>
  );
}
