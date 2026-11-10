/**
 * worker 出口的会话 part 大载荷截断（perf：session-history 80MB 无效传输）。
 *
 * 背景（Lead 线上实测）：控制面 `GET /channels/:id/session-history` 首屏向 worker
 * 取最近 `limit*2` 条 opencode 消息，worker `GET /sessions/:id/messages` 返回**完整**
 * parts（tool 输出/思考全文）；服务端拿到后才在 `convertSessionMessages` 里
 * `capPartPayloads` 截断（2KB/字符串、20 项/数组、深度 4），最终响应仅 ~231KB。
 * 51.2MB 合成会话实测：worker 出口 80MB/701ms，99.7% 字节被服务端丢弃；worker 与
 * server 跨节点时 80MB 传输/JSON parse 就是 10s+（线上 14.23s 的根因）。
 *
 * 修复：把截断**前移到 worker 出口**（`GET /sessions/:id/messages?maxPartChars=2048`），
 * 本模块是纯函数、与服务端 `ChatService.capPartPayloads` 同口径：
 * - 字符串 ≤ maxChars，超出追加 `…（内容过长，已截断）`；
 * - 数组 ≤20 项，超出追加 `…（共 N 项，仅展示前 20 项）`；
 * - 对象递归深度 ≤4（超过深度的子树原样返回，与 server 一致）；
 * - part 的 id/messageID/sessionID/callID/type/tool/time 结构键**原样保留**；
 * - `type='text'` 的 part 自身 `text` **不截断**（服务端 content.text 由 text parts
 *   拼接，截断正文会改变聊天展示；服务端仍会对 parts 内 text 做兜底截断）。
 *
 * 未传 maxPartChars 时不调用本模块（exec-server 侧分支），其它调用方（worker-dispatcher
 * 轮询）行为逐字节不变。
 */

/** 截断参数（只有 maxChars 必填；其余用于单测覆盖，生产用默认值）。 */
export interface MessagePartCapOptions {
  /** 单个字符串字段字符上限（正整数）。 */
  maxChars: number;
  /** 数组最多保留项数（默认 20）。 */
  maxArrayItems?: number;
  /** 对象递归深度上限（默认 4）。 */
  maxDepth?: number;
}

/** 与服务端一致的默认值。 */
export const MESSAGE_PART_CAP_DEFAULT_ARRAY_ITEMS = 20;
export const MESSAGE_PART_CAP_DEFAULT_DEPTH = 4;
/** 字符串截断标记（与服务端 `PART_TRUNCATED_SUFFIX` 同文案）。 */
export const MESSAGE_PART_TRUNCATED_SUFFIX = '…（内容过长，已截断）';

/**
 * part 顶层原样保留的结构/身份键。
 *
 * - 身份键（id/messageID/sessionID/callID）：前端按这些键去重/关联，截断会破坏渲染；
 * - type/tool：渲染分支依据，必须原值；
 * - time：时间戳对象（纯数字），保留可避免无意义的对象重建。
 *
 * 注意：这里的「保留」只作用于**顶层键值**——`state`（工具状态内容）等其余字段
 * 仍会递归截断；`state` 键本身也不会被丢弃。
 */
const PRESERVED_PART_KEYS = new Set([
  'id',
  'messageID',
  'sessionID',
  'callID',
  'type',
  'tool',
  'time',
]);

/** 数组超限截断标记（与服务端同文案）。 */
function arrayTruncatedSuffix(total: number, kept: number): string {
  return `…（共 ${total} 项，仅展示前 ${kept} 项）`;
}

/**
 * 批量截断消息的 parts（返回新数组/新对象，**不 mutate 入参**）。
 *
 * 消息的 `info` 原样保留（体积小、且控制面按 info 判角色/时间）；只处理 `parts`。
 */
export function capMessageParts<T extends { parts: unknown[] }>(
  messages: readonly T[],
  options: MessagePartCapOptions,
): T[] {
  const normalized = normalizeOptions(options);
  if (!normalized) {
    // 非法/缺省 maxChars → 不截断（调用方只在显式传入合法值时调用；防御返回副本）
    return [...messages];
  }
  return messages.map((message) => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return {
      ...message,
      parts: parts.map((part) => capMessagePart(part, options)),
    } as T;
  });
}

/**
 * 单条 part 的截断（顶层结构键保留 + 其余字段递归截断）。
 *
 * 非对象 part（异常数据）按通用值规则处理，保证输出仍是可序列化 JSON。
 */
export function capMessagePart(
  part: unknown,
  options: MessagePartCapOptions,
): unknown {
  const normalized = normalizeOptions(options);
  if (!normalized) {
    return part;
  }
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return capValue(part, 0, normalized);
  }
  const record = part as Record<string, unknown>;
  const isTextPart = record.type === 'text';
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (PRESERVED_PART_KEYS.has(key)) {
      // 结构/身份键：原样保留（见 PRESERVED_PART_KEYS 注释）
      out[key] = value;
      continue;
    }
    if (isTextPart && key === 'text') {
      // 正文不截断：服务端 content.text 由非 synthetic text parts 拼接，截断会改正文
      out[key] = value;
      continue;
    }
    // 其余（tool state 内容、reasoning.text、嵌套对象/数组）递归截断。
    // 深度从 1 起：与 server `capPartPayloads`（part 在 depth=0，字段值 depth=1）对齐。
    out[key] = capValue(value, 1, normalized);
  }
  return out;
}

/** 归一化后的截断参数。 */
interface NormalizedCapOptions {
  maxChars: number;
  maxArrayItems: number;
  maxDepth: number;
}

/** 校验并归一化参数；maxChars 非法（非正整数）→ null（不截断）。 */
function normalizeOptions(
  options: MessagePartCapOptions,
): NormalizedCapOptions | null {
  const maxChars = Number(options?.maxChars);
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    return null;
  }
  const maxArrayItems =
    Number.isInteger(options.maxArrayItems) && options.maxArrayItems! > 0
      ? (options.maxArrayItems as number)
      : MESSAGE_PART_CAP_DEFAULT_ARRAY_ITEMS;
  const maxDepth =
    Number.isInteger(options.maxDepth) && options.maxDepth! > 0
      ? (options.maxDepth as number)
      : MESSAGE_PART_CAP_DEFAULT_DEPTH;
  return { maxChars, maxArrayItems, maxDepth };
}

/**
 * 递归截断任意 JSON 值（字符串/数组/对象）。
 *
 * 深度语义与服务端 `ChatService.capValue` 完全一致：
 * 字符串超限截断、数组超 20 项截断、`depth < maxDepth` 的对象才递归（否则原样返回）。
 */
function capValue(
  value: unknown,
  depth: number,
  options: NormalizedCapOptions,
): unknown {
  if (typeof value === 'string') {
    return value.length <= options.maxChars
      ? value
      : value.slice(0, options.maxChars) + MESSAGE_PART_TRUNCATED_SUFFIX;
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, options.maxArrayItems)
      .map((item) => capValue(item, depth + 1, options));
    if (value.length > options.maxArrayItems) {
      kept.push(arrayTruncatedSuffix(value.length, options.maxArrayItems));
    }
    return kept;
  }
  if (
    value &&
    typeof value === 'object' &&
    depth < options.maxDepth
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = capValue(item, depth + 1, options);
    }
    return out;
  }
  return value;
}
