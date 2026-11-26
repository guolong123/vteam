import { createHmac, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { workspaceDirSegment } from '../common/tenant/tenant.constants';

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

/** 工作空间文件子目录名（`<根>/workspaces/<ws>/`）。 */
export const UPLOAD_WORKSPACES_SEGMENT = 'workspaces';

/** URL 前缀（静态服务挂载点）。 */
export const UPLOAD_URL_PREFIX = '/uploads';

/**
 * 工作空间在磁盘/URL 中使用的目录名：只允许字母数字下划线连字符（防路径穿越），
 * 非法字符替换为 `-`；空串回落 `default`。
 */
export function uploadWorkspaceSegment(workspaceId?: string): string {
  return workspaceDirSegment(workspaceId);
}

/**
 * 解析上传存储目录（UPLOAD_DIR 环境变量可覆盖，默认 server/uploads）。
 * main.ts 静态挂载与 FileStorageService 磁盘存储共用同一来源，保证读/写同目录。
 *
 * 传 workspaceId（有租户上下文时）→ `<根>/workspaces/<ws>/`：不同空间文件物理分区，
 * 防同名覆盖与路径穿越；不传 → 根目录（兼容存量文件与静态挂载点）。
 */
export function resolveUploadDir(workspaceId?: string): string {
  const base = join(
    process.cwd(),
    process.env.UPLOAD_DIR ?? DEFAULT_UPLOAD_DIR,
  );
  if (!workspaceId) return base;
  return join(
    base,
    UPLOAD_WORKSPACES_SEGMENT,
    uploadWorkspaceSegment(workspaceId),
  );
}

/** 由文件名与空间构造可访问 URL（`/uploads/workspaces/<ws>/<file>`；无空间 = 旧路径）。 */
export function uploadUrlPath(filename: string, workspaceId?: string): string {
  if (!workspaceId) return `${UPLOAD_URL_PREFIX}/${filename}`;
  return `${UPLOAD_URL_PREFIX}/${UPLOAD_WORKSPACES_SEGMENT}/${uploadWorkspaceSegment(workspaceId)}/${filename}`;
}

/** 需要签名的 URL 前缀（空间分区后的新路径；存量根目录保持可读以兼容旧数据）。 */
export const UPLOAD_SIGNED_URL_PREFIX = `${UPLOAD_URL_PREFIX}/${UPLOAD_WORKSPACES_SEGMENT}/`;

/** 上传 URL 签名密钥（UPLOAD_URL_SECRET，缺省回落 JWT_SECRET；都没有用开发占位）。 */
export function uploadUrlSigningSecret(): string {
  return (
    process.env.UPLOAD_URL_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    'vteam-dev-upload-url-secret'
  );
}

/** 上传 URL 有效期（UPLOAD_URL_TTL_SECONDS，默认 180 天）。 */
export function uploadUrlTtlSeconds(): number {
  const raw = Number.parseInt(process.env.UPLOAD_URL_TTL_SECONDS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 180 * 24 * 60 * 60;
}

/**
 * 给空间分区上传 URL 追加 `?exp&sig`（HMAC-SHA256，防枚举/盗链）。
 * - 存量根目录 URL（`/uploads/<file>`）不加签名，保持历史可读；
 * - 幂等：已带 exp/sig 的 URL 原样返回。
 */
export function signUploadUrl(url: string, nowMs: number = Date.now()): string {
  if (!url.startsWith(UPLOAD_SIGNED_URL_PREFIX)) return url;
  if (/[?&]sig=/.test(url)) return url;
  const path = url.split('?')[0];
  const exp = Math.floor(nowMs / 1000) + uploadUrlTtlSeconds();
  const sig = createHmac('sha256', uploadUrlSigningSecret())
    .update(`${path}|${exp}`)
    .digest('hex')
    .slice(0, 32);
  return `${path}?exp=${exp}&sig=${sig}`;
}

/**
 * 校验空间分区上传 URL 的签名与有效期；存量根目录 URL 直接放行。
 * 可在 `UPLOAD_URL_SIGNATURE_ENFORCE=false` 时整体关闭（迁移期回退开关，main.ts 读取）。
 */
export function verifyUploadUrlSignature(
  url: string,
  query: { exp?: unknown; sig?: unknown },
  nowMs: number = Date.now(),
): boolean {
  const path = url.split('?')[0];
  if (!path.startsWith(UPLOAD_SIGNED_URL_PREFIX)) return true;
  const exp = Number(query.exp);
  const sig = typeof query.sig === 'string' ? query.sig : '';
  if (!Number.isFinite(exp) || exp * 1000 < nowMs || !sig) return false;
  /**
   * 浏览器会把中文/空格文件名自动百分号编码，Express originalUrl 保留编码形态。
   * 签名生成使用归一化后的 Unicode 路径，因此验签必须先解码；否则所有中文文件
   * 在线上都返回 403，文档预览只表现为空白/下载失败。
   */
  let canonicalPath = path;
  try {
    canonicalPath = decodeURIComponent(path);
  } catch {
    return false;
  }
  const expected = createHmac('sha256', uploadUrlSigningSecret())
    .update(`${canonicalPath}|${exp}`)
    .digest('hex')
    .slice(0, 32);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * 解析 `/uploads/...` URL 的相对磁盘路径（用于读文件/取大小）。
 * - `/uploads/workspaces/<ws>/<file>` → `workspaces/<ws>/<file>`
 * - `/uploads/<file>` → `<file>`（存量/无空间）
 * 返回 null 表示不是 /uploads URL。
 */
export function uploadRelativePathOf(url: string): string | null {
  const prefix = `${UPLOAD_URL_PREFIX}/`;
  const pathOnly = url.split('?')[0];
  if (!pathOnly.startsWith(prefix)) return null;
  return pathOnly.slice(prefix.length);
}
