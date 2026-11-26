/**
 * MsgThinking：思考中消息（reasoning part，FR-18 内部过程折叠展示）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - state=pending：思考中（三连点 + 「思考中…」+ **单行跑马灯**流式展示进行中推理，不可折叠、
 *   恒定单行；跑马灯文本直接展示归一化全文，溢出时按 token 增量速度滚动）。
 * - state=done：已完成，默认折叠成单行摘要，点击展开/收起。
 * data-testid=msg-thinking；pending 态无 msg-thinking-detail，仅 done+展开态才挂该节点。
 * 身份（B1）：头像/作者/时间统一由 MsgParts 共享身份栏渲染，
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
 * 速度按最近两次文本增量的实测像素/秒折算；停止增长时暂停，展开态/未溢出不挂动画。
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

const DEFAULT_MARQUEE_PX_PER_SECOND = 70;
const MIN_MARQUEE_PX_PER_SECOND = 20;
const MAX_MARQUEE_PX_PER_SECOND = 2400;
const MARQUEE_STALL_MS = 600;

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
  const [open, setOpen] = useState(false);
  // 完成即自动折叠：用户展开过也不保留展开态（次要信息默认收起）。
  useEffect(() => {
    if (state === "done") setOpen(false);
  }, [state]);
  const pending = state === "pending";
  // 空白归一（与摘录同口径）：折叠摘录取前 200 字符；
  // pending 单行跑马灯取归一化全文的前 2000 字符（第 2001 字符起不进入 DOM，DOM 有界）；
  // 展开正文与 title 统一截到前 2000 字符——第 2001 字符起不进入 DOM，不追加省略号。
  const normalized = text.replace(/\s+/g, " ").trim();
  const excerpt = pending ? "" : normalized.slice(0, THINKING_EXCERPT_CHARS);
  const detail = text.slice(0, THINKING_MAX_CHARS);
  // 单行跑马灯文本目标：pending = 归一化全文前 2000 字符（随 delta 增长）；done = 折叠摘录（≤200）。
  const pendingMarqueeTarget = normalized.slice(0, THINKING_MAX_CHARS);
  const marqueeText = pending ? pendingMarqueeTarget : excerpt;
  // 多行正文只在 done+展开态存在：pending 恒定单行（不可折叠）。
  const bodyExpanded = open && !pending;
  // 跑马灯：溢出量实测（文本宽 - 视口宽），随跑马灯文本/容器宽度/展开态重测。
  // marqueeText 在 pending 下随 delta 增长，故测量 effect 依赖它 →
  // 文本一溢出即挂滚动动画。
  // done 展开态不滚（正文已在下方全量展示，避免双份动态噪音）；未溢出不挂动画。
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [marqueeShift, setMarqueeShift] = useState(0);
  const [marqueePxPerSecond, setMarqueePxPerSecond] = useState(0);
  const growthRef = useRef<{ length: number; at: number }>({ length: 0, at: 0 });
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

    if (!pending) {
      growthRef.current = { length: 0, at: 0 };
      setMarqueePxPerSecond(0);
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const now = performance.now();
    const previous = growthRef.current;
    let speed = 0;
    if (
      previous.at > 0 &&
      marqueeText.length > previous.length &&
      now > previous.at
    ) {
      const inner = textRef.current;
      const pxPerChar = inner && marqueeText.length > 0
        ? inner.scrollWidth / marqueeText.length
        : DEFAULT_MARQUEE_PX_PER_SECOND;
      const charsPerMs = (marqueeText.length - previous.length) / (now - previous.at);
      speed = Math.min(
        MAX_MARQUEE_PX_PER_SECOND,
        Math.max(MIN_MARQUEE_PX_PER_SECOND, charsPerMs * pxPerChar * 1000),
      );
    }
    growthRef.current = { length: marqueeText.length, at: now };
    setMarqueePxPerSecond(speed);
    // 一段时间没有新增 token 就暂停跑马灯，避免静态长文本慢悠悠地滚。
    const stallTimer = window.setTimeout(() => setMarqueePxPerSecond(0), MARQUEE_STALL_MS);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(stallTimer);
      window.removeEventListener("resize", measure);
    };
  }, [marqueeText, open, pending]);
  // 只有仍在生成且文本正在增长时才滚动；已完成/停滞的思考保持静态摘录。
  const marqueeActive = pending && marqueeShift > 0 && marqueePxPerSecond > 0;
  const marqueeSeconds = marqueePxPerSecond > 0
    ? Math.max(0.25, marqueeShift / marqueePxPerSecond)
    : 4;
  return (
    <div
      data-testid="msg-thinking"
      data-state={state}
      data-marquee-speed={pending ? Math.round(marqueePxPerSecond) : 0}
      className={className}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: space.sm,
        maxWidth: "100%",
        width: "100%",
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
          minHeight: 24,
          padding: `2px ${space.sm}px`,
          borderRadius: radius.sm,
          backgroundColor: "transparent",
          border: "none",
          cursor: pending ? "default" : "pointer",
          textAlign: "left",
          fontFamily: fontFamily.body,
          fontSize: fontSize.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginBottom: bodyExpanded ? space.xs : 0, minWidth: 0 }}>
          {pending ? (
            <LoadingDots color={neutral[400]} />
          ) : (
            <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1, flexShrink: 0, color: neutral[400] }}>
              ◦
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
          {marqueeText && (
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
                whiteSpace: pending ? "nowrap" : undefined,
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
                {marqueeText}
              </span>
            </span>
          )}
          {!pending && (
            <span style={{ fontSize: fontSize.xs, color: neutral[400], marginLeft: "auto", flexShrink: 0 }} aria-hidden>
              {open ? "▾ 收起" : "已思考 · 点击展开 ▸"}
            </span>
          )}
        </div>
        {bodyExpanded && (
          <div
            data-testid="msg-thinking-detail"
            style={{
              marginLeft: 22,
              paddingLeft: space.sm,
              borderLeft: `1px solid ${neutral[200]}`,
              fontSize: fontSize.md,
              color: neutral[600],
              fontStyle: "italic",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {text.trim() ? detail : "（无详细思考内容）"}
          </div>
        )}
      </button>
    </div>
  );
}
