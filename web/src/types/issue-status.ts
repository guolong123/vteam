/**
 * Issue 状态单一来源（tech-debt-remediation Todo 14）。
 * =============================================================
 * 对齐 server `ISSUE_STATUS`（server/src/issues/issues.constants.ts:16-22）：
 * open/in_progress/resolved/closed/rejected。
 * `web/src/types/issues.ts` 透传重导出，保持既有导入路径兼容。
 */

/** Issue 状态（ISSUE_STATUS：open/in_progress/resolved/closed/rejected）。 */
export type IssueStatus = "open" | "in_progress" | "resolved" | "closed" | "rejected";
