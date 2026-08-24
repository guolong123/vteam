import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../uploads/uploads.service';
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
    // 清空旧原型镜像子目录（与 .md 一致：整体删除重建，幂等且移除已删除产出物镜像）
    const protoDir = join(dir, 'prototypes');
    await fsp.rm(protoDir, { recursive: true, force: true });
    const prototypeArtifacts = [...currentByArtifact.entries()].filter(
      ([, cur]) =>
        cur.contentRef.startsWith('/uploads/') &&
        (/\.prototype\.json$/i.test(cur.contentRef) || /\.tsx$/i.test(cur.contentRef)),
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
      if (!isTsxPrototype && !isPrototype && !/\.(md|markdown)$/i.test(cur.contentRef)) {
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
        const slug = this.prototypeSlug(cur.title, artifactId, cur.contentRef);
        const tsxDir = join(protoDir, slug);
        await fsp.mkdir(tsxDir, { recursive: true });
        await fsp.writeFile(join(tsxDir, 'index.tsx'), body, 'utf8');
        protoCount += 1;
        continue;
      }
      if (isPrototype) {
        const fileName = this.prototypeFileName(cur.title, artifactId, cur.contentRef);
        await fsp.writeFile(join(protoDir, fileName), body, 'utf8');
        protoCount += 1;
        continue;
      }
      let slug = this.docIdFor(cur.title, artifactId);
      if (seenDocIds.has(slug)) {
        const suffix = String(artifactId).replace(/[^a-z0-9]/gi, '').slice(-8);
        slug = suffix ? `${slug}-${suffix}` : slug;
        let counter = 1;
        while (seenDocIds.has(slug)) {
          counter += 1;
          slug = `${this.docIdFor(cur.title, artifactId)}-${suffix}-${counter}`;
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

  /**
   * 扫描任务原型镜像目录 → 原型列表（web 原型 tab 契约）。
   * 支持两种格式：TSX 目录（<name>/index.tsx）和旧 DSL JSON（<name>.json）。
   * name 优先从 TSX meta 导出 / JSON name 字段读，缺省回退目录名/文件名。
   */
  async listPrototypes(taskId: string): Promise<Array<{ id: string; metaId?: string; name: string; file: string; artifactId?: string }>> {
    const protoDir = join(this.docsRoot, taskId, 'prototypes');
    const items: Array<{ id: string; metaId?: string; name: string; file: string; artifactId?: string }> = [];

    // 从 DB 获取 file 型产出物映射（contentRef → artifactId），供 slug 反查
    const fileArtifactVersions = await this.prisma.artifactVersion.findMany({
      where: { artifact: { taskId, type: 'file' } },
      select: { contentRef: true, artifact: { select: { id: true, currentVersion: true } }, version: true },
    });
    const contentRefToArtifact = new Map<string, string>();
    for (const r of fileArtifactVersions) {
      if (r.version === r.artifact.currentVersion && r.contentRef) {
        contentRefToArtifact.set(r.contentRef, r.artifact.id);
      }
    }

    // 扫描 TSX 目录：prototypes/<name>/index.tsx
    try {
      const entries = await fsp.readdir(protoDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (!/^[a-z0-9_-]+$/.test(name)) continue;
        const tsxFile = join(protoDir, name, 'index.tsx');
        try {
          await fsp.access(tsxFile);
          let displayName = name;
          let metaId: string | undefined;
          try {
            const content = await fsp.readFile(tsxFile, 'utf8');
            const metaMatch = content.match(/export\s+const\s+meta\s*=\s*(\{[^}]+\})/s);
            if (metaMatch) {
              const nameMatch = metaMatch[1].match(/name\s*:\s*["']([^"']+)["']/);
              if (nameMatch?.[1]) displayName = nameMatch[1];
              const idMatch = metaMatch[1].match(/id\s*:\s*["']([^"']+)["']/);
              if (idMatch?.[1]) metaId = idMatch[1].trim();
            }
          } catch { /* 读取失败用目录名兜底 */ }
          let artifactId: string | undefined;
          for (const [ref, aid] of contentRefToArtifact) {
            if (ref.includes(`/${name}/`) || ref.endsWith(`/${name}/index.tsx`) || ref.endsWith(`/${name}.tsx`)) {
              artifactId = aid;
              break;
            }
          }
          items.push({ id: name, metaId, name: displayName, file: `${name}/index.tsx`, artifactId });
        } catch { /* index.tsx 不存在 → 跳过 */ }
      }
    } catch {
      // 目录不存在（该任务无原型产出物）→ 继续扫描 JSON
    }

    // 扫描旧 DSL JSON：prototypes/<name>.json（向后兼容）
    try {
      const files = (await fsp.readdir(protoDir)).filter((f) => /^[a-z0-9_-]+\.json$/.test(f));
      files.sort();
      for (const f of files) {
        const id = f.replace(/\.json$/, '');
        try {
          const doc = JSON.parse(await fsp.readFile(join(protoDir, f), 'utf8')) as { name?: unknown };
          const name = typeof doc?.name === 'string' && doc.name.trim() ? doc.name.trim() : id;
          let artifactId: string | undefined;
          for (const [ref, aid] of contentRefToArtifact) {
            if (ref.endsWith(`/${f}`)) {
              artifactId = aid;
              break;
            }
          }
          items.push({ id, name, file: f, artifactId });
        } catch {
          this.logger.warn(`[docs-mirror] 原型 ${f} 解析失败，跳过列表`);
        }
      }
    } catch { /* 无 JSON 文件 */ }

    items.sort((a, b) => a.id.localeCompare(b.id));
    return items;
  }

  /** 读单个原型文件内容（鉴权在 controller；白名单防路径穿越）。支持 TSX 和旧 DSL JSON。 */
  async readPrototype(taskId: string, filePath: string): Promise<string | null> {
    // 白名单：仅允许 <name>/index.tsx（TSX 目录）或 <name>.json（旧 DSL）
    if (!/^[a-z0-9_-]+\/index\.tsx$/.test(filePath) && !/^[a-z0-9_-]+\.json$/.test(filePath)) {
      return null;
    }
    const fullPath = join(this.docsRoot, taskId, 'prototypes', filePath);
    try {
      return await fsp.readFile(fullPath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * TSX 原型目录名（白名单 [a-z0-9_-]）：
   * 优先取产出物文件名去 `.tsx` 后缀，不可用时从标题派生；标题弱名追加 artifact 后缀防冲突。
   */
  private prototypeSlug(title: string, artifactId: string, contentRef: string): string {
    const base = String(contentRef).split('/').pop() ?? '';
    let slug = base
      .replace(/\.tsx$/i, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) {
      slug = this.toSlug(title);
    }
    if (!slug || slug === 'doc') {
      const suffix = String(artifactId).replace(/[^a-z0-9]/gi, '').slice(-8);
      slug = suffix ? `proto-${suffix}` : 'proto';
    }
    return slug;
  }

  /**
   * 旧 DSL 原型镜像文件名（白名单 [a-z0-9_-].json）：
   * 优先取产出物文件名去 `.prototype.json`（my-proto.prototype.json → my-proto.json），
   * 文件名不可用（中文/空）时从标题派生；标题弱名（doc 兜底）追加 artifact 后缀防冲突。
   */
  private prototypeFileName(title: string, artifactId: string, contentRef: string): string {
    const base = String(contentRef).split('/').pop() ?? '';
    let slug = base
      .replace(/\.prototype\.json$/i, '')
      .replace(/\.json$/i, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) {
      slug = this.toSlug(title);
    }
    if (!slug || slug === 'doc') {
      const suffix = String(artifactId).replace(/[^a-z0-9]/gi, '').slice(-8);
      slug = suffix ? `proto-${suffix}` : 'proto';
    }
    return `${slug}.json`;
  }

  /** 生成任务文档站的动态注册表 DocDef[]（与 prototype-viewer DocDef 形状对齐）。 */
  async buildRegistry(taskId: string): Promise<Array<{
    id: string;
    name: string;
    kind: string;
    description: string;
    file: string;
    order: number;
    artifactId?: string;
  }>> {
    const rows = await this.prisma.artifactVersion.findMany({
      where: { artifact: { taskId, type: { in: ['doc', 'file'] } } },
      select: {
        version: true,
        contentRef: true,
        artifact: { select: { id: true, title: true, currentVersion: true } },
      },
    });
    const current = new Map<string, { id: string; title: string }>();
    for (const r of rows) {
      if (
        r.version === r.artifact.currentVersion &&
        /\.(md|markdown)$/i.test(r.contentRef ?? '')
      ) {
        current.set(r.artifact.id, { id: r.artifact.id, title: r.artifact.title });
      }
    }
    const seen = new Set<string>();
    return [...current.values()].map((a, i) => {
      const base = this.docIdFor(a.title, a.id);
      let id = base;
      if (seen.has(base)) {
        const suffix = String(a.id).replace(/[^a-z0-9]/gi, '').slice(-8);
        id = suffix ? `${base}-${suffix}` : base;
        let counter = 1;
        while (seen.has(id)) {
          counter += 1;
          id = `${base}-${suffix}-${counter}`;
        }
      }
      seen.add(id);
      return {
        id,
        name: a.title,
        kind: '任务产出物',
        description: `任务产出物文档：${a.title}`,
        file: `${id}.md`,
        order: i + 1,
        artifactId: a.id,
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
      const suffix = String(artifactId).replace(/[^a-z0-9]/gi, '').slice(-8);
      return suffix ? `doc-${suffix}` : 'doc';
    }
    return slug;
  }

}
