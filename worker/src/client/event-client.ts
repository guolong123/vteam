/**
 * T6 EventSender：事件上送客户端（架构决策 D1 全 push 三通道之事件回调）。
 *
 * - 内部 seq 计数器从 1 起，每次 send +1（eventId 格式 `evw_<bootId>_<seq>`，
 *   bootId 进程启动标识进程内固定，seq 与 eventId 单调关系保持）。
 * - **F2 M1：bootId 区分重启**——worker 重启后 seq 归零但 bootId 变化，eventId 全局
 *   不再复用，server 侧 (workerId, eventId) 内存去重不会把新进程事件误判丢弃。
 * - **seq 单调递增（进程内保证）**：模块级计数器作默认起点，一个进程内多个 EventSender
 *   实例也严格递增（每个实例从模块级当前值接续），测试可传 startSeq 隔离。
 * - POST {serverUrl}/api/v1/worker/events，body = WorkerEventPayload（workerId/eventId/
 *   type/payload/seq），X-Worker-Token 鉴权。
 * - 失败重试：发送失败重试 maxRetries 次（指数退避）；仍失败**记录日志不抛**
 *   （事件可丢，server 侧按 (workerId, eventId) 内存去重 D4，at-least-once 边界）。
 * - flush()：等待所有在途发送完成（优雅退出前调用，保证已发起的事件尽量送达）。
 */

import { WorkerEventPayload, WorkerEventType } from '../protocol/worker-protocol';
import { WORKER_TOKEN_HEADER, apiUrl } from './registry-client';

/** F2 M1：进程启动标识（pid + 启动时间戳 base36），模块加载时固定一次，跨重启变化。 */
const moduleBootId = `${process.pid}.${Date.now().toString(36)}`;

/** 模块级 seq 计数器：进程内全局单调递增的起点（D4）。 */
let moduleSeq = 0;

/** 测试辅助：重置模块级 seq 计数器（生产代码无需调用，仅 spec 隔离用）。 */
export function resetEventSeq(): void {
  moduleSeq = 0;
}

/** 测试辅助：当前模块级 bootId（生产代码无需调用，spec 断言 eventId 结构用）。 */
export function getEventBootId(): string {
  return moduleBootId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EventSenderOptions {
  /** server 基址（如 http://localhost:3000） */
  serverUrl: string;
  /** worker 全局唯一 id */
  workerId: string;
  /** X-Worker-Token 鉴权 token */
  workerToken: string;
  /** seq 起点；默认接续模块级计数器（多实例进程内单调递增），测试传 0 隔离 */
  startSeq?: number;
  /** bootId 覆盖（F2 M1：默认模块级进程启动标识；测试传固定值隔离断言） */
  bootId?: string;
  /** 失败重试次数（总尝试 = maxRetries + 1）；默认 3 */
  maxRetries?: number;
  /** 重试指数退避基数 ms；默认 500（序列 500ms/1s/2s） */
  retryBaseDelayMs?: number;
  /** fetch 注入点（测试用）；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  logger?: { warn(message: string): void; error(message: string): void };
}

export class EventSender {
  private readonly serverUrl: string;
  private readonly workerId: string;
  private readonly workerToken: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: EventSenderOptions['logger'];
  /** F2 M1：进程内固定的 bootId（默认模块级；重启后新进程生成新 bootId，eventId 不复用） */
  private readonly bootId: string;
  private seq: number;
  /** 在途发送任务（flush 等待；deliver 最终失败不抛，故全部 resolve） */
  private inFlight: Promise<void>[] = [];

  constructor(options: EventSenderOptions) {
    this.serverUrl = options.serverUrl;
    this.workerId = options.workerId;
    this.workerToken = options.workerToken;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
    // F2 M1：bootId 默认模块级（进程启动标识），测试可显式传固定值隔离
    this.bootId = options.bootId ?? moduleBootId;
    // startSeq 缺省接续模块级计数器：进程内多实例也保证 seq 全局单调递增（D4）
    this.seq = options.startSeq ?? moduleSeq;
  }

  /** 当前已使用的最大 seq（供调试/断言）。 */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * 上送一个事件（type + payload → WorkerEventPayload，seq 自动 +1）。
   * 返回的 Promise 在**发送成功或最终放弃**后 resolve（最终失败不抛，仅记日志）。
   */
  async send(type: WorkerEventType, payload: Record<string, unknown>): Promise<void> {
    this.seq += 1;
    // 同步推进模块级计数器：后续实例（未显式 startSeq）从最新 seq 接续（进程内单调递增，D4）
    moduleSeq = Math.max(moduleSeq, this.seq);
    const event: WorkerEventPayload = {
      workerId: this.workerId,
      // F2 M1：eventId = evw_<bootId>_<seq>——bootId 区分重启（seq 归零不复用），server 不误去重
      eventId: `evw_${this.bootId}_${this.seq}`,
      type,
      payload,
      seq: this.seq,
    };
    const task = this.deliver(event);
    this.inFlight.push(task);
    try {
      await task;
    } finally {
      const idx = this.inFlight.indexOf(task);
      if (idx >= 0) {
        this.inFlight.splice(idx, 1);
      }
    }
  }

  /** 等待所有在途发送完成（优雅退出前调用；drain 后返回）。 */
  async flush(): Promise<void> {
    while (this.inFlight.length > 0) {
      const pending = this.inFlight.splice(0);
      await Promise.all(pending);
    }
  }

  /** 单次事件投递：POST /api/v1/worker/events + 指数退避重试 + 最终放弃（不抛）。 */
  private async deliver(event: WorkerEventPayload): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
        await sleep(delay);
      }
      try {
        const response = await this.fetchImpl(apiUrl(this.serverUrl, '/worker/events'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [WORKER_TOKEN_HEADER]: this.workerToken,
          },
          body: JSON.stringify(event),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return;
      } catch (err) {
        lastError = err;
        this.logger?.warn?.(
          `[event] ${event.eventId} 发送失败（第 ${attempt + 1}/${this.maxRetries + 1} 次）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // 仍失败：记录日志不抛——事件可丢（server 内存去重 D4 兜底，at-least-once 边界）
    this.logger?.error?.(
      `[event] ${event.eventId} 重试 ${this.maxRetries} 次仍失败，丢弃: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}
