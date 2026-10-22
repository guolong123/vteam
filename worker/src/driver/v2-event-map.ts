/**
 * T12 v2 事件映射表：OpenCode v2 的 SSE 事件 → vteam 内部事件（计划 T12 / 决策 D4）。
 *
 * 为什么是「表」而不是一串 if：v2 的事件目录有近百条（附录 B），映射规则要同时表达
 * 三件事——**映到哪个 vteam 事件**、**载荷长什么样**、**这条事件能不能作状态判定**。
 * 用 if 链表达这三条 inevitably 会漏掉其中一条（尤其是第三条：ephemeral 事件一旦
 * 被当成状态判定来源，就会写出「断线期间从未发生过」的状态）。故本文件把映射写成
 * **数据**（`V2_EVENT_MAP`），把「durable / ephemeral」也写进数据里，测试直接对着
 * 数据断言覆盖率。
 *
 * 三条铁律（映射表的消费方必须遵守）：
 * 1. **只有 durable 事件能驱动状态判定**。durable = 帧带 `durable:{aggregateID,seq,version}`
 *    （可重放、有单调序号）；ephemeral = 无 `durable`（断线即丢、不可重放）。
 *    ephemeral 事件只能**触发一次动作**（如「去拉一次权限列表」），不能直接写状态。
 * 2. **每个映射出的事件都带上游身份**（`UpstreamEventIdentity`）：帧 id `evt_…` +
 *    durable 游标 + 增量序号 ordinal。worker→server 的传输 id（`evw_<bootId>_<seq>`）
 *    是**进程内**的、跨 worker 重启不复用；上游身份才跨重启稳定（server 据此去重）。
 * 3. **终态只有一个出口**。`session.execution.*` 映射出的终态事件标记
 *    `terminal: true`，由 `RunTerminalGate` 统一收口——事件路与消息轮询路**不得**
 *    各发一次完成事件。
 *
 * 实测基线（opencode v2.0.28 实机抓帧，`docs/agent-platform/opencode-v2-contract-baseline/sse-sample.txt`
 * + T4 spike 抓帧）：帧信封是 `{id, created, type, location?, data, durable?}`，
 * **data 是扁平的**（不是 v1 的 `properties` 嵌套）；文本增量的字段名是 **`delta`**
 * （不是 `text`）；`durable` 在 `session.text.delta` / `session.usage.updated` 上**缺席**
 * ——即这两条是 ephemeral（附录 B 把 `session.usage.updated` 标成 durable，与实机不符，
 * 以实机为准）。
 */

import {
  DriverContent,
  DriverMessage,
  DriverTokenUsage,
} from './opencode-driver';
import { normalizeV2ToolState } from './v2-driver';
import {
  parseUnifiedV2PartId,
  v2ContentPartId,
  v2ReasoningPartId,
  v2StepFinishPartId,
  v2TextPartId,
  v2ToolPartId,
} from './v2-part-id';
import {
  UpstreamEventIdentity,
  WORKER_EVENT_TYPES,
  WorkerEventType,
} from '../protocol/worker-protocol';

/** v2 帧的 durable 游标（仅 durable 事件带）。 */
export interface V2DurableCursor {
  /** 聚合 id（会话级事件 = 会话 id `ses_…`）。 */
  aggregateID: string;
  /** 聚合内单调序号（从 0 开始）。 */
  seq: number;
  /** 聚合版本号。 */
  version: number;
}

/** 解析后的 v2 事件帧（vteam 侧的扁平形状）。 */
export interface V2EventFrame {
  /** 帧 id（`evt_…`）。 */
  id: string;
  /** 事件类型（`data.type`；SSE 帧带 `event:` 行时优先取它）。 */
  type: string;
  /** 事件创建时间（ms；部分帧无）。 */
  created?: number;
  /** 会话/项目目录（部分帧有、部分帧无）。 */
  location?: { directory?: string };
  /** 事件负载（**扁平**，字段直接挂在 data 下）。 */
  data: Record<string, unknown>;
  /** durable 游标（ephemeral 事件无此字段）。 */
  durable?: V2DurableCursor;
}

/** 映射上下文（映射函数需要的外部状态）。 */
export interface V2EventContext {
  /** 目标会话 id（调用方已按会话过滤）。 */
  sessionId: string;
  /** 流式累积器（把增量事件累积成「当前全文」part）。 */
  accumulator: V2StreamAccumulator;
}

/** 映射出的 vteam 事件。 */
export interface V2MappedEvent {
  kind: 'event';
  /** vteam 事件类型（取自 `WORKER_EVENT_TYPES`，不新增名字）。 */
  type: WorkerEventType;
  /** 事件载荷（不含 ctx 字段与上游身份——由桥接层补齐）。 */
  payload: Record<string, unknown>;
  /**
   * 终态判定（非终态事件为 undefined）。
   *
   * 终态事件**不直接发送**——由 `RunTerminalGate` 统一收口（事件路与消息轮询路
   * 都到得了时，只允许发一次完成事件）。
   */
  terminal?: RunTerminalVerdict;
}

/** 映射出的「触发动作」（ephemeral 事件专用：只触发一次拉取，不写状态）。 */
export interface V2MappedTrigger {
  kind: 'trigger';
  /** 触发哪种拉取。 */
  trigger: 'permission' | 'question';
  /** 待拉取的会话 id。 */
  sessionId: string;
}

export type V2MappingOutcome = V2MappedEvent | V2MappedTrigger;

/** 映射表的一行：一个 v2 事件 → vteam 事件（或触发动作）。 */
export interface V2EventMapping {
  /**
   * 该 v2 事件是否 durable。
   *
   * true = 帧带 `durable:{aggregateID,seq,version}`，可重放、有单调序号 → **可作状态判定**；
   * false = ephemeral（断线即丢、不可重放）→ **只能触发动作，不能写状态**。
   */
  durable: boolean;
  /** 派生 vteam 事件 / 触发动作。 */
  derive: (frame: V2EventFrame, ctx: V2EventContext) => V2MappingOutcome[];
}

// ---------------------------------------------------------------------------
// 小工具（宽松读取：上游字段缺失时降级，绝不抛）
// ---------------------------------------------------------------------------

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function num(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rec(data: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = data[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * 增量文本字段：v2 实测是 **`delta`**（不是 v1 的 `text`）；个别事件用 `text`
 * （如 `session.tool.input.ended`）→ 两个都读，`delta` 优先。
 */
function deltaText(data: Record<string, unknown>): string {
  const delta = data.delta;
  if (typeof delta === 'string') {
    return delta;
  }
  const text = data.text;
  return typeof text === 'string' ? text : '';
}

// ---------------------------------------------------------------------------
// 上游身份（去重键）
// ---------------------------------------------------------------------------

/**
 * 由帧派生上游身份。
 *
 * - `eventId` = 帧 id（`evt_…`）——跨进程稳定；
 * - `aggregateId`/`seq` = durable 游标——**跨进程稳定且聚合内单调**（最适合当幂等键）；
 * - `ordinal` = 内容序号（同类内容流的序号）——⚠️ **不是逐帧计数器**（实机抓帧：
 *   同一条 assistant 消息的多帧 delta 全是同一个 ordinal），只作参考，不作单调闸门。
 */
export function deriveUpstreamIdentity(frame: V2EventFrame): UpstreamEventIdentity {
  const identity: UpstreamEventIdentity = { eventId: frame.id };
  if (frame.durable) {
    identity.aggregateId = frame.durable.aggregateID;
    identity.seq = frame.durable.seq;
  }
  const ordinal = num(frame.data, 'ordinal');
  if (ordinal !== undefined) {
    identity.ordinal = ordinal;
  }
  return identity;
}

/**
 * 由上游身份派生**去重键**（server 侧幂等用；worker 侧亦用它做一次性闸门）。
 *
 * - `durable:<aggregateId>:<seq>` —— **跨 worker 重启稳定**（durable 事件首选）；
 * - `event:<eventId>` —— 其余事件（帧 id 唯一）。
 *
 * ⚠️ **不用 `ordinal` 做键**：实机抓帧证明 `ordinal` **不是逐帧计数器**（同一条 assistant
 * 消息的多帧 delta 全是 0——它是「同类内容流」的序号，不是帧序号），拿它当逐帧单调量会
 * 把同一消息的多个 delta 折叠成一条。逐帧去重只能靠帧 id（`evt_…` 本身唯一）。
 */
export function deriveUpstreamDedupKey(identity: UpstreamEventIdentity): string {
  if (identity.aggregateId !== undefined && identity.seq !== undefined) {
    return `durable:${identity.aggregateId}:${identity.seq}`;
  }
  return `event:${identity.eventId}`;
}

/**
 * 从帧解析会话 id（`/api/event` 是**全局总线**，所有会话的事件都涌到同一条连接）。
 *
 * 取值顺序：`data.sessionID` → `data.form.sessionID`（表单事件把会话 id 放在表单里）
 * → `durable.aggregateID`（会话级 durable 事件的聚合 id 就是会话 id）。
 * 都取不到 → 返回空串（调用方据此丢弃该帧）。
 */
export function resolveV2SessionId(frame: V2EventFrame): string {
  const direct = str(frame.data, 'sessionID');
  if (direct !== '') {
    return direct;
  }
  const form = rec(frame.data, 'form');
  const formSession = form ? str(form, 'sessionID') : '';
  if (formSession !== '') {
    return formSession;
  }
  const aggregate = frame.durable?.aggregateID ?? '';
  return aggregate.startsWith('ses_') ? aggregate : '';
}

// ---------------------------------------------------------------------------
// 流式累积器
// ---------------------------------------------------------------------------

/**
 * 增量累积器：把 v2 的**增量**事件累积成「当前全文」。
 *
 * 为什么必须累积：vteam 的 `message.part.delta` 载荷是 **part 快照**（server 侧按
 * part id 做 last-write-wins 合并），不是增量片段——只把 `delta` 原样发过去，server
 * 侧存下来的正文永远只有最后一个片段。
 *
 * 键的取法：文本/思考用 `${messageID}:text` / `${messageID}:reasoning`（一条 assistant
 * 消息一条流）；工具入参用 `${messageID}:tool:${callID}:input`。
 */
export class V2StreamAccumulator {
  private readonly buffers = new Map<string, string>();

  /** 追加一段增量，返回累积后的全文。 */
  append(key: string, delta: string): string {
    if (delta === '') {
      return this.buffers.get(key) ?? '';
    }
    const next = (this.buffers.get(key) ?? '') + delta;
    this.buffers.set(key, next);
    return next;
  }

  /** 读当前累积值（无则空串）。 */
  get(key: string): string {
    return this.buffers.get(key) ?? '';
  }

  /** 当前缓冲条目数（可观测）。 */
  get size(): number {
    return this.buffers.size;
  }

  /**
   * 清空累积缓冲。
   *
   * **断线重连时必须调用**：v2 的 `/api/event` 是 volatile 契约的实时总线
   * （"events during disconnection are missed"）——不重放历史帧。跨连接续用旧缓冲会
   * 把「断线前已流过的文本」与「重连后的片段」拼成一段**从未存在过的正文**。
   */
  clear(): void {
    this.buffers.clear();
  }
}

// ---------------------------------------------------------------------------
// 终态闸门（终态判定的唯一出口）
// ---------------------------------------------------------------------------

/** 终态判定结果。 */
export type RunTerminalVerdict = 'succeeded' | 'failed' | 'interrupted';

/** 终态判定详情。 */
export interface RunTerminalOutcome {
  verdict: RunTerminalVerdict;
  /** 失败/中断原因（可读文本）。 */
  error?: string;
}

/**
 * RunTerminalGate：终态判定的**唯一出口**。
 *
 * 两条判定来源：
 * - **事件路**（durable 的 `session.execution.succeeded/failed/interrupted`）——权威；
 * - **消息轮询路**（`prompt-await` 观察到 assistant 消息终态）——兜底。
 *
 * 两条路**只能有一个出口**：事件路**不直接发送**终态事件（映射出的终态事件标记
 * `terminal: true`），由本闸门统一裁决后再发——否则「事件先到、轮询后到」会发两次
 * `task.completed`（server 侧按 step-finish 幂等键挡得住用量落库，但挡不住
 * 前端重复的「已完成」提示与 watchdog 计时）。
 *
 * 单调性闸门：事件路的证据带 durable `seq`——**重放的旧 seq 不覆盖新证据**
 * （SSE 与将来的 durable-log 补齐两条路会送来同一条事件）。
 */
export class RunTerminalGate {
  private eventOutcome: RunTerminalOutcome | null = null;
  private eventSeq: number | undefined;
  private pollingOutcome: RunTerminalOutcome | null = null;
  private settled = false;

  /**
   * 记录事件路的终态证据。
   *
   * @param outcome 终态判定
   * @param identity 上游身份（带 durable seq 时用于单调性闸门）
   * @returns true = 本次调用采纳了该证据（false = 已有证据或旧 seq 重放）
   */
  noteEvent(outcome: RunTerminalOutcome, identity?: UpstreamEventIdentity): boolean {
    if (this.eventOutcome !== null) {
      return false;
    }
    const seq = identity?.seq;
    if (seq !== undefined) {
      if (this.eventSeq !== undefined && seq <= this.eventSeq) {
        return false;
      }
      this.eventSeq = seq;
    }
    this.eventOutcome = outcome;
    return true;
  }

  /** 记录轮询路的终态证据（首次生效）。 */
  notePolling(outcome: RunTerminalOutcome): void {
    if (this.pollingOutcome === null) {
      this.pollingOutcome = outcome;
    }
  }

  /**
   * 取终态判定（**一次性**）：事件证据优先于轮询证据。
   *
   * 第二次调用返回 null —— 终态事件只允许发一次。
   */
  settle(): RunTerminalOutcome | null {
    if (this.settled) {
      return null;
    }
    const outcome = this.eventOutcome ?? this.pollingOutcome;
    if (outcome === null) {
      return null;
    }
    this.settled = true;
    return outcome;
  }

  /** 只读窥视（不消耗一次性闸门；用于「事件说成功但轮询失败」这类兜底分支）。 */
  peek(): RunTerminalOutcome | null {
    return this.eventOutcome ?? this.pollingOutcome;
  }
}

/** 执行终态事件（durable；**运行级**结果，不是 step 级）。 */
const EXECUTION_TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

/**
 * 判断一帧是否是「用户 prompt 已入队」信号。
 *
 * v2 把**目录切换（move）**也做成 inbox 条目（实测 2.0.32 / 2.1.2：
 * `session.inbox.enqueued{item.type:'move'}` → `session.execution.started` →
 * `session.execution.succeeded`），随后才是真正的 prompt 条目
 * （`item.type:'user'` → `session.execution.started` → …）。
 */
export function isUserPromptEnqueuedFrame(frame: V2EventFrame): boolean {
  if (frame.type !== 'session.inbox.enqueued') {
    return false;
  }
  const item = rec(frame.data, 'item');
  return item !== undefined && str(item, 'type') === 'user';
}

/**
 * 每轮执行的事件归属闸门：**只承认本轮用户 prompt 所启动的那次执行**的终态。
 *
 * 为什么需要（线上根因，opencode 2.1.2 / 2.0.32 均复现）：
 * `V2Driver.sendMessage` 在首次下发前会 `POST /api/session/{id}/move` 切目录；v2 把
 * move 实现成一个 **inbox 条目**，它的执行独立发一对
 * `session.execution.started` / `session.execution.succeeded`（实测早于用户 prompt
 * 入队 10~200ms）。`RunTerminalGate` 只看「有没有 succeeded」，于是把 **move 的成功**
 * 当成本轮结束：`runSendAndAwait` 立刻返回、SSE 订阅关闭、onPoll 停止——而用户 prompt
 * 其实还没开始跑。之后模型请求权限时既没有事件订阅也没有 onPoll，
 * `session.permission` 永远上不去（用户只看到 serve 原生确认框）。
 *
 * 归属判据（与版本无关，只看事件顺序）：本轮终态必须发生在
 * ① `session.inbox.enqueued{item.type:'user'}` 之后，且
 * ② 该帧之后至少一次 `session.execution.started`。
 */
export class V2RunEventScope {
  private promptEnqueued = false;
  private runStarted = false;

  /** 观察一帧（每帧一次，顺序与总线一致）；返回该帧终态是否属于本轮。 */
  observe(frame: V2EventFrame): { allowTerminal: boolean } {
    if (isUserPromptEnqueuedFrame(frame)) {
      this.promptEnqueued = true;
    }
    if (frame.type === 'session.execution.started' && this.promptEnqueued) {
      this.runStarted = true;
    }
    const isTerminal = EXECUTION_TERMINAL_EVENTS.has(frame.type);
    const allowTerminal = isTerminal && this.promptEnqueued && this.runStarted;
    if (isTerminal) {
      // 终态只归属一次：之后的终态属于下一轮/迟到帧，不再重复收口
      this.runStarted = false;
    }
    return { allowTerminal };
  }

  /** 本轮是否已绑定用户 prompt 的执行（可观测/测试用）。 */
  get bound(): boolean {
    return this.promptEnqueued && this.runStarted;
  }
}

// ---------------------------------------------------------------------------
// part id 归一（兼容层；正式口径见 `v2-part-id.ts`）
// ---------------------------------------------------------------------------

/**
 * v2 内容 id 的**兼容层**归一（**不再**是「两套形态的 reconcile 点」）。
 *
 * 改造前：驱动合成下标形态 `${messageID}:${index}`（计划 D5 的旧口径），事件路合成
 * 类型化形态 `${messageID}:text` / `${messageID}:tool:${callID}`——两套形态**在 worker
 * 内部**并存，只能在上送边界 reconcile；于是任何直接消费驱动消息的代码（如
 * `prompt-await.ts`）看到的都是下标形态，一旦按 `part.id` 记账，两条路就会各记一次。
 *
 * 改造后：**驱动直接产出统一形态**（口径唯一，见 `v2-part-id.ts`），事件路也从那里取 →
 * 两条路径天然一致。本函数退化为**边界兜底**（exec-server 仍调用它）：
 * - **统一形态** → **原样透传**（幂等）。⚠️ 这一条是必须的：`${M}:text:1` 若再被当成
 *   下标形态改写一次，会变成 `${M}:text:text` 这种垃圾 id（server 侧再也合并不上）。
 * - **旧的下标形态**（`${messageID}:${index}`）→ 按统一口径改写（防御：外部/旧版实现
 *   可能产出这种 id；v2 驱动已不再产出）。
 * - 其余（v1 的 `prt_…`）→ 原样透传（**不动 v1 行为**）。
 *
 * @param seen 同一条消息内已归一过的类型计数（同类内容的第一条用无序号 id）
 * @returns 归一后的 id；undefined = 不该改（原样保留）
 */
export function unifyV2ContentId(
  part: DriverContent,
  seen: Map<string, number>,
): string | undefined {
  const raw = part.id;
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  const unified = parseUnifiedV2PartId(raw);
  if (unified) {
    // 已统一 → 透传；但把「同类序号」推进到已出现的位置之后，避免紧随其后的旧形态
    // part 与它撞 id（序号只按同类别计）。
    if (unified.kind === 'text' || unified.kind === 'reasoning') {
      const seenCount = seen.get(unified.kind) ?? 0;
      seen.set(unified.kind, Math.max(seenCount, unified.occurrence + 1));
    }
    return undefined;
  }
  const matched = /^(.*):(\d+)$/.exec(raw);
  if (!matched) {
    return undefined; // 非「驱动合成 id」形态 → 不改
  }
  const messageID = matched[1];
  const index = Number(matched[2]);
  const type = part.type;
  if (type === 'tool') {
    const callID = typeof part.callID === 'string' && part.callID !== '' ? part.callID : String(index);
    return v2ToolPartId(messageID, callID);
  }
  if (type === 'text' || type === 'reasoning') {
    const count = seen.get(type) ?? 0;
    seen.set(type, count + 1);
    // 同类内容的第一条用无序号 id（与事件路一致）；后续同类保留序号区分
    return v2ContentPartId(messageID, type, count);
  }
  return `${messageID}:${type}`;
}

/** 从 part id 反解消息 id（旧的下标形态 `${messageID}:${数字}` → messageID；不匹配则空串）。 */
function messageIdOfPartId(id: unknown): string {
  if (typeof id !== 'string') {
    return '';
  }
  const matched = /^(.*):\d+$/.exec(id);
  return matched ? matched[1] : '';
}

/**
 * 归一一批消息的内容 id（**边界兜底**；驱动已直接产出统一 id）。
 *
 * 幂等：统一形态的 id 原样保留（可重复调用，且不改变结果）。
 */
export function normalizeV2ContentIds(messages: DriverMessage[]): DriverMessage[] {
  return messages.map((message) => {
    const seen = new Map<string, number>();
    const parts = (message.parts ?? []).map((part) => {
      const unified = unifyV2ContentId(part, seen);
      return unified === undefined ? part : { ...part, id: unified };
    });
    return { ...message, parts };
  });
}

/**
 * 归一**扁平 part 列表**的 id（`task.completed` 载荷里的 `parts` 用）。
 *
 * 与 `normalizeV2ContentIds` 同口径，但按 part 自身的 id 前缀分组（扁平列表没有
 * message 容器，消息 id 只能从 id 里反解）。
 */
export function normalizeV2ContentIdList(parts: DriverContent[]): DriverContent[] {
  const seenByMessage = new Map<string, Map<string, number>>();
  return parts.map((part) => {
    const messageID = messageIdOfPartId(part.id);
    let seen = seenByMessage.get(messageID);
    if (!seen) {
      seen = new Map<string, number>();
      seenByMessage.set(messageID, seen);
    }
    const unified = unifyV2ContentId(part, seen);
    return unified === undefined ? part : { ...part, id: unified };
  });
}

// ---------------------------------------------------------------------------
// step-finish part（与 v2 驱动的合成保持等价）
// ---------------------------------------------------------------------------

/**
 * v2 的 token 用量 → vteam 用量口径。
 *
 * ⚠️ 与 `v2-driver.ts` 内部的 `mapV2Tokens` **逐字等价**（字段名与 v1 的 step-finish
 * 一致；v2 无 `total` → 不造数）。两处是同一份口径的两次实现（v2 驱动那份是模块私有的，
 * 不能跨文件引用）——`v2-event-map.spec.ts` 里有**跨实现等价断言**（拿真 V2Driver 的
 * 输出与本函数的输出逐字段比），任何一侧漂移都会红。
 */
export function mapV2TokenUsage(tokens: unknown): DriverTokenUsage | undefined {
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
    return undefined;
  }
  const source = tokens as Record<string, unknown>;
  const usage: DriverTokenUsage = {};
  if (typeof source.input === 'number') {
    usage.input = source.input;
  }
  if (typeof source.output === 'number') {
    usage.output = source.output;
  }
  if (typeof source.reasoning === 'number') {
    usage.reasoning = source.reasoning;
  }
  const cache = source.cache;
  if (cache !== null && typeof cache === 'object' && !Array.isArray(cache)) {
    const cacheRecord = cache as Record<string, unknown>;
    usage.cache = {};
    if (typeof cacheRecord.read === 'number') {
      usage.cache.read = cacheRecord.read;
    }
    if (typeof cacheRecord.write === 'number') {
      usage.cache.write = cacheRecord.write;
    }
  }
  return usage;
}

/**
 * 由 `session.step.ended` 合成 `step-finish` 形状的 part。
 *
 * 为什么要合成：v2 没有 `step-finish` 这个 part（升级成了 `session.step.*` 事件），
 * 但 vteam 控制面拿它当「本轮完成」的**幂等键**
 * （`server/src/chat/worker-dispatcher.ts` 的 `findStepFinishPartKey` 读
 * `part.type === 'step-finish'`）。⇒ 事件路必须补出同形状的 part，否则事件路上的
 * 完成事件在控制面认不出「本轮已完成」。
 *
 * 字段名与 v2 驱动（轮询路）的合成**逐字一致**（id / reason / cost / tokens），
 * 两条路产出的 part 对控制面是等价的。
 */
export function buildStepFinishPart(
  messageID: string,
  sessionID: string,
  finish: string,
  cost: unknown,
  tokens: unknown,
  created: number | undefined,
): DriverContent {
  const part: DriverContent = {
    id: v2StepFinishPartId(messageID),
    sessionID,
    messageID,
    type: 'step-finish',
    reason: finish,
    time: { start: created, end: created },
  };
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    part.cost = cost;
  }
  const usage = mapV2TokenUsage(tokens);
  if (usage !== undefined) {
    part.tokens = usage;
  }
  return part;
}

// ---------------------------------------------------------------------------
// 映射表
// ---------------------------------------------------------------------------

/** 组装一个 `message.part.delta` 映射结果。 */
function partOutcome(parts: DriverContent[]): V2MappedEvent {
  return {
    kind: 'event',
    type: WORKER_EVENT_TYPES.MESSAGE_PART_DELTA,
    payload: { parts },
  };
}

/** 文本/思考类 part 的通用构造。 */
function textualPart(
  sessionID: string,
  messageID: string,
  type: 'text' | 'reasoning',
  text: string,
): DriverContent {
  return {
    id: type === 'text' ? v2TextPartId(messageID) : v2ReasoningPartId(messageID),
    sessionID,
    messageID,
    type,
    text,
  };
}

/** 工具 part 的通用构造（state 走 v2 驱动的归一，输出字段与轮询路一致）。 */
function toolPart(
  sessionID: string,
  messageID: string,
  callID: string,
  name: string,
  state: Record<string, unknown>,
): DriverContent {
  return {
    id: v2ToolPartId(messageID, callID),
    sessionID,
    messageID,
    type: 'tool',
    tool: name,
    callID,
    state: normalizeV2ToolState(state),
  };
}

/** 工具事件的公共字段读取。 */
function toolFields(data: Record<string, unknown>): {
  messageID: string;
  callID: string;
  name: string;
} {
  return {
    messageID: str(data, 'assistantMessageID'),
    callID: str(data, 'id'),
    name: str(data, 'name'),
  };
}

/**
 * v2 事件 → vteam 事件映射表。
 *
 * 覆盖判据（测试断言）：**目录里的每一条 v2 事件，要么在这里有映射，要么显式列进
 * `KNOWN_UNSUPPORTED_V2_EVENTS`**——不允许「没想过」的静默空洞。
 */
export const V2_EVENT_MAP: Readonly<Record<string, V2EventMapping>> = {
  // ---- 执行终态（durable；终态由 RunTerminalGate 统一收口）----
  'session.execution.succeeded': {
    durable: true,
    derive: () => [
      { kind: 'event', type: WORKER_EVENT_TYPES.TASK_COMPLETED, payload: {}, terminal: 'succeeded' },
    ],
  },
  'session.execution.failed': {
    durable: true,
    derive: (frame) => {
      const error = rec(frame.data, 'error');
      const message = error ? str(error, 'message') : '';
      return [
        {
          kind: 'event',
          type: WORKER_EVENT_TYPES.AGENT_STATUS,
          payload: {
            status: 'error',
            error: message !== '' ? message : '执行失败（上游未给出错误详情）',
          },
          terminal: 'failed',
        },
      ];
    },
  },
  'session.execution.interrupted': {
    durable: true,
    derive: (frame) => {
      const reason = str(frame.data, 'reason');
      return [
        {
          kind: 'event',
          type: WORKER_EVENT_TYPES.AGENT_STATUS,
          payload: {
            status: 'error',
            error: reason !== '' ? `执行被中断：${reason}` : '执行被中断',
          },
          terminal: 'interrupted',
        },
      ];
    },
  },
  'session.execution.started': {
    durable: true,
    derive: () => [
      {
        kind: 'event',
        type: WORKER_EVENT_TYPES.SESSION_UPDATED,
        payload: { status: 'running' },
      },
    ],
  },

  // ---- step 维度 ----
  'session.step.started': {
    durable: true,
    derive: (frame) => {
      const payload: Record<string, unknown> = { status: 'running' };
      const agent = str(frame.data, 'agent');
      if (agent !== '') {
        payload.agent = agent;
      }
      const model = rec(frame.data, 'model');
      const providerID = model ? str(model, 'providerID') : '';
      const modelID = model ? str(model, 'id') : '';
      if (providerID !== '' && modelID !== '') {
        payload.model = `${providerID}/${modelID}`;
      }
      return [
        {
          kind: 'event',
          type: WORKER_EVENT_TYPES.SESSION_UPDATED,
          payload,
          },
      ];
    },
  },
  'session.step.ended': {
    durable: true,
    derive: (frame, ctx) => {
      const messageID = str(frame.data, 'assistantMessageID');
      const finish = str(frame.data, 'finish');
      if (messageID === '' || finish === '') {
        return [];
      }
      const part = buildStepFinishPart(
        messageID,
        ctx.sessionId,
        finish,
        frame.data.cost,
        frame.data.tokens,
        frame.created,
      );
      return [partOutcome([part])];
    },
  },

  // ---- 文本流 ----
  'session.text.started': {
    durable: true,
    derive: (frame, ctx) => {
      const messageID = str(frame.data, 'assistantMessageID');
      if (messageID === '') {
        return [];
      }
      return [partOutcome([textualPart(ctx.sessionId, messageID, 'text', '')])];
    },
  },
  'session.text.delta': {
    durable: false,
    derive: (frame, ctx) => {
      const messageID = str(frame.data, 'assistantMessageID');
      if (messageID === '') {
        return [];
      }
      const text = ctx.accumulator.append(`${messageID}:text`, deltaText(frame.data));
      return [partOutcome([textualPart(ctx.sessionId, messageID, 'text', text)])];
    },
  },
  'session.text.ended': {
    durable: true,
    derive: (frame, ctx) => {
      const messageID = str(frame.data, 'assistantMessageID');
      if (messageID === '') {
        return [];
      }
      // 实机抓帧：`session.text.ended` 带**权威全文**（data.text）——优先用它，
      // 累积器只作兜底（连接中途建立时累积器只有后缀片段）。
      const authoritative = typeof frame.data.text === 'string' ? frame.data.text : '';
      const text =
        authoritative !== ''
          ? authoritative
          : ctx.accumulator.get(`${messageID}:text`);
      return [partOutcome([textualPart(ctx.sessionId, messageID, 'text', text)])];
    },
  },

  // ---- 思考流 ----
  'session.reasoning.started': {
    durable: true,
    derive: (frame, ctx) => {
      const messageID = str(frame.data, 'assistantMessageID');
      if (messageID === '') {
        return [];
      }
      return [partOutcome([textualPart(ctx.sessionId, messageID, 'reasoning', '')])];
    },
  },
  'session.reasoning.delta': {
    durable: false,
    derive: (frame, ctx) => {
      const messageID = str(frame.data, 'assistantMessageID');
      if (messageID === '') {
        return [];
      }
      const text = ctx.accumulator.append(`${messageID}:reasoning`, deltaText(frame.data));
      return [partOutcome([textualPart(ctx.sessionId, messageID, 'reasoning', text)])];
    },
  },
  'session.reasoning.ended': {
    durable: true,
    derive: (frame, ctx) => {
      const messageID = str(frame.data, 'assistantMessageID');
      if (messageID === '') {
        return [];
      }
      // 与 session.text.ended 同口径：实机抓帧里它带权威全文（data.text）+ state
      const authoritative = typeof frame.data.text === 'string' ? frame.data.text : '';
      const text =
        authoritative !== ''
          ? authoritative
          : ctx.accumulator.get(`${messageID}:reasoning`);
      return [partOutcome([textualPart(ctx.sessionId, messageID, 'reasoning', text)])];
    },
  },

  // ---- 工具态 ----
  'session.tool.input.started': {
    durable: true,
    derive: (frame, ctx) => {
      const { messageID, callID, name } = toolFields(frame.data);
      if (messageID === '' || callID === '') {
        return [];
      }
      return [
        partOutcome([
          toolPart(ctx.sessionId, messageID, callID, name, { status: 'running' }),
        ]),
      ];
    },
  },
  'session.tool.input.delta': {
    durable: false,
    derive: (frame, ctx) => {
      const { messageID, callID, name } = toolFields(frame.data);
      if (messageID === '' || callID === '') {
        return [];
      }
      const key = `${messageID}:tool:${callID}:input`;
      const input = ctx.accumulator.append(key, deltaText(frame.data));
      return [
        partOutcome([
          toolPart(ctx.sessionId, messageID, callID, name, {
            status: 'running',
            input: { text: input },
          }),
        ]),
      ];
    },
  },
  'session.tool.input.ended': {
    durable: true,
    derive: (frame, ctx) => {
      const { messageID, callID, name } = toolFields(frame.data);
      if (messageID === '' || callID === '') {
        return [];
      }
      const key = `${messageID}:tool:${callID}:input`;
      const input = ctx.accumulator.get(key);
      return [
        partOutcome([
          toolPart(ctx.sessionId, messageID, callID, name, {
            status: 'running',
            input: { text: input },
          }),
        ]),
      ];
    },
  },
  'session.tool.called': {
    durable: true,
    derive: (frame, ctx) => {
      const { messageID, callID, name } = toolFields(frame.data);
      if (messageID === '' || callID === '') {
        return [];
      }
      const state = rec(frame.data, 'state') ?? {};
      const input = frame.data.input;
      return [
        partOutcome([
          toolPart(ctx.sessionId, messageID, callID, name, {
            ...state,
            status: 'running',
            ...(input !== undefined ? { input } : {}),
          }),
        ]),
      ];
    },
  },
  'session.tool.progress': {
    durable: false,
    derive: (frame, ctx) => {
      const { messageID, callID, name } = toolFields(frame.data);
      if (messageID === '' || callID === '') {
        return [];
      }
      const state = rec(frame.data, 'state') ?? {};
      return [
        partOutcome([
          toolPart(ctx.sessionId, messageID, callID, name, { ...state, status: 'running' }),
        ]),
      ];
    },
  },
  'session.tool.success': {
    durable: true,
    derive: (frame, ctx) => {
      const { messageID, callID, name } = toolFields(frame.data);
      if (messageID === '' || callID === '') {
        return [];
      }
      const state = rec(frame.data, 'state') ?? {};
      const content = frame.data.content;
      return [
        partOutcome([
          toolPart(ctx.sessionId, messageID, callID, name, {
            ...state,
            status: 'completed',
            ...(content !== undefined ? { content } : {}),
          }),
        ]),
      ];
    },
  },
  'session.tool.failed': {
    durable: true,
    derive: (frame, ctx) => {
      const { messageID, callID, name } = toolFields(frame.data);
      if (messageID === '' || callID === '') {
        return [];
      }
      const state = rec(frame.data, 'state') ?? {};
      const error = frame.data.error;
      return [
        partOutcome([
          toolPart(ctx.sessionId, messageID, callID, name, {
            ...state,
            status: 'error',
            ...(error !== undefined ? { error } : {}),
          }),
        ]),
      ];
    },
  },

  // ---- 用量（实测 ephemeral：无 durable 块 → 只能当参考，不能作状态判定）----
  'session.usage.updated': {
    durable: false,
    derive: (frame) => {
      const usage: Record<string, unknown> = {};
      const cost = num(frame.data, 'cost');
      if (cost !== undefined) {
        usage.cost = cost;
      }
      const tokens = mapV2TokenUsage(frame.data.tokens);
      if (tokens !== undefined) {
        usage.tokens = tokens;
      }
      if (Object.keys(usage).length === 0) {
        return [];
      }
      // ⚠️ **不带 status**：server 侧 session.updated 的 status 会被写进 DB 的
      // Session.status——这里带一个 'running' 会把已结束的会话改回运行中。
      return [
        {
          kind: 'event',
          type: WORKER_EVENT_TYPES.SESSION_UPDATED,
          payload: { usage },
          },
      ];
    },
  },

  // ---- 会话建立 ----
  'session.created': {
    durable: true,
    derive: () => [
      {
        kind: 'event',
        type: WORKER_EVENT_TYPES.SESSION_UPDATED,
        payload: { status: 'running' },
      },
    ],
  },

  // ---- ephemeral 触发器：只触发一次拉取，绝不直接写状态 ----
  'permission.asked': {
    durable: false,
    derive: (frame) => [{ kind: 'trigger', trigger: 'permission', sessionId: resolveV2SessionId(frame) }],
  },
  'permission.replied': {
    durable: false,
    derive: (frame) => [{ kind: 'trigger', trigger: 'permission', sessionId: resolveV2SessionId(frame) }],
  },
  'form.created': {
    durable: false,
    derive: (frame) => [{ kind: 'trigger', trigger: 'question', sessionId: resolveV2SessionId(frame) }],
  },
  'form.replied': {
    durable: false,
    derive: (frame) => [{ kind: 'trigger', trigger: 'question', sessionId: resolveV2SessionId(frame) }],
  },
  'form.cancelled': {
    durable: false,
    derive: (frame) => [{ kind: 'trigger', trigger: 'question', sessionId: resolveV2SessionId(frame) }],
  },
};

/**
 * v2 事件目录（测试覆盖度断言的**全集**）。
 *
 * 来源：计划附录 B（已发布的 `@opencode/core` 类型定义导出）+ 实机抓帧
 * （`sse-sample.txt` / T4 spike）。`tui.` 是**前缀族**（具体事件名未在基线中列举）。
 *
 * ⚠️ 本清单与实机的两处差异（以实机为准，见 `KNOWN_UNSUPPORTED_V2_EVENTS` 注释）：
 * - `session.text.delta` 的增量字段是 `delta`（附录 B 写的 `text`）；
 * - `session.usage.updated` **没有** durable 块（附录 B 标成 durable）→ 实为 ephemeral。
 */
export const V2_EVENT_CATALOGUE: readonly string[] = [
  'session.created',
  'session.agent.selected',
  'session.model.selected',
  'session.moved',
  'session.renamed',
  'session.metadata.updated',
  'session.permissions',
  'session.viewed',
  'session.deleted',
  'session.forked',
  'session.usage.updated',
  'session.usage.recorded',
  'session.inbox.enqueued',
  'session.inbox.delivered',
  'session.inbox.cancelled',
  'session.inbox.delivery.changed',
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.step.started',
  'session.step.streamed',
  'session.step.ended',
  'session.step.failed',
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.failed',
  'session.message.content.updated',
  'session.compaction.started',
  'session.compaction.delta',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.compacted',
  'session.retry.scheduled',
  'session.shell.started',
  'session.shell.ended',
  'session.skill.activated',
  'session.synthetic',
  'session.instructions.updated',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
  'session.idle',
  'session.status',
  'server.connected',
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'form.cancelled',
  'mcp.status.changed',
  'mcp.prompts.changed',
  'mcp.resources.changed',
  'mcp.tools.changed',
  'config.updated',
  'command.updated',
  'agent.updated',
  'model.updated',
  'provider.updated',
  'credential.updated',
  'credential.switched',
  'integration.updated',
  'project.updated',
  'worktree.updated',
  'worktree.resolved',
  'filesystem.changed',
  'reference.updated',
  'plugin.updated',
  'skill.updated',
  'websearch.updated',
  'installation.updated',
  'installation.update-available',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'shell.created',
  'shell.exited',
  'shell.deleted',
  'location.shutdown',
  'global.disposed',
  'workspace.ready',
  'workspace.failed',
  'workspace.status',
  'lsp.updated',
  'vcs.branch.updated',
  'models-dev.refreshed',
  'tui.',
];

/**
 * 已知未支持（**显式**不映射的 v2 事件）→ 不映射的理由。
 *
 * 「显式」的意义：映射表漏事件 = 功能静默缺失（计划 T12 的风险条目）。故凡是目录里
 * 没映射的，都必须在这里出现并写明理由——测试对「目录 vs 映射 vs 未支持」三方做覆盖
 * 断言。
 */
export const KNOWN_UNSUPPORTED_V2_EVENTS: Readonly<Record<string, string>> = {
  'session.agent.selected': 'agent 切换：vteam 的 agent 由下发提示时选定，事件侧无消费方（且晚到会改写会话状态）',
  'session.model.selected': '模型切换：用量口径模型取自 assistant 消息 info（轮询路已有），事件侧重复会与之一致性打架',
  'session.moved': '会话目录迁移：vteam 的目录在会话属性层管理，不回流事件',
  'session.renamed': '会话改名：**晚于执行结束**到达，映射成 session.updated(running) 会把已 idle 的会话改回运行中',
  'session.metadata.updated': '会话元数据：vteam 无消费方',
  'session.permissions': '会话权限集：vteam 的权限判定在控制面，不依赖该事件',
  'session.viewed': '会话被查看：vteam 无消费方',
  'session.deleted': '会话删除：会话失效走 HTTP 404 的自动重建路径（exec-server 的 isSessionNotFound），不走事件',
  'session.forked': '会话分叉：vteam 不使用分叉',
  'session.usage.recorded': '用量落账事件（与 session.usage.updated 并存）：后者已承载用量载荷',
  'session.inbox.enqueued': '入队事件：**载荷里带用户 prompt 原文**（item.payload.text），转发会泄漏到流式输出',
  'session.inbox.delivered': '投递完成事件：vteam 的投递语义在 worker 侧自闭环',
  'session.inbox.cancelled': '入队取消事件：vteam 无消费方',
  'session.inbox.delivery.changed': '投递策略变更事件：vteam 无消费方',
  'session.step.streamed': 'step 流式标记：无独立载荷（增量由 text/reasoning.delta 承载）',
  'session.step.failed': 'step 级失败：**不产 step-finish**（会误触控制面的「本轮完成」幂等键），run 级失败由 session.execution.failed 承载',
  'session.message.content.updated': '整条消息内容更新：data 形状未在契约基线中确认（实机未见），不做臆造映射',
  'session.compaction.started': '上下文压缩：vteam 不消费压缩过程',
  'session.compaction.delta': '上下文压缩增量：同上',
  'session.compaction.ended': '上下文压缩结束：同上',
  'session.compaction.failed': '上下文压缩失败：同上',
  'session.compacted': '压缩完成标记：与 session.compaction.ended 并存',
  'session.retry.scheduled': '重试调度：vteam 无消费方（终态只认 session.execution.*）',
  'session.shell.started': 'shell 工具事件：工具态统一由 session.tool.* 承载',
  'session.shell.ended': 'shell 工具事件：同上',
  'session.skill.activated': '技能激活：vteam 不消费',
  'session.synthetic': '合成文本：v2 无 synthetic 标记字段，正文聚合的排除策略待语义层（计划 Q9）定，本版不臆造',
  'session.instructions.updated': '指令注入：vteam 不消费',
  'session.revert.staged': '回滚暂存：vteam 不消费',
  'session.revert.cleared': '回滚清除：vteam 不消费',
  'session.revert.committed': '回滚提交：vteam 不消费',
  'session.idle': '空闲信号（ephemeral）：**不作状态判定**（终态只认 durable 的 session.execution.*）',
  'session.status': '忙闲提示（ephemeral）：同上',
  'server.connected': '连接成活信号：由 SSE 客户端直接消费（onOpen），不走事件映射',
  'mcp.status.changed': 'MCP 状态：vteam 走独立的 mcp-status 探测通道',
  'mcp.prompts.changed': 'MCP prompts 变更：vteam 不消费',
  'mcp.resources.changed': 'MCP resources 变更：vteam 不消费',
  'mcp.tools.changed': 'MCP 工具列表变更：vteam 不消费',
  'config.updated': '配置变更：vteam 的配置由下发通道管理',
  'command.updated': '命令目录变更：vteam 不消费',
  'agent.updated': 'agent 目录变更：vteam 不消费',
  'model.updated': '模型目录变更：vteam 走 listModels 拉取',
  'provider.updated': 'provider 目录变更：vteam 不消费',
  'credential.updated': '凭据变更：vteam 的凭据由下发通道管理（**不得**经事件回流）',
  'credential.switched': '凭据切换：同上',
  'integration.updated': '集成变更：vteam 不消费',
  'project.updated': '项目变更：vteam 不消费',
  'worktree.updated': 'worktree 变更：vteam 不消费',
  'worktree.resolved': 'worktree 解析完成：vteam 不消费',
  'filesystem.changed': '文件变更：vteam 的产物落盘走 worker 自己的采集通道',
  'reference.updated': '引用目录变更：vteam 不消费',
  'plugin.updated': '插件目录变更：vteam 不消费',
  'skill.updated': '技能目录变更：vteam 不消费',
  'websearch.updated': 'websearch 配置变更：vteam 不消费',
  'installation.updated': '安装状态变更：vteam 不消费',
  'installation.update-available': '可更新提示：vteam 不消费',
  'pty.created': 'PTY 创建：vteam 不消费',
  'pty.updated': 'PTY 更新：vteam 不消费',
  'pty.exited': 'PTY 退出：vteam 不消费',
  'pty.deleted': 'PTY 删除：vteam 不消费',
  'shell.created': 'shell 会话创建：vteam 不消费',
  'shell.exited': 'shell 会话退出：vteam 不消费',
  'shell.deleted': 'shell 会话删除：vteam 不消费',
  'location.shutdown': 'location 关闭：等价于连接断开（退避重连已覆盖）',
  'global.disposed': '全局释放：等价于 serve 重启（退避重连已覆盖）',
  'workspace.ready': '工作区就绪：vteam 不消费',
  'workspace.failed': '工作区失败：vteam 不消费',
  'workspace.status': '工作区状态：vteam 不消费',
  'lsp.updated': 'LSP 状态：v2 不再运行语言服务器',
  'vcs.branch.updated': '分支变化：vteam 不消费',
  'models-dev.refreshed': '模型目录刷新：vteam 不消费',
  'tui.': 'TUI 专用事件族：vteam 不消费',
};

/**
 * 映射一个 v2 帧 → vteam 事件 / 触发动作。
 *
 * 未在表内的事件 → 返回空数组（调用方按「已知未支持」处理，不静默写状态）。
 * ephemeral 事件**不允许**产出终态（映射表里没有这种条目；此处再做一道防御）。
 */
export function mapV2Event(
  frame: V2EventFrame,
  ctx: V2EventContext,
): V2MappingOutcome[] {
  const mapping = V2_EVENT_MAP[frame.type];
  if (!mapping) {
    return [];
  }
  const outcomes = mapping.derive(frame, ctx);
  if (mapping.durable) {
    return outcomes;
  }
  return outcomes.filter((outcome) => outcome.kind !== 'event' || outcome.terminal === undefined);
}

/** 该 v2 事件是否 durable（可作状态判定）。未在表内 → false（保守）。 */
export function isDurableV2Event(type: string): boolean {
  return V2_EVENT_MAP[type]?.durable === true;
}

/** 该 v2 事件是否在「已知未支持」清单里（精确名或前缀族）。 */
export function isKnownUnsupportedV2Event(type: string): boolean {
  if (KNOWN_UNSUPPORTED_V2_EVENTS[type] !== undefined) {
    return true;
  }
  for (const key of Object.keys(KNOWN_UNSUPPORTED_V2_EVENTS)) {
    if (key.endsWith('.') && type.startsWith(key)) {
      return true;
    }
  }
  return false;
}

/**
 * assistant 消息正文聚合（补发 `task.completed` 时用）。
 *
 * 与 `prompt-await` 的 `aggregateText` 同口径：只取 assistant 消息的 text part、
 * 排除 synthetic（合成文本），按 part 时间升序拼接。
 */
export function assembleAssistantText(messages: DriverMessage[]): string {
  return messages
    .filter((message) => message.info?.role === 'assistant')
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.type === 'text' && !part.synthetic)
    .sort((a, b) => (a.time?.start ?? 0) - (b.time?.start ?? 0))
    .map((part) => part.text ?? '')
    .join('');
}
