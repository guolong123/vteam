import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { TASK_ERRORS } from '../common/constants/task.constants';
import { PROJECT_MEMBERSHIP_ERRORS } from '../common/guards/project-membership.guard';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PLAN_ERRORS, PLAN_STATUS } from './plan.constants';

/** Plan 主键前缀（<prefix>_<零填充序号>，pl_0000000001 起）。 */
const PLAN_ID_PREFIX = 'pl';
/** PlanTask 主键前缀（pt_0000000001 起）。 */
const PLAN_TASK_ID_PREFIX = 'pt';
/** 群聊系统消息主键前缀（与 ChatService/PlatformMcpService 共享 'm' 计数）。 */
const MESSAGE_ID_PREFIX = 'm';

/** 评审结论（REST 路径 verdict，对齐 plan_review 的 approved/rejected）。 */
export type PlanReviewVerdict = 'approved' | 'rejected';

/** 计划头 + 子任务清单 DTO 形状（REST findByTask 与 plan_get 共用，含指派概览）。 */
export interface PlanWithTasksDto {
  id: string;
  taskId: string;
  title: string;
  summary: string | null;
  scopeIn: string | null;
  scopeOut: string | null;
  status: string;
  createdBy: string;
  reviewerInstanceId: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: PlanTaskDto[];
}

/** 计划子任务 DTO（content 六要素原样透传 + assignee 概览）。 */
export interface PlanTaskDto {
  id: string;
  seq: number;
  title: string;
  content: Prisma.JsonValue;
  assigneeInstanceId: string | null;
  assigneeAlias: string | null;
  assigneeName: string | null;
  status: string;
}

/**
 * 协作计划服务（vteam-team-collaboration Todo 1 表结构 + 启动续号骨架；
 * Todo 5 填充业务方法 findByTask/review/findTasks/assignReviewer）。
 *
 * REST 权限模型（对齐 issues.controller）：不挂 AdminGuard / ProjectMembershipGuard，
 * 鉴权依赖全局 JwtAuthGuard，项目成员校验在本服务内完成（assertTaskMember）。
 * onModuleInit 续号逻辑保留：只统计 pl_/pt_<数字> 行最大序号，命名 id 不参与
 * （parseInt NaN 防护见 common/id-resync.ts）。
 */
@Injectable()
export class PlansService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * 进程启动对齐 Plan/PlanTask 域前缀序号（重启续号）。
   * 复用 common/id-resync.ts 的 resyncIdPrefix：findMany 按前缀过滤仅取 id 列，
   * JS 侧解析纯数字序号取 max 后 idGen.seed，防命名 id 干扰计数器。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.plan, PLAN_ID_PREFIX, this.idGen);
    await resyncIdPrefix(this.prisma.planTask, PLAN_TASK_ID_PREFIX, this.idGen);
  }

  /** 用户路径成员校验（对齐 issues.service.assertTaskMember）：任务存在（404）→ 调用者是任务所属项目成员（403）。 */
  private async assertTaskMember(
    taskId: string,
    userId: string,
  ): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: task.projectId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该项目成员',
      });
    }
  }

  /** 查计划行（404 PLAN_NOT_FOUND 若不存在）。 */
  private async findPlanOrThrow(planId: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
    });
    if (!plan) {
      throw new NotFoundException({
        code: PLAN_ERRORS.PLAN_NOT_FOUND,
        message: '执行计划不存在',
      });
    }
    return plan;
  }

  /** 任务群聊频道（task_group 型 ChatChannel，系统消息落库目标，对齐 PlatformMcpService）。 */
  private findTaskGroupChannel(taskId: string) {
    return this.prisma.chatChannel.findFirst({
      where: { taskId, type: CHANNEL_TYPE.task_group },
      select: { id: true },
    });
  }

  /**
   * 指派概览解析：planTask.assigneeInstanceId → taskAgent 行（alias + agent.name）。
   * 未命中（已移除/未指派）→ 概览为 null，不阻断读取。
   */
  private async resolveAssigneeOverview(
    taskId: string,
    rows: Array<{ assigneeInstanceId: string | null }>,
  ): Promise<Map<string, { alias: string | null; name: string }>> {
    const ids = [
      ...new Set(
        rows
          .map((r) => r.assigneeInstanceId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) {
      return new Map();
    }
    const agents = await this.prisma.taskAgent.findMany({
      where: { id: { in: ids }, taskId },
      select: { id: true, alias: true, agent: { select: { name: true } } },
    });
    return new Map(
      agents.map((a) => [
        a.id,
        { alias: a.alias, name: a.agent.name },
      ]),
    );
  }

  /** 计划子任务 DTO（content 透传 + assignee 概览）。 */
  private toPlanTaskDto(
    t: {
      id: string;
      seq: number;
      title: string;
      content: Prisma.JsonValue;
      assigneeInstanceId: string | null;
      status: string;
    },
    assigneeMap: Map<string, { alias: string | null; name: string }>,
  ): PlanTaskDto {
    const overview = assigneeMap.get(t.assigneeInstanceId ?? '');
    return {
      id: t.id,
      seq: t.seq,
      title: t.title,
      content: t.content,
      assigneeInstanceId: t.assigneeInstanceId,
      assigneeAlias: overview?.alias ?? null,
      assigneeName: overview?.name ?? null,
      status: t.status,
    };
  }

  /**
   * GET /plans?taskId=：查询任务执行计划（项目成员，一任务一计划）。
   * 返回计划头（含 reviewerInstanceId）+ 子任务清单全文（含六要素 content + 指派概览）。
   */
  async findByTask(taskId: string, userId: string): Promise<PlanWithTasksDto> {
    await this.assertTaskMember(taskId, userId);
    const plan = await this.prisma.plan.findUnique({
      where: { taskId },
    });
    if (!plan) {
      throw new NotFoundException({
        code: PLAN_ERRORS.PLAN_NOT_FOUND,
        message: '该任务尚无执行计划',
      });
    }
    const tasks = await this.prisma.planTask.findMany({
      where: { planId: plan.id },
      orderBy: { seq: 'asc' },
    });
    const assigneeMap = await this.resolveAssigneeOverview(taskId, tasks);
    return {
      id: plan.id,
      taskId: plan.taskId,
      title: plan.title,
      summary: plan.summary,
      scopeIn: plan.scopeIn,
      scopeOut: plan.scopeOut,
      status: plan.status,
      createdBy: plan.createdBy,
      reviewerInstanceId: plan.reviewerInstanceId,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      tasks: tasks.map((t) => this.toPlanTaskDto(t, assigneeMap)),
    };
  }

  /**
   * GET /plans/:id/tasks：查询计划子任务清单（项目成员，含 assignee 概览）。
   */
  async findTasks(planId: string, userId: string): Promise<PlanTaskDto[]> {
    const plan = await this.findPlanOrThrow(planId);
    await this.assertTaskMember(plan.taskId, userId);
    const tasks = await this.prisma.planTask.findMany({
      where: { planId },
      orderBy: { seq: 'asc' },
    });
    const assigneeMap = await this.resolveAssigneeOverview(plan.taskId, tasks);
    return tasks.map((t) => this.toPlanTaskDto(t, assigneeMap));
  }

  /**
   * PATCH /plans/:id/review：评审执行计划（REST 入口，项目成员可评审——FR-04 验收判定权在成员）。
   * 状态机：仅 reviewing 可评审（否则 400 PLAN_INVALID_STATUS）；rejected 无 reason → 400；
   * approved/rejected 更新 + reviewerInstanceId 置 null（R4，与 MCP plan_review 双入口一致）→
   * 群聊系统消息（驳回文案引导修改重提或切换 direct 模式，Oracle M5）。
   */
  async review(
    planId: string,
    userId: string,
    verdict: PlanReviewVerdict,
    reason?: string,
  ): Promise<{
    id: string;
    taskId: string;
    status: string;
    reviewerInstanceId: string | null;
  }> {
    const plan = await this.findPlanOrThrow(planId);
    await this.assertTaskMember(plan.taskId, userId);

    if (plan.status !== PLAN_STATUS.reviewing) {
      throw new BadRequestException({
        code: PLAN_ERRORS.PLAN_INVALID_STATUS,
        message: `执行计划当前状态（${plan.status}）不可评审，仅 reviewing 可评审`,
      });
    }
    if (verdict === 'rejected' && !(reason ?? '').trim()) {
      throw new BadRequestException({
        code: PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
        message: '评审驳回必须填写 reason',
      });
    }

    const approved = verdict === 'approved';
    const sysText = approved
      ? '执行计划已通过评审，可启动实施'
      : `执行计划被驳回：${reason}（可修改后重提或切换 direct 模式）`;
    const channel = await this.findTaskGroupChannel(plan.taskId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await tx.plan.update({
        where: { id: planId },
        data: {
          status: approved ? PLAN_STATUS.approved : PLAN_STATUS.rejected,
          reviewerInstanceId: null,
        },
      });
      if (channel) {
        await tx.message.create({
          data: {
            id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
            channelId: channel.id,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: sysText, parts: [] } as Prisma.InputJsonValue,
            mentions: null,
            status: MESSAGE_STATUS.sent,
          },
        });
      }
      return p;
    });

    if (channel) {
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: { text: sysText, channelId: channel.id } },
        { type: 'channel', id: channel.id },
      );
    }

    return {
      id: updated.id,
      taskId: updated.taskId,
      status: updated.status,
      reviewerInstanceId: updated.reviewerInstanceId,
    };
  }

  /**
   * 指派评审者（plan_assign_reviewer MCP 通道复用，无 userId——调用方已做主实例校验）。
   * 写入 plan.reviewerInstanceId + 群聊系统消息「已指派 <alias> 评审执行计划」；
   * 评审者须在任务团队未 removed（否则 400 PLAN_STRUCTURE_INVALID，对齐 plan_submit 指派语义）。
   */
  async assignReviewer(
    planId: string,
    reviewerInstanceId: string,
  ): Promise<{
    planId: string;
    taskId: string;
    reviewerInstanceId: string;
    reviewerAlias: string;
  }> {
    const plan = await this.findPlanOrThrow(planId);
    const reviewer = await this.prisma.taskAgent.findFirst({
      where: { id: reviewerInstanceId, taskId: plan.taskId, removedAt: null },
      select: { id: true, alias: true, agentId: true },
    });
    if (!reviewer) {
      throw new BadRequestException({
        code: PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
        message: `评审者不在任务团队中：${reviewerInstanceId}`,
      });
    }
    const alias = reviewer.alias ?? reviewer.agentId;
    const sysText = `已指派 ${alias} 评审执行计划`;
    const channel = await this.findTaskGroupChannel(plan.taskId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await tx.plan.update({
        where: { id: planId },
        data: { reviewerInstanceId },
      });
      if (channel) {
        await tx.message.create({
          data: {
            id: await this.idGen.nextId(MESSAGE_ID_PREFIX),
            channelId: channel.id,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: sysText, parts: [] } as Prisma.InputJsonValue,
            mentions: null,
            status: MESSAGE_STATUS.sent,
          },
        });
      }
      return p;
    });

    if (channel) {
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: { text: sysText, channelId: channel.id } },
        { type: 'channel', id: channel.id },
      );
    }

    return {
      planId: updated.id,
      taskId: updated.taskId,
      reviewerInstanceId: updated.reviewerInstanceId,
      reviewerAlias: alias,
    };
  }
}
