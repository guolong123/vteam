/**
 * 记忆等级常量（2026-09-30 起 team/global/role 三级，task 级已删除——
 * level=task 入参一律 400 MEMORY_LEVEL_INVALID）。
 *
 * 字符串枚举 + 应用层常量（双库兼容：不声明 Prisma enum，
 * 对齐 schema.prisma 头部「字符串枚举 + Json 列」约定）。
 *
 * **各级的自动注入受众**（`auto_inject=true` 时，见 worker-dispatcher 的
 * `buildTeamMemoryIndex`）——受众是「这条记忆给谁看」，与「谁写的」无关：
 *   - team：团队级（teamId，跨任务共享）→ **本团队主 Agent**
 *   - role：角色级（teamId + roleId，团队内该岗位共享）→ **本团队该岗位全部 agent**
 *   - global：全局（无归属，跨团队）→ **各团队主 Agent**
 */
export const MEMORY_LEVELS = {
  team: 'team',
  role: 'role',
  global: 'global',
} as const;

export type MemoryLevel = (typeof MEMORY_LEVELS)[keyof typeof MEMORY_LEVELS];

/**
 * 记忆域错误码常量（对齐 tool.constants / mcp-server.constants 命名约定：
 * 大写 SNAKE，随异常响应的 code 字段返回）。
 *
 * - 目标记忆不存在（DELETE/purge）→ 404 MEMORY_NOT_FOUND（含已软删条目）
 * - 任务级/非法 level 入参（session-unification Todo 9，任务级记忆已删除）→ 400 MEMORY_LEVEL_INVALID
 * - 更新无有效字段（PATCH /memory_update 全空）→ 400 MEMORY_UPDATE_EMPTY
 * - 行级鉴权失败（memory-enhancement Todo 2：团队行非成员 / 全局行非管理员）→ 403 MEMORY_FORBIDDEN
 * - 恢复撞同 scope 活跃同 hash 行（restore）→ 409 MEMORY_RESTORE_DUPLICATE
 */
export const MEMORY_ERRORS = {
  MEMORY_NOT_FOUND: 'MEMORY_NOT_FOUND',
  MEMORY_LEVEL_INVALID: 'MEMORY_LEVEL_INVALID',
  MEMORY_UPDATE_EMPTY: 'MEMORY_UPDATE_EMPTY',
  MEMORY_FORBIDDEN: 'MEMORY_FORBIDDEN',
  MEMORY_RESTORE_DUPLICATE: 'MEMORY_RESTORE_DUPLICATE',
} as const;

import { createHash } from 'node:crypto';

export type MemoryErrorCode =
  (typeof MEMORY_ERRORS)[keyof typeof MEMORY_ERRORS];

export type MemorySaveStatus = 'created' | 'duplicate';

export type MemoryUpdateStatus = 'updated';

/**
 * 记忆内容归一化（精确去重键输入，T4 记忆演进）。
 * 统一换行符 + 去首尾空白；语义相近但文本不同的合并仍只是 prompt 提示，不阻塞写入。
 */
export function normalizeMemoryContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * 精确去重键：sha256(归一化 content)，与 memories.contentHash 列对应。
 * save 前按 level + 归属 + hash 查命中即返 duplicate（check-then-insert 竞态接受，不建唯一键）。
 */
export function computeMemoryContentHash(content: string): string {
  return createHash('sha256')
    .update(normalizeMemoryContent(content), 'utf8')
    .digest('hex');
}
