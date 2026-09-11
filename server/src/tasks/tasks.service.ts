import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ACTOR_TYPE,
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
  SESSION_STATUS,
} from '../common/constants/event.constants';
import {
  TASK_ERRORS,
  TASK_PRIORITY,
  TASK_STATUS,
  TASK_TRANSITIONS,
} from '../common/constants/task.constants';
import {
  EXECUTION_MODES,
  PLAN_ERRORS,
  PLAN_STATUS,
  PLAN_TASK_STATUS,
} from '../plans/plan.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { RejectTaskDto } from './dto/reject-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { TaskProgressionScheduler } from './task-progression.scheduler';
import { sanitizeWorkDirName } from './work-dir.util';

/** 任务域主键前缀（15 篇 §2.2：<prefix>_<零填充序号>）。 */
const ID_PREFIX = {
  task: 't',
  channel: 'c',
  teamMember: 'tmm',
  taskEvent: 'te',
  message: 'm',
  session: 's',
  teamQueue: 'tq',
} as const;

/** 角色中文名映射（seed 模板 agent.role → 中文名；未知角色回退 agent.name，FR-08 别名默认规则）。 */
const ROLE_LABELS: Record<string, string> = {
  product: '产品经理',
  project_manager: '项目经理',
  architect: '架构师',
  developer: '开发者',
  tester: '测试',
} as const;

/** 团队成员视图（team_members 行 + 模板 agent 关联，instances 唯一派生源）。 */
type TeamMemberView = {
  id: string;
  agentId: string;
  alias: string | null;
  seq: number;
  workDir?: string | null;
  overrideModelId?: string | null;
  agent: { id: string; name: string; role: string | null };
};

/** 任务行（实例派生源为归属团队的团队成员）。 */
type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  mainAgentId: string | null;
  mainAgentInstanceId: string | null;
  executionMode: string;
  backgroundDocs: Prisma.JsonValue | null;
  resetAfterComplete?: boolean | null;
  teamId?: string | null;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  pendingReviewAt: Date | null;
  completedAt: Date | null;
  archivedAt: Date | null;
};

/** 系统消息行（messages 表；content 为 Json 列，对齐 ChatService.toMessageDto）。 */
type SysMessageRow = {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string | null;
  content: Prisma.JsonValue;
  mentions: Prisma.JsonValue | null;
  status: string;
  createdAt: Date;
};

/** 状态迁移系统消息上下文（10 篇 §8.1 文案生成所需）。 */
type SysMessageCtx = {
  task: TaskRow;
  /** 主实例别名（start/accept 解析实例 alias，缺省 `<角色中文名>-<seq>`；查询不到回退实例 id）。 */
  mainAgentName?: string;
};

/** 状态迁移动作的可选项（副作用编排，见 transition）。 */
type TransitionOptions = {
  /** task_events.eventType：status_change / accept / reject / archive（08 篇 §6.1）。 */
  eventType: string;
  /** 迁移时写入 tasks 的额外标量字段（startedAt 等）。 */
  fields?: Prisma.TaskUpdateManyMutationInput;
  /** task_events.metadata（reject 写 { reason }）。 */
  metadata?: Prisma.InputJsonValue;
  /** CAS 前业务前置校验（start：团队非空 + 主 Agent 已确定；tc-flow 追加 plan 模式分支校验，可异步查表）。 */
  preflight?: (task: TaskRow) => void | Promise<void>;
  /** 事务内副作用（仅 archive：sessions 全部置 archived）。 */
  afterCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** 群聊系统消息文案（10 篇 §8.1，落库 task_group 频道 senderType=system）；不传则不生成。 */
  sysMessage?: (ctx: SysMessageCtx) => string;
  /** start/accept 私信主 Agent 的提示文案（13 篇 §4.2 + 记忆管理 mem-trigger，落库主 Agent private 频道）；不传则只写群聊。 */
  privateMessage?: (ctx: SysMessageCtx) => string;
  /** 动作执行者（task_events.actorType/actorId + TASK_STATUS_CHANGED 广播）；缺省 user/调用者。 */
  actor?: { type: string; id: string };
};

/**
 * 任务 CRUD/看板/五态状态机（09 篇 §3.4 Tasks；13 篇 §2.2/§4.1~§4.5）。
 *
 * 本版实现：创建（三件套同事务 + 状态事件 + 广播）、看板列表、详情、PATCH 编辑、
 * 五态迁移（start/mark-pending-review/accept/reject/archive，迁移表驱动 + CAS 乐观锁）。
 * team 调整（FR-02）属后续任务（T8）。
 */
@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly sessionLifecycle: SessionLifecycleService,
    private readonly progression: TaskProgressionScheduler,
  ) {}

  /** 进程启动：按库内各前缀纯数字序号最大值对齐 id 生成器（resyncIdPrefix 跳过非数字 id，防主键冲突）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.task, ID_PREFIX.task, this.idGen);
    await resyncIdPrefix(
      this.prisma.chatChannel,
      ID_PREFIX.channel,
      this.idGen,
    );
    await resyncIdPrefix(
      this.prisma.taskEvent,
      ID_PREFIX.taskEvent,
      this.idGen,
    );
    await resyncIdPrefix(this.prisma.message, ID_PREFIX.message, this.idGen);
    await resyncIdPrefix(this.prisma.session, ID_PREFIX.session, this.idGen);
    await resyncIdPrefix(
      (this.prisma as any).teamQueue,
      ID_PREFIX.teamQueue,
      this.idGen,
    );
  }

  /**
   * 创建任务（团队门 + FIFO 串行排队，双保险行锁+版本CAS重试3次）。
   * 事务内：SELECT team FOR UPDATE + version CAS → 校验 teamUserMember 团队成员
   * → 空闲则 currentTaskId=新task pending，否则 TeamQueue position MAX+1 queued
   * → 任务只作为数据行（实例唯一来源为团队成员 TeamMember，不写任务侧快照）
   * → Message.taskId 分区（本期仅任务侧，后续 ChatService 复用 team_group 时带 taskId 分隔）
   * → 广播 TASK_STATUS_CHANGED + TEAM_QUEUE_CHANGED。
   */
  async create(userId: string, dto: CreateTaskDto) {
    const teamId = this.requireCreateTeam(dto);

    // 团队门：调用者须为目标团队的用户成员（team_user_members 存在性校验）
    const member = await (this.prisma as any).teamUserMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!member) {
      throw new ForbiddenException({
        code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该团队成员',
      });
    }
    return this.createTaskInternal(dto, teamId, {
      createdBy: userId,
      actorType: ACTOR_TYPE.user,
    });
  }

  /**
   * team-free-chat todo-4：agent 建任务通道（platform-mcp task_create 调用）。
   * 与 create 共用事务体（createTaskInternal，不复制）：跳过按调用方 userId 的团队成员
   * 校验（agent 无 user 归属，归属由调用方 MCP 层的团队门保证）。
   * task.createdBy 外键指向 users：调用方实例 id 非用户行，落库改用团队用户成员
   * （owner 优先）；实例归属仍记事件与广播 actorId（actorType=agent）。
   */
  async createByAgent(callerInstanceId: string, dto: CreateTaskDto) {
    const teamId = this.requireCreateTeam(dto);
    const userMembers = await (this.prisma as any).teamUserMember.findMany({
      where: { teamId },
      select: { userId: true, role: true },
    });
    const owner =
      (userMembers ?? []).find((m: any) => m.role === 'owner') ??
      (userMembers ?? [])[0];
    if (!owner) {
      throw new BadRequestException({
        code: TASK_ERRORS.TASK_EMPTY_TEAM,
        message: '团队无用户成员，无法归属任务创建者',
      });
    }
    return this.createTaskInternal(dto, teamId, {
      createdBy: owner.userId,
      actorType: ACTOR_TYPE.agent,
      actorId: callerInstanceId,
    });
  }

  /** create 与 createByAgent 共用前置：标题非空 + teamId 必填（与原 create 语义一致）。 */
  private requireCreateTeam(dto: CreateTaskDto): string {
    if (!dto.title || dto.title.trim().length === 0) {
      throw new BadRequestException('任务标题不能为空');
    }
    const teamIdRaw = (dto as any).teamId;
    if (
      !teamIdRaw ||
      typeof teamIdRaw !== 'string' ||
      teamIdRaw.trim().length === 0
    ) {
      throw new BadRequestException({
        code: TASK_ERRORS.TEAM_REQUIRED,
        message: 'teamId 必填，请选择团队',
      });
    }
    return teamIdRaw.trim();
  }

  /**
   * 建任务事务体（create 用户路径与 createByAgent agent 路径共用）。
   * opts.createdBy 落 task.createdBy（FK 指向 users 的真实用户）；
   * opts.actorId 落 taskEvent.actorId 与广播 actorId（缺省 = createdBy；agent 路径传实例 id），
   * opts.actorType 区分 user 与 agent。
   */
  private async createTaskInternal(
    dto: CreateTaskDto,
    teamId: string,
    opts: { createdBy: string; actorType: string; actorId?: string },
  ) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const taskId = await this.idGen.nextId(ID_PREFIX.task);
      let createdStatus: string = TASK_STATUS.pending;
      let queuePosition: number | null = null;
      let createdTask: any = null;
      try {
        createdTask = await this.prisma.$transaction(async (tx: any) => {
          // 行锁：SELECT team FOR UPDATE（双保险之一）
          let team: any = null;
          try {
            const rows: any[] = await tx.$queryRawUnsafe(
              'SELECT id, version, current_task_id as currentTaskId, reuse_session as reuseSession, main_agent_member_id as mainAgentMemberId FROM teams WHERE id = ? FOR UPDATE',
              teamId,
            );
            if (rows && rows.length > 0) {
              const r = rows[0];
              const full = await tx.team.findUnique({ where: { id: teamId } });
              team = full
                ? {
                    ...full,
                    version: r.version,
                    currentTaskId: r.currentTaskId,
                    reuseSession: !!r.reuseSession,
                    mainAgentMemberId:
                      r.mainAgentMemberId ??
                      (full as any).mainAgentMemberId ??
                      null,
                  }
                : {
                    id: r.id,
                    version: r.version,
                    currentTaskId: r.currentTaskId,
                    reuseSession: !!r.reuseSession,
                    mainAgentMemberId: r.mainAgentMemberId ?? null,
                  };
            } else {
              team = await tx.team.findUnique({ where: { id: teamId } });
            }
          } catch {
            team = await tx.team.findUnique({ where: { id: teamId } });
          }
          if (!team) {
            throw new NotFoundException({
              code: TASK_ERRORS.TEAM_NOT_FOUND,
              message: `团队 ${teamId} 不存在`,
            });
          }

          // 队首活跃判定：currentTaskId 非空即忙（queued/in_progress/pending 都算忙，避免两人同时抢队首）
          const isIdle = !team.currentTaskId;

          // 行锁：SELECT MAX(position) FOR UPDATE（FIFO 位置双保险）
          let maxPos = 0;
          if (!isIdle) {
            try {
              const qRows: any[] = await tx.$queryRawUnsafe(
                'SELECT MAX(position) as maxPos FROM team_queues WHERE team_id = ? FOR UPDATE',
                teamId,
              );
              const v = qRows?.[0]?.maxPos;
              maxPos = typeof v === 'number' ? v : v != null ? Number(v) : 0;
              if (!Number.isFinite(maxPos)) maxPos = 0;
            } catch {
              try {
                const agg = await tx.teamQueue.aggregate({
                  _max: { position: true },
                  where: { teamId },
                });
                maxPos = agg._max.position ?? 0;
              } catch {
                maxPos = 0;
              }
            }
          }

          const status = isIdle ? TASK_STATUS.pending : TASK_STATUS.queued;
          createdStatus = status;
          queuePosition = isIdle ? null : maxPos + 1;

          const members: any[] = await tx.teamMember.findMany({
            where: { teamId },
            include: {
              agent: { select: { id: true, name: true, role: true } },
            },
          });
          if (!members || members.length === 0) {
            throw new BadRequestException({
              code: TASK_ERRORS.TASK_EMPTY_TEAM,
              message: '团队成员为空，无法创建任务',
            });
          }

          const created = await tx.task.create({
            data: {
              id: taskId,
              title: dto.title.trim(),
              description: dto.description?.trim() || null,
              priority: dto.priority ?? TASK_PRIORITY.medium,
              status,
              teamId,
              mainAgentId: null,
              mainAgentInstanceId: null,
              executionMode: dto.executionMode ?? EXECUTION_MODES.direct,
              backgroundDocs: (dto.backgroundDocs ??
                []) as Prisma.InputJsonValue,
              resetAfterComplete: (dto as any).resetAfterComplete ?? false,
              createdBy: opts.createdBy,
              version: 0,
            },
          });

          try {
            const txChat: any = (tx as any).chatChannel;
            if (txChat?.findFirst) {
              const existing: any = await txChat
                .findFirst({
                  where: {
                    teamId,
                    type: CHANNEL_TYPE.team_group,
                    deletedAt: null,
                  },
                })
                .catch(() => null);
              if (!existing) {
                const legacy: any = await txChat
                  .findFirst({ where: { teamId } })
                  .catch(() => null);
                if (!legacy) {
                  try {
                    await txChat.create({
                      data: {
                        id: await this.idGen.nextId(ID_PREFIX.channel),
                        type: CHANNEL_TYPE.team_group,
                        teamId,
                        taskId: null,
                      },
                    });
                  } catch {}
                } else if (legacy.type === CHANNEL_TYPE.task_group) {
                  try {
                    await txChat.update({
                      where: { id: legacy.id },
                      data: {
                        teamId,
                        type: CHANNEL_TYPE.team_group,
                        taskId: null,
                      },
                    });
                  } catch {}
                }
              }
            }
          } catch {}

          // FIFO + 版本双保险
          if (isIdle) {
            const upd: any = await tx.team.updateMany({
              where: { id: teamId, version: team.version },
              data: { currentTaskId: taskId, version: { increment: 1 } },
            });
            if (upd.count === 0) {
              throw new ConflictException({
                code: 'VERSION_CONFLICT',
                message: '团队并发冲突，请重试',
              });
            }
          } else {
            await tx.teamQueue.create({
              data: {
                id: await this.idGen.nextId(ID_PREFIX.teamQueue),
                teamId,
                taskId,
                position: queuePosition!,
              },
            });
            const upd: any = await tx.team.updateMany({
              where: { id: teamId, version: team.version },
              data: { version: { increment: 1 } },
            });
            if (upd.count === 0) {
              throw new ConflictException({
                code: 'VERSION_CONFLICT',
                message: '团队并发冲突，请重试',
              });
            }
          }

          await tx.taskEvent.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.taskEvent),
              taskId,
              eventType: 'status_change',
              fromStatus: null,
              toStatus: status,
              actorType: opts.actorType,
              actorId: opts.actorId ?? opts.createdBy,
            },
          });

          return created;
        });

        await this.realtime.broadcast(
          EVENT_TYPES.TASK_STATUS_CHANGED,
          {
            taskId,
            from: null,
            to: createdStatus,
            actorType: opts.actorType,
            actorId: opts.actorId ?? opts.createdBy,
          },
          { type: 'global' },
        );
        await this.realtime.broadcast(
          EVENT_TYPES.TEAM_QUEUE_CHANGED,
          {
            teamId,
            taskId,
            status: createdStatus,
            position: queuePosition,
          },
          { type: 'team', id: teamId },
        );

        const fresh = await this.prisma.task.findUnique({
          where: { id: taskId },
        });
        return this.toTaskDto(fresh ?? createdTask);
      } catch (e: any) {
        const code = (e?.getResponse?.() as any)?.code;
        const isVersionConflict =
          e instanceof ConflictException && code === 'VERSION_CONFLICT';
        if (isVersionConflict && attempt < 2) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    throw lastError ?? new ConflictException('创建任务并发冲突，请重试');
  }

  /**
   * 事务内拉起队首（FOR UPDATE 双保险）：
   * SELECT team FOR UPDATE → 队首 queued→pending → TeamQueue 删除队首并重排剩余 position → currentTaskId 指向队首或 null → 广播 TEAM_QUEUE_CHANGED。
   * 由 accept/archive/reject 的 afterCommit 在同一事务内调用，亦可独立调用（独立事务兜底）。
   */
  private async promoteNextInTx(tx: any, teamId: string): Promise<void> {
    let team: any = null;
    try {
      const rows: any[] = await tx.$queryRawUnsafe(
        'SELECT id, version FROM teams WHERE id = ? FOR UPDATE',
        teamId,
      );
      team = rows?.[0]
        ? await tx.team.findUnique({ where: { id: teamId } })
        : await tx.team.findUnique({ where: { id: teamId } });
      if (team && rows?.[0]) team.version = rows[0].version;
    } catch {
      team = await tx.team.findUnique({ where: { id: teamId } });
    }
    if (!team) return;
    let next: any = null;
    try {
      const qRows: any[] = await tx.$queryRawUnsafe(
        'SELECT task_id as taskId, position FROM team_queues WHERE team_id = ? ORDER BY position ASC LIMIT 1 FOR UPDATE',
        teamId,
      );
      if (qRows?.[0]?.taskId) next = { taskId: qRows[0].taskId };
      else
        next = await tx.teamQueue.findFirst({
          where: { teamId },
          orderBy: { position: 'asc' },
        });
    } catch {
      next = await tx.teamQueue.findFirst({
        where: { teamId },
        orderBy: { position: 'asc' },
      });
    }
    if (next) {
      await tx.team.updateMany({
        where: { id: teamId, version: team.version },
        data: { currentTaskId: next.taskId, version: { increment: 1 } },
      });
      await tx.task.updateMany({
        where: { id: next.taskId, status: TASK_STATUS.queued },
        data: { status: TASK_STATUS.pending },
      });
      await tx.teamQueue.deleteMany({ where: { taskId: next.taskId } });
      // 重排剩余队列 position 连续化（删除队首后剩余按原 position 升序重编号 1..N）
      try {
        const remaining: any[] = await tx.teamQueue.findMany({
          where: { teamId },
          orderBy: { position: 'asc' },
        });
        for (let i = 0; i < remaining.length; i++) {
          const expected = i + 1;
          if (remaining[i].position !== expected) {
            await tx.teamQueue.update({
              where: { id: remaining[i].id },
              data: { position: expected },
            });
          }
        }
      } catch {
        // sqlite fallback 无碍，position 仍可用 MAX+1 保持 FIFO
      }
      await this.realtime.broadcast(
        EVENT_TYPES.TEAM_QUEUE_CHANGED,
        { teamId, taskId: next.taskId, status: 'promoted', action: 'promote' },
        { type: 'team', id: teamId } as any,
      );
    } else {
      await tx.team.updateMany({
        where: { id: teamId, version: team.version },
        data: { currentTaskId: null, version: { increment: 1 } },
      });
      await this.realtime.broadcast(
        EVENT_TYPES.TEAM_QUEUE_CHANGED,
        { teamId, action: 'idle' },
        { type: 'team', id: teamId } as any,
      );
    }
  }

  /**
   * 拉起队首（独立事务入口，供外部直接调用；事务内复用 promoteNextInTx）。
   */
  async promoteNext(teamId: string): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      await this.promoteNextInTx(tx, teamId);
    });
  }

  /** 看板列表：团队作用域（teamId 可选）+ 五态/优先级筛选 + 分页（page 默认 1、pageSize 默认 20 上限 100），created_at desc。 */
  async findAll(query: QueryTasksDto & { teamId?: string }) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: Prisma.TaskWhereInput = {
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const items = await Promise.all(rows.map((row) => this.toTaskDto(row)));
    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  /** 任务详情（含 teamAgentIds、instances、backgroundDocs）。 */
  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    return this.toTaskDto(task);
  }

  /** 编辑任务：mainAgentInstanceId 须为团队内实例；mainAgentId 兼容映射到该 agent 第一个实例（FR-08）。 */
  async update(id: string, dto: UpdateTaskDto) {
    const task = await this.prisma.task.findUnique({
      where: { id },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (dto.title !== undefined) {
      data.title = dto.title.trim();
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.priority !== undefined) {
      data.priority = dto.priority;
    }
    if (dto.backgroundDocs !== undefined) {
      data.backgroundDocs = dto.backgroundDocs as Prisma.InputJsonValue;
    }
    if ((dto as any).resetAfterComplete !== undefined) {
      data.resetAfterComplete = (dto as any).resetAfterComplete;
    }
    // 主实例校验口径团队化：实例唯一来源为任务归属团队的团队成员（tmm_）。
    const teamIdOf = (task as any).teamId ?? null;
    const memberRows: Array<{ id: string; agentId: string }> = teamIdOf
      ? await (this.prisma as any).teamMember.findMany({
          where: { teamId: teamIdOf },
          select: { id: true, agentId: true },
        })
      : [];
    const instances = memberRows ?? [];
    if (dto.mainAgentInstanceId !== undefined) {
      // 主实例：须为团队内实例，同步 mainAgentId 为其 agent（渲染兜底）
      if (dto.mainAgentInstanceId !== null) {
        const inst = instances.find((i) => i.id === dto.mainAgentInstanceId);
        if (!inst) {
          throw new BadRequestException({
            code: TASK_ERRORS.MAIN_AGENT_NOT_IN_TEAM,
            message: '主 Agent 必须是团队内实例',
          });
        }
        data.mainAgentInstanceId = inst.id;
        data.mainAgentId = inst.agentId;
      } else {
        data.mainAgentInstanceId = null;
        data.mainAgentId = null;
      }
    } else if (dto.mainAgentId !== undefined) {
      // 兼容路径：mainAgentId 映射到该 agent 第一个实例
      if (dto.mainAgentId !== null) {
        const inst = instances.find((i) => i.agentId === dto.mainAgentId);
        if (!inst) {
          throw new BadRequestException({
            code: TASK_ERRORS.MAIN_AGENT_NOT_IN_TEAM,
            message: '主 Agent 必须是团队内已选 Agent',
          });
        }
        data.mainAgentId = inst.agentId;
        data.mainAgentInstanceId = inst.id;
      } else {
        data.mainAgentId = null;
        data.mainAgentInstanceId = null;
      }
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data,
    });
    return this.toTaskDto(updated);
  }

  /**
   * 切换任务执行模式（tc-flow）：
   * - 双向切换均即时生效（direct ↔ plan 无前置校验）——切换 = 用户意图声明/提示
   *   （对齐 omo keyword-detector 哲学：说 ultrawork 立即生效，零前置校验）；
   * - 计划门不放在切换点：start.preflight（plan 模式须 approved 计划 = approval gate）
   *   与 mark-pending-review.preflight（计划任务全完成 = 验收门）各自把关；
   * - 任务已 in_progress 时切到 plan：若计划存在且已批准/执行中（approved/executing）
   *   → 事务内顺带计划置 executing（执行态与计划态一致）；计划不存在或其他状态 → 仅切
   *   executionMode，不碰计划。
   * 执行模式与团队托管模式（team.managedMode）独立生效、互不干扰。
   */
  async updateExecutionMode(id: string, mode: string) {
    if (mode !== EXECUTION_MODES.direct && mode !== EXECUTION_MODES.plan) {
      throw new BadRequestException(`非法执行模式：${mode}`);
    }
    const task = await this.prisma.task.findUnique({
      where: { id },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (task.executionMode === mode) {
      return this.toTaskDto(task);
    }
    if (
      mode === EXECUTION_MODES.plan &&
      task.status === TASK_STATUS.in_progress
    ) {
      const plan = await this.prisma.plan.findUnique({
        where: { taskId: id },
        select: { status: true },
      });
      // in_progress 切 plan：计划已批准（approved）或正在执行（executing——曾批准且已启动，
      // 回切无需重新评审）→ 顺带置 executing，消除「plan→direct→plan」切换死锁；
      // 计划不存在/其他状态（reviewing/completed 等）→ 仅切模式，由 start 门把关。
      if (
        plan &&
        (plan.status === PLAN_STATUS.approved ||
          plan.status === PLAN_STATUS.executing)
      ) {
        const updated = await this.prisma.$transaction(async (tx) => {
          await tx.plan.update({
            where: { taskId: id },
            data: { status: PLAN_STATUS.executing },
          });
          return tx.task.update({
            where: { id },
            data: { executionMode: mode },
          });
        });
        return this.toTaskDto(updated);
      }
    }
    const updated = await this.prisma.task.update({
      where: { id },
      data: { executionMode: mode },
    });
    return this.toTaskDto(updated);
  }

  /**
   * 团队调整（14 篇 §5.3，FR-02；session-unification 后实例唯一来源为任务归属团队的团队成员）：
   * `{addInstances[], removeInstanceIds[]}` 直接作用于任务归属团队的 team_members 行。
   *
   * 时间窗：仅 pending/in_progress 合法（与 13 篇 §7.4 联动），否则 409。
   * addInstances：每个实例写 team_members（seq = 该 teamId+agentId 已用最大 seq+1，事务内防并发重号）；
   *              同 agent 可加多实例。
   * removeInstanceIds：按成员 id 删除 team_members 行 + 冻结该成员 session（status=frozen）；
   *                    主成员被移除时清空 team.mainAgentMemberId（任务侧主标量同步置空）。
   *                    产出物保留（本版不动 artifacts）。
   * 群聊联动：团队群频道写 system 消息（10 篇 §8.3 文案）+ 广播 chat.message.new（T9 模式）。
   * 审计：team 变更写 task_event（team_add/team_remove，actorType/actorId=userId 或 opts 确认方）。
   * 广播 team.changed 按实例：{taskId, action: add|remove, instanceId, agentId, alias}，
   * scope={type:'task', id}（09 篇 §4.2）。
   */
  async updateTeam(
    id: string,
    dto: UpdateTeamDto,
    userId?: string,
    opts?: {
      /** 审计 actorType/actorId（MCP 确认门传 agent/主实例；缺省回退 user/userId）。 */
      actorType?: string;
      actorId?: string;
      /** 确认方名称：系统消息标注「经主 Agent 申请、<confirmedBy> 确认」。 */
      confirmedBy?: string;
    },
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (
      task.status !== TASK_STATUS.pending &&
      task.status !== TASK_STATUS.in_progress
    ) {
      throw new ConflictException({
        code: TASK_ERRORS.TASK_TEAM_NOT_ALLOWED,
        message: '任务待验收/已完成/已归档后不允许调整团队',
        details: { current: task.status },
      });
    }
    const teamId = (task as any).teamId ?? null;
    if (!teamId) {
      throw new BadRequestException({
        code: TASK_ERRORS.TEAM_REQUIRED,
        message: '任务无归属团队，无法调整团队',
      });
    }
    const members: any[] =
      (await (this.prisma as any).teamMember.findMany({
        where: { teamId },
        include: { agent: { select: { id: true, name: true, role: true } } },
      })) ?? [];

    const addInstances = dto.addInstances ?? [];
    const removeInstanceIds = [...new Set(dto.removeInstanceIds ?? [])];
    const teamMap = new Map(members.map((m: any) => [m.id, m]));
    const toRemove = removeInstanceIds.filter((instanceId) =>
      teamMap.has(instanceId),
    );

    if (addInstances.length === 0 && toRemove.length === 0) {
      return this.toTaskDto(task);
    }

    const team = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { mainAgentMemberId: true },
    });
    const channel =
      (await this.prisma.chatChannel.findFirst({
        where: { taskId: id, type: CHANNEL_TYPE.task_group },
        select: { id: true },
      })) ??
      (await this.prisma.chatChannel.findFirst({
        where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
        select: { id: true },
      }));

    const { sysMessages, created } = await this.prisma.$transaction(
      async (tx) => {
        const created = await this.createTeamMembers(tx, teamId, addInstances);
        const removed: any[] = [];
        for (const instanceId of toRemove) {
          removed.push(teamMap.get(instanceId)!);
          await tx.teamMember.delete({ where: { id: instanceId } });
          await tx.session.updateMany({
            where: { teamMemberId: instanceId },
            data: { status: SESSION_STATUS.frozen },
          });
        }
        if (
          (team as any)?.mainAgentMemberId &&
          toRemove.includes((team as any).mainAgentMemberId)
        ) {
          await tx.team.update({
            where: { id: teamId },
            data: { mainAgentMemberId: null },
          });
          await tx.task.update({
            where: { id },
            data: { mainAgentId: null, mainAgentInstanceId: null },
          });
        }
        const messages: SysMessageRow[] = [];
        const confirmedSuffix = opts?.confirmedBy
          ? `（经主 Agent 申请、${opts.confirmedBy} 确认）`
          : '';
        for (const inst of created) {
          if (!channel) continue;
          messages.push(
            await tx.message.create({
              data: {
                id: await this.idGen.nextId(ID_PREFIX.message),
                channelId: channel.id,
                senderType: SENDER_TYPE.system,
                senderId: null,
                content: {
                  text: `${inst.alias ?? inst.agentId} 已加入团队${confirmedSuffix}`,
                  parts: [],
                } as Prisma.InputJsonValue,
                mentions: null,
                status: MESSAGE_STATUS.sent,
              },
            }),
          );
        }
        for (const instanceId of toRemove) {
          const inst = teamMap.get(instanceId)!;
          if (!channel) continue;
          messages.push(
            await tx.message.create({
              data: {
                id: await this.idGen.nextId(ID_PREFIX.message),
                channelId: channel.id,
                senderType: SENDER_TYPE.system,
                senderId: null,
                content: {
                  text: `${inst.alias ?? inst.agentId} 已移出团队，其会话已冻结`,
                  parts: [],
                } as Prisma.InputJsonValue,
                mentions: null,
                status: MESSAGE_STATUS.sent,
              },
            }),
          );
        }
        // 审计：team 变更写 task_event（actor=userId 或确认门 opts 确认方）
        const actorType = opts?.actorType ?? ACTOR_TYPE.user;
        const actorId = opts?.actorId ?? userId;
        if (created.length > 0) {
          await tx.taskEvent.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.taskEvent),
              taskId: id,
              eventType: 'team_add',
              fromStatus: null,
              toStatus: null,
              actorType,
              actorId,
              metadata: {
                agentIds: created.map((c) => c.agentId),
                confirmedBy: opts?.confirmedBy ?? null,
              } as Prisma.InputJsonValue,
            },
          });
        }
        if (toRemove.length > 0) {
          await tx.taskEvent.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.taskEvent),
              taskId: id,
              eventType: 'team_remove',
              fromStatus: null,
              toStatus: null,
              actorType,
              actorId,
              metadata: { instanceIds: toRemove } as Prisma.InputJsonValue,
            },
          });
        }
        return { sysMessages: messages, created };
      },
    );

    for (const inst of created) {
      await this.realtime.broadcast(
        EVENT_TYPES.TEAM_CHANGED,
        {
          taskId: id,
          action: 'add',
          instanceId: inst.id,
          agentId: inst.agentId,
          alias: inst.alias,
        },
        { type: 'task', id },
      );
    }
    for (const instanceId of toRemove) {
      const inst = teamMap.get(instanceId)!;
      await this.realtime.broadcast(
        EVENT_TYPES.TEAM_CHANGED,
        {
          taskId: id,
          action: 'remove',
          instanceId: inst.id,
          agentId: inst.agentId,
          alias: inst.alias,
        },
        { type: 'task', id },
      );
    }
    if (channel) {
      for (const msg of sysMessages) {
        await this.realtime.broadcast(
          EVENT_TYPES.CHAT_MESSAGE_NEW,
          { message: this.toSystemMessageDto(msg) },
          { type: 'channel', id: channel.id },
        );
      }
    }

    const fresh = await this.prisma.task.findUnique({
      where: { id },
    });
    return this.toTaskDto(fresh ?? task);
  }

  /**
   * 实例更新（session-unification 后为兼容入口：团队成员行无 enabled/overrideModelId 列，
   * 仅校验实例归属任务团队后回传任务 DTO；分派期模型覆盖经 taskContext 透传）。
   */
  async updateInstance(
    taskId: string,
    instanceId: string,
    _dto: { enabled?: boolean; overrideModelId?: string | null },
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const teamId = (task as any).teamId ?? null;
    const member = teamId
      ? await (this.prisma as any).teamMember.findUnique({
          where: { id: instanceId },
        })
      : null;
    if (!member || member.teamId !== teamId) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '实例不存在',
      });
    }
    return this.toTaskDto(task);
  }

  /**
   * 各动作的迁移副作用配置（自原 5 个动作方法提取，行为不变）：
   * start/mark-pending-review/accept/reject/archive 的用户路径与 MCP 路径（transitionByAgent）
   * 共用同一 opts；id/dto 依赖项（afterCommit 的 taskId、reject 的 reason）收参传入。
   */
  private transitionOpts(
    id: string,
    action: keyof typeof TASK_TRANSITIONS,
    reason?: string,
  ): TransitionOptions {
    switch (action) {
      case 'start': {
        let planStarted = false;
        return {
          eventType: 'status_change',
          fields: { startedAt: new Date() },
          preflight: async (task) => {
            const preTeamId = (task as any).teamId ?? null;
            let preMainMemberId: string | null = null;
            if (preTeamId) {
              const team = await this.prisma.team.findUnique({
                where: { id: preTeamId },
              } as any);
              if (team && (team as any).currentTaskId !== task.id) {
                throw new ConflictException({
                  code: TASK_ERRORS.TEAM_NOT_QUEUE_HEAD,
                  message: '仅队首任务可启动',
                });
              }
              preMainMemberId = (team as any)?.mainAgentMemberId ?? null;
              const memberCount = await (this.prisma as any).teamMember.count({
                where: { teamId: preTeamId },
              });
              if (!memberCount) {
                throw new BadRequestException({
                  code: TASK_ERRORS.TASK_EMPTY_TEAM,
                  message: '任务团队为空，请先添加 Agent 实例后再启动',
                });
              }
            } else {
              throw new BadRequestException({
                code: TASK_ERRORS.TASK_EMPTY_TEAM,
                message: '任务团队为空，请先添加 Agent 实例后再启动',
              });
            }
            if (!preMainMemberId) {
              throw new BadRequestException({
                code: TASK_ERRORS.MAIN_AGENT_NOT_SET,
                message: '请先指定主 Agent',
              });
            }
            if (task.executionMode === EXECUTION_MODES.plan) {
              const plan = await this.prisma.plan.findUnique({
                where: { taskId: task.id },
                select: { status: true },
              });
              if (!plan || plan.status !== PLAN_STATUS.approved) {
                throw new BadRequestException({
                  code: PLAN_ERRORS.PLAN_NOT_APPROVED,
                  message: '计划未通过评审，请先提交并评审通过',
                });
              }
              planStarted = true;
            }
          },
          // T4：启动时全部 created 会话置 active（active 全库唯一写入点；Phase 4 worker 分派依赖）
          afterCommit: async (tx) => {
            await tx.session.updateMany({
              where: { taskId: id, status: SESSION_STATUS.created },
              data: { status: SESSION_STATUS.active },
            });
            if (planStarted) {
              await tx.plan.update({
                where: { taskId: id },
                data: { status: PLAN_STATUS.executing },
              });
            }
          },
          // 10 篇 §8.1：群聊系统消息含主实例名（FR-07/08）
          sysMessage: ({ task, mainAgentName }) =>
            `任务已开始，主 Agent：${mainAgentName ?? task.mainAgentId ?? '未设置'}`,
          // 13 篇 §4.2：私信主实例的启动消息（含任务目标、团队分工、背景文档）
          privateMessage: ({ task }) => {
            const docs = Array.isArray(task.backgroundDocs)
              ? task.backgroundDocs
                  .map((d) =>
                    typeof d === 'object' && d !== null && 'name' in d
                      ? String((d as { name: unknown }).name)
                      : String(d),
                  )
                  .join('、')
              : '';
            const parts = [
              `任务已启动，请作为主 Agent 牵头推进`,
              `任务目标：${task.title}${task.description ? `（${task.description}）` : ''}`,
            ];
            if (docs) parts.push(`背景文档：${docs}`);
            return parts.join('。');
          },
        };
      }
      case 'mark-pending-review':
        return {
          eventType: 'status_change',
          fields: { pendingReviewAt: new Date() },
          preflight: async (task) => {
            if (task.executionMode !== EXECUTION_MODES.plan) {
              return;
            }
            const incomplete = await this.prisma.planTask.findFirst({
              where: {
                plan: { taskId: task.id },
                status: {
                  in: [PLAN_TASK_STATUS.pending, PLAN_TASK_STATUS.in_progress],
                },
              },
              select: { id: true },
            });
            if (incomplete) {
              throw new ConflictException({
                code: PLAN_ERRORS.PLAN_TASKS_INCOMPLETE,
                message:
                  '执行计划仍有子任务未完成，请先完成全部计划子任务后再提交验收',
              });
            }
          },
          sysMessage: () => '任务已提交待验收',
          privateMessage: () =>
            '任务已提交待验收。作为主 Agent，请牵头收集本任务各 Agent 在执行过程中遇到的问题、解决办法及用户提示，整理后调用 vteam MCP 的 memory_save 工具沉淀为记忆：先用 memory_search 回顾已有记忆避免重复，再按问题/解决/用户提示分类保存（level: "task" 写本任务沉淀，level: "project" 写跨任务复用价值，level: "global" 仅平台通用知识，tags 标注问题类型如 bugfix/workflow/prompt）。如暂无可沉淀内容可跳过，不影响验收流程。',
        };
      case 'accept': {
        let planCompletable = false;
        let acceptTeamId: string | null = null;
        return {
          eventType: 'accept',
          fields: { completedAt: new Date() },
          preflight: async (task) => {
            acceptTeamId = (task as any).teamId ?? null;
            if (task.executionMode === EXECUTION_MODES.plan) {
              const plan = await this.prisma.plan.findUnique({
                where: { taskId: task.id },
                select: { id: true },
              });
              planCompletable = Boolean(plan);
            }
          },
          afterCommit: async (tx) => {
            const artifacts = await tx.artifact.findMany({
              where: { taskId: id },
              select: { id: true, currentVersion: true },
            });
            if (artifacts.length > 0) {
              await tx.artifactVersion.updateMany({
                where: {
                  OR: artifacts.map((a) => ({
                    artifactId: a.id,
                    version: a.currentVersion,
                  })),
                },
                data: { acceptedFlag: true },
              });
            }
            if (planCompletable) {
              await tx.plan.update({
                where: { taskId: id },
                data: { status: PLAN_STATUS.completed },
              });
            }
            if (acceptTeamId) await this.promoteNextInTx(tx, acceptTeamId);
          },
          // 10 篇 §8.1：强调 accepted_flag 基线锁定（FR-04）
          sysMessage: () => '任务已验收完成，产出物基线已锁定',
          privateMessage: () =>
            '任务已验收完成，产出物基线已锁定。记忆收集已自动触发（见触发消息），请按其要求只沉淀可复用经验（做法/坑/约束），不要保存会话总结。',
        };
      }
      case 'reject': {
        let rejectTeamId: string | null = null;
        return {
          eventType: 'reject',
          fields: { pendingReviewAt: null },
          metadata: reason ? { reason } : undefined,
          preflight: async (task) => {
            rejectTeamId = (task as any).teamId ?? null;
          },
          afterCommit: async (tx) => {
            if (rejectTeamId) await this.promoteNextInTx(tx, rejectTeamId);
          },
          sysMessage: () =>
            reason
              ? `任务被驳回，请补齐产出后重新提交。驳回原因：${reason}`
              : '任务被驳回，请补齐产出后重新提交',
        };
      }
      case 'archive': {
        let planCompletable = false;
        let archiveTeamId: string | null = null;
        return {
          eventType: 'archive',
          fields: { archivedAt: new Date() },
          preflight: async (task) => {
            archiveTeamId = (task as any).teamId ?? null;
            if (task.executionMode === EXECUTION_MODES.plan) {
              const plan = await this.prisma.plan.findUnique({
                where: { taskId: task.id },
                select: { id: true },
              });
              planCompletable = Boolean(plan);
            }
          },
          afterCommit: async (tx) => {
            await tx.session.updateMany({
              where: { taskId: id },
              data: { status: SESSION_STATUS.archived },
            });
            if (planCompletable) {
              await tx.plan.update({
                where: { taskId: id },
                data: { status: PLAN_STATUS.completed },
              });
            }
            if (archiveTeamId) await this.promoteNextInTx(tx, archiveTeamId);
          },
          // 10 篇 §8.1：明确内容保留（FR-05）；记忆管理（mem-trigger）补充提示：任务级记忆已随验收沉淀
          sysMessage: () =>
            '任务已归档，历史可回看。任务级记忆已随验收沉淀（未总结不影响归档）',
        };
      }
      default:
        throw new Error(`未知任务迁移动作：${action}`);
    }
  }

  /** 启动任务（pending → in_progress，13 篇 §4.2）：前置校验团队实例 + 主实例，写 startedAt。 */
  async start(id: string, userId: string) {
    return this.transition(
      id,
      'start',
      userId,
      this.transitionOpts(id, 'start'),
    );
  }

  /** 标记待验收（in_progress → pending_review，13 篇 §4.3）：写 pendingReviewAt。 */
  async markPendingReview(id: string, userId: string) {
    return this.transition(
      id,
      'mark-pending-review',
      userId,
      this.transitionOpts(id, 'mark-pending-review'),
    );
  }

  /**
   * 验收通过（pending_review → completed，13 篇 §4.4）：写 completedAt（验收基线属 Phase 3）。
   * 12 篇 §7 验收联动：同事务锁定该任务全部产出物当前版本基线（accepted_flag=true）。
   */
  async accept(id: string, userId: string) {
    return this.transition(
      id,
      'accept',
      userId,
      this.transitionOpts(id, 'accept'),
    );
  }

  /** 验收驳回（pending_review → in_progress，13 篇 §4.4）：reason 写 metadata，重置 pendingReviewAt。 */
  async reject(id: string, userId: string, dto?: RejectTaskDto) {
    return this.transition(
      id,
      'reject',
      userId,
      this.transitionOpts(id, 'reject', dto?.reason),
    );
  }

  /** 归档（completed → archived，终态，13 篇 §4.5）：写 archivedAt，sessions 全部置 archived。 */
  async archive(id: string, userId: string) {
    return this.transition(
      id,
      'archive',
      userId,
      this.transitionOpts(id, 'archive'),
    );
  }

  /**
   * MCP 专用状态流转（task_transition 工具）：仅主 Agent 实例可调用。
   * 主成员校验：team.mainAgentMemberId === instanceId，否则 403 TASK_STATUS_MAIN_AGENT_ONLY；
   * actor 记为 agent/instanceId（task_events.actorType='agent' + TASK_STATUS_CHANGED 广播）；
   * reject 的 reason 经 metadata 透传（transitionOpts 第 3 参）。
   */
  async transitionByAgent(
    taskId: string,
    instanceId: string,
    action: keyof typeof TASK_TRANSITIONS,
    dto?: { reason?: string },
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, teamId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const gateTeamId = (task as any).teamId ?? null;
    const gateTeam = gateTeamId
      ? await (this.prisma as any).team.findUnique({
          where: { id: gateTeamId },
          select: { mainAgentMemberId: true },
        })
      : null;
    const mainMemberId = (gateTeam as any)?.mainAgentMemberId ?? null;
    if (!mainMemberId || mainMemberId !== instanceId) {
      // Agent 可读的完整引导：指明主成员 id + 正确操作路径（MCP 由主成员调用 / 知会主成员 / 管理界面人工操作）
      throw new ForbiddenException({
        code: TASK_ERRORS.TASK_STATUS_MAIN_AGENT_ONLY,
        message: `仅主 Agent（${mainMemberId ?? '未设置'}）可流转任务状态；请知会主 Agent 调用 task_transition，或由管理员在任务管理界面操作`,
      });
    }
    return this.transition(taskId, action, instanceId, {
      ...this.transitionOpts(taskId, action, dto?.reason),
      actor: { type: ACTOR_TYPE.agent, id: instanceId },
    });
  }

  /**
   * T12（Todo10 团队化）：查询成员的全部 opencode 会话实例（TaskGroupInstance，供任务页展示/调度复用）。
   * 委托 SessionLifecycleService（WorkersModule 域，团队键查询）。
   */
  async getInstancesByTeamMember(teamId: string, teamMemberId: string) {
    return this.sessionLifecycle.getInstancesByTeamMember(teamId, teamMemberId);
  }

  /**
   * T12：查询会话绑定的 opencode 实例（供二次 @ 判断是否复用同一 opencode 会话）。
   * 会话未绑定 worker/instanceRef（created 态）或实例已移除 → null。
   */
  async getInstanceBySession(sessionId: string) {
    return this.sessionLifecycle.getInstanceBySession(sessionId);
  }

  /**
   * 五态迁移统一入口（13 篇 §8.1/§8.2）：
   * 迁移表驱动 → 前置状态校验（非前置 409）→ CAS 乐观锁 + task_events 同事务 → 事务后广播。
   * 幂等：已处目标态 200 不写事件不广播（09 篇 §2.1）；并发 CAS 影响 0 行重读判定。
   */
  private async transition(
    id: string,
    action: keyof typeof TASK_TRANSITIONS,
    userId: string,
    opts: TransitionOptions,
  ) {
    const { from, to } = TASK_TRANSITIONS[action];
    // 动作执行者：缺省 user/调用者（用户路径行为不变）；MCP 路径由 transitionByAgent 传 agent/实例。
    const actor = opts.actor ?? { type: ACTOR_TYPE.user, id: userId };

    const task = await this.prisma.task.findUnique({
      where: { id },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (task.status === to) {
      return this.toTaskDto(task);
    }
    if (action === 'start' && (task as any).teamId) {
      const teamHead = await (this.prisma as any).team.findUnique({
        where: { id: (task as any).teamId },
      });
      if (teamHead && teamHead.currentTaskId !== id) {
        // 空闲认领：团队无当前任务且本任务为 pending（取消排队后的孤儿 pending）→ 直接认领队首后启动，
        // 否则一旦 currentTaskId 为空将没有任何任务可启动（死锁）。忙碌中非队首仍 409。
        if (!teamHead.currentTaskId && task.status === TASK_STATUS.pending) {
          const claimed = await (this.prisma as any).team.updateMany({
            where: {
              id: (task as any).teamId,
              currentTaskId: null,
              version: teamHead.version,
            },
            data: { currentTaskId: id, version: { increment: 1 } },
          });
          if (claimed.count === 0) {
            throw new ConflictException({
              code: 'VERSION_CONFLICT',
              message: '团队并发冲突，请重试',
            });
          }
          try {
            await this.realtime.broadcast(
              EVENT_TYPES.TEAM_QUEUE_CHANGED,
              {
                teamId: (task as any).teamId,
                taskId: id,
                status: 'claimed',
                action: 'claim',
              },
              { type: 'team', id: (task as any).teamId } as any,
            );
          } catch {}
        } else {
          throw new ConflictException({
            code: TASK_ERRORS.TEAM_NOT_QUEUE_HEAD,
            message: '仅队首任务可启动',
          });
        }
      }
      if (task.status === TASK_STATUS.queued) {
        throw new ConflictException({
          code: TASK_ERRORS.TEAM_NOT_QUEUE_HEAD,
          message: '仅队首任务可启动',
        });
      }
    }
    if (task.status !== from) {
      throw new ConflictException({
        code: TASK_ERRORS.TASK_INVALID_TRANSITION,
        message: '任务状态迁移不合法',
        details: { from, to, current: task.status },
      });
    }
    await opts.preflight?.(task);

    // 系统消息落库目标：任务群聊频道（task_group，10 篇 §8.1；T8 updateTeam 同模式）
    const channel = await this.prisma.chatChannel.findFirst({
      where: { taskId: id, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });
    // start/accept 私信主成员（13 篇 §4.2；记忆管理 mem-trigger：accept 同路径私信引导记忆总结）：
    // 解析主成员别名 + private 频道（按 teamMemberId；无团队主成员则跳过）
    let mainAgentName: string | undefined;
    let privateChannel: { id: string } | null = null;
    {
      const privTeamId = (task as any).teamId ?? null;
      const privTeam = privTeamId
        ? await (this.prisma as any).team.findUnique({
            where: { id: privTeamId },
            select: { mainAgentMemberId: true },
          })
        : null;
      const privMainId = (privTeam as any)?.mainAgentMemberId ?? null;
      if (
        (action === 'start' ||
          action === 'accept' ||
          action === 'mark-pending-review') &&
        privMainId &&
        privTeamId
      ) {
        const mainMember = await (this.prisma as any).teamMember.findUnique({
          where: { id: privMainId },
          include: { agent: { select: { id: true, name: true, role: true } } },
        });
        mainAgentName =
          (mainMember as any)?.alias ??
          (mainMember as any)?.agent?.name ??
          undefined;
        privateChannel = await this.prisma.chatChannel.findFirst({
          where: {
            teamId: privTeamId,
            teamMemberId: privMainId,
            type: CHANNEL_TYPE.private,
          },
          select: { id: true },
        });
      }
    }
    const sysCtx: SysMessageCtx = { task, mainAgentName };
    const groupText = opts.sysMessage?.(sysCtx);
    const privateText = opts.privateMessage?.(sysCtx);

    const sysMessages: SysMessageRow[] = [];
    const casFailed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.updateMany({
        where: { id, status: from, version: task.version },
        data: { status: to, version: { increment: 1 }, ...opts.fields },
      });
      if (updated.count === 0) {
        return true;
      }
      await tx.taskEvent.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.taskEvent),
          taskId: id,
          eventType: opts.eventType,
          fromStatus: from,
          toStatus: to,
          actorType: actor.type,
          actorId: actor.id,
          metadata: opts.metadata,
        },
      });
      await opts.afterCommit?.(tx);
      // 群聊系统消息（senderType=system；与 updateTeam 相同的 tx.message.create 模式）
      if (channel && groupText) {
        sysMessages.push(
          await tx.message.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.message),
              channelId: channel.id,
              senderType: SENDER_TYPE.system,
              senderId: null,
              content: { text: groupText, parts: [] } as Prisma.InputJsonValue,
              mentions: null,
              status: MESSAGE_STATUS.sent,
            },
          }),
        );
      }
      // start/accept 私信主 Agent：写入主 Agent 的 private 频道（存在才发）
      if (privateChannel && privateText) {
        sysMessages.push(
          await tx.message.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.message),
              channelId: privateChannel.id,
              senderType: SENDER_TYPE.system,
              senderId: null,
              content: {
                text: privateText,
                parts: [],
              } as Prisma.InputJsonValue,
              mentions: null,
              status: MESSAGE_STATUS.sent,
            },
          }),
        );
      }
      // Todo7 记忆开关：accept/archive 同事务内批量 reset（reuseSession=false 或 resetAfterComplete=true 时）
      // soft-remove TaskGroupInstance 先于 delete，且 Memory 表不动；分隔系统消息在同事务内写入
      if (
        (action === 'accept' || action === 'archive') &&
        (task as any).teamId
      ) {
        const teamIdForReset = (task as any).teamId as string;
        let needReset = false;
        try {
          const teamRow = await (tx as any).team.findUnique({
            where: { id: teamIdForReset },
            select: { reuseSession: true },
          });
          const taskReset = Boolean((task as any).resetAfterComplete);
          needReset = !!teamRow && (!teamRow.reuseSession || taskReset);
        } catch {}
        if (needReset) {
          await this.sessionLifecycle.resetTeamSessionsInTx(
            tx as unknown as Prisma.TransactionClient,
            teamIdForReset,
          );
          if (channel) {
            sysMessages.push(
              await tx.message.create({
                data: {
                  id: await this.idGen.nextId(ID_PREFIX.message),
                  channelId: channel.id,
                  senderType: SENDER_TYPE.system,
                  senderId: null,
                  content: {
                    text: '已为下一任务开新会话',
                    parts: [],
                  } as Prisma.InputJsonValue,
                  mentions: null,
                  status: MESSAGE_STATUS.sent,
                },
              }),
            );
          }
        }
      }
      return false;
    });

    if (casFailed) {
      const current = await this.prisma.task.findUnique({
        where: { id },
      });
      if (current?.status === to) {
        return this.toTaskDto(current);
      }
      throw new ConflictException({
        code: TASK_ERRORS.TASK_INVALID_TRANSITION,
        message: '任务状态迁移不合法（并发冲突）',
        details: { from, to, current: current?.status ?? null },
      });
    }

    await this.realtime.broadcast(
      EVENT_TYPES.TASK_STATUS_CHANGED,
      { taskId: id, from, to, actorType: actor.type, actorId: actor.id },
      { type: 'global' },
    );

    if (to === TASK_STATUS.in_progress) {
      await this.progression
        .register(id)
        .catch((err: unknown) =>
          this.logger.error(
            `巡检注册失败 taskId=${id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    } else if (from === TASK_STATUS.in_progress) {
      this.progression.unregister(id);
    }

    if (action === 'mark-pending-review' && (task as any).teamId) {
      void this.progression
        .triggerMemoryHarvest(id, task.title)
        .catch((err: unknown) =>
          this.logger.error(
            `记忆收集触发失败 taskId=${id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }

    // 系统消息事务后广播 chat.message.new（先落库后转发，与 updateTeam 一致）
    for (const msg of sysMessages) {
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: this.toSystemMessageDto(msg) },
        { type: 'channel', id: msg.channelId },
      );
    }

    const fresh = await this.prisma.task.findUnique({
      where: { id },
    });
    return this.toTaskDto(fresh ?? task);
  }

  /**
   * 任务 DTO（Todo11 团队化）：instances 自团队成员组装
   * [{id(tmm_), agentId, alias, seq, name, role, main}]，按 (agentId, seq) 稳定排序；
   * main = team.mainAgentMemberId；sessionStatus/sessionId 取团队会话行；
   * 无任务侧实例字段、无任务实例表读取。
   * mainAgentId/mainAgentInstanceId 标量保留（历史值由 Todo 6 迁移置空，列保留）。
   */
  private async toTaskDto(task: TaskRow) {
    const teamId = (task as any).teamId ?? null;
    let members: TeamMemberView[] = [];
    let mainMemberId: string | null = null;
    const sessionByMember = new Map<string, { id: string; status: string }>();
    if (teamId) {
      const team = await (this.prisma as any).team.findUnique({
        where: { id: teamId },
        select: { mainAgentMemberId: true },
      });
      mainMemberId = team?.mainAgentMemberId ?? null;
      members =
        ((await (this.prisma as any).teamMember.findMany({
          where: { teamId },
          include: {
            agent: { select: { id: true, name: true, role: true } },
          },
        })) as TeamMemberView[] | null) ?? [];
      if (members.length > 0) {
        const sessions = (await (this.prisma as any).session.findMany({
          where: {
            teamMemberId: { in: members.map((m) => m.id) },
            status: { not: SESSION_STATUS.archived },
          },
          select: { id: true, status: true, teamMemberId: true },
        })) as { id: string; status: string; teamMemberId: string }[] | null;
        for (const s of sessions ?? []) {
          if (s?.teamMemberId && !sessionByMember.has(s.teamMemberId)) {
            sessionByMember.set(s.teamMemberId, s);
          }
        }
      }
    }
    const instances = members
      .slice()
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.seq - b.seq)
      .map((m) => {
        const s = sessionByMember.get(m.id);
        return {
          id: m.id,
          agentId: m.agentId,
          alias: m.alias ?? this.defaultAlias(m.agent, m.seq),
          seq: m.seq,
          workDir: m.workDir ?? this.defaultAgentWorkDir(m.agent, m.seq),
          name: m.agent.name,
          role: m.agent.role,
          main: m.id === mainMemberId,
          enabled: true,
          overrideModelId: m.overrideModelId ?? null,
          sessionStatus: s?.status ?? null,
          sessionId: s?.id ?? null,
        };
      });
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      mainAgentId: task.mainAgentId,
      mainAgentInstanceId: task.mainAgentInstanceId ?? null,
      executionMode: task.executionMode ?? EXECUTION_MODES.direct,
      backgroundDocs: task.backgroundDocs ?? [],
      teamId: (task as any).teamId ?? null,
      teamAgentIds: members.map((m) => m.agentId),
      instances,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      pendingReviewAt: task.pendingReviewAt,
      completedAt: task.completedAt,
      archivedAt: task.archivedAt,
    };
  }

  /** 实例默认别名：`<角色中文名>-<seq>`；未知角色用 agent.name（FR-08 别名默认规则）。 */
  private defaultAlias(
    agent: { name: string; role: string | null },
    seq: number,
  ): string {
    const roleLabel = ROLE_LABELS[agent.role ?? ''] ?? agent.name;
    return `${roleLabel}-${seq}`;
  }

  /**
   * is_0000000010：实例默认持久化工作目录 `/data/vteam-worker/<sanitize(agent.name)>`（统一持久化）。
   * agent 名称可能含中文/空格/斜杠等非 ASCII 字符，做 ASCII 化映射（非法字符 → `-`），
   * 避免路径穿越/非法字符导致目录不可用；同 agent 同任务多实例追加 `-<seq>` 防共享串数据。
   */
  private defaultAgentWorkDir(
    agent: { name: string; role: string | null; id?: string },
    seq: number,
  ): string {
    const base = sanitizeWorkDirName(agent.name ?? agent.id ?? 'agent');
    return seq > 1
      ? `/data/vteam-worker/${base}-${seq}`
      : `/data/vteam-worker/${base}`;
  }

  /**
   * 事务内批量创建团队成员（updateTeam 专用）：
   * 每个实例写 team_members（seq = 该 teamId+agentId 已用最大 seq+1，防并发重号），
   * 不写 sessions 行；返回带模板 agent 关联的成员列表。
   */
  private async createTeamMembers(
    tx: Prisma.TransactionClient,
    teamId: string,
    agents: { agentId: string; alias?: string; workDir?: string }[],
  ): Promise<TeamMemberView[]> {
    const created: TeamMemberView[] = [];
    for (const item of agents) {
      const agent = await tx.agent.findUnique({
        where: { id: item.agentId },
        select: { id: true, name: true, role: true },
      });
      if (!agent) {
        throw new NotFoundException({
          code: TASK_ERRORS.AGENT_NOT_FOUND,
          message: `Agent ${item.agentId} 不存在`,
        });
      }
      const max = await (tx as any).teamMember.aggregate({
        _max: { seq: true },
        where: { teamId, agentId: item.agentId },
      });
      const seq = (max._max.seq ?? 0) + 1;
      const alias = item.alias?.trim() || this.defaultAlias(agent, seq);
      const workDir =
        item.workDir?.trim() || this.defaultAgentWorkDir(agent, seq);
      const member = await (tx as any).teamMember.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.teamMember),
          teamId,
          agentId: item.agentId,
          alias,
          seq,
          workDir,
        },
      });
      created.push({
        id: member.id,
        agentId: item.agentId,
        alias,
        seq,
        workDir,
        agent,
      });
    }
    return created;
  }

  /** 系统消息 DTO（对齐 ChatService.toMessageDto：content 透传 Json、mentions 缺省 []、createdAt ISO8601）。 */
  private toSystemMessageDto(row: SysMessageRow) {
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

  private normalizePage(page?: number): number {
    const p = Number(page ?? 1);
    return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
  }

  private normalizePageSize(pageSize?: number): number {
    const ps = Number(pageSize ?? 20);
    if (!Number.isFinite(ps)) return 20;
    return Math.min(Math.max(Math.floor(ps), 1), 100);
  }
}
