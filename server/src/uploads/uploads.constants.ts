import { join } from 'path';

/**
 * 上传域常量（FILE-01/02、UX-10 共享的文件存储基础能力）。
 *
 * 统一约定：
 * - 文件落盘 `server/uploads/`（可经 UPLOAD_DIR 环境变量覆盖），静态服务挂 `/uploads/*`
 * - 文件名 = `UUID<ext>`（randomUUID，保留扩展名），杜绝重名/路径穿越
 * - 大小上限 10MB（multer limits，超限 413，与 skills 上传同款机制）
 * - 类型白名单按**扩展名**校验（浏览器上传的 mimetype 常被统一为
 *   application/octet-stream，扩展名才是可控可信的类型信号；返回 ext 同源）
 */

/** 上传错误码（大写 SNAKE，随异常响应的 code 字段返回，对齐 skill/tool 常量）。 */
export const UPLOAD_ERRORS = {
  /** multipart 未携带 file 字段：POST /uploads → 400。 */
  FILE_REQUIRED: 'UPLOAD_FILE_REQUIRED',
  /** 扩展名不在白名单（pdf/doc/…）：POST /uploads → 400。 */
  FILE_TYPE_NOT_ALLOWED: 'UPLOAD_FILE_TYPE_NOT_ALLOWED',
} as const;

export type UploadErrorCode = (typeof UPLOAD_ERRORS)[keyof typeof UPLOAD_ERRORS];

/** 文件类型白名单（扩展名，小写；对齐任务要求：pdf/doc/docx/xlsx/csv/png/jpg/jpeg/gif/md/txt 等）。 */
export const ALLOWED_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'csv',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'md',
  'txt',
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

/** 单文件大小上限（10MB）。 */
export const FILE_SIZE_LIMIT = 10 * 1024 * 1024;

/** 默认存储根目录（相对 server 进程 cwd，即 `server/uploads/`）。 */
export const DEFAULT_UPLOAD_DIR = 'uploads';

/**
 * 解析上传存储目录（UPLOAD_DIR 环境变量可覆盖，默认 server/uploads）。
 * main.ts 静态挂载与 FileStorageService 磁盘存储共用同一来源，保证读/写同目录。
 */
export function resolveUploadDir(): string {
  return join(process.cwd(), process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR);
}
