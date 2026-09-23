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
 * 超时：**首字超时**（时限内既无非空 text part、也无 reasoning part → 调 abort +
 * 抛 CompletionTimeoutError，携带已收集文本）。reasoning part **存在即算已响应**
 * （opencode 实测先建 reasoning 空壳、思考结束才一次性写入文本，故不能要求文本非空），
 * 长时间纯思考不被误杀。首字出现后**无完成超时**（长期任务持续轮询到 step-finish，
 * 判死由上层 server AGENT_IDLE_TIMEOUT_MS 负责，worker 只管「有活动就继续」）——只有
 * 「模型完全没响应」才报错。
 */

import { V1Driver, ServeMessage, ServePart, ServeTokens } from './v1-driver';

export interface AwaitCompletionOptions {
  /**
   * 首字超时 ms（时限内既无非空 text part、也无 reasoning part → abort + 抛
   * CompletionTimeoutError）；默认 300000（对齐 server FIRST_TOKEN_TIMEOUT_MS = 300000）。
   * reasoning part 存在即算已响应（空壳也算：思考期 opencode 不落文本），长时间思考不被误杀。
   * 首字出现后无完成超时（持续等待 step-finish，不 abort）。
   */
  firstTokenTimeoutMs?: number;
  /** 轮询间隔 ms；默认 500（计划 D8） */
  pollMs?: number;
  /** 每次轮询后的回调（调试/进度上报用，T6 事件上送可在此挂钩） */
  onPoll?: (messages: ServeMessage[], elapsedMs: number) => void;
  /**
   * P1 会话复用修复：基线消息 id 集合——sendMessage **前**拉取的会话现有消息 id。
   * 复用同一 opencode 会话时，完成判定/文本聚合/首字判定/onPoll 只处理基线之后
   * 新增的消息，历史轮次的 step-finish 与回复文本不再误命中本轮（P1 回复错乱根因）。
   * 缺省/空集合 → 全部视为本轮（新会话无历史，保持原语义）。
   */
  baselineIds?: Set<string>;
  /**
   * T17 serve 日志模型错误检测：每轮轮询在 extractMessageError 检测之后调用。
   * 参数 = serve 最近错误日志行（serveErrorReader 提供）。返回 true = 应提前失败
   * （abort + 抛 CompletionTimeoutError，错误文案用 serve 错误文本而非「模型无任何输出」）；
   * false = 忽略（防止误杀正常日志）。serve 对 Rate limit / Free usage 等 APIError
   * 只写 stderr 不透传 message.info.error——本回调是这些错误的唯一感知通道。
   */
  onServeError?: (errorText: string) => boolean;
  /**
   * T17 serve 最近错误日志行读取器（数据源：OpencodeServer.recentErrors()，exec-server
   * 接线注入）。参数 = 当前 opencode 会话 id（用于剔除其它会话的历史错误，stale 隔离）；
   * 缺省 = 不检测 serve 日志（保持原行为）。与 onServeError 同时缺省/同时存在。
   */
  serveErrorReader?: (sessionID: string) => string[];
  /**
   * 原始 serve 日志尾部读取器（数据源：OpencodeServer.recentLogTail()）。模型错误不可提取时，
   * 用它把**原始日志行**附进失败原因，使失败始终携带证据（而非只有一句笼统文案）。
   * 参数 = 当前会话 id；缺省 = 不附证据（保持原行为）。
   */
  serveLogReader?: (sessionID: string) => string[];
  /** 附进失败原因的原始日志行数上限；默认 20。 */
  serveLogTailLines?: number;
  /**
   * T17-stale 陈旧隔离：本轮运行开始前已存在的 serve 错误行基线（sendAndAwait 在
   * sendMessage 前经 serveErrorReader 快照，语义对齐 P1 baselineIds）。
   * 快检只触发基线之外**新追加**的行——复用会话/日志文件回退（recentErrors 读文件尾部，
   * 跨 serve 重启不清）场景下，上一轮失败的旧错误行不再秒杀新一轮。线上实测根因：
   * vLLM 400 错误行在文件残留 30 分钟，每轮首 poll 即 abort（`模型调用报错：\` 死循环）。
   * 直接调 awaitCompletion（无基线）→ 首轮读到的行即可触发（保持原快检语义，存量单测不变）。
   */
  baselineServeErrorLines?: Set<string> | string[];
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

/**
 * 从 serve part 提取实际错误详情（防御：part.error 可能缺失/非对象，text 可能缺失）。
 * 优先级：error.message > part.text（error/step-finish part 的 text 通常承载具体报错）> 兜底。
 */
function extractPartError(p: ServePart): string {
  const err = p.error;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') {
      return message;
    }
  }
  if (typeof p.text === 'string' && p.text.trim() !== '') {
    return p.text.trim();
  }
  return '未知错误（serve 未透传错误详情）';
}

/** 卡在工具循环的诊断文案（step-finish(reason=tool-calls)：完成但循环调工具未产出正文）。 */
const TOOL_LOOP_REASON =
  '模型长时间在工具调用阶段（tool-calls 循环）未产出正文——可能模型卡在工具调用循环或模型输出异常';

/**
 * 从 assistant 消息的 `info.error`（serve 直接透传的模型调用错误，如 APIError）提取
 * 首个非 Aborted 的错误文本；无模型错误/仅 Aborted → null。
 *
 * 背景（实测）：serve 用错误凭据调用模型时，assistant 消息 **parts=[]**（无 error part、
 * 无 step-finish），错误落在 `message.info.error`（如
 * `{name:'APIError', data:{message:'Invalid API key.', statusCode:401, isRetryable:false}}`）
 * ——原实现只查 parts 漏了该字段，导致用户只见笼统「模型无任何输出」。
 *
 * - Aborted（MessageAbortedError）**跳过**：aborted 会话可复用（用户确认），非模型调用
 *   失败，不当作可抛错误（awaitCompletion 据此不提前抛）。
 * - 提取优先级：`error.data?.message` > `error.message` > `error.name`（对齐 APIError
 *   {name, data:{message, statusCode}} 结构）；statusCode 存在时附 ` (HTTP <code>)`。
 */
function extractMessageError(messages: ServeMessage[]): string | null {
  for (const m of messages) {
    if (m.info?.role !== 'assistant') {
      continue;
    }
    const err = m.info.error;
    if (!err || typeof err !== 'object') {
      continue;
    }
    const record = err as { name?: unknown; data?: unknown; message?: unknown };
    const name = typeof record.name === 'string' ? record.name : '';
    // Aborted 跳过（aborted 会话可复用，非模型调用失败，不提前抛）
    if (name.toLowerCase().includes('aborted')) {
      continue;
    }
    const data =
      record.data && typeof record.data === 'object'
        ? (record.data as { message?: unknown; statusCode?: unknown })
        : undefined;
    const detail = [
      data && typeof data.message === 'string' && data.message.trim() !== ''
        ? data.message.trim()
        : undefined,
      typeof record.message === 'string' && record.message.trim() !== ''
        ? record.message.trim()
        : undefined,
      name !== '' ? name : undefined,
    ].find((v): v is string => v !== undefined);
    if (detail === undefined) {
      continue;
    }
    const statusCode =
      data && typeof data.statusCode === 'number' ? data.statusCode : undefined;
    return statusCode !== undefined ? `${detail} (HTTP ${statusCode})` : detail;
  }
  return null;
}

/**
 * 从 serve 日志行提取干净的模型错误文本（onServeError 命中行的展示文本）。
 * 实测两种形态：
 *   a) `message="stream error" ... error.error="AI_APICallError: Rate limit exceeded. Please try again later."`
 *   b) `message="share subscriber failed" ... cause="Cause([Fail(ProviderModelNotFoundError: Model not found: …)])"`
 * 提取优先级（取**最深可用细节**，避免把整行结构化日志当原因）：
 *   1. `error.error="..."`（APIError 承载具体模型调用错误）
 *   2. `cause="..."`（流/订阅失败的嵌套原因；剥掉 `Cause([Fail(` / `)])` 包装）
 *   3. `message="..."`（如 "stream error"）
 *   4. 整行 trim（结构化字段全缺时的兜底）
 * 再去掉错误类型前缀（`AI_APICallError: ` / `APIError: ` 等），对齐前端展示习惯。
 *
 * ⚠️ 值内转义引号：serve 日志为类 logfmt，值内 `"` 转义为 `\"`
 * （如 `error.error="AI_APICallError: \"auto\" tool choice requires ..."`）。
 * 裸 `[^"]*` 会在第一个转义引号处截断（线上实测只剩 `\`），故用允许 `\\.` 转义对
 * 的模式完整捕获后再反转义。
 */
export function extractServeError(line: string): string {
  const errorValue = /error\.error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  const causeValue = /cause="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  const messageValue = /message="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  const raw = (errorValue ?? causeValue ?? messageValue ?? line).trim();
  const unescaped = raw.replace(/\\"/g, '"');
  const unwrapped = unescaped
    .replace(/^Cause\(\[Fail\(/, '')
    .replace(/\)\]\)?$/, '')
    .trim();
  return unwrapped.replace(/^[A-Za-z_]+:\s*/, '').trim();
}

/**
 * 诊断首字超时根因（从 awaitCompletion 已收集的消息），优先级：
 * 0. **serve 日志模型错误（最高优先级）**：awaitCompletion 轮询期间经 serveErrorReader 读到
 *    的 serve stderr 模型调用错误（Rate limit / Free usage 等只写 stderr，不透传
 *    message.info.error）→ 透传 serve 错误文本。
 * 1. **info.error 模型调用错误**：assistant 消息的 info.error（serve 直接透传的 APIError，
 *    如凭据错误）→ 透传 error 详情（parts=[] 时唯一错误来源）。
 * 2. **serve 实际错误**：assistant 消息含 type:'error' part，或 step-finish 且
 *    reason==='error' → 透传 part.error.message / part.text（serve 无凭据时通常为
 *    "No authentication/credential" 类认证错误）。
 * 3. **卡在工具循环**：assistant 含 step-finish 且 reason==='tool-calls'（完成但循环
 *    调工具不产出正文）。注意：reasoning 已算首字——纯思考（有 reasoning 无 text）场景
 *    不会触发首字超时（会持续轮询到 step-finish），故此处不再诊断「思考阶段」。
 * 4. **完全无响应**：无上述特征 → 凭据缺失/模型不可用/serve 异常等。**兜底必须带证据**：
 *    若提供了原始 serve 日志尾部（serveLogTail），把逐行原文附在文案后（用户 mandate：
 *    拿到信息不该直接丢弃成一句笼统话；有证据就不允许只报「模型无任何输出」）。
 */
export function describeTimeoutReason(
  messages: ServeMessage[],
  serveErrorText?: string,
  serveLogTail?: string[],
): string {
  const assistantParts = messages
    .filter((m) => m.info?.role === 'assistant')
    .flatMap((m) => m.parts ?? []);

  // 0. serve 日志错误（最高优先级）：Rate limit/Free usage 等不透传 message.info.error——
  //    这是唯一能拿到该错误的通道
  if (typeof serveErrorText === 'string' && serveErrorText.trim() !== '') {
    return `模型调用报错：${serveErrorText.trim()}`;
  }

  // 1. info.error（serve 直接透传的模型调用错误）：APIError 消息 parts=[]，
  //    只在这里能拿到「Invalid API key.」等具体报错
  const messageError = extractMessageError(messages);
  if (messageError !== null) {
    return `模型调用报错：${messageError}`;
  }

  // 2. serve 实际错误：error part 或 step-finish(reason=error)
  for (const p of assistantParts) {
    if (p.type === 'error' || (p.type === 'step-finish' && p.reason === 'error')) {
      return `模型调用报错：${extractPartError(p)}`;
    }
  }

  // 3. 卡在工具循环：step-finish(reason=tool-calls)——完成但循环调工具不产出正文
  const hasToolCallsFinish = assistantParts.some(
    (p) => p.type === 'step-finish' && p.reason === 'tool-calls',
  );
  if (hasToolCallsFinish) {
    return TOOL_LOOP_REASON;
  }

  // 4. 完全无响应（兜底）：有原始 serve 日志尾部则原文附上（失败必须携带证据）
  const evidence = (serveLogTail ?? []).map((line) => line.trim()).filter((line) => line !== '');
  if (evidence.length > 0) {
    return `模型无任何输出（可能模型凭据缺失/模型不可用/serve 异常）；serve 日志尾部（原始证据）:\n${evidence.join('\n')}`;
  }
  return '模型无任何输出（可能模型凭据缺失/模型不可用/serve 异常）';
}

/**
 * 会话未完成即失败（已 abort + 携带部分回复）。两条来源共用本类型：
 * - **首字超时**：firstTokenTimeoutMs 内未出现第一个非空 assistant 输出 part（text 或 reasoning）；
 * - **serve 日志模型错误提前失败**：命中真实模型 API 错误关键词（`serveErrorText` 有值）——
 *   非超时，文案以「模型调用失败」开头，避免把"会话仍在跑"误报成首字超时。
 */
export class CompletionTimeoutError extends Error {
  readonly sessionID: string;
  readonly result: CompletionResult;
  /** serve 日志中提取的模型调用错误文本（T17 serveErrorReader 数据源；无则 undefined）。 */
  readonly serveErrorText?: string;

  constructor(
    sessionID: string,
    result: CompletionResult,
    messages?: ServeMessage[],
    serveErrorText?: string,
    serveLogTail?: string[],
  ) {
    const reason = describeTimeoutReason(messages ?? [], serveErrorText, serveLogTail);
    super(
      typeof serveErrorText === 'string' && serveErrorText.trim() !== ''
        ? `[prompt-await] 会话 ${sessionID} 模型调用失败：${reason}`
        : `[prompt-await] 会话 ${sessionID} 等待首字超时：${reason}`,
    );
    this.name = 'CompletionTimeoutError';
    this.sessionID = sessionID;
    this.result = result;
    this.serveErrorText = serveErrorText;
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

/**
 * P1 会话复用修复：过滤出基线（sendMessage 前快照）之后新增的消息。
 * - baselineIds 缺省/空集合 → 原样返回（新会话无历史，全量即本轮）；
 * - 非空 → 仅保留 id 不在基线中的消息（复用会话时历史轮次的
 *   user prompt 注入内容/step-finish/回复被排除，不混入本轮）。
 */
function filterFresh(messages: ServeMessage[], baselineIds?: Set<string>): ServeMessage[] {
  if (!baselineIds || baselineIds.size === 0) {
    return messages;
  }
  return messages.filter((m) => m.info?.id && !baselineIds.has(m.info.id));
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
    // P1 补充修复：parts 与 text 一致只取 assistant 消息——user 消息的 parts
    // （含 prompt 注入的 [群聊历史消息]/<doclib> 上下文块）绝不混入回复 parts，
    // 否则前端 MsgParts 渲染 text part 会显示用户消息/注入内容（私聊回复含用户问题根因）。
    parts: messages
      .filter((m) => m.info?.role === 'assistant')
      .flatMap((m) => m.parts ?? []),
    ...(finish?.tokens ? { tokens: finish.tokens } : {}),
    ...(finish?.cost !== undefined ? { cost: finish.cost } : {}),
  };
}

/**
 * 首字判定：存在任一 assistant 输出 part（非空 text，或**任意** reasoning）即视为已响应。
 * - text：排除 synthetic 合成文本（工具调用占位，非模型输出）
 * - reasoning：模型思考内容。**part 存在即算首字，不要求文本非空**——opencode 实测
 *   （1.18.32 + 免费 provider，线上 ses_f339ae60）：reasoning part 在思考开始时创建，
 *   但其文本要等 step 结束才**一次性**落盘，思考期间 `text` 恒为空字符串
 *   （opencode 事件表实证：同一 part 仅 2 条事件——`textLen=0` 创建 → 结束时长文写入；
 *   期间 5 分钟零更新）。若要求「文本非空」，长时间纯思考会被误判「模型无任何输出」
 *   而 abort 误杀（模型其实一直在干活）。part 存在 = opencode 已收到模型的思考内容。
 *   代价：思考开始后即无完成超时，判死交给上层 server 的静默/空闲 watchdog。
 */
function hasFirstToken(messages: ServeMessage[]): boolean {
  for (const m of messages) {
    if (m.info?.role !== 'assistant') {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type === 'text' && !p.synthetic && (p.text ?? '').trim() !== '') {
        return true;
      }
      if (p.type === 'reasoning' && !p.synthetic) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 会话活性指纹：任何「主循环在推进」的可见变化都改变它——消息数、part 数、文本长度、
 * 消息时间、以及 tool part 的 state（status / output 长度 / 自身耗时）。
 * 全部用 O(1) 标量投影（字符串取 .length，不做 JSON.stringify），避免每轮 poll 对大 tool 输出
 * 做全量序列化。
 */
function activitySignature(messages: ServeMessage[]): string {
  let parts = 0;
  let scalar = 0;
  for (const m of messages) {
    const mt = m.info?.time;
    scalar += (mt?.created ?? 0) + (mt?.completed ?? 0);
    for (const p of m.parts ?? []) {
      parts += 1;
      scalar += (p.text ?? '').length + (p.id ?? '').length;
      // part 类型也计入：空壳 reasoning（思考期 text 恒空）与 text/tool 的切换同样是
      // 「主循环在推进」的可见变化，不能只看文本长度。
      scalar += (p.type ?? '').length;
      const t = p.time;
      scalar += (t?.start ?? 0) + (t?.end ?? 0);
      const state = (
        p as {
          state?: {
            status?: unknown;
            output?: unknown;
            time?: { start?: number; end?: number };
          };
        }
      ).state;
      if (state !== undefined && state !== null && typeof state === 'object') {
        scalar += typeof state.status === 'string' ? state.status.length : 0;
        scalar += typeof state.output === 'string' ? state.output.length : 0;
        scalar += (state.time?.start ?? 0) + (state.time?.end ?? 0);
      }
    }
  }
  return `${messages.length}:${parts}:${scalar}`;
}

/**
 * 轮询等待会话完成：默认 500ms 间隔 / 300s 首字超时。
 * 完成（step-finish）→ 返回聚合结果；首字超时（时限内既无 text 也无 reasoning part）→
 * abort + 抛 CompletionTimeoutError（带已收集文本）。首字（非空 text 或 reasoning part）
 * 出现后 **无完成超时**——持续轮询到 step-finish，长期任务（模型思考/长输出）不被误杀，
 * 判死由上层 server 空闲超时负责。
 *
 * 活性顺延：即使 text/reasoning 尚未出现，只要 serve 侧持续追加/推进 parts（主循环在
 * 推进，如长 tool-calls 循环），首字 deadline 顺延——只有「无首字**且**无任何新输出」
 * 满时限才 abort。纯 tool 循环被误杀是线上主 agent 中断的另一来源（与 T17 子域秒杀并列）。
 */
export async function awaitCompletion(
  driver: V1Driver,
  sessionID: string,
  options: AwaitCompletionOptions = {},
): Promise<CompletionResult> {
  const { firstTokenTimeoutMs = 300_000, pollMs = 500, onPoll, baselineIds, onServeError, serveErrorReader, serveLogReader, serveLogTailLines = 20 } = options;
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let collected: ServeMessage[] = [];
  /** T17：serve 日志中提取的模型错误文本（onServeError 命中行）；有值 → 抛错文案用该文本 */
  let serveErrorText: string | null = null;
  /** 兜底证据：最近一次轮询读到的原始 serve 日志尾部（无模型错误可提取时附进原因） */
  let serveLogTail: string[] = [];
  /** T17 去重 + 陈旧隔离：基线（本轮开始前已存在，永不触发）与本轮已检查过的行。
   * 同一行永不重复判定——新追加行才走 onServeError。 */
  const seenServeErrorLines = new Set<string>(options.baselineServeErrorLines ?? []);
  /** 主循环活性指纹（见 activitySignature）：变化即 serve 侧在推进，首字 deadline 顺延。 */
  let lastActivitySignature = '';
  let lastActivityAt = startedAt;
  const hasServeErrorDetection = serveErrorReader !== undefined && onServeError !== undefined;

  let finish: ServePart | undefined;
  while (true) {
    const messages = await driver.getMessages(sessionID);
    // P1：只处理基线之后新增的消息（复用会话不混入历史轮次）
    const fresh = filterFresh(messages, baselineIds);
    collected = mergeMessages(collected, fresh);
    onPoll?.(fresh, Date.now() - startedAt);
    finish = findFinish(collected);
    if (finish) {
      break;
    }
    // T15：模型调用错误（info.error 非 Aborted）提前失败——serve 实测 APIError 消息
    // parts=[]（首字永不出现，也无 step-finish），等满 firstTokenTimeoutMs(300s) 无意义；
    // 立即走超时路径（abort + 抛 CompletionTimeoutError，文案带 info.error 详情）
    if (extractMessageError(collected) !== null) {
      break;
    }
    // T17：serve 日志模型错误提前失败——serve 对 Rate limit/Free usage 等 APIError 只写
    // stderr（`message="stream error" ... error.error="AI_APICallError: ..."`）不透传
    // message.info.error，extractMessageError 检测不到；经 serveErrorReader 读最近错误日志，
    // onServeError 判定命中（匹配模型 API 错误关键词）→ 记录错误文本 → 提前 break（快速
    // abort + 抛 CompletionTimeoutError，文案用 serve 错误文本而非「模型无任何输出」）。
    // 陈旧隔离：基线内（本轮开始前已存在）的行直接跳过——只有运行中新追加的行能触发，
    // 否则上一轮的错误行会秒杀复用会话上的每一轮新派发。
    if (hasServeErrorDetection) {
      for (const line of serveErrorReader!(sessionID)) {
        if (seenServeErrorLines.has(line)) {
          continue;
        }
        seenServeErrorLines.add(line);
        if (onServeError!(line)) {
          serveErrorText = extractServeError(line);
          break;
        }
      }
      if (serveErrorText !== null) {
        break;
      }
    }
    // 兜底证据（每轮刷新，取最新尾部）：模型错误不可提取时，原始行仍进失败原因
    if (serveLogReader !== undefined) {
      const tail = serveLogReader(sessionID);
      if (Array.isArray(tail) && tail.length > 0) {
        serveLogTail = tail.slice(-serveLogTailLines);
      }
    }
    if (firstTokenAt === null && hasFirstToken(collected)) {
      firstTokenAt = Date.now();
    }
    // 活性记录：指纹变化即主循环在推进（新增 part / 文本增长 / tool 状态与耗时推进 / 消息时间推进），
    // 刷新活性。仅数 parts 会漏掉「工具执行中」——tool part 的 state/output/time 会变但 part 数不变，
    // 单个长工具（> firstTokenTimeoutMs 且无新 part）会被误判「无输出」而 abort。
    const signature = activitySignature(collected);
    if (signature !== lastActivitySignature) {
      lastActivitySignature = signature;
      lastActivityAt = Date.now();
    }
    // 首字（text 或 reasoning）出现后无完成超时（继续轮询，判死由上层负责）；
    // 仅「时限内 text/reasoning 均未出现**且**无任何新输出」才 abort；firstTokenTimeoutMs<=0 视为禁用
    if (firstTokenTimeoutMs > 0 && firstTokenAt === null && Date.now() - Math.max(startedAt, lastActivityAt) >= firstTokenTimeoutMs) {
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
    throw new CompletionTimeoutError(sessionID, result, collected, serveErrorText ?? undefined, serveLogTail);
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
  // P1：sendMessage 前取基线（会话现有消息 id）——复用会话时 awaitCompletion
  // 仅聚合/判定/上送本轮新增消息，历史轮次回复与注入内容不再混入本轮结果。
  // 取基线失败（serve 暂不可达）→ 缺省（全量聚合，回归旧行为不阻断执行）。
  let baselineIds: Set<string> | undefined;
  try {
    const existing = await driver.getMessages(sessionID);
    baselineIds = new Set(
      existing
        .map((m) => m.info?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
  } catch {
    baselineIds = undefined;
  }
  // T17-stale：sendMessage 前快照 serve 错误行基线——快检只触发本轮新追加的行，
  // 上一轮残留（日志文件回退跨重启不清）的旧错误行不再秒杀新一轮。快照失败 → 缺省
  // （无基线，保持原快检语义不阻断执行）。
  let baselineServeErrorLines: Set<string> | undefined;
  if (options.serveErrorReader) {
    try {
      baselineServeErrorLines = new Set(options.serveErrorReader(sessionID));
    } catch {
      baselineServeErrorLines = undefined;
    }
  }
  await driver.sendMessage(sessionID, input);
  return awaitCompletion(driver, sessionID, { ...options, baselineIds, baselineServeErrorLines });
}

/**
 * T10：消息增量去重——挂在 awaitCompletion 的 onPoll 上提取「新增 parts」。
 * serve 轮询返回整个会话的**累积列表**（非增量），同一 assistant 消息（同 info.id）
 * 的 parts 在后续轮询中 **append-only 逐步增长**（实测：parts=[] 空壳 → 增补
 * step-start/reasoning → 再增补 text/step-finish）。按消息 id 粗粒度去重会丢掉
 * 逐步增长的增量 parts，必须**按 part 粒度去重**：
 *  - part key 优先用 `part.id`（serve 实测稳定存在，`prt_` 前缀，如
 *    prt_fef9ccd840014HjL6O0NoNLKD2，同一消息内 append-only 累积）
 *  - part 无 id 时回退 `消息id:partIndex`（消息内 0 基索引——parts append-only
 *    累积索引稳定，增量 part 的索引必然是新值）
 *  - 空壳消息（parts=[]）不产生 key，不影响后续；同消息增量部分（新 id/新索引）
 *    被提取，旧 part 不重复上送
 * 保证 message.part.delta 事件只上送新增 part，不重复上送整批历史。
 */
export class MessageDeltaTracker {
  private readonly sentPartKeys = new Set<string>();

  /** 返回本轮 messages 中此前未上送过的 **assistant** 消息的增量 parts（扁平拼接）；
   *  无新增返回空数组。
   *  P1/P6：过滤 role=assistant——user/system 消息（含 prompt 注入的 [群聊历史消息]/
   *  doclib 上下文）绝不进入流式回复，杜绝聊天记录显示注入重复内容。 */
  extractNewParts(messages: ServeMessage[]): ServePart[] {
    const fresh: ServePart[] = [];
    for (const m of messages) {
      if (m.info?.role !== 'assistant') {
        continue;
      }
      const msgId = m.info?.id;
      if (!msgId) {
        // 消息无 id：不参与去重也不上送（回归现行为，防御兜底）
        continue;
      }
      const parts = m.parts ?? [];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        // part key：优先 part.id（serve 实测稳定 `prt_` 前缀）；无 id 时回退
        // `消息id:partIndex`（0 基索引，parts append-only 累积索引稳定）
        const key = part.id ? part.id : `${msgId}:${i}`;
        if (this.sentPartKeys.has(key)) {
          continue;
        }
        this.sentPartKeys.add(key);
        fresh.push(part);
      }
    }
    return fresh;
  }

  /** 重置已上送集合（多轮执行复用同一实例时隔离）。 */
  reset(): void {
    this.sentPartKeys.clear();
  }
}
