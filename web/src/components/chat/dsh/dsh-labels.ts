/**
 * dsh-labels：DSH 文案词典（vendored 自 `@deepseek-ai/dsh-client-locale` 的 common 命名空间）
 * =============================================
 * 为什么自己存一份而不装 `@deepseek-ai/dsh-client-locale`：后者依赖 cordis 运行时
 * （`LocaleRuntime` 挂在 cordis 的 slots/events 上）。本方案只需要那 6 条文案，
 * 直接 vendor 字符串（MIT，Copyright (c) 2026 DeepSeek）比引入整个 locale 运行时划算。
 *
 * 这些 key 与 DSH Web 逐字对齐（`dsh-client-locale/lib/client.js` 的 zh/en 字典）：
 * - `codeBlock.title`  = 代码块      ← 代码块**没有语言标注**时的兜底标题（截图左上角那个）
 * - `codeBlock.wrap`   = 自动换行
 * - `codeBlock.unwrap` = 取消自动换行
 * - `copy` / `copied`  = 复制 / 复制成功
 * - `markdown.footnotes` = 脚注
 *
 * @module components/chat/dsh/dsh-labels
 */
"use client";

import { useMemo } from "react";
import type { MarkdownLabels } from "@deepseek-ai/dsh-client-ui-primitives";

/** DSH `common` 命名空间的文案子集。 */
export interface DshCommonLabels {
  /** 复制按钮空闲态文案（`copy`）。 */
  copy: string;
  /** 复制后的确认文案（`copied`）。 */
  copied: string;
  /** 代码块无语言标注时的兜底标题（`codeBlock.title`）。 */
  codeBlockTitle: string;
  /** 自动换行动作（`codeBlock.wrap`）。 */
  codeBlockWrap: string;
  /** 取消自动换行动作（`codeBlock.unwrap`）。 */
  codeBlockUnwrap: string;
  /** 脚注标题（`markdown.footnotes`）。 */
  footnotes: string;
}

/** 中文词典（与 DSH `zh` 逐字一致）。 */
export const DSH_COMMON_ZH: DshCommonLabels = Object.freeze({
  copy: "复制",
  copied: "复制成功",
  codeBlockTitle: "代码块",
  codeBlockWrap: "自动换行",
  codeBlockUnwrap: "取消自动换行",
  footnotes: "脚注",
});

/** English dictionary（与 DSH `en` 逐字一致）。 */
export const DSH_COMMON_EN: DshCommonLabels = Object.freeze({
  copy: "Copy",
  copied: "Copied",
  codeBlockTitle: "Code block",
  codeBlockWrap: "Wrap lines",
  codeBlockUnwrap: "Do not wrap lines",
  footnotes: "Footnotes",
});

/**
 * `DshCommonLabels` → primitives 的 `MarkdownLabels`。
 *
 * 对齐 DSH 的 `markdownLabels(t)`（`dsh-client-ui-chat` 的 markdown-labels.js）：
 * 围栏与脚注的 chrome 全部由这几个 key 拼出来。
 */
export function markdownLabelsOf(common: DshCommonLabels): MarkdownLabels {
  return {
    code: {
      copyLabel: common.copy,
      copiedLabel: common.copied,
      toolbarLabels: {
        codeLabel: common.codeBlockTitle,
        wrapLabel: common.codeBlockWrap,
        unwrapLabel: common.codeBlockUnwrap,
      },
    },
    footnotes: common.footnotes,
  };
}

/**
 * memo 化的 `MarkdownLabels`。
 *
 * ⚠️ **身份必须稳定**：`MarkdownText` 的流式渲染缓存以 `labels` 的引用为失效条件，
 * 每次渲染都传新对象会让「冻结已完成块、只重解析尾部」的优化整段失效
 * （DSH 文档原文：a new identity discards the streaming render cache mid-message）。
 */
export function useMarkdownLabels(common: DshCommonLabels = DSH_COMMON_ZH): MarkdownLabels {
  return useMemo(() => markdownLabelsOf(common), [common]);
}
