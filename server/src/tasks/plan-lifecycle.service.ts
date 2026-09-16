import { Injectable, Logger } from '@nestjs/common';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 计划生命周期状态（schema.prisma Plan.status 字符串枚举，
 * draft/reviewing/approved/rejected/executing/completed，双库兼容不声明 Prisma enum）。
 */
export const PLAN_LIFECYCLE_STATUS = {
  draft: 'draft',
  reviewing: 'reviewing',
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
 * plans 表唯一读写 choke 点（todo2 复活，守卫窄豁免仅覆盖本文件）。
 *
 * 约束：本文件只碰 plans 表；子任务表读写仍全禁（守卫即红），
 * 团队删除级联（teams.service）保持原样不扩散。
 */
@Injectable()
export class PlanLifecycleService {
  private readonly logger = new Logger(PlanLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
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
    opts?: { confirmedBy?: string | null; rejectReason?: string | null },
  ) {
    this.verifyEnum(to);
    return this.prisma.plan.update({
      where: { taskId },
      data: {
        status: to,
        ...(opts?.confirmedBy !== undefined
          ? { confirmedBy: opts.confirmedBy }
          : {}),
        ...(opts?.rejectReason !== undefined
          ? { rejectReason: opts.rejectReason }
          : {}),
      },
    });
  }
}
