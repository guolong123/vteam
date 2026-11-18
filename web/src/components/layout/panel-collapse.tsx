"use client";

/**
 * PanelExpandRail：侧栏「收起后」的恢复入口
 * =====================================================================
 * 2026-11-18 小屏适配：会话页左右两侧面板原来都没有收起入口，小屏上中间聊天区
 * 被左右各 300px 挤成一条缝，用户明确要求「左右两侧工具栏要支持收起展示」。
 *
 * 两个角色：
 * - 面板**展开时**的收起按钮由 `PanelGutter`（边缘分隔条上的 ‹ / ›）承担，
 *   不放在面板头部——头部会随内容滚走，且每个面板都要各自加一遍；
 * - `PanelExpandRail`：面板**收起后**顶替它的窄条（含图标 + 竖排文字），
 *   点一下即恢复——收起永远不是单向的（这点在 docs 页文档树上已经踩过：
 *   收起后没有可见入口就等于把功能藏死了）。
 *
 * 方向语义：`side="left"` 收起时箭头向左（‹），恢复条贴在左缘；
 * `side="right"` 反之。两者都带 title/aria-label/aria-expanded。
 */
import type { CSSProperties } from "react";
import { neutral, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const RAIL_W = 34;

const baseBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${neutral[200]}`,
  background: "var(--color-surface)",
  color: neutral[500],
  borderRadius: radius.md,
  cursor: "pointer",
  fontFamily: fontFamily.body,
  lineHeight: 1,
  padding: 0,
};

/**
 * 收起态恢复条：竖排文字 + 箭头，整条都可点。
 * `height` 缺省铺满容器；给出时按固定高度贴顶（配合滚动容器）。
 */
export function PanelExpandRail({
  side,
  label,
  onExpand,
  testId,
  hint,
}: {
  side: "left" | "right";
  /** 无障碍名称，如「展开会话列表」。 */
  label: string;
  onExpand: () => void;
  testId?: string;
  /** 竖排提示文字（默认取 label 去掉「展开」后的部分）。 */
  hint?: string;
}) {
  return (
    <div
      data-testid={testId}
      data-collapsed="true"
      style={{
        width: RAIL_W,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 8,
        minHeight: 0,
        backgroundColor: "var(--color-surface)",
        borderRight: side === "left" ? `1px solid ${neutral[200]}` : undefined,
        borderLeft: side === "right" ? `1px solid ${neutral[200]}` : undefined,
      }}
    >
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={false}
        onClick={onExpand}
        style={{
          ...baseBtn,
          width: 26,
          height: 120,
          flexDirection: "column",
          gap: 4,
          fontSize: fontSize.md,
        }}
      >
        <span aria-hidden>{side === "left" ? "›" : "‹"}</span>
        <span
          aria-hidden
          style={{
            writingMode: "vertical-rl",
            fontSize: fontSize.xs,
            letterSpacing: 1,
            whiteSpace: "nowrap",
          }}
        >
          {hint ?? label}
        </span>
      </button>
    </div>
  );
}
