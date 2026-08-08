/**
 * ChatBubble：消息气泡（user=右对齐蓝 / agent=左对齐白卡带角色 / system=居中灰）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 */
import type { CSSProperties } from "react";
import {
  type RoleKey,
  roles,
  roleText,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import { AgentAvatar } from "./agent-avatar";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export type ChatMessageType = "user" | "agent" | "system";

export interface ChatBubbleProps {
  text: string;
  type?: ChatMessageType;
  /** 发送人（agent / system 消息展示） */
  author?: string;
  /** 发送人角色（agent 消息展示角色色） */
  role?: RoleKey;
  /** 可选时间戳 */
  time?: string;
  style?: CSSProperties;
  className?: string;
}

export function ChatBubble({
  text,
  type = "agent",
  author,
  role,
  time,
  style,
  className,
}: ChatBubbleProps) {
  const isUser = type === "user";
  const isSystem = type === "system";
  const roleTheme = role ? roles[role] : null;

  // 气泡外壳：宽度自适应内容，总宽上限由根行容器 maxWidth 控制
  // （maxWidth 放 flex 列子项上会按内容宽解析，短文本被压成逐字换行）
  const bubbleBase: CSSProperties = {
    width: "fit-content",
    maxWidth: "100%",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.lg,
    fontSize: fontSize.md,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    ...baseFont,
  };

  if (isSystem) {
    return (
      <div
        data-testid="chat-bubble"
        data-type="system"
        className={className}
        style={{ display: "flex", justifyContent: "center", ...style }}
      >
        <div
          style={{
            ...bubbleBase,
            backgroundColor: neutral[100],
            color: neutral[500],
            fontSize: fontSize.sm,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.pill,
          }}
        >
          {text}
        </div>
      </div>
    );
  }

  const showHeader = !isUser && (author || roleTheme);
  return (
    <div
      data-testid="chat-bubble"
      data-type={type}
      className={className}
      style={{
        display: "flex",
        flexDirection: isUser ? "row-reverse" : "row",
        alignItems: "flex-start",
        gap: space.sm,
        justifyContent: isUser ? "flex-end" : "flex-start",
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "78%",
        minWidth: 0,
        ...style,
      }}
    >
      {!isUser && (
        <AgentAvatar role={role ?? "developer"} size="sm" dot={false} style={{ marginTop: 2 }} />
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: isUser ? "flex-end" : "flex-start",
          gap: space.xs,
          maxWidth: "100%",
          minWidth: 0,
        }}
      >
        {showHeader && (
          <span
            data-testid="chat-bubble-author"
            style={{
              fontSize: fontSize.xs,
              color: roleTheme ? roleText[role!] : neutral[400],
              fontWeight: 500,
              ...baseFont,
            }}
          >
            {author ?? roleTheme!.label}
            {time ? ` · ${time}` : ""}
          </span>
        )}
        <div
          style={
            isUser
              ? {
                  ...bubbleBase,
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  borderTopRightRadius: radius.sm,
                  boxShadow: shadow.sm,
                }
              : {
                  ...bubbleBase,
                  backgroundColor: "#FFFFFF",
                  color: neutral[800],
                  border: `1px solid ${neutral[200]}`,
                  borderTopLeftRadius: radius.sm,
                  boxShadow: shadow.sm,
                }
          }
        >
          {text}
        </div>
      </div>
    </div>
  );
}