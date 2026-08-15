import { join } from 'path';

/**
 * 文档站（is_0000000024 · 集成 prototype-viewer 作为任务产出物文档查看工具）。
 *
 * 架构（art_0000000026 v2）：同源代理 + 任务模式数据源注入。
 * - 工具 = vteam 仓库 prototype-viewer（Vite App），静态构建产物 + dev server 两种形态；
 * - 任务模式：URL 携带 ?task=<taskId> → 工具从 server 拉取动态注册表 + 文档内容；
 * - 镜像层：doc 产出物 → <docsRoot>/<taskId>/<slug>.md（派生视图，权威在 DB+uploads）。
 */

/** 文档站错误码（大写 SNAKE，随异常响应的 code 字段返回）。 */
export const DOCS_SITE_ERRORS = {
  /** 任务不存在。 */
  TASK_NOT_FOUND: 'DOCS_TASK_NOT_FOUND',
  /** 无文档站查看权限（非项目成员）。 */
  FORBIDDEN: 'DOCS_SITE_FORBIDDEN',
  /** 文档站未配置（MD_DOCS_ROOT/MD_DOCS_MODE 缺失）。 */
  NOT_CONFIGURED: 'DOCS_SITE_NOT_CONFIGURED',
  /** 请求路径越界（taskId/文件名白名单校验失败）。 */
  PATH_OUT_OF_BOUNDS: 'DOCS_PATH_OUT_OF_BOUNDS',
  /** 文档不存在（镜像文件缺失）。 */
  DOC_NOT_FOUND: 'DOCS_DOC_NOT_FOUND',
} as const;

export type DocsSiteErrorCode = (typeof DOCS_SITE_ERRORS)[keyof typeof DOCS_SITE_ERRORS];

/** 镜像根目录默认值（相对 server 进程 cwd；生产建议挂持久卷到 /data/docs-root）。 */
export const DEFAULT_DOCS_ROOT = 'docs-root';

/** 文档站模式：dev=Vite dev server 常驻（回环）；static=静态构建产物。 */
export const DOCS_SITE_MODES = {
  dev: 'dev',
  static: 'static',
} as const;

export type DocsSiteMode = (typeof DOCS_SITE_MODES)[keyof typeof DOCS_SITE_MODES];

/** dev 模式 upstream 默认地址（仅回环，不对公网暴露；prototype-viewer vite 默认 5173）。 */
export const DEFAULT_DOCS_UPSTREAM = 'http://127.0.0.1:5173';

/**
 * 解析文档站镜像根目录（MD_DOCS_ROOT 环境变量可覆盖，默认 server/docs-root）。
 * 与 uploads 同级约定（resolveUploadDir 同模式）：main.ts 不需静态挂载（经 controller 鉴权代理读）。
 */
export function resolveDocsRoot(): string {
  return join(process.cwd(), process.env.MD_DOCS_ROOT ?? DEFAULT_DOCS_ROOT);
}
