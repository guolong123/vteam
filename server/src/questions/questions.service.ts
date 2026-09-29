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
import { resyncIdPrefix, resyncRequestIdPrefix } from '../common/id-resync';
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
  QUESTION_CONFIRM_INTEGRITY_ERRORS,
  QUESTION_PENDING_TTL_MS,
  QUESTIONS_ERRORS,
  SECRET_QUESTION_SOURCE,
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
  /** 托管模式标记：团队开启托管（team.managedMode=true）时该请求改由主 Agent 确认，前端不弹窗。 */
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
 * secret_input 终态钩子（createSecretForPlatform 注册，填写/取消时触发）。
 * secrets 值只在进程内存传给钩子执行命令：不落 content、不落 answers、不进 SSE、不写日志。
 */
type PlatformSecretResolveHook = (args: {
  outcome: 'provided' | 'cancelled';
  secrets: Record<string, string> | null;
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

  /** secret_input 终态钩子（key=requestId；secret 值仅经此内存传递，绝不落库/广播）。 */
  private readonly secretResolvers = new Map<
    string,
    PlatformSecretResolveHook
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly workerClient: WorkerClient,
  ) {}

  /**
   * 进程启动对齐序号（重启续号，对齐 models/git-repos onModuleInit 模式）：
   * - `aq_` 主键前缀；
   * - `que` 计数器对齐 `request_id` 中 `que_platform_` 的最大数字尾段——
   *   `agent_questions.request_id` 是 `@unique`（agent_questions_request_id_key，非 PK），
   *   计数器重启归零后重发 `que_platform_0000000001` 会撞既有行 P2002。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.agentQuestion,
      AGENT_QUESTION_ID_PREFIX,
      this.idGen,
    );
    await resyncRequestIdPrefix(
      this.prisma.agentQuestion,
      'que',
      'que_platform',
      this.idGen,
    );
  }

  /** GET /questions：按 taskId/teamId/status 过滤（会话页补拉用；status 缺省 pending）。teamId 经任务归属 + 会话归属双路实现，无 schema 变更。 */
  async findAll(query: {
    taskId?: string;
    teamId?: string;
    status?: string;
  }): Promise<AgentQuestionDto[]> {
    const statusFilter = query.status
      ? { status: query.status }
      : { status: AGENT_QUESTION_STATUS.PENDING };
    let where: Prisma.AgentQuestionWhereInput = { ...statusFilter };
    if (query.teamId) {
      const [tasks, sessions] = await Promise.all([
        this.prisma.task.findMany({
          where: { teamId: query.teamId },
          select: { id: true },
        }),
        this.prisma.session.findMany({
          where: { teamId: query.teamId },
          select: { id: true },
        }),
      ]);
      where = {
        ...where,
        OR: [
          { taskId: { in: tasks.map((t) => t.id) } },
          { sessionId: { in: sessions.map((s) => s.id) } },
        ],
      };
    } else if (query.taskId) {
      where = { ...where, taskId: query.taskId };
    }
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

  /** 批量行 → DTO：按团队归属一次查询关联团队 managedMode（托管标记，前端据此过滤弹窗）。 */
  private async toDtos(rows: AgentQuestion[]): Promise<AgentQuestionDto[]> {
    const taskIds = [...new Set(rows.map((r) => r.taskId).filter(Boolean))];
    const sessionIds = [
      ...new Set(rows.map((r) => r.sessionId).filter(Boolean)),
    ];
    const [tasks, sessions] = await Promise.all([
      taskIds.length > 0
        ? await this.prisma.task.findMany({
            where: { id: { in: taskIds } },
            select: { id: true, teamId: true },
          })
        : [],
      sessionIds.length > 0
        ? await this.prisma.session.findMany({
            where: { id: { in: sessionIds } },
            select: { id: true, teamId: true },
          })
        : [],
    ]);
    const teamByTask = new Map(
      tasks.map((t) => [t.id, (t as { teamId?: string | null }).teamId]),
    );
    const teamBySession = new Map(
      sessions.map((s) => [s.id, (s as { teamId?: string | null }).teamId]),
    );
    const teamIds = [
      ...new Set(
        rows
          .map(
            (r) =>
              teamBySession.get(r.sessionId) ??
              teamByTask.get(r.taskId as string),
          )
          .filter(Boolean) as string[],
      ),
    ];
    const teams =
      teamIds.length > 0
        ? ((await (this.prisma as any).team.findMany({
            where: { id: { in: teamIds } },
            select: { id: true, managedMode: true },
          })) as Array<{ id: string; managedMode?: boolean | null }>)
        : [];
    const managedByTeam = new Map(
      teams.map((t) => [t.id, t.managedMode ?? false]),
    );
    return rows.map((r) => {
      const teamId =
        teamBySession.get(r.sessionId) ??
        (r.taskId ? teamByTask.get(r.taskId) : undefined);
      return this.toDto(
        r,
        teamId ? (managedByTeam.get(teamId) ?? false) : false,
      );
    });
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
    if (row.kind === AGENT_QUESTION_KINDS.SECRET_INPUT) {
      // secret 不进 forwardReply（worker 转发链）：平台旁路直接终态，值仅传给注册钩子（内存）。
      return this.resolveSecretQuestion(row, dto, {
        type: ACTOR_TYPE.user,
        id: userId ?? '',
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
   * 托管确认（question_confirm MCP 工具）：团队托管模式下确认成员请求。
   * 身份门禁（原「仅主成员」403）已移除：调用权限由调用方 ROLE 的 toolAllows 决定；
   * 缺口由两道完整性校验补上：
   *   1) 确认者不得为请求发起者本人，防自批。发起者身份来源分两种：
   *      - 平台 question（source='platform'）：发起者由 createForPlatform 在创建时记入
   *        content.requesterInstanceId（row.sessionId 只是主成员会话占位，反映不了真实
   *        发起者，不能作为依据）→ 直接比对记录值；
   *      - 非平台 question，或本次修复前创建的历史平台行（无 requesterInstanceId 记录）→
   *        回退原 session.teamMemberId 比对（保持既有语义，**不静默放宽**）。历史平台行
   *        对非主发起者仍可能 fail-open，属已知残留，新行恒武装。
   *   2) 请求归属任务须与调用方任务一致（row.taskId === input.taskId），防跨任务确认。
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
    // team:<id> 域（团队会话，worker 行 taskId 为空）：跳过任务查表直接按团队校验；
    // 任务形态保持原语义（task 查不存在 → TASK_NOT_FOUND）。
    const teamScopedId = input.taskId.startsWith('team:')
      ? input.taskId.slice('team:'.length)
      : null;
    let teamId: string | null = teamScopedId;
    if (!teamScopedId) {
      const task = await this.prisma.task.findUnique({
        where: { id: input.taskId },
        select: { teamId: true },
      });
      if (!task) {
        throw new NotFoundException({
          code: TASK_ERRORS.TASK_NOT_FOUND,
          message: '任务不存在',
        });
      }
      teamId = task.teamId;
    }
    const team = teamId
      ? await this.prisma.team.findUnique({
          where: { id: teamId },
          select: { id: true },
        })
      : null;
    if (!team) {
      throw new NotFoundException({
        code: QUESTIONS_ERRORS.QUESTION_TEAM_NOT_FOUND,
        message: '团队不存在',
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
    // 完整性校验 2：跨任务/跨团队确认拒绝（请求须属于调用方任务或团队）。
    // 团队形态：worker 行 taskId 空 → 经会话所属团队比对；平台自建行存有
    // team:<id> → 直接比对（两形态均精确，不放宽）。
    if (teamScopedId) {
      const sessionTeamId = row.sessionId
        ? ((
            await this.prisma.session.findUnique({
              where: { id: row.sessionId },
              select: { teamId: true },
            })
          )?.teamId ?? null)
        : null;
      const belongs = row.taskId
        ? row.taskId === input.taskId
        : sessionTeamId === teamScopedId;
      if (!belongs) {
        throw new ForbiddenException({
          code: QUESTION_CONFIRM_INTEGRITY_ERRORS.CROSS_TASK_FORBIDDEN,
          message: `请求 ${input.requestId} 归属团队与调用方 ${input.taskId} 不一致，禁止跨团队确认`,
        });
      }
    } else if (row.taskId !== input.taskId) {
      throw new ForbiddenException({
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.CROSS_TASK_FORBIDDEN,
        message: `请求 ${input.requestId} 归属任务 ${row.taskId}，与调用方任务 ${input.taskId} 不一致，禁止跨任务确认`,
      });
    }
    // 完整性校验 1a：平台 question 自批拒绝——发起者实例 id 创建时记入 content
    // （row.sessionId 是主成员会话占位，不能据此判断真实发起者）。
    const recordedRequester = this.platformRequesterOf(row);
    if (recordedRequester && recordedRequester === input.instanceId) {
      throw new ForbiddenException({
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.SELF_CONFIRMATION_FORBIDDEN,
        message: `请求 ${input.requestId} 由成员 ${input.instanceId} 本人发起，不可自行确认`,
      });
    }
    // 完整性校验 1b：非平台 question（或历史平台行无发起者记录）回退既有会话比对
    // （发起者会话的 teamMemberId === 确认者 instanceId）。历史行不静默放宽。
    const requesterSession =
      recordedRequester || !row.sessionId
        ? null
        : await this.prisma.session.findUnique({
            where: { id: row.sessionId },
            select: { teamMemberId: true },
          });
    if (
      requesterSession?.teamMemberId &&
      requesterSession.teamMemberId === input.instanceId
    ) {
      throw new ForbiddenException({
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.SELF_CONFIRMATION_FORBIDDEN,
        message: `请求 ${input.requestId} 由成员 ${input.instanceId} 本人发起，不可自行确认`,
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
    payload: {
      answers?: string[][] | null;
      response?: PermissionResponse;
      secrets?: Record<string, string> | null;
    },
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
    // 任务所属团队 + 模板 agentId 定位团队成员，再取其团队会话绑定 worker。
    const workerId =
      session?.workerId ??
      (row.sessionId.startsWith('ses_')
        ? await this.findTeamSessionWorker(row.taskId, row.agentId)
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
    const managedMode = await this.managedModeOf(
      updated.taskId,
      updated.sessionId,
    );
    // 收敛帧 payload 口径同 ingress：团队会话行 taskId 空 → 补 team:<teamId> + 顶层
    // teamId，否则 use-sse team: 段匹配不过，其他页签弹窗不关闭。
    const teamId = await this.teamIdOf(updated.taskId, updated.sessionId);
    const payloadTaskId = updated.taskId || (teamId ? `team:${teamId}` : null);
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(updated, managedMode),
        taskId: payloadTaskId,
        teamId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      teamId ? { type: 'team', id: teamId } : { type: 'global' },
    );
    return this.toDto(updated, managedMode);
  }

  /** ses_ 回退 worker 定位：任务 teamId + 模板 agentId → 团队成员 → 其团队会话绑定 worker。 */
  private async findTeamSessionWorker(
    taskId: string | null,
    agentId: string | null,
  ): Promise<string | null> {
    if (!taskId || !agentId) {
      return null;
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { teamId: true },
    });
    if (!task?.teamId) {
      return null;
    }
    const member = await this.prisma.teamMember.findFirst({
      where: { teamId: task.teamId, agentId },
      select: { id: true },
    });
    if (!member) {
      return null;
    }
    const teamSession = await this.prisma.session.findFirst({
      where: {
        teamId: task.teamId,
        teamMemberId: member.id,
        workerId: { not: null },
      },
      select: { workerId: true },
      orderBy: { updatedAt: 'desc' },
    });
    return teamSession?.workerId ?? null;
  }

  /** 团队归属解析：会话 teamId 优先（session-unification Todo 9 经 session.teamId 读团队行），回退任务归属 teamId；均无 → null。 */
  private async teamIdOf(
    taskId: string | null,
    sessionId?: string | null,
  ): Promise<string | null> {
    if (sessionId) {
      const sess = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { teamId: true },
      });
      if (sess?.teamId) {
        return sess.teamId;
      }
    }
    if (taskId) {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      if (task?.teamId) {
        return task.teamId;
      }
    }
    return null;
  }

  /** 托管开关读团队行：team.managedMode；有归属但团队行缺失 → 404；无归属 → false。 */
  private async managedModeOf(
    taskId: string | null,
    sessionId?: string | null,
  ): Promise<boolean> {
    const teamId = await this.teamIdOf(taskId, sessionId);
    if (!teamId) {
      return false;
    }
    const team = (await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { managedMode: true },
    })) as { managedMode?: boolean | null } | null;
    if (!team) {
      throw new NotFoundException({
        code: QUESTIONS_ERRORS.QUESTION_TEAM_NOT_FOUND,
        message: '团队不存在',
      });
    }
    return team.managedMode ?? false;
  }

  /** 问题事件 scope：团队域（session-unification Todo 9）；无团队归属回退 global。 */
  private async scopeOf(
    taskId: string | null,
    sessionId?: string | null,
  ): Promise<RealtimeScope> {
    const teamId = await this.teamIdOf(taskId, sessionId);
    return teamId ? { type: 'team', id: teamId } : { type: 'global' };
  }

  /**
   * 僵尸/超期 pending 终态落库（expired + answers 留痕 reason）并广播收敛（resolved=true →
   * 前端 onAgentQuestion 关闭弹窗）。仅处理未终态记录，重复调用幂等（where 带 status）。
   */
  private async expire(row: AgentQuestion, reason: string): Promise<void> {
    this.platformResolvers.delete(row.requestId);
    this.secretResolvers.delete(row.requestId);
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
    // 收敛帧 payload 口径同 reply（团队会话行 taskId 空 → 补 team:<teamId>，
    // 否则前端 team: 段过滤丢帧、过期收敛页签无感）。
    const expireTeamId = await this.teamIdOf(updated.taskId, updated.sessionId);
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(
          updated,
          await this.managedModeOf(updated.taskId, updated.sessionId),
        ),
        taskId:
          updated.taskId || (expireTeamId ? `team:${expireTeamId}` : null),
        teamId: expireTeamId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      expireTeamId ? { type: 'team', id: expireTeamId } : { type: 'global' },
    );
  }

  /**
   * 平台侧创建 question（L2 自治确认门，如 team_add_member）。
   * - content 保持前端兼容形状：{questions: [{question, header, options}], source: 'platform'}，
   *   options 落库为 {label, description} 对象数组（对齐 ingress/serve 契约）；
   * - content.requesterInstanceId：创建时记录真实发起者实例 id（options.requesterInstanceId），
   *   供 confirmByAgent 的自批校验比对（sessionId 只是主成员会话占位，反映不了发起者）。
   *   缺省 null（无发起者身份的历史/占位调用），校验回退会话比对，不静默放宽；
   * - sessionId 用任务主 Agent 会话占位（仅满足非空约束，平台 question 不实际转发 worker）；
   * - requestId 用 que_platform_ 前缀（区别于 serve 下发的 que_ id，防唯一键碰撞）；
   * - options.onResolved：终态（确认/拒绝）时触发的执行钩子（按 requestId 注册）。
   */
  async createForPlatform(
    taskId: string,
    question: { question: string; header?: string; options?: string[] },
    options: {
      agentId?: string;
      requesterInstanceId?: string;
      onResolved?: PlatformResolveHook;
    } = {},
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
      requesterInstanceId: options.requesterInstanceId ?? null,
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
    // create emit 与 scope 同源补顶层 teamId：payload.taskId 保持真实 t_... 以兼容
    // task-scope 消费者；否则 web matchesScope team: 兜底无法匹配、实时帧被丢弃。
    const createScope = await this.scopeOf(row.taskId, row.sessionId);
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(
          row,
          await this.managedModeOf(row.taskId, row.sessionId),
        ),
        taskId: row.taskId,
        teamId: createScope.type === 'team' ? createScope.id : null,
        agentId: row.agentId,
        sessionId: row.sessionId,
      },
      createScope,
    );
    this.logger.log(
      `[questions] 平台创建 question id=${row.id} requestId=${requestId} taskId=${taskId}（确认门）`,
    );
    return this.toDto(row, await this.managedModeOf(row.taskId, row.sessionId));
  }

  /**
   * 平台侧创建 secret_input question（secret_command 等待用户填写敏感值）。
   * - content 只持久化模板与变量元数据（source/template/variables/reason/
   *   requesterInstanceId），绝不存值；
   * - **本方法不读 managedMode、不做任何身份门禁**（用户决策 2026-09-29，提交
   *   8eaaa22 整块移除了 `assertSecretCommandManagedAllowed` 与
   *   `createSecretForPlatform` 的托管身份分支）：托管开关开或关都照常弹窗，
   *   团队内任意 agent 都能发起。理由是这类工具必须**用户本人**输入密钥，托管的
   *   「交主 Agent 确认」语义在这个环节管不到东西；`toDto` 对 secret_input 恒
   *   `managedMode=false` 即该决策的落点。此处**不要**再加回按身份的拒绝。
   * - `options.teamId`：团队直聊（无任务）场景的归属，taskId 传空串；
   * - `options.requesterInstanceId`：写入 content，供 `confirmByAgent` 的自确认
   *   校验比对。**注意其来源是工具入参 `selfInstanceId`（客户端可控）**，不是
   *   服务端推导的身份；当前无身份门依赖它，但若将来据它做授权判断，须先消除
   *   该回声（团队内可冒名他人 instance id）。
   * - requestId 用 que_platform_ 前缀（与 createForPlatform 同规则，防唯一键碰撞）；
   * - options.onSecretResolved：终态（填写/取消）钩子，secrets 仅在进程内存传递。
   */
  async createSecretForPlatform(
    taskId: string,
    input: {
      template: string;
      variables: Array<{ name: string; secret?: boolean }>;
      reason?: string;
    },
    options: {
      agentId?: string;
      teamId?: string;
      requesterInstanceId?: string;
      onSecretResolved?: PlatformSecretResolveHook;
    } = {},
  ): Promise<AgentQuestionDto> {
    const teamId = options.teamId ?? (await this.teamIdOf(taskId, null));
    const sessionId = teamId
      ? ((await this.mainAgentSessionOfTeam(teamId)) ??
        (taskId ? await this.mainAgentSessionOf(taskId) : null))
      : await this.mainAgentSessionOf(taskId);
    // 解析不到会话就**快速失败**，不落占位行。
    //
    // 与 createForPlatform 的不对称：那边 s_placeholder 无害（question 行只等
    // worker 转发，无人应答会走 TTL/expire 收敛）；这边调用方**阻塞等待**答复，
    // 而 teamId 只能由 taskId/sessionId 反查 —— 两者皆为哨兵值时该行永远送不到
    // 用户面前，调用方只能空等满 540s 输入预算。
    if (!sessionId) {
      throw new ServiceUnavailableException({
        code: QUESTIONS_ERRORS.QUESTION_WORKER_UNAVAILABLE,
        message:
          '该团队暂无主 Agent 会话，无法弹出敏感值输入框（不会创建问题行，请先建立主 Agent 会话后重试）',
      });
    }
    const seq = await this.idGen.nextId('que');
    const requestId = `que_platform_${seq.split('_')[1] ?? ''}`;
    const id = await this.idGen.nextId(AGENT_QUESTION_ID_PREFIX);
    const content: Prisma.InputJsonValue = {
      source: SECRET_QUESTION_SOURCE,
      template: input.template,
      variables: (input.variables ?? []).map((v) => ({
        name: v.name,
        secret: v.secret ?? true,
      })),
      reason: input.reason ?? null,
      // 真实发起者实例 id：对齐 createForPlatform（:717）。缺它则 platformRequesterOf
      // 对 secret_input 恒返回 null，confirmByAgent 的自确认校验 1a 永不触发。
      requesterInstanceId: options.requesterInstanceId ?? null,
    } as unknown as Prisma.InputJsonValue;
    const row = await this.prisma.agentQuestion.create({
      data: {
        id,
        requestId,
        sessionId: sessionId ?? 's_placeholder',
        taskId,
        agentId: options.agentId ?? '',
        kind: AGENT_QUESTION_KINDS.SECRET_INPUT,
        content,
        status: AGENT_QUESTION_STATUS.PENDING,
      },
    });
    if (options.onSecretResolved) {
      this.secretResolvers.set(requestId, options.onSecretResolved);
    }
    const managedMode = await this.managedModeOf(row.taskId, row.sessionId);
    // create emit 与 scope 同源补顶层 teamId（口径同 createForPlatform）。
    const secretScope = await this.scopeOf(row.taskId, row.sessionId);
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(row, managedMode),
        taskId: row.taskId,
        teamId: secretScope.type === 'team' ? secretScope.id : null,
        agentId: row.agentId,
        sessionId: row.sessionId,
      },
      secretScope,
    );
    this.logger.log(
      `[questions] 平台创建 secret_input id=${row.id} requestId=${requestId} taskId=${taskId}（敏感输入，值不落库）`,
    );
    return this.toDto(row, managedMode);
  }

  /** content.source === 'platform'|'secret_input' 的平台 question 判定（旁路转发的标记分支）。 */
  private isPlatformQuestion(row: AgentQuestion): boolean {
    const content = (row.content ?? {}) as { source?: string };
    return (
      content.source === PLATFORM_QUESTION_SOURCE ||
      content.source === SECRET_QUESTION_SOURCE
    );
  }

  /** content.requesterInstanceId：平台 question 创建时记录的发起者实例 id（历史/占位行为 null）。 */
  private platformRequesterOf(row: AgentQuestion): string | null {
    const content = (row.content ?? {}) as { requesterInstanceId?: unknown };
    return typeof content.requesterInstanceId === 'string' &&
      content.requesterInstanceId.length > 0
      ? content.requesterInstanceId
      : null;
  }

  /**
   * 平台 question 旁路终态（Oracle R2）：不经 workerClient（serve 无该 requestId 必
   * 404→expire），直接终态落库 + 触发 onResolved 钩子 + emit AGENT_QUESTION resolved:true
   * 收敛（对齐 forwardReply/expire 的弹窗关闭事件）。
   */
  private async resolvePlatformQuestion(
    row: AgentQuestion,
    payload: {
      answers?: string[][] | null;
      response?: PermissionResponse;
      secrets?: Record<string, string> | null;
    },
    actor?: { type: string; id: string },
  ): Promise<AgentQuestionDto> {
    if (row.kind === AGENT_QUESTION_KINDS.SECRET_INPUT) {
      return this.resolveSecretQuestion(
        row,
        { secrets: payload.secrets },
        actor ?? { type: ACTOR_TYPE.user, id: '' },
      );
    }
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
    const managedMode = await this.managedModeOf(
      updated.taskId,
      updated.sessionId,
    );
    // 收敛帧 payload 口径同 ingress（团队会话行补 team:<teamId>，见 reply 处注释）。
    const confirmTeamId = await this.teamIdOf(
      updated.taskId,
      updated.sessionId,
    );
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(updated, managedMode),
        taskId:
          updated.taskId || (confirmTeamId ? `team:${confirmTeamId}` : null),
        teamId: confirmTeamId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      confirmTeamId ? { type: 'team', id: confirmTeamId } : { type: 'global' },
    );
    return this.toDto(updated, managedMode);
  }

  /** content.variables[].name 清单（secret_input 已声明变量；content 缺失/畸形 → 空数组）。 */
  private secretVariableNamesOf(row: AgentQuestion): string[] {
    const content = (row.content ?? {}) as { variables?: unknown };
    if (!Array.isArray(content.variables)) {
      return [];
    }
    return content.variables
      .map((v) => (v as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string');
  }

  /**
   * secret_input 终态（平台旁路：不经 workerClient、不经 forwardReply）。
   * - `{secrets:{变量:值}}` → resolved；值只传给注册钩子（进程内存），落库 answers=
   *   `{provided,filled,actorType,actorId}`（filled=变量名清单，不含值）；
   * - `{secrets:null}` → 取消：rejected + 钩子 outcome='cancelled'（不执行命令）；
   * - 缺 secrets / 未声明变量 / 已声明变量缺值 → 400（终态重复回复在 reply 入口 400）。
   */
  private async resolveSecretQuestion(
    row: AgentQuestion,
    dto: { secrets?: Record<string, string> | null },
    actor: { type: string; id: string },
  ): Promise<AgentQuestionDto> {
    if (dto.secrets === undefined) {
      throw new BadRequestException({
        code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY,
        message:
          'secret_input 回复需携带 secrets（{变量名: 值}）或 null（取消）',
      });
    }
    const declared = this.secretVariableNamesOf(row);
    const secrets = dto.secrets;
    if (secrets !== null) {
      for (const key of Object.keys(secrets)) {
        if (!declared.includes(key)) {
          throw new BadRequestException({
            code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY,
            message: `secrets 含未声明变量 ${key}`,
          });
        }
      }
      for (const name of declared) {
        if (!Object.prototype.hasOwnProperty.call(secrets, name)) {
          throw new BadRequestException({
            code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY,
            message: `secrets 缺少已声明变量 ${name}`,
          });
        }
        if (typeof secrets[name] !== 'string') {
          throw new BadRequestException({
            code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY,
            message: `secrets.${name} 必须为字符串`,
          });
        }
      }
    }
    const provided = secrets !== null;
    const status = provided
      ? AGENT_QUESTION_STATUS.RESOLVED
      : AGENT_QUESTION_STATUS.REJECTED;
    const answers: Prisma.InputJsonValue = {
      provided,
      filled: provided ? declared : [],
      actorType: actor.type,
      actorId: actor.id,
    };
    const updated = await this.prisma.agentQuestion.update({
      where: { id: row.id },
      data: { status, answers },
    });
    this.logger.log(
      `[questions] secret_input 终态 id=${row.id} status=${status} filled=${provided ? declared.length : 0} requestId=${row.requestId}（旁路，不转发 worker）`,
    );
    const hook = this.secretResolvers.get(row.requestId);
    if (hook) {
      try {
        await hook({
          outcome: provided ? 'provided' : 'cancelled',
          secrets,
          actor,
        });
      } catch (err) {
        // 钩子错误 message 由执行链拼装（可能含命令输出/secret）：落日志前精确替换脱敏。
        let msg = (err as Error)?.message ?? String(err);
        for (const v of Object.values(secrets ?? {})) {
          if (v) {
            msg = msg.split(v).join('***');
          }
        }
        this.logger.error(
          `[questions] secret_input 终态钩子执行失败 id=${row.id} requestId=${row.requestId}：${msg}`,
        );
      } finally {
        this.secretResolvers.delete(row.requestId);
      }
    }
    const managedMode = await this.managedModeOf(
      updated.taskId,
      updated.sessionId,
    );
    const secretTeamId = await this.teamIdOf(updated.taskId, updated.sessionId);
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(updated, managedMode),
        taskId:
          updated.taskId || (secretTeamId ? `team:${secretTeamId}` : null),
        teamId: secretTeamId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      secretTeamId ? { type: 'team', id: secretTeamId } : { type: 'global' },
    );
    return this.toDto(updated, managedMode);
  }

  /** 团队主成员会话 id（平台 question sessionId 占位；无主成员/会话时回退占位符）。 */
  private async mainAgentSessionOf(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { teamId: true },
    });
    if (!task?.teamId) {
      return null;
    }
    return this.mainAgentSessionOfTeam(task.teamId);
  }

  /** 团队主 Agent 的团队会话 id（团队直聊/任务内共用同一口径）。 */
  private async mainAgentSessionOfTeam(teamId: string): Promise<string | null> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { mainAgentMemberId: true },
    });
    if (!team?.mainAgentMemberId) {
      return null;
    }
    const session = await this.prisma.session.findFirst({
      where: { teamId, teamMemberId: team.mainAgentMemberId },
      select: { id: true },
    });
    return session?.id ?? null;
  }

  /**
   * AgentQuestion → DTO。
   *
   * `secret_input` 的 managedMode **恒 false**（is_0000000001 问题 2）：托管标记的
   * 作用是「前端不弹窗、改由主 Agent 代确认」，而密钥值只有用户手里有——带着
   * managedMode=true 会让弹窗永不出现，等于把主 Agent 也彻底堵死。收敛口径必须
   * 收在这里（create/resolve/expire/list 共用），否则任一路径漏改就复现「无人收到
   * 弹窗」。
   */
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
      managedMode:
        row.kind === AGENT_QUESTION_KINDS.SECRET_INPUT ? false : managedMode,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
