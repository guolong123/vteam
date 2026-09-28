"use client";

/**
 * ChatBubble：消息气泡（user=右对齐蓝 / agent=左对齐白卡带角色 / system=居中灰）
 *
 * 从 docs/agent-platform/prototypes/_shared/components.tsx 原样迁移。
 * 结构 / 样式 / data-testid 与原型一致；token 引用统一走 src/theme/tokens.ts。
 *
 * B7（复选框 10）：user 消息带 status 且取值 ∈ sending/sent/failed 时，在气泡体下方的
 * 文档流里渲染一条 data-testid="chat-bubble-status"（data-status=取值、role="status"、
 * 11px 元信息级）的轻量状态标记；它是正文之外的兄弟节点，不覆盖、不挤压正文。
 * B8（复选框 10）：可选 initials 由调用方用 lib/message-initials 从已解析人名生成，
 * 未传时 AgentAvatar 回落角色字母——组件自身不接触 senderId/instanceId。
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  type RoleKey,
  roles,
  roleText,
  neutral,
  mention,
  space,
  radius,
  fontSize,
  messageFontSize,
  messageFontWeight,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";
import { AgentAvatar } from "./agent-avatar";
import { authorRoleDisplay } from "@/lib/author-role-display";
import { stripInjectedContext } from "@/lib/strip-injected-context";
import { Markdown } from "./markdown";
import {
  ATTACHMENT_DETAIL_COLLAPSE_CHARS,
  ATTACHMENT_NAME_HEAD_CHARS,
  headChars,
} from "./collapse-policy";

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
  /** false=不渲染自身头像/作者行/时间（MsgParts 由共享身份栏出一次身份，避免二次身份）；默认 true */
  showIdentity?: boolean;
  /** B7 用户消息状态：sending/sent/failed 时渲染轻量状态标记；其余状态与非 user 消息一律不渲染 */
  status?: string;
  /** B8 头像缩写：调用方从已解析人名生成（lib/message-initials）；未传时 AgentAvatar 回落角色字母 */
  initials?: string;
  style?: CSSProperties;
  className?: string;
}

/** 图片附件判定：扩展名 ∈ 浏览器可内嵌渲染的图片集（其余走文件下载）。 */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif"];

/**
 * 正文折叠阈值（A1）：严格大于 800 字符才折叠；折叠态 clamp 10 行，
 * bubbleBase 行高 1.6 → maxHeight 10 × 1.6em = 16em。
 */
export const CHAT_COLLAPSE_THRESHOLD = 800;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * B7 用户消息状态标记：白名单只认 sending/sent/failed（逐值比较，不走 `in`，避开原型链误命中）；
 * pending/processing/completed/未知状态与缺省状态一律返回 null → 不渲染任何标记。
 */
function userMessageStatus(status?: string): { key: string; label: string } | null {
  if (status === "sending") return { key: status, label: "发送中…" };
  if (status === "sent") return { key: status, label: "已发送" };
  if (status === "failed") return { key: status, label: "发送失败" };
  return null;
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
  showIdentity = true,
  status,
  initials,
  style,
  className,
}: ChatBubbleProps) {
  const isUser = type === "user";
  const isSystem = type === "system";
  const roleTheme = role ? roles[role] : null;
  /** B5：身份行主文本 + 并列角色标签（author 已由容器解析，裸 id 不在本组件职责内） */
  const display = authorRoleDisplay(author, (roleTheme ?? roles.developer).label);
  /** B7：仅 user + sending/sent/failed 三个白名单取值出标记 */
  const statusMarker = isUser ? userMessageStatus(status) : null;
  const [expanded, setExpanded] = useState(false);

  const bubbleBase: CSSProperties = {
    width: "fit-content",
    maxWidth: "100%",
    minWidth: 0,
    overflowWrap: "break-word",
    padding: `${space.md}px ${space.lg}px`,
    borderRadius: radius.lg,
    fontSize: messageFontSize.body,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    ...baseFont,
  };

  if (isSystem) {
    // B4 降噪：system 行独立容器，不复用正文 bubbleBase（正文 14px / 12-16px 内边距 / 左对齐卡片）。
    // 非颜色区隔：11px 元信息字号、居中、虚线细边、4-12px 收窄内边距 + 4-8px 独立外边距节奏。
    // B12：提前 return 不再吞掉 time —— 传入时在 pill 内按元信息样式渲染，不加回身份/头像。
    return (
      <div
        data-testid="chat-bubble"
        data-type="system"
        className={className}
        style={{
          display: "flex",
          justifyContent: "center",
          margin: `${space.xs}px ${space.sm}px`,
          ...style,
        }}
      >
        <div
          style={{
            maxWidth: "100%",
            minWidth: 0,
            overflowWrap: "break-word",
            padding: `${space.xs}px ${space.md}px`,
            borderRadius: radius.pill,
            border: `1px dashed ${neutral[200]}`,
            backgroundColor: neutral[100],
            color: neutral[500],
            fontSize: messageFontSize.meta,
            lineHeight: 1.5,
            textAlign: "center",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            ...baseFont,
          }}
        >
          {stripInjectedContext(text)}
          {time ? (
            <span
              data-testid="chat-bubble-time"
              style={{
                display: "block",
                marginTop: space.xs,
                fontSize: messageFontSize.meta,
                color: neutral[400],
                lineHeight: 1.4,
                ...baseFont,
              }}
            >
              {time}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  const showHeader = showIdentity && !isUser && (author || roleTheme);
  const hasText = text.trim().length > 0;
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
      {!isUser && showIdentity && (
        <AgentAvatar role={role ?? "developer"} initials={initials} size="sm" dot={false} style={{ marginTop: 2 }} />
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
            style={{
              display: "inline-flex",
              alignItems: "baseline",
              gap: space.xs,
              flexWrap: "wrap",
              ...baseFont,
            }}
          >
            <span
              data-testid="chat-bubble-author"
              style={{
                fontSize: messageFontSize.identity,
                color: roleTheme ? roleText[role!] : neutral[400],
                fontWeight: messageFontWeight.identity,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
                ...baseFont,
              }}
            >
              <span>{display.primary}</span>
              {display.roleLabel !== null && (
                <span
                  data-testid="message-identity-role"
                  style={{
                    fontSize: messageFontSize.identity,
                    fontWeight: 500,
                    color: neutral[600],
                    lineHeight: 1.4,
                    ...baseFont,
                  }}
                >
                  · {display.roleLabel}
                </span>
              )}
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
            </span>
            {time ? (
              <span
                data-testid="chat-bubble-time"
                style={{
                  fontSize: messageFontSize.meta,
                  color: neutral[500],
                  lineHeight: 1.4,
                  ...baseFont,
                }}
              >
                · {time}
              </span>
            ) : null}
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
              color: mention.text,
              backgroundColor: mention.bg,
              border: `1px solid ${mention.border}`,
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
                    backgroundColor: "#0D9488",
                    color: "#FFFFFF",
                    borderTopRightRadius: radius.sm,
                    boxShadow: shadow.sm,
                    overflow: "hidden",
                    maxWidth: attachment ? 520 : "100%",
                  }
                : {
                    ...bubbleBase,
                    backgroundColor: isMentionMe ? mention.bg : "var(--color-surface)",
                    color: neutral[800],
                    border: isMentionMe ? `1px solid ${mention.border}` : `1px solid ${neutral[200]}`,
                    borderLeft: isMentionMe ? `3px solid ${mention.accent}` : `1px solid ${neutral[200]}`,
                    borderTopLeftRadius: radius.sm,
                    boxShadow: isMentionMe ? `0 0 0 1px rgba(13,148,136,0.15)` : shadow.sm,
                    overflow: "hidden",
                    maxWidth: attachment ? 520 : "100%",
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
                          WebkitLineClamp: 10,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          maxHeight: "16em",
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
                      color: isUser ? "rgba(255,255,255,0.9)" : mention.text,
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
        {statusMarker && (
          <span
            data-testid="chat-bubble-status"
            data-status={statusMarker.key}
            role="status"
            style={{
              display: "inline-flex",
              alignItems: "center",
              fontSize: messageFontSize.meta,
              lineHeight: 1.4,
              // tokens.ts 无 danger/error 语义色：沿用仓库既有错误红 #DC2626（发送失败/加载失败同色）
              color: statusMarker.key === "failed" ? "#DC2626" : neutral[400],
              ...baseFont,
            }}
          >
            {statusMarker.label}
          </span>
        )}
      </div>
    </div>
  );
}

/** 附件卡片：图片内嵌预览（attachment-image）/ 文件下载链接（attachment-file），包 message-attachment。
 *  导出供 MsgParts（agent 过程片段消息）复用同一渲染链路。
 *  B11：非图片且文件名超过 ATTACHMENT_DETAIL_COLLAPSE_CHARS 时附件详情默认收起——
 *  收起态只渲染 attachment-summary（徽标 + 名字头部 + 大小）与 attachment-detail-toggle，
 *  完整 attachment-file 链接只有展开后才进 DOM；图片与短文件名走原路径，零开关。 */
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
  const collapsible = !isImage && attachment.name.length > ATTACHMENT_DETAIL_COLLAPSE_CHARS;
  const [zoomed, setZoomed] = useState(false);
  const [detailOpen, setDetailOpen] = useState(!collapsible);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  const badge = (
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
        backgroundColor: isUser ? "rgba(255,255,255,0.2)" : "rgba(13,148,136,0.18)",
        color: "#0D9488",
        fontSize: fontSize.xs,
        fontWeight: 600,
      }}
    >
      {attachment.ext.slice(0, 3).toUpperCase()}
    </span>
  );

  const fullLabel = (
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
  );

  const detailToggle = (
    <button
      type="button"
      data-testid="attachment-detail-toggle"
      aria-expanded={detailOpen}
      onClick={() => setDetailOpen((v) => !v)}
      style={{
        flexShrink: 0,
        padding: 0,
        border: "none",
        background: "none",
        color: isUser ? "#FFFFFF" : "#0D9488",
        fontSize: fontSize.xs,
        fontWeight: 500,
        cursor: "pointer",
        fontFamily: fontFamily.body,
        textDecoration: "underline",
      }}
    >
      {detailOpen ? "收起详情 ▾" : "展开详情 ▸"}
    </button>
  );

  const fileLink = (
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
        color: isUser ? "#FFFFFF" : "#0D9488",
        fontSize: fontSize.sm,
        fontWeight: 500,
        textDecoration: "none",
        wordBreak: "break-all",
        ...(embedded
          ? {
              border: `1px solid ${neutral[200]}`,
              borderRadius: radius.md,
              backgroundColor: isUser ? "rgba(255,255,255,0.12)" : neutral[50],
            }
          : {}),
      }}
    >
      {badge}
      {fullLabel}
    </a>
  );

  const summaryRow = (
    <div
      data-testid="attachment-summary"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        minWidth: 0,
        padding: `${space.sm}px ${space.md}px`,
      }}
    >
      {badge}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: fontSize.sm,
          fontWeight: 500,
          lineHeight: 1.4,
          color: isUser ? "#FFFFFF" : "#0D9488",
          wordBreak: "break-all",
        }}
      >
        {headChars(attachment.name, ATTACHMENT_NAME_HEAD_CHARS)}
      </span>
      {typeof attachment.size === "number" && (
        <span
          style={{
            flexShrink: 0,
            fontSize: fontSize.xs,
            color: isUser ? "rgba(255,255,255,0.75)" : neutral[400],
          }}
        >
          {formatFileSize(attachment.size)}
        </span>
      )}
      {detailToggle}
    </div>
  );

  const fileBody = !collapsible
    ? fileLink
    : detailOpen
      ? (
          <div style={{ display: "flex", flexDirection: "column", gap: space.xs, minWidth: 0 }}>
            {fileLink}
            {detailToggle}
          </div>
        )
      : summaryRow;

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
    return fileBody;
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
        fileBody
      )}
    </div>
  );
}