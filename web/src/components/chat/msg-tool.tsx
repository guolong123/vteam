/**
 * MsgTool：紧凑的工具过程行（opencode / DSH 风格）
 * =============================================
 * 默认只显示一行：状态 + 工具标题 + 参数摘要 + 输出行数；没有卡片底色、边框和阴影。
 * 点击后才在下方展开完整输入/输出，历史消息与流式消息使用同一套密度。
 *
 * data-testid=msg-tool（data-status 四态）；awaiting-input 额外带 msg-tool-awaiting。
 * 安全边界：本组件只接收已脱敏的 input/output 文本，不做任何拼接渲染。
 */
"use client";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";
import {
  summarizeToolInput,
  summarizeToolOutput,
  toolOutputLineCount,
  toolTitleOf,
} from "@/lib/tool-summary";
import { diffOfInput } from "@/lib/edit-diff";
import { viewKindOf } from "./dsh/dsh-tool-parse";
import { EditDiffView } from "./edit-diff-view";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 工具状态只保留语义色；成功态不展示徽章，避免每条工具都像一张卡。 */
const toolStatus: Record<
  "running" | "success" | "failed" | "awaiting-input",
  { label: string; color: string; symbol: string }
> = {
  running: { label: "运行中", color: "#0D9488", symbol: "●" },
  success: { label: "", color: neutral[400], symbol: "✓" },
  failed: { label: "失败", color: "var(--color-danger-text)", symbol: "×" },
  "awaiting-input": { label: "等待填写敏感信息", color: "var(--color-warn-text)", symbol: "!" },
};

export type MsgToolStatus = "running" | "success" | "failed" | "awaiting-input";

export interface MsgToolProps {
  name: string;
  status: MsgToolStatus;
  input: string;
  output: string;
  style?: CSSProperties;
  className?: string;
}

/** 单值 I/O 展开为值原文；多键 JSON 在展开区 pretty 化，折叠摘要不再回显整段 JSON。 */
function displayDetail(raw: string): string {
  const text = raw.trim();
  if (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") {
        if (!Array.isArray(parsed)) {
          const entries = Object.entries(parsed as Record<string, unknown>);
          if (
            entries.length === 1 &&
            (typeof entries[0][1] === "string" || typeof entries[0][1] === "number")
          ) {
            return String(entries[0][1]);
          }
        }
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      /* 非 JSON，按原文返回 */
    }
  }
  return raw;
}

function nonEmptyDetail(raw: string): string {
  const value = displayDetail(raw);
  const text = value.trim();
  return text === "{}" || text === "[]" ? "" : value;
}

export function MsgTool({ name, status, input, output, style, className }: MsgToolProps) {
  const st = toolStatus[status];
  const failed = status === "failed";
  const [open, setOpen] = useState(false);
  // 执行结束后自动收起，历史消息只保留一行摘要。
  useEffect(() => {
    if (status === "success" || status === "failed") setOpen(false);
  }, [status]);

  const title = toolTitleOf(name, input);
  const summary = summarizeToolInput(input) || summarizeToolOutput(output);
  const outputLines = toolOutputLineCount(output);
  const detailInput = nonEmptyDetail(input);
  const detailOutput = nonEmptyDetail(output);
  const editDiffs = useMemo(
    () => (viewKindOf(name, output) === "diff" ? diffOfInput(input) : null),
    [name, input, output],
  );
  const noIO = detailInput.length === 0 && detailOutput.length === 0;
  const detailFont: CSSProperties = {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.xs,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  };

  return (
    <div
      data-testid="msg-tool"
      data-status={status}
      data-tool={name}
      data-output-lines={outputLines}
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        width: "100%",
        minWidth: 0,
        ...baseFont,
        ...style,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: space.sm,
          width: "100%",
          minWidth: 0,
          minHeight: 24,
          padding: `2px ${space.sm}px`,
          borderRadius: radius.sm,
          backgroundColor: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          fontFamily: fontFamily.body,
          fontSize: fontSize.sm,
        }}
      >
        <span aria-hidden style={{ flexShrink: 0, fontSize: fontSize.xs, color: neutral[400] }}>
          {open ? "▾" : "▸"}
        </span>
        <span aria-hidden style={{ flexShrink: 0, fontSize: fontSize.xs, lineHeight: 1, color: st.color }}>
          {st.symbol}
        </span>
        <span
          title={name}
          style={{ flexShrink: 0, color: neutral[700], fontWeight: 600, whiteSpace: "nowrap" }}
        >
          {title}
        </span>
        {summary.length > 0 ? (
          <span
            data-testid="msg-tool-summary"
            title={summary}
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: fontFamily.mono,
              fontSize: fontSize.xs,
              color: neutral[500],
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {summary}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        {outputLines > 0 ? (
          <span
            data-testid="msg-tool-output-lines"
            style={{ flexShrink: 0, fontSize: fontSize.xs, color: neutral[400], whiteSpace: "nowrap" }}
          >
            {outputLines} 行输出
          </span>
        ) : null}
        {st.label.length > 0 ? (
          <span
            data-testid={status === "awaiting-input" ? "msg-tool-awaiting" : "msg-tool-status"}
            style={{
              flexShrink: 0,
              fontSize: fontSize.xs,
              color: st.color,
              whiteSpace: "nowrap",
            }}
          >
            {st.label}
          </span>
        ) : null}
      </button>
      {open && (
        <div
          data-testid="msg-tool-io"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            width: "calc(100% - 22px)",
            minWidth: 0,
            marginTop: space.xs,
            marginLeft: 22,
            paddingLeft: space.sm,
            borderLeft: `1px solid ${neutral[200]}`,
            fontSize: fontSize.xs,
            color: neutral[500],
            lineHeight: 1.6,
          }}
        >
          {editDiffs ? (
            <EditDiffView hunks={editDiffs} />
          ) : noIO ? (
            <span style={{ color: neutral[400] }}>（无输入输出）</span>
          ) : (
            <>
              {detailInput.length > 0 && (
                <div style={{ display: "flex", gap: space.sm, minWidth: 0 }}>
                  <span style={{ color: neutral[400], flexShrink: 0 }}>输入</span>
                  <pre style={{ margin: 0, flex: 1, minWidth: 0, ...detailFont }}>{detailInput}</pre>
                </div>
              )}
              <div style={{ display: "flex", gap: space.sm, minWidth: 0 }}>
                <span style={{ color: neutral[400], flexShrink: 0 }}>输出</span>
                <pre
                  style={{
                    margin: 0,
                    flex: 1,
                    minWidth: 0,
                    ...detailFont,
                    color: failed ? "var(--color-danger-text)" : neutral[600],
                  }}
                >
                  {detailOutput.length > 0 ? detailOutput : "（无输出）"}
                </pre>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
