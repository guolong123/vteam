import { join } from 'path';

/**
 * 文档站（is_0000000024 · 集成 prototype-viewer 文档渲染能力为任务产出物文档查看工具）。
 *
 * 架构（art_0000000039 v4 深度集成）：无额外进程/无代理。
 * - 渲染组件内嵌 web（DocExplorer 移植 web 组件库），数据走现有鉴权 API；
 * - server 仅提供**纯数据端点**（registry + prd）与 F1 镜像导出层；
 * - 镜像层：doc 产出物 → <docsRoot>/<taskId>/<slug>.md（派生视图，权威在 DB+uploads）。
 */

/** 文档站错误码（大写 SNAKE，随异常响应的 code 字段返回）。 */
export const DOCS_SITE_ERRORS = {
  /** 任务不存在。 */
  TASK_NOT_FOUND: 'DOCS_TASK_NOT_FOUND',
  /** 无文档站查看权限（非项目成员）。 */
  FORBIDDEN: 'DOCS_SITE_FORBIDDEN',
  /** 请求路径越界（taskId/文件名白名单校验失败）。 */
  PATH_OUT_OF_BOUNDS: 'DOCS_PATH_OUT_OF_BOUNDS',
  /** 文档不存在（镜像文件缺失）。 */
  DOC_NOT_FOUND: 'DOCS_DOC_NOT_FOUND',
} as const;

export type DocsSiteErrorCode = (typeof DOCS_SITE_ERRORS)[keyof typeof DOCS_SITE_ERRORS];

/** 镜像根目录默认值（相对 server 进程 cwd；生产建议挂持久卷到 /data/docs-root）。 */
export const DEFAULT_DOCS_ROOT = 'docs-root';

/**
 * 解析文档站镜像根目录（MD_DOCS_ROOT 环境变量可覆盖，默认 server/docs-root）。
 * v4 深度集成仅需镜像根（无 dev/static 模式、无 upstream——数据端点直接读镜像）。
 */
export function resolveDocsRoot(): string {
  return join(process.cwd(), process.env.MD_DOCS_ROOT ?? DEFAULT_DOCS_ROOT);
}
