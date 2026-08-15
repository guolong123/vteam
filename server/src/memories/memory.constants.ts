/**
 * 记忆等级常量（memory-management）。
 *
 * 字符串枚举 + 应用层常量（双库兼容：不声明 Prisma enum，
 * 对齐 schema.prisma 头部「字符串枚举 + Json 列」约定）：
 *   - task：任务级记忆（taskId + 冗余 projectId）
 *   - project：项目级记忆（仅 projectId）
 *   - global：全局记忆（两者均为空）
 */
export const MEMORY_LEVELS = {
  task: 'task',
  project: 'project',
  global: 'global',
} as const;

export type MemoryLevel = (typeof MEMORY_LEVELS)[keyof typeof MEMORY_LEVELS];

/**
 * 记忆域错误码常量（对齐 tool.constants / mcp-server.constants 命名约定：
 * 大写 SNAKE，随异常响应的 code 字段返回）。
 *
 * - 目标记忆不存在（DELETE）→ 404 MEMORY_NOT_FOUND（含已软删条目）
 */
export const MEMORY_ERRORS = {
  MEMORY_NOT_FOUND: 'MEMORY_NOT_FOUND',
} as const;

export type MemoryErrorCode = (typeof MEMORY_ERRORS)[keyof typeof MEMORY_ERRORS];
