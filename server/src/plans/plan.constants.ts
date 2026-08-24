/**
 * 协作计划域常量（vteam-team-collaboration tc-store）。
 *
 * 字符串枚举 + 应用层常量（双库兼容：不声明 Prisma enum，
 * 对齐 schema.prisma 头部「字符串枚举 + Json 列」约定）：
 *   - PLAN_STATUS：计划状态机 draft → reviewing → approved → executing → completed
 *     （rejected 为评审驳回态；draft 为预留态——当前 planSubmit 直接落 reviewing，
 *     draft→reviewing 无独立迁移动作，保留供未来「草稿保存」扩展）
 *   - PLAN_TASK_STATUS：计划子任务状态
 *   - EXECUTION_MODES：任务执行模式（tasks.execution_mode，默认 direct）
 */
export const PLAN_STATUS = {
  draft: 'draft',
  reviewing: 'reviewing',
  approved: 'approved',
  rejected: 'rejected',
  executing: 'executing',
  completed: 'completed',
} as const;

export type PlanStatus = (typeof PLAN_STATUS)[keyof typeof PLAN_STATUS];

export const PLAN_TASK_STATUS = {
  pending: 'pending',
  in_progress: 'in_progress',
  done: 'done',
  blocked: 'blocked',
  skipped: 'skipped',
} as const;

export type PlanTaskStatus =
  (typeof PLAN_TASK_STATUS)[keyof typeof PLAN_TASK_STATUS];

export const EXECUTION_MODES = {
  direct: 'direct',
  plan: 'plan',
} as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[keyof typeof EXECUTION_MODES];

/**
 * 协作计划域错误码常量（对齐 memory.constants / tool.constants 命名约定：
 * 大写 SNAKE，随异常响应的 code 字段返回）。
 */
export const PLAN_ERRORS = {
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  PLAN_INVALID_STATUS: 'PLAN_INVALID_STATUS',
  PLAN_STRUCTURE_INVALID: 'PLAN_STRUCTURE_INVALID',
  PLAN_NOT_APPROVED: 'PLAN_NOT_APPROVED',
  PLAN_TASKS_INCOMPLETE: 'PLAN_TASKS_INCOMPLETE',
  PLAN_REVIEW_ROUNDS_EXCEEDED: 'PLAN_REVIEW_ROUNDS_EXCEEDED',
} as const;

export type PlanErrorCode = (typeof PLAN_ERRORS)[keyof typeof PLAN_ERRORS];
