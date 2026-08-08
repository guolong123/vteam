import {
  BadRequestException,
  ConflictException,
  Injectable,
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
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { RejectTaskDto } from './dto/reject-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTeamDto } from './dto/update-team.dto';

/** 任务域主键前缀（15 篇 §2.2：<prefix>_<零填充序号>）。 */
const ID_PREFIX = {
  task: 't',
  channel: 'c',
  taskAgent: 'ta',
  taskEvent: 'te',
  message: 'm',
  session: 's',
} as const;

/** 任务行 + 团队关系（teamAgentIds 派生源）。 */
type TaskRow = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  mainAgentId: string | null;
  backgroundDocs: Prisma.JsonValue | null;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  pendingReviewAt: Date | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  taskAgents?: { agentId: string; removedAt: Date | null }[];
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

/** 只暴露 findFirst({orderBy:{id:'desc'},select:{id:true}}) 的结构化子集（重启续号用）。 */
type SeqModel = {
  findFirst(args: {
    orderBy: { id: 'desc' };
    select: { id: true };
  }): Promise<{ id: string } | null>;
};

/** 状态迁移系统消息上下文（10 篇 §8.1 文案生成所需）。 */
type SysMessageCtx = {
  task: TaskRow;
  /** 主 Agent 名（仅 start 解析 agent.name；查询不到回退 agentId）。 */
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
  /** CAS 前业务前置校验（仅 start：团队非空 + 主 Agent 已确定）。 */
  preflight?: (task: TaskRow) => void;
  /** 事务内副作用（仅 archive：sessions 全部置 archived）。 */
  afterCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** 群聊系统消息文案（10 篇 §8.1，落库 task_group 频道 senderType=system）；不传则不生成。 */
  sysMessage?: (ctx: SysMessageCtx) => string;
  /** start 私信主 Agent 的启动消息文案（13 篇 §4.2，落库主 Agent private 频道）；不传则只写群聊。 */
  privateMessage?: (ctx: SysMessageCtx) => string;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
    private readonly sessionLifecycle: SessionLifecycleService,
  ) {}

  /** 进程启动：按库内各前缀最大序号对齐 id 生成器（重启续号，防主键冲突）。 */
  async onModuleInit(): Promise<void> {
    await this.seedPrefix(ID_PREFIX.task, this.prisma.task);
    await this.seedPrefix(ID_PREFIX.channel, this.prisma.chatChannel);
    await this.seedPrefix(ID_PREFIX.taskAgent, this.prisma.taskAgent);
    await this.seedPrefix(ID_PREFIX.taskEvent, this.prisma.taskEvent);
    await this.seedPrefix(ID_PREFIX.message, this.prisma.message);
    await this.seedPrefix(ID_PREFIX.session, this.prisma.session);
  }

  /**
   * 创建任务（13 篇 §4.1）：
   * 同事务完成 任务 + 群聊频道(task_group) + 虚拟团队(task_agents) + 独立会话(sessions，10 篇 §3.3
   * 「每 Agent 每任务一个独立会话」) + 状态事件(task_events)，
   * 事务提交后广播 task.status.changed（先落库后转发，08 篇 §7.3）。
   */
  async create(pid: string, userId: string, dto: CreateTaskDto) {
    if (!dto.title || dto.title.trim().length === 0) {
      throw new BadRequestException('任务标题不能为空');
    }
    if (dto.mainAgentId && !dto.agentIds.includes(dto.mainAgentId)) {
      throw new BadRequestException({
        code: TASK_ERRORS.MAIN_AGENT_NOT_IN_TEAM,
        message: '主 Agent 必须在团队 agentIds 内',
      });
    }

    const taskId = await this.idGen.nextId(ID_PREFIX.task);

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          id: taskId,
          projectId: pid,
          title: dto.title.trim(),
          description: dto.description?.trim() || null,
          priority: dto.priority ?? TASK_PRIORITY.medium,
          status: TASK_STATUS.pending,
          mainAgentId: dto.mainAgentId ?? null,
          backgroundDocs: (dto.backgroundDocs ?? []) as Prisma.InputJsonValue,
          createdBy: userId,
          version: 0,
        },
      });

      // 群聊频道（type=task_group；uk_channels_task_agent 唯一约束对 agent_id=null 不冲突）
      await tx.chatChannel.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.channel),
          type: CHANNEL_TYPE.task_group,
          taskId,
          agentId: null,
        },
      });

      for (const agentId of dto.agentIds) {
        await tx.taskAgent.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.taskAgent),
            taskId,
            agentId,
          },
        });
        // 每 Agent 每任务独立会话（10 篇 §3.3 / plan §6 T12「新会话创建」）：
        // 无会话行 → @ 解析 no_session 不分派，mock 回复永不回流（M2 验收阻断项）。
        await tx.session.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.session),
            taskId,
            agentId,
            status: SESSION_STATUS.created,
          },
        });
      }

      // 创建即入待开始：事件 from=null → pending（08 篇 §6.1）
      await tx.taskEvent.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.taskEvent),
          taskId,
          eventType: 'status_change',
          fromStatus: null,
          toStatus: TASK_STATUS.pending,
          actorType: ACTOR_TYPE.user,
          actorId: userId,
        },
      });

      return created;
    });

    // 先落库后转发：广播失败不影响事务结果，前端可经 since 补拉。
    // task.status.changed 走 global 广播（09 篇 §4.1「不传 scope 推送全局广播（任务状态变更等）」），
    // 看板 / 任务页均可用无 scope / scope=global 订阅接收。
    await this.realtime.broadcast(
      EVENT_TYPES.TASK_STATUS_CHANGED,
      {
        taskId,
        from: null,
        to: TASK_STATUS.pending,
        actorType: ACTOR_TYPE.user,
        actorId: userId,
      },
      { type: 'global' },
    );

    const teamAgentIds = dto.agentIds.map((agentId) => ({
      agentId,
      removedAt: null,
    }));
    return this.toTaskDto({ ...task, taskAgents: teamAgentIds });
  }

  /** 看板列表：五态/优先级筛选 + 分页（page 默认 1、pageSize 默认 20 上限 100），created_at desc。 */
  async findAll(pid: string, query: QueryTasksDto) {
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    const where: Prisma.TaskWhereInput = {
      projectId: pid,
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        include: { taskAgents: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => this.toTaskDto(row)),
      total,
      page,
      pageSize,
    };
  }

  /** 任务详情（含 teamAgentIds、backgroundDocs）。 */
  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { taskAgents: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    return this.toTaskDto(task);
  }

  /** 编辑任务：mainAgentId 须为团队内已选 Agent（未 removed），否则 400（FR-08）。 */
  async update(id: string, dto: UpdateTaskDto) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { taskAgents: true },
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
    if (dto.mainAgentId !== undefined) {
      if (dto.mainAgentId !== null) {
        const teamAgentIds = this.teamAgentIdsOf(task.taskAgents);
        if (!teamAgentIds.includes(dto.mainAgentId)) {
          throw new BadRequestException({
            code: TASK_ERRORS.MAIN_AGENT_NOT_IN_TEAM,
            message: '主 Agent 必须是团队内已选 Agent',
          });
        }
      }
      data.mainAgentId = dto.mainAgentId;
    }

    const updated = await this.prisma.task.update({
      where: { id },
      data,
      include: { taskAgents: true },
    });
    return this.toTaskDto(updated);
  }

  /**
   * 团队调整（14 篇 §5.3，FR-02）：`{addAgentIds[], removeAgentIds[]}`。
   *
   * 时间窗：仅 pending/in_progress 合法（与 13 篇 §7.4 联动），否则 409。
   * add：全新 Agent 写 task_agents（joined_at 默认）；已移除者重新加入（removedAt 置空 + joinedAt 刷新）；
   *      已存在未移除者幂等跳过（200，不广播，与状态迁移幂等一致）。
   * remove：写 removed_at（标记非删除）；sessions 冻结（status=frozen）；主 Agent 被移除时清空 mainAgentId；
   *         产出物保留（本版不动 artifacts）。
   * 群聊联动：task_group 频道写 system 消息（10 篇 §8.3 文案）+ 广播 chat.message.new（T9 模式）。
   * 广播 team.changed：逐 Agent {taskId, action: add|remove, agentId}，scope={type:'task', id}（09 篇 §4.2）。
   */
  async updateTeam(id: string, dto: UpdateTeamDto, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { taskAgents: true },
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

    const addIds = [...new Set(dto.addAgentIds ?? [])];
    const removeIds = [...new Set(dto.removeAgentIds ?? [])].filter(
      (agentId) => !addIds.includes(agentId),
    );
    const teamMap = new Map(task.taskAgents.map((ta) => [ta.agentId, ta]));
    const toCreate = addIds.filter((a) => !teamMap.has(a));
    const toRejoin = addIds.filter((a) => teamMap.has(a) && !!teamMap.get(a)!.removedAt);
    const toRemove = removeIds.filter((a) => {
      const ta = teamMap.get(a);
      return ta && !ta.removedAt;
    });

    if (toCreate.length + toRejoin.length + toRemove.length === 0) {
      return this.toTaskDto(task);
    }

    const agentRows = await this.prisma.agent.findMany({
      where: { id: { in: [...toCreate, ...toRejoin, ...toRemove] } },
      select: { id: true, name: true },
    });
    const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));
    for (const agentId of toCreate) {
      if (!agentNameMap.has(agentId)) {
        throw new NotFoundException({
          code: TASK_ERRORS.AGENT_NOT_FOUND,
          message: `Agent ${agentId} 不存在`,
        });
      }
    }

    const channel = await this.prisma.chatChannel.findFirst({
      where: { taskId: id, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });

    const sysMessages = await this.prisma.$transaction(async (tx) => {
      // 任务进行中（in_progress）加入团队的 Agent 会话置 active，否则保持 created（T4 与 start 衔接）
      const joinStatus =
        task.status === TASK_STATUS.in_progress
          ? SESSION_STATUS.active
          : SESSION_STATUS.created;
      for (const agentId of toCreate) {
        await tx.taskAgent.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.taskAgent),
            taskId: id,
            agentId,
          },
        });
        await tx.session.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.session),
            taskId: id,
            agentId,
            status: joinStatus,
          },
        });
      }
      for (const agentId of toRejoin) {
        await tx.taskAgent.update({
          where: { taskId_agentId: { taskId: id, agentId } },
          data: { removedAt: null, joinedAt: new Date() },
        });
        await tx.session.updateMany({
          where: { taskId: id, agentId },
          data: { status: joinStatus },
        });
      }
      for (const agentId of toRemove) {
        await tx.taskAgent.updateMany({
          where: { taskId: id, agentId, removedAt: null },
          data: { removedAt: new Date() },
        });
        await tx.session.updateMany({
          where: { taskId: id, agentId },
          data: { status: SESSION_STATUS.frozen },
        });
      }
      if (task.mainAgentId && toRemove.includes(task.mainAgentId)) {
        await tx.task.update({
          where: { id },
          data: { mainAgentId: null },
        });
      }
      const messages: SysMessageRow[] = [];
      for (const agentId of [...toCreate, ...toRejoin]) {
        const name = agentNameMap.get(agentId) ?? agentId;
        messages.push(
          await tx.message.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.message),
              channelId: channel!.id,
              senderType: SENDER_TYPE.system,
              senderId: null,
              content: { text: `${name} 已加入团队`, parts: [] } as Prisma.InputJsonValue,
              mentions: null,
              status: MESSAGE_STATUS.sent,
            },
          }),
        );
      }
      for (const agentId of toRemove) {
        const name = agentNameMap.get(agentId) ?? agentId;
        messages.push(
          await tx.message.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.message),
              channelId: channel!.id,
              senderType: SENDER_TYPE.system,
              senderId: null,
              content: {
                text: `${name} 已移出团队，其会话已冻结`,
                parts: [],
              } as Prisma.InputJsonValue,
              mentions: null,
              status: MESSAGE_STATUS.sent,
            },
          }),
        );
      }
      return messages;
    });

    for (const agentId of [...toCreate, ...toRejoin]) {
      await this.realtime.broadcast(
        EVENT_TYPES.TEAM_CHANGED,
        { taskId: id, action: 'add', agentId },
        { type: 'task', id },
      );
    }
    for (const agentId of toRemove) {
      await this.realtime.broadcast(
        EVENT_TYPES.TEAM_CHANGED,
        { taskId: id, action: 'remove', agentId },
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
      include: { taskAgents: true },
    });
    return this.toTaskDto(fresh ?? task);
  }

  /** 启动任务（pending → in_progress，13 篇 §4.2）：前置校验团队 + 主 Agent，写 startedAt。 */
  async start(id: string, userId: string) {
    return this.transition(id, 'start', userId, {
      eventType: 'status_change',
      fields: { startedAt: new Date() },
      preflight: (task) => {
        if (this.teamAgentIdsOf(task.taskAgents).length === 0) {
          throw new BadRequestException({
            code: TASK_ERRORS.TASK_EMPTY_TEAM,
            message: '任务团队为空，请先添加 Agent 后再启动',
          });
        }
        if (!task.mainAgentId) {
          throw new BadRequestException({
            code: TASK_ERRORS.MAIN_AGENT_NOT_SET,
            message: '主 Agent 未确定，请先指定主 Agent 后再启动',
          });
        }
      },
      // T4：启动时全部 created 会话置 active（active 全库唯一写入点；Phase 4 worker 分派依赖）
      afterCommit: async (tx) => {
        await tx.session.updateMany({
          where: { taskId: id, status: SESSION_STATUS.created },
          data: { status: SESSION_STATUS.active },
        });
      },
      // 10 篇 §8.1：群聊系统消息含主 Agent 名（FR-07/08）
      sysMessage: ({ task, mainAgentName }) =>
        `任务已开始，主 Agent：${mainAgentName ?? task.mainAgentId}`,
      // 13 篇 §4.2：私信主 Agent 的启动消息（含任务目标、团队分工、背景文档）
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
          `团队分工：${this.teamAgentIdsOf(task.taskAgents).join('、')}`,
        ];
        if (docs) parts.push(`背景文档：${docs}`);
        return parts.join('。');
      },
    });
  }

  /** 标记待验收（in_progress → pending_review，13 篇 §4.3）：写 pendingReviewAt。 */
  async markPendingReview(id: string, userId: string) {
    return this.transition(id, 'mark-pending-review', userId, {
      eventType: 'status_change',
      fields: { pendingReviewAt: new Date() },
      // 10 篇 §8.1：提示成员核对产出（FR-04）
      sysMessage: () => '任务已提交待验收',
    });
  }

  /**
   * 验收通过（pending_review → completed，13 篇 §4.4）：写 completedAt（验收基线属 Phase 3）。
   * 12 篇 §7 验收联动：同事务锁定该任务全部产出物当前版本基线（accepted_flag=true）。
   */
  async accept(id: string, userId: string) {
    return this.transition(id, 'accept', userId, {
      eventType: 'accept',
      fields: { completedAt: new Date() },
      afterCommit: async (tx) => {
        // 12 篇 §7：accept 事务内标记该任务所有 Artifact 当前版本 accepted_flag=true（基线锁定）
        const artifacts = await tx.artifact.findMany({
          where: { taskId: id },
          select: { id: true, currentVersion: true },
        });
        if (artifacts.length === 0) {
          return;
        }
        // (artifactId, version) 精确组合匹配 currentVersion（@@unique 保证组合唯一，
        // 不能用「in 列表」——会误标非当前版本）
        await tx.artifactVersion.updateMany({
          where: {
            OR: artifacts.map((a) => ({
              artifactId: a.id,
              version: a.currentVersion,
            })),
          },
          data: { acceptedFlag: true },
        });
      },
      // 10 篇 §8.1：强调 accepted_flag 基线锁定（FR-04）
      sysMessage: () => '任务已验收完成，产出物基线已锁定',
    });
  }

  /** 验收驳回（pending_review → in_progress，13 篇 §4.4）：reason 写 metadata，重置 pendingReviewAt。 */
  async reject(id: string, userId: string, dto?: RejectTaskDto) {
    return this.transition(id, 'reject', userId, {
      eventType: 'reject',
      fields: { pendingReviewAt: null },
      metadata: dto?.reason ? { reason: dto.reason } : undefined,
      // 10 篇 §8.1 / 13 篇 §4.4：附驳回原因（reason 存在时）
      sysMessage: () =>
        dto?.reason
          ? `任务被驳回，请补齐产出后重新提交。驳回原因：${dto.reason}`
          : '任务被驳回，请补齐产出后重新提交',
    });
  }

  /** 归档（completed → archived，终态，13 篇 §4.5）：写 archivedAt，sessions 全部置 archived。 */
  async archive(id: string, userId: string) {
    return this.transition(id, 'archive', userId, {
      eventType: 'archive',
      fields: { archivedAt: new Date() },
      afterCommit: async (tx) => {
        await tx.session.updateMany({
          where: { taskId: id },
          data: { status: SESSION_STATUS.archived },
        });
      },
      // 10 篇 §8.1：明确内容保留（FR-05）
      sysMessage: () => '任务已归档，历史可回看',
    });
  }

  /**
   * T12：查询任务的全部 opencode 会话实例（TaskGroupInstance，供任务页展示/调度复用）。
   * 委托 SessionLifecycleService（WorkersModule 域，与 T10 bindSessionToWorker 同源）。
   */
  async getInstancesByTask(taskId: string) {
    return this.sessionLifecycle.getInstancesByTask(taskId);
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

    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { taskAgents: true },
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
    if (task.status !== from) {
      throw new ConflictException({
        code: TASK_ERRORS.TASK_INVALID_TRANSITION,
        message: '任务状态迁移不合法',
        details: { from, to, current: task.status },
      });
    }
    opts.preflight?.(task);

    // 系统消息落库目标：任务群聊频道（task_group，10 篇 §8.1；T8 updateTeam 同模式）
    const channel = await this.prisma.chatChannel.findFirst({
      where: { taskId: id, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });
    // start 私信主 Agent（13 篇 §4.2）：解析主 Agent 名 + private 频道（无 private 频道则跳过）
    let mainAgentName: string | undefined;
    let privateChannel: { id: string } | null = null;
    if (action === 'start' && task.mainAgentId) {
      const agent = await this.prisma.agent.findUnique({
        where: { id: task.mainAgentId },
        select: { name: true },
      });
      mainAgentName = agent?.name ?? undefined;
      privateChannel = await this.prisma.chatChannel.findFirst({
        where: {
          taskId: id,
          agentId: task.mainAgentId,
          type: CHANNEL_TYPE.private,
        },
        select: { id: true },
      });
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
          actorType: ACTOR_TYPE.user,
          actorId: userId,
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
      // start 私信主 Agent：写入主 Agent 的 private 频道（存在才发）
      if (privateChannel && privateText) {
        sysMessages.push(
          await tx.message.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.message),
              channelId: privateChannel.id,
              senderType: SENDER_TYPE.system,
              senderId: null,
              content: { text: privateText, parts: [] } as Prisma.InputJsonValue,
              mentions: null,
              status: MESSAGE_STATUS.sent,
            },
          }),
        );
      }
      return false;
    });

    if (casFailed) {
      const current = await this.prisma.task.findUnique({
        where: { id },
        include: { taskAgents: true },
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
      { taskId: id, from, to, actorType: ACTOR_TYPE.user, actorId: userId },
      { type: 'global' },
    );

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
      include: { taskAgents: true },
    });
    return this.toTaskDto(fresh ?? task);
  }

  private toTaskDto(task: TaskRow) {
    return {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      mainAgentId: task.mainAgentId,
      backgroundDocs: task.backgroundDocs ?? [],
      teamAgentIds: this.teamAgentIdsOf(task.taskAgents),
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      pendingReviewAt: task.pendingReviewAt,
      completedAt: task.completedAt,
      archivedAt: task.archivedAt,
    };
  }

  /** 团队内已选 Agent：task_agents 中未 removed 的 agentId 列表。 */
  private teamAgentIdsOf(
    taskAgents?: { agentId: string; removedAt: Date | null }[],
  ): string[] {
    return (taskAgents ?? [])
      .filter((ta) => !ta.removedAt)
      .map((ta) => ta.agentId);
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

  private async seedPrefix(prefix: string, model: SeqModel): Promise<void> {
    const last = await model.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    if (last) {
      const seq = parseInt(last.id.slice(prefix.length + 1), 10);
      if (Number.isFinite(seq)) {
        this.idGen.seed(prefix, seq);
      }
    }
  }
}
