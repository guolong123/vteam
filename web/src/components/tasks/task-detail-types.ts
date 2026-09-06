/**
 * 任务详情域共享类型（任务详情页 / 团队会话页 / 抽屉复用）。
 * 对齐 server DTO：TasksService.toTaskDto / toArtifactListItem / issues / plans.
 */
import type { RoleKey } from "@/src/theme/tokens";

/** 后端六态（TASK_STATUS，含 queued）。 */
export type TaskApiStatus =
  | "queued"
  | "pending"
  | "in_progress"
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
  projectId: string;
  title: string;
  description: string | null;
  priority: string;
  status: TaskApiStatus;
  mainAgentId: string | null;
  mainAgentInstanceId: string | null;
  managedMode: boolean;
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
  executionMode: "direct" | "plan";
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

/** 计划子任务条目（GET /plans?taskId= → tasks[]）。 */
export interface PlanTaskItem {
  id: string;
  seq: number;
  title: string;
  content: unknown;
  assigneeInstanceId: string | null;
  assigneeAlias: string | null;
  assigneeName: string | null;
  status: string;
}

/** 计划头 + 子任务清单（GET /plans?taskId= 响应）。 */
export interface PlanWithTasks {
  id: string;
  taskId: string;
  title: string;
  summary: string | null;
  scopeIn: string | null;
  scopeOut: string | null;
  status: string;
  createdBy: string;
  reviewerInstanceId: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: PlanTaskItem[];
}

/** 计划状态 → 视觉主题（徽章色）。 */
export const PLAN_STATUS_THEME: Record<string, { label: string; color: string; bg: string; border: string }> = {
  reviewing: { label: "待评审", color: "#D97706", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.28)" },
  approved: { label: "已通过", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  rejected: { label: "已驳回", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
  executing: { label: "执行中", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  completed: { label: "已完成", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
};

/** 计划子任务状态 → 中文标签。 */
export const PLAN_TASK_STATUS_LABEL: Record<string, string> = {
  pending: "待开始",
  in_progress: "进行中",
  done: "已完成",
  blocked: "已阻塞",
  skipped: "已跳过",
};

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
  in_progress: { label: "进行中", color: "#2563EB", bg: "rgba(37,99,235,0.10)", border: "rgba(37,99,235,0.22)" },
  resolved: { label: "已解决", color: "#059669", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.28)" },
  closed: { label: "已关闭", color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
  rejected: { label: "已拒绝", color: "#DC2626", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
};

/** 产出物类型三色：结论文本=紫 / 文档=蓝 / 文件=绿。 */
export const ARTIFACT_TYPE_THEME: Record<ArtifactApiType, { color: string }> = {
  text: { color: "#7C3AED" },
  doc: { color: "#2563EB" },
  file: { color: "#059669" },
};

/** 产出物类型中文名。 */
export const ARTIFACT_TYPE_LABEL: Record<ArtifactApiType, string> = {
  text: "结论文本",
  doc: "文档",
  file: "文件",
};

/** 标题 → ASCII slug（对齐 server DocsMirrorService.toSlug）。 */
export function toDocSlug(title: string): string {
  return (
    String(title ?? "doc")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  );
}

/** 产出物 → 文档站 doc id（对齐 server DocsMirrorService.docIdFor + buildRegistry 去重）：
 *  base = ASCII slug；纯中文/空 → 'doc' 追加 artifact id 前 8 位；
 *  同名多文档按 artifact id 序，已占用 → 追加 -<artId前8位>。 */
export function docIdFor(title: string, artifactId: string, all?: { id: string; title: string }[]): string {
  const toBase = (t: string, id: string): string => {
    const slug = toDocSlug(t);
    if (slug !== "doc") return slug;
    const suffix = String(id).replace(/[^a-z0-9]/gi, "").slice(-8);
    return suffix ? `doc-${suffix}` : "doc";
  };
  const base = toBase(title, artifactId);
  if (!all || all.length <= 1) return base;
  const seen = new Set<string>();
  const ordered = [...all].sort((a, b) => a.id.localeCompare(b.id));
  for (const a of ordered) {
    const b = toBase(a.title, a.id);
    if (a.id === artifactId) {
      if (!seen.has(b)) return b;
      const suffix = String(artifactId).replace(/[^a-z0-9]/gi, "").slice(-8);
      let cand = suffix ? `${b}-${suffix}` : b;
      let cnt = 1;
      while (seen.has(cand)) {
        cnt += 1;
        cand = `${b}-${suffix}-${cnt}`;
      }
      return cand;
    }
    seen.add(b);
  }
  return base;
}

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
