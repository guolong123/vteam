"use client";

/**
 * 外部用户只读消息回看（契约 3.2）
 * =============================================
 * - 头部：头像 + 名称 + 来源徽标 + 公司·岗位 + 消息数。
 * - 中间：按时间正序的只读消息流；每条上方小字「团队名 · 时间」，正文复用 ChatBubble
 *   （契约指定 type="user"），附件以链接形式随气泡渲染。
 * - 底部：只读提示；外部消息仍走原群聊链路，这里不提供输入框。
 * - 数据：详情 useQuery(["external-user", userId])；消息分页 useInfiniteQuery（每页 50，
 *   cursor 向更早翻），页序从新到旧，展示时倒页拼成正序。
 */
import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChatBubble } from "@/src/components/ui";
import type { ChatBubbleAttachment } from "@/src/components/ui";
import { isApiError } from "@/lib/errors";
import {
  externalUsersApi,
  type ExternalUserMessage,
  type ExternalUserMessageAttachment,
} from "@/src/api/external-users";
import {
  externalUserAvatarStyle,
  externalUserInitial,
  formatExternalUserTime,
} from "./ExternalUserList";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";

/** 首屏（也是每次翻页）条数；与契约「limit 50」一致。 */
const MESSAGE_PAGE_SIZE = 50;

/** 来源渠道 → 人类可读徽标文案；未知来源原样展示，避免丢信息。 */
const SOURCE_LABELS: Record<string, string> = {
  wecom_aibot: "企微用户",
  generic_webhook: "通用 Webhook",
  legacy: "历史消息",
};

function sourceLabel(source: string | null | undefined): string {
  if (!source) return "外部渠道";
  return SOURCE_LABELS[source] ?? source;
}

/**
 * 剥离入站正文的渠道传输前缀：企微/通用 webhook 链路落库的正文形如
 * `[WeCom:<展示名>|from 群聊|私聊] 正文`，这个标记是给 Agent 判断回复场景的，
 * 回看视图里展示名已在头部/元信息出现，再显示一遍既冗余又像乱码。
 * 只剥行首标记（正文中间用户自己写的同形文本不动），并保留其后的正文。
 */
function stripChannelPrefix(text: string): string {
  return text.replace(/^\s*\[WeCom:[^\]]*\]\s*/, "");
}

/** 从附件 URL 推断扩展名（后端 ext 可能为空，ChatBubble 依赖它区分图片/文件）。 */
function extOfUrl(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

/** 后端附件（字段可空）→ ChatBubbleAttachment（name/ext 必填）。 */
function toBubbleAttachments(
  attachments: ExternalUserMessageAttachment[] | null | undefined,
): ChatBubbleAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment, index) => ({
    url: attachment.url,
    name: attachment.name ?? `附件-${index + 1}`,
    size: attachment.size ?? undefined,
    ext: attachment.ext ?? extOfUrl(attachment.url),
  }));
}

/** 气泡上方元信息：「团队名 · 时间」。 */
function messageMeta(message: ExternalUserMessage): string {
  const time = formatExternalUserTime(message.createdAt);
  const team = message.teamName?.trim();
  return team ? `${team} · ${time}` : time;
}

function errorText(err: unknown): string {
  if (isApiError(err)) return err.message;
  return err instanceof Error ? err.message : "加载失败";
}

export function ExternalUserConversation({ userId }: { userId: string }) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const detailQuery = useQuery({
    queryKey: ["external-user", userId],
    queryFn: () => externalUsersApi.get(userId),
    enabled: !!userId,
  });

  const messagesQuery = useInfiniteQuery({
    queryKey: ["external-user", userId, "messages"],
    queryFn: ({ pageParam }) =>
      externalUsersApi.messages(userId, {
        limit: MESSAGE_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!userId,
  });

  /** pages 第 0 页最新；整体正序需要先倒页、再页内顺序拼接。 */
  const messages = useMemo(() => {
    const pages = messagesQuery.data?.pages ?? [];
    return [...pages].reverse().flatMap((page) => page.items);
  }, [messagesQuery.data]);

  // 打开某位外部用户/首屏加载完成时滚到最新一条；翻更早消息不跳到底部。
  useEffect(() => {
    if (!messagesQuery.isSuccess) return;
    const el = listRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messagesQuery.isSuccess, userId]);

  const detail = detailQuery.data;
  const displayName = detail?.name ?? "外部用户";
  const organization = [detail?.company, detail?.position]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(" · ");
  const subtitle = organization
    ? organization
    : detail
      ? `渠道名：${detail.displayName}`
      : "外部渠道用户";

  return (
    <section
      data-testid="external-user-conversation"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--color-bg, #F8FAFC)",
      }}
    >
      <header
        style={{
          padding: `${space.md}px ${space.lg}px`,
          borderBottom: `1px solid ${neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          display: "flex",
          alignItems: "center",
          gap: space.sm,
        }}
      >
        <span style={externalUserAvatarStyle(displayName, 36)}>
          {externalUserInitial(displayName)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: fontSize.md,
                fontWeight: 700,
                color: neutral[900],
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayName}
            </span>
            <span
              style={{
                flexShrink: 0,
                fontSize: 10,
                color: "#0F766E",
                backgroundColor: "rgba(13,148,136,0.10)",
                border: "1px solid rgba(13,148,136,0.22)",
                borderRadius: radius.pill,
                padding: "1px 8px",
              }}
            >
              {sourceLabel(detail?.source)}
            </span>
          </div>
          <div
            style={{
              fontSize: fontSize.xs,
              color: neutral[500],
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subtitle}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: fontSize.xs, color: neutral[400], whiteSpace: "nowrap" }}>
          {detail?.messageCount ?? 0} 条消息
          {detail && detail.groupCount > 0 ? ` · ${detail.groupCount} 个群聊` : ""}
        </span>
      </header>

      {detailQuery.isError && (
        <div
          role="alert"
          style={{
            padding: `${space.sm}px ${space.lg}px`,
            fontSize: fontSize.xs,
            color: "#B91C1C",
            backgroundColor: "#FEF2F2",
            borderBottom: `1px solid ${neutral[200]}`,
          }}
        >
          {errorText(detailQuery.error)}
        </div>
      )}

      <div
        ref={listRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: `${space.lg}px ${space.xl}px`,
          display: "flex",
          flexDirection: "column",
          gap: space.md,
        }}
      >
        {messagesQuery.isPending ? (
          <div style={{ color: neutral[400], fontSize: fontSize.sm }}>
            加载消息中…
          </div>
        ) : messages.length === 0 ? (
          <div style={{ margin: "auto", color: neutral[400], fontSize: fontSize.sm }}>
            {messagesQuery.isError
              ? `消息加载失败：${errorText(messagesQuery.error)}`
              : "该外部用户还没有可回看的消息"}
          </div>
        ) : (
          <>
            {messagesQuery.hasNextPage && (
              <div style={{ alignSelf: "center" }}>
                <button
                  type="button"
                  disabled={messagesQuery.isFetchingNextPage}
                  onClick={() => void messagesQuery.fetchNextPage()}
                  style={{
                    padding: "4px 14px",
                    borderRadius: radius.pill,
                    border: `1px solid ${neutral[200]}`,
                    backgroundColor: "var(--color-surface)",
                    color: neutral[500],
                    fontSize: fontSize.xs,
                    cursor: messagesQuery.isFetchingNextPage
                      ? "default"
                      : "pointer",
                    fontFamily: fontFamily.body,
                  }}
                >
                  {messagesQuery.isFetchingNextPage
                    ? "加载中…"
                    : "加载更早消息"}
                </button>
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                data-testid="external-user-message"
                data-message-id={message.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 4,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: neutral[400],
                    paddingLeft: 2,
                    fontFamily: fontFamily.body,
                  }}
                >
                  {messageMeta(message)}
                </span>
                <ChatBubble
                  text={stripChannelPrefix(message.text ?? "")}
                  type="user"
                  attachments={toBubbleAttachments(message.attachments)}
                  style={{ alignSelf: "flex-start", maxWidth: "100%" }}
                />
              </div>
            ))}
          </>
        )}
      </div>

      <footer
        data-testid="external-user-readonly-hint"
        style={{
          borderTop: `1px solid ${neutral[200]}`,
          backgroundColor: "var(--color-surface)",
          padding: `${space.sm}px ${space.lg}px`,
          fontSize: fontSize.xs,
          color: neutral[500],
          lineHeight: 1.6,
        }}
      >
        外部用户消息经渠道自动汇总，此处只读展示；如需回复请在对应群聊中 @ 成员
      </footer>
    </section>
  );
}
