/**
 * 引擎事件订阅契约（P3）——让 exec-server 不再直连任何引擎的事件通道。
 *
 * ## 为什么需要这一层
 *
 * 现状：exec-server 里有一段约 300 行的 SSE 订阅代码（`exec-server.ts:2641-2700`），
 * 直接拼 `driver.baseUrl` + Basic 认证去订阅 opencode serve 的 `/api/event`，
 * 并耦合 v2 专有的三件套：
 * - `ServeEventStream`（volatile 总线 + 退避重连）
 * - `V2StreamAccumulator`（增量累积成全文快照；断线必须清空）
 * - `V2RunEventScope`（move/建会话等基础设施执行的终态不得结束本轮）
 *
 * 接第二个引擎时，若不收口，就要在 exec-server 里再写一段"dsh 的事件订阅分支"——
 * 这正是本次重构要消除的 `if (engine === ...)` 扩散。
 *
 * ## 收口方式（务实版，非大爆炸重构）
 *
 * 在 driver 契约上增加 `subscribeEvents()`：**引擎自己负责订阅与归一**，
 * 只向上吐出 vteam 事件语义（`tid` = part 增量 / terminal = 本轮终态 / trigger = 待拉取）。
 * v2 实现的 SSE 三件套整体留在 v2 侧（不搬，避免改动既有稳定逻辑）；
 * dsh 实现直接从 `session.event` 回调翻译（P2 的 `dsh-event-map` 已就位）。
 *
 * exec-server 的角色从"知道引擎怎么订阅"变成"消费引擎吐出的事件"。
 *
 * ⚠️ P3 阶段是**增量接入**：`subscribeEvents()` 为可选能力。
 * 未实现的驱动（现阶段的 v2）继续走既有 SSE 路径，行为零变化；
 * 实现了的驱动（dsh）走新通道。P3-b（后续）再统一。
 *
 * @module driver/engine-events
 */

import type { DriverContent, DriverTokenUsage } from './opencode-driver';

/**
 * 引擎事件的语义分类（vteam 口径，与上游 wire 无关）。
 *
 * - `parts`：流式内容增量（exec-server 会串行上送 `message.part.delta`）
 * - `terminal`：本轮终态证据（交 `RunTerminalGate`，不直接发送）
 * - `trigger`：只说"有东西可拉"（如权限/问题），由 `PendingQuestionDetector` 去拉
 * - `notice`：其它需要上送的 vteam 事件（如 agent.status / task.completed）
 */
export type EngineEventKind = 'parts' | 'terminal' | 'trigger' | 'notice';

/** 本轮终态判定（与 `RunTerminalGate` 的 verdict 口径一致）。 */
export type EngineTerminalVerdict = 'succeeded' | 'failed' | 'interrupted';

/** 触发类别（只说"该去拉了"，不含内容）。 */
export type EngineTriggerKind = 'permission' | 'question';

/** 上游身份（供 server 跨 worker 重启去重；DSH 用事件 seq，opencode 用 evt_id）。 */
export interface EngineEventIdentity {
  /** 上游事件 id（缺省 = 无身份，server 按指纹去重）。 */
  eventId?: string;
  /** 该事件是否 durable（durable 才可作状态判定）。 */
  durable?: boolean;
  /** 单调序号（durable 事件的顺序保证）。 */
  seq?: number;
}

/** 一条引擎事件（vteam 归一后的语义）。 */
export interface EngineEvent {
  kind: EngineEventKind;
  /** parts：流式增量。 */
  parts?: DriverContent[];
  /** terminal：终态判定。 */
  terminal?: EngineTerminalVerdict;
  /** terminal：错误说明（failed 时）。 */
  error?: string;
  /** trigger：触发类别。 */
  trigger?: EngineTriggerKind;
  /** notice：要上送的 vteam 事件类型（如 `agent.status`）。 */
  noticeType?: string;
  /** notice：事件负载（vteam 协议形状）。 */
  noticePayload?: Record<string, unknown>;
  /** 上游身份。 */
  identity?: EngineEventIdentity;
}

/** 事件订阅回调。 */
export type EngineEventHandler = (event: EngineEvent) => void;

/** 事件流断线/重连信息（供上层做状态重同步决策）。 */
export interface EngineStreamStatus {
  state: 'open' | 'closed' | 'reconnect';
  /** 原因（closed/reconnect 时）。 */
  reason?: string;
  /** 本次连接累计帧数（区分"serve 不可达"与"流中断"，v2 实现的经验）。 */
  frames?: number;
  /** 重连次数（reconnect 时）。 */
  attempt?: number;
}

/** 事件订阅句柄。 */
export interface EngineEventSubscription {
  /** 取消订阅（幂等）。 */
  close(): void;
}

/**
 * 引擎事件通道（`OpenCodeDriver` 的可选能力）。
 *
 * 实现方负责：连接建立/重连/断线检测、上游帧解析、语义归一。
 * 消费方只关心 `EngineEvent` 与 `EngineStreamStatus`。
 */
export interface EngineEventChannel {
  /**
   * 订阅某会话的事件。
   *
   * @param sessionId - vteam 会话 id（引擎侧会话标识）。
   * @param onEvent - 语义事件回调（同步，调用方负责串行化）。
   * @param onStatus - 连接状态回调（可选；用于断线重同步）。
   * @returns 订阅句柄（`close()` 幂等）。
   */
  subscribeEvents(
    sessionId: string,
    onEvent: EngineEventHandler,
    onStatus?: (status: EngineStreamStatus) => void,
  ): EngineEventSubscription;
}

/** 运行期判定：驱动是否具备事件通道（避免用 `instanceof` 判断具体实现）。 */
export function hasEventChannel(driver: unknown): driver is EngineEventChannel {
  if (driver === null || typeof driver !== 'object') return false;
  return typeof (driver as EngineEventChannel).subscribeEvents === 'function';
}

/** 终态判决 → `RunTerminalGate` 的 verdict（DSH 的 aborted 对应 interrupted）。 */
export function toTerminalVerdict(kind: 'completed' | 'aborted' | 'error'): EngineTerminalVerdict {
  switch (kind) {
    case 'completed':
      return 'succeeded';
    case 'aborted':
      // "用户中断"不是失败：控制面据此**不发** task.completed（与 v2 的 interrupted 同口径）
      return 'interrupted';
    case 'error':
      return 'failed';
  }
}

/** token 用量 → 事件 payload 的 `tokens` 字段（占位导出，供 P4 的 usage 上送复用）。 */
export type EngineTokenUsage = DriverTokenUsage;
