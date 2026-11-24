import {
  TENANT_WORKSPACE_ID,
  workspaceDirSegment,
} from '../common/tenant/tenant.constants';

/**
 * is_0000000010：工作目录名 sanitize——agent 名称可能含中文/空格/斜杠等，做安全映射：
 * 保留字母数字下划线、点、连字符与 CJK 字符（Linux/UTF-8 支持中文目录，需求「与 agent
 * 名称同名」），其余非法字符（空格/斜杠/引号/路径分隔符等）→ `-`；去首尾连字符/点，
 * 兜底 `agent`（防空串/路径穿越/保留字）。
 *
 * 独立工具文件（不从 tasks.service 导出）：worker-dispatcher 与 tasks.service 共用同一
 * 规则，但 worker-dispatcher → tasks.service 会与 task-progression.scheduler →
 * worker-dispatcher 形成循环依赖（CJS 下 decorator 元数据拿到 undefined token，Nest
 * 无法解析构造依赖）。抽离为无依赖纯函数模块打破循环。
 */
export function sanitizeWorkDirName(name: string): string {
  const raw = String(name ?? '').trim();
  const base =
    raw
      .replace(/[^\p{L}\p{N}._-]/gu, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .replace(/\.{2,}/g, '.') || 'agent';
  return base;
}

/**
 * 任务工作目录根（env WORK_DIR 的缺省值）：任务目录 = `<根>/tasks/<taskId>`。
 *
 * 放在本纯函数模块而非 worker-dispatcher：plan-docs.service 也要用它拼同一个任务目录，
 * 若从 worker-dispatcher 导入会重演上面注释里的循环依赖（tasks 模块 ↔ chat 模块）。
 */

export const DEFAULT_TASK_WORK_DIR = '/data/vteam-worker';

/**
 * 空间化的目录根（M2）：
 * - 默认空间（ws_default）或未指定 → 保持历史布局 `<根>`（存量任务目录零迁移、零回归）；
 * - 其它空间 → `<根>/workspaces/<ws>`（空间之间物理隔离，防同名/互相可见）。
 *
 * 采用「默认空间=旧路径」的策略：单租户部署（全部存量数据在 ws_default）行为逐字节不变，
 * 多空间部署的非默认空间才引入新目录段。
 */
export function workspaceWorkRoot(root: string, workspaceId?: string): string {
  const base = String(root ?? '').replace(/\/+$/, '');
  if (!workspaceId || workspaceId === TENANT_WORKSPACE_ID.DEFAULT) {
    return base;
  }
  return `${base}/workspaces/${workspaceDirSegment(workspaceId)}`;
}

/**
 * 任务目录绝对路径（`<根>/tasks/<taskId>`，去尾斜杠避免 `//tasks`）。
 * worker-dispatcher 与 plan-docs.service 共用，保证"agent 写的"与"页面读的"同目录。
 */
export function taskDirOf(
  root: string,
  taskId: string,
  workspaceId?: string,
): string {
  return `${workspaceWorkRoot(root, workspaceId)}/tasks/${taskId}`;
}

/** 团队直聊工作目录（`<空间根>/teams/<teamId>`，与 taskDirOf 同一空间规则）。 */
export function teamDirOf(
  root: string,
  teamId: string,
  workspaceId?: string,
): string {
  return `${workspaceWorkRoot(root, workspaceId)}/teams/${teamId}`;
}
