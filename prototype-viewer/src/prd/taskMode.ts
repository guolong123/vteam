/**
 * 任务模式（is_0000000024 F2 · art_0000000030 v3）
 * =============================================================
 * 当 URL 携带 `?task=<taskId>`（整页导航首跳，server 302 去 token 后保留 task 参数）：
 * - 文档注册表改为从 server 拉取（GET /docs-site/:taskId/registry）；
 * - 文档内容 fetch 改为 GET /docs-site/:taskId/prd/<file>（server 鉴权 + taskId 隔离）；
 * - 非任务模式保持现状（PRD 本地模式：public/prd + 静态注册表 docs.ts）。
 * 鉴权：首跳后 server 已 Set-Cookie（httpOnly），后续 registry/prd 请求同源自动携带。
 */

/** 从 URL 解析任务模式标识（?task=<taskId>）。 */
export function detectTaskMode(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const task = params.get("task");
  return task && /^t_[a-zA-Z0-9_]+$/.test(task) ? task : null;
}

/** 任务模式下 server 侧 base（registry/prd 请求）。 */
export function taskBase(taskId: string): string {
  return `/docs-site/${encodeURIComponent(taskId)}`;
}

/** server 动态注册表返回的 DocDef 形状（与本地 docs.ts DocDef 对齐）。 */
export interface TaskDocDef {
  id: string;
  name: string;
  kind: string;
  description: string;
  file: string;
  order: number;
}
