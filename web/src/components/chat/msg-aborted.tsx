/**
 * MsgAborted：中断消息（MessageAbortedError → 灰「已中断」，区别于错误）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - 居中灰条「▮▮ 已中断」+ 中断说明（author 的处理被用户中断）
 * - FR-21 用户中断不可重试，区别于错误（MsgError）
 * data-testid=msg-aborted，token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import type { CSSProperties } from "react";
import {
  type RoleKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";
import { AgentAvatar } from "@/src/components/ui";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface MsgAbortedProps {
  author: string;
  role: RoleKey;
  detail: string;
  time?: string;
  style?: CSSProperties;
  className?: string;
}

/** 中断消息（MessageAbortedError）：灰「已中断」，区别于错误 */
export function MsgAborted({ author, role, detail, time, style, className }: MsgAbortedProps) {
  return (
    <div
      data-testid="msg-aborted"
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        ...baseFont,
        ...style,
      }}
    >
      <AgentAvatar role={role} size="sm" dot={false} />
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: space.xs,
          padding: `${space.xs}px ${space.md}px`,
          borderRadius: radius.pill,
          backgroundColor: neutral[200],
          color: neutral[600],
          fontSize: fontSize.sm,
          fontWeight: 500,
        }}
      >
        ▮▮ 已中断
      </span>
      <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
        {author} 的处理被用户中断{time ? ` · ${time}` : ""} — {detail}
      </span>
    </div>
  );
}
