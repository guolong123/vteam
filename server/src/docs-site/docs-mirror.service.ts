import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../uploads/uploads.service';
import { resolveDocsRoot } from './docs-site.constants';

/**
 * F1 镜像导出层（is_0000000024）：任务 doc 产出物 → 文档站镜像 .md。
 *
 * 原则（art_0000000026）：镜像 = **派生视图**，权威在 DB(artifacts)+uploads。
 * - 只处理 type=doc（AC-6：text/file 不入站）；
 * - 读 uploads 正文（contentRef=/uploads/...）→ 写 `<docsRoot>/<taskId>/<slug>.md`；
 * - frontmatter 注入 `title` + 英文 `id`（规避 prototype-viewer 中文 id hash 路由 bug）；
 * - 幂等：按 (taskId, title) 覆盖写最新版本（AC-5），历史版本不走文档站；
 * - 可全量重建（扫描 artifacts 表），不新增 DB 表（AC-8）。
 */
@Injectable()
export class DocsMirrorService implements OnModuleDestroy {
  private readonly logger = new Logger(DocsMirrorService.name);
  private readonly docsRoot: string;
  /** 串行重建锁（防归档事件并发触发镜像写竞争）。 */
  private rebuildLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const root = config.get<string>('MD_DOCS_ROOT');
    this.docsRoot = root?.trim() ? root.trim() : resolveDocsRoot();
  }

  onModuleDestroy(): void {
    this.rebuildLocks.clear();
  }

  /**
   * 同步单个任务的镜像目录（append 成功后异步触发）。
   * 全量重建该任务（扫描 DB doc 产出物 → 幂等覆盖写），事件漏触发时幂等安全。
   */
  async syncTask(taskId: string): Promise<void> {
    const existing = this.rebuildLocks.get(taskId);
    if (existing) {
      return existing.catch(() => undefined);
    }
    const run = this.doSyncTask(taskId).finally(() => this.rebuildLocks.delete(taskId));
    this.rebuildLocks.set(taskId, run);
    return run.catch((err: unknown) => {
      this.logger.error(
        `[docs-mirror] 任务 ${taskId} 镜像同步失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 归档链路不因镜像失败而失败（fire-and-forget，异步不抛）
    });
  }

  /** 全量重建所有任务镜像（进程启动 / 手动 sync 兜底）。 */
  async rebuildAll(): Promise<void> {
    const tasks = await this.prisma.task.findMany({
      where: { status: { not: 'archived' } },
      select: { id: true },
    });
    for (const t of tasks) {
      await this.syncTask(t.id);
    }
  }

  private async doSyncTask(taskId: string): Promise<void> {
    // 1. 查该任务全部 doc 产出物当前版本（镜像只含最新版本，AC-5）
    const rows = await this.prisma.artifactVersion.findMany({
      where: {
        artifact: { taskId, type: 'doc' },
      },
      select: {
        version: true,
        contentRef: true,
        artifact: { select: { id: true, title: true, currentVersion: true } },
      },
    });
    const currentByArtifact = new Map<string, { title: string; contentRef: string }>();
    for (const r of rows) {
      if (r.version === r.artifact.currentVersion) {
        currentByArtifact.set(r.artifact.id, {
          title: r.artifact.title,
          contentRef: r.contentRef ?? '',
        });
      }
    }

    // 2. 目标目录：<docsRoot>/<taskId>/，先清理旧镜像再重建（幂等）
    const dir = join(this.docsRoot, taskId);
    await fsp.mkdir(dir, { recursive: true });
    // 清空旧 .md（移除已删除/改名产出物镜像，保证视图与权威一致）
    const stale = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md'));
    for (const f of stale) {
      await fsp.rm(join(dir, f), { force: true });
    }

    // 3. 逐个读 uploads 正文 → 写镜像 .md（纯 markdown 正文；id 由注册表英文 slug 承载）
    for (const [artifactId, cur] of currentByArtifact) {
      if (!cur.contentRef.startsWith('/uploads/')) {
        // 未落盘 uploads（text 型或 fileRef 占位）→ 跳过镜像
        continue;
      }
      let content: Buffer;
      try {
        content = await FileStorageService.readUploadedFile(cur.contentRef);
      } catch (err) {
        this.logger.warn(
          `[docs-mirror] 产出物 ${cur.title} 正文读取失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const body = content.toString('utf8');
      const slug = this.docIdFor(cur.title, artifactId);
      await fsp.writeFile(join(dir, `${slug}.md`), body, 'utf8');
    }
    this.logger.log(`[docs-mirror] 任务 ${taskId} 镜像同步完成（${currentByArtifact.size} 篇 doc）`);
  }

  /** 读单个任务镜像文件内容（鉴权在 controller；此处仅按白名单文件名读盘）。 */
  async readMirrorDoc(taskId: string, fileName: string): Promise<string | null> {
    // 白名单：仅允许 [a-z0-9-_].md（防路径穿越；与 toSlug 输出一致）
    if (!/^[a-z0-9_-]+\.md$/.test(fileName)) {
      return null;
    }
    const filePath = join(this.docsRoot, taskId, fileName);
    try {
      return await fsp.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  /** 生成任务文档站的动态注册表 DocDef[]（与 prototype-viewer DocDef 形状对齐）。 */
  async buildRegistry(taskId: string): Promise<Array<{
    id: string;
    name: string;
    kind: string;
    description: string;
    file: string;
    order: number;
  }>> {
    const rows = await this.prisma.artifactVersion.findMany({
      where: { artifact: { taskId, type: 'doc' } },
      select: {
        version: true,
        artifact: { select: { id: true, title: true, currentVersion: true } },
      },
    });
    const current = new Map<string, { id: string; title: string }>();
    for (const r of rows) {
      if (r.version === r.artifact.currentVersion) {
        current.set(r.artifact.id, { id: r.artifact.id, title: r.artifact.title });
      }
    }
    // 去重（同名产出物多 artifact 或弱 slug 冲突 → 追加 artifact id 后缀保证唯一）
    const seen = new Set<string>();
    return [...current.values()].map((a, i) => {
      const base = this.docIdFor(a.title, a.id);
      const id = seen.has(base) ? `${base}-${a.id.replace(/[^a-z0-9]/gi, '').slice(0, 8)}` : base;
      seen.add(id);
      return {
        id,
        name: a.title,
        kind: '任务产出物',
        description: `任务产出物文档：${a.title}`,
        file: `${id}.md`,
        order: i + 1,
      };
    });
  }

  /** 标题 → ASCII slug（文件名/文档 id；规避中文 id hash 路由 bug）。 */
  toSlug(title: string): string {
    const base = String(title ?? 'doc')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return base || 'doc';
  }

  /** 文档 id：标题 slug；弱 slug（纯中文/空 → doc）追加 artifact id 防多文档冲突。 */
  docIdFor(title: string, artifactId: string): string {
    const slug = this.toSlug(title);
    if (slug === 'doc' && artifactId) {
      const suffix = String(artifactId).replace(/[^a-z0-9]/gi, '').slice(0, 8);
      return suffix ? `doc-${suffix}` : 'doc';
    }
    return slug;
  }

}
