import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AgentQuestion, Prisma } from '@prisma/client';
import { ACTOR_TYPE, EVENT_TYPES } from '../common/constants/event.constants';
import { TASK_ERRORS } from '../common/constants/task.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeScope } from '../realtime/realtime.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  WorkerClient,
  WorkerUnavailableException,
} from '../workers/worker.client';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import {
  AGENT_QUESTION_ID_PREFIX,
  AGENT_QUESTION_KINDS,
  AGENT_QUESTION_STATUS,
  PermissionResponse,
  PLATFORM_QUESTION_SOURCE,
  QUESTION_PENDING_TTL_MS,
  QUESTIONS_ERRORS,
} from './questions.constants';

/** AgentQuestion 对外 DTO（落库行脱 Json 原样透传 content，前端据此渲染弹窗）。 */
export interface AgentQuestionDto {
  id: string;
  requestId: string;
  sessionId: string;
  taskId: string | null;
  agentId: string | null;
  kind: string;
  content: unknown;
  status: string;
  answers: unknown;
  /** 托管模式标记：任务开启托管（managedMode=true）时该请求改由主 Agent 确认，前端不弹窗。 */
  managedMode: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** 平台 question 终态执行钩子（createForPlatform 注册，确认/拒绝/超期时触发）。 */
type PlatformResolveHook = (args: {
  answers: string[][] | null;
  actor: { type: string; id: string };
}) => Promise<void>;

/**
 * 模型提问 / 工具权限确认服务（worker 检测 serve pending → ingress 落库 → 本服务读/回复）。
 *
 * - findAll：会话页补拉（GET /questions?taskId=&status=pending），刷新/进入页面恢复弹窗；
 * - reply：用户答复 → WorkerClient 调 worker /question-reply → serve 应用 → AgentQuestion
 *   落库 resolved/rejected + answers → realtime.emit AGENT_QUESTION（{resolved}）收敛前端弹窗。
 *   落库失败/worker 不可达 → 明确错误（400/404/503），不静默。
 * - reply 链路 sessionId 语义：AgentQuestion.sessionId 为平台主键（s_），经 Session.instanceRef
 *   反查 opencode 会话 id（ses_）传 worker（worker 直接调 serve）。
 * - 平台 question（source='platform'，如 team_add_member 确认门）：不经 worker 转发，直接
 *   终态落库 + 触发 createForPlatform 注册的 onResolved 钩子 + emit 收敛（Oracle R2 旁路）。
 */
@Injectable()
export class QuestionsService {
  private readonly logger = new Logger(QuestionsService.name);

  /** 平台 question 终态钩子（key=requestId，终态/超期时触发并移除）。 */
  private readonly platformResolvers = new Map<string, PlatformResolveHook>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly workerClient: WorkerClient,
  ) {}

  /** 进程启动对齐 aq_ 前缀序号（重启续号，对齐 models/git-repos onModuleInit 模式）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.agentQuestion,
      AGENT_QUESTION_ID_PREFIX,
      this.idGen,
    );
  }

  /** GET /questions：按 taskId/status 过滤（会话页补拉用；status 缺省 pending）。 */
  async findAll(query: {
    taskId?: string;
    status?: string;
  }): Promise<AgentQuestionDto[]> {
    const where: Prisma.AgentQuestionWhereInput = {
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.status
        ? { status: query.status }
        : { status: AGENT_QUESTION_STATUS.PENDING }),
    };
    const rows = await this.prisma.agentQuestion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    // 惰性过期：pending 超 TTL 且未回复 → 自动终态 + 广播收敛（僵尸/超时弹窗不无限弹）。
    const staleThreshold = new Date(Date.now() - QUESTION_PENDING_TTL_MS);
    const stale = rows.filter(
      (r) =>
        r.status === AGENT_QUESTION_STATUS.PENDING &&
        r.createdAt < staleThreshold,
    );
    if (stale.length > 0) {
      for (const r of stale) {
        await this.expire(
          r,
          `GET 惰性过期（pending 超 ${QUESTION_PENDING_TTL_MS / 60000}min）`,
        );
      }
      const fresh = await this.prisma.agentQuestion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
      return this.toDtos(fresh);
    }
    return this.toDtos(rows);
  }

  /** 批量行 → DTO：一次查询关联任务 managedMode（托管标记，前端据此过滤弹窗）。 */
  private async toDtos(rows: AgentQuestion[]): Promise<AgentQuestionDto[]> {
    const taskIds = [...new Set(rows.map((r) => r.taskId).filter(Boolean))];
    const tasks =
      taskIds.length > 0
        ? await this.prisma.task.findMany({
            where: { id: { in: taskIds } },
            select: { id: true, managedMode: true },
          })
        : [];
    const managedByTask = new Map(tasks.map((t) => [t.id, t.managedMode]));
    return rows.map((r) => this.toDto(r, managedByTask.get(r.taskId) ?? false));
  }

  /**
   * POST /questions/:id/reply：用户答复（question=answers / permission=response）。
   * 流程：查 AgentQuestion → 经 Session.instanceRef 定位 opencode 会话 → WorkerClient 调
   * worker /question-reply → serve 应用成功 → 落库 resolved/rejected + answers → emit 收敛。
   * 失败不静默：找不到 404；参数与 kind 不符 400；worker 不可达 503。
   * userId：审计 actor（平台 question 确认门场景；缺省 '' 兼容旧调用）。
   */
  async reply(
    id: string,
    dto: ReplyQuestionDto,
    userId?: string,
  ): Promise<AgentQuestionDto> {
    const row = await this.prisma.agentQuestion.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({
        code: QUESTIONS_ERRORS.QUESTION_NOT_FOUND,
        message: `AgentQuestion ${id} 不存在`,
      });
    }
    if (row.status !== AGENT_QUESTION_STATUS.PENDING) {
      throw new BadRequestException({
        code: QUESTIONS_ERRORS.QUESTION_ALREADY_RESOLVED,
        message: `AgentQuestion ${id} 已终态（${row.status}），不可重复回复`,
      });
    }
    if (row.kind === AGENT_QUESTION_KINDS.QUESTION) {
      if (dto.answers === undefined) {
        throw new BadRequestException({
          code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY,
          message: 'question 回复需携带 answers（label 数组）或 null（拒绝）',
        });
      }
    } else {
      if (!dto.response) {
        throw new BadRequestException({
          code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY,
          message: 'permission 回复需携带 response ∈ once|always|reject',
        });
      }
    }
    return this.forwardReply(
      row,
      { answers: dto.answers, response: dto.response },
      { type: ACTOR_TYPE.user, id: userId ?? '' },
    );
  }

  /**
   * 托管确认（question_confirm MCP 工具）：任务托管模式下由主 Agent 确认成员请求。
   * 仅主实例可调（task.mainAgentInstanceId === instanceId，复用 task_transition 权限模式）；
   * requestId 精确命中 AgentQuestion（requestId 唯一键），kind 须与落库一致；
   * 回复语义与用户 reply 相同（question=answers / permission=response，answers=null=拒绝）。
   */
  async confirmByAgent(input: {
    taskId: string;
    instanceId: string;
    requestId: string;
    kind: 'question' | 'permission';
    answers?: string[][] | null;
    response?: PermissionResponse;
  }): Promise<AgentQuestionDto> {
    const task = await this.prisma.task.findUnique({
      where: { id: input.taskId },
      select: { mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (task.mainAgentInstanceId !== input.instanceId) {
      throw new ForbiddenException({
        code: TASK_ERRORS.TASK_STATUS_MAIN_AGENT_ONLY,
        message: `仅主 Agent（${task.mainAgentInstanceId ?? '未设置'}）可确认托管模式下的请求`,
      });
    }
    const row = await this.prisma.agentQuestion.findUnique({
      where: { requestId: input.requestId },
    });
    if (!row) {
      throw new NotFoundException({
        code: QUESTIONS_ERRORS.QUESTION_NOT_FOUND,
        message: `AgentQuestion requestId ${input.requestId} 不存在`,
      });
    }
    if (row.status !== AGENT_QUESTION_STATUS.PENDING) {
      throw new BadRequestException({
        code: QUESTIONS_ERRORS.QUESTION_ALREADY_RESOLVED,
        message: `AgentQuestion ${row.id} 已终态（${row.status}），不可重复确认`,
      });
    }
    if (row.kind !== input.kind) {
      throw new BadRequestException({
        code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY,
        message: `确认 kind（${input.kind}）与请求类型（${row.kind}）不符`,
      });
    }
    return this.forwardReply(
      row,
      { answers: input.answers, response: input.response },
      { type: ACTOR_TYPE.agent, id: input.instanceId },
    );
  }

  /** 回复转发核心（reply / confirmByAgent 共用）：worker 定位 → workerClient → 终态落库 → emit 收敛。 */
  private async forwardReply(
    row: AgentQuestion,
    payload: { answers?: string[][] | null; response?: PermissionResponse },
    actor?: { type: string; id: string },
  ): Promise<AgentQuestionDto> {
    // 平台 question（source='platform'）短路：serve 无该 requestId 必 404→expire，不经
    // worker 转发；直接终态落库 + 触发 onResolved 钩子 + emit 收敛（独立标记分支，现有
    // 托管 question 的转发路径保持不动）。
    if (this.isPlatformQuestion(row)) {
      return this.resolvePlatformQuestion(row, payload, actor);
    }
    const session = await this.prisma.session.findUnique({
      where: { id: row.sessionId },
      select: { workerId: true, instanceRef: true },
    });
    // sessionId 双语义：s_ 前缀（平台主键）→ session.instanceRef 反查 opencode 会话 id；
    // ses_ 前缀（ingress 反查失败时保留的原始 opencode 会话 id）→ 直接透传 worker 调 serve。
    const opencodeSessionId = row.sessionId.startsWith('ses_')
      ? row.sessionId
      : session?.instanceRef;
    if (!opencodeSessionId) {
      throw new ServiceUnavailableException({
        code: QUESTIONS_ERRORS.QUESTION_WORKER_UNAVAILABLE,
        message: `会话 ${row.sessionId} 未绑定 serve 实例（instanceRef 缺失），无法转发回复`,
      });
    }
    // worker 定位：s_ 前缀 → session.workerId；ses_ 前缀（无 Session 主键记录）→ 按
    // taskId+agentId 反查该 agent 在任务下的会话绑定 worker。
    const workerId =
      session?.workerId ??
      (row.sessionId.startsWith('ses_')
        ? (
            await this.prisma.session.findFirst({
              where: {
                taskId: row.taskId,
                agentId: row.agentId,
                workerId: { not: null },
              },
              select: { workerId: true },
              orderBy: { updatedAt: 'desc' },
            })
          )?.workerId
        : null);
    const worker = workerId
      ? await this.prisma.worker.findUnique({
          where: { id: workerId },
          select: { id: true, capabilities: true },
        })
      : null;
    if (!worker) {
      throw new ServiceUnavailableException({
        code: QUESTIONS_ERRORS.QUESTION_WORKER_UNAVAILABLE,
        message: `会话 ${row.sessionId} 无绑定 worker，无法转发回复`,
      });
    }

    const answers: Prisma.InputJsonValue =
      row.kind === AGENT_QUESTION_KINDS.QUESTION
        ? (payload.answers as Prisma.InputJsonValue)
        : { response: payload.response };
    const status =
      row.kind === AGENT_QUESTION_KINDS.QUESTION && payload.answers === null
        ? AGENT_QUESTION_STATUS.REJECTED
        : AGENT_QUESTION_STATUS.RESOLVED;

    try {
      if (row.kind === AGENT_QUESTION_KINDS.QUESTION) {
        await this.workerClient.questionReply(
          { id: worker.id, capabilities: worker.capabilities },
          {
            sessionId: opencodeSessionId,
            requestId: row.requestId,
            answers: payload.answers ?? null,
          },
        );
      } else {
        await this.workerClient.permissionReply(
          { id: worker.id, capabilities: worker.capabilities },
          {
            sessionId: opencodeSessionId,
            permissionId: row.requestId,
            response: payload.response as 'once' | 'always' | 'reject',
          },
        );
      }
    } catch (err) {
      // 僵尸 pending：serve 已无该 requestId/permissionId（worker 转发 404，如 serve 重启/请求
      // 已消失）→ 终态落库 + 广播收敛，前端弹窗关闭；而非一直 503 死循环（GET pending 恒返回）。
      if (
        err instanceof WorkerUnavailableException &&
        /HTTP 404/.test(err.message)
      ) {
        await this.expire(row, `reply 转发 serve 404（${row.requestId}）`);
        throw new GoneException({
          code: QUESTIONS_ERRORS.QUESTION_EXPIRED,
          message: `AgentQuestion ${row.id} 已过期（serve 已无请求 ${row.requestId}），弹窗已关闭`,
        });
      }
      throw err;
    }

    const updated = await this.prisma.agentQuestion.update({
      where: { id: row.id },
      data: { status, answers },
    });
    this.logger.log(
      `[questions] ${row.kind === AGENT_QUESTION_KINDS.QUESTION ? 'reply' : 'confirm'} ${row.kind} id=${row.id} status=${status} requestId=${row.requestId}（worker=${worker.id}）`,
    );
    const managedMode = await this.managedModeOf(updated.taskId);
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(updated, managedMode),
        taskId: updated.taskId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      this.scopeOf(updated.taskId),
    );
    return this.toDto(updated, managedMode);
  }

  private async managedModeOf(taskId: string): Promise<boolean> {
    if (!taskId) {
      return false;
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { managedMode: true },
    });
    return task?.managedMode ?? false;
  }

  private scopeOf(taskId: string): RealtimeScope {
    return taskId ? { type: 'task', id: taskId } : { type: 'global' };
  }

  /**
   * 僵尸/超期 pending 终态落库（expired + answers 留痕 reason）并广播收敛（resolved=true →
   * 前端 onAgentQuestion 关闭弹窗）。仅处理未终态记录，重复调用幂等（where 带 status）。
   */
  private async expire(row: AgentQuestion, reason: string): Promise<void> {
    this.platformResolvers.delete(row.requestId);
    const updated = await this.prisma.agentQuestion.update({
      where: { id: row.id },
      data: {
        status: AGENT_QUESTION_STATUS.EXPIRED,
        answers: { expired: true, reason } as Prisma.InputJsonValue,
      },
    });
    this.logger.warn(
      `[questions] ${row.id} 僵尸/超期 pending 已终态（expired）：${reason}`,
    );
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(updated, await this.managedModeOf(updated.taskId)),
        taskId: updated.taskId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      this.scopeOf(updated.taskId),
    );
  }

  /**
   * 平台侧创建 question（L2 自治确认门，如 team_add_member）。
   * - content 保持前端兼容形状：{questions: [{question, header, options}], source: 'platform'}，
   *   options 落库为 {label, description} 对象数组（对齐 ingress/serve 契约）；
   * - sessionId 用任务主 Agent 会话占位（仅满足非空约束，平台 question 不实际转发 worker）；
   * - requestId 用 que_platform_ 前缀（区别于 serve 下发的 que_ id，防唯一键碰撞）；
   * - options.onResolved：终态（确认/拒绝）时触发的执行钩子（按 requestId 注册）。
   */
  async createForPlatform(
    taskId: string,
    question: { question: string; header?: string; options?: string[] },
    options: { agentId?: string; onResolved?: PlatformResolveHook } = {},
  ): Promise<AgentQuestionDto> {
    const seq = await this.idGen.nextId('que');
    const requestId = `que_platform_${seq.split('_')[1] ?? ''}`;
    const id = await this.idGen.nextId(AGENT_QUESTION_ID_PREFIX);
    const content: Prisma.InputJsonValue = {
      questions: [
        {
          question: question.question,
          header: question.header ?? '平台确认',
          options: (question.options ?? []).map((label) => ({
            label,
            description: '',
          })),
        },
      ],
      source: PLATFORM_QUESTION_SOURCE,
    } as unknown as Prisma.InputJsonValue;
    const row = await this.prisma.agentQuestion.create({
      data: {
        id,
        requestId,
        sessionId: (await this.mainAgentSessionOf(taskId)) ?? 's_placeholder',
        taskId,
        agentId: options.agentId ?? '',
        kind: AGENT_QUESTION_KINDS.QUESTION,
        content,
        status: AGENT_QUESTION_STATUS.PENDING,
      },
    });
    if (options.onResolved) {
      this.platformResolvers.set(requestId, options.onResolved);
    }
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(row, await this.managedModeOf(row.taskId)),
        taskId: row.taskId,
        agentId: row.agentId,
        sessionId: row.sessionId,
      },
      this.scopeOf(row.taskId),
    );
    this.logger.log(
      `[questions] 平台创建 question id=${row.id} requestId=${requestId} taskId=${taskId}（确认门）`,
    );
    return this.toDto(row, await this.managedModeOf(row.taskId));
  }

  /** content.source === 'platform' 的平台 question 判定（旁路转发的标记分支）。 */
  private isPlatformQuestion(row: AgentQuestion): boolean {
    const content = (row.content ?? {}) as { source?: string };
    return content.source === PLATFORM_QUESTION_SOURCE;
  }

  /**
   * 平台 question 旁路终态（Oracle R2）：不经 workerClient（serve 无该 requestId 必
   * 404→expire），直接终态落库 + 触发 onResolved 钩子 + emit AGENT_QUESTION resolved:true
   * 收敛（对齐 forwardReply/expire 的弹窗关闭事件）。
   */
  private async resolvePlatformQuestion(
    row: AgentQuestion,
    payload: { answers?: string[][] | null; response?: PermissionResponse },
    actor?: { type: string; id: string },
  ): Promise<AgentQuestionDto> {
    const answers: Prisma.InputJsonValue =
      row.kind === AGENT_QUESTION_KINDS.QUESTION
        ? (payload.answers as Prisma.InputJsonValue)
        : { response: payload.response };
    const status =
      row.kind === AGENT_QUESTION_KINDS.QUESTION && payload.answers === null
        ? AGENT_QUESTION_STATUS.REJECTED
        : AGENT_QUESTION_STATUS.RESOLVED;
    const updated = await this.prisma.agentQuestion.update({
      where: { id: row.id },
      data: { status, answers },
    });
    this.logger.log(
      `[questions] 平台 question 终态 id=${row.id} status=${status} requestId=${row.requestId}（旁路，不转发 worker）`,
    );
    const hook = this.platformResolvers.get(row.requestId);
    if (hook) {
      try {
        await hook({
          answers: payload.answers ?? null,
          actor: actor ?? { type: ACTOR_TYPE.user, id: '' },
        });
      } catch (err) {
        // 执行钩子失败不阻塞弹窗收敛（question 已终态落库）；终态回调的 409 在钩子内自行忽略
        this.logger.error(
          `[questions] 平台 question 确认钩子执行失败 id=${row.id} requestId=${row.requestId}：${(err as Error).message}`,
        );
      } finally {
        this.platformResolvers.delete(row.requestId);
      }
    }
    const managedMode = await this.managedModeOf(updated.taskId);
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(updated, managedMode),
        taskId: updated.taskId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      this.scopeOf(updated.taskId),
    );
    return this.toDto(updated, managedMode);
  }

  /** 任务主 Agent 会话 id（平台 question sessionId 占位；无主实例/会话时回退占位符）。 */
  private async mainAgentSessionOf(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { mainAgentInstanceId: true },
    });
    if (!task?.mainAgentInstanceId) {
      return null;
    }
    const session = await this.prisma.session.findFirst({
      where: { taskId, taskAgentId: task.mainAgentInstanceId },
      select: { id: true },
    });
    return session?.id ?? null;
  }

  private toDto(row: AgentQuestion, managedMode = false): AgentQuestionDto {
    return {
      id: row.id,
      requestId: row.requestId,
      sessionId: row.sessionId,
      taskId: row.taskId,
      agentId: row.agentId,
      kind: row.kind,
      content: row.content,
      status: row.status,
      answers: row.answers,
      managedMode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
