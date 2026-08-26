import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { diskStorage } from 'multer';
import {
  ALLOWED_EXTENSIONS,
  FILE_SIZE_LIMIT,
  resolveUploadDir,
  UPLOAD_ERRORS,
} from './uploads.constants';

/** multer diskStorage 写入后挂到 file 上的元数据（对齐 multer 磁盘存储字段子集）。 */
export interface StoredFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  /** 字节数。 */
  size: number;
  /** 落盘目录。 */
  destination: string;
  /** 磁盘存储生成的文件名（UUID + 扩展名）。 */
  filename: string;
  /** 完整磁盘路径。 */
  path: string;
}

/** fileFilter 校验入参（字段子集：仅需要名字与 mimetype）。 */
export interface FileCandidate {
  originalname: string;
  mimetype: string;
}

/** 上传成功响应体（GET /uploads/{filename} 可达，FILE-01/02、UX-10 复用该结构）。 */
export interface UploadedFileMeta {
  /** 可访问的相对 URL（经 web rewrite / 直接命中 server 静态服务）。 */
  url: string;
  /** 原始文件名（含扩展名，用户可感知）。 */
  name: string;
  /** 字节数。 */
  size: number;
  /** 小写扩展名（无扩展名为空串）。 */
  ext: string;
}

/**
 * 文件存储服务（平台统一上传基础，FILE-01/02、UX-10 共享）。
 *
 * 职责拆分：
 * - **静态方法**：供任意 `FileInterceptor('file', FileStorageService.buildMulterOptions())`
 *   装饰器在模块编译期复用（diskStorage 存储策略 / 大小限制 / 扩展名白名单 fileFilter）；
 *   纯函数可单测，不依赖实例状态。
 * - **实例方法**：`describe(file)` 生成上传响应元数据（DI 注入，供 controller 及
 *   后续上传消费方复用同一声明）。
 *
 * 存储约定（对齐 uploads.constants.ts）：server/uploads/（UPLOAD_DIR 可覆盖）、
 * 文件名 `UUID.<ext>`、扩展名白名单校验、10MB 上限。
 */
@Injectable()
export class FileStorageService {
  /**
   * 构建 multer 磁盘存储策略（controller 装饰器用）：
   * - destination：落盘 resolveUploadDir()（目录缺失时递归创建）
   * - filename：UUID + 白名单扩展名（generateFilename）
   * - limits：10MB（超限走 multer → Nest 413，与 skills 上传同款机制）
   * - fileFilter：扩展名白名单校验，非法类型 → 400 UPLOAD_FILE_TYPE_NOT_ALLOWED
   */
  static buildMulterOptions() {
    return {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = resolveUploadDir();
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          cb(null, FileStorageService.generateFilename(file.originalname));
        },
      }),
      limits: { fileSize: FILE_SIZE_LIMIT },
      fileFilter: FileStorageService.buildFileFilter(),
    };
  }

  /**
   * 扩展名白名单校验（类型安全关键路径）。非法 → 抛 400 `UPLOAD_FILE_TYPE_NOT_ALLOWED`。
   * 以**扩展名**为准而非 mimetype：浏览器/工具常把不同类型统一上报为
   * application/octet-stream，扩展名才是可控的类型信号（返回的 ext 与校验同源）。
   */
  static assertAllowed(file: FileCandidate): void {
    const ext = FileStorageService.extractExtension(file.originalname);
    if (!ext || !(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new BadRequestException({
        code: UPLOAD_ERRORS.FILE_TYPE_NOT_ALLOWED,
        message: `文件类型不允许：仅支持 ${ALLOWED_EXTENSIONS.join('/')}`,
      });
    }
  }

  /** 提取小写扩展名（`报告.PDF` → `pdf`；无点/点结尾 → null）。 */
  static extractExtension(originalname: string): string | null {
    const dot = originalname.lastIndexOf('.');
    if (dot <= 0 || dot === originalname.length - 1) return null;
    return originalname.slice(dot + 1).toLowerCase();
  }

  /** 生成磁盘文件名：`UUID.<ext>`（保留扩展名，杜绝重名/路径穿越）。 */
  static generateFilename(originalname: string): string {
    const ext = FileStorageService.extractExtension(originalname);
    return ext ? `${randomUUID()}.${ext}` : randomUUID();
  }

  /** multer fileFilter：白名单校验通过接受，否则拒绝（multer abort → 400）。 */
  private static buildFileFilter() {
    return (
      _req: unknown,
      file: FileCandidate,
      cb: (error: Error | null, acceptFile: boolean) => void,
    ): void => {
      try {
        FileStorageService.assertAllowed(file);
        cb(null, true);
      } catch (err) {
        cb(err as Error, false);
      }
    };
  }

  /** 上传成功响应元数据：`{url: '/uploads/<filename>', name, size, ext}`。 */
  describe(file: StoredFile): UploadedFileMeta {
    return {
      url: `/uploads/${file.filename}`,
      name: file.originalname,
      size: file.size,
      ext: FileStorageService.extractExtension(file.originalname) ?? '',
    };
  }

  /**
   * P2：将产出物文本内容落盘 uploads 目录（worker 完成回流上送的真实文件内容），
   * 返回控制面可访问的 URL——doc/file 产出物归档时用真实文件替换 worker 容器路径
   * 占位（/tmp/opencode/...），前端下载链接不再 404。文件名 UUID.<ext>（扩展名取
   * originalName；无扩展名 → 纯 UUID）。
   */
  static async saveTextFile(
    content: string,
    originalName: string,
  ): Promise<UploadedFileMeta> {
    const dir = resolveUploadDir();
    await fsp.mkdir(dir, { recursive: true });
    const filename = FileStorageService.generateFilename(originalName);
    await fsp.writeFile(join(dir, filename), content, 'utf8');
    return {
      url: `/uploads/${filename}`,
      name: originalName,
      size: Buffer.byteLength(content, 'utf8'),
      ext: FileStorageService.extractExtension(originalName) ?? '',
    };
  }

  /**
   * FR-41：将 worker 工作区拉取的二进制文件内容落盘 uploads 目录（group_post fileRef
   * 归档路径），返回控制面可访问的 URL。与 saveTextFile 对称，区别是 Buffer 直写
   * （二进制安全，不按 utf8 转码）。文件名 UUID.<ext>（扩展名取 originalName）。
   */
  static async saveBufferFile(
    content: Buffer,
    originalName: string,
  ): Promise<UploadedFileMeta> {
    const dir = resolveUploadDir();
    await fsp.mkdir(dir, { recursive: true });
    const filename = FileStorageService.generateFilename(originalName);
    await fsp.writeFile(join(dir, filename), content);
    return {
      url: `/uploads/${filename}`,
      name: originalName,
      size: content.length,
      ext: FileStorageService.extractExtension(originalName) ?? '',
    };
  }

  /**
   * 产出物 fileRef 归一化为可访问 URL（FILE-02）。
   *
   * worker 上报的 fileRef（12 篇 §3.1）与浏览器上传的 /uploads URL 是两条路径：
   * - `/uploads/<name>` → 原样（控制面静态服务 + web rewrite 可达）
   * - `http(s)://...` 完整 URL → 原样（外部引用，前端新标签打开）
   * - 其他（worker 工作区原始路径 / 纯文件名）→ 提取 basename 映射为 `/uploads/<basename>`
   *   （文件已由控制面落盘 uploads 目录时可达；否则前端对 404 降级展示）
   */
  static normalizeFileRef(ref: string): string {
    if (!ref) return ref;
    if (ref.startsWith('/uploads/') || /^https?:\/\//i.test(ref)) {
      return ref;
    }
    const base = ref.split(/[\\/]/).pop() ?? '';
    if (base && FileStorageService.extractExtension(base)) {
      return `/uploads/${base}`;
    }
    return ref;
  }

  /**
   * read_file：从 uploads 目录读取已落盘文件内容（归档 contentRef 为 /uploads/<name> 形式，
   * 与 saveBufferFile/saveTextFile 对称的读方法）。仅支持控制面落盘文件（/uploads/ 前缀）；
   * basename 经 split 提取后与 uploads 根目录拼接，杜绝路径穿越。磁盘缺失 / 非 /uploads/
   * 引用 → 抛错（platform-mcp read_file 调用方统一转 404 业务错误）。
   */
  static async readUploadedFile(fileUrl: string): Promise<Buffer> {
    const url = FileStorageService.normalizeFileRef(fileUrl);
    if (!url.startsWith('/uploads/')) {
      throw new BadRequestException({
        code: UPLOAD_ERRORS.FILE_NOT_READABLE,
        message: '仅支持读取已归档落盘的 /uploads/ 文件',
      });
    }
    const base = url.split(/[\\/]/).pop() ?? '';
    return fsp.readFile(join(resolveUploadDir(), base));
  }

  /** 从已归一化的 fileRef 派生展示元数据（文件名 / 扩展名 / 磁盘大小，FILE-02 前端徽章）。 */
  static describeFileRef(fileUrl: string): {
    name: string;
    ext: string;
    size: number | null;
  } {
    const base = fileUrl.split(/[\\/]/).pop() ?? fileUrl;
    let size: number | null = null;
    if (fileUrl.startsWith('/uploads/')) {
      try {
        size = statSync(join(resolveUploadDir(), base)).size;
      } catch {
        // 磁盘不存在（worker 原始路径未落盘 uploads）→ size 缺省，前端不显示大小徽章
        size = null;
      }
    }
    return {
      name: base,
      ext: FileStorageService.extractExtension(base) ?? '',
      size,
    };
  }
}
