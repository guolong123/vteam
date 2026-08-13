/**
 * 共享前端类型：Issue 管理页契约（issue-management plan todo 4）
 * =============================================================
 * 对齐 server/src/issues/issues.service.ts toIssueDto：
 * - IssueItem：GET /issues 条目（含 task 标题/指派/创建者名，agent/user 二选一）。
 * - CreateIssuePayload / UpdateIssuePayload：POST /issues / PATCH /issues/:id 请求体
 *   （CreateIssueDto / UpdateIssueDto 前端镜像，tags 为字符串数组）。
 * - IssuesResponse：GET /issues 分页响应（对齐 models/git-repos 的 findAll 模式）。
 */

/** Issue 状态（ISSUE_STATUS：open/in_progress/resolved/closed）。 */
export type IssueStatus = "open" | "in_progress" | "resolved" | "closed";

/** GET /issues 条目（IssuesService.toIssueDto；创建者 agent/user 二选一非空）。 */
export interface IssueItem {
  id: string;
  taskId: string;
  taskTitle: string | null;
  title: string;
  description: string | null;
  status: IssueStatus;
  tags: string[];
  assigneeAgentId: string | null;
  assigneeAgentName: string | null;
  /** T5：指派到任务实例（ta_ 前缀；assigneeAgentName 为模板 agent 名，实例别名前端映射）。 */
  assigneeInstanceId: string | null;
  assigneeUserId: string | null;
  assigneeUserName: string | null;
  creatorAgentId: string | null;
  creatorAgentName: string | null;
  creatorUserId: string | null;
  creatorUserName: string | null;
  createdAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
}

/** GET /issues 分页响应（对齐 models/git-repos 的 findAll 模式）。 */
export interface IssuesResponse {
  items: IssueItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** POST /issues 请求体（CreateIssueDto；issue 仅任务绑定 taskId 必填）。 */
export interface CreateIssuePayload {
  taskId: string;
  title: string;
  description?: string;
  tags?: string[];
  /** T5：指派到任务实例（ta_ 前缀，后端 assertAssigneeInTeam 按前缀分流校验）。 */
  assigneeInstanceId?: string;
  /** 存量兼容：模板 agent 指派（新 UI 不再产生，保留给既有调用方）。 */
  assigneeAgentId?: string;
  assigneeUserId?: string;
}

/** PATCH /issues/:id 请求体（UpdateIssueDto；全 optional 部分更新，null 清除指派）。 */
export interface UpdateIssuePayload {
  title?: string;
  description?: string | null;
  tags?: string[];
  assigneeInstanceId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}

/** POST /issues/:id/transition 请求体（TransitionIssueDto；action ∈ start/resolve/close/reopen/reject）。 */
export interface TransitionIssuePayload {
  action: "start" | "resolve" | "close" | "reopen" | "reject";
}
