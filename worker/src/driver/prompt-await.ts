/**
 * T14 prompt 发送 + 轮询完成判定（语义层；**v1 回退路与 v2 共用同一套判定**）。
 *
 * 本文件是 worker 侧**唯一**回答「这一轮跑完了吗 / 正文是什么 / 出了什么错」的地方。
 * 上游两代形态的差异全部收敛在这里，调用方（exec-server）只认 vteam 自有类型。
 *
 * ## 五条语义：v1 口径 → v2 口径
 *
 * | 语义 | v1 | v2（本文件的实现） |
 * |---|---|---|
 * | 完成判定 | assistant 消息含 `step-finish(reason=stop)` | **同**——v2 驱动把消息的 `finish` 合成成 `step-finish` part，而 v2 的 `finish` 取值与 v1 **同名**（实测 2.0.28：`stop`/`tool-calls`/`error`）；**另加事件路**（durable 的 `session.execution.succeeded`）为同等权威来源 |
 * | 首字 | 非空 text part 或**任意** reasoning part | **同**（轮询路看累积后的 content）+ 事件路等价物（`session.text.delta` 非空 / 任意 reasoning 事件） |
 * | 在飞工具豁免 | `state.status ∈ {pending, running}` | `state.status ∈ {running, streaming}`——**v2 没有 `pending`**（实测 2.0.28：v2 工具只会 `running` → `completed`/`error`）；`pending` 仍留在集合里（v1 回退路径不能退化） |
 * | 文本聚合 | text 且非 synthetic，按 `time.start` 升序 | **同**——v2 的 `content[]` 本身有序，且驱动给同一条消息的各 part 同一时间戳 ⇒ 排序退化为「按消息时间 + 消息内原序」，与 v2 的 content 序一致 |
 * | 错误抽取 | `info.error = {name, data:{message, statusCode}}` | **两代形状都认**：v1 的 `{name, data:{message,statusCode}}` 与 v2 的 `{type, message, status, response{body}}`（实测 2.0.28） |
 *
 * ## 三条不能破的规矩
 *
 * 1. **「有文本」不等于「完成」**（v1 实测铁律，v2 继续成立）：assistant 消息在 step-start
 *    之前就已出现（parts=[]），abort 后消息只有 step-start+reasoning（无 text/step-finish）
 *    ——按「有消息」判会把没跑完的会话误判成完整回复。完成必须有**终态信号**：轮询路的
 *    `step-finish(reason=stop)`，或事件路的 `session.execution.succeeded`。
 * 2. **终态只有一个出口**：事件路（durable `session.execution.*`）与轮询路（消息终态）**都**
 *    能判出终态，不收口就会发两次 `task.completed`。收口在 `RunTerminalGate`
 *    （`v2-event-map.ts`）：事件证据优先于轮询证据、`settle()` 一次性、陈旧 durable `seq`
 *    不覆盖新证据。⇒ **本文件不自己发终态事件**，只负责①把自己的判定**记进同一个闸门**
 *    （`notePolling`）②在判定前**先问闸门**（`peek`）——事件路已判失败/中断时，轮询路
 *    **不得**宣告成功（事件证据优先）。
 * 3. **首字之后没有完成超时**：长期任务持续轮询到终态，判死由上层 server 的空闲 watchdog
 *    负责；只有「模型完全没响应」才报错。
 *
 * 首字超时：时限内既无非空 text part、也无 reasoning part → 调 abort + 抛
 * CompletionTimeoutError，携带已收集文本。reasoning part **存在即算已响应**（opencode
 * 实测先建 reasoning 空壳、思考结束才一次性写入文本，故不能要求文本非空），长时间纯思考
 * 不被误杀。
 */

import {
  OpenCodeDriver,
  DriverMessage,
  DriverContent,
  DriverTokenUsage,
  DriverModelRef,
  Logger,
} from './opencode-driver';

/** 终态判定（vteam 口径；与 v2 事件路的 `RunTerminalVerdict` 同名同义）。 */
export type RunVerdict = 'succeeded' | 'failed' | 'interrupted';

/** 终态判定详情（与 v2 事件路的 `RunTerminalOutcome` 同形：判定 + 可读原因）。 */
export interface RunOutcome {
  /** 判定结果。 */
  verdict: RunVerdict;
  /** 失败/中断原因（可读文本）。 */
  error?: string;
}

/**
 * 事件路信号（**结构化接口**；v2 事件路的 `RunTerminalGate` 天然满足前两个方法）。
 *
 * 为什么语义层需要它：v2 的 **run 级结果只在事件路有**——`session.execution.succeeded /
 * failed / interrupted` 是 durable 事件；而承载 run 结果的 `idle` 消息（`outcome` 字段）
 * 被 v2 驱动**丢弃**（vteam 的 role 模型只有 user/assistant 二值）⇒ 轮询路**看不到**
 * 「这一轮整体成功还是失败」，只能看到「某一步以 stop 收尾」。两条路必须合流到**同一个
 * 闸门**，否则会发两次 `task.completed`（或把失败判成成功）。
 *
 * 契约：
 * - `peek()`：窥视**已有**的终态证据（**不**消耗闸门的一次性收口；那由调用方做）；
 *   未到达 = null。
 * - `notePolling()`：把**轮询路**的终态证据记进同一个闸门（事件证据优先于轮询证据）。
 * - `firstToken()`（可选）：事件路是否已出现「首字」；缺省 = 事件路不提供该信号
 *   （判定纯由轮询路做，见 `isFirstTokenEvent`）。
 */
export interface EventSignal {
  /** 窥视已有终态证据（不消耗一次性收口）。 */
  peek(): RunOutcome | null;
  /** 记录轮询路的终态证据（首次生效；事件证据优先）。 */
  notePolling(outcome: RunOutcome): void;
  /** 事件路是否已出现「首字」（可选）。 */
  firstToken?(): boolean;
}

export interface AwaitCompletionOptions {
  /**
   * 首字超时 ms（时限内既无非空 text part、也无 reasoning part → abort + 抛
   * CompletionTimeoutError）；缺省 0=禁用首字超时，长脚本/等权限不误杀。
   * reasoning part 存在即算已响应（空壳也算：思考期 opencode 不落文本），长时间思考不被误杀。
   * 首字出现后无完成超时（持续等待 step-finish，不 abort）。
   */
  firstTokenTimeoutMs?: number;
  /**
   * 执行总时长上限 ms（opt-in，默认禁用）。自 awaitCompletion 开始计时；**首字出现后**
   * 若到期限仍无 step-finish（无完成）→ abort + 抛 CompletionTimeoutError（文案前缀
   * 「执行总时长超限」）。与首字超时独立：首字超时管「模型完全没响应」，本项管「模型有
   * 响应但整体跑太久」。<=0/缺省 = 禁用（保持既有「首字后无完成超时」契约，判死仍由上层
   * server 空闲 watchdog 负责）。
   */
  totalTimeoutMs?: number;
  /** 轮询间隔 ms；默认 500（计划 D8） */
  pollMs?: number;
  /** 每次轮询后的回调（调试/进度上报用，T6 事件上送可在此挂钩） */
  onPoll?: (messages: DriverMessage[], elapsedMs: number) => void;
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
  /**
   * T14：**事件路信号**（v2 事件桥提供的只读视图；缺省 = 无事件路，纯轮询）。
   *
   * 给了它，轮询路就与事件路**合流到同一个终态闸门**（见 `EventSignal`）：轮询路判定完成
   * 时把证据记进闸门（`notePolling`），判定前先问闸门（`peek`）——事件路已判失败/中断时
   * 轮询路不宣告成功；事件路给出 `succeeded` 时**也算完成**（v2 的 run 级结果只在事件路有）。
   */
  eventSignal?: EventSignal;
  /**
   * T14：**终态宽限期** ms（默认 500）。
   *
   * 轮询路判定完成（见到 `step-finish(reason=stop)`）后，若事件路还没给出终态，等这么久
   * 让它补齐——目的是让「轮询先到」与「事件先到」两种顺序**得到同一个结论**（事件证据
   * 优先：若事件路在这段时间里给出 failed/interrupted，轮询路不得宣告成功）。
   *
   * 只在**提供了 `eventSignal`** 时生效（无事件路 → 没什么可等，不加延迟）；0 = 不等待。
   */
  eventGraceMs?: number;
  /**
   * T14：日志输出（可选；缺省 = 不打日志 → v1 回退路径与既有行为零变化）。
   *
   * 只在**事件路参与了判定**时记一条（谁判的完成 / 两路是否分歧）——分歧必须可诊断：
   * 线上「到底是模型失败还是我们的判定错了」只能靠这条记录回答。
   */
  logger?: Logger;
}

/** 会话完成聚合结果。 */
export interface CompletionResult {
  /** 全部 text part 按时间排序拼接的最终回复 */
  text: string;
  /** 原始 parts（含 reasoning/tool 等，T6 事件上送直接透传） */
  parts: DriverContent[];
  /** step-finish 的 tokens（实测含 total/input/output/reasoning/cache） */
  tokens?: DriverTokenUsage;
  /** step-finish 的 cost */
  cost?: number;
  /**
   * **serve 实际使用的模型**（assistant 消息 `info.providerID`/`info.modelID`，opencode
   * message info 实测字段）。零配置环境（default_model_id 为空）serve 自选默认模型，
   * 调用方无从得知——本字段带出真实模型。缺失/非法一律 undefined（不造假数据），
   * 与显式配置的优先级由 exec-server 决定。
   */
  model?: DriverModelRef;
  /**
   * T14：**终态证据来源**（谁判的完成）。
   *
   * - `event`：事件路（durable 的 `session.execution.succeeded`）——权威；
   * - `polling`：轮询路（`step-finish(reason=stop)`）——兜底；
   * - 缺省 = 本轮**没走到**完成判定（超时/失败路径，结果随错误一起带出）。
   *
   * 为什么要带出：两条路都到得了终态，**分歧必须可诊断**——线上「到底是模型失败，还是
   * 我们的判定错了」只能靠这条证据（配合 `AwaitCompletionOptions.logger` 的一条记录）回答。
   */
  terminalEvidence?: 'event' | 'polling';
}

/**
 * 从 assistant 消息 `info` 取实际使用模型。沿用 info.error 的索引签名安全访问：
 * 两个字段都必须是非空字符串才认可（任一缺失/空白/非字符串 → undefined，绝不半截拼接）。
 */
function extractModelInfo(m: DriverMessage): DriverModelRef | undefined {
  const providerID = m.info?.providerID;
  const modelID = m.info?.modelID;
  if (typeof providerID !== 'string' || providerID.trim() === '') {
    return undefined;
  }
  if (typeof modelID !== 'string' || modelID.trim() === '') {
    return undefined;
  }
  return { providerID, modelID };
}

/**
 * 本轮实际使用模型：优先取**持有 step-finish(reason=stop) 的那条 assistant 消息**的
 * info（= 最后一次真实模型调用的归属消息，工具循环换模型时也以它为准）；无 finish
 * （超时路径）则退化为最后一条 assistant 消息。
 */
export function findAssistantModel(messages: DriverMessage[]): DriverModelRef | undefined {
  const assistants = messages.filter((m) => m.info?.role === 'assistant');
  const owner =
    assistants.find((m) =>
      (m.parts ?? []).some((p) => p.type === 'step-finish' && p.reason === 'stop'),
    ) ?? assistants[assistants.length - 1];
  return owner ? extractModelInfo(owner) : undefined;
}

/**
 * 从 serve part 提取实际错误详情（防御：part.error 可能缺失/非对象，text 可能缺失）。
 * 优先级：error.message > part.text（error/step-finish part 的 text 通常承载具体报错）> 兜底。
 */
function extractPartError(p: DriverContent): string {
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
 * 从 assistant 消息的 `info.error` 提取首个非 Aborted 的错误文本；无模型错误/仅 Aborted → null。
 *
 * 背景（实测）：serve 用错误凭据调用模型时，assistant 消息 **parts=[]**（无 error part、
 * 无 step-finish），错误落在 `message.info.error` ——原实现只查 parts 漏了该字段，
 * 导致用户只见笼统「模型无任何输出」。
 *
 * **v2 的等价形态已实测确认**：模型调用失败时 assistant 消息**同样没有 content**
 * （= vteam 内部模型的 parts=[]），错误落在 `info.error`——只是**形状变了**。
 *
 * | 代 | 形状 | 消息 | HTTP 码 | 类型名 |
 * |---|---|---|---|---|
 * | v1 | `{name:'APIError', data:{message, statusCode, isRetryable}}` | `data.message` | `data.statusCode` | `name` |
 * | v2 | `{type:'provider.auth', message, status, response:{body}}` | 顶层 `message` | 顶层 `status` | `type` |
 *
 * 提取优先级：`data.message`（v1）> 顶层 `message`（v2）> 类型名（`name` / `type`）。
 * HTTP 码：`data.statusCode`（v1）> 顶层 `status`（v2）——存在时附 ` (HTTP <code>)`。
 *
 * - Aborted（v1 `MessageAbortedError` / v2 的 `*aborted*`）**跳过**：aborted 会话可复用
 *   （用户确认），非模型调用失败，不当作可抛错误（awaitCompletion 据此不提前抛）。
 */
function extractMessageError(messages: DriverMessage[]): string | null {
  for (const m of messages) {
    if (m.info?.role !== 'assistant') {
      continue;
    }
    const err = m.info.error;
    if (!err || typeof err !== 'object') {
      continue;
    }
    const record = err as {
      name?: unknown;
      type?: unknown;
      data?: unknown;
      message?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    const name = typeof record.name === 'string' ? record.name : '';
    const type = typeof record.type === 'string' ? record.type : '';
    // Aborted 跳过（aborted 会话可复用，非模型调用失败，不提前抛）
    // v1 的错误类型名在 `name`，v2 的在 `type`（如 `provider.auth`）——两处都查。
    if (name.toLowerCase().includes('aborted') || type.toLowerCase().includes('aborted')) {
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
      type !== '' ? type : undefined,
    ].find((v): v is string => v !== undefined);
    if (detail === undefined) {
      continue;
    }
    const statusCode =
      data && typeof data.statusCode === 'number'
        ? data.statusCode
        : typeof record.status === 'number'
          ? record.status
          : undefined;
    return statusCode !== undefined ? `${detail} (HTTP ${statusCode})` : detail;
  }
  return null;
}

/**
 * 从 serve 日志行提取干净的模型错误文本（onServeError 命中行的展示文本）。
 * 实测两种形态：
 *   a) `message="stream error" ... error.error="AI_APICallError: Rate limit exceeded. Please try again later."`
 *   b) `message="share subscriber failed" ... cause="Cause([Fail(ProviderModelNotFoundError: Model not found: …)])"`
 *   c) `level=ERROR message="prompt_async failed" sessionID=ses_… cause="Cause([Die(ProviderModelNotFoundError: Model not found: …)])"`
 *      （顶层模型下架：`Die(` 与子域 `Fail(` 同为 Cause 包装形态，需一并剥离）
 * 提取优先级（取**最深可用细节**，避免把整行结构化日志当原因）：
 *   1. `error.error="..."`（APIError 承载具体模型调用错误）
 *   2. `cause="..."`（流/订阅失败的嵌套原因；剥掉 `Cause([Fail(` / `Cause([Die(` / `)])` 包装）
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
    .replace(/^Cause\(\[(?:Fail|Die)\(/, '')
    .replace(/\)\]\)?$/, '')
    .trim();
  return unwrapped.replace(/^[A-Za-z_]+:\s*/, '').trim();
}

/**
 * 模型下架判定（serve 错误文本）：ProviderModelNotFoundError / `Model not found`。
 * 命中 → 该模型在 provider 中已不存在/下架，重试同一模型必然继续失败：文案需明确告知
 * 用户**为该成员更换可用模型**（而非笼统「模型调用失败」/「等待首字超时」）。
 */
export function isModelNotFoundError(text: string): boolean {
  return /ProviderModelNotFoundError|Model not found/i.test(text);
}

/** 模型下架的可执行修复提示（附在错误原因后：告知用户改成员模型即可恢复）。 */
const MODEL_NOT_FOUND_HINT = '（该模型可能已在 provider 中下架；请为该成员更换可用的模型后重试）';

/** 模型下架 → 明确「模型不可用」+ 更换模型提示；否则原样「模型调用报错」。 */
function describeModelError(detail: string): string {
  return isModelNotFoundError(detail)
    ? `模型不可用：${detail}${MODEL_NOT_FOUND_HINT}`
    : `模型调用报错：${detail}`;
}

/**
 * 诊断首字超时根因（从 awaitCompletion 已收集的消息），优先级：
 * 0. **serve 日志模型错误（最高优先级）**：awaitCompletion 轮询期间经 serveErrorReader 读到
 *    的 serve stderr 模型调用错误（Rate limit / Free usage 等只写 stderr，不透传
 *    message.info.error）→ 透传 serve 错误文本。
 * 1. **info.error 模型调用错误**：assistant 消息的 info.error（serve 直接透传的 APIError，
 *    如凭据错误）→ 透传 error 详情（parts=[] 时唯一错误来源）。**v1 与 v2 的形状都认**
 *    （v1 `{name,data:{message,statusCode}}` / v2 `{type,message,status}`，见
 *    `extractMessageError`）——v2 实测：凭据错误时 assistant 消息**没有 content**，
 *    错误只在 `info.error` 里，与 v1 同一个坑。
 *    ⚠️ v2 还有**更好的来源**：durable 事件 `session.execution.failed` 的
 *    `error{type,message,status,response{body}}`（走事件路，见 `EventSignal`）——
 *    它带 HTTP 码与响应体，比消息里的错误更全。
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
  messages: DriverMessage[],
  serveErrorText?: string,
  serveLogTail?: string[],
): string {
  const assistantParts = messages
    .filter((m) => m.info?.role === 'assistant')
    .flatMap((m) => m.parts ?? []);

  // 0. serve 日志错误（最高优先级）：Rate limit/Free usage 等不透传 message.info.error——
  //    这是唯一能拿到该错误的通道；模型下架（Model not found）→ 明确「模型不可用」+ 换模型提示
  if (typeof serveErrorText === 'string' && serveErrorText.trim() !== '') {
    return describeModelError(serveErrorText.trim());
  }

  // 1. info.error（serve 直接透传的模型调用错误）：APIError 消息 parts=[]，
  //    只在这里能拿到「Invalid API key.」等具体报错
  const messageError = extractMessageError(messages);
  if (messageError !== null) {
    return describeModelError(messageError);
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
    messages?: DriverMessage[],
    serveErrorText?: string,
    serveLogTail?: string[],
    timeoutKind: 'first-token' | 'total' = 'first-token',
  ) {
    const reason = describeTimeoutReason(messages ?? [], serveErrorText, serveLogTail);
    const modelNotFound = typeof serveErrorText === 'string' && isModelNotFoundError(serveErrorText);
    const prefix =
      timeoutKind === 'total'
        ? `[prompt-await] 会话 ${sessionID} 执行总时长超限：${reason}`
        : modelNotFound
          ? `[prompt-await] 会话 ${sessionID} ${reason}`
          : typeof serveErrorText === 'string' && serveErrorText.trim() !== ''
            ? `[prompt-await] 会话 ${sessionID} 模型调用失败：${reason}`
            : `[prompt-await] 会话 ${sessionID} 等待首字超时：${reason}`;
    super(prefix);
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
function mergeMessages(collected: DriverMessage[], incoming: DriverMessage[]): DriverMessage[] {
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
function filterFresh(messages: DriverMessage[], baselineIds?: Set<string>): DriverMessage[] {
  if (!baselineIds || baselineIds.size === 0) {
    return messages;
  }
  return messages.filter((m) => m.info?.id && !baselineIds.has(m.info.id));
}

/**
 * 完成判定核心：遍历 assistant 消息找含 `step-finish(reason=stop)` 的 part。
 *
 * ## v1 / v2 同规则（v2 驱动把终态合成成同名 part）
 *
 * v2 上游**没有** `step-finish` 这个 part（升级成了 `session.step.*` 事件），但 v2 驱动
 * **从 assistant 消息的 `finish` 字段合成**一个同形状的 part（`v2-driver.ts` 的
 * `mapMessage`）——而 v2 的 `finish` 取值与 v1 **同名**（实测 2.0.28：`stop`/`tool-calls`/
 * `error`；`rawFinish` 才是下划线形态 `tool_calls`，驱动不用它）。⇒ 本判定**逐字适用**。
 *
 * ## 两条不能破的规则
 *
 * 1. **只有 `stop` 才算完成**：`tool-calls`（这一轮只是去调工具、正文还没产出）与 `error`
 *    都**不是**完成——v1/v2 同理（v2 实测：中间步骤的 `finish` 就是 `tool-calls`）。
 * 2. **「有消息」不算完成**：assistant 消息在 step 结束前就已存在（parts=[]），按「有消息」
 *    判会把没跑完的会话误判成完整回复（v1 实测铁律）。
 *
 * ⚠️ 事件路（durable 的 `session.execution.succeeded`）是**同等权威**的完成来源，但**不在
 * 这里判**——终态只有一个出口（`RunTerminalGate`），见 `awaitCompletion` 的事件路合流。
 */
export function findFinish(messages: DriverMessage[]): DriverContent | undefined {
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
 * 过滤 type=text 且非 synthetic（合成文本=工具调用占位/注入上下文，排除避免污染最终回复），
 * 按 part.time.start 时间戳升序串接。
 *
 * ## v2 的等价性（口径不变）
 *
 * - **顺序**：v2 的 `content[]` 本身就是有序的；v2 驱动给**同一条消息的各 part 同一个
 *   时间戳**（消息级 created/completed）⇒ 这里的排序在消息内**退化**为「原序」、
 *   在消息间按创建时间——与 v2 的 content 序一致（`Array.prototype.sort` 稳定，
 *   同键时保持原序）。
 * - **`synthetic` 过滤在 v2 下是空操作**：v2 的 `content[]` 项**没有** `synthetic` 字段，
 *   驱动也从不设置它（v1 同样不设置——实测 v1 会话 dump 里没有一项带 `synthetic`）。
 *   它防的是 **vteam 自己注入**的占位/上下文块（`[群聊历史消息]`/`<doclib>`）。
 *   ⚠️ v1 担心的「工具调用占位文本」在 v2 **结构上不存在**：v2 里工具调用是**独立的
 *   `content` 项（`type:'tool'`）**，与模型写的 `type:'text'` 项**互斥**
 *   （实测 2.0.28：调工具的那条 assistant 消息**只有** tool 项，**没有**文本占位）——
 *   所以工具占位污染回复这条路在 v2 是**封死**的，无需再靠标记位区分。
 */
export function aggregateText(messages: DriverMessage[]): string {
  const texts = messages
    .filter((m) => m.info?.role === 'assistant')
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text' && !p.synthetic)
    .sort((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0));
  return texts.map((p) => p.text ?? '').join('');
}

/** 从已收集消息构建聚合结果（tokens/cost 取 step-finish part，model 取 finish 归属消息的 info）。 */
function buildResult(
  messages: DriverMessage[],
  terminalEvidence?: 'event' | 'polling',
): CompletionResult {
  const finish = findFinish(messages);
  const model = findAssistantModel(messages);
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
    ...(model ? { model } : {}),
    ...(terminalEvidence !== undefined ? { terminalEvidence } : {}),
  };
}

/**
 * 首字判定（**轮询路**）：存在任一 assistant 输出 part（非空 text，或**任意** reasoning）
 * 即视为已响应。
 * - text：排除 synthetic 合成文本（vteam 注入的占位/上下文块，非模型输出）
 * - reasoning：模型思考内容。**part 存在即算首字，不要求文本非空**——opencode 实测
 *   （1.18.32 + 免费 provider，线上 ses_f339ae60）：reasoning part 在思考开始时创建，
 *   但其文本要等 step 结束才**一次性**落盘，思考期间 `text` 恒为空字符串
 *   （opencode 事件表实证：同一 part 仅 2 条事件——`textLen=0` 创建 → 结束时长文写入；
 *   期间 5 分钟零更新）。若要求「文本非空」，长时间纯思考会被误判「模型无任何输出」
 *   而 abort 误杀（模型其实一直在干活）。part 存在 = opencode 已收到模型的思考内容。
 *   代价：思考开始后即无完成超时，判死交给上层 server 的静默/空闲 watchdog。
 *
 * ⚠️ **v2 逐字适用**：v2 驱动把 `content[]` 的 `text`/`reasoning` 项映射成同名 part
 * （`type`/`text` 都一样），故这四例矩阵在 v2 上一一对应。
 */
function hasFirstToken(messages: DriverMessage[]): boolean {
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
 * 首字判定（**事件路**等价物）：v2 的 `session.text.delta` / `session.reasoning.*` 事件。
 *
 * 与轮询路的四例矩阵**逐条对齐**（事件路到达得比轮询早，故它是首字的主信号）：
 *
 * | v1（轮询） | v2（事件） | 算首字？ |
 * |---|---|---|
 * | 非空 text part | `session.text.delta` 且 `delta` 非空 | ✅ |
 * | 仅 reasoning part | `session.reasoning.started` / `session.reasoning.delta` | ✅（**任意** reasoning 事件都算——与「reasoning part 存在即算」同义） |
 * | 空 text part | `session.text.started`（空文本流开始） | ❌（空文本不算首字） |
 * | 无任何输出 | 无相关事件 | ❌ |
 *
 * ⚠️ 增量字段名是 **`delta`**（不是 v1 的 `text`）；`session.text.ended` 带的是**权威全文**
 * （`data.text`）——它是**收尾**事件而非首字信号（此刻正文已全部到齐，不该再当「刚开始」）。
 */
export function isFirstTokenEvent(event: {
  type?: string;
  data?: Record<string, unknown>;
}): boolean {
  const type = typeof event.type === 'string' ? event.type : '';
  const data =
    event.data !== null && typeof event.data === 'object' ? event.data : ({} as Record<string, unknown>);
  if (type === 'session.reasoning.started' || type === 'session.reasoning.delta') {
    return true;
  }
  if (type === 'session.text.delta') {
    const delta = data.delta;
    return typeof delta === 'string' && delta.trim() !== '';
  }
  return false;
}

/**
 * 在途工具态（`state.status` 白名单）：模型正被外部依赖卡住——典型是 `secret_command`
 * 等用户填敏感值（输入预算 540s > 首字窗口 300s）。这种「无 text/reasoning 且 serve
 * 静止」不是模型没输出，而是模型在等工具返回；此时首字超时不得 abort。
 * 白名单而非黑名单：未知/缺失 status 不延长活性（保持既有判死语义）。
 *
 * ## 两代取值（**取值是小写**；OpenAPI 里的 `Running`/`Streaming` 是类型名不是取值）
 *
 * | status | v1 | v2 | 语义 |
 * |---|---|---|---|
 * | `pending` | ✅ | ❌ **没有** | v1：工具 part 在参数解析完成前先以 `{status:'pending', input:{}}` 空壳落盘 |
 * | `running` | ✅ | ✅ | 在飞（两代同名） |
 * | `streaming` | ❌ | ✅ | v2 的独立在飞变体（输出流式回传中） |
 * | `completed` / `error` | ✅ | ✅ | 终态（**不**享受豁免） |
 *
 * ⚠️ **v2 没有 `pending`**（实测 2.0.28：v2 工具只会 `running` → `completed`/`error`，
 * 从未出现 `pending`）——v1 那个「已排队未开跑」的窗口在 v2 **没有对应表示**：
 * v2 在工具调用**发出**的那一刻就把 state 标成 `running`（`session.tool.input.started`），
 * 之后才是 `session.tool.called` → `session.tool.success`。
 * ⇒ **v1 的豁免窗口在 v2 被压缩进 `running`**：豁免语义**不丢**（模型在等工具返回时
 * 首字超时照样不触发），且窗口比 v1 更早开始（v1 要等参数解析完才 running）。
 * `pending` 仍留在集合里，是为了**v1 回退路径不退化**（v1 的 secret 等待场景正落在它上面）。
 */
const IN_FLIGHT_TOOL_STATES = new Set(['pending', 'running', 'streaming']);

function hasInFlightTool(messages: DriverMessage[]): boolean {
  for (const m of messages) {
    if (m.info?.role !== 'assistant') {
      continue;
    }
    for (const p of m.parts ?? []) {
      if (p.type !== 'tool') {
        continue;
      }
      const state = p.state as { status?: unknown } | undefined | null;
      const status =
        state !== undefined && state !== null && typeof state === 'object'
          ? state.status
          : undefined;
      // 大小写不敏感（防御 OpenAPI 的类型名形态 `Running`/`Streaming` 被当真值传上来）
      if (typeof status === 'string' && IN_FLIGHT_TOOL_STATES.has(status.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return h;
}

function sampleHash(s: string): number {
  if (s.length <= 128) return hashStr(s);
  return hashStr(`${s.slice(0, 64)}\n${s.slice(-64)}`) + s.length;
}

/**
 * 会话活性指纹：任何「主循环在推进」的可见变化都改变它——消息数、part 数、文本长度、
 * 消息时间、以及 tool part 的 state（status / output 长度 / 自身耗时）。
 * 全部用 O(1) 标量投影（字符串取有界采样哈希，不做 JSON.stringify），避免每轮 poll 对大 tool 输出
 * 做全量序列化。
 */
function activitySignature(messages: DriverMessage[]): string {
  let parts = 0;
  let scalar = 0;
  for (const m of messages) {
    const mt = m.info?.time;
    scalar += (mt?.created ?? 0) + (mt?.completed ?? 0);
    for (const p of m.parts ?? []) {
      parts += 1;
      scalar += sampleHash(p.text ?? '') + (p.id ?? '').length;
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
        scalar += typeof state.output === 'string' ? sampleHash(state.output) : 0;
        scalar += (state.time?.start ?? 0) + (state.time?.end ?? 0);
      }
    }
  }
  return `${messages.length}:${parts}:${scalar}`;
}

/**
 * 事件路终态失败（durable 的 `session.execution.failed` / `interrupted`）。
 *
 * 为什么单独一个类型：它**不是**超时，也不是轮询路的判定——是上游事件路给出的**权威**
 * 终态（凭据错误 / 模型报错 / 被中断）。消息文本直接透传事件载荷里的错误详情
 * （v2 的 `error{type,message,status,response{body}}` → 取 `message`），让上层能区分
 * 「上游判死的」与「我们没等到（超时）」——两者的处置完全不同。
 */
export class RunTerminalError extends Error {
  readonly sessionID: string;
  /** 终态判定（failed / interrupted）。 */
  readonly verdict: 'failed' | 'interrupted';
  /** 上游给出的错误详情（可读文本）。 */
  readonly error?: string;
  /** 已收集到的聚合结果（失败也带正文，便于前端展示部分输出）。 */
  readonly result: CompletionResult;

  constructor(sessionID: string, outcome: RunOutcome, result: CompletionResult) {
    // 归一：只有 failed/interrupted 会走到这里（succeeded 不是失败路径）；
    // 未知取值按 failed 处理（宁可报错也不静默当成功）。
    const verdict: 'failed' | 'interrupted' =
      outcome.verdict === 'interrupted' ? 'interrupted' : 'failed';
    const detail =
      typeof outcome.error === 'string' && outcome.error.trim() !== ''
        ? outcome.error.trim()
        : '（上游未给出错误详情）';
    super(
      verdict === 'interrupted'
        ? `[prompt-await] 会话 ${sessionID} 执行被中断（事件路判定）：${detail}`
        : `[prompt-await] 会话 ${sessionID} 执行失败（事件路判定）：${detail}`,
    );
    this.name = 'RunTerminalError';
    this.sessionID = sessionID;
    this.verdict = verdict;
    this.error = outcome.error;
    this.result = result;
  }
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
 * 满时限才 abort。在途工具豁免：存在 `state.status ∈ {pending, running, streaming}` 的
 * tool part（模型在等工具返回，如 `secret_command` 阻塞等待用户填敏感值，输入预算 540s >
 * 首字 300s）时，serve 静止不等于模型失联，首字超时不触发。纯 tool 循环被误杀是线上主
 * agent 中断的另一来源（与 T17 子域秒杀并列）。
 *
 * ## 终态与事件路合流（T14）
 *
 * 两条路都能判出终态，**必须**合流到同一个闸门，否则会发两次 `task.completed`（或把
 * 失败判成成功）。本函数的职责只有三件，**不自己发终态事件**：
 * 1. **先问闸门**：每轮开始读 `eventSignal.peek()`——事件路已判 failed/interrupted 时
 *    轮询路**不得**宣告成功（事件证据优先）；事件路已判 succeeded 时**也算完成**
 *    （v2 的 run 级结果只在事件路有，轮询路看不到 `idle` 消息的 outcome）。
 * 2. **记下自己的证据**：轮询路判定完成时 `eventSignal.notePolling({verdict:'succeeded'})`
 *    ——一次性收口（`settle()`）仍由调用方做，本函数**不消耗**它。
 * 3. **给事件路一个宽限期**（`eventGraceMs`）：轮询路先看到完成、事件路还没到时，等一小段
 *    让它补齐——这样「轮询先到」与「事件先到」两种顺序**得到同一个结论**。
 */
export async function awaitCompletion(
  driver: OpenCodeDriver,
  sessionID: string,
  options: AwaitCompletionOptions = {},
): Promise<CompletionResult> {
  const {
    firstTokenTimeoutMs = 0,
    totalTimeoutMs = 0,
    pollMs = 500,
    onPoll,
    baselineIds,
    onServeError,
    serveErrorReader,
    serveLogReader,
    serveLogTailLines = 20,
    eventSignal,
    eventGraceMs = 500,
    logger,
  } = options;
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let collected: DriverMessage[] = [];
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

  let finish: DriverContent | undefined;
  let totalTimedOut = false;
  /** T14：本轮是否已判定完成（轮询路的 step-finish，或事件路的 succeeded）。 */
  let completed = false;
  /** T14：终态证据来源（写进结果，供调用方记日志/排障）。 */
  let terminalEvidence: 'event' | 'polling' | undefined;
  /** T14：事件路判死（failed/interrupted）时的终态；null = 未判死。 */
  let eventFailure: RunOutcome | null = null;

  /** 拉一次消息快照并合并进 collected（终态判定后补拉用：终态那一刻内容才落齐）。 */
  const refresh = async (): Promise<void> => {
    const messages = await driver.getMessages(sessionID);
    const fresh = filterFresh(messages, baselineIds);
    collected = mergeMessages(collected, fresh);
    onPoll?.(fresh, Date.now() - startedAt);
  };

  while (true) {
    // ① 事件路终态优先：上游已判失败/中断时，轮询路不得宣告成功（事件证据优先）。
    //    v2 的 run 级结果只在事件路有（idle 消息的 outcome 被驱动丢弃），故这里是
    //    「失败」的唯一权威来源；轮询路只能看到「某一步以 stop 收尾」。
    const eventOutcome = eventSignal?.peek() ?? null;
    if (eventOutcome !== null && eventOutcome.verdict !== 'succeeded') {
      eventFailure = eventOutcome;
      logger?.info(
        `[prompt-await] 会话 ${sessionID} 事件路判定本轮${
          eventOutcome.verdict === 'interrupted' ? '被中断' : '失败'
        }（证据=event）：${eventOutcome.error ?? '-'}`,
      );
      break;
    }
    const messages = await driver.getMessages(sessionID);
    // P1：只处理基线之后新增的消息（复用会话不混入历史轮次）
    const fresh = filterFresh(messages, baselineIds);
    collected = mergeMessages(collected, fresh);
    onPoll?.(fresh, Date.now() - startedAt);
    finish = findFinish(collected);
    if (finish) {
      // ② 轮询路判定完成 → 先给事件路一个**有界宽限期**补齐终态：让「轮询先到」与
      //    「事件先到」得到**同一个结论**（事件证据优先）。
      //    ⚠️ 顺序很关键：宽限期**内**不能先 `notePolling`——闸门的 `peek()` 返回的是
      //    「事件证据 ?? 轮询证据」，一旦记下自己的证据，`peek()` 就再也分不出
      //    「事件路还没说话」与「事件路说了 succeeded」→ 宽限期会立刻结束、事件路的
      //    迟到失败就被丢掉（把失败判成成功）。故：**先问、后记**。
      let outcome: RunOutcome | null = null;
      if (eventSignal !== undefined) {
        const graceDeadline = Date.now() + Math.max(0, eventGraceMs);
        for (;;) {
          outcome = eventSignal.peek();
          if (outcome !== null || Date.now() >= graceDeadline) {
            break;
          }
          await sleep(Math.min(pollMs, Math.max(1, graceDeadline - Date.now())));
        }
      }
      if (outcome === null) {
        // 事件路没说话（或压根没有事件路）→ 轮询路的证据生效
        terminalEvidence = 'polling';
        eventSignal?.notePolling({ verdict: 'succeeded' });
      } else if (outcome.verdict === 'succeeded') {
        terminalEvidence = 'event';
        eventSignal?.notePolling({ verdict: 'succeeded' });
      } else {
        // 分歧：轮询路看到完成，事件路说失败/中断 —— 事件证据优先，轮询路不宣告成功。
        eventFailure = outcome;
        eventSignal?.notePolling({
          verdict: 'failed',
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        });
        logger?.warn(
          `[prompt-await] 会话 ${sessionID} 轮询路与事件路判定分歧（轮询=完成 事件=${
            outcome.verdict
          }），按事件路判定：${outcome.error ?? '-'}`,
        );
      }
      completed = eventFailure === null;
      break;
    }
    // ③ 事件路已判成功但轮询路还没看到 step-finish —— 事件路同样是权威的完成来源
    //    （v2 的 run 级结果只在事件路有）。补拉一次快照把终态内容取齐后完成。
    if (eventOutcome !== null && eventOutcome.verdict === 'succeeded') {
      await refresh();
      finish = findFinish(collected);
      terminalEvidence = 'event';
      completed = true;
      eventSignal?.notePolling({ verdict: 'succeeded' });
      logger?.info(`[prompt-await] 会话 ${sessionID} 事件路判定完成（证据=event）`);
      break;
    }
    // T15：模型调用错误（info.error 非 Aborted）提前失败——serve 实测 APIError 消息
    // parts=[]（首字永不出现，也无 step-finish），等满 firstTokenTimeoutMs 超时无意义；
    // 立即走超时路径（abort + 抛 CompletionTimeoutError，文案带 info.error 详情）
    if (extractMessageError(collected) !== null) {
      // 事件路已给出失败判定时用它（证据更全：带 HTTP 码与响应体），否则用轮询路自己的抽取。
      const failed = eventSignal?.peek() ?? null;
      if (failed !== null && failed.verdict !== 'succeeded') {
        eventFailure = failed;
      }
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
    // 首字：轮询路（非空 text / 任意 reasoning）+ 事件路（非空 text.delta / 任意 reasoning 事件）
    if (
      firstTokenAt === null &&
      (hasFirstToken(collected) || eventSignal?.firstToken?.() === true)
    ) {
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
    if (firstTokenTimeoutMs > 0 && firstTokenAt === null && !hasInFlightTool(collected) && Date.now() - Math.max(startedAt, lastActivityAt) >= firstTokenTimeoutMs) {
      break;
    }
    // 总时长上限（opt-in）：首字已出现但到期限仍无 step-finish → 触发（复用下方 !finish 的
    // abort + CompletionTimeoutError 路径）。无 hasInFlightTool 豁免——上限是硬预算。
    if (totalTimeoutMs > 0 && Date.now() - startedAt >= totalTimeoutMs) {
      totalTimedOut = true;
      break;
    }
    await sleep(pollMs);
  }

  const result = buildResult(collected, terminalEvidence);
  // 事件路判死：上游已给出权威失败/中断 → 失败优先于轮询路的任何完成迹象。
  if (eventFailure !== null) {
    try {
      await driver.abort(sessionID);
    } catch {
      // abort 失败不掩盖终态错误（双保险中 HTTP abort 已尽力）
    }
    throw new RunTerminalError(sessionID, eventFailure, result);
  }
  if (!completed) {
    try {
      await driver.abort(sessionID);
    } catch {
      // abort 失败不掩盖超时错误（双保险中 HTTP abort 已尽力）
    }
    throw new CompletionTimeoutError(sessionID, result, collected, serveErrorText ?? undefined, serveLogTail, totalTimedOut ? 'total' : 'first-token');
  }
  logger?.info(
    `[prompt-await] 会话 ${sessionID} 判定完成（证据=${terminalEvidence ?? 'polling'}）`,
  );
  return result;
}

/** sendMessage → awaitCompletion 组合（T6 单次下发的标准入口）。 */
export async function sendAndAwait(
  driver: OpenCodeDriver,
  sessionID: string,
  input: Parameters<OpenCodeDriver['sendMessage']>[1],
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
 *
 * tool part 的**状态重发**（状态流转去重）：serve 的 tool part 在模型参数解析完成前
 * 就以 `{status:'pending', input:{}}` 空壳落盘，参数/输出稍后才写入同一 `part.id`。
 * 纯「首次上送一次」会把每个工具调用永久冻结在参数解析前的空态（线上表现：聊天 UI
 * 大量工具卡片永远 running + 输入 {} + 空输出）。故 tool part 按**可观测状态指纹**
 * （status/input/output 的有界采样哈希）去重：指纹变化即重发同一 part（part.id 不变，
 * server 侧按 id 合并覆盖），指纹不变不重发。
 * text/reasoning part 按**内容增长阈值**重发：累计增长 ≥ TEXT_GROWTH_MIN_CHARS
 * 字符才重发同一 part——思考/正文随生成过程流动刷新（流式观感），又不会每轮 poll
 * 都重传累积全文（带宽回归）；终态全量仍由 task.completed 的 result.parts 兜底。
 */
/**
 * tool part 单调进度指纹：状态rank × 1e12 + input 长度 × 1e6 + output 长度。
 * 双路（SSE 实时 + 轮询快照）并发上送同一 part 时，**进度大的赢、旧快照盖不住新状态**——
 * serve 快照天然可能比 SSE 事件旧（轮询间隙），用状态字符串直接比较会regress
 * （completed 快照晚到反而把卡片打回 running）。rank：pending=0 / running=1 /
 * 其余（completed/error/未知终态）=2。input/output 长度单调增长（append-only）。
 *
 * **v2 的取值是小写**（实测 2.0.28：`running` → `completed`/`error`；`Running`/`Completed`
 * 只是 OpenAPI 的**类型名**不是取值）——这里再取一次 `toLowerCase()` 兜底（万一上游把
 * 类型名当值传上来）。`pending`/`queued` 是 v1 的形态，留在表里不回退。
 */
const TOOL_STATUS_RANK: Record<string, number> = {
  pending: 0,
  queued: 0,
  running: 1,
  streaming: 1,
  completed: 2,
  error: 2,
};
const TOOL_PROGRESS_BASE = 1e12;
const TOOL_INPUT_WEIGHT = 1e6;

/**
 * 工具输出长度：vteam 内部模型里是 `state.output`（**字符串**）；v2 的 wire 形态是
 * `state.content`（**数组**）。两种都认——驱动已在边界把 content[] 归一成 output
 * （`normalizeV2ToolState`），这里再兜一层，避免「未归一的 part」让指纹算不出长度
 * （长度算不出 = 进度不涨 = 卡片不刷新）。
 */
function toolOutputLength(state: { output?: unknown; content?: unknown }): number {
  if (typeof state.output === 'string') {
    return state.output.length;
  }
  if (Array.isArray(state.content)) {
    let len = 0;
    for (const item of state.content) {
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') {
        len += text.length;
      }
    }
    return len;
  }
  return safeJsonLength(state.output);
}

function toolProgress(part: DriverContent): string {
  const state = part.state as
    | { status?: unknown; input?: unknown; output?: unknown; content?: unknown }
    | undefined
    | null;
  if (state === undefined || state === null || typeof state !== 'object') {
    return String(TOOL_PROGRESS_BASE * 2);
  }
  const status = typeof state.status === 'string' ? state.status.toLowerCase() : '';
  const rank = TOOL_STATUS_RANK[status] ?? 2;
  const inLen = typeof state.input === 'string' ? state.input.length : safeJsonLength(state.input);
  const outLen = toolOutputLength(state);
  return String(rank * TOOL_PROGRESS_BASE + inLen * TOOL_INPUT_WEIGHT + outLen);
}

function safeJsonLength(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  try {
    return (JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

/**
 * text/reasoning part 的内容增长重发阈值（字符）：serve 的 text/reasoning part 同一
 * `part.id` 随生成累积变长（append-only），按阈值重发让 UI 流动刷新思考/正文，
 * 又避免每轮 poll（默认 500ms）重传累积全文的带宽回归。终态全量由 task.completed
 * 的 result.parts 兜底，阈值截断不影响最终内容。
 */
export const TEXT_GROWTH_MIN_CHARS = 64;

/**
 * text/reasoning part 指纹 = 候选文本字段总长度（`L<len>`，append-only 单调增长）；
 * 无任何文本字段 → ''（维持首次即发一次，如空壳占位）。
 */
function textGrowthFingerprint(part: DriverContent): string {
  const p = part as {
    text?: unknown;
    summary?: unknown;
    thoughts?: unknown;
    detail?: unknown;
  };
  let len = 0;
  for (const key of ['text', 'summary', 'thoughts', 'detail'] as const) {
    const v = p[key];
    if (typeof v === 'string') {
      len += v.length;
    }
  }
  return len > 0 ? `L${len}` : '';
}

/** 首发/记录基准指纹：tool → 单调进度值；text/reasoning → 增长长度；其余 → ''（仅首发）。 */
function fingerprintOf(part: DriverContent): string {
  if (part.type === 'tool') {
    return toolProgress(part);
  }
  if (part.type === 'text' || part.type === 'reasoning') {
    return textGrowthFingerprint(part);
  }
  return '';
}

export class MessageDeltaTracker {
  /** part key → 最近一次上送时的指纹（tool=单调进度 / text·reasoning=增长长度 / 其余=''）。 */
  private readonly sentPartKeys = new Map<string, string>();

  /** 返回本轮 messages 中**首次出现**或**可观测状态已推进**的 **assistant** 消息 parts
   *  （扁平拼接）；无新增/无推进返回空数组。
   *  P1/P6：过滤 role=assistant——user/system 消息（含 prompt 注入的 [群聊历史消息]/
   *  doclib 上下文）绝不进入流式回复，杜绝聊天记录显示注入重复内容。
   *  双路并发（SSE 实时 + 轮询快照）：轮询快照可能比 SSE 事件旧——tool 进度值、
   *  text 长度均为**单调**量，旧快照永远小于已记录值，不会回覆盖（见 noteSent）。 */
  extractNewParts(messages: DriverMessage[]): DriverContent[] {
    const fresh: DriverContent[] = [];
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
        const prev = this.sentPartKeys.get(key);
        if (prev === undefined) {
          // 首次出现：任何类型都上送
          this.sentPartKeys.set(key, fingerprintOf(part));
          fresh.push(part);
          continue;
        }
        // tool part：单调进度推进才重发（pending→running→completed；旧快照不回退）
        if (part.type === 'tool') {
          const fp = toolProgress(part);
          if (Number(fp) > Number(prev)) {
            this.sentPartKeys.set(key, fp);
            fresh.push(part);
          }
          continue;
        }
        // text/reasoning part：内容累计增长 ≥ 阈值才重发（流式刷新 + 带宽受控）
        if (part.type === 'text' || part.type === 'reasoning') {
          const fp = textGrowthFingerprint(part);
          if (fp === '') {
            continue; // 无文本字段（空壳/占位）：不重发
          }
          const prevLen = prev.startsWith('L') ? Number(prev.slice(1)) : 0;
          const curLen = Number(fp.slice(1));
          if (curLen - prevLen >= TEXT_GROWTH_MIN_CHARS) {
            this.sentPartKeys.set(key, fp);
            fresh.push(part);
          }
          continue;
        }
        // 其余类型（step-start/step-finish/patch 等）：首次已发，不再上送
      }
    }
    return fresh;
  }

  /**
   * 记录「已直接上送」的 part（SSE 实时路用）：把状态推进量写入 sentPartKeys，
   * 使后续轮询快照对同一 part 的比较以 SSE 已发进度为基准——旧快照压下不回退，
   * 更新的快照仍可继续推进。与 extractNewParts 共用同一套指纹口径。
   */
  noteSent(part: DriverContent): void {
    this.sentPartKeys.set(part.id ?? `<noid>:${fingerprintOf(part)}`, fingerprintOf(part));
  }

  /**
   * SSE 实时路**单调准入**：仅当 part 对同一 part.id 而言是「新增或推进」的快照才放行
   * 并更新基准；否则丢弃且**不降低**已记录基准。与 extractNewParts 共用 sentPartKeys
   * 单一基准（双路不会互相回退覆盖）。返回 true = 可上送。
   *
   * 为什么需要：serve /event 不重放历史帧，SSE 连接**晚于**同轮轮询建立时，delta 缓冲
   * 从零累积——合成 part 的文本会**短于**轮询路已上送的全文（且是全文的后缀片段）。
   * 旧实现（noteSent 无条件记录 + 无条件上送）会把该短快照发出去，经 server
   * last-write-wins 合并 / 前端整条替换覆盖更长文本 → 渲染回退（先出现→消失→再出现）。
   *
   * 规则：
   * - tool：进度值严格大于已记录 → 放行（pending→running→completed；旧快照不回退）
   * - text/reasoning：`kind=delta`（增量合成，可能是不完整后缀）要求文本累计长度**严格增长**；
   *   `kind=update`（权威整快照）允许**等长**替换（如 reasoning 终态修正 type/time），
   *   但仍拒绝更短快照
   * - 其余类型：仅首次出现放行
   */
  admitSsePart(part: DriverContent, kind: 'update' | 'delta' = 'delta'): boolean {
    const key = part.id ?? `<noid>:${fingerprintOf(part)}`;
    const prev = this.sentPartKeys.get(key);
    const fp = fingerprintOf(part);
    if (prev === undefined) {
      this.sentPartKeys.set(key, fp);
      return true;
    }
    if (part.type === 'tool') {
      if (Number(fp) > Number(prev)) {
        this.sentPartKeys.set(key, fp);
        return true;
      }
      return false;
    }
    if (part.type === 'text' || part.type === 'reasoning') {
      if (fp === '') {
        return false;
      }
      const prevLen = prev.startsWith('L') ? Number(prev.slice(1)) : 0;
      const curLen = Number(fp.slice(1));
      if (curLen > prevLen || (kind === 'update' && curLen === prevLen)) {
        this.sentPartKeys.set(key, fp);
        return true;
      }
      return false;
    }
    return false;
  }

  /** 重置已上送集合（多轮执行复用实例时隔离）。 */
  reset(): void {
    this.sentPartKeys.clear();
  }
}
