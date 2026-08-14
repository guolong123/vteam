/**
 * @ 触发分派入口（09 篇 §5.1 第 5 步「分派」）。
 *
 * 本抽象由 WorkerDispatcher 实现（Phase 4 真实分派：定位任务组 Worker 实例并
 * 下发 prompt（FR-14 私聊/群聊共用同一 Agent 会话），注入群聊历史 + 文档库上下文
 * （FR-15），回复经 worker task.completed 回流（18 篇 §8.3）。
 * 早期 Phase 2 mock 实现（延迟 → loading 两阶段 → 确定性模板回复）已删除。
 *
 * 具体实现通过 DI token = MessageDispatcher 替换（chat.module.ts providers），
 * ChatService 只依赖本抽象，不感知具体实现——Phase 4 零改动替换。
 *
 * 回调契约（计划 §5.1：dispatch + onLoading/onFinal/onError）：
 * - ChatService 构造时通过 onLoading/onFinal/onError 订阅 loading/final/error 事件；
 * - 实现类在分派时序内调用 protected emitLoading/emitFinal/emitError 触发；
 * - 回调同步执行、异常被吞（订阅者失败不影响分派主流程）。
 */
export interface DispatchTarget {
  agentId: string;
  /** 任务×Agent 会话 id（sessions 表 uk_sessions_task_agent）。 */
  sessionId: string | null;
  /** T6 实例语义：目标实例 id（TaskAgent.id，ta_ 前缀）。同 agent 多实例时
   * 用于 loading 广播按实例下发、回复落库 senderInstanceId 精确归属。 */
  instanceId?: string | null;
}

export interface DispatchRequest {
  /** 触发分派的那条用户消息主键（m_<序号>）。 */
  messageId: string;
  channelId: string;
  taskId: string;
  /** 用户消息正文。 */
  text: string;
  /** 仅 dispatched 状态的目标（agent_removed / no_session 不参与分派）。 */
  targets: DispatchTarget[];
}

/** 分派结果：mock 实现返回回复（已落库）；真实实现为空（回复经 worker 事件回流）。 */
export interface AgentReply {
  agentId: string;
  text: string;
}

export interface DispatchResult {
  replies: AgentReply[];
}

/** Loading 两阶段事件（FR-20：thinking → operating，scope=task）。 */
export interface DispatcherLoadingEvent {
  taskId: string;
  agentId: string;
  instanceId?: string | null;
  sessionId: string | null;
  phase: 'thinking' | 'operating';
}

/** Final 事件：Agent 回复已落库（messageId）+ 广播后触发。 */
export interface DispatcherFinalEvent {
  taskId: string;
  agentId: string;
  messageId: string;
  text: string;
}

/** Error 事件：单目标分派失败。 */
export interface DispatcherErrorEvent {
  taskId: string;
  agentId: string;
  error: string;
}

type DispatcherCallback<T> = (event: T) => void;

export abstract class MessageDispatcher {
  private loadingCallbacks: DispatcherCallback<DispatcherLoadingEvent>[] = [];
  private finalCallbacks: DispatcherCallback<DispatcherFinalEvent>[] = [];
  private errorCallbacks: DispatcherCallback<DispatcherErrorEvent>[] = [];

  /** 下发分派；返回 mock 回复（占位）或空数组（真实实现，回复走 SSE 回流）。 */
  abstract dispatch(request: DispatchRequest): Promise<DispatchResult>;

  /** 订阅 loading 事件（两阶段 thinking → operating）。 */
  onLoading(cb: DispatcherCallback<DispatcherLoadingEvent>): this {
    this.loadingCallbacks.push(cb);
    return this;
  }

  /** 订阅 final 事件（Agent 回复落库 + 广播后）。 */
  onFinal(cb: DispatcherCallback<DispatcherFinalEvent>): this {
    this.finalCallbacks.push(cb);
    return this;
  }

  /** 订阅 error 事件（单目标分派失败）。 */
  onError(cb: DispatcherCallback<DispatcherErrorEvent>): this {
    this.errorCallbacks.push(cb);
    return this;
  }

  /** 触发 loading 事件（实现类在分派时序内调用；回调异常不向上抛）。 */
  protected emitLoading(event: DispatcherLoadingEvent): void {
    this.notify(this.loadingCallbacks, event);
  }

  /** 触发 final 事件（实现类在回复落库 + 广播后调用）。 */
  protected emitFinal(event: DispatcherFinalEvent): void {
    this.notify(this.finalCallbacks, event);
  }

  /** 触发 error 事件（实现类在单目标失败时调用）。 */
  protected emitError(event: DispatcherErrorEvent): void {
    this.notify(this.errorCallbacks, event);
  }

  private notify<T>(callbacks: DispatcherCallback<T>[], event: T): void {
    for (const cb of callbacks) {
      try {
        cb(event);
      } catch {
        // 订阅者异常不影响分派主流程（loading/落库/广播继续）。
      }
    }
  }
}
