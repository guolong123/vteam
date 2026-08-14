/**
 * stripInjectedContext：剥离注入到 agent 回复文本中的系统上下文块（前端兜底双保险）。
 *
 * 后端已修复（P1：worker 只聚合本轮 assistant 消息，不再把 [群聊历史消息]/<doclib>
 * 拼入回复），此处为历史残留数据/异常路径的兜底过滤：
 * - `<doclib>...</doclib>` 整体块（含标签本身，跨行非贪婪）
 * - `[群聊历史消息]` 标题行及其后紧跟的 `用户: / Agent:` 历史行（保守剥离，不误伤正文）
 * - 剥离产生的多余连续空行
 *
 * 仅应用于 agent/system 消息文本；user 消息不过滤。
 */
export function stripInjectedContext(text: string): string {
  if (!text) return text;
  let out = text;
  // <doclib>...</doclib> 整体块 + 紧随其后的历史残留行（</doclib> 后若紧跟 `用户:/Agent:` 行）
  out = out.replace(/<doclib>[\s\S]*?<\/doclib>[ \t]*(?:\n?[ \t]*(?:用户|Agent|agent):[^\n]*)*/g, "");
  // 行首 [群聊历史消息] 标记行 + 其后的 用户:/Agent: 历史行（到下一个非历史行边界）
  out = out.replace(/(?:^|\n)[ \t]*\[群聊历史消息\][^\n]*(?:\n[ \t]*(?:用户|Agent|agent):[^\n]*)*/g, "");
  // 清理剥离产生的多余空行并 trim 首尾
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
