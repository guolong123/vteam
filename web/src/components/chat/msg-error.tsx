/**
 * MsgError：错误消息（消息级 error，FR-21 三层错误中的第二层）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - kind=retry：模型繁忙（APIError isRetryable:true → 琥珀重试中，RetryPart attempt）
 * - kind=quota：余额不足（insufficient_quota isRetryable:false → 红色升级引导）
 * data-testid=msg-error（+ quota 分支操作链接 msg-error-action，对齐 dm-chat 原型 :386），
 * token 引用统一走 src/theme/tokens.ts。
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
  shadow,
} from "@/src/theme/tokens";
import { AgentAvatar } from "@/src/components/ui";
import { LoadingDots } from "./loading-indicator";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 错误语义色：模型繁忙=琥珀（可重试）/ 余额不足=红（不可重试，需升级） */
const errorTheme = {
  retry: { color: "#B45309", bg: "#FFFBEB", border: "#FDE68A" },
  quota: { color: "#B91C1C", bg: "#FEF2F2", border: "#FECACA" },
} as const;

export interface MsgErrorProps {
  kind: "retry" | "quota";
  detail: string;
  author?: string;
  role?: RoleKey;
  attempt?: number;
  time?: string;
  style?: CSSProperties;
  className?: string;
}

/** 错误消息（消息级 error）：retry=模型繁忙琥珀重试中（RetryPart attempt）/ quota=余额不足红色升级引导 */
export function MsgError({ kind, author, role, detail, attempt, time, style, className }: MsgErrorProps) {
  const theme = errorTheme[kind];
  const isRetry = kind === "retry";
  return (
    <div
      data-testid="msg-error"
      data-kind={kind}
      className={className}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: space.sm,
        maxWidth: "78%",
        alignSelf: "flex-start",
        ...baseFont,
        ...style,
      }}
    >
      {role && <AgentAvatar role={role} size="sm" dot={false} style={{ marginTop: 2 }} />}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: theme.bg,
          border: `1px solid ${theme.border}`,
          boxShadow: shadow.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1, color: theme.color }}>
            {isRetry ? "⟳" : "⚠"}
          </span>
          <span style={{ fontSize: fontSize.md, color: theme.color, fontWeight: 600 }}>{detail}</span>
          {isRetry && (
            <span
              style={{
                fontSize: fontSize.xs,
                color: theme.color,
                marginLeft: "auto",
                whiteSpace: "nowrap",
              }}
            >
              RetryPart · attempt {attempt ?? 1}/3
            </span>
          )}
        </div>
        {isRetry ? (
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
            <LoadingDots color={theme.color} />
            <span style={{ fontSize: fontSize.xs, color: theme.color }}>
              APIError · isRetryable · 稍后自动重试
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
            <span style={{ fontSize: fontSize.xs, color: theme.color }}>insufficient_quota · 不可重试</span>
            <span
              role="link"
              data-testid="msg-error-action"
              aria-label="查看升级方案"
              style={{
                marginLeft: "auto",
                display: "inline-flex",
                alignItems: "center",
                gap: space.xs,
                padding: `${space.xs}px ${space.md}px`,
                borderRadius: radius.pill,
                backgroundColor: theme.color,
                color: "#FFFFFF",
                fontSize: fontSize.sm,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              查看升级方案 <span aria-hidden>→</span>
            </span>
          </div>
        )}
        <div style={{ fontSize: fontSize.xs, color: neutral[500], marginTop: space.sm }}>
          {author && <span>{author}</span>}
          {time ? <span style={{ color: neutral[400] }}> · {time}</span> : null}
        </div>
      </div>
    </div>
  );
}
