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

/** 角色中文名映射（seed 模板 agent.role → 中文名；未知角色回退 agent.name，FR-08 别名默认规则）。 */
const ROLE_LABELS: Record<string, string> = {
  product: '产品经理',
  project_manager: '项目经理',
  architect: '架构师',
  developer: '开发者',
  tester: '测试',
} as const;

/** 团队成员实例（task_agents 行 + 模板 agent 关联，instances/teamInstancesOf 派生源）。 */
type TaskAgentInstance = {
  id: string;
  agentId: string;
  alias: string | null;
  seq: number;
  removedAt: Date | null;
  agent: { id: string; name: string; role: string | null };
};

/** 任务详情/列表查询的 taskAgents include（统一带模板 agent 的 name/role，instances 渲染用）。 */
const TASK_AGENTS_INCLUDE = {
  taskAgents: {
    include: {
      agent: { select: { id: true, name: true, role: true } },
    },
  },
} as const;

/** 任务行 + 团队实例关系（teamInstancesOf 派生源）。 */
type TaskRow = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  mainAgentId: string | null;
  mainAgentInstanceId: string | null;
  backgroundDocs: Prisma.JsonValue | null;
  createdBy: string;
  createdAt: Date;
  startedAt: Date | null;
  pendingReviewAt: Date | null;
  completedAt: Date | null;
  archivedAt: Date | null;
  taskAgents?: TaskAgentInstance[];
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
  /** 主实例别名（仅 start 解析实例 alias，缺省 `<角色中文名>-<seq>`；查询不到回退实例 id）。 */
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
    const agents = dto.agents ?? [];
    if (agents.length === 0) {
      throw new BadRequestException({
        code: TASK_ERRORS.TASK_EMPTY_TEAM,
        message: '任务团队不能为空，请至少添加一个 Agent 实例',
      });
    }
    if (dto.mainAgentId && !agents.some((a) => a.agentId === dto.mainAgentId)) {
      throw new BadRequestException({
        code: TASK_ERRORS.MAIN_AGENT_NOT_IN_TEAM,
        message: '主 Agent 必须在团队实例内',
      });
    }

    const taskId = await this.idGen.nextId(ID_PREFIX.task);
    let instances: TaskAgentInstance[] = [];

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          id: taskId,
          projectId: pid,
          title: dto.title.trim(),
          description: dto.description?.trim() || null,
          priority: dto.priority ?? TASK_PRIORITY.medium,
          status: TASK_STATUS.pending,
          // 主实例在实例创建后解析（mainAgentInstanceId 需校验属于创建集合），先空置再更新
          mainAgentId: null,
          mainAgentInstanceId: null,
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

      // 团队实例：每个 agents 项创建 TaskAgent（seq = 该 taskId+agentId 已用最大 seq+1，
      // 事务内防并发重号，uk_task_agents_task_agent_seq 唯一键兜底）+ 独立会话绑实例
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
        const max = await tx.taskAgent.aggregate({
          _max: { seq: true },
          where: { taskId, agentId: item.agentId },
        });
        const seq = (max._max.seq ?? 0) + 1;
        const alias = item.alias?.trim() || this.defaultAlias(agent, seq);
        const ta = await tx.taskAgent.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.taskAgent),
            taskId,
            agentId: item.agentId,
            alias,
            seq,
          },
        });
        // 每实例每任务独立会话（10 篇 §3.3 / plan §6 T12「新会话创建」）：
        // 无会话行 → @ 解析 no_session 不分派，mock 回复永不回流（M2 验收阻断项）。
        await tx.session.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.session),
            taskId,
            taskAgentId: ta.id,
            agentId: item.agentId,
            status: SESSION_STATUS.created,
          },
        });
        instances.push({
          id: ta.id,
          agentId: item.agentId,
          alias,
          seq,
          removedAt: null,
          agent,
        });
      }

      // 主实例解析：入参 mainAgentInstanceId 优先 → mainAgentId 映射该 agent 第一个实例 → null；
      // mainAgentInstanceId 必须属于本次创建实例集合（FR-08）。
      let mainInstanceId = dto.mainAgentInstanceId ?? null;
      if (!mainInstanceId && dto.mainAgentId) {
        mainInstanceId =
          instances.find((i) => i.agentId === dto.mainAgentId)?.id ?? null;
      }
      if (
        mainInstanceId &&
        !instances.some((i) => i.id === mainInstanceId)
      ) {
        throw new BadRequestException({
          code: TASK_ERRORS.MAIN_AGENT_NOT_IN_TEAM,
          message: '主 Agent 必须是团队内实例',
        });
      }
      const mainAgentId =
        instances.find((i) => i.id === mainInstanceId)?.agentId ?? null;
      await tx.task.update({
        where: { id: taskId },
        data: { mainAgentId, mainAgentInstanceId: mainInstanceId },
      });

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

    const fresh = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: TASK_AGENTS_INCLUDE,
    });
    return this.toTaskDto(fresh ?? { ...task, taskAgents: instances });
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
        include: TASK_AGENTS_INCLUDE,
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

  /** 任务详情（含 teamAgentIds、instances、backgroundDocs）。 */
  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: TASK_AGENTS_INCLUDE,
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
      include: TASK_AGENTS_INCLUDE,
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
    const instances = this.teamInstancesOf(task.taskAgents);
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
      include: TASK_AGENTS_INCLUDE,
    });
    return this.toTaskDto(updated);
  }

  /**
   * 团队调整（14 篇 §5.3，FR-02；角色/实例分离 T2）：`{addInstances[], removeInstanceIds[]}`。
   *
   * 时间窗：仅 pending/in_progress 合法（与 13 篇 §7.4 联动），否则 409。
   * addInstances：每个实例写 task_agents（seq = 该 taskId+agentId 已用最大 seq+1，事务内防并发重号）
   *              + 独立会话绑实例（joined_at 默认）；同 agent 可加多实例。
   * removeInstanceIds：按实例 id 写 removed_at（标记非删除）+ 冻结该实例 session（status=frozen）；
   *                    主实例被移除时清空 mainAgentInstanceId（同步 mainAgentId）。
   *                    产出物保留（本版不动 artifacts）。
   * 群聊联动：task_group 频道写 system 消息（10 篇 §8.3 文案）+ 广播 chat.message.new（T9 模式）。
   * 广播 team.changed 按实例：{taskId, action: add|remove, instanceId, agentId, alias}，
   * scope={type:'task', id}（09 篇 §4.2）。
   */
  async updateTeam(id: string, dto: UpdateTeamDto, userId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: TASK_AGENTS_INCLUDE,
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

    const addInstances = dto.addInstances ?? [];
    const removeInstanceIds = [...new Set(dto.removeInstanceIds ?? [])];
    const teamMap = new Map(task.taskAgents.map((ta) => [ta.id, ta]));
    const toRemove = removeInstanceIds.filter((instanceId) => {
      const ta = teamMap.get(instanceId);
      return ta && !ta.removedAt;
    });

    if (addInstances.length === 0 && toRemove.length === 0) {
      return this.toTaskDto(task);
    }

    const channel = await this.prisma.chatChannel.findFirst({
      where: { taskId: id, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });

    const { sysMessages, created } = await this.prisma.$transaction(async (tx) => {
      // 任务进行中（in_progress）加入团队的 Agent 会话置 active，否则保持 created（T4 与 start 衔接）
      const joinStatus =
        task.status === TASK_STATUS.in_progress
          ? SESSION_STATUS.active
          : SESSION_STATUS.created;
      const created = await this.createInstances(tx, id, addInstances, joinStatus);
      for (const instanceId of toRemove) {
        await tx.taskAgent.updateMany({
          where: { id: instanceId, removedAt: null },
          data: { removedAt: new Date() },
        });
        await tx.session.updateMany({
          where: { taskAgentId: instanceId },
          data: { status: SESSION_STATUS.frozen },
        });
      }
      if (
        task.mainAgentInstanceId &&
        toRemove.includes(task.mainAgentInstanceId)
      ) {
        await tx.task.update({
          where: { id },
          data: { mainAgentId: null, mainAgentInstanceId: null },
        });
      }
      const messages: SysMessageRow[] = [];
      for (const inst of created) {
        messages.push(
          await tx.message.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.message),
              channelId: channel!.id,
              senderType: SENDER_TYPE.system,
              senderId: null,
              content: {
                text: `${inst.alias ?? inst.agentId} 已加入团队`,
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
        messages.push(
          await tx.message.create({
            data: {
              id: await this.idGen.nextId(ID_PREFIX.message),
              channelId: channel!.id,
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
      return { sysMessages: messages, created };
    });

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
      include: TASK_AGENTS_INCLUDE,
    });
    return this.toTaskDto(fresh ?? task);
  }

  /** 启动任务（pending → in_progress，13 篇 §4.2）：前置校验团队实例 + 主实例，写 startedAt。 */
  async start(id: string, userId: string) {
    return this.transition(id, 'start', userId, {
      eventType: 'status_change',
      fields: { startedAt: new Date() },
      preflight: (task) => {
        if (this.teamInstancesOf(task.taskAgents).length === 0) {
          throw new BadRequestException({
            code: TASK_ERRORS.TASK_EMPTY_TEAM,
            message: '任务团队为空，请先添加 Agent 实例后再启动',
          });
        }
        if (!task.mainAgentInstanceId) {
          throw new BadRequestException({
            code: TASK_ERRORS.MAIN_AGENT_NOT_SET,
            message: '主 Agent 实例未确定，请先指定主 Agent 后再启动',
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
      // 10 篇 §8.1：群聊系统消息含主实例名（FR-07/08）
      sysMessage: ({ task, mainAgentName }) =>
        `任务已开始，主 Agent：${mainAgentName ?? task.mainAgentInstanceId}`,
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
          `团队分工：${this.teamInstancesOf(task.taskAgents)
            .map((i) => i.alias ?? i.agentId)
            .join('、')}`,
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
      include: TASK_AGENTS_INCLUDE,
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
    // start 私信主实例（13 篇 §4.2）：解析主实例别名 + private 频道（按 taskAgentId，无则跳过）
    let mainAgentName: string | undefined;
    let privateChannel: { id: string } | null = null;
    if (action === 'start' && task.mainAgentInstanceId) {
      const mainInstance = task.taskAgents?.find(
        (ta) => ta.id === task.mainAgentInstanceId,
      );
      mainAgentName =
        mainInstance?.alias ??
        mainInstance?.agent.name ??
        undefined;
      privateChannel = await this.prisma.chatChannel.findFirst({
        where: {
          taskId: id,
          taskAgentId: task.mainAgentInstanceId,
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
        include: TASK_AGENTS_INCLUDE,
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
      include: TASK_AGENTS_INCLUDE,
    });
    return this.toTaskDto(fresh ?? task);
  }

  /**
   * 任务 DTO（FR-08 角色/实例分离 T2）：instances 为团队实例列表
   * [{id, agentId, alias, seq, name, role, main}]，按 (agentId, seq) 稳定排序；
   * mainAgentId 保留（渲染兜底），mainAgentInstanceId 为决策依据；
   * teamAgentIds 保留兼容（按 taskAgents 原始顺序，未 removed 过滤）。
   */
  private toTaskDto(task: TaskRow) {
    const instances = this.teamInstancesOf(task.taskAgents).map((ta) => ({
      id: ta.id,
      agentId: ta.agentId,
      alias: ta.alias,
      seq: ta.seq,
      name: ta.agent.name,
      role: ta.agent.role,
      main: ta.id === task.mainAgentInstanceId,
    }));
    return {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      mainAgentId: task.mainAgentId,
      mainAgentInstanceId: task.mainAgentInstanceId ?? null,
      backgroundDocs: task.backgroundDocs ?? [],
      teamAgentIds: (task.taskAgents ?? [])
        .filter((ta) => !ta.removedAt)
        .map((ta) => ta.agentId),
      instances,
      createdBy: task.createdBy,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      pendingReviewAt: task.pendingReviewAt,
      completedAt: task.completedAt,
      archivedAt: task.archivedAt,
    };
  }

  /** 团队实例列表：task_agents 中未 removed 的实例，按 (agentId, seq) 稳定排序。 */
  private teamInstancesOf(
    taskAgents?: TaskAgentInstance[],
  ): TaskAgentInstance[] {
    return (taskAgents ?? [])
      .filter((ta) => !ta.removedAt)
      .sort(
        (a, b) =>
          a.agentId.localeCompare(b.agentId) || a.seq - b.seq,
      );
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
   * 事务内批量创建团队实例（create / updateTeam 共用）：
   * 每个实例写 task_agents（seq = 该 taskId+agentId 已用最大 seq+1，防并发重号）
   * + 独立会话绑实例（status 由调用方传入）；返回带模板 agent 关联的实例列表。
   */
  private async createInstances(
    tx: Prisma.TransactionClient,
    taskId: string,
    agents: { agentId: string; alias?: string }[],
    status: string,
  ): Promise<TaskAgentInstance[]> {
    const created: TaskAgentInstance[] = [];
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
      const max = await tx.taskAgent.aggregate({
        _max: { seq: true },
        where: { taskId, agentId: item.agentId },
      });
      const seq = (max._max.seq ?? 0) + 1;
      const alias = item.alias?.trim() || this.defaultAlias(agent, seq);
      const ta = await tx.taskAgent.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.taskAgent),
          taskId,
          agentId: item.agentId,
          alias,
          seq,
        },
      });
      await tx.session.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.session),
          taskId,
          taskAgentId: ta.id,
          agentId: item.agentId,
          status,
        },
      });
      created.push({
        id: ta.id,
        agentId: item.agentId,
        alias,
        seq,
        removedAt: null,
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
