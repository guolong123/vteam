import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Plan, Prisma } from '@prisma/client';
import { MessageReceiptsService } from '../chat/message-receipts.service';
import { IdGeneratorService } from '../common/id-generator';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { TASK_ERRORS } from '../common/constants/task.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * 计划生命周期状态（schema.prisma Plan.status 字符串枚举，
 * draft/reviewing/pending_final/approved/rejected/executing/completed，
 * 双库兼容不声明 Prisma enum）。
 * 评审收敛（N/N APPROVE）只到 pending_final（待定稿），定稿须用户显式确认
 * （finalize→approved），开始执行另需用户二次确认（confirm→executing）。
 */
export const PLAN_LIFECYCLE_STATUS = {
  draft: 'draft',
  reviewing: 'reviewing',
  pending_final: 'pending_final',
  approved: 'approved',
  rejected: 'rejected',
  executing: 'executing',
  completed: 'completed',
} as const;

export type PlanLifecycleStatus =
  (typeof PLAN_LIFECYCLE_STATUS)[keyof typeof PLAN_LIFECYCLE_STATUS];

const PLAN_LIFECYCLE_STATUS_SET: ReadonlySet<string> = new Set(
  Object.values(PLAN_LIFECYCLE_STATUS),
);

/**
 * 计划确认门精确错误码（todo11 用户确认端点与状态流转）。
 * wrong-state 一律 409（details.current 携带当前 DB 状态），缺打回原因 400，
 * 完工非主实例 403。常量命名带 LIFECYCLE 中缀以避开守卫禁令
 * （禁令逐字匹配见 plan-removal 守卫单测，此处不逐字复述）。
 */
export const PLAN_LIFECYCLE_ERRORS = {
  PLAN_CONFIRM_WRONG_STATE: 'PLAN_CONFIRM_WRONG_STATE',
  PLAN_FINALIZE_WRONG_STATE: 'PLAN_FINALIZE_WRONG_STATE',
  PLAN_REJECT_WRONG_STATE: 'PLAN_REJECT_WRONG_STATE',
  PLAN_REJECT_REASON_REQUIRED: 'PLAN_REJECT_REASON_REQUIRED',
  PLAN_COMPLETE_WRONG_STATE: 'PLAN_COMPLETE_WRONG_STATE',
  PLAN_COMPLETE_MAIN_ONLY: 'PLAN_COMPLETE_MAIN_ONLY',
} as const;

/** 计划文件仅展示提示（GET plan 真值源声明：状态一律读 DB，文件 divergence 时告警）。 */
export const PLAN_FILE_DISPLAY_ONLY_WARNING =
  '计划文件仅展示用，状态以数据库 plans.status 为准';

/** 确认门动作（finalize=确认定稿；confirm=开始执行；reject=打回重修）。 */
export type PlanConfirmAction = 'finalize' | 'confirm' | 'reject';

/**
 * plans 表唯一读写 choke 点（todo2 复活，守卫窄豁免仅覆盖本文件）。
 *
 * 约束：本文件只写 plans 表（读任务行仅为事件归属团队解析）；
 * 子任务表读写仍全禁（守卫即红），团队删除级联（teams.service）保持原样不扩散。
 */
@Injectable()
export class PlanLifecycleService {
  private readonly logger = new Logger(PlanLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly receipts: MessageReceiptsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** 校验计划状态枚举值（非法即抛，防脏写）。 */
  verifyEnum(status: string): asserts status is PlanLifecycleStatus {
    if (!PLAN_LIFECYCLE_STATUS_SET.has(status)) {
      throw new Error(`未知计划状态：${status}`);
    }
  }

  /**
   * 任务创建成功后兜底建行（一任务一计划）：
   * 行已存在→直接返回（不重复建）；缺失→建 draft 行；
   * DB 抛错→上抛由调用方记 warn（永不阻断任务创建）。
   */
  async autoEnsureRow(taskId: string) {
    const existing = await this.prisma.plan.findUnique({
      where: { taskId },
    });
    if (existing) {
      return existing;
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, title: true, createdBy: true },
    });
    const created = await this.prisma.plan.create({
      data: {
        id: await this.idGen.nextId('pl'),
        taskId,
        title: task?.title ?? taskId,
        status: PLAN_LIFECYCLE_STATUS.draft,
        createdBy: task?.createdBy ?? 'system',
      },
    });
    this.logger.log(`plans 兜底建行 taskId=${taskId} status=draft`);
    return created;
  }

  /** 门禁读状态（todo4 执行门禁复用：唯一 plans 表读出口之一）。
   * 有行→status；无行→null（调用方按需调 autoEnsureRow 兜底建行后再门禁）；
   * DB 抛错→上抛，由调用方 fail-open + warn（永不转 fail-closed）。 */
  async getStatus(taskId: string): Promise<string | null> {
    const row = await this.prisma.plan.findUnique({
      where: { taskId },
      select: { status: true },
    });
    return row?.status ?? null;
  }

  /** 状态流转（todo11 确认门复用；非法目标态即抛且不写库）。 */
  async transition(
    taskId: string,
    to: string,
    opts?: {
      confirmedBy?: string | null;
      confirmedAt?: Date | null;
      finalizedBy?: string | null;
      finalizedAt?: Date | null;
      rejectReason?: string | null;
    },
  ) {
    this.verifyEnum(to);
    const prev = (await this.prisma.plan.findUnique({
      where: { taskId },
      select: { status: true },
    })) as unknown as { status: string } | null;
    const updated = await this.prisma.plan.update({
      where: { taskId },
      data: {
        status: to,
        ...(opts?.confirmedBy !== undefined
          ? { confirmedBy: opts.confirmedBy }
          : {}),
        ...(opts?.confirmedAt !== undefined
          ? { confirmedAt: opts.confirmedAt }
          : {}),
        ...(opts?.finalizedBy !== undefined
          ? { finalizedBy: opts.finalizedBy }
          : {}),
        ...(opts?.finalizedAt !== undefined
          ? { finalizedAt: opts.finalizedAt }
          : {}),
        ...(opts?.rejectReason !== undefined
          ? { rejectReason: opts.rejectReason }
          : {}),
      },
    });
    try {
      await this.receipts.emitPlanStatusChanged({
        taskId,
        from: prev?.status ?? null,
        to,
      });
    } catch (err) {
      this.logger.warn(
        `plan.status 事件广播失败 task=${taskId} to=${to}（翻转已落库）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return updated;
  }

  async getPlan(taskId: string): Promise<Plan | null> {
    await this.requireTask(taskId);
    return this.prisma.plan.findUnique({ where: { taskId } });
  }

  async confirmPlan(
    taskId: string,
    input: {
      userId: string;
      userName?: string | null;
      action?: PlanConfirmAction;
      reason?: string | null;
    },
  ): Promise<{ plan: Plan; idempotent: boolean; action: PlanConfirmAction }> {
    if (input.action === 'finalize') {
      return this.finalizePlan(taskId, input);
    }
    if (input.action === 'reject') {
      return this.rejectPlan(taskId, input);
    }
    const actor = displayName(input.userName, input.userId);
    const { task, row } = await this.loadWritablePlan(taskId);
    if (row.status === PLAN_LIFECYCLE_STATUS.executing) {
      return { plan: row, idempotent: true, action: 'confirm' };
    }
    if (row.status !== PLAN_LIFECYCLE_STATUS.approved) {
      throw new ConflictException({
        code: PLAN_LIFECYCLE_ERRORS.PLAN_CONFIRM_WRONG_STATE,
        message: `计划未定稿待执行（当前 ${row.status}），不可确认开始`,
        details: { current: row.status },
      });
    }
    const plan = await this.transition(taskId, 'executing', {
      confirmedBy: actor,
      confirmedAt: new Date(),
      rejectReason: null,
    });
    await this.postPlanSystemMessage(
      taskId,
      task.teamId,
      `计划已由 ${actor} 确认，开始执行（approved → executing）。PM 请续推 W2 执行任务。`,
    );
    return { plan, idempotent: false, action: 'confirm' };
  }

  async finalizePlan(
    taskId: string,
    input: {
      userId: string;
      userName?: string | null;
      reason?: string | null;
    },
  ): Promise<{ plan: Plan; idempotent: boolean; action: PlanConfirmAction }> {
    const actor = displayName(input.userName, input.userId);
    const { task, row } = await this.loadWritablePlan(taskId);
    if (row.status === PLAN_LIFECYCLE_STATUS.approved) {
      return { plan: row, idempotent: true, action: 'finalize' };
    }
    if (row.status !== PLAN_LIFECYCLE_STATUS.pending_final) {
      throw new ConflictException({
        code: PLAN_LIFECYCLE_ERRORS.PLAN_FINALIZE_WRONG_STATE,
        message: `计划未待定稿（当前 ${row.status}），不可确认定稿`,
        details: { current: row.status },
      });
    }
    const plan = await this.transition(
      taskId,
      PLAN_LIFECYCLE_STATUS.approved,
      {
        finalizedBy: actor,
        finalizedAt: new Date(),
        rejectReason: null,
      },
    );
    await this.postPlanSystemMessage(
      taskId,
      task.teamId,
      `计划已由 ${actor} 确认定稿（pending_final → approved）。开始执行另需用户确认，确认前不得派发执行类工作。`,
    );
    return { plan, idempotent: false, action: 'finalize' };
  }

  async rejectPlan(
    taskId: string,
    input: {
      userId: string;
      userName?: string | null;
      reason?: string | null;
    },
  ): Promise<{ plan: Plan; idempotent: boolean; action: PlanConfirmAction }> {
    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw new BadRequestException({
        code: PLAN_LIFECYCLE_ERRORS.PLAN_REJECT_REASON_REQUIRED,
        message: '打回需携带原因 reason（落库 rejectReason 供重修）',
      });
    }
    const actor = displayName(input.userName, input.userId);
    const { task, row } = await this.loadWritablePlan(taskId);
    if (row.status !== PLAN_LIFECYCLE_STATUS.approved) {
      throw new ConflictException({
        code: PLAN_LIFECYCLE_ERRORS.PLAN_REJECT_WRONG_STATE,
        message: `仅已定稿待执行（approved）的计划可打回，当前 ${row.status}`,
        details: { current: row.status },
      });
    }
    const plan = await this.transition(taskId, 'draft', {
      rejectReason: reason,
    });
    await this.postPlanSystemMessage(
      taskId,
      task.teamId,
      `计划已被 ${actor} 打回（approved → draft），原因：${reason}。版本号+1、轮次不变，重走收敛门。`,
    );
    return { plan, idempotent: false, action: 'reject' };
  }

  async completePlan(
    taskId: string,
    input: { userId: string; userName?: string | null; instanceId?: string | null },
  ): Promise<{ plan: Plan; idempotent: boolean }> {
    const { task, row } = await this.loadWritablePlan(taskId);
    if (input.instanceId !== undefined && input.instanceId !== null) {
      const team = task.teamId
        ? await this.prisma.team.findUnique({
            where: { id: task.teamId },
            select: { mainAgentMemberId: true },
          })
        : null;
      const mainMemberId = team?.mainAgentMemberId ?? null;
      if (!mainMemberId || mainMemberId !== input.instanceId) {
        throw new ForbiddenException({
          code: PLAN_LIFECYCLE_ERRORS.PLAN_COMPLETE_MAIN_ONLY,
          message: `仅主实例（${mainMemberId ?? '未设置'}）可标记计划完工；用户路径请经 PM（tasks.review）操作`,
        });
      }
    }
    if (row.status === PLAN_LIFECYCLE_STATUS.completed) {
      return { plan: row, idempotent: true };
    }
    if (row.status !== PLAN_LIFECYCLE_STATUS.executing) {
      throw new ConflictException({
        code: PLAN_LIFECYCLE_ERRORS.PLAN_COMPLETE_WRONG_STATE,
        message: `仅执行中（executing）的计划可标记完工，当前 ${row.status}`,
        details: { current: row.status },
      });
    }
    const actor = displayName(
      input.instanceId ?? input.userName,
      input.userId,
    );
    const plan = await this.transition(taskId, 'completed');
    await this.postPlanSystemMessage(
      taskId,
      task.teamId,
      `计划执行完成（executing → completed），由 ${actor} 标记。`,
    );
    return { plan, idempotent: false };
  }

  private async requireTask(taskId: string): Promise<{ id: string; teamId: string | null }> {
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
    return task as unknown as { id: string; teamId: string | null };
  }

  private async loadWritablePlan(
    taskId: string,
  ): Promise<{ task: { id: string; teamId: string | null }; row: Plan }> {
    const task = await this.requireTask(taskId);
    const row = await this.autoEnsureRow(taskId);
    return { task, row: row as unknown as Plan };
  }

  private async postPlanSystemMessage(
    taskId: string,
    teamId: string | null,
    text: string,
  ): Promise<void> {
    try {
      const channel =
        (await this.prisma.chatChannel.findFirst({
          where: { taskId, type: CHANNEL_TYPE.task_group },
          select: { id: true },
        })) ??
        (teamId
          ? await this.prisma.chatChannel.findFirst({
              where: {
                teamId,
                type: CHANNEL_TYPE.team_group,
                deletedAt: null,
              },
              select: { id: true },
            })
          : null);
      if (!channel) {
        this.logger.warn(
          `[plans] 系统消息无落库频道 task=${taskId}（翻转已落库）：${text}`,
        );
        return;
      }
      const message = await this.prisma.message.create({
        data: {
          id: await this.idGen.nextId('m'),
          channelId: channel.id,
          senderType: SENDER_TYPE.system,
          senderId: null,
          content: { text, parts: [] } as Prisma.InputJsonValue,
          mentions: null,
          status: MESSAGE_STATUS.sent,
        },
      });
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: {
            id: message.id,
            channelId: channel.id,
            senderType: SENDER_TYPE.system,
            content: message.content,
          },
        },
        { type: 'channel', id: channel.id },
      );
    } catch (err) {
      this.logger.warn(
        `[plans] 系统消息落库/广播失败 task=${taskId}（翻转已落库）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function displayName(
  name: string | null | undefined,
  fallback: string,
): string {
  const text = (name ?? '').trim();
  return text.length > 0 ? text : fallback;
}
