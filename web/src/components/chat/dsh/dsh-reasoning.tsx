/**
 * DshReasoning：思考行（DSH `ReasoningRow` 的对齐实现）
 * =============================================
 * 行为与 DSH 一致：
 * - **默认折叠**，折叠态只出一行摘要（固定 24px 行高），不占屏幕；
 * - 摘要取**首行**（已定稿）或**最新完整段落的首行**（流式中），并去掉 `**` 标记；
 * - 流式中摘要走 `TextShimmer` 微光（能看出"还在想"）；
 * - 点击展开 → 完整思考正文，用 `DshMarkdown variant="compact"`（次级排版）；
 * - 空思考（trim 后为空）整个不渲染 —— 由 adapter 层拦掉，本组件只兜一次。
 *
 * 视觉外壳直接用 primitives 的 `DisclosureRow`（DSH 同款 24px 过程行），
 * 图标用 `IconThinkOutlineRegular`（DSH ReasoningRow 用的同一个）。
 *
 * @module components/chat/dsh/dsh-reasoning
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import {
  DisclosureRow,
  IconThinkOutlineRegular,
  TextShimmer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { MarkdownLabels } from "@deepseek-ai/dsh-client-ui-primitives";
import { DshMarkdown } from "./dsh-markdown";

/** 思考行标题（对齐 DSH `message.think` = 「思考」）。 */
export const REASONING_TITLE_ZH = "思考";

/** 摘取首行；无换行时整段即首行。 */
function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * 取「最后一个已完成段落」的首行。
 *
 * 为什么流式中用它而不是 `firstLine`：流式文本的第一行往往已经滚过去了，
 * 拿「最新段落首行」才能反映模型此刻在想什么（与 DSH 的实现逐行对齐）。
 */
function latestCompletedParagraphFirstLine(text: string): string {
  let summary = "";
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  while (true) {
    const nextParagraph = separator.exec(text);
    const paragraphEnd =
      nextParagraph === null
        ? text.length
        : nextParagraph.index + nextParagraph[0].indexOf("\n");
    const newline = text.indexOf("\n", paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== "") summary = candidate;
    }
    if (nextParagraph === null) return summary;
    paragraphStart = nextParagraph.index + nextParagraph[0].length;
  }
}

export interface DshReasoningProps {
  /** 完整或流式中的思考文本。 */
  text: string;
  /** 是否仍在生成（决定摘要 shimmer 与折叠态摘要取哪一句）。 */
  running?: boolean;
  /** 稳定的 Markdown 文案引用（由 useMarkdownLabels 提供）。 */
  labels: MarkdownLabels;
}

/**
 * 一条思考（reasoning）块。
 *
 * 展开/折叠状态是**组件内 state**（与 DSH 的 useDisclosure 同语义：默认收着，
 * 用户点了才开）。没有做「回合结束自动收起」——那需要外层 Turn 概念，
 * 私聊页目前没有，保持简单。
 */
export function DshReasoning({ text, running = false, labels }: DshReasoningProps) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  /** 摘要：流式取最新段落首行，定稿取首行；去掉 `**` 加粗标记（DSH 同口径）。 */
  const summary = useMemo(() => {
    const raw = running ? latestCompletedParagraphFirstLine(text) : firstLine(text);
    return raw.replaceAll("**", "");
  }, [text, running]);

  if (text.trim().length === 0) return null;

  return (
    <div
      data-testid="dsh-reasoning"
      data-state={running ? "running" : "done"}
      data-expanded={open ? "true" : undefined}
      // ⚠️ 折叠态必须**自己钉死高度**：`DisclosureRow` 只保证 header 行 24px，
      // 而思考摘要是一长段没有换行的文本 —— 不约束就会换行撑破行高、把相邻的
      // 思考行挤在一起（实测现象）。DSH 的 ReasoningRow 用的是
      // `.root:not([data-expanded]) { contain: size layout; height: 24px }`，
      // 这里照抄该契约。
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        ...(open ? {} : { contain: "size layout", height: "calc(24px + var(--dsh-content-font-delta, 0px))" }),
      }}
    >
      <DisclosureRow
        icon={<IconThinkOutlineRegular size={14} />}
        title={REASONING_TITLE_ZH}
        open={open}
        expandable
        onToggle={toggle}
        running={running}
        expandOnRowClick
        previewChevron
        keepContentWhenOpen
        collapsedContent={
          summary.length > 0 ? (
            <>
              {/* 标题与摘要之间的 2×2 圆点分隔（DSH `.separator` 同款） */}
              <span
                aria-hidden
                style={{
                  flex: "none",
                  width: 2,
                  height: 2,
                  margin: "0 8px",
                  borderRadius: 1,
                  background: "var(--dsw-alias-label-caption)",
                }}
              />
              {/* 摘要单行 + 省略号。流式中用 mask 做右侧淡出（DSH 同款），
                  避免省略号在文字还在增长时频繁跳变。 */}
              <span
                data-testid="dsh-reasoning-summary"
                data-streaming={running ? "true" : undefined}
                style={{
                  flex: "auto",
                  minWidth: 0,
                  fontSize: 13,
                  lineHeight: "20px",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: running ? "clip" : "ellipsis",
                  display: "block",
                  ...(running
                    ? { maskImage: "linear-gradient(90deg, #000 calc(100% - 48px), transparent)" }
                    : {}),
                }}
              >
                <TextShimmer active={running}>{summary}</TextShimmer>
              </span>
            </>
          ) : undefined
        }
      >
        {open ? (
          <div
            data-testid="dsh-reasoning-body"
            style={{ padding: "4px 0 4px 22px", minWidth: 0 }}
          >
            <DshMarkdown text={text} labels={labels} variant="compact" />
          </div>
        ) : null}
      </DisclosureRow>
    </div>
  );
}
