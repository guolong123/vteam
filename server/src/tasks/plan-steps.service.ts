import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLifecycleService } from './plan-lifecycle.service';

/**
 * 计划执行步骤域（plan_tasks 的唯一 choke 点；服务端读 + MCP 写共用）。
 *
 * 为什么不用 opencode todos（2026-09-23 用户决策，vteam_todo 复活 plan_tasks）：
 * todos 是**会话级**——换会话/重置即丢（实测重置 PM 会话丢过一次）、跨成员与跨任务不可见、
 * 且平台注入的工具清单里根本没有 todo 写入工具（tools 表 0 条）→ 执行步骤卡恒 0 项。
 * `plan_tasks` 表（plan_id/seq/title/content/assignee/status，含 uk_plan_tasks_plan_seq
 * 唯一约束）当初就是为结构化步骤建的，0 行从没写过——补上写入工具即可承载该功能。
 *
 * 读路径语义（对齐前端）：无 plan 行 = 尚未拆解 → `{steps: [], degraded: false}`
 * （不是降级，前端据此显示「暂无执行步骤（agent 拆解后自动出现）」）；查询异常才 degraded。
 *
 * status 词表 = PlanTask.status 注释契约：pending / in_progress / done / blocked / skipped。
 */

/** 单个步骤的对外视图（`content` 恒为字符串，与前端 PlanStepItem 对齐）。 */
export interface PlanStepView {
  id: string;
  seq: number;
  title: string;
  content: string;
  status: string;
  assignee: string | null;
}

/** GET /tasks/:id/plan-steps 响应（形状保持不变，前端零改动）。 */
export interface PlanStepsResult {
  steps: PlanStepView[];
  /** 已废弃（opencode todos 链下线）：恒 null，保留字段以兼容既有前端消费方。 */
  workerId: string | null;
  /** true = 取数异常（查询失败）；无步骤且非异常时为 false。 */
  degraded: boolean;
}

export type PlanStepStatus =
  'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped';

@Injectable()
export class PlanStepsService implements OnModuleInit {
  private readonly logger = new Logger(PlanStepsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    @Optional()
    private readonly planLifecycle?: PlanLifecycleService,
  ) {}

  /**
   * 进程启动：按库内 pt_ 前缀纯数字序号最大值对齐 id 生成器。
   * 不对齐则重启后 nextId 会从 1 重来、撞既有主键 P2002（id-resync 守卫强制本对齐点）。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.planTask, 'pt', this.idGen);
  }

  /** content JSON（可能是 `{text}` 或纯串）→ 字符串；空则用 title 兜底。 */
  private contentTextOf(value: unknown, title: string): string {
    let text = '';
    if (typeof value === 'string') {
      text = value;
    } else if (value && typeof value === 'object') {
      const v = (value as { text?: unknown }).text;
      if (typeof v === 'string') text = v;
    }
    return text ? `${title} — ${text}` : title;
  }

  private mapStep(t: {
    id: string;
    seq: number;
    title: string;
    content: unknown;
    status: string;
    assigneeInstanceId: string | null;
  }): PlanStepView {
    return {
      id: t.id,
      seq: t.seq,
      title: t.title,
      content: this.contentTextOf(t.content, t.title),
      status: t.status,
      assignee: t.assigneeInstanceId,
    };
  }

  private readonly stepSelect = {
    id: true,
    seq: true,
    title: true,
    content: true,
    status: true,
    assigneeInstanceId: true,
  } as const;

  /** 读（REST）：降级语义只在查询异常时 true；无 plan 行=未拆解，非降级。 */
  async listPlanSteps(taskId: string): Promise<PlanStepsResult> {
    try {
      return {
        steps: await this.listSteps(taskId),
        workerId: null,
        degraded: false,
      };
    } catch {
      return { steps: [], workerId: null, degraded: true };
    }
  }

  /** 读（MCP list）：无 plan 行返回空数组（不是错误，拆解后自然出现）；seq 升序为 API 契约，服务侧自排序。 */
  async listSteps(taskId: string): Promise<PlanStepView[]> {
    const plan = await this.prisma.plan.findUnique({
      where: { taskId },
      select: { planTasks: { orderBy: { seq: 'asc' } } },
    });
    return (plan?.planTasks ?? [])
      .map((t) => this.mapStep(t))
      .sort((a, b) => a.seq - b.seq);
  }

  /**
   * 写（MCP write）：planId+seq 有唯一约束 → compound upsert（同键覆盖）。
   * seq 缺省取 max(seq)+1；plan 行缺失先 autoEnsureRow 兜底建行。
   */
  async writeStep(
    taskId: string,
    input: {
      seq?: number;
      title: string;
      content?: string;
      status?: PlanStepStatus;
      assignee?: string;
    },
  ): Promise<PlanStepView> {
    const title = input.title.trim();
    if (!title) {
      throw new BadRequestException('步骤 title 不能为空');
    }
    let planRow: { id: string } | null = null;
    try {
      planRow = this.planLifecycle
        ? ((await this.planLifecycle.autoEnsureRow(taskId)) as { id: string })
        : null;
    } catch (err) {
      this.logger.warn(
        `plan 行兜底建行失败 task=${taskId}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!planRow) {
      throw new NotFoundException({
        code: 'PLATFORM_MCP_TASK_NOT_FOUND',
        message: '计划行不存在且无法创建，暂不可写入步骤',
      });
    }
    let seq = input.seq;
    if (typeof seq !== 'number') {
      const agg = await this.prisma.planTask.aggregate({
        where: { planId: planRow.id },
        _max: { seq: true },
      });
      seq = (agg._max.seq ?? 0) + 1;
    }
    const data = {
      title,
      content: { text: input.content ?? '' },
      status: input.status ?? 'pending',
      assigneeInstanceId: input.assignee ?? null,
    };
    const row = await this.prisma.planTask.upsert({
      where: { planId_seq: { planId: planRow.id, seq } },
      create: {
        id: await this.idGen.nextId('pt'),
        planId: planRow.id,
        seq,
        ...data,
      },
      update: data,
    });
    return this.mapStep(row);
  }

  /** 完成（MCP done）：按 planId+seq 定位（miss → 404）。 */
  async markDone(taskId: string, seq: number): Promise<PlanStepView> {
    const plan = await this.prisma.plan.findUnique({
      where: { taskId },
      select: { id: true },
    });
    const step = plan
      ? await this.prisma.planTask.findUnique({
          where: { planId_seq: { planId: plan.id, seq } },
        })
      : null;
    if (!step) {
      throw new NotFoundException({
        code: 'PLATFORM_MCP_PLAN_STEP_NOT_FOUND',
        message: `步骤 seq=${seq} 不存在（先用 action=list 看现有步骤）`,
      });
    }
    const updated = await this.prisma.planTask.update({
      where: { id: step.id },
      data: { status: 'done' },
    });
    return this.mapStep(updated);
  }
}
