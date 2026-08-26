/**
 * 消息 content.parts 过滤工具（F3 QA 缺陷①共享修复）
 * =============================================
 * 群聊（task_group）只允许结论性 text part（reasoning/tool 等过程片段不落库不广播）；
 * 私聊（private）保留全量 parts（前端折叠卡片展示 reasoning/tool）。
 *
 * 两条回流路径必须共用同一套过滤，保证行为一致（缺陷根源：delta 路径过滤、
 * task.completed 终态化路径不过滤）：
 * - ingress message.part.delta（worker-event.ingress.ts）——流式累积
 * - worker-dispatcher.handleTaskCompleted 终态化——最终落库
 */

/** 归一化 parts：非数组 → []；剔除 null/非对象条目。 */
export function normalizeParts(parts: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts.filter(
    (p): p is Record<string, unknown> => p !== null && typeof p === 'object',
  );
}

/** 结论性 parts（群聊只保留此子集）：type==='text' && 非 synthetic（reasoning/tool 排除）。 */
export function extractConclusionParts(
  parts: unknown,
): Array<Record<string, unknown>> {
  return normalizeParts(parts).filter((p) => p.type === 'text' && !p.synthetic);
}

/** 从 parts 拼接结论文本：type==='text' 且非 synthetic 的 part.text 顺序串接。 */
export function concatText(parts: unknown[]): string {
  return (parts as Array<Record<string, unknown>>)
    .filter((p) => p.type === 'text' && !p.synthetic)
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('');
}
