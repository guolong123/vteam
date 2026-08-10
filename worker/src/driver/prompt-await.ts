/**
 * T4 prompt 发送 + 轮询完成判定（D2 最重要铁律）。
 *
 * 完成判定（Oracle 实测）：轮询 GET /session/{id}/message，**判定条件 = 存在含
 * `step-finish` part（reason=stop）的 assistant 消息**。不能是"有消息"——实测
 * assistant 消息在 step-start 之前就已出现（parts=[]），abort 后消息只有
 * step-start+reasoning（无 text/step-finish），按"有消息"会被误判为完整回复。
 *
 * 文本聚合：按 messageID 分组 → 过滤 type=text（排除 synthetic 合成文本，工具
 * 调用占位非模型输出）→ 按 part.time.start 时间戳排序 → 串接（D2 多段拼接规则）。
 *
 * 超时：调 abort + 抛 CompletionTimeoutError（携带已收集文本，调用方可展示部分回复）。
 */

import { V1Driver, ServeMessage, ServePart, ServeTokens } from './v1-driver';

export interface AwaitCompletionOptions {
  /** 总超时 ms；默认 60000（计划 D8 总超时 60s + abort） */
  timeoutMs?: number;
  /** 轮询间隔 ms；默认 500（计划 D8） */
  pollMs?: number;
  /** 每次轮询后的回调（调试/进度上报用，T6 事件上送可在此挂钩） */
  onPoll?: (messages: ServeMessage[], elapsedMs: number) => void;
}

/** 会话完成聚合结果。 */
export interface CompletionResult {
  /** 全部 text part 按时间排序拼接的最终回复 */
  text: string;
  /** 原始 parts（含 reasoning/tool 等，T6 事件上送直接透传） */
  parts: ServePart[];
  /** step-finish 的 tokens（实测含 total/input/output/reasoning/cache） */
  tokens?: ServeTokens;
  /** step-finish 的 cost */
  cost?: number;
}

/** 轮询超时（60s 未出现 step-finish(reason=stop)），已 abort + 携带部分回复。 */
export class CompletionTimeoutError extends Error {
  readonly sessionID: string;
  readonly result: CompletionResult;

  constructor(sessionID: string, result: CompletionResult) {
    super(
      `[prompt-await] 会话 ${sessionID} 等待完成超时（60s 内未收到 step-finish(reason=stop)）`,
    );
    this.name = 'CompletionTimeoutError';
    this.sessionID = sessionID;
    this.result = result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 合并轮询结果：serve 的 GET /session/{id}/message 返回**整个会话累积列表**
 * （非增量），且同一条 assistant 消息的 parts 会在完成过程中逐步填充——
 * 按 info.id 用最新版本整体替换，避免聚合重复/过期 parts。
 */
function mergeMessages(collected: ServeMessage[], incoming: ServeMessage[]): ServeMessage[] {
  const byId = new Map(collected.map((m) => [m.info?.id, m]));
  for (const m of incoming) {
    byId.set(m.info?.id, m);
  }
  return [...byId.values()];
}

/** 完成判定核心：遍历 assistant 消息找含 step-finish(reason=stop) 的 part。 */
export function findFinish(messages: ServeMessage[]): ServePart | undefined {
  for (const m of messages) {
    if (m.info?.role !== 'assistant') {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'step-finish' && p.reason === 'stop') {
        return p;
      }
    }
  }
  return undefined;
}

/**
 * 文本聚合（D2 多段拼接规则）：
 * 只取 assistant 消息（模型输出；user 输入不应进入最终回复），
 * 过滤 type=text 且非 synthetic（合成文本=工具调用占位，排除避免污染最终回复），
 * 按 part.time.start 时间戳升序串接。
 */
export function aggregateText(messages: ServeMessage[]): string {
  const texts = messages
    .filter((m) => m.info?.role === 'assistant')
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text' && !p.synthetic)
    .sort((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0));
  return texts.map((p) => p.text ?? '').join('');
}

/** 从已收集消息构建聚合结果（tokens/cost 取 step-finish part）。 */
function buildResult(messages: ServeMessage[]): CompletionResult {
  const finish = findFinish(messages);
  return {
    text: aggregateText(messages),
    parts: messages.flatMap((m) => m.parts ?? []),
    ...(finish?.tokens ? { tokens: finish.tokens } : {}),
    ...(finish?.cost !== undefined ? { cost: finish.cost } : {}),
  };
}

/**
 * 轮询等待会话完成：默认 500ms 间隔 / 60s 总超时。
 * 完成 → 返回聚合结果；超时 → abort + 抛 CompletionTimeoutError（带已收集文本）。
 */
export async function awaitCompletion(
  driver: V1Driver,
  sessionID: string,
  options: AwaitCompletionOptions = {},
): Promise<CompletionResult> {
  const { timeoutMs = 60_000, pollMs = 500, onPoll } = options;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let collected: ServeMessage[] = [];

  let finish: ServePart | undefined;
  while (Date.now() < deadline) {
    const messages = await driver.getMessages(sessionID);
    collected = mergeMessages(collected, messages);
    onPoll?.(messages, Date.now() - startedAt);
    finish = findFinish(collected);
    if (finish) {
      break;
    }
    await sleep(pollMs);
  }

  const result = buildResult(collected);
  if (!finish) {
    try {
      await driver.abort(sessionID);
    } catch {
      // abort 失败不掩盖超时错误（双保险中 HTTP abort 已尽力）
    }
    throw new CompletionTimeoutError(sessionID, result);
  }
  return result;
}

/** sendMessage → awaitCompletion 组合（T6 单次下发的标准入口）。 */
export async function sendAndAwait(
  driver: V1Driver,
  sessionID: string,
  input: Parameters<V1Driver['sendMessage']>[1],
  options: AwaitCompletionOptions = {},
): Promise<CompletionResult> {
  await driver.sendMessage(sessionID, input);
  return awaitCompletion(driver, sessionID, options);
}

/**
 * T10：消息增量去重——挂在 awaitCompletion 的 onPoll 上提取「新增消息」的 parts。
 * serve 轮询返回整个会话的**累积列表**（非增量），同一 message id 在后续轮询中
 * 可能被逐步补全 parts；本辅助按 message id 粗粒度去重（任务约定：与上次已上送
 * 的消息 id 对比，只送新增），保证 message.part.delta 事件不重复上送整批历史。
 */
export class MessageDeltaTracker {
  private readonly sentIds = new Set<string>();

  /** 返回本轮 messages 中此前未上送过的消息的 parts（扁平拼接）；无新增返回空数组。 */
  extractNewParts(messages: ServeMessage[]): ServePart[] {
    const fresh: ServePart[] = [];
    for (const m of messages) {
      const id = m.info?.id;
      if (!id || this.sentIds.has(id)) {
        continue;
      }
      this.sentIds.add(id);
      fresh.push(...(m.parts ?? []));
    }
    return fresh;
  }

  /** 重置已上送集合（多轮执行复用同一实例时隔离）。 */
  reset(): void {
    this.sentIds.clear();
  }
}
