import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import {
  EVENT_TYPES,
  SESSION_STATUS,
} from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeScope } from '../realtime/realtime.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerEventDto } from './dto/worker-event.dto';
import { WORKER_ERRORS } from './workers.constants';

/** task.completed 回流负载（worker 侧 step-finish 实测字段，T10 WorkerDispatcher 消费）。
 * sessionId 语义：平台 Session 主键（s_ 前缀）；worker 若误上报 opencode 会话 id
 * （ses_ 前缀），Ingress 经 Session.instanceRef 反查映射（F2 MINOR 防御）。 */
export interface TaskCompletedPayload {
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  /**
   * 消息来源频道 id（DispatchRequest.channelId 透传）。轮询回流路径携带，供
   * resolveChannel 群聊优先（用户在群聊频道 @agent → 回复回流群聊而非 DM）。
   * ingress task.completed 回调路径（worker 不上报）缺省，保持现状 DM 优先行为。
   */
  channelId?: string;
  text?: string;
  parts?: unknown;
  tokens?: unknown;
  cost?: number;
  /** Agent 声明产出物（12 篇 §3.1 声明形状，T10 直连 ArtifactsService 归档）。 */
  artifacts?: unknown[];
  [key: string]: unknown;
}

/** agent.status 回流负载（对齐 DispatcherLoadingEvent 契约 + error 扩展）。 */
export interface AgentStatusPayload {
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  /** 进行中阶段：thinking → operating（FR-20 两阶段指示器）。 */
  phase?: string;
  /** loading=进行中 / error=失败（缺省按 loading 处理）。 */
  status?: 'loading' | 'error';
  /** status=error 时附带的错误消息。 */
  error?: string;
  [key: string]: unknown;
}

type TaskCompletedCallback = (payload: TaskCompletedPayload) => void;
type AgentStatusCallback = (payload: AgentStatusPayload) => void;

/** task_events 主键前缀（对齐 tasks.service ID_PREFIX.taskEvent，续号同源）。 */
const TASK_EVENT_ID_PREFIX = 'te';

/** 内存去重窗口上限（D4：seq 单调递增下保留最近 N 条即可覆盖连接内有序重发）。 */
const DEDUP_WINDOW = 1000;

/** Session.status 允许的流转值（SESSION_STATUS.created 为 bind 前初始态，worker 不回流该值）。 */
const SESSION_STATUS_ALLOWED: Set<string> = new Set(Object.values(SESSION_STATUS));

/**
 * Worker 事件回流入口（T9，架构决策 D1 全 push 三通道之事件回调）。
 *
 * 职责边界（D5 铁律，防双写）：
 * - **只做**：幂等去重 + 语义转换 + RealtimeService.emit 转发 + 回调通知；
 * - **不做**：消息落库 / 广播 chat.message.new / emitFinal——落库与广播归
 *   T10 WorkerDispatcher 回流处理器（注册 onTaskCompleted 回调消费，对齐
 *   mock-dispatcher.ts:181-208 模板）。
 *
 * 各事件语义（计划 §MUST DO）：
 * - worker.heartbeat → 忽略（心跳走单独端点 POST /workers/:id/heartbeat）
 * - instance.created → 仅日志确认（TaskGroupInstance 已在 T12 bindSessionToWorker 时落库）
 * - session.updated → 更新 Session.status + emit `session.updated`（RealtimeService 先落库后广播）
 * - message.part.delta → 不落库不广播（D2：流式中间态不进统一事件流，前端按需
 *   /sessions/:id/stream），仅 debug 日志
 * - agent.status → emit `agent.loading` / `agent.error`（映射 phase/status/error）+ onAgentStatus 回调
 * - task.completed → 最高优先级：解析 payload → onTaskCompleted 回调（T10 注册做
 *   落库+广播+emitFinal）；Ingress 自身不 emit task.completed
 *
 * 幂等（D4）：内存 Map key=`workerId:eventId` + 窗口环形缓冲（保留最近
 * DEDUP_WINDOW 条）；已见 → 返回 false 不重复处理。已知限制：server 重启后
 * 内存去重丢失 → at-least-once 边界（M4 规模可接受，生产级需 Phase 5
 * (worker_id, event_id) 唯一索引）；超窗口重放不幂等（worker 侧连接内有序不重发兜底）。
 */
@Injectable()
export class WorkerEventIngress {
  private readonly logger = new Logger(WorkerEventIngress.name);

  /** 去重键 → 是否已见（键=`workerId:eventId`）；环形缓冲保证窗口内淘汰。 */
  private readonly seen = new Map<string, true>();
  /** 键插入序（先进先出淘汰窗口）。 */
  private readonly order: string[] = [];

  private readonly taskCompletedCallbacks: TaskCompletedCallback[] = [];
  private readonly agentStatusCallbacks: AgentStatusCallback[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /** 订阅 task.completed 回流（T10 WorkerDispatcher 构造时注册：落库+广播+emitFinal）。 */
  onTaskCompleted(cb: TaskCompletedCallback): this {
    this.taskCompletedCallbacks.push(cb);
    return this;
  }

  /** 订阅 agent.status 回流（T10 可据此跟踪 loading/error 时序）。 */
  onAgentStatus(cb: AgentStatusCallback): this {
    this.agentStatusCallbacks.push(cb);
    return this;
  }

  /**
   * 消费一个 worker 事件。返回 true=首次处理；false=重复（幂等跳过）。
   * 各 type 的 handler 内部 catch 异常记日志（事件回流尽力而为，不向上抛——
   * controller 恒定 202，错误经 agent.error/回调链反馈）。
   */
  async handleEvent(dto: WorkerEventDto): Promise<boolean> {
    // F2 M2（MAJOR）：workerId 必须已注册——WorkerTokenGuard 只校验共享 token（所有 worker
    // 同值），不校验 workerId 归属；未注册 workerId 的事件直接 404 拒绝（防伪造注入）。
    if (!(await this.isWorkerRegistered(dto.workerId))) {
      throw new NotFoundException({
        code: WORKER_ERRORS.WORKER_NOT_FOUND,
        message: `Worker ${dto.workerId} 不存在（未注册）`,
      });
    }
    if (this.isDuplicate(dto)) {
      this.logger.debug(
        `[dedup] 跳过重复事件 ${dto.workerId}:${dto.eventId} (${dto.type})`,
      );
      return Promise.resolve(false);
    }
    switch (dto.type) {
      case 'worker.heartbeat':
        // 心跳走 POST /workers/:id/heartbeat 单独端点（T7），事件通道忽略
        this.logger.debug(
          `[ingress] 忽略 ${dto.type}（心跳经单独端点，workerId=${dto.workerId}）`,
        );
        break;
      case 'instance.created':
        // TaskGroupInstance 已由 T12 bindSessionToWorker 事务落库，此处仅确认
        this.logger.log(
          `[ingress] instance.created workerId=${dto.workerId} payload=${JSON.stringify(dto.payload)}`,
        );
        break;
      case 'session.updated':
        return this.handleSessionUpdated(dto)
          .catch((err: unknown) => {
            this.logger.error(
              `[ingress] session.updated 处理失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .then(() => true);
      case 'message.part.delta':
        // D2：流式中间态不进统一事件流（前端按需经 /sessions/:id/stream），不落库不广播
        this.logger.debug(
          `[ingress] 忽略 message.part.delta（流式中间态，workerId=${dto.workerId} seq=${dto.seq}）`,
        );
        break;
      case 'agent.status':
        return this.handleAgentStatus(dto)
          .catch((err: unknown) => {
            this.logger.error(
              `[ingress] agent.status 处理失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .then(() => true);
      case 'task.completed':
        return this.handleTaskCompleted(dto);
      case 'git.op':
        // T6：git 工具执行审计 → task_events 落库（metadata Json：agent/repo_url/action/exit）
        return this.handleGitOp(dto);
    }
    return Promise.resolve(true);
  }

  // ---- 语义转换 ----

  /** session.updated：更新 Session.status（合法值映射）+ emit session.updated。 */
  private async handleSessionUpdated(dto: WorkerEventDto): Promise<void> {
    const { sessionId, status, taskId } = dto.payload as {
      sessionId?: unknown;
      status?: unknown;
      taskId?: unknown;
    };
    const mapped = this.mapSessionStatus(status);
    if (typeof sessionId === 'string' && sessionId && mapped) {
      // updateMany 幂等：status 已一致时不产生更新（不抛）。
      // DB 更新失败仅记 warn，不阻断 emit——事件流转优先（前端感知），落库终态由 T10/重放兜底。
      try {
        const res = await this.prisma.session.updateMany({
          where: { id: sessionId, status: { not: mapped } },
          data: { status: mapped },
        });
        if (res.count > 0) {
          this.logger.log(
            `[ingress] session ${sessionId} status → ${mapped}（workerId=${dto.workerId}）`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `[ingress] session ${sessionId} status 更新失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.realtime.emit(
      EVENT_TYPES.SESSION_UPDATED,
      {
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        status: mapped ?? (typeof status === 'string' ? status : null),
        workerId: dto.workerId,
      },
      this.scopeOf(taskId),
    );
  }

  /** agent.status：status=error/带 error → emit agent.error；否则 emit agent.loading（phase 透传）。 */
  private async handleAgentStatus(dto: WorkerEventDto): Promise<void> {
    const payload = dto.payload as AgentStatusPayload;
    const base = {
      taskId: payload.taskId,
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      workerId: dto.workerId,
    };
    const isError =
      payload.status === 'error' ||
      (typeof payload.error === 'string' && payload.error.length > 0);
    if (isError) {
      await this.realtime.emit(
        EVENT_TYPES.AGENT_ERROR,
        { ...base, error: payload.error ?? 'agent error' },
        this.scopeOf(payload.taskId),
      );
    } else {
      await this.realtime.emit(
        EVENT_TYPES.AGENT_LOADING,
        { ...base, phase: payload.phase ?? 'operating' },
        this.scopeOf(payload.taskId),
      );
    }
    this.notify(this.agentStatusCallbacks, payload);
  }

  /**
   * task.completed：最高优先级事件。解析 step-finish 负载 → 通知全部注册回调
   * （T10 WorkerDispatcher 注册 handler 做落库+广播 chat.message.new+emitFinal——
   * D5 明确落库归 WorkerDispatcher，Ingress 只做转发，防双写）。
   */
  private async handleTaskCompleted(dto: WorkerEventDto): Promise<boolean> {
    const raw = dto.payload as Record<string, unknown>;
    // F2 MINOR：payload.sessionId 语义=平台 Session 主键（s_ 前缀）。worker 侧若误上报
    // opencode 会话 id（ses_ 前缀），经 Session.instanceRef 反查映射（查不到留空，
    // 由回调内 sessionId 反查 agentId 的兜底逻辑接管）。
    let sessionId = this.str(raw.sessionId);
    if (sessionId && !sessionId.startsWith('s_')) {
      this.logger.warn(
        `[ingress] task.completed sessionId=${sessionId} 非平台 Session 主键（s_ 前缀），尝试经 instanceRef 映射`,
      );
      sessionId = await this.resolveSessionIdByInstanceRef(sessionId);
    }
    const payload: TaskCompletedPayload = {
      taskId: this.str(raw.taskId),
      agentId: this.str(raw.agentId),
      sessionId,
      text: this.str(raw.text),
      parts: raw.parts,
      tokens: raw.tokens,
      cost: typeof raw.cost === 'number' ? raw.cost : undefined,
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : undefined,
    };
    this.logger.log(
      `[ingress] task.completed workerId=${dto.workerId} taskId=${payload.taskId ?? '-'} agentId=${payload.agentId ?? '-'}`,
    );
    this.notify(this.taskCompletedCallbacks, payload);
    return true;
  }

  /**
   * git.op：git 工具执行审计（17 篇 §8.2）→ task_events 落库。
   * payload 解析：taskId/agentId/action/repo_url/exit/error；metadata Json 存
   * agent/repo_url/action/exit/error，时间由 task_events.createdAt 承载。
   * taskId 或 action 缺失 → 跳过（审计事件无主键无法落库）；落库失败吞错记 warn
   * （对齐 session.updated 模式，controller 恒定 202，审计尽力而为）。
   */
  private async handleGitOp(dto: WorkerEventDto): Promise<boolean> {
    const raw = dto.payload as Record<string, unknown>;
    const taskId = this.str(raw.taskId);
    const action = this.str(raw.action);
    const agentId = this.str(raw.agentId);
    const repoUrl = this.str(raw.repo_url);
    const error = this.str(raw.error);
    const exit = typeof raw.exit === 'number' ? raw.exit : undefined;

    if (!taskId || !action) {
      this.logger.debug(
        `[ingress] git.op 缺 taskId/action，跳过（workerId=${dto.workerId}）`,
      );
      return true;
    }
    const metadata: Prisma.InputJsonValue = {
      ...(agentId ? { agent: agentId } : {}),
      ...(repoUrl ? { repo_url: repoUrl } : {}),
      action,
      ...(exit !== undefined ? { exit } : {}),
      ...(error ? { error } : {}),
    };
    try {
      await this.prisma.taskEvent.create({
        data: {
          id: await this.idGen.nextId(TASK_EVENT_ID_PREFIX),
          taskId,
          eventType: 'git.op',
          fromStatus: null,
          toStatus: null,
          actorType: 'agent',
          actorId: agentId ?? null,
          metadata,
        },
      });
      this.logger.log(
        `[ingress] git.op 落库 taskId=${taskId} action=${action} exit=${exit ?? '-'} workerId=${dto.workerId}`,
      );
    } catch (err) {
      this.logger.warn(
        `[ingress] git.op 落库失败（taskId=${taskId} action=${action}）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  }

  // ---- 幂等 ----

  /** 标记并判断是否已见：未见过 → 入 Map + 窗口淘汰最旧；已见 → true。 */
  private isDuplicate(dto: WorkerEventDto): boolean {
    const key = `${dto.workerId}:${dto.eventId}`;
    if (this.seen.has(key)) {
      return true;
    }
    this.seen.set(key, true);
    this.order.push(key);
    if (this.order.length > DEDUP_WINDOW) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    return false;
  }

  // ---- 工具 ----

  /** payload status → SESSION_STATUS 合法值；非法/缺失 → null（不更新 DB，emit 透传原值）。 */
  private mapSessionStatus(status: unknown): string | null {
    if (typeof status !== 'string' || !SESSION_STATUS_ALLOWED.has(status)) {
      return null;
    }
    return status;
  }

  /** payload.taskId 合法 → task scope（SSE 订阅过滤）；否则 global。 */
  private scopeOf(taskId: unknown): RealtimeScope {
    if (typeof taskId === 'string' && taskId) {
      return { type: 'task', id: taskId };
    }
    return { type: 'global' };
  }

  private str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  /** F2 M2：校验 workerId 已注册（Worker 表存在）；未注册事件在 handleEvent 入口被 404 拒绝。 */
  private async isWorkerRegistered(workerId: string): Promise<boolean> {
    const row = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true },
    });
    return row !== null;
  }

  /** F2 MINOR：opencode 会话 id（ses_ 前缀）经 Session.instanceRef 反查平台 sessionId。 */
  private async resolveSessionIdByInstanceRef(
    instanceRef: string,
  ): Promise<string | undefined> {
    const session = await this.prisma.session.findFirst({
      where: { instanceRef },
      select: { id: true },
    });
    return session?.id;
  }

  /** 通知全部注册回调（对齐 MessageDispatcher.notify：异常被吞，订阅者失败不影响主流程）。 */
  private notify<T>(callbacks: ((payload: T) => void)[], payload: T): void {
    for (const cb of callbacks) {
      try {
        cb(payload);
      } catch {
        // 订阅者（如 T10 落库）失败不阻断事件处理
      }
    }
  }
}
