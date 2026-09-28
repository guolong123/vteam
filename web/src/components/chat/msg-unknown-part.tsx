/**
 * MsgUnknownPart：未知/未处理 part 的低噪音诊断行（B6）
 * =============================================
 * step-start / step-finish / patch 等前端未建模片段此前在 MsgParts 分发末尾被
 * `return null` 静默丢弃；本组件改为默认收起的一行诊断：
 * - 折叠态只渲染类型标签与展开提示，payload 一个字符都不进 DOM；
 * - 展开态渲染受 UNKNOWN_PART_SUMMARY_MAX_CHARS 封顶的 JSON 摘要，
 *   第 401 字符起不进 DOM，绝不原样倾倒未截断的 payload；
 * - 类型名经 safePartType 清洗（仅 [A-Za-z0-9_.:-]、≤32 字符），可见标签与
 *   data-part-type 共用同一安全值，恶意 type 串无法产生标记或属性注入。
 * data-testid=msg-unknown-part（折叠开关 button[aria-expanded]）、
 * msg-unknown-part-summary（展开摘要）；身份（B1）与左缩进由 MsgParts 的共享身份栏
 * 与 secondaryRows 负责，本组件只渲染自身内容。token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import { useState } from "react";
import type { CSSProperties } from "react";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** JSON 摘要进入 DOM 的字符上限（B6 验收：超长 payload 必须有界）。 */
export const UNKNOWN_PART_SUMMARY_MAX_CHARS = 400;

/** 安全 part 类型名的字符上限。 */
export const UNKNOWN_PART_TYPE_MAX_CHARS = 32;

/** 类型名白名单：只保留标识符安全字符，尖括号/引号/等号/空白一律剔除。 */
const SAFE_TYPE_CHARS = /[^A-Za-z0-9_.:-]/g;

/** 把任意 part type 归一为可安全放进可见文本与 data-part-type 的标签。 */
export function safePartType(type: unknown): string {
  if (typeof type !== "string") {
    return "unknown";
  }
  const cleaned = type.replace(SAFE_TYPE_CHARS, "").slice(0, UNKNOWN_PART_TYPE_MAX_CHARS);
  return cleaned || "unknown";
}

/** JSON 序列化任意 part 并封顶：序列化失败有兜底，超长只留前 400 字符。 */
export function summarizeUnknownPart(part: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(part) ?? String(part);
  } catch {
    serialized = '{"error":"unserializable"}';
  }
  return serialized.length > UNKNOWN_PART_SUMMARY_MAX_CHARS
    ? serialized.slice(0, UNKNOWN_PART_SUMMARY_MAX_CHARS)
    : serialized;
}

export interface MsgUnknownPartProps {
  part: unknown;
  style?: CSSProperties;
  className?: string;
}

/** 未知 part 诊断行：默认收起的类型标签，点击展开受限 JSON 摘要。 */
export function MsgUnknownPart({ part, style, className }: MsgUnknownPartProps) {
  const [open, setOpen] = useState(false);
  const rawType =
    typeof part === "object" && part !== null ? (part as { type?: unknown }).type : undefined;
  const typeLabel = safePartType(rawType);
  const summary = open ? summarizeUnknownPart(part) : "";
  return (
    <div
      data-testid="msg-unknown-part"
      data-part-type={typeLabel}
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.xs,
        maxWidth: "78%",
        minWidth: 0,
        ...baseFont,
        ...style,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          minWidth: 0,
          padding: `${space.xs}px ${space.sm}px`,
          borderRadius: radius.md,
          backgroundColor: "transparent",
          border: `1px dashed ${neutral[200]}`,
          cursor: "pointer",
          textAlign: "left",
          fontFamily: fontFamily.body,
          fontSize: fontSize.xs,
          color: neutral[400],
        }}
      >
        <span aria-hidden style={{ flexShrink: 0, lineHeight: 1 }}>
          ⋯
        </span>
        <span
          style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          未知片段 · <span style={{ color: neutral[500] }}>{typeLabel}</span>
        </span>
        <span aria-hidden style={{ marginLeft: "auto", flexShrink: 0 }}>
          {open ? "▾ 收起" : "点击展开 ▸"}
        </span>
      </button>
      {open && (
        <pre
          data-testid="msg-unknown-part-summary"
          style={{
            margin: 0,
            padding: `${space.xs}px ${space.sm}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[50],
            border: `1px dashed ${neutral[200]}`,
            fontSize: fontSize.xs,
            color: neutral[500],
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
            ...baseFont,
          }}
        >
          {summary}
        </pre>
      )}
    </div>
  );
}
