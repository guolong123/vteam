import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../uploads/uploads.service';
import {
  docIdFor as slugDocIdFor,
  prototypeFileName as slugPrototypeFileName,
  prototypeSlug as slugPrototypeSlug,
  toSlug as slugToSlug,
} from '../artifacts/artifact-slug';
import { resolveDocsRoot } from './docs-site.constants';

/**
 * F1 镜像导出层（is_0000000024）：任务产出物 → 文档站镜像 .md + 原型（TSX / DSL JSON）。
 *
 * 原则（art_0000000026）：镜像 = **派生视图**，权威在 DB(artifacts)+uploads。
 * - 处理 type=doc 与 type=file 且 contentRef 以 .md 结尾的产出物（AC-6 扩展：
 *   实际产出物多为 file 型 .md 文档，text/其他格式文件不入站）；
 * - 扩展（26-原型TSX动态渲染）：file 型 `*.tsx` →
 *   `<docsRoot>/<taskId>/prototypes/<slug>/index.tsx`（agent 产出 TSX 组件 →
 *   原型 tab 编译渲染，无需改代码/重构建；与 .md/.json 镜像共存于
 *   `<docsRoot>/<taskId>/` 下）；
 * - 兼容：旧 DSL `*.prototype.json` → `<docsRoot>/<taskId>/prototypes/<slug>.json`
 *   （web 已不渲染 DSL，但端点保留兜底）；
 * - 读 uploads 正文（contentRef=/uploads/...）→ 写 `<docsRoot>/<taskId>/<slug>.md`；
 * - 幂等：按 (taskId, title) 覆盖写最新版本（AC-5），历史版本不走文档站；
 * - 可全量重建（扫描 artifacts 表），不新增 DB 表（AC-8）；启动时全量重建存量。
 */
@Injectable()
export class DocsMirrorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocsMirrorService.name);
  private readonly docsRoot: string;
  /** 串行重建锁（防归档事件并发触发镜像写竞争）。 */
  private rebuildLocks = new Map<string, Promise<void>>();

  /** 启动全量重建存量任务镜像（含修复前遗漏的 file 型 .md 产出物）；失败不阻断启动。 */
  async onModuleInit(): Promise<void> {
    try {
      await this.rebuildAll();
    } catch (err) {
      this.logger.warn(
        `[docs-mirror] 启动全量重建失败（不影响启动，后续归档事件仍会触发单任务同步）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

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
    const run = this.doSyncTask(taskId).finally(() =>
      this.rebuildLocks.delete(taskId),
    );
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
    // 1. 查该任务全部 doc / file(.md) 产出物当前版本（镜像只含最新版本，AC-5）
    const rows = await this.prisma.artifactVersion.findMany({
      where: {
        artifact: { taskId, type: { in: ['doc', 'file'] } },
      },
      select: {
        version: true,
        contentRef: true,
        artifact: { select: { id: true, title: true, currentVersion: true } },
      },
    });
    const currentByArtifact = new Map<
      string,
      { title: string; contentRef: string }
    >();
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
    // 清空旧原型镜像子目录（与 .md 一致：整体删除重建，幂等且移除已删除产出物镜像）
    const protoDir = join(dir, 'prototypes');
    await fsp.rm(protoDir, { recursive: true, force: true });
    const prototypeArtifacts = [...currentByArtifact.entries()].filter(
      ([, cur]) =>
        cur.contentRef.startsWith('/uploads/') &&
        (/\.prototype\.json$/i.test(cur.contentRef) ||
          /\.tsx$/i.test(cur.contentRef)),
    );
    if (prototypeArtifacts.length > 0) {
      await fsp.mkdir(protoDir, { recursive: true });
    }

    // 3. 逐个读 uploads 正文 → 写镜像（.md 纯 markdown 正文 / *.tsx 原型组件 / *.prototype.json 兼容）
    let protoCount = 0;
    const seenDocIds = new Set<string>();
    for (const [artifactId, cur] of currentByArtifact) {
      if (!cur.contentRef.startsWith('/uploads/')) {
        continue;
      }
      const isTsxPrototype = /\.tsx$/i.test(cur.contentRef);
      const isPrototype = /\.prototype\.json$/i.test(cur.contentRef);
      if (
        !isTsxPrototype &&
        !isPrototype &&
        !/\.(md|markdown)$/i.test(cur.contentRef)
      ) {
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
      if (isTsxPrototype) {
        const slug = slugPrototypeSlug(cur.title, artifactId, cur.contentRef);
        const tsxDir = join(protoDir, slug);
        await fsp.mkdir(tsxDir, { recursive: true });
        await fsp.writeFile(join(tsxDir, 'index.tsx'), body, 'utf8');
        protoCount += 1;
        continue;
      }
      if (isPrototype) {
        const fileName = slugPrototypeFileName(
          cur.title,
          artifactId,
          cur.contentRef,
        );
        await fsp.writeFile(join(protoDir, fileName), body, 'utf8');
        protoCount += 1;
        continue;
      }
      let slug = slugDocIdFor(cur.title, artifactId);
      if (seenDocIds.has(slug)) {
        const suffix = String(artifactId)
          .replace(/[^a-z0-9]/gi, '')
          .slice(-8);
        slug = suffix ? `${slug}-${suffix}` : slug;
        let counter = 1;
        while (seenDocIds.has(slug)) {
          counter += 1;
          slug = `${slugDocIdFor(cur.title, artifactId)}-${suffix}-${counter}`;
        }
      }
      seenDocIds.add(slug);
      await fsp.writeFile(join(dir, `${slug}.md`), body, 'utf8');
    }
    this.logger.log(
      `[docs-mirror] 任务 ${taskId} 镜像同步完成（${currentByArtifact.size - protoCount} 篇 doc，${protoCount} 个原型）`,
    );
  }

  /** 读单个任务镜像文件内容（鉴权在 controller；此处仅按白名单文件名读盘）。 */
  async readMirrorDoc(
    taskId: string,
    fileName: string,
  ): Promise<string | null> {
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

  /**
   * 任务原型列表（DB 直读，T6；web 原型 tab 契约不变）。
   * 查 type='file' 当前版本且 contentRef 以 .tsx/.prototype.json 结尾的行，
   * 显示名经 `../artifacts/artifact-slug` 规范 helper 计算，源码经
   * `readUploadedFile(contentRef)` 读取后按既有 meta 正则解析；
   * 磁盘 `prototypes/` 目录不再参与（`doSyncTask` 写盘保留到 T11 删除）。
   * 支持两种格式：TSX（<slug>/index.tsx）和旧 DSL JSON（<slug>.json）。
   * name 优先从 TSX meta 导出 / JSON name 字段读，缺省回退 slug。
   */
  async listPrototypes(taskId: string): Promise<
    Array<{
      id: string;
      metaId?: string;
      name: string;
      file: string;
      artifactId?: string;
    }>
  > {
    const rows = await this.prisma.artifactVersion.findMany({
      where: { artifact: { taskId, type: 'file' } },
      select: {
        version: true,
        contentRef: true,
        artifact: { select: { id: true, title: true, currentVersion: true } },
      },
    });
    const items: Array<{
      id: string;
      metaId?: string;
      name: string;
      file: string;
      artifactId?: string;
    }> = [];

    for (const r of rows) {
      if (r.version !== r.artifact.currentVersion) {
        continue;
      }
      const contentRef = r.contentRef ?? '';
      if (!contentRef.startsWith('/uploads/')) {
        continue;
      }
      const artifactId = r.artifact.id;
      const title = r.artifact.title;
      if (/\.tsx$/i.test(contentRef)) {
        const slug = slugPrototypeSlug(title, artifactId, contentRef);
        let displayName = slug;
        let metaId: string | undefined;
        try {
          const content = (
            await FileStorageService.readUploadedFile(contentRef)
          ).toString('utf8');
          const metaMatch = content.match(
            /export\s+const\s+meta\s*=\s*(\{[^}]+\})/s,
          );
          if (metaMatch) {
            const nameMatch = metaMatch[1].match(
              /name\s*:\s*["']([^"']+)["']/,
            );
            if (nameMatch?.[1]) displayName = nameMatch[1];
            const idMatch = metaMatch[1].match(/id\s*:\s*["']([^"']+)["']/);
            if (idMatch?.[1]) metaId = idMatch[1].trim();
          }
        } catch {
          /* 读取失败用 slug 兜底 */
        }
        items.push({
          id: slug,
          metaId,
          name: displayName,
          file: `${slug}/index.tsx`,
          artifactId,
        });
        continue;
      }
      if (/\.prototype\.json$/i.test(contentRef)) {
        const fileName = slugPrototypeFileName(title, artifactId, contentRef);
        const id = fileName.replace(/\.json$/, '');
        try {
          const raw = (
            await FileStorageService.readUploadedFile(contentRef)
          ).toString('utf8');
          const doc = JSON.parse(raw) as { name?: unknown };
          const name =
            typeof doc?.name === 'string' && doc.name.trim()
              ? doc.name.trim()
              : id;
          items.push({ id, name, file: fileName, artifactId });
        } catch {
          this.logger.warn(`[docs-mirror] 原型 ${fileName} 解析失败，跳过列表`);
        }
      }
    }

    items.sort((a, b) => a.id.localeCompare(b.id));
    return items;
  }

  /**
   * 读单个原型文件内容（DB 直读，T6；鉴权在 controller；白名单防路径穿越）。
   * 支持 TSX（<slug>/index.tsx）和旧 DSL JSON（<slug>.json）；
   * 文件名经规范 helper 反查到 DB 行后由 `readUploadedFile` 取源码。
   */
  async readPrototype(
    taskId: string,
    filePath: string,
  ): Promise<string | null> {
    // 白名单：仅允许 <name>/index.tsx（TSX 目录）或 <name>.json（旧 DSL）
    if (
      !/^[a-z0-9_-]+\/index\.tsx$/.test(filePath) &&
      !/^[a-z0-9_-]+\.json$/.test(filePath)
    ) {
      return null;
    }
    const rows = await this.prisma.artifactVersion.findMany({
      where: { artifact: { taskId, type: 'file' } },
      select: {
        version: true,
        contentRef: true,
        artifact: { select: { id: true, title: true, currentVersion: true } },
      },
    });
    for (const r of rows) {
      if (r.version !== r.artifact.currentVersion) {
        continue;
      }
      const contentRef = r.contentRef ?? '';
      if (!contentRef.startsWith('/uploads/')) {
        continue;
      }
      if (/\.tsx$/i.test(contentRef)) {
        const slug = slugPrototypeSlug(
          r.artifact.title,
          r.artifact.id,
          contentRef,
        );
        if (`${slug}/index.tsx` === filePath) {
          try {
            return (
              await FileStorageService.readUploadedFile(contentRef)
            ).toString('utf8');
          } catch {
            return null;
          }
        }
        continue;
      }
      if (/\.prototype\.json$/i.test(contentRef)) {
        const fileName = slugPrototypeFileName(
          r.artifact.title,
          r.artifact.id,
          contentRef,
        );
        if (fileName === filePath) {
          try {
            return (
              await FileStorageService.readUploadedFile(contentRef)
            ).toString('utf8');
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * TSX 原型目录名（规范实现见 `../artifacts/artifact-slug`；
   * 此为兼容透传，T11 随镜像层删除）。
   */
  private prototypeSlug(
    title: string,
    artifactId: string,
    contentRef: string,
  ): string {
    return slugPrototypeSlug(title, artifactId, contentRef);
  }

  /**
   * 旧 DSL 原型镜像文件名（规范实现见 `../artifacts/artifact-slug`；
   * 此为兼容透传，T11 随镜像层删除）。
   */
  private prototypeFileName(
    title: string,
    artifactId: string,
    contentRef: string,
  ): string {
    return slugPrototypeFileName(title, artifactId, contentRef);
  }

  /**
   * 生成任务文档站的动态注册表 DocDef[]（与 prototype-viewer DocDef 形状对齐）。
   * 包含所有文件类型（md/docx/pdf/xlsx/pptx/png/jpg/...），非 md 文件附带 fileExt/fileUrl
   * 供前端决定渲染方式（md 渲染 / 图片内嵌 / 下载卡片）。
   */
  async buildRegistry(taskId: string): Promise<
    Array<{
      id: string;
      name: string;
      kind: string;
      description: string;
      file: string;
      order: number;
      artifactId?: string;
      fileExt?: string;
      fileUrl?: string;
    }>
  > {
    const rows = await this.prisma.artifactVersion.findMany({
      where: { artifact: { taskId, type: { in: ['doc', 'file'] } } },
      select: {
        version: true,
        contentRef: true,
        artifact: { select: { id: true, title: true, currentVersion: true } },
      },
    });
    const current = new Map<
      string,
      { id: string; title: string; contentRef: string }
    >();
    for (const r of rows) {
      if (r.version === r.artifact.currentVersion && r.contentRef) {
        current.set(r.artifact.id, {
          id: r.artifact.id,
          title: r.artifact.title,
          contentRef: r.contentRef,
        });
      }
    }
    const seen = new Set<string>();
    return [...current.values()].map((a, i) => {
      const base = slugDocIdFor(a.title, a.id);
      let id = base;
      if (seen.has(base)) {
        const suffix = String(a.id)
          .replace(/[^a-z0-9]/gi, '')
          .slice(-8);
        id = suffix ? `${base}-${suffix}` : base;
        let counter = 1;
        while (seen.has(id)) {
          counter += 1;
          id = `${base}-${suffix}-${counter}`;
        }
      }
      seen.add(id);
      const ext = this.extractExt(a.contentRef);
      const isMd = /^(md|markdown)$/i.test(ext);
      return {
        id,
        name: a.title,
        kind: '任务产出物',
        description: `任务产出物文档：${a.title}`,
        file: isMd ? `${id}.md` : id,
        order: i + 1,
        artifactId: a.id,
        ...(isMd ? {} : { fileExt: ext, fileUrl: a.contentRef }),
      };
    });
  }

  private extractExt(contentRef: string): string {
    const base = String(contentRef).split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
  }

  /** 标题 → ASCII slug（规范实现见 `../artifacts/artifact-slug`；此为兼容透传，T11 随镜像层删除）。 */
  toSlug(title: string): string {
    return slugToSlug(title);
  }

  /** 文档 id（规范实现见 `../artifacts/artifact-slug`；此为兼容透传，T11 随镜像层删除）。 */
  docIdFor(title: string, artifactId: string): string {
    return slugDocIdFor(title, artifactId);
  }
}
