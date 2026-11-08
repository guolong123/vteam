/**
 * 全局会话（37 篇 P3）状态常量。
 * 字符串枚举 + 应用层常量（双库兼容，不声明 Prisma enum）。
 */

/** session_turns.status：pending=待执行（不是产品队列位次）、running=执行中、其余终态。 */
export const SESSION_TURN_STATUS = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
} as const;

export type SessionTurnStatus =
  (typeof SESSION_TURN_STATUS)[keyof typeof SESSION_TURN_STATUS];

/** 轮次来源：谁触发了这一轮（用于审计/回执/UI 标注）。 */
export const SESSION_TURN_SOURCE = {
  userMention: 'user_mention',
  agentNotify: 'agent_notify',
  hookWake: 'hook_wake',
  taskStart: 'task_start',
  manual: 'manual',
} as const;

export type SessionTurnSource =
  (typeof SESSION_TURN_SOURCE)[keyof typeof SESSION_TURN_SOURCE];

/** Session.busy_state：信息态（执行互斥由 session_turns.running_key 唯一索引兜底）。 */
export const SESSION_BUSY_STATE = {
  idle: 'idle',
  running: 'running',
} as const;

/** 最近一轮结果（Session.last_turn_outcome）。 */
export const SESSION_TURN_OUTCOME = {
  ok: 'ok',
  error: 'error',
  timeout: 'timeout',
  cancelled: 'cancelled',
} as const;

export const GLOBAL_SESSION_ERRORS = {
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  MEMBER_DISABLED: 'MEMBER_DISABLED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_TURN_NOT_FOUND: 'SESSION_TURN_NOT_FOUND',
  SESSION_TURN_MEMBER_MISMATCH: 'SESSION_TURN_MEMBER_MISMATCH',
} as const;
