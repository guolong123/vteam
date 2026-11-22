"use client";

/**
 * PanelGutter：面板边缘的「收起按钮 + 拖拽分隔条」复合控件
 * =====================================================================
 * 小屏适配（2026-11-18）的一条设计取舍：收起入口如果塞进面板头部，
 * 每个面板都要各自加一遍按钮（会话列表头、群信息头、任务面板头、外部用户面板头…），
 * 而且面板内容滚动时按钮会跟着滚走。改为挂在**面板边缘的分隔条上**：
 *
 * ```
 * │ ‹  ← 收起按钮（常驻在边缘，不随内容滚走）
 * │ ║  ← 下面是拖拽热区（9px 宽，触摸可拖、键盘可调）
 * ```
 *
 * 面板收起后由 `PanelExpandRail` 顶替，箭头方向翻转，点一下即可恢复。
 */
import { useState } from "react";
import { ResizeHandle } from "@/src/components/teams/ResizeHandle";
import type { ResizeStartEvent } from "@/src/hooks/use-resizable";
import { neutral, radius, fontSize, fontFamily } from "@/src/theme/tokens";

/** 收起按钮整块命中区（比图标大得多，手指也好点）。 */
const TOGGLE_W = 20;
const TOGGLE_H = 30;

/** 无障碍名：把「调整会话列表宽度」这类拖拽名换成「收起会话列表」。 */
function collapseLabelOf(label: string): string {
  return label.replace(/^调整/, "收起").replace(/宽度$/, "");
}

export function PanelGutter({
  side,
  label,
  width,
  onResizeStart,
  onNudge,
  onCollapse,
  testId,
}: {
  /** 面板在视口的哪一侧（决定收起箭头方向）。 */
  side: "left" | "right";
  /** 拖拽条的无障碍名称，如「调整会话列表宽度」。 */
  label: string;
  /** 当前宽度（aria-valuenow）。 */
  width: number;
  onResizeStart: (e: ResizeStartEvent) => void;
  /** 键盘 ←/→ 微调（正数=向右）。 */
  onNudge: (delta: number) => void;
  onCollapse: () => void;
  testId?: string;
}) {
  const [hover, setHover] = useState(false);
  const collapseLabel = collapseLabelOf(label);

  return (
    <div
      data-testid={testId}
      style={{
        width: TOGGLE_W,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        paddingTop: 6,
        paddingBottom: 6,
        backgroundColor: "var(--color-surface)",
      }}
    >
      <button
        type="button"
        data-testid={testId ? `${testId}-collapse` : undefined}
        data-collapsed="false"
        title={collapseLabel}
        aria-label={collapseLabel}
        aria-expanded={true}
        onClick={onCollapse}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: TOGGLE_W,
          height: TOGGLE_H,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          border: `1px solid ${hover ? "#0D9488" : neutral[200]}`,
          borderRadius: radius.sm,
          backgroundColor: hover ? "rgba(13,148,136,0.10)" : "var(--color-surface)",
          color: hover ? "var(--color-accent-text)" : neutral[500],
          fontSize: fontSize.md,
          lineHeight: 1,
          cursor: "pointer",
          fontFamily: fontFamily.body,
          transition: "background-color .15s ease, border-color .15s ease, color .15s ease",
        }}
      >
        <span aria-hidden>{side === "left" ? "‹" : "›"}</span>
      </button>
      <div style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center" }}>
        <ResizeHandle
          label={label}
          onResizeStart={onResizeStart}
          width={width}
          onKeyResize={onNudge}
        />
      </div>
    </div>
  );
}
