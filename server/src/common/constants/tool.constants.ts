/**
 * Tool 域错误码常量（对齐 agent.constants / task.constants 命名约定：大写 SNAKE，
 * 随异常响应的 code 字段返回）。
 *
 * - 目标工具不存在（GET/PATCH/DELETE）→ 404 TOOL_NOT_FOUND
 * - action 唯一冲突（POST/PATCH 撞 @unique action）→ 409 TOOL_ACTION_EXISTS
 * - execution=mcp 时 mcpServer 指向的 MCP 服务器不存在（name/id 均未命中
 *   mcp_servers）→ 400 TOOL_MCP_SERVER_NOT_FOUND（弱关联防断链：注册 MCP 工具
 *   必须绑定已注册的服务器，否则前端反查 server 名/类型/状态失败）
 */
export const TOOL_ERRORS = {
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_ACTION_EXISTS: 'TOOL_ACTION_EXISTS',
  TOOL_MCP_SERVER_NOT_FOUND: 'TOOL_MCP_SERVER_NOT_FOUND',
} as const;

export type ToolErrorCode = (typeof TOOL_ERRORS)[keyof typeof TOOL_ERRORS];
