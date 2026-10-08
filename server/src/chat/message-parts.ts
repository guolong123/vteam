/**
 * 消息 content.parts 过滤工具（F3 QA 缺陷①共享修复）
 * =============================================
 * 群聊（team_group）只允许结论性 text part（reasoning/tool 等过程片段不落库不广播）；
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

/**
 * 可渲染 part 类型：与前端 MsgParts 分发口径一致（text 正文 + reasoning/tool/error
 * 过程卡片）。step-start/step-finish/snapshot/patch 等内部片段前端不渲染——
 * 只含这些类型的「消息」在 UI 上是空消息，不应建行/应清理。
 */
const RENDERABLE_PART_TYPES: ReadonlySet<string> = new Set([
  'text',
  'tool',
  'error',
  'aborted',
]);

/**
 * reasoning/thinking 是否有实际内容：serve 会推空 text 的 reasoning 占位
 * （`{"type":"reasoning","text":""}`），前端展开后是「（无详细思考内容）」空壳，
 * 不算可渲染——避免建出只剩空思考条的「空消息」。
 */
function reasoningHasContent(p: Record<string, unknown>): boolean {
  const c = p.text ?? p.summary ?? p.thoughts ?? p.detail;
  return typeof c === 'string' && c.trim().length > 0;
}

/** parts 中是否存在任一可渲染条目（text 取非 synthetic——合成占位不渲染）。 */
export function hasRenderableContent(parts: unknown): boolean {
  return normalizeParts(parts).some((p) => {
    const type = typeof p.type === 'string' ? p.type : '';
    if (type === 'text') return !p.synthetic && typeof p.text === 'string' && p.text.length > 0;
    if (type === 'reasoning' || type === 'thinking') {
      return reasoningHasContent(p);
    }
    return RENDERABLE_PART_TYPES.has(type);
  });
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
