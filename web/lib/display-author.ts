/**
 * display-author：可见作者名的「页面侧」解析（chat-ux-hierarchy-and-streaming 复选框 7 · B9）
 * =============================================
 * 职责边界（本文件只被 session 页面这类容器调用，展示组件不 import）：
 *   容器先用 agent/instance/team-member 三路业务映射取出候选名，再经本模块过滤，
 *   最后把「已解析的 display author」当作普通字符串 prop 传给 MessageIdentity / ChatBubble。
 * 展示决策（author 与角色标签如何并列、如何去重）在 lib/author-role-display.ts，
 * 由展示组件调用；展示组件不认识 id 格式，也不访问业务映射。
 *
 * B9 约束：裸 id（a_xxx / tmm_xxx / ta_xxx）永远不是可展示的人名——
 * 解析链路上任何一步命中裸 id 就跳过，全部候选都不可用时返回 undefined，
 * 由展示组件回落到安全的角色标签，而不是把 senderId/memberId/instanceId 塞进可见文本。
 */

/** 裸 id 形态：agentId（a_）、团队成员 id（tmm_）、任务实例 id（ta_）+ 小写字母数字。 */
export const RAW_SENDER_ID_PATTERN = /^(?:a|tmm|ta)_[0-9a-z]+$/;

/** 该字符串是否是裸 sender/成员/实例 id（整串判定，不做子串误伤）。 */
export function isRawSenderId(value: unknown): value is string {
  return typeof value === "string" && RAW_SENDER_ID_PATTERN.test(value);
}

/**
 * 按候选顺序解析可展示作者名：
 * - 非字符串 / 空串 / 纯空白 → 跳过；
 * - 命中裸 id → 跳过（B9：裸 id 不进可见文本）；
 * - 第一个通过校验的候选 trim 后返回；全部落空 → undefined（调用方回落角色标签）。
 */
export function resolveDisplayAuthor(
  candidates: ReadonlyArray<string | null | undefined>,
): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed === "") continue;
    if (isRawSenderId(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}
