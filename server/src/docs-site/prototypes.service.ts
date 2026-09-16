import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageService } from '../uploads/uploads.service';
import {
  prototypeFileName as slugPrototypeFileName,
  prototypeSlug as slugPrototypeSlug,
} from '../artifacts/artifact-slug';

/**
 * 任务原型数据服务（docs-artifacts-merge T11：从已退役的磁盘镜像层搬移，
 * 方法体逐字一致，仅类包装/注入变化）。
 *
 * DB 直读（T6 语义保留）：查 `type='file'` 当前版本且 `contentRef` 以
 * `.tsx`/`.prototype.json` 结尾的行，显示名经 `../artifacts/artifact-slug`
 * 规范 helper 计算，源码经 `readUploadedFile(contentRef)` 读取后按既有 meta
 * 正则解析；磁盘 `prototypes/` 目录不参与（镜像层已随 T11 删除）。
 * 支持两种格式：TSX（`<slug>/index.tsx`）和旧 DSL JSON（`<slug>.json`）。
 */
@Injectable()
export class PrototypesService {
  private readonly logger = new Logger(PrototypesService.name);

  constructor(private readonly prisma: PrismaService) {}

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
          this.logger.warn(`[prototypes] 原型 ${fileName} 解析失败，跳过列表`);
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
}
