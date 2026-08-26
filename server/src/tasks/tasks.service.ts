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
  workDir?: string | null;
  removedAt: Date | null;
  enabled?: boolean | null;
  overrideModelId?: string | null;
  agent: { id: string; name: string; role: string | null };
  /** 实例会话（每实例每任务一个，task 详情 instances 回传 sessionStatus 真实状态源）。 */
  sessions?: { id: string; status: string }[];
};

/** 任务详情/列表查询的 taskAgents include（统一带模板 agent 的 name/role，instances 渲染用）。 */
const TASK_AGENTS_INCLUDE = {
  taskAgents: {
    include: {
      agent: { select: { id: true, name: true, role: true } },
      // 会话状态快照：instances.sessionStatus 取该实例会话当前 status（archived 终态不参与
      // 工作状态展示）；每实例恒 1 条会话（uk_sessions_task_agent 唯一），直接取首项。
      sessions: {
        select: { id: true, status: true },
        where: { status: { not: SESSION_STATUS.archived } },
      },
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
  managedMode: boolean;
  executionMode: string;
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
    const instances: TaskAgentInstance[] = [];

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
          managedMode: dto.managedMode ?? false,
          // 执行模式（tc-flow）：缺省 direct（迁移列 @default("direct") 兜底）；与托管模式独立生效
          executionMode: dto.executionMode ?? EXECUTION_MODES.direct,
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
        const workDir =
          item.workDir?.trim() || this.defaultAgentWorkDir(agent, seq);
        const ta = await tx.taskAgent.create({
          data: {
            id: await this.idGen.nextId(ID_PREFIX.taskAgent),
            taskId,
            agentId: item.agentId,
            alias,
            seq,
            workDir,
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
          workDir,
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
      if (mainInstanceId && !instances.some((i) => i.id === mainInstanceId)) {
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
    if (dto.backgroundDocs !== undefined) {
      data.backgroundDocs = dto.backgroundDocs as Prisma.InputJsonValue;
    }
    if (dto.managedMode !== undefined) {
      data.managedMode = dto.managedMode;
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
   * 切换任务执行模式（tc-flow）：
   * - 双向切换均即时生效（direct ↔ plan 无前置校验）——切换 = 用户意图声明/提示
   *   （对齐 omo keyword-detector 哲学：说 ultrawork 立即生效，零前置校验）；
   * - 计划门不放在切换点：start.preflight（plan 模式须 approved 计划 = approval gate）
   *   与 mark-pending-review.preflight（计划任务全完成 = 验收门）各自把关；
   * - 任务已 in_progress 时切到 plan：若计划存在且已批准/执行中（approved/executing）
   *   → 事务内顺带计划置 executing（执行态与计划态一致）；计划不存在或其他状态 → 仅切
   *   executionMode，不碰计划。
   * 执行模式与托管模式（managedMode）独立生效、互不干扰。
   */
  async updateExecutionMode(id: string, mode: string) {
    if (mode !== EXECUTION_MODES.direct && mode !== EXECUTION_MODES.plan) {
      throw new BadRequestException(`非法执行模式：${mode}`);
    }
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
            include: TASK_AGENTS_INCLUDE,
          });
        });
        return this.toTaskDto(updated);
      }
    }
    const updated = await this.prisma.task.update({
      where: { id },
      data: { executionMode: mode },
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

    const { sysMessages, created } = await this.prisma.$transaction(
      async (tx) => {
        // 任务进行中（in_progress）加入团队的 Agent 会话置 active，否则保持 created（T4 与 start 衔接）
        const joinStatus =
          task.status === TASK_STATUS.in_progress
            ? SESSION_STATUS.active
            : SESSION_STATUS.created;
        const created = await this.createInstances(
          tx,
          id,
          addInstances,
          joinStatus,
        );
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
        const confirmedSuffix = opts?.confirmedBy
          ? `（经主 Agent 申请、${opts.confirmedBy} 确认）`
          : '';
        for (const inst of created) {
          messages.push(
            await tx.message.create({
              data: {
                id: await this.idGen.nextId(ID_PREFIX.message),
                channelId: channel!.id,
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
      include: TASK_AGENTS_INCLUDE,
    });
    return this.toTaskDto(fresh ?? task);
  }

  async updateInstance(
    taskId: string,
    instanceId: string,
    dto: { enabled?: boolean; overrideModelId?: string | null },
  ) {
    const inst = await this.prisma.taskAgent.findUnique({
      where: { id: instanceId },
    });
    if (!inst || inst.taskId !== taskId) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '实例不存在',
      });
    }
    const data: Record<string, unknown> = {};
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.overrideModelId !== undefined) {
      const v = dto.overrideModelId?.trim();
      data.overrideModelId = v ? v : null;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.taskAgent.update({ where: { id: instanceId }, data });
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: TASK_AGENTS_INCLUDE,
    });
    return this.toTaskDto(task!);
  }

  async resetInstanceSession(taskId: string, instanceId: string) {
    const inst = await this.prisma.taskAgent.findUnique({
      where: { id: instanceId },
    });
    if (!inst || inst.taskId !== taskId) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '实例不存在',
      });
    }
    // uk_sessions_task_agent 保证每实例仅一行 session，旧实现先 archived 再 create
    // 会触发唯一约束（500）。改为事务内删除旧行（含 TaskGroupInstance 软删）再创建新会话，
    // 确保 reset 清空绑定状态且不会 500。
    const newId = await this.idGen.nextId('s');
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.session.findFirst({
        where: { taskAgentId: instanceId },
        select: { id: true, workerId: true, instanceRef: true },
      });
      if (existing?.workerId && existing.instanceRef) {
        await tx.taskGroupInstance.updateMany({
          where: {
            taskId,
            workerId: existing.workerId,
            instanceId: existing.instanceRef,
            removedAt: null,
          },
          data: { removedAt: new Date() },
        });
      }
      // 删除旧会话以释放 (taskId, taskAgentId) 唯一约束，再创建 created 态新会话
      await tx.session.deleteMany({ where: { taskAgentId: instanceId } });
      const newSession = await tx.session.create({
        data: {
          id: newId,
          taskId,
          taskAgentId: instanceId,
          agentId: inst.agentId,
          status: SESSION_STATUS.created,
        },
      });
      const task = await tx.task.findUnique({
        where: { id: taskId },
        include: TASK_AGENTS_INCLUDE,
      });
      return { task: this.toTaskDto(task!), session: newSession };
    });
    return result;
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
        // tc-flow：plan 模式启动前置通过后，事务内将计划置 executing（approved → executing 唯一写入点之一）；
        // 执行模式与托管模式（managedMode）独立生效、互不干扰
        let planStarted = false;
        return {
          eventType: 'status_change',
          fields: { startedAt: new Date() },
          preflight: async (task) => {
            if (this.teamInstancesOf(task.taskAgents).length === 0) {
              throw new BadRequestException({
                code: TASK_ERRORS.TASK_EMPTY_TEAM,
                message: '任务团队为空，请先添加 Agent 实例后再启动',
              });
            }
            if (!task.mainAgentInstanceId) {
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
        // tc-flow：plan 模式且存在计划 → 验收通过后计划置 completed（Oracle B3）
        let planCompletable = false;
        return {
          eventType: 'accept',
          fields: { completedAt: new Date() },
          preflight: async (task) => {
            if (task.executionMode === EXECUTION_MODES.plan) {
              const plan = await this.prisma.plan.findUnique({
                where: { taskId: task.id },
                select: { id: true },
              });
              planCompletable = Boolean(plan);
            }
          },
          afterCommit: async (tx) => {
            // 12 篇 §7：accept 事务内标记该任务所有 Artifact 当前版本 accepted_flag=true（基线锁定）
            const artifacts = await tx.artifact.findMany({
              where: { taskId: id },
              select: { id: true, currentVersion: true },
            });
            if (artifacts.length > 0) {
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
            }
            if (planCompletable) {
              await tx.plan.update({
                where: { taskId: id },
                data: { status: PLAN_STATUS.completed },
              });
            }
          },
          // 10 篇 §8.1：强调 accepted_flag 基线锁定（FR-04）
          sysMessage: () => '任务已验收完成，产出物基线已锁定',
          privateMessage: () =>
            '任务已验收完成，产出物基线已锁定。记忆收集已自动触发（见触发消息），请按其要求只沉淀可复用经验（做法/坑/约束），不要保存会话总结。',
        };
      }
      case 'reject':
        return {
          eventType: 'reject',
          fields: { pendingReviewAt: null },
          metadata: reason ? { reason } : undefined,
          // 10 篇 §8.1 / 13 篇 §4.4：附驳回原因（reason 存在时）
          sysMessage: () =>
            reason
              ? `任务被驳回，请补齐产出后重新提交。驳回原因：${reason}`
              : '任务被驳回，请补齐产出后重新提交',
        };
      case 'archive': {
        // tc-flow：plan 模式且存在计划 → 归档后计划置 completed（Oracle B3）
        let planCompletable = false;
        return {
          eventType: 'archive',
          fields: { archivedAt: new Date() },
          preflight: async (task) => {
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
   * 主实例校验：task.mainAgentInstanceId === instanceId，否则 403 TASK_STATUS_MAIN_AGENT_ONLY；
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
      select: { id: true, mainAgentInstanceId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    if (task.mainAgentInstanceId !== instanceId) {
      // Agent 可读的完整引导：指明主实例 id + 正确操作路径（MCP 由主实例调用 / 知会主实例 / 管理界面人工操作）
      throw new ForbiddenException({
        code: TASK_ERRORS.TASK_STATUS_MAIN_AGENT_ONLY,
        message: `仅主 Agent（${task.mainAgentInstanceId ?? '未设置'}）可流转任务状态；请知会主 Agent 调用 task_transition，或由管理员在任务管理界面操作`,
      });
    }
    return this.transition(taskId, action, instanceId, {
      ...this.transitionOpts(taskId, action, dto?.reason),
      actor: { type: ACTOR_TYPE.agent, id: instanceId },
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
    // 动作执行者：缺省 user/调用者（用户路径行为不变）；MCP 路径由 transitionByAgent 传 agent/实例。
    const actor = opts.actor ?? { type: ACTOR_TYPE.user, id: userId };

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
    await opts.preflight?.(task);

    // 系统消息落库目标：任务群聊频道（task_group，10 篇 §8.1；T8 updateTeam 同模式）
    const channel = await this.prisma.chatChannel.findFirst({
      where: { taskId: id, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });
    // start/accept 私信主实例（13 篇 §4.2；记忆管理 mem-trigger：accept 同路径私信引导记忆总结）：
    // 解析主实例别名 + private 频道（按 taskAgentId，无 mainAgentInstanceId 则跳过）
    let mainAgentName: string | undefined;
    let privateChannel: { id: string } | null = null;
    if (
      (action === 'start' ||
        action === 'accept' ||
        action === 'mark-pending-review') &&
      task.mainAgentInstanceId
    ) {
      const mainInstance = task.taskAgents?.find(
        (ta) => ta.id === task.mainAgentInstanceId,
      );
      mainAgentName =
        mainInstance?.alias ?? mainInstance?.agent.name ?? undefined;
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

    if (action === 'mark-pending-review' && task.mainAgentInstanceId) {
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
      workDir: ta.workDir ?? this.defaultAgentWorkDir(ta.agent, ta.seq),
      name: ta.agent.name,
      role: ta.agent.role,
      main: ta.id === task.mainAgentInstanceId,
      enabled: (ta as { enabled?: boolean | null }).enabled ?? true,
      // 会话状态快照（每实例一会话，取首项；archived 已过滤）：前端挂载时初始化
      // 成员工作状态（SSE 增量仅驱动后续切换，重连不重放 running → 状态丢失修复）。
      sessionStatus: ta.sessions?.[0]?.status ?? null,
      sessionId: ta.sessions?.[0]?.id ?? null,
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
      managedMode: task.managedMode ?? false,
      executionMode: task.executionMode ?? EXECUTION_MODES.direct,
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
      .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.seq - b.seq);
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
   * 事务内批量创建团队实例（create / updateTeam 共用）：
   * 每个实例写 task_agents（seq = 该 taskId+agentId 已用最大 seq+1，防并发重号）
   * + 独立会话绑实例（status 由调用方传入）；返回带模板 agent 关联的实例列表。
   */
  private async createInstances(
    tx: Prisma.TransactionClient,
    taskId: string,
    agents: { agentId: string; alias?: string; workDir?: string }[],
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
      const workDir =
        item.workDir?.trim() || this.defaultAgentWorkDir(agent, seq);
      const ta = await tx.taskAgent.create({
        data: {
          id: await this.idGen.nextId(ID_PREFIX.taskAgent),
          taskId,
          agentId: item.agentId,
          alias,
          seq,
          workDir,
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
        workDir,
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
