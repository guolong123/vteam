/**
 * MsgThinking：思考中消息（reasoning part，FR-18 内部过程折叠展示）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - state=pending：思考中（三连点 + 「思考中…」，不可折叠）
 * - state=done：已完成，默认折叠（「已思考 · 点击展开 ▸」），点击展开/收起
 * data-testid=msg-thinking，token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import { useState } from "react";
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
import { LoadingDots } from "./loading-indicator";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface MsgThinkingProps {
  author: string;
  role: RoleKey;
  state: "pending" | "done";
  text: string;
  time?: string;
  style?: CSSProperties;
  className?: string;
}

/** 思考中消息（reasoning 阶段）：pending=思考中带动画 / done=可折叠（单行缩略 + 思考摘要，点击展开） */
export function MsgThinking({ author, role, state, text, time, style, className }: MsgThinkingProps) {
  const [open, setOpen] = useState(state === "done" ? false : true);
  const pending = state === "pending";
  // 折叠态单行缩略：取思考正文前 60 字（空白归一），无内容时仅显示"已思考"
  const excerpt = !pending
    ? text.replace(/\s+/g, " ").trim().slice(0, 60)
    : "";
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
      <AgentAvatar role={role} size="sm" dot={false} style={{ marginTop: 2 }} />
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen(!open);
        }}
        style={{
          flex: 1,
          minWidth: 0,
          padding: `${space.sm}px ${space.md}px`,
          borderRadius: radius.md,
          backgroundColor: neutral[100],
          border: `1px dashed ${neutral[300]}`,
          cursor: pending ? "default" : "pointer",
          transition: "border-color .15s ease",
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
          <span
            style={{
              fontSize: fontSize.sm,
              color: neutral[500],
              fontWeight: 500,
              fontStyle: "italic",
              flexShrink: 0,
            }}
          >
            {pending ? "思考中…" : author}
          </span>
          {!pending && excerpt && (
            <span
              title={text.trim()}
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
              {excerpt}{text.replace(/\s+/g, " ").trim().length > 60 ? "…" : ""}
            </span>
          )}
          {!pending && (
            <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto", flexShrink: 0 }} aria-hidden>
              {open ? "▾ 收起" : "已思考 · 点击展开 ▸"}
            </span>
          )}
          {time && <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: excerpt ? 0 : "auto", flexShrink: 0 }}>{time}</span>}
        </div>
        {(open || pending) && (
          <div
            style={{
              fontSize: fontSize.md,
              color: pending ? neutral[400] : neutral[600],
              fontStyle: "italic",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {pending ? text : text.trim() ? text : "（无详细思考内容）"}
          </div>
        )}
      </div>
    </div>
  );
}
