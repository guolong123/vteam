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
    <div data-testid="dsh-reasoning" data-state={running ? "running" : "done"}>
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
            <TextShimmer active={running}>
              <span data-testid="dsh-reasoning-summary">{summary}</span>
            </TextShimmer>
          ) : undefined
        }
      >
        {open ? (
          <div
            data-testid="dsh-reasoning-body"
            style={{ padding: "4px 0 8px 22px" }}
          >
            <DshMarkdown text={text} labels={labels} variant="compact" />
          </div>
        ) : null}
      </DisclosureRow>
    </div>
  );
}
