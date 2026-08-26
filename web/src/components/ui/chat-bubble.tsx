"use client";

/**
 * ChatBubble：消息气泡（user=右对齐蓝 / agent=左对齐白卡带角色 / system=居中灰）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 */
import { useEffect, useState } from "react";
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
import { stripInjectedContext } from "@/lib/strip-injected-context";
import { Markdown } from "./markdown";

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
  author?: string;
  role?: RoleKey;
  time?: string;
  attachment?: ChatBubbleAttachment;
  isMentionMe?: boolean;
  /** 外部渠道消息：senderType==='external' 时展示“外部渠道”徽章 */
  senderType?: string;
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
  isMentionMe,
  senderType,
  style,
  className,
}: ChatBubbleProps) {
  const isUser = type === "user";
  const isSystem = type === "system";
  const roleTheme = role ? roles[role] : null;
  const [expanded, setExpanded] = useState(false);

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
          {stripInjectedContext(text)}
        </div>
      </div>
    );
  }

  const showHeader = !isUser && (author || roleTheme);
  const hasText = text.trim().length > 0;
  const CHAT_COLLAPSE_THRESHOLD = 360;
  const needsCollapse = hasText && text.length > CHAT_COLLAPSE_THRESHOLD;
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
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              flexWrap: "wrap",
              ...baseFont,
            }}
          >
            <span>{author ?? (roleTheme ?? roles.developer).label}</span>
            {senderType === "external" && (
              <span
                data-testid="external-channel-badge"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "1px 6px",
                  borderRadius: 999,
                  backgroundColor: neutral[100],
                  border: `1px solid ${neutral[200]}`,
                  color: neutral[500],
                  fontSize: 10,
                  fontWeight: 600,
                  lineHeight: 1.4,
                  whiteSpace: "nowrap",
                }}
              >
                外部渠道
              </span>
            )}
            {time ? <span> · {time}</span> : null}
          </span>
        )}
        {isMentionMe && !isUser && !isSystem && (
          <span
            data-testid="mention-me-badge"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10,
              color: "#2563EB",
              backgroundColor: "#EFF6FF",
              border: "1px solid #BFDBFE",
              borderRadius: 4,
              padding: "1px 6px",
              fontWeight: 600,
            }}
          >
            ★ @你
          </span>
        )}
        {(hasText || attachment) && (
          <div
            style={
              isUser
                ? {
                    ...bubbleBase,
                    backgroundColor: "#2563EB",
                    color: "#FFFFFF",
                    borderTopRightRadius: radius.sm,
                    boxShadow: shadow.sm,
                    maxWidth: attachment ? 520 : undefined,
                  }
                : {
                    ...bubbleBase,
                    backgroundColor: isMentionMe ? "#EFF6FF" : "var(--color-surface)",
                    color: neutral[800],
                    border: isMentionMe ? `1px solid #BFDBFE` : `1px solid ${neutral[200]}`,
                    borderLeft: isMentionMe ? `3px solid #2563EB` : `1px solid ${neutral[200]}`,
                    borderTopLeftRadius: radius.sm,
                    boxShadow: isMentionMe ? `0 0 0 1px rgba(37,99,235,0.15)` : shadow.sm,
                    maxWidth: attachment ? 520 : undefined,
                  }
            }
          >
            {hasText && (
              <>
                <div
                  data-testid="chat-bubble-content"
                  style={
                    (needsCollapse && !expanded
                      ? {
                          display: "-webkit-box",
                          WebkitLineClamp: 6,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          maxHeight: "9.6em",
                        }
                      : undefined) as unknown as CSSProperties
                  }
                >
                  {isUser || isSystem ? (
                    stripInjectedContext(text)
                  ) : (
                    <Markdown>{stripInjectedContext(text)}</Markdown>
                  )}
                </div>
                {needsCollapse && (
                  <button
                    type="button"
                    data-testid="chat-bubble-toggle"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((v) => !v)}
                    style={{
                      marginTop: space.xs,
                      padding: 0,
                      border: "none",
                      background: "none",
                      color: isUser ? "rgba(255,255,255,0.9)" : "#2563EB",
                      fontSize: fontSize.sm,
                      fontWeight: 500,
                      cursor: "pointer",
                      fontFamily: fontFamily.body,
                      textDecoration: "underline",
                    }}
                  >
                    {expanded ? "收起 ▲" : "展开 ▼"}
                  </button>
                )}
              </>
            )}
            {attachment && (
              <div style={{ marginTop: hasText ? space.md : 0 }}>
                <AttachmentCard attachment={attachment} isUser={isUser} embedded />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 附件卡片：图片内嵌预览（attachment-image）/ 文件下载链接（attachment-file），包 message-attachment。
 *  导出供 MsgParts（agent 过程片段消息）复用同一渲染链路。 */
export function AttachmentCard({
  attachment,
  isUser,
  embedded = false,
}: {
  attachment: ChatBubbleAttachment;
  isUser: boolean;
  embedded?: boolean;
}) {
  const isImage = (IMAGE_EXTS as readonly string[]).includes(
    attachment.ext.toLowerCase(),
  );
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);
  if (embedded) {
    if (isImage) {
      return (
        <>
          <button
            type="button"
            data-testid="attachment-image"
            aria-label={`查看大图：${attachment.name}`}
            title="点击查看大图"
            onClick={() => setZoomed(true)}
            style={{
              display: "inline-block",
              maxWidth: "100%",
              padding: 0,
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.md,
              overflow: "hidden",
              backgroundColor: neutral[50],
              cursor: "zoom-in",
            }}
          >
            <img
              src={attachment.url}
              alt={attachment.name}
              style={{
                display: "block",
                width: "auto",
                maxWidth: 320,
                maxHeight: 180,
                objectFit: "cover",
                objectPosition: "top",
                borderRadius: radius.md,
              }}
            />
          </button>
          {zoomed && (
            <div
              data-testid="attachment-lightbox"
              role="dialog"
              aria-modal="true"
              onClick={() => setZoomed(false)}
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 9999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: space.xl,
                backgroundColor: "rgba(15,23,42,0.72)",
                backdropFilter: "blur(4px)",
                cursor: "zoom-out",
              }}
            >
              <img
                src={attachment.url}
                alt={attachment.name}
                style={{
                  display: "block",
                  maxWidth: "92vw",
                  maxHeight: "92vh",
                  width: "auto",
                  height: "auto",
                  objectFit: "contain",
                  borderRadius: radius.lg,
                  border: `1px solid rgba(255,255,255,0.18)`,
                  backgroundColor: "#FFFFFF",
                  boxShadow: shadow.lg,
                  cursor: "zoom-out",
                }}
              />
            </div>
          )}
        </>
      );
    }
    // embedded file: inline without outer card background, keeps light border inside bubble
    return (
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
          border: `1px solid ${neutral[200]}`,
          borderRadius: radius.md,
          backgroundColor: isUser ? "rgba(255,255,255,0.12)" : neutral[50],
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
            backgroundColor: isUser ? "rgba(255,255,255,0.2)" : "rgba(37,99,235,0.18)",
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
    );
  }
  return (
    <div
      data-testid="message-attachment"
      style={{
        marginTop: embedded ? 0 : space.sm,
        borderRadius: radius.md,
        overflow: "hidden",
        backgroundColor: isUser ? "rgba(255,255,255,0.12)" : neutral[50],
        border: isUser ? "none" : `1px solid ${neutral[200]}`,
        ...baseFont,
      }}
    >
      {isImage ? (
        <>
          <button
            type="button"
            data-testid="attachment-image"
            aria-label={`查看大图：${attachment.name}`}
            title="点击查看大图"
            onClick={() => setZoomed(true)}
            style={{
              display: "block",
              width: "100%",
              padding: 0,
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.md,
              overflow: "hidden",
              backgroundColor: neutral[50],
              cursor: "zoom-in",
            }}
          >
            <img
              src={attachment.url}
              alt={attachment.name}
              style={{
                display: "block",
                width: "100%",
                height: "auto",
                maxWidth: 320,
                maxHeight: 180,
                objectFit: "cover",
                objectPosition: "top",
                borderRadius: radius.md,
              }}
            />
          </button>
          {zoomed && (
            <div
              data-testid="attachment-lightbox"
              role="dialog"
              aria-modal="true"
              onClick={() => setZoomed(false)}
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 9999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: space.xl,
                backgroundColor: "rgba(15,23,42,0.72)",
                backdropFilter: "blur(4px)",
                cursor: "zoom-out",
              }}
            >
              <img
                src={attachment.url}
                alt={attachment.name}
                style={{
                  display: "block",
                  maxWidth: "92vw",
                  maxHeight: "92vh",
                  width: "auto",
                  height: "auto",
                  objectFit: "contain",
                  borderRadius: radius.lg,
                  border: `1px solid rgba(255,255,255,0.18)`,
                  backgroundColor: "#FFFFFF",
                  boxShadow: shadow.lg,
                  cursor: "zoom-out",
                }}
              />
            </div>
          )}
        </>
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
              backgroundColor: isUser ? "rgba(255,255,255,0.2)" : "rgba(37,99,235,0.18)",
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