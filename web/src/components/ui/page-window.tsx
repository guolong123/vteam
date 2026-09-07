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
  /** 根节点 testid（缺省 page-window；替换旧根容器时透传原 testid，保 e2e 不变）。 */
  testId?: string;
  style?: CSSProperties;
  className?: string;
}

export function PageWindow({ children, maxWidth = 1080, testId = "page-window", style, className }: PageWindowProps) {
  return (
    <main data-testid={testId} className={className} style={{ flex: 1, minHeight: 0, padding: `${space.xl}px`, ...style }}>
      <div
        style={{
          maxWidth,
          margin: "0 auto",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
        }}
      >
        {children}
      </div>
    </main>
  );
}
