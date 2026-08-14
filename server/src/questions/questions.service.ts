import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AgentQuestion, Prisma } from '@prisma/client';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeScope } from '../realtime/realtime.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerClient, WorkerUnavailableException } from '../workers/worker.client';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import {
  AGENT_QUESTION_ID_PREFIX,
  AGENT_QUESTION_KINDS,
  AGENT_QUESTION_STATUS,
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
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 模型提问 / 工具权限确认服务（worker 检测 serve pending → ingress 落库 → 本服务读/回复）。
 *
 * - findAll：会话页补拉（GET /questions?taskId=&status=pending），刷新/进入页面恢复弹窗；
 * - reply：用户答复 → WorkerClient 调 worker /question-reply → serve 应用 → AgentQuestion
 *   落库 resolved/rejected + answers → realtime.emit AGENT_QUESTION（{resolved}）收敛前端弹窗。
 *   落库失败/worker 不可达 → 明确错误（400/404/503），不静默。
 * - reply 链路 sessionId 语义：AgentQuestion.sessionId 为平台主键（s_），经 Session.instanceRef
 *   反查 opencode 会话 id（ses_）传 worker（worker 直接调 serve）。
 */
@Injectable()
export class QuestionsService {
  private readonly logger = new Logger(QuestionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly workerClient: WorkerClient,
  ) {}

  /** 进程启动对齐 aq_ 前缀序号（重启续号，对齐 models/git-repos onModuleInit 模式）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.agentQuestion, AGENT_QUESTION_ID_PREFIX, this.idGen);
  }

  /** GET /questions：按 taskId/status 过滤（会话页补拉用；status 缺省 pending）。 */
  async findAll(query: {
    taskId?: string;
    status?: string;
  }): Promise<AgentQuestionDto[]> {
    const where: Prisma.AgentQuestionWhereInput = {
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.status ? { status: query.status } : { status: AGENT_QUESTION_STATUS.PENDING }),
    };
    const rows = await this.prisma.agentQuestion.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    // 惰性过期：pending 超 TTL 且未回复 → 自动终态 + 广播收敛（僵尸/超时弹窗不无限弹）。
    const staleThreshold = new Date(Date.now() - QUESTION_PENDING_TTL_MS);
    const stale = rows.filter(
      (r) => r.status === AGENT_QUESTION_STATUS.PENDING && r.createdAt < staleThreshold,
    );
    if (stale.length > 0) {
      for (const r of stale) {
        await this.expire(r, `GET 惰性过期（pending 超 ${QUESTION_PENDING_TTL_MS / 60000}min）`);
      }
      const fresh = await this.prisma.agentQuestion.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      });
      return fresh.map((r) => this.toDto(r));
    }
    return rows.map((r) => this.toDto(r));
  }

  /**
   * POST /questions/:id/reply：用户答复（question=answers / permission=response）。
   * 流程：查 AgentQuestion → 经 Session.instanceRef 定位 opencode 会话 → WorkerClient 调
   * worker /question-reply → serve 应用成功 → 落库 resolved/rejected + answers → emit 收敛。
   * 失败不静默：找不到 404；参数与 kind 不符 400；worker 不可达 503。
   */
  async reply(id: string, dto: ReplyQuestionDto): Promise<AgentQuestionDto> {
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
    const session = await this.prisma.session.findUnique({
      where: { id: row.sessionId },
      select: { workerId: true, instanceRef: true },
    });
    // sessionId 双语义：s_ 前缀（平台主键）→ session.instanceRef 反查 opencode 会话 id；
    // ses_ 前缀（ingress 反查失败时保留的原始 opencode 会话 id）→ 直接透传 worker 调 serve。
    const opencodeSessionId =
      row.sessionId.startsWith('ses_') ? row.sessionId : session?.instanceRef;
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
        ? (dto.answers as Prisma.InputJsonValue)
        : { response: dto.response };
    const status =
      row.kind === AGENT_QUESTION_KINDS.QUESTION && dto.answers === null
        ? AGENT_QUESTION_STATUS.REJECTED
        : AGENT_QUESTION_STATUS.RESOLVED;

    try {
      if (row.kind === AGENT_QUESTION_KINDS.QUESTION) {
        await this.workerClient.questionReply(
          { id: worker.id, capabilities: worker.capabilities },
          {
            sessionId: opencodeSessionId,
            requestId: row.requestId,
            answers: dto.answers ?? null,
          },
        );
      } else {
        await this.workerClient.permissionReply(
          { id: worker.id, capabilities: worker.capabilities },
          {
            sessionId: opencodeSessionId,
            permissionId: row.requestId,
            response: dto.response as 'once' | 'always' | 'reject',
          },
        );
      }
    } catch (err) {
      // 僵尸 pending：serve 已无该 requestId/permissionId（worker 转发 404，如 serve 重启/请求
      // 已消失）→ 终态落库 + 广播收敛，前端弹窗关闭；而非一直 503 死循环（GET pending 恒返回）。
      if (err instanceof WorkerUnavailableException && /HTTP 404/.test(err.message)) {
        await this.expire(row, `reply 转发 serve 404（${row.requestId}）`);
        throw new GoneException({
          code: QUESTIONS_ERRORS.QUESTION_EXPIRED,
          message: `AgentQuestion ${id} 已过期（serve 已无请求 ${row.requestId}），弹窗已关闭`,
        });
      }
      throw err;
    }

    const updated = await this.prisma.agentQuestion.update({
      where: { id },
      data: { status, answers },
    });
    this.logger.log(
      `[questions] reply ${row.kind} id=${id} status=${status} requestId=${row.requestId}（worker=${worker.id}）`,
    );
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(updated),
        taskId: updated.taskId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      this.scopeOf(updated.taskId),
    );
    return this.toDto(updated);
  }

  private scopeOf(taskId: string): RealtimeScope {
    return taskId ? { type: 'task', id: taskId } : { type: 'global' };
  }

  /**
   * 僵尸/超期 pending 终态落库（expired + answers 留痕 reason）并广播收敛（resolved=true →
   * 前端 onAgentQuestion 关闭弹窗）。仅处理未终态记录，重复调用幂等（where 带 status）。
   */
  private async expire(row: AgentQuestion, reason: string): Promise<void> {
    const updated = await this.prisma.agentQuestion.update({
      where: { id: row.id },
      data: {
        status: AGENT_QUESTION_STATUS.EXPIRED,
        answers: { expired: true, reason } as Prisma.InputJsonValue,
      },
    });
    this.logger.warn(`[questions] ${row.id} 僵尸/超期 pending 已终态（expired）：${reason}`);
    await this.realtime.emit(
      EVENT_TYPES.AGENT_QUESTION,
      {
        question: this.toDto(updated),
        taskId: updated.taskId,
        agentId: updated.agentId,
        sessionId: updated.sessionId,
        resolved: true,
      },
      this.scopeOf(updated.taskId),
    );
  }

  private toDto(row: AgentQuestion): AgentQuestionDto {
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
