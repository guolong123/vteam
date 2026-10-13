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
import { useEffect, useRef, useState } from "react";
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

/**
 * 折叠摘录的跑马灯 keyframes（溢出时向左滚动展示）。
 * 位移量经 CSS 变量 --thinking-marquee-shift 注入（JS 实测 文本宽-视口宽），
 * 速度按 ~70px/s 折算 duration，长短文本观感一致；alternate 双向滚动避免
 * 循环跳变的撕裂感，展开态/未溢出不挂动画。
 */
const MARQUEE_KEYFRAMES = `
@keyframes msg-thinking-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(calc(-1 * var(--thinking-marquee-shift, 0px))); }
}
.msg-thinking-marquee {
  animation-name: msg-thinking-marquee;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
  animation-direction: alternate;
}
@media (prefers-reduced-motion: reduce) {
  .msg-thinking-marquee { animation: none; }
}
`;

const MARQUEE_PX_PER_SECOND = 70;

/** keyframes 一次性注入 document.head（模块级 guard：整页只插一个 style 标签）。 */
let marqueeStyleInjected = false;
function ensureMarqueeStyle(): void {
  if (marqueeStyleInjected || typeof document === "undefined") {
    return;
  }
  const el = document.createElement("style");
  el.textContent = MARQUEE_KEYFRAMES;
  document.head.appendChild(el);
  marqueeStyleInjected = true;
}

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
  // 折叠摘录跑马灯：溢出量实测（文本宽 - 视口宽），随摘录内容/容器宽度/展开态重测。
  // 展开态不滚（正文已在下方全量展示，避免双份动态噪音）；未溢出不挂动画。
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [marqueeShift, setMarqueeShift] = useState(0);
  useEffect(() => {
    ensureMarqueeStyle();
    const measure = (): void => {
      const viewport = viewportRef.current;
      const inner = textRef.current;
      if (!viewport || !inner) {
        setMarqueeShift(0);
        return;
      }
      const shift = inner.scrollWidth - viewport.clientWidth;
      setMarqueeShift(shift > 1 ? shift : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [excerpt, open]);
  const marqueeActive = marqueeShift > 0 && !open;
  const marqueeSeconds = Math.max(
    4,
    Math.round(marqueeShift / MARQUEE_PX_PER_SECOND),
  );
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
              ref={viewportRef}
              title={detail}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                position: "relative",
                fontSize: fontSize.xs,
                color: neutral[400],
                fontStyle: "italic",
              }}
            >
              <span
                ref={textRef}
                className={marqueeActive ? "msg-thinking-marquee" : undefined}
                style={
                  marqueeActive
                    ? {
                        display: "inline-block",
                        whiteSpace: "nowrap",
                        // 位移量/时长由实测溢出量注入：匀速观感 + alternate 回滚
                        ["--thinking-marquee-shift" as string]: `${marqueeShift}px`,
                        animationDuration: `${marqueeSeconds}s`,
                      }
                    : {
                        display: "inline-block",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: "100%",
                      }
                }
              >
                {excerpt}
              </span>
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
