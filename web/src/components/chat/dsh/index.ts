/**
 * DSH 风格私聊渲染层（统一出口）
 * =============================================
 * 私聊 Tab（`MsgParts variant="dsh"`）的渲染实现，全部基于
 * `@deepseek-ai/dsh-client-ui-primitives`（DSH 本体在用的渲染原子，MIT，零 cordis）。
 *
 * 引入方式：
 *   import { DshMessage } from "@/src/components/chat/dsh";
 *
 * 结构：
 * - `dsh-message`        一条 agent 消息的合成（身份栏 + 时间线块 + 附件）
 * - `dsh-markdown`       正文（DSH `MarkdownText`，带流式增量解析）
 * - `dsh-reasoning`      思考行（DSH `ReasoningRow` 对齐）
 * - `dsh-tool-card`      工具卡（DSH `ToolRow` 对齐，通用卡形态）
 * - `dsh-parts-adapter`  vteam part → DSH block 的纯函数映射
 * - `dsh-labels`         DSH 文案词典 + memo 化的 MarkdownLabels
 *
 * 群聊（`variant="bubble"`）不经过本目录，观感零变化。
 */
export { DshMessage } from "./dsh-message";
export type { DshMessageProps } from "./dsh-message";
export { DshMarkdown } from "./dsh-markdown";
export type { DshMarkdownProps } from "./dsh-markdown";
export { DshReasoning, REASONING_TITLE_ZH } from "./dsh-reasoning";
export type { DshReasoningProps } from "./dsh-reasoning";
export { DshToolCard, toolTitleOf } from "./dsh-tool-card";
export type { DshToolCardProps } from "./dsh-tool-card";
export { toDshBlocks } from "./dsh-parts-adapter";
export type {
  DshBlock,
  DshErrorBlock,
  DshReasoningBlock,
  DshTextBlock,
  DshToolBlock,
  ToDshBlocksOptions,
} from "./dsh-parts-adapter";
export {
  DSH_COMMON_EN,
  DSH_COMMON_ZH,
  markdownLabelsOf,
  useMarkdownLabels,
} from "./dsh-labels";
export type { DshCommonLabels } from "./dsh-labels";
