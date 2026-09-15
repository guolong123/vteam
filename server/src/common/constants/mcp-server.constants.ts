/**
 * MCP 服务器域错误码常量（对齐 tool.constants / skill.constants 命名约定：
 * 大写 SNAKE，随异常响应的 code 字段返回）。
 *
 * - 目标服务器不存在（GET/PATCH/DELETE/POST :id/sync）→ 404 MCP_SERVER_NOT_FOUND
 * - name 唯一冲突（POST/PATCH 撞 @unique name）→ 409 MCP_SERVER_NAME_EXISTS
 * - local/remote 配置不合法（POST/PATCH 分支校验失败）→ 400 MCP_SERVER_INVALID_CONFIG
 * - 工具同步失败（POST :id/sync 连接/发现失败，含服务端要求 OAuth）→ 400 MCP_SERVER_SYNC_FAILED
 */
export const MCP_SERVER_ERRORS = {
  MCP_SERVER_NOT_FOUND: 'MCP_SERVER_NOT_FOUND',
  MCP_SERVER_NAME_EXISTS: 'MCP_SERVER_NAME_EXISTS',
  MCP_SERVER_INVALID_CONFIG: 'MCP_SERVER_INVALID_CONFIG',
  MCP_SERVER_SYNC_FAILED: 'MCP_SERVER_SYNC_FAILED',
} as const;

export type McpServerErrorCode =
  (typeof MCP_SERVER_ERRORS)[keyof typeof MCP_SERVER_ERRORS];
