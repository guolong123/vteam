import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient, WorkerTodoInfo } from '../workers/worker.client';

/**
 * 计划执行步骤查询结果（GET /tasks/:id/plan-steps）。
 * degraded=true 表示未能取到真实清单（无主 Agent / 无会话 / worker 离线），
 * steps 为空数组——前端据此提示"暂不可用"而非"暂无步骤"，避免误导用户。
 * 注意与"agent 还没用 todo 工具"区分：后者 degraded=false + steps=[]，
 * 前端显示"暂无执行步骤（agent 拆解后自动出现）"。
 */
export interface PlanStepsResult {
  steps: WorkerTodoInfo[];
  /** 实际取数的 worker id；降级且未定位到 worker 时为 null。 */
  workerId: string | null;
  degraded: boolean;
}

/**
 * 计划步骤服务：任务 → 主 Agent 成员 session → opencode serve todo。
 *
 * 定位链：task.teamId → team.mainAgentMemberId → session（teamId + teamMemberId，
 * 取最近更新的一条，要求 workerId + instanceRef 非空）→ worker 行 capabilities →
 * WorkerClient.listTodos（→ worker GET /todos → serve GET /session/{id}/todo）。
 *
 * 任一环节缺失 → degraded（不抛错，列表类端点不阻断页面，对齐 listOpencodeAgents）。
 * worker 行 status 非 online → 直接 degraded，不再下发调用（避免把"不可达"误报成"无步骤"）。
 */
@Injectable()
export class PlanStepsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workerClient: WorkerClient,
  ) {}

  async listPlanSteps(taskId: string): Promise<PlanStepsResult> {
    try {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { id: true, teamId: true },
      });
      if (!task?.teamId) {
        return { steps: [], workerId: null, degraded: true };
      }
      const team = await this.prisma.team.findUnique({
        where: { id: task.teamId },
        select: { mainAgentMemberId: true },
      });
      if (!team?.mainAgentMemberId) {
        return { steps: [], workerId: null, degraded: true };
      }
      const session = await this.prisma.session.findFirst({
        where: {
          teamId: task.teamId,
          teamMemberId: team.mainAgentMemberId,
        },
        orderBy: { updatedAt: 'desc' },
        select: { workerId: true, instanceRef: true },
      });
      if (!session?.workerId || !session?.instanceRef) {
        return { steps: [], workerId: null, degraded: true };
      }
      const worker = await this.prisma.worker.findUnique({
        where: { id: session.workerId },
        select: { id: true, status: true, capabilities: true },
      });
      // worker 行缺失/明确离线 → degraded；online/degraded 均可下发
      // （degraded 只是调度降权，不代表不可达，见 workers.service 心跳逻辑）。
      if (!worker || worker.status === 'offline') {
        return { steps: [], workerId: worker?.id ?? null, degraded: true };
      }
      // directory 不传：todo 按 opencode 会话 id（instanceRef）定位，
      // 与 serve cwd 无关（同 /agent 的 per-directory 发现语义不同）。
      const steps = await this.workerClient.listTodos(
        { id: worker.id, capabilities: worker.capabilities },
        session.instanceRef,
      );
      return { steps, workerId: worker.id, degraded: false };
    } catch {
      return { steps: [], workerId: null, degraded: true };
    }
  }
}
