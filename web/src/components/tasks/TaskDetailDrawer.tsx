"use client";

/**
 * TaskDetailDrawer（任务抽屉详情，Todo 2 完整数据接入）
 * =============================================
 * 看板 TaskCard 去聊天化：点击卡片打开本抽屉，不再 router.push(/tasks/:id) 聊天页。
 * 数据源：GET /tasks/:id + GET /tasks/:id/artifacts + GET /issues?taskId= +
 * GET /plans?taskId= + GET /teams/:teamId；无任何聊天组件（MessageList/输入/SSE）。
 * 铁律 T15：无 fixed / 100vh / 100vw，浮层 absolute 相对宿主 + 遮罩 + Esc 关闭。
 */
import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useAuthStore } from "@/lib/stores/authStore";
import { TaskStatusActions } from "@/src/components/tasks/task-status-actions";
import { teamsApi } from "@/src/api/teams";
import { AgentAvatar } from "@/src/components/ui";
import {
  type RoleKey,
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

type TaskApiStatus =
  | "queued"
  | "pending"
  | "in_progress"
  | "pending_review"
  | "completed"
  | "archived";

interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: TaskApiStatus;
  executionMode?: "direct" | "plan";
  mainAgentId: string | null;
  mainAgentInstanceId?: string | null;
  teamAgentIds: string[];
  teamId?: string | null;
  createdAt: string;
}

interface ArtifactItem {
  id: string;
  taskId: string;
  type: string;
  title: string;
  currentVersion: number;
  acceptedFlag: boolean;
  createdAt: string;
}

interface ArtifactsResponse {
  items: ArtifactItem[];
  total: number;
}

interface IssueItem {
  id: string;
  taskId: string;
  title: string;
  status: "open" | "in_progress" | "resolved" | "closed" | "rejected";
}

interface IssuesResponse {
  items: IssueItem[];
  total: number;
}

interface PlanWithTasks {
  id: string;
  taskId: string;
  title: string;
  summary: string | null;
  status: string;
  tasks: { id: string; seq: number; title: string; status: string }[];
}

const STATUS_LABEL: Record<TaskApiStatus, string> = {
  queued: "排队中",
  pending: "待开始",
  in_progress: "进行中",
  pending_review: "待验收",
  completed: "已完成",
  archived: "已归档",
};

const ISSUE_LABEL: Record<IssueItem["status"], string> = {
  open: "待处理",
  in_progress: "进行中",
  resolved: "已解决",
  closed: "已关闭",
  rejected: "已驳回",
};

const AGENT_ID_ROLE: Record<string, RoleKey> = {
  a_product: "product",
  a_project_manager: "project_manager",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const ROLE_KEYS: readonly RoleKey[] = ["product", "project_manager", "architect", "developer", "tester"];

function toRoles(agentIds: string[]): RoleKey[] {
  const roles: RoleKey[] = [];
  for (const id of agentIds ?? []) {
    const direct = AGENT_ID_ROLE[id];
    if (direct) {
      roles.push(direct);
      continue;
    }
    const rest = id.startsWith("a_") ? id.slice(2) : id;
    if ((ROLE_KEYS as readonly string[]).includes(rest)) {
      roles.push(rest as RoleKey);
    }
  }
  return roles;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>
      {children}
    </div>
  );
}

interface TaskDetailDrawerProps {
  taskId: string | null;
  onClose: () => void;
}

export function TaskDetailDrawer({ taskId, onClose }: TaskDetailDrawerProps) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const enabled = !!taskId && !!user?.id;

  useEffect(() => {
    if (!taskId) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [taskId, onClose]);

  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.get<TaskDetail>(`/tasks/${taskId}`),
    enabled,
    retry: false,
  });
  const artifactsQuery = useQuery({
    queryKey: ["task", taskId, "artifacts"],
    queryFn: () =>
      api.get<ArtifactsResponse>(`/tasks/${taskId}/artifacts`, { query: { pageSize: 10 } }),
    enabled,
    retry: false,
  });
  const issuesQuery = useQuery({
    queryKey: ["task-issues", taskId],
    queryFn: () =>
      api.get<IssuesResponse>("/issues", { query: { taskId: taskId!, page: 1, pageSize: 100 } }),
    enabled,
    retry: false,
  });
  const plansQuery = useQuery({
    queryKey: ["plans", taskId],
    queryFn: () => api.get<PlanWithTasks>("/plans", { query: { taskId: taskId! } }),
    enabled,
    retry: false,
  });

  const teamId = taskQuery.data?.teamId ?? null;
  const teamQuery = useQuery({
    queryKey: ["team", teamId],
    queryFn: () => teamsApi.get(teamId!),
    enabled: !!teamId && !!user?.id,
    retry: false,
  });

  useEffect(() => {
    if (taskQuery.error) console.error("[TaskDetailDrawer] GET /tasks/:id failed", { taskId, error: taskQuery.error });
  }, [taskQuery.error, taskId]);
  useEffect(() => {
    if (artifactsQuery.error) console.error("[TaskDetailDrawer] GET /tasks/:id/artifacts failed", { taskId, error: artifactsQuery.error });
  }, [artifactsQuery.error, taskId]);
  useEffect(() => {
    if (issuesQuery.error) console.error("[TaskDetailDrawer] GET /issues?taskId= failed", { taskId, error: issuesQuery.error });
  }, [issuesQuery.error, taskId]);
  useEffect(() => {
    if (plansQuery.error) console.error("[TaskDetailDrawer] GET /plans?taskId= failed", { taskId, error: plansQuery.error });
  }, [plansQuery.error, taskId]);
  useEffect(() => {
    if (teamQuery.error) console.error("[TaskDetailDrawer] GET /teams/:id failed", { taskId, teamId, error: teamQuery.error });
  }, [teamQuery.error, taskId, teamId]);

  if (!taskId) return null;

  const task = taskQuery.data;
  const artifacts = artifactsQuery.data?.items ?? [];
  const issues = [...(issuesQuery.data?.items ?? [])];
  const plan = plansQuery.data ?? null;
  const team = teamQuery.data ?? null;

  return (
    <div
      data-testid="task-detail-drawer"
      data-task-id={taskId}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", inset: 0, zIndex: 50, ...baseFont }}
    >
      <div
        aria-hidden
        data-testid="task-drawer-backdrop"
        onClick={onClose}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      <aside
        role="dialog"
        aria-label="任务详情"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 440,
          maxWidth: "calc(100% - 32px)",
          display: "flex",
          flexDirection: "column",
          gap: space.lg,
          padding: `${space.xl}px`,
          overflow: "auto",
          backgroundColor: "var(--color-surface)",
          borderLeft: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono }}>{taskId}</div>
            <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], marginTop: space.xs }}>
              {taskQuery.isPending ? "加载中…" : (task?.title ?? "任务不存在")}
            </div>
          </div>
          <button
            type="button"
            data-testid="task-drawer-close"
            onClick={onClose}
            aria-label="关闭"
            style={{
              padding: `${space.xs}px ${space.sm}px`,
              borderRadius: radius.md,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "var(--color-surface)",
              color: neutral[600],
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            ✕
          </button>
        </div>

        {taskQuery.isError ? (
          <div role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626" }}>
            {isApiError(taskQuery.error) ? taskQuery.error.message : "加载任务详情失败"}
          </div>
        ) : null}

        {task ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <span
                data-testid="status-badge"
                data-status={STATUS_LABEL[task.status]}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: `${space.xs}px ${space.sm + 2}px`,
                  borderRadius: radius.pill,
                  backgroundColor: "var(--color-neutral-50)",
                  border: "1px solid var(--color-neutral-300)",
                  color: "var(--color-neutral-600)",
                  fontSize: fontSize.sm,
                  fontWeight: 500,
                  lineHeight: 1.4,
                  whiteSpace: "nowrap",
                  ...baseFont,
                }}
              >
                {STATUS_LABEL[task.status]}
              </span>
              {task.executionMode === "plan" ? (
                <span style={{ fontSize: fontSize.xs, color: "#2563EB" }}>计划模式</span>
              ) : null}
            </div>

            {task.description ? (
              <div data-testid="task-drawer-description" style={{ fontSize: fontSize.md, color: neutral[700], lineHeight: 1.6 }}>
                {task.description}
              </div>
            ) : null}

            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>主 Agent：</span>
              <span data-testid="task-drawer-main-agent" style={{ fontSize: fontSize.sm, color: neutral[800] }}>
                {task.mainAgentId ?? "未指定"}
              </span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
              <span style={{ fontSize: fontSize.sm, color: neutral[500] }}>团队：</span>
              <span data-testid="task-drawer-team" style={{ fontSize: fontSize.sm, color: neutral[800] }}>
                {team ? team.name : (task.teamId ?? "未指派")}
              </span>
              <span style={{ display: "inline-flex" }}>
                {toRoles(task.teamAgentIds).map((role) => (
                  <span key={role} style={{ marginLeft: -6 }}>
                    <AgentAvatar role={role} size="sm" />
                  </span>
                ))}
              </span>
            </div>
            {team && team.queue.length > 0 ? (
              <div data-testid="task-drawer-queue" style={{ fontSize: fontSize.sm, color: neutral[500] }}>
                团队队列：{team.queue.length} 个等待任务{team.currentTaskId === task.id ? "（本任务为队首）" : ""}
              </div>
            ) : null}

            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              <SectionTitle>产出物（{artifactsQuery.data?.total ?? artifacts.length}）</SectionTitle>
              {artifactsQuery.isPending ? (
                <div style={{ fontSize: fontSize.sm, color: neutral[400] }}>加载中…</div>
              ) : artifacts.length === 0 ? (
                <div data-testid="task-drawer-artifacts-empty" style={{ fontSize: fontSize.sm, color: neutral[400] }}>暂无产出物</div>
              ) : (
                <ul data-testid="task-drawer-artifacts" style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: space.xs }}>
                  {artifacts.map((a) => (
                    <li key={a.id} style={{ fontSize: fontSize.sm, color: neutral[800], display: "flex", justifyContent: "space-between", gap: space.sm }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</span>
                      <span style={{ color: neutral[400], flexShrink: 0 }}>v{a.currentVersion}{a.acceptedFlag ? " · 已验收" : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              <SectionTitle>Issue（{issuesQuery.data?.total ?? issues.length}）</SectionTitle>
              {issuesQuery.isPending ? (
                <div style={{ fontSize: fontSize.sm, color: neutral[400] }}>加载中…</div>
              ) : issues.length === 0 ? (
                <div data-testid="task-drawer-issues-empty" style={{ fontSize: fontSize.sm, color: neutral[400] }}>暂无 Issue</div>
              ) : (
                <ul data-testid="task-drawer-issues" style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: space.xs }}>
                  {issues.slice(0, 10).map((i) => (
                    <li key={i.id} style={{ fontSize: fontSize.sm, color: neutral[800], display: "flex", justifyContent: "space-between", gap: space.sm }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</span>
                      <span style={{ color: neutral[400], flexShrink: 0 }}>{ISSUE_LABEL[i.status]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
              <SectionTitle>执行计划</SectionTitle>
              {plansQuery.isPending ? (
                <div style={{ fontSize: fontSize.sm, color: neutral[400] }}>加载中…</div>
              ) : !plan ? (
                <div data-testid="task-drawer-plan-empty" style={{ fontSize: fontSize.sm, color: neutral[400] }}>暂无执行计划</div>
              ) : (
                <div data-testid="task-drawer-plan" style={{ fontSize: fontSize.sm, color: neutral[800] }}>
                  <div style={{ fontWeight: 600 }}>{plan.title}</div>
                  <div style={{ color: neutral[500], marginTop: space.xs }}>
                    状态：{plan.status} · 子任务 {plan.tasks.length} 项
                  </div>
                </div>
              )}
            </div>

            <TaskStatusActions taskId={task.id} status={task.status} />

            {task.teamId ? (
              <button
                type="button"
                data-testid="enter-team-session-drawer"
                data-team-id={task.teamId}
                onClick={() => router.push(`/teams/${task.teamId}/session`)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: space.xs,
                  width: "100%",
                  padding: `${space.sm}px ${space.md}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#2563EB",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                进入团队会话 →
              </button>
            ) : (
              <div style={{ fontSize: fontSize.sm, color: neutral[400] }}>该任务尚未指派团队</div>
            )}
          </>
        ) : null}
      </aside>
    </div>
  );
}
