/**
 * MsgTool：工具调用消息（tool part，工具卡片四态）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - 卡片含工具名 + 输入/输出摘要 + 状态徽章（运行中/成功/失败/等待填写敏感信息，
 *   失败=ToolStateError；第四态 awaiting-input 见 sensitive-command-tool todo 8）
 * - 失败时边框/输出文字用错误语义色（errorTheme.quota 红色系）；awaiting-input 用琥珀
 *   描边表示「等待用户动作」而非错误。
 * data-testid=msg-tool（data-status 四态）；awaiting-input 徽章额外带
 * data-testid=msg-tool-awaiting。身份（B1）：头像/作者/时间统一由 MsgParts 共享身份栏
 * 渲染，本卡片只留工具名、I/O 摘录与运行状态。token 引用统一走 src/theme/tokens.ts。
 * 安全边界：本组件只接收已脱敏的 input/output 文本——secret 值与渲染后命令从不进入
 * 这些 props（server/worker 契约保证），组件也不做任何拼接渲染。
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
import { LoadingDots } from "./loading-indicator";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 工具卡片状态四态（第四态 awaiting-input 由 MsgParts 按 pending secret_input 派生）。 */
export type MsgToolStatus = "running" | "success" | "failed" | "awaiting-input";

/** 工具状态色：运行中=蓝 / 成功=绿 / 失败=红 / 等待填写敏感信息=琥珀 */
const toolStatus: Record<
  MsgToolStatus,
  { label: string; color: string; bg: string; border: string }
> = {
  running: { label: "运行中", color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
  success: { label: "成功", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  failed: { label: "失败", color: "#B91C1C", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
  "awaiting-input": { label: "等待填写敏感信息", color: "#B45309", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.32)" },
};

export interface MsgToolProps {
  name: string;
  status: MsgToolStatus;
  input: string;
  output: string;
  style?: CSSProperties;
  className?: string;
}

/** 工具调用消息（tool part）：单行概要（名称 + 输入摘要 + 状态）+ 点击展开完整输入/输出 */
export function MsgTool({ name, status, input, output, style, className }: MsgToolProps) {
  const st = toolStatus[status];
  const failed = status === "failed";
  const awaiting = status === "awaiting-input";
  const [open, setOpen] = useState(false);
  const summary = input || output || "（无输入输出）";
  return (
    <div
      data-testid="msg-tool"
      data-status={status}
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
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          flex: 1,
          minWidth: 0,
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: "var(--color-surface)",
          border: `1px solid ${failed ? "rgba(239,68,68,0.22)" : awaiting ? "rgba(245,158,11,0.32)" : neutral[200]}`,
          boxShadow: shadow.sm,
          cursor: "pointer",
          transition: "border-color .15s ease",
          textAlign: "left",
          fontFamily: fontFamily.body,
          fontSize: fontSize.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, minWidth: 0 }}>
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1, flexShrink: 0 }}>
            {failed ? "✕" : awaiting ? "🔐" : "⚙"}
          </span>
          <span style={{ fontSize: fontSize.sm, color: neutral[700], fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>{name}</span>
          <span
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
          <span
            data-testid={awaiting ? "msg-tool-awaiting" : undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: space.xs,
              padding: `${space.xs - 1}px ${space.sm}px`,
              borderRadius: radius.pill,
              backgroundColor: st.bg,
              border: `1px solid ${st.border}`,
              color: st.color,
              fontSize: fontSize.xs,
              fontWeight: 600,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {status === "running" && <LoadingDots color={st.color} />}
            {st.label}
          </span>
          <span style={{ flexShrink: 0, fontSize: fontSize.xs, color: neutral[400] }} aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </div>
        {open && (
          <div
            data-testid="msg-tool-io"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              marginTop: space.sm,
              paddingTop: space.sm,
              borderTop: `1px solid ${neutral[100]}`,
              fontSize: fontSize.xs,
              color: neutral[500],
              lineHeight: 1.6,
            }}
          >
            <div style={{ display: "flex", gap: space.sm }}>
              <span style={{ color: neutral[400], flexShrink: 0 }}>输入</span>
              <span style={{ fontFamily: fontFamily.mono, wordBreak: "break-all" }}>{input}</span>
            </div>
            <div style={{ display: "flex", gap: space.sm }}>
              <span style={{ color: neutral[400], flexShrink: 0 }}>输出</span>
              <span style={{ wordBreak: "break-word", color: failed ? "#B91C1C" : neutral[600] }}>
                {output}
              </span>
            </div>
          </div>
        )}
      </button>
    </div>
  );
}
