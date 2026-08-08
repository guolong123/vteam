/**
 * MsgTool：工具调用消息（tool part，工具卡片三态）
 * =============================================
 * 从 docs/agent-platform/prototypes/group-chat/index.tsx 迁移：
 * - 卡片含工具名 + 输入/输出摘要 + 状态徽章（运行中/成功/失败，失败=ToolStateError）
 * - 失败时边框/输出文字用错误语义色（errorTheme.quota 红色系）
 * data-testid=msg-tool，token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import type { CSSProperties } from "react";
import {
  type RoleKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import { AgentAvatar } from "@/src/components/ui";
import { LoadingDots } from "./loading-indicator";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 工具状态色：运行中=蓝 / 成功=绿 / 失败=红 */
const toolStatus: Record<
  "running" | "success" | "failed",
  { label: string; color: string; bg: string; border: string }
> = {
  running: { label: "运行中", color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  success: { label: "成功", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  failed: { label: "失败", color: "#B91C1C", bg: "#FEF2F2", border: "#FECACA" },
};

export interface MsgToolProps {
  author: string;
  role: RoleKey;
  name: string;
  status: "running" | "success" | "failed";
  input: string;
  output: string;
  time?: string;
  style?: CSSProperties;
  className?: string;
}

/** 工具调用消息（tool part）：工具名 + 输入/输出摘要 + 状态（运行中/成功/失败，失败=ToolStateError） */
export function MsgTool({ author, role, name, status, input, output, time, style, className }: MsgToolProps) {
  const st = toolStatus[status];
  const failed = status === "failed";
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
      <AgentAvatar role={role} size="sm" dot={false} style={{ marginTop: 2 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          padding: space.md,
          borderRadius: radius.md,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${failed ? "#FECACA" : neutral[200]}`,
          boxShadow: shadow.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
          <span aria-hidden style={{ fontSize: fontSize.md, lineHeight: 1 }}>
            {failed ? "✕" : "⚙"}
          </span>
          <span style={{ fontSize: fontSize.md, color: neutral[700], fontWeight: 600 }}>{name}</span>
          <span
            style={{
              marginLeft: "auto",
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
            }}
          >
            {status === "running" && <LoadingDots color={st.color} />}
            {st.label}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            marginTop: space.sm,
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
        <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm }}>
          <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
            {author}
            {time ? ` · ${time}` : ""}
          </span>
          {failed && (
            <span style={{ fontSize: fontSize.xs, color: "#B91C1C", marginLeft: "auto" }}>
              ToolStateError
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
