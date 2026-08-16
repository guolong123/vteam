/**
 * 平台 MCP 域常量（阶段 1：server 平台 MCP 端点，`.omo/plans/platform-mcp-implementation.md`）。
 *
 * 错误码命名沿用既有约定（大写 SNAKE，随异常响应 code 字段返回）：
 * - 缺少 x-worker-id header / 归属校验失败（该 worker 无对应任务的 Session）→ 403
 * - 任务/频道/产出物/版本不存在 → 404
 * - submit_artifact 参数非法（text 缺 content / doc/file 缺 fileRef）→ 400
 */
export const PLATFORM_MCP_ERRORS = {
  MISSING_WORKER_ID: 'PLATFORM_MCP_MISSING_WORKER_ID',
  FORBIDDEN: 'PLATFORM_MCP_FORBIDDEN',
  TASK_NOT_FOUND: 'PLATFORM_MCP_TASK_NOT_FOUND',
  CHANNEL_NOT_FOUND: 'PLATFORM_MCP_CHANNEL_NOT_FOUND',
  ARTIFACT_NOT_FOUND: 'PLATFORM_MCP_ARTIFACT_NOT_FOUND',
  VERSION_NOT_FOUND: 'PLATFORM_MCP_VERSION_NOT_FOUND',
  FILE_NOT_FOUND: 'PLATFORM_MCP_FILE_NOT_FOUND',
  ARTIFACT_INVALID: 'PLATFORM_MCP_ARTIFACT_INVALID',
  MEMORY_INVALID: 'PLATFORM_MCP_MEMORY_INVALID',
  /** team_add_member：目标 Agent 已在团队（未移除）→ 400 重复加入。 */
  AGENT_ALREADY_IN_TEAM: 'PLATFORM_MCP_AGENT_ALREADY_IN_TEAM',
  /** team_add_member：该 Agent 已有 pending 增员申请未确认 → 409 冲突。 */
  PENDING_APPLICATION: 'PLATFORM_MCP_PENDING_APPLICATION',
} as const;

export type PlatformMcpErrorCode =
  (typeof PLATFORM_MCP_ERRORS)[keyof typeof PLATFORM_MCP_ERRORS];

/**
 * 平台 MCP 工具名（SDK registerTool/tool 注册，tools/list 返回工具清单）。
 * chat_history / doclib / task_context / group_post / read_file / notify_agent
 * / submit_artifact（设计文档 §5 工具集 v1 + read_file + FR-13 notify_agent
 * + submit_artifact：agent 直接提交产出物）。
 */
export const PLATFORM_MCP_TOOLS = [
  'chat_history',
  'doclib',
  'task_context',
  'group_post',
  'read_file',
  'notify_agent',
  'submit_artifact',
] as const;

/** 平台 MCP server 标识（seed 阶段 2 的 mcp-servers 记录 name 对齐）。 */
export const PLATFORM_MCP_SERVER_NAME = 'vteam';
export const PLATFORM_MCP_SERVER_VERSION = '1.0.0';
