/**
 * MsgError：错误消息（消息级 error，FR-21 三层错误中的第二层）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - kind=retry：模型繁忙（APIError isRetryable:true → 琥珀重试中，RetryPart attempt）
 * - kind=quota：余额不足（insufficient_quota isRetryable:false → 红色升级引导）
 * data-testid=msg-error（+ quota 分支操作链接 msg-error-action，对齐 dm-chat 原型 :386），
 * 身份（B1）：头像/作者统一由 MsgParts 共享身份栏渲染，本组件只留错误内容与可选时间。
 * B11：detail 超过 HIGH_PRIORITY_DETAIL_COLLAPSE_CHARS 时标题降为 headChars 头部，
 * 完整 detail 落进默认展开的 msg-error-detail 区；收起只摘该区，标题/状态/
 * retry·quota 操作控件永远在 DOM 里。token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import { useState } from "react";
import type { CSSProperties } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import {
  HIGH_PRIORITY_DETAIL_COLLAPSE_CHARS,
  HIGH_PRIORITY_TITLE_HEAD_CHARS,
  headChars,
} from "@/src/components/ui/collapse-policy";
import { LoadingDots } from "./loading-indicator";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 错误语义色：模型繁忙=琥珀（可重试）/ 余额不足=红（不可重试，需升级）/ 执行失败=红（通用，如模型连不上/首字超时） */
const errorTheme = {
  retry: { color: "#B45309", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
  quota: { color: "#B91C1C", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
  failed: { color: "#B91C1C", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
} as const;

export interface MsgErrorProps {
  kind: "retry" | "quota" | "failed";
  detail: string;
  attempt?: number;
  /** 独立状态行（session 页 errorLabel）自带的时间；消息内由共享身份栏出时间，MsgParts 不传 */
  time?: string;
  style?: CSSProperties;
  className?: string;
}

/** 错误消息（消息级 error）：retry=模型繁忙琥珀重试中（RetryPart attempt）/ quota=余额不足红色升级引导 */
export function MsgError({ kind, detail, attempt, time, style, className }: MsgErrorProps) {
  const theme = errorTheme[kind];
  const isRetry = kind === "retry";
  const overlong = detail.length > HIGH_PRIORITY_DETAIL_COLLAPSE_CHARS;
  const [detailOpen, setDetailOpen] = useState(true);
  const title = overlong ? headChars(detail, HIGH_PRIORITY_TITLE_HEAD_CHARS) : detail;
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
          <span data-testid="msg-error-title" style={{ fontSize: fontSize.md, color: theme.color, fontWeight: 600 }}>
            {title}
          </span>
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
        {overlong && (
          <button
            type="button"
            data-testid="msg-error-detail-toggle"
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((v) => !v)}
            style={{
              marginTop: space.sm,
              padding: 0,
              border: "none",
              background: "none",
              color: theme.color,
              fontSize: fontSize.xs,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: fontFamily.body,
              textDecoration: "underline",
            }}
          >
            {detailOpen ? "收起详情 ▾" : "展开详情 ▸"}
          </button>
        )}
        {overlong && detailOpen && (
          <div
            data-testid="msg-error-detail"
            style={{
              marginTop: space.sm,
              fontSize: fontSize.xs,
              color: theme.color,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {detail}
          </div>
        )}
        {isRetry ? (
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
            <LoadingDots color={theme.color} />
            <span style={{ fontSize: fontSize.xs, color: theme.color }}>
              APIError · isRetryable · 稍后自动重试
            </span>
          </div>
        ) : kind === "failed" ? (
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
            <span style={{ fontSize: fontSize.xs, color: theme.color }}>执行失败 · 可重新发送消息触发重试</span>
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
        {time && (
          <div style={{ fontSize: fontSize.xs, color: neutral[400], marginTop: space.sm }}>· {time}</div>
        )}
      </div>
    </div>
  );
}
