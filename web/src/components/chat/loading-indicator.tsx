/**
 * LoadingIndicator：Agent 处理中指示器（FR-20 Loading 两阶段共用）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - LoadingDots：三连点弹跳 loading（思考中 / 工具运行中复用，chat-bounce 动画）
 * - LoadingIndicator：指示条（label + 三连点 + 可选时间），data-testid=loading-indicator
 * token 引用统一走 src/theme/tokens.ts；动画前缀 chat- 防污染其他页面。
 */
"use client";
import type { CSSProperties } from "react";
import { neutral, space, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** scoped CSS 动画（chat- 前缀防污染） */
const chatCss = `
@keyframes chat-bounce { 0%, 80%, 100% { transform: scale(.6); opacity: .45 } 40% { transform: scale(1); opacity: 1 } }
`;

export interface LoadingDotsProps {
  testid?: string;
  color?: string;
}

/** 三连点 loading（思考中 / Agent 处理中指示器） */
export function LoadingDots({
  testid = "loading-indicator",
  color = neutral[400],
}: LoadingDotsProps) {
  return (
    <span
      data-testid={testid}
      aria-hidden
      style={{ display: "inline-flex", gap: 4, lineHeight: 0 }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            backgroundColor: color,
            animation: "chat-bounce 1.1s ease-in-out infinite",
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </span>
  );
}

export interface LoadingIndicatorProps {
  /** 指示文案，如「测试 Agent 处理中」；展示为 `label…` */
  label: string;
  /** 可选时间戳 */
  time?: string;
  /**
   * 容器 testid（B12）：默认 `loading-indicator`；瞬态 session 状态行复用本容器时传
   * `session-status`，使两行共用同一容器实现（结构、样式、指示元素完全一致）。
   */
  testid?: string;
  /**
   * 三连点 testid（B12）：默认沿用 `loading-indicator`（既有定位契约）；复用容器时须显式传入
   * （如 `session-status-dots`），否则同页两行会各带一个同名 testid。
   */
  dotsTestId?: string;
  style?: CSSProperties;
  className?: string;
}

/** Agent 处理中指示条（对应 session.status busy / agent.loading） */
export function LoadingIndicator({
  label,
  time,
  testid = "loading-indicator",
  dotsTestId,
  style,
  className,
}: LoadingIndicatorProps) {
  return (
    <div
      data-testid={testid}
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        color: neutral[500],
        fontSize: fontSize.sm,
        padding: `${space.xs}px ${space.sm}px`,
        ...baseFont,
        ...style,
      }}
    >
      <style>{chatCss}</style>
      <LoadingDots testid={dotsTestId} />
      {label}…
      {time ? <span style={{ color: neutral[400], marginLeft: "auto" }}>{time}</span> : null}
    </div>
  );
}
