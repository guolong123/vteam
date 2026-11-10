/**
 * 剥离外部渠道入站正文的渠道传输前缀。
 *
 * 企微/通用 webhook 链路落库的正文形如 `[WeCom:<展示名>|from 群聊|私聊] 正文`：
 * 这个标记是给 Agent 判断回复场景的（`worker-dispatcher` 依赖它），不是给最终用户看的。
 * 群聊消息与外部用户回看视图里，展示名已经由身份行/头像展示；且前缀里是**入站当时的
 * 展示名快照**，外部用户改名后继续显示会与新名字割裂（用户反馈：改了名称群里没变）。
 *
 * 只剥行首标记（正文中间用户自己写的同形文本不动），并保留其后的正文。
 */
export function stripExternalChannelPrefix(text: string): string {
  return text.replace(/^\s*\[WeCom:[^\]]*\]\s*/, "");
}
