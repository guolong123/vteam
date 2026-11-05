import { join } from 'path';

/**
 * 上传域常量（FILE-01/02、UX-10 共享的文件存储基础能力）。
 *
 * 统一约定：
 * - 文件落盘 `server/uploads/`（可经 UPLOAD_DIR 环境变量覆盖），静态服务挂 `/uploads/*`
 * - 文件名 = `UUID<ext>`（randomUUID，保留扩展名），杜绝重名/路径穿越
 * - 大小上限 20MB（multer limits，超限 413，与 skills 上传同款机制）
 * - **不限扩展名**：任意扩展名 / 无扩展名文件都允许上传（不再有类型白名单）
 *
 * 为什么放弃扩展名白名单（需求变更）：
 * - 旧实现按扩展名白名单（pdf/doc/…）拦截，导致 zip / 代码 / 日志 / 数据等类型传不上去；
 * - 新口径是「**模型能读的按既有逻辑读，不能读的由模型自行决定处理**」——例如 zip 由
 *   模型自行解压、二进制由模型转换后再读。可读性与处理方式属于模型侧决策，控制面只负责
 *   安全落盘与分发，不预设「哪些类型可上传」。
 *
 * ⚠️ 这不是安全倒退：放宽白名单后的补偿在静态服务侧（main.ts 的 `/uploads` 挂载）——
 * 落盘文件一律带 `Content-Disposition: attachment` 强制下载、`X-Content-Type-Options:
 * nosniff` 禁止 MIME 嗅探、`Content-Security-Policy: default-src 'none'; sandbox`
 * 禁止在本源内联执行；因此上传 .html/.svg 等也无法在站内执行脚本（<img> 预览为子资源
 * 加载，Content-Disposition 只影响顶层导航，不影响图片渲染）。
 */

/** 上传错误码（大写 SNAKE，随异常响应的 code 字段返回，对齐 skill/tool 常量）。 */
export const UPLOAD_ERRORS = {
  /** multipart 未携带 file 字段：POST /uploads → 400。 */
  FILE_REQUIRED: 'UPLOAD_FILE_REQUIRED',
  /** read_file：引用非 /uploads/ 落盘文件（外部 URL / worker 原始路径未归档）→ 400。 */
  FILE_NOT_READABLE: 'UPLOAD_FILE_NOT_READABLE',
} as const;

export type UploadErrorCode =
  (typeof UPLOAD_ERRORS)[keyof typeof UPLOAD_ERRORS];

/** 单文件大小上限（20MB，与前端/worker 对齐）。 */
export const FILE_SIZE_LIMIT = 20 * 1024 * 1024;

/** 默认存储根目录（相对 server 进程 cwd，即 `server/uploads/`）。 */
export const DEFAULT_UPLOAD_DIR = 'uploads';

/**
 * 解析上传存储目录（UPLOAD_DIR 环境变量可覆盖，默认 server/uploads）。
 * main.ts 静态挂载与 FileStorageService 磁盘存储共用同一来源，保证读/写同目录。
 */
export function resolveUploadDir(): string {
  return join(process.cwd(), process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR);
}
