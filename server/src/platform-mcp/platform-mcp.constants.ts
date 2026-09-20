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
  /** 任务级/非法记忆 level（session-unification Todo 9：仅 team/global，余者 400，精确 code）。 */
  MEMORY_LEVEL_INVALID: 'MEMORY_LEVEL_INVALID',
  /** team_add_member：目标 Agent 已在团队（未移除）→ 400 重复加入。 */
  AGENT_ALREADY_IN_TEAM: 'PLATFORM_MCP_AGENT_ALREADY_IN_TEAM',
  /** team_add_member：该 Agent 已有 pending 增员申请未确认 → 409 冲突。 */
  PENDING_APPLICATION: 'PLATFORM_MCP_PENDING_APPLICATION',
  /** hook_cancel：hook 行不存在（id/dedupKey 双查均 miss）→ 404。 */
  HOOK_NOT_FOUND: 'PLATFORM_MCP_HOOK_NOT_FOUND',
  /**
   * notify_agent 主 Agent 路由门：非主成员直呼其他非主成员（含 self-notify）→ 403
   * 硬拦（消息不落库不广播）。调用方凭 code 与通用 FORBIDDEN 区分。
   */
  NOTIFY_ROUTING_VIOLATION: 'PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION',
  /**
   * 平台工具权限门（opencode-native-permissions-and-fixes todo 3）：调用方绑定的
   * ExecutionPolicy `tools` 矩阵未授权该工具（显式 deny 或未列入）→ 403。
   *
   * 与通用 FORBIDDEN 区分：那个表示 **归属** 校验失败（worker↔团队↔任务绑定、
   * 实例冒充、DM 端点），本码表示 **能力** 拒绝。调用方（模型/审计）凭 code
   * 即可机器判别「越权」与「不属于我」。fail-closed 语义与理由见
   * `CONTRACT-tool-naming-and-identity.md` §4（身份/角色/矩阵不可解析一律本码 403）。
   */
  TOOL_NOT_PERMITTED: 'PLATFORM_MCP_TOOL_NOT_PERMITTED',
} as const;

export type PlatformMcpErrorCode =
  (typeof PLATFORM_MCP_ERRORS)[keyof typeof PLATFORM_MCP_ERRORS];

/**
 * notify_agent `type` 值集（reply-join）：区分执行答复 / 求助 / 普通通知，
 * 决定 fan-out JOIN 计数与唤醒策略。未知值 → tools/call -32602。
 */
export const NOTIFY_TYPE = {
  answer: 'answer',
  question: 'question',
  help: 'help',
} as const;

export type NotifyType = (typeof NOTIFY_TYPE)[keyof typeof NOTIFY_TYPE];

/**
 * notify_agent `stage` 值集（reply-join）：process=执行进行中（仅持久化），
 * end=已完工（触发 ACK + drain 检查）。未知值 → tools/call -32602。
 */
export const NOTIFY_STAGE = {
  process: 'process',
  end: 'end',
} as const;

export type NotifyStage = (typeof NOTIFY_STAGE)[keyof typeof NOTIFY_STAGE];

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
  'channel_send',
  'skill_create',
  'memory_update',
  'git_repos_list',
] as const;

/** 平台 MCP server 标识（seed 阶段 2 的 mcp-servers 记录 name 对齐）。 */
export const PLATFORM_MCP_SERVER_NAME = 'vteam';
export const PLATFORM_MCP_SERVER_VERSION = '1.0.0';

const HOOK_RE =
  /\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer)\b/;
const HOOK_IMPORT_RE =
  /\bimport\s*[\s\S]*?\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer)\b[\s\S]*?\bfrom\s*['"]react['"]/;

export function validateTsxPrototype(source: string): string[] {
  const issues: string[] = [];
  const usedHooks = source.match(HOOK_RE);
  if (usedHooks && !HOOK_IMPORT_RE.test(source)) {
    const unique = [...new Set(usedHooks)];
    issues.push(
      `使用了 React hooks（${unique.join(', ')}）但缺少 import { ${unique.join(', ')} } from "react"`,
    );
  }
  if (!/export\s+const\s+meta\s*=/.test(source)) {
    issues.push('缺少 export const meta = { id, name } 声明');
  }
  if (!/export\s+default\s+function/.test(source)) {
    issues.push('缺少 export default function 组件导出');
  }
  return issues;
}
