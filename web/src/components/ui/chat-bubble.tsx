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

/** UX-10 附件元数据（后端 toMessageDto 附件三字段 + POST /uploads 响应 size）。 */
export interface ChatBubbleAttachment {
  url: string;
  name: string;
  size?: number;
  ext: string;
}

export interface ChatBubbleProps {
  text: string;
  type?: ChatMessageType;
  /** 发送人（agent / system 消息展示） */
  author?: string;
  /** 发送人角色（agent 消息展示角色色） */
  role?: RoleKey;
  /** 可选时间戳 */
  time?: string;
  /** UX-10 附件：图片内嵌预览（attachment-image）/ 文件下载链接（attachment-file） */
  attachment?: ChatBubbleAttachment;
  style?: CSSProperties;
  className?: string;
}

/** 图片附件判定：扩展名 ∈ 浏览器可内嵌渲染的图片集（其余走文件下载）。 */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif"];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatBubble({
  text,
  type = "agent",
  author,
  role,
  time,
  attachment,
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
  const hasText = text.trim().length > 0;
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
        {hasText && (
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
        )}
        {attachment && (
          <AttachmentCard attachment={attachment} isUser={isUser} />
        )}
      </div>
    </div>
  );
}

/** 附件卡片：图片内嵌预览（attachment-image）/ 文件下载链接（attachment-file），包 message-attachment。 */
function AttachmentCard({
  attachment,
  isUser,
}: {
  attachment: ChatBubbleAttachment;
  isUser: boolean;
}) {
  const isImage = (IMAGE_EXTS as readonly string[]).includes(
    attachment.ext.toLowerCase(),
  );
  return (
    <div
      data-testid="message-attachment"
      style={{
        marginTop: space.sm,
        borderRadius: radius.md,
        overflow: "hidden",
        backgroundColor: isUser ? "rgba(255,255,255,0.12)" : neutral[50],
        border: isUser ? "none" : `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {isImage ? (
        <img
          data-testid="attachment-image"
          src={attachment.url}
          alt={attachment.name}
          style={{
            display: "block",
            width: "100%",
            maxHeight: 280,
            objectFit: "cover",
            borderRadius: radius.md,
          }}
        />
      ) : (
        <a
          data-testid="attachment-file"
          href={attachment.url}
          download={attachment.name}
          target="_blank"
          rel="noopener noreferrer"
          title={attachment.name}
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.sm}px ${space.md}px`,
            color: isUser ? "#FFFFFF" : "#2563EB",
            fontSize: fontSize.sm,
            fontWeight: 500,
            textDecoration: "none",
            wordBreak: "break-all",
          }}
        >
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: radius.sm,
              backgroundColor: isUser ? "rgba(255,255,255,0.2)" : "#DBEAFE",
              color: "#2563EB",
              fontSize: fontSize.xs,
              fontWeight: 600,
            }}
          >
            {attachment.ext.slice(0, 3).toUpperCase()}
          </span>
          <span style={{ minWidth: 0 }}>
            <span
              style={{
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                lineHeight: 1.4,
              }}
            >
              {attachment.name}
            </span>
            {typeof attachment.size === "number" && (
              <span
                style={{
                  display: "block",
                  fontSize: fontSize.xs,
                  color: isUser ? "rgba(255,255,255,0.75)" : neutral[400],
                  lineHeight: 1.4,
                }}
              >
                {formatFileSize(attachment.size)}
              </span>
            )}
          </span>
        </a>
      )}
    </div>
  );
}