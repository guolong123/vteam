/**
 * MsgLiveStream：私聊流式「生成中」独立置底行（chat-ux-hierarchy-and-streaming）
 * =============================================
 * 私聊 Tab 下，`status=processing` 的 agent 消息（in-flight 回合）从消息数组中抽出，
 * 作为一条**置底**的独立流式行渲染：它不再以回合起点的 createdAt 混排在历史中
 * （服务端 mergeSessionWithPlatform 已把 processing 行并入会话末尾，本组件负责渲染
 * 位置保证 + 折叠 UX）。群聊 Tab 不走本组件（页面对群聊恒传空 liveMessages）。
 *
 * - 顶部共享身份栏（MessageIdentity）：与 MsgParts 同一身份出口，不重复身份；
 * - 标题行：`生成中` + 三连点 + 折叠开关（data-testid=msg-live-stream-toggle，aria-expanded）；
 *   文案 `▾ 收起`（展开）/ `▸ 生成中 · 点击展开`（折叠）；
 * - 默认展开（streaming），点击折叠；
 * - 展开体复用 MsgParts（grouped=true，身份不重复），外层限高 40vh 并随内容增长自动滚底；
 * - 折叠体为 200 字符摘录（对齐 msg-thinking THINKING_EXCERPT_CHARS 的封顶思路）。
 *
 * data-testid=msg-live-stream（根，置底行）——折叠开关只存在于本行，**不进 MsgParts**：
 * e2e/chat-density.spec.ts 断言 msg-streaming 内不得出现 button[aria-expanded]，本组件的
 * 开关在 msg-live-stream 根之下，与 msg-streaming 无嵌套关系。
 * token 引用统一走 src/theme/tokens.ts。
 */
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  type RoleKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";
import { MessageIdentity } from "@/src/components/ui";
import type { ChatBubbleAttachment } from "@/src/components/ui";
import { LoadingDots } from "./loading-indicator";
import { MsgParts } from "./msg-parts";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 折叠态摘录字符上限（与 msg-thinking 的 THINKING_EXCERPT_CHARS 同口径）。 */
export const LIVE_EXCERPT_CHARS = 200;

/** 展开体最大高度（40vh）：长流式输出内部滚动，不把历史消息挤出视口。 */
const LIVE_BODY_MAX_HEIGHT = "40vh";

/** 附属行容器：与 MsgParts 同缩进 = 头像 28 + 身份栏间距 8，折叠开关与展开体对齐过程行。 */
const secondaryRows: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: space.sm,
  paddingLeft: 36,
};

export interface MsgLiveStreamProps {
  parts: unknown[];
  bodyText?: string;
  /** 已解析的展示作者名（容器剔除裸 id）；缺省时由共享身份栏回落角色标签 */
  author?: string;
  role: RoleKey;
  time?: string;
  /** B8 头像缩写：调用方从已解析人名生成（lib/message-initials） */
  initials?: string;
  /** 敏感命令等待填写派生（透传 MsgParts 的 secretAwaiting） */
  secretAwaiting?: boolean;
  isMentionMe?: boolean;
  attachment?: ChatBubbleAttachment;
  className?: string;
  style?: CSSProperties;
}

/**
 * 折叠摘录：拼接 text part 与 bodyText（同 MsgParts 的正文 join 口径），空白归一后取前
 * LIVE_EXCERPT_CHARS 个字符（无内容时返回空串，由调用侧回落占位文案）。
 */
function excerptOf(parts: unknown[], bodyText?: string): string {
  const list = (parts ?? []) as { type?: string; text?: string }[];
  const joined =
    list
      .filter((p) => p?.type === "text")
      .map((p) => p.text ?? "")
      .join("\n") || bodyText || "";
  return joined.replace(/\s+/g, " ").trim().slice(0, LIVE_EXCERPT_CHARS);
}

/** 内容签名：part 数 + 文本/输出字符数之和；仅内容增长（签名变化）时触发展开体自动滚底。 */
function contentSignature(parts: unknown[], bodyText?: string): string {
  const list = (parts ?? []) as { text?: string; output?: string }[];
  let chars = bodyText?.length ?? 0;
  for (const p of list) {
    if (typeof p?.text === "string") chars += p.text.length;
    if (typeof p?.output === "string") chars += p.output.length;
  }
  return `${list.length}:${chars}`;
}

/** 私聊流式「生成中」独立行：置底 + 可折叠 + 展开体自滚动。 */
export function MsgLiveStream({
  parts,
  bodyText,
  author,
  role,
  time,
  initials,
  secretAwaiting,
  isMentionMe,
  attachment,
  className,
  style,
}: MsgLiveStreamProps) {
  const [open, setOpen] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const signature = useMemo(() => contentSignature(parts, bodyText), [parts, bodyText]);
  const excerpt = useMemo(() => excerptOf(parts, bodyText), [parts, bodyText]);
  // 展开体自身滚动跟随：内容签名变化时把内部 scrollTop 顶到 scrollHeight，
  // 保证最新一行流式输出可见（外层列表由页面 scrollToBottom 负责）。
  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [signature, open]);
  return (
    <div
      data-testid="msg-live-stream"
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        ...baseFont,
        ...style,
      }}
    >
      <MessageIdentity author={author} role={role} time={time} initials={initials} />
      <div style={secondaryRows}>
        <button
          type="button"
          data-testid="msg-live-stream-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            width: "100%",
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: neutral[100],
            border: `1px dashed ${neutral[300]}`,
            cursor: "pointer",
            textAlign: "left",
            fontFamily: fontFamily.body,
            fontSize: fontSize.sm,
          }}
        >
          <span style={{ fontSize: fontSize.sm, color: neutral[500], fontWeight: 500, flexShrink: 0 }}>
            生成中
          </span>
          <LoadingDots color={neutral[400]} testid="msg-live-stream-dots" />
          <span style={{ marginLeft: "auto", fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>
            {open ? "▾ 收起" : "▸ 生成中 · 点击展开"}
          </span>
        </button>
        {open ? (
          <div
            ref={bodyRef}
            data-testid="msg-live-stream-body"
            style={{ maxHeight: LIVE_BODY_MAX_HEIGHT, overflowY: "auto" }}
          >
            <MsgParts
              parts={parts}
              bodyText={bodyText}
              streaming
              messageStatus="processing"
              grouped
              secretAwaiting={secretAwaiting}
              isMentionMe={isMentionMe}
              attachment={attachment}
              role={role}
              author={author}
              time={time}
              initials={initials}
            />
          </div>
        ) : (
          <div
            style={{
              padding: `${space.sm}px ${space.md}px`,
              fontSize: fontSize.xs,
              color: neutral[400],
              fontStyle: "italic",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {excerpt || "（生成中，暂无输出）"}
          </div>
        )}
      </div>
    </div>
  );
}
