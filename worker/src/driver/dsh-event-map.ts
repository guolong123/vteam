/**
 * dsh 事件映射（P2）——DSH `session.event` → vteam 事件与 `DriverContent`。
 *
 * 这是 DshDriver 的**核心翻译层**，价值来自 P0 的实测基线（见
 * `md-docs/dsh-worker-p0-poc-report.md`）：
 *
 * | DSH 事件 | vteam 产物 |
 * |---|---|
 * | `assistant/message{message, usage}` | `DriverMessage` + 合成 `step-finish` part（带 tokens） |
 * | `turn/end{reason.kind}` | 本轮终态（`completed`/`aborted`/`error`），驱动完成判定 |
 * | `tool/call{callId,name,arguments}` | `tool` 类 part（status=running） |
 * | `tool/result{message,error}` | `tool` 类 part 更新（status=completed/error） |
 * | `step/start` / `step/end` | `step-start` / 载体（step-finish 由 assistant/message 合成） |
 * | `session.status{status}` | 会话级状态（running/idle） |
 *
 * 三条硬约束（来自既有 v2 实现的教训）：
 * 1. **step-finish 是本轮完成判定与用量落库的锚点**：控制面按 `part.type==='step-finish'`、
 *    `part.id='${messageID}:step-finish'`、`reason==='stop'` 判本轮完成
 *    （`server/src/chat/worker-dispatcher.ts` 的 `findStepFinishPartKey`）。
 *    缺失 = 整轮不被认作完成，用量记 0。
 * 2. **`messageID` 不可改名**：控制面按它关联消息。
 * 3. **不做 token 级流式**：DSH 的 `session/update` 是 committed 粒度（P0 实测），
 *    故 vteam 的「首字超时/活性指纹」只能基于**整段文本到达**，不能基于增量。
 *
 * @module driver/dsh-event-map
 */

import type {
  DriverContent,
  DriverMessage,
  DriverMessageInfo,
  DriverTokenUsage,
} from './opencode-driver';

/** DSH 的一条 `session.event` 载荷（P0 实测形状；多余字段原样透传）。 */
export interface DshSessionEvent {
  /** 事件类型（如 `assistant/message`、`turn/end`、`tool/call`）。 */
  type: string;
  /** 事件数据（各类型不同）。 */
  data?: Record<string, unknown>;
  /** 事件序号（DSH 持久化事件的单调序号；缺省时由调用方按到达顺序补）。 */
  seq?: number;
}

/** DSH `turn/end` 的 reason（P0 实测：`{kind:'completed'}` / `{kind:'aborted',reason:{kind:'user'}}`）。 */
export interface DshTurnEndReason {
  kind?: string;
  reason?: { kind?: string; [key: string]: unknown };
  error?: { message?: string; code?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** 一轮的终态分类（vteam 口径）。 */
export type DshTurnOutcome = 'completed' | 'aborted' | 'error';

/**
 * 归一 DSH 的 `turn/end` reason → vteam 终态。
 *
 * 为什么必须显式分类：控制面用"是否发出 task.completed"区分成功与失败——
 * 被取消的一轮**不发** task.completed（否则会把中断当成功落库）。
 */
export function classifyTurnEnd(reason: DshTurnEndReason | undefined): DshTurnOutcome {
  const kind = reason?.kind;
  if (kind === 'completed') return 'completed';
  if (kind === 'aborted') return 'aborted';
  if (kind === 'error') return 'error';
  // 未知 kind（DSH 可能新增）→ 按 error 处理：宁可报失败，不可把未完成当成功。
  return kind === undefined ? 'error' : 'error';
}

/** `turn/end` → `step-finish` 的 reason 字段值（控制面认 `stop` 为正常完成）。 */
export function stepFinishReason(outcome: DshTurnOutcome): string {
  switch (outcome) {
    case 'completed':
      return 'stop';
    case 'aborted':
      return 'aborted';
    case 'error':
      return 'error';
  }
}

/**
 * DSH `usage` → vteam `DriverTokenUsage`。
 *
 * P0 实测 DSH 的 usage 形状：`{inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens?, thoughtTokens?}`
 * （`packages/core/agent-loop/src/agent.ts` 的 `assistant/message.usage`）。
 *
 * ⚠️ 字段名是 **camelCase**（DSH 口径），与 vteam 的 `DriverTokenUsage`
 * （`input`/`output`/`total`/`reasoning`/`cache:{read,write}`，snake 风格语义但 camel 嵌套）不同。
 */
export function mapUsage(raw: unknown): DriverTokenUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const result: DriverTokenUsage = {};
  const input = num(u.inputTokens);
  const output = num(u.outputTokens);
  const total = num(u.totalTokens);
  const reasoning = num(u.thoughtTokens);
  const cacheRead = num(u.cacheReadTokens);
  const cacheWrite = num(u.cacheWriteTokens);

  if (input !== undefined) result.input = input;
  if (output !== undefined) result.output = output;
  if (total !== undefined) result.total = total;
  if (reasoning !== undefined) result.reasoning = reasoning;
  if (cacheRead !== undefined || cacheWrite !== undefined) {
    result.cache = {};
    if (cacheRead !== undefined) result.cache.read = cacheRead;
    if (cacheWrite !== undefined) result.cache.write = cacheWrite;
  }
  // 全部字段都缺 → 视为"无用量"（不要返回空对象让上层误以为有数据）
  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * 从 `assistant/message` 事件提取文本与消息 id。
 *
 * DSH 的 message 形状：`{id?, content: [{type:'text', text}], source:{provider,model}, ...}`
 * （P0 实测 `content: [{"type":"text","text":"PONG"}]`）。
 */
export interface DshAssistantMessageData {
  messageID: string;
  text: string;
  reasoning: string;
  providerID?: string;
  modelID?: string;
  usage?: DriverTokenUsage;
  /** 原始 message（供渲染层兜底）。 */
  raw: Record<string, unknown>;
}

/** 读取 DSH `assistant/message` 的 data。 */
export function readAssistantMessage(data: Record<string, unknown> | undefined): DshAssistantMessageData | null {
  if (data === undefined) return null;
  const message = asRecord(data.message);
  if (message === null) return null;

  const messageID = typeof message.id === 'string' && message.id.length > 0 ? message.id : undefined;
  if (messageID === undefined) return null;

  const content = Array.isArray(message.content) ? message.content : [];
  let text = '';
  let reasoning = '';
  for (const block of content) {
    const b = asRecord(block);
    if (b === null) continue;
    const type = b.type;
    const value = typeof b.text === 'string' ? b.text : '';
    if (type === 'text') text += value;
    // DSH 的 reasoning block 类型名（P0 未直接观测到，按 pi-ai/DSH 约定兼容两种）
    else if (type === 'reasoning' || type === 'thinking' || type === 'thought') reasoning += value;
  }

  const source = asRecord(message.source);
  const providerID = source !== null && typeof source.provider === 'string' ? source.provider : undefined;
  const modelID = source !== null && typeof source.model === 'string' ? source.model : undefined;

  return {
    messageID,
    text,
    reasoning,
    providerID,
    modelID,
    usage: mapUsage(data.usage),
    raw: message,
  };
}

/**
 * 从 `tool/call` / `tool/result` 事件构造 tool 类 part。
 *
 * DSH 形状（P0 实测）：
 * - `tool/call{callId, name, arguments(tool 名)}`
 * - `tool/result{message:{content, isError, toolCallId}, error?}`
 *
 * vteam 侧渲染读 `part.tool` / `part.state.{status,input,output}`。
 */
export interface DshToolPart {
  part: DriverContent;
  /** tool call id（与 result 配对）。 */
  callId: string;
}

/** 读取 `tool/call` 的 part（status=running）。 */
export function readToolCall(
  data: Record<string, unknown> | undefined,
  fallbackMessageID: string,
): DshToolPart | null {
  if (data === undefined) return null;
  const callId = typeof data.callId === 'string' ? data.callId : undefined;
  const name = typeof data.name === 'string' ? data.name : undefined;
  if (callId === undefined || name === undefined) return null;

  return {
    callId,
    part: {
      id: `tool:${callId}`,
      messageID: fallbackMessageID,
      type: 'tool',
      tool: name,
      state: {
        status: 'running',
        input: data.arguments,
        time: { start: Date.now() },
      },
      time: { start: Date.now() },
    },
  };
}

/** 读取 `tool/result` 的 part 更新（status=completed / error）。 */
export function readToolResult(
  data: Record<string, unknown> | undefined,
  fallbackMessageID: string,
): DshToolPart | null {
  if (data === undefined) return null;
  const message = asRecord(data.message);
  if (message === null) return null;

  const callId =
    (typeof message.toolCallId === 'string' && message.toolCallId) ||
    (typeof data.callId === 'string' && data.callId) ||
    undefined;
  if (callId === undefined) return null;

  const isError = message.isError === true || asRecord(data.error) !== null;
  const content = Array.isArray(message.content) ? message.content : [];
  let output = '';
  for (const block of content) {
    const b = asRecord(block);
    if (b !== null && typeof b.text === 'string') output += b.text;
  }

  return {
    callId,
    part: {
      id: `tool:${callId}`,
      messageID: fallbackMessageID,
      type: 'tool',
      tool: undefined,
      state: {
        status: isError ? 'error' : 'completed',
        output,
        metadata: data.error === undefined ? undefined : data.error,
        time: { end: Date.now() },
      },
      time: { end: Date.now() },
    },
  };
}

/**
 * 把 `tool/result` 的 part 合并到 `tool/call` 的 part 上。
 *
 * ⚠️ **不能整体替换 `state`**：`readToolResult` 只产出 `status/output/metadata/time`，
 * 既没有 `tool` 名也没有 `input`。若直接用结果 part 覆盖调用 part（服务端
 * `mergePartsById` 是 last-write-wins，驱动内也是整体赋值），工具调用就会
 * **丢掉「工具名」和「入参」** —— 前端只看得见输出，看不到"执行了什么命令"。
 *
 * 故这里做浅合并：名字、入参等只在调用阶段存在的字段一律保留。
 */
export function mergeToolPart(
  prev: DriverContent | undefined,
  next: DriverContent,
): DriverContent {
  if (prev === undefined) return next;
  const prevState = asRecord(prev.state as unknown) ?? {};
  const nextState = asRecord(next.state as unknown) ?? {};
  const prevTime = asRecord(prev.time as unknown) ?? {};
  const nextTime = asRecord(next.time as unknown) ?? {};
  return {
    ...prev,
    ...next,
    tool: next.tool ?? prev.tool,
    state: { ...prevState, ...nextState },
    time: { ...prevTime, ...nextTime },
  } as DriverContent;
}

/**
 * 合成 `step-finish` part（**本轮完成锚点**）。
 *
 * 为什么必须合成：DSH 没有 vteam 需要的 `step-finish` 概念，而控制面
 * （`worker-dispatcher.ts` 的 `findStepFinishPartKey`）按它判本轮完成并落库用量。
 * v2 驱动同样是从消息 finish 合成（`v2-driver.ts:1413-1425`），本函数对齐其口径：
 *
 * - `id` 固定为 `${messageID}:step-finish`（跨轮询/事件两路**稳定**，否则控制面会存双份）
 * - `type` = `'step-finish'`
 * - `reason` = `stop` / `aborted` / `error`（控制面认 `stop` 为正常完成）
 * - `tokens` = 该轮 usage（P0 实测 DSH 会给出完整拆分）
 *
 * @param messageID - 承载该轮的 assistant 消息 id。
 * @param outcome - 轮终态。
 * @param usage - 该轮 usage（缺省 = 不带上 tokens，控制面会回退到指纹去重）。
 */
export function synthesizeStepFinish(
  messageID: string,
  outcome: DshTurnOutcome,
  usage?: DriverTokenUsage,
): DriverContent {
  const part: DriverContent = {
    id: `${messageID}:step-finish`,
    messageID,
    type: 'step-finish',
    reason: stepFinishReason(outcome),
    time: { end: Date.now() },
  };
  if (usage !== undefined) part.tokens = usage;
  return part;
}

/**
 * 把 DSH `assistant/message` 投影成 vteam `DriverMessage`（含合成 step-finish）。
 *
 * 这是 `getMessages` 的实现基础（DSH 无累积消息 API，驱动的消息镜像由事件累积而来）。
 */
export function toDriverMessage(
  assistant: DshAssistantMessageData,
  outcome: DshTurnOutcome | undefined,
): DriverMessage {
  const parts: DriverContent[] = [];

  if (assistant.reasoning.length > 0) {
    parts.push({
      id: `${assistant.messageID}:reasoning`,
      messageID: assistant.messageID,
      type: 'reasoning',
      text: assistant.reasoning,
    });
  }
  if (assistant.text.length > 0) {
    parts.push({
      id: `${assistant.messageID}:text`,
      messageID: assistant.messageID,
      type: 'text',
      text: assistant.text,
    });
  }
  // 完成锚点：只有知道终态时才合成（否则控制面会提前认为本轮结束）
  if (outcome !== undefined) {
    parts.push(synthesizeStepFinish(assistant.messageID, outcome, assistant.usage));
  }

  const info: DriverMessageInfo = {
    id: assistant.messageID,
    role: 'assistant',
    time: { completed: Date.now() },
  };
  if (assistant.providerID !== undefined) info.providerID = assistant.providerID;
  if (assistant.modelID !== undefined) info.modelID = assistant.modelID;

  return { info, parts };
}

/** 安全转 record（非对象/null/数组 → null）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
