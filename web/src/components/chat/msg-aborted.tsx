/**
 * MsgAborted：中断消息（MessageAbortedError → 灰「已中断」，区别于错误）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - 居中灰条「▮▮ 已中断」+ 中断说明（处理被用户中断的原因）
 * - FR-21 用户中断不可重试，区别于错误（MsgError）
 * data-testid=msg-aborted；身份（B1）：头像/作者/时间统一由 MsgParts 共享身份栏渲染，
 * 本组件只留中断 pill 与中断说明。B11：detail 超过 HIGH_PRIORITY_DETAIL_COLLAPSE_CHARS
 * 时摘要固定为「处理被用户中断」，完整 detail 落进默认展开的 msg-aborted-detail 区；
 * 收起只摘该区，pill 与摘要永远在 DOM 里。token 引用统一走 src/theme/tokens.ts。
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
} from "@/src/theme/tokens";
import { HIGH_PRIORITY_DETAIL_COLLAPSE_CHARS } from "@/src/components/ui/collapse-policy";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface MsgAbortedProps {
  detail: string;
  style?: CSSProperties;
  className?: string;
}

/** 中断消息（MessageAbortedError）：灰「已中断」，区别于错误 */
export function MsgAborted({ detail, style, className }: MsgAbortedProps) {
  const overlong = detail.length > HIGH_PRIORITY_DETAIL_COLLAPSE_CHARS;
  const [detailOpen, setDetailOpen] = useState(true);
  return (
    <div
      data-testid="msg-aborted"
      className={className}
      style={{
        display: "flex",
        flexDirection: overlong ? "column" : "row",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        ...baseFont,
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap", justifyContent: "center" }}>
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
          {overlong ? "处理被用户中断" : `处理被用户中断 — ${detail}`}
        </span>
        {overlong && (
          <button
            type="button"
            data-testid="msg-aborted-detail-toggle"
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((v) => !v)}
            style={{
              padding: 0,
              border: "none",
              background: "none",
              color: neutral[500],
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
      </div>
      {overlong && detailOpen && (
        <div
          data-testid="msg-aborted-detail"
          style={{
            maxWidth: "100%",
            fontSize: fontSize.xs,
            color: neutral[400],
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            textAlign: "center",
          }}
        >
          {detail}
        </div>
      )}
    </div>
  );
}
