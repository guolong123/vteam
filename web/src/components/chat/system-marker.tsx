/**
 * SystemMarker：长 system 消息的折叠标记行
 * =============================================
 * 背景：平台会在任务状态机节点往会话写 `senderType=system` 的消息，例如任务启动时
 * 写进主 Agent 私聊频道的**任务 brief**：
 *
 * ```
 * 任务已启动，请作为主 Agent 牵头推进。任务目标：黑洞 3D 动画 HTML（WebGL 光追）
 * （交付单文件、离线可运行的…；写入 /data/vteam-worker/teams/tm_0000000002 并作为
 * 群聊附件交付。）
 * ```
 *
 * 这类文本有 200+ 字，按「消息气泡」铺开会变成一个巨大的灰块 —— 视觉权重比 agent
 * 的回复还高，用户反馈「显示效果比较丑」。
 *
 * 但它**本质是系统级时间线标记**，不是对话内容。所以：
 * - 折叠态：一行低对比居中标记（`—— 首句 · 08:41 ——`），几乎不占版面；
 * - 展开态：完整文本，仍是低对比的小字号（读者主动要看才给）。
 *
 * ## 为什么只处理「长文本」
 * 短的 system 消息（`任务已开始，主 Agent：xxx`、`成员已加入频道`）本来一行就够，
 * 套一层折叠反而多一次点击。故**短文本仍走原来的 `ChatBubble type="system"`**
 * （既有观感与 e2e 断言都不受影响），只有超阈值才用本组件。
 *
 * @module components/chat/system-marker
 */
"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { neutral, space, radius, messageFontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 超过这个字符数才折叠（短的 system 标记保持原样）。 */
export const SYSTEM_MARKER_COLLAPSE_THRESHOLD = 120;

/** 折叠态标题最多取多少个字符。 */
const HEADLINE_MAX_CHARS = 26;

/**
 * 从系统文案里取一行标题：截到第一个句号（`。`）或上限，
 * 保证折叠态是「任务已启动，请作为主 Agent 牵头推进」这种一眼可读的短语。
 */
export function systemHeadline(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const stop = clean.search(/[。！？；\n]/);
  const head = stop > 0 ? clean.slice(0, stop) : clean;
  return head.length > HEADLINE_MAX_CHARS ? `${head.slice(0, HEADLINE_MAX_CHARS)}…` : head;
}

export interface SystemMarkerProps {
  text: string;
  time?: string;
  style?: CSSProperties;
  className?: string;
}

/**
 * 长 system 消息的一行标记（点击展开全文）。
 */
export function SystemMarker({ text, time, style, className }: SystemMarkerProps) {
  const [expanded, setExpanded] = useState(false);
  const headline = systemHeadline(text);

  return (
    <div
      data-testid="system-marker"
      data-type="system"
      data-state={expanded ? "expanded" : "collapsed"}
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: space.xs,
        margin: `${space.xs}px ${space.sm}px`,
        minWidth: 0,
        ...baseFont,
        ...style,
      }}
    >
      <button
        type="button"
        data-testid="system-marker-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "inline-flex",
          alignItems: "baseline",
          gap: space.xs,
          maxWidth: "100%",
          minWidth: 0,
          padding: `${space.xs}px ${space.md}px`,
          border: "none",
          background: "transparent",
          borderRadius: radius.pill,
          cursor: "pointer",
          color: neutral[500],
          fontSize: messageFontSize.meta,
          lineHeight: 1.5,
          fontFamily: fontFamily.body,
        }}
      >
        {/* 左右破折号：表达「这是一条时间线标记」而不是一条发言 */}
        <span aria-hidden style={{ color: neutral[300] }}>——</span>
        <span style={{ minWidth: 0, overflowWrap: "break-word" }}>{headline}</span>
        {time ? (
          <span data-testid="system-marker-time" style={{ color: neutral[400] }}>
            · {time}
          </span>
        ) : null}
        <span
          aria-hidden
          style={{
            color: neutral[400],
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform 120ms ease",
          }}
        >
          ▾
        </span>
        <span aria-hidden style={{ color: neutral[300] }}>——</span>
      </button>
      {expanded ? (
        <div
          data-testid="system-marker-text"
          style={{
            maxWidth: "100%",
            minWidth: 0,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            border: `1px dashed ${neutral[200]}`,
            backgroundColor: neutral[100],
            color: neutral[500],
            fontSize: messageFontSize.meta,
            lineHeight: 1.6,
            textAlign: "left",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            ...baseFont,
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}
