import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
  SESSION_STATUS,
} from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeScope } from '../realtime/realtime.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerEventDto } from './dto/worker-event.dto';
import { WORKER_ERRORS } from './workers.constants';
import {
  concatText,
  extractConclusionParts,
  hasRenderableContent,
  mergePartsById,
  stripInjectedPromptParts,
} from '../chat/message-parts';
import { inferErrorType } from './infer-error-type';

/** task.completed 回流负载（worker 侧 step-finish 实测字段，T10 WorkerDispatcher 消费）。
 * sessionId 语义：平台 Session 主键（s_ 前缀）；worker 若误上报 opencode 会话 id
 * （ses_ 前缀），Ingress 经 Session.instanceRef 反查映射（F2 MINOR 防御）。 */
export interface TaskCompletedPayload {
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  /** 执行注册注销用（dispatcher unregisterExecution 需定位 worker:task 活跃记录）。 */
  workerId?: string;
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
  /**
   * 用量口径模型标识（`providerID/modelID` 组合串，worker ctx 透传）。缺失时 worker
   * 落固定哨兵串 `'unknown'`（worker/src/protocol/worker-protocol.ts UNKNOWN_MODEL_KEY）。
   *
   * 可选——存量/旧版本 worker 事件不带该字段，消费方需自行兜底。消费（落库）属
   * usage-sink，本类型仅声明。
   */
  model?: string;
  /** Agent 声明产出物（12 篇 §3.1 声明形状，T10 直连 ArtifactsService 归档）。 */
  artifacts?: unknown[];
  [key: string]: unknown;
}

/** agent.status 回流负载（对齐 DispatcherLoadingEvent 契约 + error 扩展）。 */
export interface AgentStatusPayload {
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  /** 消息来源频道 id（worker 上送透传；ingress 不消费，回调/前端映射链透传）。 */
  channelId?: string;
  /** 进行中阶段：thinking → operating（FR-20 两阶段指示器）。 */
  phase?: string;
  /** loading=进行中 / error=失败（缺省按 loading 处理）。 */
  status?: 'loading' | 'error';
  /** status=error 时附带的错误消息。 */
  error?: string;
  [key: string]: unknown;
}

/**
 * 会话活动事件负载（任务 5 判死 watchdog 数据源）：
 * 每次会话收到回流事件时通知订阅者（WorkerDispatcher）——用于清除首字超时
 * watchdog（任何事件都算「有响应」）与维护 running 会话集合。
 */
export interface ActivityPayload {
  sessionId: string;
  taskId?: string;
  agentId?: string;
  /** 活动来源事件类型。 */
  kind: 'delta' | 'session.updated' | 'task.completed' | 'agent.status';
  /** session.updated 时的原始 status（running/idle 等，判 running 进入/离开用）。 */
  status?: string;
}

/**
 * message.part.delta 回流负载（方案 A worker 主动推，worker 执行端点协议契约）：
 * `{taskId, agentId, sessionId, channelId, parts, status: 'streaming'}`。
 * channelId 语义 = 消息来源频道（resolveChannel 已支持 preferredChannelId）；
 * parts 为流式增量 part 数组（type=text/reasoning/tool 等，对齐 opencode part 形状）。
 */
export interface MessagePartDeltaPayload {
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  channelId?: string;
  parts?: unknown;
  status?: string;
  [key: string]: unknown;
}

/** session.question 回流负载（worker 检测 serve pending question 后上送）。
 * sessionId 语义 = opencode 会话 id（ses_ 前缀，ingress 经 instanceRef 反查平台主键）；
 * requestId = serve question 请求 id（que_ 前缀，AgentQuestion.requestId 唯一键）。 */
export interface SessionQuestionPayload {
  sessionId?: string;
  requestId?: string;
  taskId?: string;
  agentId?: string;
  questions?: unknown;
  [key: string]: unknown;
}

/** session.permission 回流负载（worker 检测 serve pending 权限请求后上送）。
 * permissionId = serve 权限请求 id（per_ 前缀，AgentQuestion.requestId 唯一键）。 */
export interface SessionPermissionPayload {
  sessionId?: string;
  permissionId?: string;
  taskId?: string;
  agentId?: string;
  type?: string;
  pattern?: string | string[];
  title?: string;
  [key: string]: unknown;
}

/**
 * 会话活动事件通知负载（判死 watchdog 消费，T10 WorkerDispatcher 注册 onSessionActivity）：
 * 任何「worker 开始/正在产出」的回流事件（session.updated(running) / message.part.delta /
 * agent.status / task.completed）都会触发——dispatcher 据此清除首字超时 watchdog +
 * 刷新空闲判死计时。`type` 为原始事件类型；session.updated 时 `status` 携带目标状态。
 */
export interface SessionActivityPayload {
  type?: string;
  taskId?: string;
  agentId?: string;
  sessionId?: string;
  status?: string;
  [key: string]: unknown;
}

type TaskCompletedCallback = (payload: TaskCompletedPayload) => void;
type AgentStatusCallback = (payload: AgentStatusPayload) => void;
type ActivityCallback = (payload: ActivityPayload) => void;
type SessionActivityCallback = (payload: SessionActivityPayload) => void;

/** task_events 主键前缀（对齐 tasks.service ID_PREFIX.taskEvent，续号同源）。 */
const TASK_EVENT_ID_PREFIX = 'te';

/** 流式消息主键前缀（与 ChatService/WorkerDispatcher 共享 IdGeneratorService 的 'm' 计数）。 */
const MESSAGE_ID_PREFIX = 'm';

/** 内存去重窗口上限（D4：seq 单调递增下保留最近 N 条即可覆盖连接内有序重发）。 */
const DEDUP_WINDOW = 1000;

/** message.part.delta 组装态缓存上限（有界；超限淘汰最旧——淘汰前会先把该条目
 *  未落库的尾段 flush 掉，见 cacheAssembled/flushEvictedStream）。 */
const ASSEMBLING_CACHE_MAX = 256;

/**
 * message.part.delta **落库节流窗口**（毫秒）：同一流式键在该窗口内至多落库一次。
 *
 * 事故背景（生产 OOM + 磁盘打满双事故）：worker 以 7-35 delta/s 上送，旧实现对
 * **每个** delta 都把全量累积 content 写回 messages 行 —— 行归档增长，单行实测
 * 1.25MB/行；MySQL 行格式 binlog 每次记录整个更新后的行 → binlog 20-30GB/h
 * → 共享 NFS 983GB 被打满 → mysqld `posix_fallocate ... error 28`(ENOSPC)
 * crash-loop → 全站 HTTP 500。
 *
 * 为什么取 1000ms：
 * - 对观察到的 7-35 delta/s：最松散 35 个增量合并成 1 次写（写次数 ÷35）、
 *   最密 7 个增量合并成 1 次写（写次数 ÷7），两个量级都显著下降；
 * - SSE 广播**不受影响**——每个 delta 仍广播一帧（payload 由内存组装态合成，
 *   与逐 delta 落库时的帧同形），前端流式体验逐字不变；
 * - REST 历史最多滞后 1s：只有流式中刷新页面才可能观察到，肉眼不可感知；
 * - 进程崩溃的最坏暴露 = 最近 1s 的增量；且残留行仍为 status=processing，
 *   会被 D2 清扫标 failed（不会把截断内容当成完整消息呈现）。
 *
 * 节流只影响**稳态写频率**，不影响最终一致性：终态（task.completed /
 * agent.status{error} / dispatcher 判死清扫钩子 invalidateDeltaStream）与淘汰
 * （ASSEMBLING_CACHE_MAX）都会强制 flush 未落库尾段。
 */
export const DELTA_PERSIST_INTERVAL_MS = 1000;

/** Session.status 允许的流转值（SESSION_STATUS.created 为 bind 前初始态，worker 不回流该值）。 */
const SESSION_STATUS_ALLOWED: Set<string> = new Set(
  Object.values(SESSION_STATUS),
);

/** 消息行（messages 表；content/mentions 为 Json 列），对齐 worker-dispatcher 的 MessageRow 契约。 */
type MessageRow = {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string | null;
  content: Prisma.JsonValue;
  mentions: Prisma.JsonValue | null;
  status: string;
  createdAt: Date;
};

/**
 * message.part.delta 组装态缓存项 = messages 行的内存镜像 + 节流账本。
 *
 * `parts` 是**真理源**（每个 delta 合并后的最新态）；DB 行可能滞后 `parts`
 * （节流跳过的增量）。`dirty` 标记滞后的存在，`lastFlushAt` 是节流闸门，
 * `row` 是上次成功落库返回的行（节流跳过的 delta 靠它合成广播帧的 DB 侧字段）。
 */
type AssemblingEntry = {
  messageId: string;
  parts: Array<Record<string, unknown>>;
  /** true = 有尚未落库的增量（节流跳过 / 上次写失败）→ 淘汰与终态必须 flush。 */
  dirty: boolean;
  /** 上次成功落库的 Date.now()（DELTA_PERSIST_INTERVAL_MS 闸门基准）。 */
  lastFlushAt: number;
  /** 上次成功落库返回的行（广播 DTO 的 DB 侧字段来源）。 */
  row: MessageRow;
};

/**
 * Worker 事件回流入口（T9，架构决策 D1 全 push 三通道之事件回调）。
 *
 * 职责边界（D5 铁律，防双写）：
 * - **只做**：幂等去重 + 语义转换 + RealtimeService.emit 转发 + 回调通知；
 * - **不做**：消息落库 / 广播 chat.message.new / emitFinal——落库与广播归
 *   T10 WorkerDispatcher 回流处理器（注册 onTaskCompleted 回调消费，按
 *   worker task.completed 事件模板处理）。
 *
 * 各事件语义（计划 §MUST DO）：
 * - worker.heartbeat → 忽略（心跳走单独端点 POST /workers/:id/heartbeat）
 * - instance.created → 仅日志确认（TaskGroupInstance 已在 T12 bindSessionToWorker 时落库）
 * - session.updated → 更新 Session.status + emit `session.updated`（RealtimeService 先落库后广播）
 * - message.part.delta → 流式中间态**有界频率**累积落库（processing 消息，private /
 *   team_group 来源均写目标私聊频道的全量 parts；同一流式键 DELTA_PERSIST_INTERVAL_MS
 *   内至多写一次，尾段由终态/淘汰强制 flush）+ emit `message.part.delta`（scope=channel）
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
  private readonly sessionActivityCallbacks: SessionActivityCallback[] = [];

  /** message.part.delta 落库串行队列：`channelId|senderId`（= findFirst 定位身份）→ 在途 promise 链。
   *  worker 侧 delta 不 await 连发、handleEvent 各 handler 并发执行，
   *  findFirst(无行)→create 是典型 check-then-act，并发下会建出多条 processing 行
   *  （UI 上同一段独白重复成多条消息）。按定位身份串行化即可关闭，无需 DB 唯一约束。 */
  private readonly partDeltaChains = new Map<string, Promise<unknown>>();

  /**
   * message.part.delta 组装态缓存：流式键 `channelId|agentId` → 当前 processing 消息的
   * `AssemblingEntry`（避免每 delta 重读整条消息历史导致的 O(N²) 内存放大）。
   * 命中即用内存组装态增量合并，跳过 message.findFirst 全量 content 回读 + 从 DB
   * 重新推导整条消息；未命中仍以 DB 为准（findFirst → create/update）。key 中的 channelId
   * 指**落库目标频道**（private 独白，见 resolveDeltaStreamKey）；task.completed 时按同键精准失效。
   *
   * 缓存项同时是节流账本：`dirty` 为 true 表示内存组装态领先 DB 行（窗口内跳过的增量）。
   * 因此**带病条目绝不被静默丢弃**——淘汰前先 flush（见 cacheAssembled/flushEvictedStream），
   * 否则下一条同键 delta 走 MISS 从 DB 回读时会丢掉未落库的中段。
   */
  private readonly assemblingMessages = new Map<string, AssemblingEntry>();

  /** 会话最近输出活动时间（sessionId → Date.now()，空闲判死数据源）。
   *  仅 delta/task.completed/session.updated 三类「输出活动」刷新；agent.status
   *  只通知订阅者不清计时（不构成持续输出，防 worker 仅上送状态变化不产字误保活）。 */
  private readonly sessionActivity = new Map<string, number>();

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
   * 订阅会话活动事件（判死 watchdog：T10 WorkerDispatcher 构造时注册）——任何开始/正在
   * 产出的回流事件（session.updated / message.part.delta / agent.status / task.completed）
   * 都经此通知，dispatcher 据此清除首字超时 watchdog 并刷新空闲判死计时。
   */
  onSessionActivity(cb: SessionActivityCallback): this {
    this.sessionActivityCallbacks.push(cb);
    return this;
  }

  /** 查询会话最近输出活动时间（未记录 → undefined）。 */
  getLastActivity(sessionId: string): number | undefined {
    return this.sessionActivity.get(sessionId);
  }

  /** 刷新会话输出活动时间（空闲判死计时器；有 sessionId 才记录）。
   *  trigger-unification todo-7 双写：内存 sessionActivity map + DB
   *  Session.lastActivityAt（重启后内存丢失，scanIdleSessions 凭 DB 列判死）。
   *  DB 写 fail-open（warn + 继续），controller 恒定 202 不受影响。 */
  private touchSessionActivity(payload: SessionActivityPayload): void {
    if (typeof payload.sessionId === 'string' && payload.sessionId) {
      this.sessionActivity.set(payload.sessionId, Date.now());
      void this.persistSessionActivity(payload.sessionId);
    }
  }

  /** 双写 DB 侧：尽力而为，失败只记 warn 永不抛错（sidecar 惯例）。 */
  private async persistSessionActivity(sessionId: string): Promise<void> {
    try {
      await this.prisma.session.update({
        where: { id: sessionId },
        data: { lastActivityAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `[ingress] session ${sessionId} lastActivityAt 回写失败（fail-open，内存计时不受影响）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
        // Phase 4 流式（方案 A worker 主动推）：累积落库 processing 消息 + 广播
        // MESSAGE_PART_DELTA（scope=channel）；异常吞错不阻断（事件回流尽力而为）。
        return this.handleMessagePartDelta(dto)
          .catch((err: unknown) => {
            this.logger.error(
              `[ingress] message.part.delta 处理失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .then(() => true);
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
      case 'session.question':
      case 'session.permission':
        // 模型提问/工具权限确认：AgentQuestion 落库 + emit AGENT_QUESTION（scope=task/team，
        // 团队会话发 team 域），前端会话页弹窗；异常吞错不阻断（事件回流尽力而为）。
        return this.handleAgentQuestion(dto)
          .catch((err: unknown) => {
            this.logger.error(
              `[ingress] ${dto.type} 处理失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .then(() => true);
    }
    return Promise.resolve(true);
  }

  // ---- 语义转换 ----

  /** session.updated：更新 Session.status（合法值映射）+ emit session.updated。
   *  wave1 对齐：worker 上送 sessionId 为 opencode 会话 id（ses_ 前缀，exec-server.ts
   *  透传 dispatch 下发值）——先经 instanceRef 反查为平台 Session 主键（s_ 前缀），
   *  后续 updateMany/emit/activity 通知统一用平台主键（dispatcher watchdog 以
   *  target.sessionId=s_ 注册，域不一致会导致首字 watchdog 永不清除）。 */
  private async handleSessionUpdated(dto: WorkerEventDto): Promise<void> {
    const raw = dto.payload as {
      sessionId?: unknown;
      status?: unknown;
      taskId?: unknown;
      agentId?: unknown;
    };
    const sessionId = await this.resolvePlatformSessionId(
      this.str(raw.sessionId),
      dto.workerId,
      this.str(raw.taskId),
      this.str(raw.agentId),
    );
    const mapped = this.mapSessionStatus(raw.status);
    if (sessionId && mapped) {
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
        sessionId: sessionId ?? null,
        status: mapped ?? (typeof raw.status === 'string' ? raw.status : null),
        workerId: dto.workerId,
      },
      this.scopeOf(raw.taskId),
    );
    // 判死 watchdog：session 状态流转即活动事件（running 刷新 idle 计时/非 running 结束追踪）
    if (mapped && sessionId) {
      this.touchSessionActivity({ type: 'session.updated', sessionId });
      this.notify(this.sessionActivityCallbacks, {
        type: 'session.updated',
        sessionId,
        taskId: this.str(raw.taskId),
        status: mapped,
      });
    }
  }

  /** agent.status：status=error/带 error → emit agent.error；否则 emit agent.loading（phase 透传）。 */
  private async handleAgentStatus(dto: WorkerEventDto): Promise<void> {
    const payload = dto.payload as AgentStatusPayload; // 团队实例语义：反查会话成员 id（teamMemberId），emit 载荷带 instanceId——
    // 同 agent 多实例各自 loading，前端按实例消费不再全体 loading。
    const platformSessionId = await this.resolvePlatformSessionId(
      this.str(payload.sessionId),
      dto.workerId,
      payload.taskId,
      payload.agentId,
    );
    let instanceId: string | null | undefined;
    if (platformSessionId) {
      const sessionRow = await this.prisma.session.findUnique({
        where: { id: platformSessionId },
        select: { teamMemberId: true },
      });
      instanceId = sessionRow?.teamMemberId ?? null;
    }
    const base = {
      taskId: payload.taskId,
      agentId: payload.agentId,
      instanceId,
      sessionId: platformSessionId ?? payload.sessionId,
      workerId: dto.workerId,
    };
    const isError =
      payload.status === 'error' ||
      (typeof payload.error === 'string' && payload.error.length > 0);
    if (isError) {
      // 终态事件（worker 失败路径）：本轮流式已中断，精准失效其组装态缓存（同
      // resolveDeltaStreamKey 键，与 task.completed 处理保持同键纪律）——
      // worker/src/exec/exec-server.ts 失败路径只上送 agent.status{error} +
      // session.updated{failed}，永不上送 task.completed（唯一 emitter 在成功路径），
      // 不失效则同频道同 agent 的用户重试首 delta 命中残留缓存，把已被
      // WorkerDispatcher.failTeamProcessingMessage 标 failed 的消息行 update
      // 成新内容（失败行被静默覆盖）。
      // 节流后追加「先 flush 再失效」：窗口内跳过的增量只活在内存组装态里，失效前
      // 必须补写，否则失败行被永久截断。本方法在 notify（dispatcher failMessage
      // 标 failed）之前 await，顺序确定，用无守卫的 message.update。
      const errorStreamKey = await this.resolveDeltaStreamKey(
        this.str(payload.channelId),
        this.str(payload.sessionId),
        dto.workerId,
        payload.taskId,
        payload.agentId,
      );
      if (errorStreamKey) {
        await this.flushAndDropDeltaStream(errorStreamKey);
      }
      await this.realtime.emit(
        EVENT_TYPES.AGENT_ERROR,
        {
          ...base,
          error: payload.error ?? 'agent error',
          errorType: this.inferErrorType(payload.error),
        },
        this.scopeOf(payload.taskId),
      );
    } else {
      await this.realtime.emit(
        EVENT_TYPES.AGENT_LOADING,
        { ...base, phase: payload.phase ?? 'operating' },
        this.scopeOf(payload.taskId),
      );
    }
    this.notify(this.agentStatusCallbacks, {
      ...payload,
      // wave1 对齐（task.completed 同款）：回调侧 sessionId 归一为平台主键——
      // worker 上送 ses_（opencode 会话 id）时经 instanceRef 反查，s_ 直接透传。
      // 不归一则 dispatcher handleAgentStatus 内 findUnique(ses_) 永 miss →
      // failTeamProcessingMessage 跳过 → 失败无落库，会话页静默（团队直聊必现，
      // taskId 为 team: scope 时任务兜底分支也查不到）。SSE emit 载荷保持原样。
      sessionId:
        (await this.resolvePlatformSessionId(
          this.str(payload.sessionId),
          dto.workerId,
          payload.taskId,
          payload.agentId,
        )) ?? payload.sessionId,
      workerId: dto.workerId,
    });
    // 判死 watchdog：agent 状态上报即活动（thinking/operating 均刷新 idle 计时）
    // wave1 对齐：sessionId 反查为平台主键（与 dispatcher watchdog 注册域一致）
    this.notify(this.sessionActivityCallbacks, {
      type: 'agent.status',
      sessionId: platformSessionId,
      taskId: payload.taskId,
      agentId: payload.agentId,
      status: payload.status,
    });
  }

  /** 从错误文本推断 errorType（前端分类依据；推断不出缺省 model_error，保持向后兼容）。委托共享工具。 */
  private inferErrorType(error?: string): string {
    return inferErrorType(error);
  }

  /**
   * message.part.delta：流式中间态累积落库 + 广播 MESSAGE_PART_DELTA（方案 A worker 主动推）。
   * - **目标频道 = 成员的 team 私聊频道（内心独白）**：群聊 @ 触发的处理过程（含
   *   reasoning/tool/text）统一落该成员的 team 私聊频道，私聊页流式展示完整独白；
   *   群聊只显示最终结果（task.completed 转发），不显示处理过程。private 频道反查
   *   失败（成员无 team 私聊）→ 回退来源 channelId。taskId 仅归因透传，不参与定位。
   * - 定位该会话最新一条 status=processing 的 agent 消息 → 累积更新其 content
   *   （parts 追加 + text 重新拼接）；无 processing 消息 → 新建（status=processing）。
   *   Message 表无 sessionId 列，以 channelId+senderId 唯一定位——同一 agent 在频道内
   *   同时仅一条流式消息（历史教训：每 delta 新建消息会撑爆 DB，必须聚合累积）。
   * - **落库频率有界**（DELTA_PERSIST_INTERVAL_MS）：稳态命中的 delta 在窗口内不写
   *   messages，只更新内存组装态；DB 与内存的差由 `AssemblingEntry.dirty` 记账，终态
   *   （task.completed / agent.status{error} / invalidateDeltaStream）与淘汰
   *   （ASSEMBLING_CACHE_MAX）强制补写，故 DB 不会永久滞后。
   * - 广播 payload：`{message: toMessageDto(最新消息), delta: <本次新增 parts>}`，scope=channel。
   *   **每个 delta 都广播**（节流只省 DB 写，不省帧）；窗口内跳过的 delta 用上次落库
   *   返回的行 + 内存组装态合成 message 字段，与逐 delta 落库时的帧同形。
   */
  private async handleMessagePartDelta(dto: WorkerEventDto): Promise<boolean> {
    const raw = dto.payload as MessagePartDeltaPayload;
    const sourceChannelId = this.str(raw.channelId);
    const taskId = this.str(raw.taskId);
    // wave1 对齐：worker 上送 sessionId 为 opencode 会话 id（ses_ 前缀）→ 反查平台
    // Session 主键后再用于 agentId 反查/activity 通知（域一致才与 dispatcher watchdog 匹配）。
    const sessionId = await this.resolvePlatformSessionId(
      this.str(raw.sessionId),
      dto.workerId,
      taskId,
      this.str(raw.agentId),
    );
    // Todo 7 team-only：会话归属唯一读团队行（团队会话）；taskId 仅归因透传
    // （activity 通知/日志），不参与频道定位。存量任务会话无团队行 → teamId 为
    // 空 → privateTarget 为空 → 回退来源频道（私聊来源照常落库；群聊来源跳过）。
    let deltaSenderInstanceId: string | null | undefined;
    let teamIdOfSession: string | null = null;
    let teamMemberIdOfSession: string | null = null;
    if (sessionId) {
      const sRow = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { teamId: true, teamMemberId: true },
      });
      teamIdOfSession = (sRow as any)?.teamId ?? null;
      teamMemberIdOfSession = (sRow as any)?.teamMemberId ?? null;
      deltaSenderInstanceId = teamMemberIdOfSession ?? null;
    }
    let agentId = this.str(raw.agentId);
    if (!sourceChannelId) {
      this.logger.debug(
        `[ingress] message.part.delta 缺 channelId，跳过（workerId=${dto.workerId}）`,
      );
      return true;
    }
    const source = await this.prisma.chatChannel.findUnique({
      where: { id: sourceChannelId },
      select: { id: true, type: true },
    });
    if (!source) {
      this.logger.debug(
        `[ingress] message.part.delta 频道 ${sourceChannelId} 不存在，跳过`,
      );
      return true;
    }
    if (
      source.type !== CHANNEL_TYPE.private &&
      source.type !== CHANNEL_TYPE.team_group
    ) {
      this.logger.debug(
        `[ingress] message.part.delta 拒绝非 private/team_group 来源 type=${source.type} channel=${sourceChannelId}`,
      );
      return true;
    }
    // payload.agentId 缺失 → 经 sessionId（平台主键）反查 Session.agentId（定位流式消息归属）
    if (!agentId && sessionId) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { agentId: true },
      });
      agentId = session?.agentId;
    }
    // 群聊触发（来源 team_group）→ 处理过程落该成员的 team 私聊频道
    // （内心独白）；私聊触发来源本就是 private，反查结果一致。反查失败回退来源
    // 频道（兼容无私聊场景）。Todo 7 team-only：任务只作归因数据，不再按任务查
    // 私聊频道；同成员多任务/多实例按 teamMemberId 精确匹配各自私聊频道。
    const privateTarget =
      teamIdOfSession && teamMemberIdOfSession
        ? await this.prisma.chatChannel.findFirst({
            where: {
              teamId: teamIdOfSession,
              teamMemberId: teamMemberIdOfSession,
              type: CHANNEL_TYPE.private,
            },
            select: { id: true, type: true },
          })
        : null;
    // 群聊回复只经 MCP group_post 工具直发：群聊触发的流式处理过程仅落该 agent 的
    // private 会话频道（内心独白）；任务未创建该 agent private 频道（仅群频道）
    // → 跳过落库，不把流式中间态写进群聊（曾致群聊每人 3 条：
    // ACK / 流式处理过程 / 工具直发）。私聊来源或有 private 频道时行为不变。
    if (source.type === CHANNEL_TYPE.team_group && privateTarget === null) {
      this.logger.debug(
        `[ingress] message.part.delta 群聊触发且无 private 频道，跳过落库（taskId=${taskId} teamId=${teamIdOfSession} agentId=${agentId ?? '-'})`,
      );
      return true;
    }
    const target = privateTarget ?? source;
    const channelId = target.id;
    // 注入提示防护：worker 异常时会把服务端注入的整段用户提示当流式增量回送，
    // 该 part 会污染 agent 处理行并被 UI 当成 agent 正文。此处先剔除注入提示
    // part，保证它既不建行也不累积进已有 processing 行（终态/读取期另有清洗）。
    const kept = stripInjectedPromptParts(raw.parts);
    if (kept.length === 0) {
      // 无保留 parts（纯非对象条目）→ 中间态无内容，不落库不广播
      this.logger.debug(
        `[ingress] message.part.delta 无保留 parts，跳过（channel=${channelId}）`,
      );
      return true;
    }
    // 落库段（findFirst → update/create）按定位身份串行化：worker 不 await 连发 delta
    // 时，并发的 findFirst(无行)→create 会各建一条 processing 行（重复独白消息）。
    const streamKey = `${channelId}|${agentId ?? ''}`;
    const row = await this.runPartDeltaExclusive(streamKey, async () => {
      const cached = this.assemblingMessages.get(streamKey);
      if (cached) {
        if (!hasRenderableContent(kept)) {
          this.logger.debug(
            `[ingress] message.part.delta(cached) 增量无可渲染内容，不追加 message=${cached.messageId}（channel=${channelId}）`,
          );
          return null;
        }
        const merged = mergePartsById(cached.parts, kept);
        const content = {
          text: concatText(merged),
          parts: merged,
        } as Prisma.InputJsonValue;
        // 节流：窗口内至多落库一次。跳过的 delta 只更新内存组装态并置 dirty，
        // 落库由「窗口到期后的下一次 delta / 终态 flush / 淘汰前 flush」补上
        // ——DB 不会永久滞后于内存（见 flushAndDropDeltaStream / flushEvictedStream）。
        if (Date.now() - cached.lastFlushAt < DELTA_PERSIST_INTERVAL_MS) {
          this.cacheAssembled(streamKey, {
            ...cached,
            parts: merged,
            dirty: true,
          });
          this.logger.debug(
            `[ingress] message.part.delta(cached) 节流跳过落库 message=${cached.messageId} parts=${kept.length}（${DELTA_PERSIST_INTERVAL_MS}ms 窗口内，未落库尾段待 flush，workerId=${dto.workerId}）`,
          );
          // 广播一帧都不能少：DB 侧字段取上次落库返回的真实行，content 取内存组装态
          // （= 下一次落库会写的内容）→ 与逐 delta 落库时的帧同形，前端逐字不变。
          return {
            ...cached.row,
            content: content as Prisma.JsonValue,
          };
        }
        const updated = await this.prisma.message.update({
          where: { id: cached.messageId },
          data: { content },
        });
        this.cacheAssembled(streamKey, {
          messageId: cached.messageId,
          parts: merged,
          dirty: false,
          lastFlushAt: Date.now(),
          row: updated,
        });
        this.logger.debug(
          `[ingress] message.part.delta(cached) 累积更新 message=${cached.messageId} parts=${kept.length}（workerId=${dto.workerId}）`,
        );
        return updated;
      }
      const hasExisting = await this.prisma.message.findFirst({
        where: {
          channelId,
          senderType: SENDER_TYPE.agent,
          status: MESSAGE_STATUS.processing,
          ...(agentId ? { senderId: agentId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, content: true },
      });
      // MISS 分支**不节流、必落库**：它每进程每条流只走一次（重建缓存项 + 广播需要
      // 一行完整 DB 行），且它是「缓存丢失后以 DB 为权威重新定位」的唯一入口——
      // 这里必须写，才能保证刚回读的累积内容与本次增量一起成为新的权威。
      // 只含 step-start/step-finish 等前端不渲染片段的增量：
      // - 无 processing 行 → 不建行（否则消息开始时就落一条 UI 上的空消息）；
      // - 已有行 → 不追加（避免内容被噪声撑大、终态化后仍无可渲染内容）。
      if (!hasExisting && !hasRenderableContent(kept)) {
        this.logger.debug(
          `[ingress] message.part.delta 增量无可渲染内容且无 processing 行，跳过（channel=${channelId}）`,
        );
        return null;
      }
      if (hasExisting && !hasRenderableContent(kept)) {
        this.logger.debug(
          `[ingress] message.part.delta 增量无可渲染内容，不追加 message=${hasExisting.id}（channel=${channelId}）`,
        );
        return null;
      }
      if (hasExisting) {
        const oldContent = (hasExisting.content ?? {}) as Record<
          string,
          unknown
        >;
        // 同 part.id 的新快照原地替换旧快照（worker 重发状态变化后同一 id 会重复上送；
        // 无条件追加会让一次工具调用在 content.parts 里堆出多份快照）。
        const merged = mergePartsById(oldContent.parts, kept);
        const updated = await this.prisma.message.update({
          where: { id: hasExisting.id },
          data: {
            content: {
              text: concatText(merged),
              parts: merged,
            } as Prisma.InputJsonValue,
          },
        });
        this.cacheAssembled(streamKey, {
          messageId: hasExisting.id,
          parts: merged,
          dirty: false,
          lastFlushAt: Date.now(),
          row: updated,
        });
        this.logger.debug(
          `[ingress] message.part.delta 累积更新 message=${hasExisting.id} parts=${kept.length}（workerId=${dto.workerId}）`,
        );
        return updated;
      }
      const created = await this.prisma.message.create({
        data: {
          id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
          channelId,
          senderType: SENDER_TYPE.agent,
          senderId: agentId ?? null,
          senderInstanceId: deltaSenderInstanceId ?? null,
          content: {
            text: concatText(kept),
            parts: kept,
          } as Prisma.InputJsonValue,
          mentions: null,
          status: MESSAGE_STATUS.processing,
        },
      });
      this.cacheAssembled(streamKey, {
        messageId: created.id,
        parts: kept,
        dirty: false,
        lastFlushAt: Date.now(),
        row: created,
      });
      this.logger.debug(
        `[ingress] message.part.delta 新建 processing message=${created.id} parts=${kept.length}（workerId=${dto.workerId}）`,
      );
      return created;
    });
    if (!row) {
      return true;
    }
    await this.realtime.emit(
      EVENT_TYPES.MESSAGE_PART_DELTA,
      { message: this.toMessageDto(row), delta: kept },
      { type: 'channel', id: channelId },
    );
    // 判死 watchdog：delta 落库+广播成功 = 活跃输出 → 刷新 idle 计时（有活动不误杀）
    this.touchSessionActivity({ type: 'message.part.delta', sessionId });
    this.notify(this.sessionActivityCallbacks, {
      type: 'message.part.delta',
      sessionId,
      taskId,
      agentId: agentId ?? this.str(raw.agentId),
    });
    return true;
  }

  /**
   * 计算 message.part.delta 组装态缓存键（= 落库目标频道 + 定位 agentId），与
   * handleMessagePartDelta 的落库键一致，供 task.completed 精准失效同一流式消息。
   * 解析不出（缺 channelId / 频道不存在或非 private/team_group）→ null（该 delta 不会
   * 建缓存项，无从失效）。读失败吞错返 null（失效尽力而为）。
   */
  private async resolveDeltaStreamKey(
    sourceChannelId: string | undefined,
    sessionIdRaw: string | undefined,
    workerId?: string,
    taskId?: string,
    agentIdRaw?: string,
  ): Promise<string | null> {
    try {
      if (!sourceChannelId) {
        return null;
      }
      const source = await this.prisma.chatChannel.findUnique({
        where: { id: sourceChannelId },
        select: { id: true, type: true },
      });
      if (
        !source ||
        (source.type !== CHANNEL_TYPE.private &&
          source.type !== CHANNEL_TYPE.team_group)
      ) {
        return null;
      }
      const sessionId = await this.resolvePlatformSessionId(
        sessionIdRaw,
        workerId,
        taskId,
        agentIdRaw,
      );
      let agentId = agentIdRaw;
      if (!agentId && sessionId) {
        const session = await this.prisma.session.findUnique({
          where: { id: sessionId },
          select: { agentId: true },
        });
        agentId = session?.agentId;
      }
      let targetChannelId = source.id;
      if (sessionId) {
        const sRow = await this.prisma.session.findUnique({
          where: { id: sessionId },
          select: { teamId: true, teamMemberId: true },
        });
        const teamId = (sRow as { teamId?: string | null })?.teamId ?? null;
        const teamMemberId =
          (sRow as { teamMemberId?: string | null })?.teamMemberId ?? null;
        if (source.type === CHANNEL_TYPE.team_group && teamId && teamMemberId) {
          const privateTarget = await this.prisma.chatChannel.findFirst({
            where: { teamId, teamMemberId, type: CHANNEL_TYPE.private },
            select: { id: true },
          });
          if (privateTarget) {
            targetChannelId = privateTarget.id;
          }
        }
      }
      return `${targetChannelId}|${agentId ?? ''}`;
    } catch {
      return null;
    }
  }

  /**
   * 按 key 串行执行（同一 key 的前一个任务结束后才启动下一个）。前序失败不阻断后序，
   * 队尾出链后清理 key（防内存泄漏）。
   */
  private runPartDeltaExclusive<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const prev = this.partDeltaChains.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.partDeltaChains.set(key, tail);
    void tail.then(() => {
      if (this.partDeltaChains.get(key) === tail) {
        this.partDeltaChains.delete(key);
      }
    });
    return run;
  }

  private cacheAssembled(streamKey: string, entry: AssemblingEntry): void {
    this.assemblingMessages.set(streamKey, entry);
    if (this.assemblingMessages.size > ASSEMBLING_CACHE_MAX) {
      const oldest = this.assemblingMessages.keys().next().value;
      if (oldest !== undefined && oldest !== streamKey) {
        const evicting = this.assemblingMessages.get(oldest);
        this.assemblingMessages.delete(oldest);
        if (evicting) {
          this.flushEvictedStream(oldest, evicting);
        }
      }
    }
  }

  /**
   * 把组装态**全量**写回 messages 行（补写节流窗口内跳过的尾段）。
   *
   * `guarded=true` 走 `updateMany` 且带 `status=processing` 守卫：行已被终态化
   * （failed/sent）或已删除 → 0 行不写。用于**顺序不可控**的路径（淘汰前 flush /
   * dispatcher 判死清扫钩子 invalidateDeltaStream）——那些调用方可能已经把行标了
   * failed，无守卫补写会把已终态行覆盖成流式内容（D1/D2 同型腐败，有测例钳制）。
   * `guarded=false` 走 `message.update`，调用方已保证先于 dispatcher 终态化
   * （task.completed / agent.status{error} 都在 notify 回调之前 await 本 flush）。
   *
   * 返回值 = 是否真的写了行（guarded 时 count>0）。
   */
  private async flushAssembled(
    entry: AssemblingEntry,
    guarded: boolean,
  ): Promise<boolean> {
    const content = {
      text: concatText(entry.parts),
      parts: entry.parts,
    } as Prisma.InputJsonValue;
    if (guarded) {
      const res = await this.prisma.message.updateMany({
        where: { id: entry.messageId, status: MESSAGE_STATUS.processing },
        data: { content },
      });
      return res.count > 0;
    }
    await this.prisma.message.update({
      where: { id: entry.messageId },
      data: { content },
    });
    return true;
  }

  /**
   * 终态强制 flush + 失效组装态缓存（task.completed / agent.status{error} 两条有序终态路径）。
   *
   * 为什么必须 flush：节流窗口内跳过的 delta 只活在内存组装态里，DB 行停在上一次
   * 落库的内容；终态不补写 → 用户消息在 DB 里被永久截断（SSE 帧是全的，但 REST
   * 历史 / 刷新后少一截）。
   *
   * 顺序保证：整段跑在该流式键的串行链上——在途 delta 的写先落地，本 flush 才拿得到
   * 最新组装态；失效（delete）也在链内完成，排队中的同键 delta 必然排在其后 MISS
   * 回读，不会撞上「已 flush 未失效」的中间态。
   */
  private async flushAndDropDeltaStream(streamKey: string): Promise<void> {
    await this.runPartDeltaExclusive(streamKey, async () => {
      const entry = this.assemblingMessages.get(streamKey);
      if (!entry) {
        return;
      }
      if (entry.dirty) {
        try {
          await this.flushAssembled(entry, false);
          this.logger.log(
            `[ingress] 终态 flush 补写未落库尾段 message=${entry.messageId} parts=${entry.parts.length}（stream=${streamKey}）`,
          );
        } catch (err) {
          // 落库失败不阻断终态流转（事件回流尽力而为）；缓存项仍按终态纪律失效，
          // 防止后续 delta 命中并对已被 dispatcher 终态化的行 message.update。
          this.logger.error(
            `[ingress] 终态 flush 失败 message=${entry.messageId}（stream=${streamKey}）: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      this.assemblingMessages.delete(streamKey);
    });
  }

  /**
   * 淘汰前 flush（ASSEMBLING_CACHE_MAX 有界淘汰的唯一安全出口）。
   *
   * 为什么必须 flush：节流让 DB 滞后于内存组装态，而 MISS 分支是**从 DB 回读**累积
   * 内容再合并。带病（dirty）条目被静默丢弃 → 下一条同键 delta 走 MISS 时从缺了中段
   * 的 DB 行继续合并 → 中段被永久丢弃（本任务要堵的第二个洞）。
   *
   * 为什么安全：整段跑在被淘汰键**自己**的串行链上——链尚未自清理前到达的同键 delta
   * 会排在本 flush 之后，其 MISS 回读必然看到已补写的全量内容；链已自清理则说明 flush
   * 早已落地。用 guarded（status=processing）写：该流若已被终态化/删除，补写 0 行，
   * 绝不用流式内容覆盖已 failed 行。
   */
  private flushEvictedStream(streamKey: string, entry: AssemblingEntry): void {
    if (!entry.dirty) {
      return;
    }
    void this.runPartDeltaExclusive(streamKey, async () => {
      try {
        const persisted = await this.flushAssembled(entry, true);
        this.logger.log(
          `[ingress] 淘汰前 flush stream=${streamKey} message=${entry.messageId} parts=${entry.parts.length} persisted=${persisted}`,
        );
      } catch (err) {
        // 写失败只记错误并放弃该尾段，**不**把条目放回缓存：那会让后续 delta 命中缓存后
        // 对可能已被终态化的行 message.update，反而打开 D1/D2 腐败面。
        this.logger.error(
          `[ingress] 淘汰前 flush 失败（放弃未落库尾段）stream=${streamKey} message=${entry.messageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  /**
   * 供 WorkerDispatcher 终态清扫失效该流式键的组装态缓存（公开方法，dispatcher 是唯一调用方）。
   * 键口径与 handleMessagePartDelta 的定位键 / resolveDeltaStreamKey 完全一致：
   * `<落库目标频道>|<agentId>`。
   *
   * 为什么需要它：ingress 自身只在 task.completed / agent.status{error} 两个终态失效缓存，
   * 而第三条终态路径**不经过 ingress**——worker 崩溃或静默 watchdog 判死
   * （markSessionIdleDead，只写 Session.status=failed 并 best-effort abort，无任何回流事件），
   * 用户重试时 dispatcher 的重派清扫把上一轮残留 processing 行标 failed（或删除空行）。
   * 若缓存项残留，重试轮首 delta 命中它即对**已 failed / 已删除**的消息行 message.update
   * （与 D1 同型的 correctness 缺陷）。
   *
   * 节流后的终态 flush：带病（dirty）条目被丢弃前先补写未落库尾段。本方法是**同步**钩子
   * 且无法与调用方（worker-dispatcher stale-row sweep）的「标 failed / 删除」定序，故补写
   * 用 guarded（status=processing）形式——行已终态则 0 行不写，绝不会把已 failed 行覆盖成
   * 流式内容；补写跑在该键自己的串行链上，在途 delta 的写先落地、后续同键 delta 的 MISS
   * 回读也看得到本次补写。写失败只记错误并放弃该尾段（不把条目放回缓存，理由同
   * flushEvictedStream：避免后续 delta 命中缓存后 update 可能已终态的行）。
   *
   * 刻意不含 partDeltaChains：该 Map 每条链尾 settle 后即自清理（runPartDeltaExclusive），
   * 不存在跨轮残留；且在途 delta 执行中删键会解除同一键的串行化，重新打开
   * findFirst→create 的 check-then-act 竞态（重复 processing 行）。
   */
  invalidateDeltaStream(channelId: string, agentId: string | null): void {
    const streamKey = `${channelId}|${agentId ?? ''}`;
    const entry = this.assemblingMessages.get(streamKey);
    this.assemblingMessages.delete(streamKey);
    if (!entry?.dirty) {
      return;
    }
    const captured = entry;
    void this.runPartDeltaExclusive(streamKey, async () => {
      try {
        const persisted = await this.flushAssembled(captured, true);
        this.logger.log(
          `[ingress] 判死清扫 flush stream=${streamKey} message=${captured.messageId} parts=${captured.parts.length} persisted=${persisted}`,
        );
      } catch (err) {
        this.logger.error(
          `[ingress] 判死清扫 flush 失败（放弃未落库尾段）stream=${streamKey} message=${captured.messageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  /**
   * task.completed：最高优先级事件。解析 step-finish 负载 → 通知全部注册回调
   * （T10 WorkerDispatcher 注册 handler 做落库+广播 chat.message.new+emitFinal——
   * D5 明确落库归 WorkerDispatcher，Ingress 只做转发，防双写）。
   */
  private async handleTaskCompleted(dto: WorkerEventDto): Promise<boolean> {
    const raw = dto.payload as Record<string, unknown>;
    // 终态事件：本轮流式已结束，先补写未落库尾段再精准失效其组装态缓存（同
    // resolveDeltaStreamKey 键）——下一条流式首 delta 重新以 DB 定位，防止命中已终态化
    // 消息的 messageId 并 update 到 sent。
    // 节流后追加「先 flush 再失效」（flushAndDropDeltaStream）：窗口内跳过的增量只在
    // 内存组装态里，直接 delete 会把它们永久丢掉 → 用户消息在 DB 里被截断。本方法在
    // notify（dispatcher 落库终态 + 广播 chat.message.new）之前 await，顺序确定，
    // 用无守卫的 message.update。
    const doneStreamKey = await this.resolveDeltaStreamKey(
      this.str(raw.channelId),
      this.str(raw.sessionId),
      dto.workerId,
      this.str(raw.taskId),
      this.str(raw.agentId),
    );
    if (doneStreamKey) {
      await this.flushAndDropDeltaStream(doneStreamKey);
    }
    // wave1 对齐：sessionId 统一经 resolvePlatformSessionId 归一（s_ 前缀透传；ses_ 前缀
    // opencode 会话 id 经 instanceRef 反查映射；查不到留空，由回调内 sessionId 反查 agentId
    // 的兜底逻辑接管）。F3 缺陷②：ses_ 反查未命中（worker 404 重建新会话）→ 回写
    // instanceRef 后返回平台主键，保证回调侧 sessionId 反查 agentId 也能命中。
    const sessionId = await this.resolvePlatformSessionId(
      this.str(raw.sessionId),
      dto.workerId,
      this.str(raw.taskId),
      this.str(raw.agentId),
    );
    const payload: TaskCompletedPayload = {
      taskId: this.str(raw.taskId),
      agentId: this.str(raw.agentId),
      sessionId,
      // 执行注册注销用（dispatcher unregisterExecution 需定位 worker:task 活跃记录）
      workerId: dto.workerId,
      // wave1 对齐：channelId 透传（worker 执行端点 ctx 上送）——dispatcher
      // resolveChannel 群聊优先依赖它（1320cbe）；此前 ingress 丢弃导致群聊回复误落私聊。
      channelId: this.str(raw.channelId),
      text: this.str(raw.text),
      parts: raw.parts,
      tokens: raw.tokens,
      cost: typeof raw.cost === 'number' ? raw.cost : undefined,
      // 用量口径模型标识透传（worker ctx 的 providerID/modelID）：Wave 1 只声明了本类型，
      // 真正把字段搬进 payload 属 usage-sink 的消费侧——不搬则 dispatcher 永远读不到，
      // 全表 model 恒为 'unknown'，模型维度失效。
      model: this.str(raw.model),
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : undefined,
    };
    this.logger.log(
      `[ingress] task.completed workerId=${dto.workerId} taskId=${payload.taskId ?? '-'} agentId=${payload.agentId ?? '-'}`,
    );
    // 判死 watchdog：完成回流 = 本轮结束（dispatcher 停止 idle 追踪，防完成后再误判死）
    this.touchSessionActivity({
      type: 'task.completed',
      sessionId: payload.sessionId,
    });
    this.notify(this.sessionActivityCallbacks, {
      type: 'task.completed',
      sessionId: payload.sessionId,
      taskId: payload.taskId,
      agentId: payload.agentId,
    });
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

  /**
   * session.question / session.permission：模型提问或工具权限确认 → AgentQuestion 落库 + emit。
   * - requestId（kind=question）/ permissionId（kind=permission）为 AgentQuestion.requestId 唯一键；
   *   upsert 幂等：已存在且非 pending（已答复/拒绝）→ 跳过（不覆盖终态）；pending → 更新 content。
   * - sessionId 统一经 resolvePlatformSessionId 归一为平台主键（s_ 前缀）落库；taskId/agentId 缺失时
   *   从 Session 反查（worker 事件透传的 ses_ 会话 id 反查命中率更高，反查不到用 payload 值）。
   * - emit AGENT_QUESTION（scope=task/team；团队会话 payload 补 `team:<teamId>` 与顶层 teamId）：
   *   payload = AgentQuestion DTO + taskId/agentId/teamId，前端弹窗。
   */
  private async handleAgentQuestion(dto: WorkerEventDto): Promise<boolean> {
    const raw = dto.payload as SessionQuestionPayload &
      SessionPermissionPayload;
    const kind = dto.type === 'session.question' ? 'question' : 'permission';
    const requestId =
      kind === 'question'
        ? this.str(raw.requestId)
        : this.str(raw.permissionId);
    if (!requestId) {
      this.logger.debug(
        `[ingress] ${dto.type} 缺 ${kind === 'question' ? 'requestId' : 'permissionId'}，跳过（workerId=${dto.workerId}）`,
      );
      return true;
    }
    // sessionId 归一：s_ 前缀直接透传；ses_ 前缀（opencode 会话 id）经 instanceRef 反查平台
    // 主键。反查失败**不丢弃**——落库保留原始 ses_ id（reply 时直接传给 worker 调 serve），
    // taskId/agentId 用 payload 值（worker 上送透传）。同 worker 多 running 会话时反查不唯一
    // 会失败（adoptNewInstanceRef 放弃回写），此时必须走 payload 兜底，否则事件静默丢失。
    const sessionId = await this.resolvePlatformSessionId(
      this.str(raw.sessionId),
      dto.workerId,
      this.str(raw.taskId),
      this.str(raw.agentId),
    );
    const storeSessionId = sessionId ?? this.str(raw.sessionId);
    if (!storeSessionId) {
      this.logger.debug(
        `[ingress] ${dto.type} 会话 ${this.str(raw.sessionId) ?? '-'} 缺失，跳过（workerId=${dto.workerId}）`,
      );
      return true;
    }
    let taskId = this.str(raw.taskId);
    let agentId = this.str(raw.agentId);
    // 团队域恒需解析：团队会话 payload.taskId 为空 → emit scope、managedMode、payload
    // taskId 三处都依赖 session.teamId；任务态会话行为不变（scope 仍按 taskId 发 task 域）。
    let teamId: string | null = null;
    if (sessionId) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { taskId: true, agentId: true, teamId: true },
      });
      taskId = taskId ?? session?.taskId;
      agentId = agentId ?? session?.agentId;
      teamId = session?.teamId ?? null;
    }
    const content: Prisma.InputJsonValue =
      kind === 'question'
        ? { questions: Array.isArray(raw.questions) ? raw.questions : [] }
        : {
            title: this.str(raw.title) ?? raw.type ?? 'permission',
            pattern: raw.pattern ?? null,
            type: raw.type ?? '',
          };
    const existing = await this.prisma.agentQuestion.findUnique({
      where: { requestId },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== 'pending') {
      this.logger.debug(
        `[ingress] ${dto.type} requestId=${requestId} 已终态（${existing.status}），跳过重复上报`,
      );
      return true;
    }
    let row: { id: string; status: string };
    if (existing) {
      row = await this.prisma.agentQuestion.update({
        where: { id: existing.id },
        data: { content },
        select: { id: true, status: true },
      });
    } else {
      row = await this.prisma.agentQuestion.create({
        data: {
          id: await this.idGen.nextId('aq'),
          requestId,
          sessionId: storeSessionId,
          taskId: taskId ?? '',
          agentId: agentId ?? '',
          kind,
          content,
          status: 'pending',
        },
        select: { id: true, status: true },
      });
    }
    this.logger.log(
      `[ingress] ${dto.type} 落库 requestId=${requestId} session=${storeSessionId} kind=${kind}（workerId=${dto.workerId}）`,
    );
    // 托管模式检测：团队 managedMode=true → 请求改由主 Agent 确认（前端不弹窗）。
    // payload 带 managed 标记（TaskProgressionScheduler 订阅 realtime bus 据此 dispatch 给主 Agent），
    // question.managedMode 供 GET /questions 补拉路径前端过滤弹窗。
    const managedMode = teamId
      ? await this.teamManagedModeById(teamId)
      : taskId
        ? await this.teamManagedModeOfTask(taskId)
        : false;
    // 团队会话（payload.taskId 空）补 `team:<teamId>` 与顶层 teamId，且 scope 发 team 域：
    // ① use-sse 的 team: 段按 payload.taskId==='team:<id>' 契约匹配（dispatcher 侧同形状），
    //    缺它前端 scope 过滤必丢帧；② global 域经 payload.taskId 反查任务归属团队，空 taskId
    //    → teamId=null → scope=all 可见性谓词（teamId 非空且可见）直接丢帧——两处均导致
    //    团队会话权限/问题事件在浏览器端完全不展示（k8s 实测 pending per_* 行落库但前端无感）。
    const payloadTaskId = taskId || (teamId ? `team:${teamId}` : null);
    const scope: RealtimeScope = taskId
      ? { type: 'task', id: taskId }
      : teamId
        ? { type: 'team', id: teamId }
        : { type: 'global' };
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: {
          id: row.id,
          requestId,
          sessionId: storeSessionId,
          taskId: payloadTaskId,
          agentId: agentId ?? null,
          kind,
          content,
          status: row.status,
          managedMode,
        },
        ...(managedMode ? { managed: true } : {}),
        taskId: payloadTaskId,
        teamId,
        agentId: agentId ?? null,
        sessionId: storeSessionId,
      },
      scope,
    );
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

  /** 任务归属团队的托管开关（Todo9 团队化：读 team.managedMode；无归属 → false）。 */
  private async teamManagedModeOfTask(taskId: string): Promise<boolean> {
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      const teamId = (task as { teamId?: string | null } | null)?.teamId;
      if (!teamId) return false;
      return await this.teamManagedModeById(teamId);
    } catch {
      return false;
    }
  }

  /** 团队直接维度的托管开关（团队会话 payload.taskId 为空，经 session.teamId 走此路）。 */
  private async teamManagedModeById(teamId: string): Promise<boolean> {
    try {
      const team = await this.prisma.team.findUnique({
        where: { id: teamId },
        select: { managedMode: true },
      });
      return (
        (team as { managedMode?: boolean | null } | null)?.managedMode ?? false
      );
    } catch {
      return false;
    }
  }

  private str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  /** 消息 DTO（对齐 worker-dispatcher.toMessageDto）：content/mentions 透传 Json。 */
  private toMessageDto(row: MessageRow) {
    return {
      id: row.id,
      channelId: row.channelId,
      senderType: row.senderType,
      senderId: row.senderId,
      content: row.content,
      mentions: row.mentions ?? [],
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
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

  /**
   * wave1 对齐：把 worker 回流事件的 sessionId 归一为平台 Session 主键——已 s_ 前缀
   * 直接透传（无反查开销）；ses_ 前缀（opencode 会话 id，worker 执行端点透传 dispatch
   * 下发的 sessionId）经 instanceRef 反查映射；其他/缺失 → undefined（调用方兜底）。
   *
   * F3 缺陷②回写副作用：ses_ 前缀反查**未命中**——worker 端 404 重建了新 opencode 会话
   * （45e0fdf，instanceRef 仍指向旧值）→ 将该 worker 正在运行的**唯一** Session 的
   * instanceRef 回写为新会话 id（幂等），返回该 Session 平台主键。否则 worker 上送
   * session.updated(idle) 时反查失败 → idle 无法落库 → session 永久卡 running。
   *
   * team-only（Todo 5）：任务锚定精确回写分支已删——未知
   * instanceRef（含多 running 无法唯一、worker 缺失）→ undefined，调用方保留原始
   * ses_ id 继续（reply 直传 worker 调 serve；落库走 payload 兜底），不误写他会话。
   */
  private async resolvePlatformSessionId(
    sessionId: string | undefined,
    workerId?: string,
    taskId?: string,
    agentId?: string,
  ): Promise<string | undefined> {
    if (!sessionId) {
      return undefined;
    }
    if (sessionId.startsWith('s_')) {
      return sessionId;
    }
    const platformId = await this.resolveSessionIdByInstanceRef(sessionId);
    if (platformId) {
      return platformId;
    }
    if (!workerId) {
      return undefined;
    }
    const adopted = await this.adoptNewInstanceRef(sessionId, workerId);
    if (adopted) {
      return adopted;
    }
    return undefined;
  }

  /**
   * F3 缺陷②回写：worker 端 404 重建的新 opencode 会话 id（ses_ 前缀且 instanceRef 反查
   * 未命中）→ 将该 worker 正在运行的**唯一** Session 的 instanceRef 更新为新会话 id。
   * 唯一命中 → 返回平台主键（s_ 前缀）并回写；不唯一/未命中 → undefined（不误写）。
   * 幂等：instanceRef 已是新值（此前已回写）→ 不重复 updateMany。
   */
  private async adoptNewInstanceRef(
    newRef: string,
    workerId: string,
  ): Promise<string | undefined> {
    const running = await this.prisma.session.findMany({
      where: { workerId, status: SESSION_STATUS.running },
      select: { id: true, instanceRef: true },
    });
    if (running.length !== 1) {
      // 同 worker 多会话并发或无 running 会话 → 无法可靠定位，放弃回写（现状行为）
      return undefined;
    }
    const session = running[0];
    if (session.instanceRef !== newRef) {
      try {
        await this.prisma.session.updateMany({
          where: {
            id: session.id,
            status: SESSION_STATUS.running,
            instanceRef: { not: newRef },
          },
          data: { instanceRef: newRef },
        });
        this.logger.log(
          `[ingress] 回写 session ${session.id} instanceRef → ${newRef}（worker 404 重建新会话，workerId=${workerId}）`,
        );
      } catch (err) {
        this.logger.warn(
          `[ingress] session ${session.id} instanceRef 回写失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return session.id;
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
