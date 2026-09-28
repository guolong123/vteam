/**
 * MsgThinking：思考中消息（reasoning part，FR-18 内部过程折叠展示）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - state=pending：思考中（三连点 + 「思考中…」，不可折叠）
 * - state=done：已完成，默认折叠（「已思考 · 点击展开 ▸」），点击展开/收起
 * data-testid=msg-thinking；身份（B1）：头像/作者/时间统一由 MsgParts 共享身份栏渲染，
 * 本组件只留过程内容（状态 + 摘录 + 展开正文）。token 引用统一走 src/theme/tokens.ts。
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
import { LoadingDots } from "./loading-indicator";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 思考密度阈值（A3）：折叠摘录 200 字符；展开态与 title 最多 2000 字符进入 DOM。 */
export const THINKING_EXCERPT_CHARS = 200;
export const THINKING_MAX_CHARS = 2000;

export interface MsgThinkingProps {
  state: "pending" | "done";
  text: string;
  style?: CSSProperties;
  className?: string;
}

/** 思考中消息（reasoning 阶段）：pending=思考中带动画 / done=可折叠（单行缩略 + 思考摘要，点击展开） */
export function MsgThinking({ state, text, style, className }: MsgThinkingProps) {
  const [open, setOpen] = useState(state === "done" ? false : true);
  const pending = state === "pending";
  // 折叠态单行缩略：空白归一后取前 200 字符（无内容时仅显示"已思考"）；
  // 展开正文与 title 统一截到前 2000 字符——第 2001 字符起不进入 DOM，不追加省略号。
  const normalized = pending ? "" : text.replace(/\s+/g, " ").trim();
  const excerpt = normalized.slice(0, THINKING_EXCERPT_CHARS);
  const detail = text.slice(0, THINKING_MAX_CHARS);
  return (
    <div
      data-testid="msg-thinking"
      data-state={state}
      className={className}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: space.sm,
        maxWidth: "78%",
        ...baseFont,
        ...style,
      }}
    >
      <button
        type="button"
        aria-expanded={state === "done" ? open : undefined}
        disabled={pending}
        onClick={() => setOpen(!open)}
        style={{
          flex: 1,
          minWidth: 0,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[100],
          border: `1px dashed ${neutral[300]}`,
          cursor: pending ? "default" : "pointer",
          transition: "border-color .15s ease",
          textAlign: "left",
          fontFamily: fontFamily.body,
          fontSize: fontSize.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginBottom: open ? space.xs : 0, minWidth: 0 }}>
          {pending ? (
            <LoadingDots color={neutral[400]} />
          ) : (
            <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1, flexShrink: 0 }}>
              💭
            </span>
          )}
          {pending && (
            <span
              style={{
                fontSize: fontSize.sm,
                color: neutral[500],
                fontWeight: 500,
                fontStyle: "italic",
                flexShrink: 0,
              }}
            >
              思考中…
            </span>
          )}
          {!pending && excerpt && (
            <span
              title={detail}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: fontSize.xs,
                color: neutral[400],
                fontStyle: "italic",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {excerpt}
            </span>
          )}
          {!pending && (
            <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto", flexShrink: 0 }} aria-hidden>
              {open ? "▾ 收起" : "已思考 · 点击展开 ▸"}
            </span>
          )}
        </div>
        {(open || pending) && (
          <div
            data-testid="msg-thinking-detail"
            style={{
              fontSize: fontSize.md,
              color: pending ? neutral[400] : neutral[600],
              fontStyle: "italic",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {pending ? detail : text.trim() ? detail : "（无详细思考内容）"}
          </div>
        )}
      </button>
    </div>
  );
}
