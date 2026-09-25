/**
 * 任务状态单一来源（tech-debt-remediation Todo 14）。
 * =============================================================
 * `TaskApiStatus` 七态联合此前在 web 侧有五处重复声明（task-detail-types /
 * task-status-actions / TaskDetailDrawer / board 页 / 团队任务页），此处为唯一定义，
 * 其余位置均为导入或透传重导出。
 * 对齐 server `TASK_STATUS`（server/src/common/constants/task.constants.ts:9-17）：
 * queued/pending/in_progress/blocked/pending_review/completed/archived。
 */

/** 后端七态（TASK_STATUS，含 queued/blocked）。 */
export type TaskApiStatus =
  | "queued"
  | "pending"
  | "in_progress"
  | "blocked"
  | "pending_review"
  | "completed"
  | "archived";

/** API 状态 → 中文标签（此前三处重复定义文案逐字一致，此处唯一定义，渲染文案不变）。 */
export const STATUS_LABEL: Record<TaskApiStatus, string> = {
  queued: "排队中",
  pending: "待开始",
  in_progress: "进行中",
  blocked: "阻塞中",
  pending_review: "待验收",
  completed: "已完成",
  archived: "已归档",
};

/** 可执行操作 key（对齐后端端点后缀）。 */
export type TaskAction =
  | "start"
  | "mark-pending-review"
  | "accept"
  | "reject"
  | "archive"
  | "block"
  | "resume";

/**
 * 各状态可执行操作组（archived 终态返回 null 不渲染）。
 *
 * 已知 web/server 差异（刻意保留，勿在此“对齐修复”）：
 * web 此表为“状态 → 可执行操作”视图，含 `queued: null` 与 `archived: null` 显式条目
 * （排队中/已归档在看板与抽屉不渲染任何流转按钮）；
 * 而 server `TASK_TRANSITIONS` 为“动作 → { from, to }”迁移表，
 * 只收录五个可迁移动作（start/mark-pending-review/accept/reject/archive/block/resume），
 * 没有 `queued`/`archived` 状态条目。两表为平行手写，本次只做搬移，语义逐字保留。
 */
export const ACTION_SETS: Record<TaskApiStatus, TaskAction[] | null> = {
  queued: null,
  pending: ["start"],
  in_progress: ["mark-pending-review", "block"],
  blocked: ["resume"],
  pending_review: ["accept", "reject"],
  completed: ["archive"],
  archived: null,
};
