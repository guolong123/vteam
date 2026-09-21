/**
 * 任务详情域共享类型（任务详情页 / 团队会话页 / 抽屉复用）。
 * 对齐 server DTO：TasksService.toTaskDto / toArtifactListItem / issues.
 */
import type { RoleKey } from "@/src/theme/tokens";

/** 后端七态（TASK_STATUS，含 queued/blocked）。 */
export type TaskApiStatus =
  | "queued"
  | "pending"
  | "in_progress"
  | "blocked"
  | "pending_review"
  | "completed"
  | "archived";

/** 任务实例（T5 角色/实例分离：toTaskDto.instances 条目，main=主实例）。 */
export interface TaskInstance {
  id: string;
  agentId: string;
  alias: string | null;
  seq: number;
  name: string;
  role: string | null;
  main: boolean;
  enabled?: boolean | null;
  /** 实例覆盖模型（null=跟随模板默认；成员面板 chip 显示用）。 */
  overrideModelId?: string | null;
  /** 会话状态快照（sessions.status 真实源：running=工作中 / idle=空闲；无会话=null）。 */
  sessionStatus: string | null;
  /** 实例会话 id。 */
  sessionId: string | null;
}

export interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: TaskApiStatus;
  mainAgentId: string | null;
  mainAgentInstanceId: string | null;
  managedMode: boolean;
  /** 计划模式开关（task.planMode；true=主 Agent 先出计划，其他成员只评审）。 */
  planMode?: boolean | null;
  /**
   * 有效计划模式（服务端唯一真相：planMode OR 主 Agent 职责约定为 plan）。
   * 展示判断一律用它（缺省回退 planMode 兼容旧响应）。
   */
  effectivePlanMode?: boolean | null;
  backgroundDocs: unknown[];
  teamAgentIds: string[];
  instances: TaskInstance[];
  teamId: string | null;
  resetAfterComplete?: boolean | null;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  pendingReviewAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

/** 产出物 API 类型（对齐 ARTIFACT_TYPES：text/doc/file）。 */
export type ArtifactApiType = "text" | "doc" | "file";

/** GET /tasks/:id/artifacts 列表项（对齐 toArtifactListItem）。 */
export interface ArtifactItem {
  id: string;
  taskId: string;
  type: ArtifactApiType;
  title: string;
  currentVersion: number;
  acceptedFlag: boolean;
  authorAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  fileUrl?: string;
}

/** GET /tasks/:id/artifacts 分页响应。 */
export interface ArtifactsResponse {
  items: ArtifactItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /issues 列表项。 */
export interface TaskIssueItem {
  id: string;
  taskId: string;
  title: string;
  status: "open" | "in_progress" | "resolved" | "closed" | "rejected";
}

/** GET /issues?taskId= 分页响应。 */
export interface TaskIssuesResponse {
  items: TaskIssueItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** issue 状态排序优先级（待办在前）。 */
export const ISSUE_STATUS_ORDER: Record<TaskIssueItem["status"], number> = {
  open: 0,
  in_progress: 1,
  resolved: 2,
  closed: 3,
  rejected: 4,
};

/** issue 状态徽章主题。 */
export const ISSUE_STATUS_BADGE: Record<TaskIssueItem["status"], { label: string; color: string; bg: string; border: string }> = {
  open: { label: "待处理", color: "var(--color-neutral-600)", bg: "var(--color-neutral-50)", border: "var(--color-neutral-300)" },
  in_progress: { label: "进行中", color: "#0D9488", bg: "rgba(13,148,136,0.10)", border: "rgba(13,148,136,0.22)" },
  resolved: { label: "已解决", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  closed: { label: "已关闭", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
  rejected: { label: "已拒绝", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
};

/** 产出物类型四色：结论文本=紫 / 文档=蓝 / 文件=绿 / 计划=青。 */
export const ARTIFACT_TYPE_THEME: Record<ArtifactApiType, { color: string }> = {
  text: { color: "#7C3AED" },
  doc: { color: "#0D9488" },
  file: { color: "#059669" },
};

/** 产出物类型中文名。 */
export const ARTIFACT_TYPE_LABEL: Record<ArtifactApiType, string> = {
  text: "结论文本",
  doc: "文档",
  file: "文件",
};

/** slug 规范实现见 `@/src/lib/artifact-slug`（web 侧唯一定义）；
 *  此处纯透传重导出，供既有调用方（团队会话页深链）兼容，T11 后按需直引新路径。 */
export { docIdFor, toDocSlug } from "@/src/lib/artifact-slug";

/** 成员展示项（TeamMembersPanel agents 元素形状）。 */
export interface MemberView {
  id: string;
  instanceId?: string;
  name: string;
  role: RoleKey;
  seq?: number;
  main?: boolean;
  enabled?: boolean | null;
  overrideModelId?: string | null;
}
