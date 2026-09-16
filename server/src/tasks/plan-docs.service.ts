import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReviewRoundService } from '../issues/review-round.service';
import { computePlanHash, tryParseLedger } from '../issues/review-round-ledger';
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
 * 设计约束（重要）：**工作区计划文件是起草真相，冻结正式版以 DB+哈希为准**。
 * 本服务不维护执行态：不落执行状态、不建版本、不生成内容，只做搬运；
 * 起草阶段计划文件是真相，由 opencode agent 自己写（或用户上传）；
 * 一经定稿冻结，执行门禁只认冻结版（DB 行 + planVersion.hash 双锚），
 * 文件侧后续改动须走修订重评小循环并重新冻结方能执行：
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
    // todo 2 哈希钩接线：落盘成功后经 applyRoundUpdate 回填 planVersion.hash
    //（TasksModule imports IssuesModule，无 Nest 环：IssuesModule 只依赖 RealtimeModule）。
    private readonly rounds: ReviewRoundService,
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
    await this.backfillPlanHash(taskId, input.content);
    return { ...written, directory };
  }

  /**
   * 哈希计算钩（todo 2 接线点写死）：计划员修订落盘后读内容算 sha1 前 8，
   * 经 applyRoundUpdate（串行写唯一入口）回填宿主 issue 账本 planVersion.hash。
   * hash-only 补丁不碰 version（merge 只升不降）；无宿主/回填失败只 warn，
   * 永不阻断上传返回（缺失语义由账本层 pending-hash 承接）。
   */
  private async backfillPlanHash(taskId: string, content: string): Promise<void> {
    try {
      const hostIssueId = await this.findHostIssueId(taskId);
      if (!hostIssueId) {
        this.logger.warn(
          `[plans] 哈希回填跳过 task=${taskId}（无轮次账本宿主 issue，hash 缺失走 pending-hash）`,
        );
        return;
      }
      await this.rounds.applyRoundUpdate(hostIssueId, {
        planVersion: { hash: computePlanHash(content) },
      });
    } catch (err) {
      this.logger.warn(
        `[plans] 哈希回填失败 task=${taskId}（上传已落盘）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async findHostIssueId(taskId: string): Promise<string | null> {
    const rows = (await this.prisma.issue.findMany({
      where: { taskId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      select: { id: true, description: true },
    })) as unknown as Array<{ id: string; description?: string | null }>;
    for (const row of rows ?? []) {
      if (tryParseLedger(row?.description ?? null)) return row.id;
    }
    return null;
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
