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

/**
 * 平台侧创建 question 的 source 标记（AgentQuestion.content.source='platform'）。
 * 平台 question（如主 Agent 申请增员的确认门）不经 worker 转发——serve 无该 requestId
 * 必 404→expire，reply/confirmByAgent 据此短路 forwardReply（Oracle R2 旁路）。
 */
export const PLATFORM_QUESTION_SOURCE = 'platform';

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
  /** 托管读团队行时团队归属存在但团队行缺失（session-unification Todo 9）→ 404。 */
  QUESTION_TEAM_NOT_FOUND: 'QUESTION_TEAM_NOT_FOUND',
} as const;

/**
 * confirmByAgent 完整性拒绝码（question_confirm 身份门禁移除后的替代防线）：
 * 自批拒绝 + 跨任务确认拒绝。两码均 403，独立于 QUESTIONS_ERRORS（后者语义为参数/状态错误）。
 */
export const QUESTION_CONFIRM_INTEGRITY_ERRORS = {
  /** 确认者本人即请求发起者 → 拒绝（防自批）。 */
  SELF_CONFIRMATION_FORBIDDEN: 'QUESTION_SELF_CONFIRMATION_FORBIDDEN',
  /** 请求归属任务与调用方任务不一致 → 拒绝（防跨任务确认）。 */
  CROSS_TASK_FORBIDDEN: 'QUESTION_CROSS_TASK_FORBIDDEN',
} as const;
