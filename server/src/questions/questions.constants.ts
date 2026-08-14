/**
 * 模型提问 / 工具权限确认域常量（AgentQuestion 表语义，对齐 serve question/permission 契约）。
 */

/** AgentQuestion.kind 枚举（worker 事件类型区分）。 */
export const AGENT_QUESTION_KINDS = {
  QUESTION: 'question',
  PERMISSION: 'permission',
} as const;

/** AgentQuestion.status 枚举（pending → resolved/rejected；expired=僵尸/超期自动终态）。 */
export const AGENT_QUESTION_STATUS = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  REJECTED: 'rejected',
  /** 僵尸/超期：serve 已无对应 requestId（转发 404）或 pending 超 TTL 未回复 → 自动终态收敛弹窗。 */
  EXPIRED: 'expired',
} as const;

/** AgentQuestion 主键前缀（对齐 15 篇 §2.2：`aq_<零填充序号>`）。 */
export const AGENT_QUESTION_ID_PREFIX = 'aq';

/** pending 惰性过期阈值 ms（30min：超时未回复的 question/权限视为过期，GET /questions 时自动终态收敛）。 */
export const QUESTION_PENDING_TTL_MS = 30 * 60 * 1000;

/** 权限确认 response 枚举（对齐 serve replyPermission 契约）。 */
export const PERMISSION_RESPONSES = ['once', 'always', 'reject'] as const;
export type PermissionResponse = (typeof PERMISSION_RESPONSES)[number];

/** questions 模块错误码（对齐 09 篇 §2 错误响应 {code, message}）。 */
export const QUESTIONS_ERRORS = {
  QUESTION_NOT_FOUND: 'QUESTION_NOT_FOUND',
  QUESTION_WORKER_UNAVAILABLE: 'QUESTION_WORKER_UNAVAILABLE',
  QUESTION_INVALID_REPLY: 'QUESTION_INVALID_REPLY',
  QUESTION_ALREADY_RESOLVED: 'QUESTION_ALREADY_RESOLVED',
  /** 僵尸/超期：serve 已无该请求（reply 转发 404 或 pending 超 TTL）→ 410 Gone，前端据此关闭弹窗。 */
  QUESTION_EXPIRED: 'QUESTION_EXPIRED',
} as const;
