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
 * 注入提示块标记（由服务端 worker-dispatcher 组装 prompt 时前置，见
 * worker-dispatcher.ts 的【任务上下文】/【团队上下文】/【群聊回复要求】拼接）。
 * 正常情况下这些块只存在于 user 触发消息（服务端有意回写展示）；当 worker 异常
 * 地把「拼好的整段用户提示」当流式增量回送时，其 text 即以这些标记开头。
 */
export const INJECTED_PROMPT_MARKERS = [
  '【任务上下文】',
  '【团队上下文】',
  '【群聊回复要求】',
] as const;

/**
 * 是否「注入提示」part：type==='text' 且**去除首尾空白后**的文本以任一注入标记
 * **开头**——即服务端注入块 + 用户原文拼接成的整段提示被误当正文。
 * 仅精确标记前缀命中才算，正文里出现相似字样（如 '【重要】...'）或标记不在开头
 * 的 text 一律不匹配，避免误杀 agent 正常输出。
 */
export function isInjectedPromptPart(p: Record<string, unknown>): boolean {
  if (p.type !== 'text') return false;
  const text = typeof p.text === 'string' ? p.text : '';
  const trimmed = text.trim();
  return INJECTED_PROMPT_MARKERS.some((marker) => trimmed.startsWith(marker));
}

/** 归一化 parts 后剔除注入提示 part（agent 消息不得把服务端注入 prompt 当正文渲染）。 */
export function stripInjectedPromptParts(
  parts: unknown,
): Array<Record<string, unknown>> {
  return normalizeParts(parts).filter((p) => !isInjectedPromptPart(p));
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

/** part.id（非空字符串才算有效标识；缺失/空串 → undefined，保留追加语义）。 */
function partIdOf(p: Record<string, unknown>): string | undefined {
  return typeof p.id === 'string' && p.id.length > 0 ? p.id : undefined;
}

/** 按 part.id 去重：保留最后一次出现的位置与内容（对齐 web MsgParts 的 procParts 去重口径，
 *  修复历史脏数据里同一次工具调用重复落多个快照 → 同一次调用出多张卡）。 */
function dedupePartsById(
  parts: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const id = partIdOf(parts[i]);
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(parts[i]);
  }
  return out.reverse();
}

/**
 * 流式 parts 合并：同一 part.id 的旧快照被新快照**原地替换**（last-write-wins），
 * 新出现的 id 按到达顺序追加到末尾；无 id 的 part 保持追加语义。
 *
 * 背景：worker 改为「重发状态变化」后，同一 part.id 会随每轮快照重复上送，
 * 旧实现 `[...old, ...new]` 无条件追加 → 同一 part 在 content.parts 里堆出多份
 * 快照（UI 上表现为重复的工具卡/重复正文）。
 *
 * `options.monotonicText`：**流式单调守卫**——仅对同 id 的 text/reasoning/thinking
 * part 生效，拒绝会让文本回退的快照（更短、或与旧文本无前后缀包含关系），保留更长/
 * 更完整的旧快照；tool/step-* 等非文本 part 一律保持 last-write-wins（工具状态流转、
 * 终态替换不受影响）。开启方仅限 ingress message.part.delta 累积路径（见
 * worker-event.ingress handleMessagePartDelta）；终态化（task.completed）走
 * worker-dispatcher 的整段 content 覆写，不经本函数。
 */
export interface MergePartsOptions {
  monotonicText?: boolean;
}

/** 会随流式生成累积增长的文本类 part 类型（单调守卫作用域）。 */
const TEXTUAL_PART_TYPES: ReadonlySet<string> = new Set(['text', 'reasoning', 'thinking']);

/** 文本类 part 的候选文本字段拼接（与 worker textGrowthFingerprint 同口径）。 */
function partTextualValue(p: Record<string, unknown>): string {
  let out = '';
  for (const key of ['text', 'summary', 'thoughts', 'detail'] as const) {
    const v = p[key];
    if (typeof v === 'string') out += v;
  }
  return out;
}

/**
 * 流式单调守卫：同 id 的文本类快照 `newPart` 是否可覆盖 `oldPart`。
 * - 任一非文本类 → true（tool 状态流转等保持 last-write-wins）
 * - 类型不同（同 id 文本 part 类型不应变化；如 reasoning 增量被合成标成 text）→
 *   只在新快照文本**更长**（更完整，可顺带修正类型）时接受，否则保留旧类型
 * - 类型同：新更短 → 拒绝；等长 → 仅文本相同才接受；更长 → 需为前缀扩展
 *   （append-only 累积）或旧文本为其后缀（新快照是更完整全文、旧的是重连后截断的
 *   后缀片段）才接受；否则拒绝（防止无关改写/回退覆盖已渲染的更长文本）
 */
function mayReplaceTextualPart(
  oldPart: Record<string, unknown>,
  newPart: Record<string, unknown>,
): boolean {
  const oldType = typeof oldPart.type === 'string' ? oldPart.type : '';
  const newType = typeof newPart.type === 'string' ? newPart.type : '';
  if (!TEXTUAL_PART_TYPES.has(oldType) || !TEXTUAL_PART_TYPES.has(newType)) {
    return true;
  }
  const oldText = partTextualValue(oldPart);
  const newText = partTextualValue(newPart);
  if (oldType !== newType) {
    return newText.length > oldText.length;
  }
  if (newText.length < oldText.length) {
    return false;
  }
  if (newText.length === oldText.length) {
    return newText === oldText;
  }
  if (oldText.length === 0) {
    return true;
  }
  return newText.startsWith(oldText) || newText.endsWith(oldText);
}

export function mergePartsById(
  oldParts: unknown,
  newParts: unknown,
  options: MergePartsOptions = {},
): Array<Record<string, unknown>> {
  const merged = dedupePartsById(normalizeParts(oldParts));
  const incoming = normalizeParts(newParts);
  const indexById = new Map<string, number>();
  for (let i = 0; i < merged.length; i += 1) {
    const id = partIdOf(merged[i]);
    if (id !== undefined) indexById.set(id, i);
  }
  for (const p of incoming) {
    const id = partIdOf(p);
    if (id !== undefined) {
      const at = indexById.get(id);
      if (at !== undefined) {
        if (options.monotonicText && !mayReplaceTextualPart(merged[at], p)) {
          continue;
        }
        merged[at] = p;
        continue;
      }
      indexById.set(id, merged.length);
    }
    merged.push(p);
  }
  return merged;
}

/** tool part 非终态状态集（对齐 web toToolStatus 的 running 口径）。 */
const NON_TERMINAL_TOOL_STATUS: ReadonlySet<string> = new Set([
  'running',
  'streaming',
  'pending',
  'queued',
]);

/** 敏感命令工具名（对齐 web isSecretCommandPart）。 */
function isSecretCommandToolName(p: Record<string, unknown>): boolean {
  const raw = p.tool ?? p.name;
  const name = typeof raw === 'string' ? raw : '';
  return name === 'secret_command' || name.endsWith('_secret_command');
}

/** 工具 I/O 是否零信息量（缺失/null/空串/空数组/空对象）。 */
function isEmptyToolIO(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * 残留行的 content 是否**只由「非终态且无任何 I/O 的 tool part」构成**——
 * 即并发 delta 建行竞态/未收尾轮次留下的空壳工具卡行。
 *
 * 与 `hasRenderableContent` 刻意分开：后者把 `tool` 无条件算作可渲染（流式中
 * in-flight 工具卡必须算，否则行永远不落地），因此无法区分「有内容的工具卡」与
 * 「永远 running + 输入 {} 的空壳」。本函数只服务终态清扫：
 * - 有真实 text / reasoning / 终态工具输出 / error / aborted → false（保留原处理）
 * - 纯 pending/running tool 且 input、output 皆空 → true（应删，不应收敛为 sent）
 *
 * `opts.secretAwaiting`：会话存在 pending `secret_input` question 时，
 * running 的 `secret_command` 工具卡实为「等待用户填写」（web 派生的
 * awaiting-input 态），必须保留 → 返回 false。
 */
export function isStaleToolOnlyContent(
  content: unknown,
  opts: { secretAwaiting?: boolean } = {},
): boolean {
  const parts = normalizeParts(
    (content as { parts?: unknown } | null | undefined)?.parts,
  );
  if (parts.length === 0) return false;
  for (const p of parts) {
    if (p.type !== 'tool') return false;
    const state =
      p.state !== null && typeof p.state === 'object'
        ? (p.state as Record<string, unknown>)
        : undefined;
    const rawStatus = state?.status ?? p.status;
    const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
    if (!NON_TERMINAL_TOOL_STATUS.has(status)) return false;
    if (opts.secretAwaiting && isSecretCommandToolName(p)) return false;
    if (!isEmptyToolIO(state?.input ?? p.input)) return false;
    if (!isEmptyToolIO(state?.output ?? p.output)) return false;
  }
  return true;
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
