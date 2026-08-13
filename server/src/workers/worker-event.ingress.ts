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
import { concatText, extractConclusionParts, normalizeParts } from '../chat/message-parts';

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

/** Session.status 允许的流转值（SESSION_STATUS.created 为 bind 前初始态，worker 不回流该值）。 */
const SESSION_STATUS_ALLOWED: Set<string> = new Set(Object.values(SESSION_STATUS));

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
 * - message.part.delta → 流式中间态累积落库（processing 消息，private 全量 parts /
 *   task_group 仅结论 text）+ emit `message.part.delta`（scope=channel）
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

  /** 刷新会话输出活动时间（空闲判死计时器；有 sessionId 才记录）。 */
  private touchSessionActivity(payload: SessionActivityPayload): void {
    if (typeof payload.sessionId === 'string' && payload.sessionId) {
      this.sessionActivity.set(payload.sessionId, Date.now());
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
        // 模型提问/工具权限确认：AgentQuestion 落库 + emit AGENT_QUESTION（scope=task），
        // 前端会话页弹窗；异常吞错不阻断（事件回流尽力而为）。
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
    const payload = dto.payload as AgentStatusPayload;
    // T6 实例语义：反查会话实例 id（taskAgentId），emit 载荷带 instanceId——
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
        select: { taskAgentId: true },
      });
      instanceId = sessionRow?.taskAgentId ?? null;
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
      await this.realtime.emit(
        EVENT_TYPES.AGENT_ERROR,
        { ...base, error: payload.error ?? 'agent error', errorType: this.inferErrorType(payload.error) },
        this.scopeOf(payload.taskId),
      );
    } else {
      await this.realtime.emit(
        EVENT_TYPES.AGENT_LOADING,
        { ...base, phase: payload.phase ?? 'operating' },
        this.scopeOf(payload.taskId),
      );
    }
    this.notify(this.agentStatusCallbacks, { ...payload, workerId: dto.workerId });
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

  /** 从错误文本推断 errorType（前端分类依据；推断不出缺省 model_error，保持向后兼容）。 */
  private inferErrorType(error?: string): string {
    const e = (error ?? '').toLowerCase();
    if (/invalid api key|unauthorized|401|credential/.test(e)) return 'auth_failed';
    if (/quota|insufficient|billing/.test(e)) return 'quota_exceeded';
    if (/timeout|model_busy|busy|rate.?limit|overloaded|try again/.test(e)) return 'model_busy';
    return 'model_error';
  }

  /**
   * message.part.delta：流式中间态累积落库 + 广播 MESSAGE_PART_DELTA（方案 A worker 主动推）。
   * - **目标频道 = agent 的 private 会话频道（内心独白）**：群聊 @ 触发的处理过程（含
   *   reasoning/tool/text）统一落该 agent 的 private 频道，私聊页流式展示完整独白；
   *   群聊只显示最终结果（task.completed 转发），不显示处理过程。private 频道反查
   *   失败（任务无该 agent 私聊）→ 回退来源 channelId。
   * - 定位该会话最新一条 status=processing 的 agent 消息 → 累积更新其 content
   *   （parts 追加 + text 重新拼接）；无 processing 消息 → 新建（status=processing）。
   *   Message 表无 sessionId 列，以 channelId+senderId 唯一定位——同一 agent 在频道内
   *   同时仅一条流式消息（历史教训：每 delta 新建消息会撑爆 DB，必须聚合累积）。
   * - 广播 payload：`{message: toMessageDto(最新消息), delta: <本次新增 parts>}`，scope=channel。
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
    // T6 实例语义：processing 消息落 senderInstanceId（会话 taskAgentId），
    // 同 agent 多实例流式内容精确归属（终态化 handleTaskCompleted 已按实例落库）
    let deltaSenderInstanceId: string | null | undefined;
    if (sessionId) {
      const sRow = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { taskAgentId: true },
      });
      deltaSenderInstanceId = sRow?.taskAgentId ?? null;
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
    // payload.agentId 缺失 → 经 sessionId（平台主键）反查 Session.agentId（定位流式消息归属）
    if (!agentId && sessionId) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { agentId: true },
      });
      agentId = session?.agentId;
    }
    // 群聊触发（来源 task_group）→ 处理过程落该 agent 的 private 会话频道（内心独白）；
    // 私聊触发来源本就是 private，反查结果一致。反查失败回退来源频道（兼容无私聊场景）。
    // F3 P1 修复：同 agent 多实例按 taskAgentId 精确匹配各自私聊频道（deltaSenderInstanceId
    // 已从 session 反查）；存量会话 taskAgentId NULL → 回退 agentId 首实例兼容。
    const privateTarget =
      taskId && agentId
        ? await this.prisma.chatChannel.findFirst({
            where: deltaSenderInstanceId
              ? { taskId, taskAgentId: deltaSenderInstanceId }
              : { taskId, agentId },
            select: { id: true, type: true },
          })
        : null;
    // 群聊回复只经 MCP group_post 工具直发：群聊触发的流式处理过程仅落该 agent 的
    // private 会话频道（内心独白）；任务未创建该 agent private 频道（如仅 task_group
    // 一个频道）→ 跳过落库，不把流式中间态写进群聊（曾致群聊每人 3 条：
    // ACK / 流式处理过程 / 工具直发）。私聊来源或有 private 频道时行为不变。
    if (source.type === CHANNEL_TYPE.task_group && privateTarget === null) {
      this.logger.debug(
        `[ingress] message.part.delta 群聊触发且无 private 频道，跳过落库（taskId=${taskId} agentId=${agentId ?? '-'}）`,
      );
      return true;
    }
    const target = privateTarget ?? source;
    const channelId = target.id;
    const kept = normalizeParts(raw.parts);
    if (kept.length === 0) {
      // 无保留 parts（纯非对象条目）→ 中间态无内容，不落库不广播
      this.logger.debug(
        `[ingress] message.part.delta 无保留 parts，跳过（channel=${channelId}）`,
      );
      return true;
    }
    const existing = await this.prisma.message.findFirst({
      where: {
        channelId,
        senderType: SENDER_TYPE.agent,
        status: MESSAGE_STATUS.processing,
        ...(agentId ? { senderId: agentId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, content: true },
    });
    let row: MessageRow;
    if (existing) {
      const oldContent = (existing.content ?? {}) as Record<string, unknown>;
      const oldParts = Array.isArray(oldContent.parts) ? oldContent.parts : [];
      const merged = [...oldParts, ...kept];
      row = await this.prisma.message.update({
        where: { id: existing.id },
        data: {
          content: {
            text: concatText(merged),
            parts: merged,
          } as Prisma.InputJsonValue,
        },
      });
      this.logger.debug(
        `[ingress] message.part.delta 累积更新 message=${existing.id} parts=${kept.length}（workerId=${dto.workerId}）`,
      );
    } else {
      row = await this.prisma.message.create({
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
      this.logger.debug(
        `[ingress] message.part.delta 新建 processing message=${row.id} parts=${kept.length}（workerId=${dto.workerId}）`,
      );
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
   * task.completed：最高优先级事件。解析 step-finish 负载 → 通知全部注册回调
   * （T10 WorkerDispatcher 注册 handler 做落库+广播 chat.message.new+emitFinal——
   * D5 明确落库归 WorkerDispatcher，Ingress 只做转发，防双写）。
   */
  private async handleTaskCompleted(dto: WorkerEventDto): Promise<boolean> {
    const raw = dto.payload as Record<string, unknown>;
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
      artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : undefined,
    };
    this.logger.log(
      `[ingress] task.completed workerId=${dto.workerId} taskId=${payload.taskId ?? '-'} agentId=${payload.agentId ?? '-'}`,
    );
    // 判死 watchdog：完成回流 = 本轮结束（dispatcher 停止 idle 追踪，防完成后再误判死）
    this.touchSessionActivity({ type: 'task.completed', sessionId: payload.sessionId });
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
   * - emit AGENT_QUESTION（scope=task）：payload = AgentQuestion DTO + taskId/agentId，前端弹窗。
   */
  private async handleAgentQuestion(dto: WorkerEventDto): Promise<boolean> {
    const raw = dto.payload as SessionQuestionPayload & SessionPermissionPayload;
    const kind = dto.type === 'session.question' ? 'question' : 'permission';
    const requestId =
      kind === 'question' ? this.str(raw.requestId) : this.str(raw.permissionId);
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
    if (sessionId && (!taskId || !agentId)) {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { taskId: true, agentId: true },
      });
      taskId = taskId ?? session?.taskId;
      agentId = agentId ?? session?.agentId;
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
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: {
          id: row.id,
          requestId,
          sessionId: storeSessionId,
          taskId: taskId ?? null,
          agentId: agentId ?? null,
          kind,
          content,
          status: row.status,
        },
        taskId: taskId ?? null,
        agentId: agentId ?? null,
        sessionId: storeSessionId,
      },
      this.scopeOf(taskId),
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
   * Bug2 修复（多 running 会话时唯一性兜底失败）：同 worker 存在多个 running Session 时
   * adoptNewInstanceRef 无法可靠定位会放弃回写 → instanceRef 永为旧值 → 每次 dispatch
   * 复用旧值 404 → 每次重建新会话（线上 Bug2 根因）。此处增加 taskId/agentId 精确兜底
   * （worker 事件 payload 恒携带 taskId/agentId，Session 表同 task+agent 唯一）——按
   * `{workerId, taskId, agentId}` 定位并回写，保证 404 重建后新 instanceRef 落库、后续复用。
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
    // 唯一 running 定位失败 → 用 taskId/agentId 精确兜底（同 task+agent 会话唯一）
    return this.adoptNewInstanceRefByTask(sessionId, workerId, taskId, agentId);
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

  /**
   * Bug2 修复：adoptNewInstanceRef 唯一 running 兜底失效时的 taskId/agentId 精确回写。
   * 同 worker 多 running 会话时唯一性定位失败 → 按事件携带的 `{workerId, taskId, agentId}`
   * 定位（Session 表同 task+agent 唯一，buildTrigger 保证）→ 回写 instanceRef = 新会话 id。
   * 返回平台主键供调用方继续；无 taskId/未命中 → undefined（不误写）。
   */
  private async adoptNewInstanceRefByTask(
    newRef: string,
    workerId: string,
    taskId?: string,
    agentId?: string,
  ): Promise<string | undefined> {
    if (!taskId) {
      return undefined;
    }
    const session = await this.prisma.session.findFirst({
      where: { workerId, taskId, ...(agentId ? { agentId } : {}) },
      select: { id: true, instanceRef: true },
    });
    if (!session || session.instanceRef === newRef) {
      return session?.id;
    }
    try {
      await this.prisma.session.updateMany({
        where: { id: session.id, instanceRef: { not: newRef } },
        data: { instanceRef: newRef },
      });
      this.logger.log(
        `[ingress] 回写 session ${session.id} instanceRef → ${newRef}（404 重建新会话，taskId=${taskId} workerId=${workerId}）`,
      );
    } catch (err) {
      this.logger.warn(
        `[ingress] session ${session.id} instanceRef 回写失败: ${err instanceof Error ? err.message : String(err)}`,
      );
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
