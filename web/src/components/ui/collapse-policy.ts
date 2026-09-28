/**
 * B11 统一折叠策略（chat-ux-hierarchy-and-streaming 复选框 12）
 * =============================================
 * 单一事实源：哪些消息片段默认收起、哪些必须始终可见、以及「超长」的判定阈值。
 *
 * 低优先级（默认收起、可展开，toggle 挂 aria-expanded）：
 *   - thinking 摘录（msg-thinking，既有）
 *   - tool I/O（msg-tool，既有）
 *   - unknown part 诊断（msg-unknown-part，既有）
 *   - 长附件详情（chat-bubble AttachmentCard，本 todo 新增）
 * 高优先级（永不默认收起）：
 *   - 主正文 / 流式正文 / system 行：内容永远留在 DOM，元素永远可见
 *   - error / aborted：标题、状态、摘要与 retry/quota/action 控件永远可见；
 *     只有 detail 本身超过 HIGH_PRIORITY_DETAIL_COLLAPSE_CHARS 时才提供一个
 *     **默认展开** 的折叠开关，收起只摘掉 detail 区，不摘标题/状态/控件。
 */

/** error/aborted detail 触发折叠的阈值：严格大于才提供开关。 */
export const HIGH_PRIORITY_DETAIL_COLLAPSE_CHARS = 200;

/** 超长 detail 收起后仍保留在标题里的头部字符数。 */
export const HIGH_PRIORITY_TITLE_HEAD_CHARS = 60;

/** 文件名触发附件详情折叠的阈值：严格大于才提供开关（图片附件不折叠）。 */
export const ATTACHMENT_DETAIL_COLLAPSE_CHARS = 60;

/** 折叠摘要里保留的文件名头部字符数。 */
export const ATTACHMENT_NAME_HEAD_CHARS = 24;

/** 超长文本的可见头部：截到 max 个字符并追加一个省略号（超长才截，短文本原样返回）。 */
export function headChars(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
