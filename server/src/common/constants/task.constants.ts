/**
 * 任务状态机常量（对齐 13 篇 §3 五态状态机、09 篇 §3.4 / §2.1）。
 *
 * - 六态迁移链唯一确定，无跳态；reject 是验收驳回后退，block/resume 是执行阻塞侧挂。
 * - blocked 只能进出 in_progress（阻塞必须写原因，恢复即回进行中；完成永远走验收）。
 * - 非法迁移 409 `TASK_INVALID_TRANSITION`，已处目标态幂等返回 200。
 */

export const TASK_STATUS = {
  queued: 'queued',
  pending: 'pending',
  in_progress: 'in_progress',
  blocked: 'blocked',
  pending_review: 'pending_review',
  completed: 'completed',
  archived: 'archived',
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

/** 七态顺序（queued 预排队 + 六态，06 篇 task-board 扩展；blocked 列看板展示卡住任务）。 */
export const TASK_STATUS_ORDER: readonly TaskStatus[] = [
  TASK_STATUS.queued,
  TASK_STATUS.pending,
  TASK_STATUS.in_progress,
  TASK_STATUS.blocked,
  TASK_STATUS.pending_review,
  TASK_STATUS.completed,
  TASK_STATUS.archived,
];

export const TASK_PRIORITY = {
  high: 'high',
  medium: 'medium',
  low: 'low',
} as const;

export type TaskPriority = (typeof TASK_PRIORITY)[keyof typeof TASK_PRIORITY];

/**
 * 合法迁移表（13 篇 §3.2 迁移总表）：
 * 动作 → { from, to }，迁移表驱动状态机判定，新增动作只改表不改分支逻辑。
 */
export const TASK_TRANSITIONS = {
  start: { from: TASK_STATUS.pending, to: TASK_STATUS.in_progress },
  'mark-pending-review': {
    from: TASK_STATUS.in_progress,
    to: TASK_STATUS.pending_review,
  },
  accept: { from: TASK_STATUS.pending_review, to: TASK_STATUS.completed },
  reject: { from: TASK_STATUS.pending_review, to: TASK_STATUS.in_progress },
  archive: { from: TASK_STATUS.completed, to: TASK_STATUS.archived },
  block: { from: TASK_STATUS.in_progress, to: TASK_STATUS.blocked },
  resume: { from: TASK_STATUS.blocked, to: TASK_STATUS.in_progress },
} as const;

export type TaskTransitionAction = keyof typeof TASK_TRANSITIONS;

export const TASK_ERRORS = {
  TASK_INVALID_TRANSITION: 'TASK_INVALID_TRANSITION',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  MAIN_AGENT_NOT_IN_TEAM: 'MAIN_AGENT_NOT_IN_TEAM',
  /** start 前置校验：task_agents 至少 1 名未 removed Agent（13 篇 §4.2）。 */
  TASK_EMPTY_TEAM: 'TASK_EMPTY_TEAM',
  /** start 前置校验：多 Agent 任务 mainAgentId 未确定（13 篇 §4.2 FR-07/08）。 */
  MAIN_AGENT_NOT_SET: 'MAIN_AGENT_NOT_SET',
  /** team 调整时间窗：仅 pending/in_progress 合法（14 篇 §5.3，13 篇 §7.4）。 */
  TASK_TEAM_NOT_ALLOWED: 'TASK_TEAM_NOT_ALLOWED',
  /** add 的目标 Agent 不存在（14 篇 §5.3；code 与 chat 域 AGENT_NOT_FOUND 同值）。 */
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  /** transitionByAgent：仅主 Agent 实例可流转任务状态（MCP 工具路径，403）。 */
  TASK_STATUS_MAIN_AGENT_ONLY: 'TASK_STATUS_MAIN_AGENT_ONLY',
  /** block 置阻塞必须写明原因（400，卡点不明不许挂）。 */
  TASK_BLOCK_REASON_REQUIRED: 'TASK_BLOCK_REASON_REQUIRED',  /** transitionByAgent：accept/archive 仅人类用户可执行，Agent 调用直接拒绝（403，fail-closed）。 */
  TASK_AGENT_COMPLETION_FORBIDDEN: 'TASK_AGENT_COMPLETION_FORBIDDEN',
  /** accept/archive 用户路径完工预检未通过（409，message 枚举未完成项，force=true 可强制通过）。 */
  TASK_COMPLETION_PREFLIGHT_FAILED: 'TASK_COMPLETION_PREFLIGHT_FAILED',
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  TEAM_NOT_QUEUE_HEAD: 'TEAM_NOT_QUEUE_HEAD',
  TEAM_REQUIRED: 'TEAM_REQUIRED',
} as const;
