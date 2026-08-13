/**
 * Issue 域常量（issue-management plan todo 2）。
 *
 * 状态机 open/in_progress/resolved/closed（四态，无跳态），迁移表驱动判定：
 * - start：open → in_progress（开始处理）
 * - resolve：in_progress → resolved（处理完成）
 * - close：resolved → closed（验收关闭）
 * - reopen：closed → open（关闭后重开）
 * - reject：in_progress → open（处理被驳回，唯一「后退」动作）
 * 非法迁移 409 `ISSUE_INVALID_TRANSITION`，已处目标态幂等返回 200。
 */

export const ISSUE_STATUS = {
  open: 'open',
  in_progress: 'in_progress',
  resolved: 'resolved',
  closed: 'closed',
} as const;

export type IssueStatus = (typeof ISSUE_STATUS)[keyof typeof ISSUE_STATUS];

/** 合法迁移表（仿 task.constants TASK_TRANSITIONS：动作 → { from, to }）。 */
export const ISSUE_TRANSITIONS = {
  start: { from: ISSUE_STATUS.open, to: ISSUE_STATUS.in_progress },
  resolve: { from: ISSUE_STATUS.in_progress, to: ISSUE_STATUS.resolved },
  close: { from: ISSUE_STATUS.resolved, to: ISSUE_STATUS.closed },
  reopen: { from: ISSUE_STATUS.closed, to: ISSUE_STATUS.open },
  reject: { from: ISSUE_STATUS.in_progress, to: ISSUE_STATUS.open },
} as const;

export type IssueTransitionAction = keyof typeof ISSUE_TRANSITIONS;

export const ISSUE_ERRORS = {
  /** issue 不存在或已软删（GET/PATCH/transition/DELETE :id 路径）。 */
  ISSUE_NOT_FOUND: 'ISSUE_NOT_FOUND',
  /** 状态流转不合法（from 不匹配当前 status，409）。 */
  ISSUE_INVALID_TRANSITION: 'ISSUE_INVALID_TRANSITION',
  /** 绑定的任务不存在（404，任务路由反查失败）。 */
  ISSUE_TASK_NOT_FOUND: 'ISSUE_TASK_NOT_FOUND',
  /** 指派 Agent 不在任务团队（task_agents 无记录或已 removed，400）。 */
  ASSIGNEE_NOT_IN_TEAM: 'ASSIGNEE_NOT_IN_TEAM',
  /** 任务已归档，不可创建 issue（409，仅 create/createByAgent）。 */
  ISSUE_TASK_ARCHIVED: 'ISSUE_TASK_ARCHIVED',
  /** MCP 创建路径缺少 creatorAgentId（400，Metis B1 双创建者互斥）。 */
  ISSUE_CREATOR_REQUIRED: 'ISSUE_CREATOR_REQUIRED',
} as const;
