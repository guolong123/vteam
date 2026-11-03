/**
 * DshMarkdown：DSH 正文 Markdown 渲染器
 * =============================================
 * 直接复用 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` —— 这是 DSH Web
 * 渲染 agent 正文的那一个组件，**不是复刻**。因此以下能力与 DSH 逐像素一致：
 *
 * | 能力 | 说明 |
 * |---|---|
 * | 标题 / 列表 / 表格 / 引用 / 分隔线 | mdast → React 语义元素 |
 * | 行内代码 | 等宽 chip（`--dsw-alias-markdown-inline-code`） |
 * | 代码块 | 语言标签 / 「代码块」兜底 / 复制 / 自动换行 / Shiki 着色 |
 * | GFM | 表格、删除线、任务列表、自动链接、脚注 |
 * | 数学 | KaTeX（`$…$` / `$$…$$`） |
 * | 流式 | `streaming` 时增量解析：冻结已完成块为缓存元素，只重解析尾部 |
 * | 安全 | raw HTML 渲染为字面文本（不进 DOM）；链接/图片走协议白名单 |
 *
 * ## 与 vteam 群聊 `Markdown`（`src/components/ui/markdown.tsx`）的关系
 * 两者**并存、互不影响**：群聊仍走 react-markdown（`variant="bubble"`），
 * 私聊走本组件（`variant="dsh"`）。刻意不合并 —— 改群聊观感风险大且不在需求内。
 *
 * ## streaming 语义（重要）
 * `text` 必须是**「到目前为止的完整文本」**，不是本次增量。vteam 的
 * `message.part.delta` 帧携带的正是累积全文快照（worker 侧已累积），
 * 所以直接把 `part.text` 传进来即可，无需前端再拼。
 *
 * @module components/chat/dsh/dsh-markdown
 */
"use client";

import { memo } from "react";
import type { CSSProperties } from "react";
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  MarkdownFileMentions,
  MarkdownLabels,
  MarkdownPathImages,
} from "@deepseek-ai/dsh-client-ui-primitives";

export interface DshMarkdownProps {
  /** Markdown 源文本；streaming 时为「截至目前的全文」。 */
  text: string;
  /** 是否仍在流式生成（增量解析 + 围栏增量高亮）。 */
  streaming?: boolean;
  /** 由 `useMarkdownLabels` 提供的稳定引用（**不要每次新建对象**）。 */
  labels: MarkdownLabels;
  /**
   * 排版变体：
   * - `"body"`（默认）= 正文的完整文档排版；
   * - `"compact"` = 次级字号 + 统一粗体标题 + 紧凑块间距（思考正文用）。
   */
  variant?: "body" | "compact";
  /** 行内代码中被识别为真实文件的 token → 可点击（本方案暂不接，留位）。 */
  fileMentions?: MarkdownFileMentions;
  /** 本地图片路径重写（本方案暂不接，留位）。 */
  pathImages?: MarkdownPathImages;
  style?: CSSProperties;
  className?: string;
}

/**
 * DSH 正文 Markdown。
 *
 * `MarkdownText` 自身已 memo 化，这里再包一层 memo 只是为了让 vteam 侧的
 * style/className 透传不引起多余渲染。
 */
export const DshMarkdown = memo(function DshMarkdown({
  text,
  streaming = false,
  labels,
  variant = "body",
  fileMentions,
  pathImages,
  style,
  className,
}: DshMarkdownProps) {
  return (
    <div
      data-testid="dsh-markdown"
      data-streaming={streaming ? "true" : undefined}
      data-variant={variant}
      className={className}
      style={style}
    >
      <MarkdownText
        text={text}
        streaming={streaming}
        labels={labels}
        variant={variant}
        {...(fileMentions === undefined ? {} : { fileMentions })}
        {...(pathImages === undefined ? {} : { pathImages })}
      />
    </div>
  );
});
