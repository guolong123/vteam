import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { FileStorageService } from '../uploads/uploads.service';
import { WorkerClient } from '../workers/worker.client';
import { PlanDocsService } from './plan-docs.service';

/**
 * 计划目录自动归档（session-right-panel-plan-overhaul Phase 3）。
 *
 * 背景：计划内容其实产出了（任务目录 `.omo/plans` / `.opencode/plans` /
 * `.omo/drafts` 下的 `*.md`），但 agent 不调 `submit_artifact` 就永远进不了
 * 产出物库，计划 Tab 一直空。本服务做系统侧兜底：任务进入 `pending_review`
 * 时（`accept` 幂等兜底）把三处计划目录的 `*.md` 经既有 `archiveFile`
 * 落进产出物库并打上 `category:'计划'`。
 *
 * 约束：
 * - 触发只在写路径（markPendingReview/accept 状态落库成功后 fire-and-forget），
 *   本方法绝不在任何 GET handler / 读路径被调用（读路径写库有副作用且随轮询反复触发）；
 * - worker 定位复用 `PlanDocsService.locateWorkerForTask`（与读路径同一套，不复制）；
 * - 归档复用 `ArtifactsService.archiveFile` 的 sha256 去重语义（重复内容 → duplicate
 *   计 skipped，版本不涨；`accept` 兜底再扫天然幂等）；
 * - 单文件失败只 warn 计 `failed`，整体方法绝不抛错（扫描失败不得改变 HTTP 结果、
 *   不得回滚状态迁移）；
 * - 归档类型恒为 file（由 `archiveFile` 内部固定），不引入新的产出物类型；
 */
@Injectable()
export class PlanArchiveService {
  private readonly logger = new Logger(PlanArchiveService.name);

  constructor(
    private readonly planDocs: PlanDocsService,
    private readonly workerClient: WorkerClient,
    private readonly artifactsService: ArtifactsService,
  ) {}

  async scanAndArchivePlanDocs(
    taskId: string,
  ): Promise<{ archived: number; skipped: number; failed: number }> {
    const zero = { archived: 0, skipped: 0, failed: 0 };
    try {
      const directory = this.planDocs.taskDirectory(taskId);
      const located = await this.planDocs.locateWorkerForTask(taskId);
      if (!located) {
        this.logger.warn(
          `计划自动归档跳过 task=${taskId}（未定位到可用 worker）`,
        );
        return zero;
      }
      let files: Array<{
        name: string;
        updatedAt: string;
        size: number;
        content: string;
        truncated: boolean;
      }>;
      try {
        files = await this.workerClient.listPlanFiles(
          located.worker,
          directory,
        );
      } catch (err) {
        this.logger.warn(
          `计划自动归档读取计划目录失败 task=${taskId}（不阻断）：${err instanceof Error ? err.message : String(err)}`,
        );
        return zero;
      }
      if (!files || files.length === 0) {
        return zero;
      }
      let archived = 0;
      let skipped = 0;
      let failed = 0;
      const dirPrefix = directory.replace(/\/+$/, '');
      for (const file of files) {
        const fileRef = `${dirPrefix}/${file.name}`;
        try {
          // 完整正文：列表截断时经 /file 拉原文（对齐 fetchAndArchiveAttachment
          // worker 拉取→落盘→归档链路），否则直接用列表下发 content。
          let content = file.content ?? '';
          if (file.truncated) {
            const buffer = await this.workerClient.fetchFile(
              located.worker,
              fileRef,
            );
            content = buffer.toString('utf8');
          }
          const sha256 = createHash('sha256').update(content).digest('hex');
          const stored = await FileStorageService.saveTextFile(
            content,
            file.name,
          );
          const result = await this.artifactsService.archiveFile(taskId, {
            fileRef,
            storedUrl: stored.url,
            storedName: stored.name,
            sha256,
            title: file.name,
            category: '计划',
          });
          if (result.status === 'duplicate') {
            skipped += 1;
          } else {
            archived += 1;
          }
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `计划自动归档单文件失败 task=${taskId} file=${file.name}（继续下一个）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { archived, skipped, failed };
    } catch (err) {
      this.logger.warn(
        `计划自动归档整体失败 task=${taskId}（不阻断）：${err instanceof Error ? err.message : String(err)}`,
      );
      return zero;
    }
  }
}
