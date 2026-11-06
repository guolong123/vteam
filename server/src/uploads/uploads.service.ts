import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { diskStorage } from 'multer';
import { repairMultipartText } from './filename-encoding';
import {
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
 *   装饰器在模块编译期复用（diskStorage 存储策略 / 大小限制）；
 *   纯函数可单测，不依赖实例状态。
 * - **实例方法**：`describe(file)` 生成上传响应元数据（DI 注入，供 controller 及
 *   后续上传消费方复用同一声明）。
 *
 * 存储约定（对齐 uploads.constants.ts）：server/uploads/（UPLOAD_DIR 可覆盖）、
 * 文件名 `UUID.<ext>`、**不限扩展名**（任意类型/无扩展名均放行）、20MB 上限。
 */
@Injectable()
export class FileStorageService {
  /**
   * 构建 multer 磁盘存储策略（controller 装饰器用）：
   * - destination：落盘 resolveUploadDir()（目录缺失时递归创建）
   * - filename：UUID + 扩展名（generateFilename；无扩展名 → 纯 UUID）
   * - limits：20MB（超限走 multer → Nest 413，与 skills 上传同款机制）
   * - 不再挂 fileFilter：任意扩展名 / 无扩展名一律放行，由模型自行决定如何处理
   *   （能否读取属于模型侧能力判断，控制面不预设类型白名单）。
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
    };
  }

  /** 提取小写扩展名（`报告.PDF` → `pdf`；无点/点结尾 → null）。 */
  static extractExtension(originalname: string): string | null {
    const dot = originalname.lastIndexOf('.');
    if (dot <= 0 || dot === originalname.length - 1) return null;
    return originalname.slice(dot + 1).toLowerCase();
  }

  /** 生成磁盘文件名：`<UUID>__<原始名>`（保留原始名，杜绝重名/路径穿越）。
   *
   *  为什么要把原始名嵌进磁盘名（2026-11-06 实测缺陷）：
   *  此前磁盘名只有 `UUID.ext`，而「下载」用的是静态 URL + `download` 属性；
   *  `describeFileRef` 只能从 URL 尾段取名字 ⇒ 前端拿到的 `fileName` 是 UUID ⇒
   *  用户下载下来的文件叫 `f8a2173c-...-c4151f71756b.docx`（截图缺陷）。
   *  原始名在**落盘时**是已知的（上传链路 file.originalname / 产出物归档 fileName），
   *  但此前只用于响应 DTO，没有持久化 ⇒ 事后无从还原。
   *  把清洗后的原始名嵌进文件名后：静态下载、直接开新标签、describeFileRef
   *  三条路径都能拿到人类可读名；老文件（纯 UUID）保持原行为（降级）。
   *
   *  命名规则 `<uuid>__<safe>`：uuid 固定 36 字符 + `__` 分隔，
   *  `describeFileRef` 用锚定正则剥离，绝不会误伤原始名里自带的 `__`。
   *
   *  安全性：原始名只用 basename 且清洗路径分隔符/控制字符/首尾点，
   *  杜绝路径穿越与隐藏文件；长度按**字节**封顶（中文 3 字节/字，避免 ENAMETOOLONG）。 */
  static generateFilename(originalname: string): string {
    const repaired = repairMultipartText(originalname);
    const ext = FileStorageService.extractExtension(repaired);
    const uuid = randomUUID();
    const safeBase = FileStorageService.sanitizeStoredNameBase(repaired);
    if (!safeBase) {
      return ext ? `${uuid}.${ext}` : uuid;
    }
    return `${uuid}__${safeBase}`;
  }

  /**
   * 由磁盘文件名生成 `Content-Disposition` 值（静态下载用）。
   *
   * 只写 `attachment` 不带 filename 时，浏览器只能用 URL 尾段（= UUID）当文件名，
   * 用户下载下来就是一串编号（2026-11-06 缺陷）。这里：
   * - `filename=`：ASCII 兜底（非 ASCII 替换成 `_`，兼容老客户端）；
   * - `filename*=`：RFC 5987 UTF-8 百分号编码（中文/空格/引号都正确）；
   * - 额外转义 `'()`（RFC 5987 的 attr-char 之外，个别浏览器实现有坑）。
   */
  /**
   * 允许**内联渲染**（`Content-Disposition: inline`）的扩展名白名单。
   *
   * 为什么需要：`/uploads/*` 此前对**所有**文件强制 `attachment`（安全补偿：上传不限
   * 扩展名，若把 .html/.svg 当同源文档内联渲染即可执行脚本）。但这条规则同时把 PDF
   * 也变成"下载"，导致文档站的 PDF iframe 永远空白（2026-11-06 用户实测）。
   * PDF 的安全性由浏览器内置阅读器（独立进程 + 无页面脚本权限）承担，加上
   * `X-Content-Type-Options: nosniff`（MIME 不可嗅探）+ 由扩展名决定的固定
   * `application/pdf`，不会退化成 HTML 执行 ⇒ 只有 PDF 进白名单。
   */
  private static readonly INLINE_DISPOSITION_EXTS = new Set(['pdf']);

  /** 该文件是否应当内联渲染（而非强制下载）。 */
  static prefersInlineDisposition(storedName: string): boolean {
    const ext = FileStorageService.extractExtension(
      FileStorageService.displayNameFromStored(storedName),
    );
    return ext !== null && FileStorageService.INLINE_DISPOSITION_EXTS.has(ext);
  }

  static buildDownloadDisposition(
    storedName: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ): string {
    const display = FileStorageService.displayNameFromStored(storedName);
    const fallback =
      display.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') ||
      'download';
    const encoded = encodeURIComponent(display).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
  }

  /** 磁盘文件名里 `<uuid>__` 前缀的剥离正则（36 字符 UUID + 双下划线）。 */
  private static readonly STORED_NAME_PREFIX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__/i;

  /** 从磁盘文件名还原人类可读名（无 `<uuid>__` 前缀 → 原样返回，兼容老文件）。 */
  static displayNameFromStored(stored: string): string {
    const stripped = stored.replace(FileStorageService.STORED_NAME_PREFIX, '');
    return stripped.length > 0 ? stripped : stored;
  }

  /**
   * 清洗原始名作为磁盘名后缀：仅保留 basename、去掉路径分隔符/控制字符、
   * 折叠空白、去首尾点，并按 UTF-8 字节数封顶（保扩展名）。
   * 返回空串表示「不值得嵌」（调用方回落纯 UUID 命名）。
   */
  private static sanitizeStoredNameBase(originalname: string): string {
    const base = (originalname.split(/[\\/]/).pop() ?? '')
      // 控制字符 + Windows 保留字符（路径分隔符已按 basename 处理）
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '');
    if (!base) return '';
    const ext = FileStorageService.extractExtension(base);
    const stem = ext ? base.slice(0, base.length - ext.length - 1) : base;
    // 字节封顶：uuid(36) + '__'(2) + stem + '.' + ext 需 < 255 字节，留足余量
    const MAX_STEM_BYTES = 140;
    let kept = '';
    for (const ch of stem) {
      if (Buffer.byteLength(kept + ch, 'utf8') > MAX_STEM_BYTES) break;
      kept += ch;
    }
    kept = kept.trim();
    if (!kept) return '';
    return ext ? `${kept}.${ext}` : kept;
  }

  /** 上传成功响应元数据：`{url: '/uploads/<filename>', name, size, ext}`。
   *  `name` 经 repairMultipartText 修复 latin1/UTF-8 错位（中文文件名乱码根因），
   *  保证落库/展示/下载文件名与用户选择时一致。 */
  describe(file: StoredFile): UploadedFileMeta {
    const name = repairMultipartText(file.originalname);
    return {
      url: `/uploads/${file.filename}`,
      name,
      size: file.size,
      ext: FileStorageService.extractExtension(name) ?? '',
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
    // 产出物标题可能来自中文内容/worker 路径：与上传链路同口径修复 latin1 错位
    const safeName = repairMultipartText(originalName);
    const dir = resolveUploadDir();
    await fsp.mkdir(dir, { recursive: true });
    const filename = FileStorageService.generateFilename(safeName);
    await fsp.writeFile(join(dir, filename), content, 'utf8');
    return {
      url: `/uploads/${filename}`,
      name: safeName,
      size: Buffer.byteLength(content, 'utf8'),
      ext: FileStorageService.extractExtension(safeName) ?? '',
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
    // 与 saveTextFile 同口径：产出物原始名同样可能是 latin1 错位的中文
    const safeName = repairMultipartText(originalName);
    const dir = resolveUploadDir();
    await fsp.mkdir(dir, { recursive: true });
    const filename = FileStorageService.generateFilename(safeName);
    await fsp.writeFile(join(dir, filename), content);
    return {
      url: `/uploads/${filename}`,
      name: safeName,
      size: content.length,
      ext: FileStorageService.extractExtension(safeName) ?? '',
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
   * 归档内容读取（read_file 的归档路径）：控制面落盘文件（/uploads/<name>）或**内联正文**。
   * - /uploads/<name>：与 saveBufferFile/saveTextFile 对称的读法；basename 经 split 提取后
   *   与 uploads 根目录拼接，杜绝路径穿越；磁盘缺失 → 抛错（platform-mcp read_file 调用方
   *   统一转 404 业务错误）。
   * - **内联正文**（text 类产出物）：见下方说明。
   *
   * ⚠️ **内联正文例外**（缺陷 1）：`text` 类产出物的 `contentRef` **存的就是正文**
   * （见 ArtifactsService.append：`contentRef = type === 'text' ? content : …`）——
   * 它在**平台产出物库**里，从来没有对应的工作区文件。按老口径把它当「非 /uploads/
   * 引用」抛错 ⇒ agent 读 text 产出物永远是「文件不存在」，而正文明明就在库里。
   * ⇒ 非文件引用形态的 contentRef 按**内联正文**返回字节（判定见 isInlineContentRef）。
   */
  static async readUploadedFile(fileUrl: string): Promise<Buffer> {
    // ⚠️ 顺序要紧：**先判内联正文**，再走文件路径。
    // normalizeFileRef 会把「末段像文件名」的引用一律映射成 /uploads/<basename>
    // （正文里出现 "… 见 issue.update …" 这类片段时同样会被映射），若先归一化，
    // 内联正文会被误当成 uploads 文件去读磁盘 → 又变成「文件不存在」。
    if (FileStorageService.isInlineContentRef(fileUrl)) {
      return Buffer.from(fileUrl, 'utf8');
    }
    const url = FileStorageService.normalizeFileRef(fileUrl);
    if (url.startsWith('/uploads/')) {
      const base = url.split(/[\\/]/).pop() ?? '';
      return fsp.readFile(join(resolveUploadDir(), base));
    }
    throw new BadRequestException({
      code: UPLOAD_ERRORS.FILE_NOT_READABLE,
      message: '仅支持读取已归档落盘的 /uploads/ 文件',
    });
  }

  /**
   * contentRef 是「内联正文」还是「文件引用」？
   *
   * 归档表里两种形态并存（**同一列**）：
   * - `doc`/`file` 类：`contentRef` = 文件引用（`/uploads/<uuid>.<ext>`，或内容没抓到时
   *   的 worker 工作区原始路径）；
   * - `text` 类：`contentRef` = 正文本身（多行 markdown / 短句）。
   *
   * 判定（**按引用形态**，因为 read_file 这条链路上拿不到产出物类型——它只转发
   * contentRef）：
   * - 绝对路径（`/…`）、Windows 盘符、URL → **文件引用**；
   * - basename 形如 `name.ext`（含相对路径 `docs/a.md`）→ **文件引用**；
   * - 其余 → **内联正文**。
   *
   * ⚠️ 已知歧义（保守取舍）：doc/file 产出物若内容没抓到、且 fileRef 是个**无扩展名
   * 的裸名**（如 `notes`），会被当成内联正文返回（返回的是那个名字本身）。
   * 取「宁可当成文件引用报 404」会把 text 产出物的**短正文**（如 `已完成`）也判死，
   * 取当前口径最多影响这种极罕见的归档行。
   */
  static isInlineContentRef(ref: string): boolean {
    if (!ref) {
      return false;
    }
    if (ref.startsWith('/') || ref.startsWith('\\')) {
      return false;
    }
    if (/^[A-Za-z]:[\\/]/.test(ref)) {
      return false;
    }
    if (/^(https?|file):\/\//i.test(ref)) {
      return false;
    }
    const base = ref.split(/[\\/]/).pop() ?? '';
    return !/\.[A-Za-z0-9]{1,10}$/.test(base);
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
    // 磁盘名是 `<uuid>__<原始名>`：对外还原人类可读名（老文件纯 UUID → 原样）
    const name = FileStorageService.displayNameFromStored(base);
    return {
      name,
      ext: FileStorageService.extractExtension(name) ?? '',
      size,
    };
  }
}
