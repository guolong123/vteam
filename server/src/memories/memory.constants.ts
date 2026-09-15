/**
 * 记忆等级常量（memory-management；session-unification Todo 9 起仅 team/global，
 * 任务级记忆已删除——level=task 入参一律 400 MEMORY_LEVEL_INVALID）。
 *
 * 字符串枚举 + 应用层常量（双库兼容：不声明 Prisma enum，
 * 对齐 schema.prisma 头部「字符串枚举 + Json 列」约定）：
 *   - team：团队级记忆（仅 teamId，跨任务共享）
 *   - global：全局记忆（两者均为空）
 */
export const MEMORY_LEVELS = {
  team: 'team',
  global: 'global',
} as const;

export type MemoryLevel = (typeof MEMORY_LEVELS)[keyof typeof MEMORY_LEVELS];

/**
 * 记忆域错误码常量（对齐 tool.constants / mcp-server.constants 命名约定：
 * 大写 SNAKE，随异常响应的 code 字段返回）。
 *
 * - 目标记忆不存在（DELETE）→ 404 MEMORY_NOT_FOUND（含已软删条目）
 * - 任务级/非法 level 入参（session-unification Todo 9，任务级记忆已删除）→ 400 MEMORY_LEVEL_INVALID
 * - 更新无有效字段（PATCH /memory_update 全空）→ 400 MEMORY_UPDATE_EMPTY
 */
export const MEMORY_ERRORS = {
  MEMORY_NOT_FOUND: 'MEMORY_NOT_FOUND',
  MEMORY_LEVEL_INVALID: 'MEMORY_LEVEL_INVALID',
  MEMORY_UPDATE_EMPTY: 'MEMORY_UPDATE_EMPTY',
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
