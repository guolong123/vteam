import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient, WorkerPlanFileInfo } from '../workers/worker.client';
import { DEFAULT_TASK_WORK_DIR, taskDirOf } from './work-dir.util';

/**
 * 计划文档查询结果（GET /tasks/:id/plan-docs）。
 *
 * degraded=true 表示读不到（未配置任务目录 / 团队无主 Agent / 无会话 / worker 离线），
 * files 为空数组——前端据此提示"暂不可用"而非"暂无计划"，避免误导用户
 * （与 plan-steps 的 degraded 语义一致）。
 * degraded=false + files=[] 才是"确实还没有计划"。
 */
export interface PlanDocsResult {
  files: WorkerPlanFileInfo[];
  /** 实际取数的 worker id；降级且未定位到 worker 时为 null。 */
  workerId: string | null;
  /** 任务工作目录（上传计划文件的落点，前端回显用）。 */
  directory: string | null;
  degraded: boolean;
}

/**
 * 计划文档服务：任务目录 `.opencode/plans/*.md` ↔ opencode agent 的唯一交换点。
 *
 * 设计约束（重要）：**vteam 不维护任何计划状态**。不落库、不建版本、不生成内容；
 * 计划文件是真相，由 opencode agent 自己写（或用户上传），本服务只做搬运：
 *   - 读：WorkerClient.listPlanFiles → worker GET /plan-files → 任务目录直读
 *   - 写：WorkerClient.writePlanFile → worker POST /plan-file → 落进同一目录
 *
 * 目录定位与执行期一致：`<WORK_DIR>/tasks/<taskId>`（worker-dispatcher 同款约定），
 * 这样 agent 执行时写的 `.opencode/plans/` 与页面读的必然是同一个目录。
 *
 * 定位链（读）：task.teamId → team.mainAgentMemberId → session(workerId) → worker 行
 * （capabilities）→ listPlanFiles。任一环节缺失 → degraded（不抛错，列表类端点
 * 不阻断页面）。
 */
@Injectable()
export class PlanDocsService {
  private readonly logger = new Logger(PlanDocsService.name);
  private readonly taskWorkDirRoot: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workerClient: WorkerClient,
    config: ConfigService,
  ) {
    const workDir = config.get<string>('WORK_DIR');
    this.taskWorkDirRoot =
      typeof workDir === 'string' && workDir.trim()
        ? workDir.trim()
        : DEFAULT_TASK_WORK_DIR;
  }

  /** 任务工作目录（与 worker-dispatcher resolveAgentWorkDir 同款拼接，确保同落点）。 */
  taskDirectory(taskId: string): string {
    return taskDirOf(this.taskWorkDirRoot, taskId);
  }

  /**
   * 列出任务目录下的计划文档。
   * 降级（返回 degraded=true）场景：任务不存在/无团队、无主 Agent、无会话、worker 行缺失
   * 或 offline。目录不存在不算降级（worker 侧返回空列表）——"还没写过计划"是常态。
   */
  async listPlanDocs(taskId: string): Promise<PlanDocsResult> {
    const directory = this.taskDirectory(taskId);
    try {
      const located = await this.locateWorker(taskId);
      if (!located) {
        return { files: [], workerId: null, directory, degraded: true };
      }
      const files = await this.workerClient.listPlanFiles(located.worker, directory);
      return { files, workerId: located.worker.id, directory, degraded: false };
    } catch (err) {
      this.logger.warn(
        `计划文档列表失败 task=${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { files: [], workerId: null, directory, degraded: true };
    }
  }

  /**
   * 写入（或覆盖）一份计划文档。
   *
   * 与 listPlanDocs 相反，这是写路径：定位失败/worker 不可达一律抛出，
   * 由 controller 映射为 HTTP 错误（用户上传后必须有明确成败反馈，
   * 不能像列表那样静默降级成"空计划"）。
   */
  async writePlanDoc(
    taskId: string,
    input: { name: string; content: string },
  ): Promise<{ name: string; updatedAt: string; directory: string }> {
    const directory = this.taskDirectory(taskId);
    const located = await this.locateWorker(taskId);
    if (!located) {
      throw new Error('未定位到可用的 worker（团队无主 Agent / 无会话 / worker 离线）');
    }
    const written = await this.workerClient.writePlanFile(located.worker, {
      directory,
      name: input.name,
      content: input.content,
    });
    return { ...written, directory };
  }

  /**
   * 任务 → 团队主 Agent 成员 → 会话 → worker 行（含 capabilities）。
   *
   * ⚠️ 必须把 capabilities 一并取出：WorkerClient 的 exec base URL 由 capabilities 决定，
   * 只传 {id} 会静默回落到 localhost:4199（listOpencodeAgents 本地部署踩过同类 bug）。
   */
  private async locateWorker(
    taskId: string,
  ): Promise<{
    worker: { id: string; capabilities: unknown };
  } | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, teamId: true },
    });
    if (!task?.teamId) {
      return null;
    }
    const team = await this.prisma.team.findUnique({
      where: { id: task.teamId },
      select: { mainAgentMemberId: true },
    });
    if (!team?.mainAgentMemberId) {
      return null;
    }
    const session = await this.prisma.session.findFirst({
      where: { teamId: task.teamId, teamMemberId: team.mainAgentMemberId },
      orderBy: { updatedAt: 'desc' },
      select: { workerId: true },
    });
    if (!session?.workerId) {
      return null;
    }
    const worker = await this.prisma.worker.findUnique({
      where: { id: session.workerId },
      select: { id: true, status: true, capabilities: true },
    });
    // worker 行缺失/明确离线 → 降级；online/degraded 均可下发
    // （degraded 只是调度降权，不代表不可达）。
    if (!worker || worker.status === 'offline') {
      return null;
    }
    return { worker: { id: worker.id, capabilities: worker.capabilities } };
  }
}
