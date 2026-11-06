"use client";

/**
 * PageWindow：资源管理页统一窗口容器（与 skills/issues/models 页一致）。
 * =============================================================
 * - 外层 main：内容区内边距（padding xl），flex 纵向；
 * - 内层 div：maxWidth 1080 居中 + 纵向 gap lg，窄屏自动占满（width 100%）。
 * - 聊天/看板等全高工作区页面不使用本组件（保持全屏）。
 * - token 引用统一走 src/theme/tokens.ts，不散落魔法值。
 */
import type { CSSProperties, ReactNode } from "react";
import { space } from "@/src/theme/tokens";

export interface PageWindowProps {
  children: ReactNode;
  /** 内容最大宽度（缺省 1080，对齐既有窗口页）。 */
  maxWidth?: number;
  /** 子区块纵向间距（缺省 space.lg；工作区页可收紧以让正文占更多高度）。 */
  gap?: number;
  /**
   * 撑满可用高度（缺省 false，既有页行为不变）。
   * 开启后 main 变成纵向 flex、内层 div `flex:1`，子级就能用 `flex:1/minHeight:0`
   * 铺满——工作区页（文档站等）靠它摆脱 `calc(100vh - Npx)` 这类写死高度。
   */
  fill?: boolean;
  /** 全宽模式：内层不限宽、不居中（docs 站等工作区页用；缺省 false，既有页行为不变）。 */
  fluid?: boolean;
  /** 根节点 testid（缺省 page-window；替换旧根容器时透传原 testid，保 e2e 不变）。 */
  testId?: string;
  style?: CSSProperties;
  className?: string;
}

export function PageWindow({ children, maxWidth = 1080, fluid = false, gap = space.lg, fill = false, testId = "page-window", style, className }: PageWindowProps) {
  return (
    <main
      data-testid={testId}
      className={className}
      style={{
        flex: 1,
        minHeight: 0,
        padding: `${space.xl}px`,
        ...(fill ? { display: "flex", flexDirection: "column" as const } : {}),
        ...style,
      }}
    >
      <div
        style={{
          ...(fluid ? { maxWidth: "none", margin: 0 } : { maxWidth, margin: "0 auto" }),
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap,
          ...(fill ? { flex: 1, minHeight: 0 } : {}),
        }}
      >
        {children}
      </div>
    </main>
  );
}
