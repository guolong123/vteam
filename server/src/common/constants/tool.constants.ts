/**
 * Tool 域错误码常量（对齐 agent.constants / task.constants 命名约定：大写 SNAKE，
 * 随异常响应的 code 字段返回）。
 *
 * - 目标工具不存在（GET/PATCH/DELETE）→ 404 TOOL_NOT_FOUND
 * - action 唯一冲突（POST/PATCH 撞 @unique action）→ 409 TOOL_ACTION_EXISTS
 */
export const TOOL_ERRORS = {
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_ACTION_EXISTS: 'TOOL_ACTION_EXISTS',
} as const;

export type ToolErrorCode = (typeof TOOL_ERRORS)[keyof typeof TOOL_ERRORS];
