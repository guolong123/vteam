"use client";

/**
 * 团队任务列表页（历史任务）
 * =============================================
 * 展示团队全部历史任务列表，含状态/优先级/模式/Agent/产出物/Issue。
 * 任务卡片可点击进入团队会话，或跳转文档站。
 */
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { useSSE } from "@/hooks/use-sse";
import { AgentAvatar, StatusBadge } from "@/src/components/ui";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";
import type { CSSProperties } from "react";

type TaskApiStatus = "queued" | "pending" | "in_progress" | "pending_review" | "completed" | "archived";

interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: TaskApiStatus;
  executionMode: "direct" | "plan";
  teamAgentIds: string[];
  createdAt: string;
  completedAt: string | null;
}

interface TasksResponse {
  items: TaskItem[];
  total: number;
  page: number;
  pageSize: number;
}

interface CountResponse {
  total: number;
}

const STATUS_BADGE_KEY: Partial<Record<TaskApiStatus, "进行中" | "待验收" | "已完成" | "已归档">> = {
  in_progress: "进行中",
  pending_review: "待验收",
  completed: "已完成",
  archived: "已归档",
};

const STATUS_LABEL: Record<TaskApiStatus, string> = {
  queued: "排队中",
  pending: "待开始",
  in_progress: "进行中",
  pending_review: "待验收",
  completed: "已完成",
  archived: "已归档",
};

const PRIORITY_LABEL: Record<string, { label: string; color: string }> = {
  high: { label: "高", color: "#DC2626" },
  medium: { label: "中", color: "#D97706" },
  low: { label: "低", color: "var(--color-neutral-500)" },
};

const AGENT_ID_ROLE: Record<string, "product" | "project_manager" | "architect" | "developer" | "tester"> = {
  a_product: "product",
  a_project_manager: "project_manager",
  a_architect: "architect",
  a_developer: "developer",
  a_tester: "tester",
};

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function TaskStatusBadge({ status }: { status: TaskApiStatus }) {
  const key = STATUS_BADGE_KEY[status];
  if (key) return <StatusBadge status={key} />;
  const label = STATUS_LABEL[status];
  const isQueued = status === "queued";
  return (
    <span
      data-testid="status-badge"
      data-status={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 8px",
        borderRadius: 999,
        backgroundColor: isQueued ? "rgba(245,158,11,0.10)" : "var(--color-neutral-50)",
        border: `1px solid ${isQueued ? "rgba(245,158,11,0.22)" : "var(--color-neutral-300)"}`,
        color: isQueued ? "#D97706" : "var(--color-neutral-600)",
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: isQueued ? "#D97706" : "var(--color-neutral-500)", flexShrink: 0 }} />
      {label}
    </span>
  );
}

function TaskListCount({ taskId }: { taskId: string }) {
  const { data: artifacts } = useQuery({
    queryKey: ["task", taskId, "artifact-count"],
    queryFn: () => api.get<CountResponse>(`/tasks/${taskId}/artifacts`, { query: { page: 1, pageSize: 1 } }),
    retry: false,
  });
  const { data: issues } = useQuery({
    queryKey: ["task", taskId, "issue-count"],
    queryFn: () => api.get<CountResponse>("/issues", { query: { taskId: taskId!, page: 1, pageSize: 1 } }),
    retry: false,
  });
  const artCount = artifacts?.total ?? 0;
  const issueCount = issues?.total ?? 0;
  if (artCount === 0 && issueCount === 0) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: space.sm, fontSize: fontSize.xs, color: neutral[500] }}>
      {artCount > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
          <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>▤</span>
          {artCount} 产出
        </span>
      )}
      {issueCount > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "2px", color: "#D97706" }}>
          <span aria-hidden style={{ fontSize: fontSize.sm, lineHeight: 1 }}>☰</span>
          {issueCount} 待办
        </span>
      )}
    </span>
  );
}

export default function TeamTasksPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const teamId = params.id;

  useSSE({
    scope: "global",
    onEvent: (ev) => {
      if (ev.type === "task.status.changed") {
        queryClient.invalidateQueries({ queryKey: ["team-tasks", teamId] });
      }
    },
  });

  const { data, isPending, isError, error } = useQuery({
    queryKey: ["team-tasks", teamId],
    queryFn: () =>
      api.get<TasksResponse>("/tasks", {
        query: { teamId: teamId!, page: 1, pageSize: 100 },
      }),
    enabled: !!teamId,
  });

  const items = data?.items ?? [];
  const running = items.filter((t) => t.status === "in_progress" || t.status === "queued");
  const done = items.filter((t) => t.status === "completed" || t.status === "archived");

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", ...baseFont }}>
      <div style={{ marginBottom: space.xl }}>
        <div style={{ fontSize: fontSize.xxl, fontWeight: 700, color: neutral[900], fontFamily: fontFamily.display }}>
          历史任务
        </div>
        <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
          {items.length} 个任务 · {running.length} 进行中 / {done.length} 已完成
        </div>
      </div>

      {isPending ? (
        <div style={{ fontSize: fontSize.md, color: neutral[400], padding: `${space.xl}px 0` }}>加载中…</div>
      ) : isError ? (
        <div style={{ fontSize: fontSize.md, color: "#DC2626", padding: `${space.xl}px 0` }}>
          {isApiError(error) ? error.message : "加载失败"}
        </div>
      ) : items.length === 0 ? (
        <div
          style={{
            padding: `${space.xl}px`,
            border: `1px dashed ${neutral[200]}`,
            borderRadius: radius.md,
            textAlign: "center",
            color: neutral[500],
          }}
        >
          还没有任务
          <button
            type="button"
            onClick={() => router.push(`/tasks/new?teamId=${teamId}`)}
            style={{
              display: "block",
              margin: `${space.md}px auto 0`,
              padding: `${space.sm}px ${space.lg}px`,
              borderRadius: radius.md,
              border: "none",
              backgroundColor: "#0D9488",
              color: "#FFF",
              fontSize: fontSize.sm,
              cursor: "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            创建任务
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          {items.map((task) => {
            const prio = PRIORITY_LABEL[task.priority];
            return (
              <div
                key={task.id}
                data-testid="task-list-item"
                data-task-id={task.id}
                style={{
                  padding: `${space.lg}px`,
                  borderRadius: radius.lg,
                  backgroundColor: "var(--color-surface)",
                  border: `1px solid ${neutral[200]}`,
                  boxShadow: shadow.sm,
                  display: "flex",
                  flexDirection: "column",
                  gap: space.sm,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.md }}>
                  <div
                    style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
                    onClick={() => router.push(`/teams/${teamId}/session?task=${task.id}`)}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                      <div style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900] }}>
                        {task.title}
                      </div>
                      {task.executionMode === "plan" && (
                        <span
                          data-testid="plan-badge"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: space.xs,
                            padding: `${space.xs - 1}px ${space.sm}px`,
                            borderRadius: radius.pill,
                            backgroundColor: "rgba(13,148,136,0.10)",
                            border: "1px solid rgba(13,148,136,0.22)",
                            color: "#0D9488",
                            fontSize: fontSize.xs,
                            fontWeight: 500,
                            lineHeight: 1.4,
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: "#0D9488", flexShrink: 0 }} />
                          计划
                        </span>
                      )}
                    </div>
                    {task.description && (
                      <div
                        style={{
                          fontSize: fontSize.sm,
                          color: neutral[400],
                          marginTop: space.xs,
                          lineHeight: 1.6,
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {task.description}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: space.xs, flexShrink: 0 }}>
                    <TaskStatusBadge status={task.status} />
                    <span style={{ fontSize: fontSize.xs, color: neutral[400], fontFamily: fontFamily.mono }}>
                      {task.id.slice(0, 8)}…
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingTop: space.sm,
                    borderTop: `1px solid ${neutral[100]}`,
                    flexWrap: "wrap",
                    gap: space.sm,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                    <div data-testid="task-members" style={{ display: "flex", alignItems: "center" }}>
                      {(task.teamAgentIds ?? []).slice(0, 5).map((id: string, idx: number) => {
                        const role = AGENT_ID_ROLE[id] ?? "developer";
                        return (
                          <span key={id} style={{ marginLeft: idx === 0 ? 0 : -6 }}>
                            <AgentAvatar role={role} size="sm" />
                          </span>
                        );
                      })}
                    </div>
                    {prio && (
                      <span
                        data-testid="priority-badge"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "2px",
                          padding: `${space.xs - 1}px ${space.sm}px`,
                          borderRadius: radius.pill,
                          backgroundColor: "var(--color-neutral-50)",
                          border: `1px solid ${neutral[200]}`,
                          color: prio.color,
                          fontSize: fontSize.xs,
                          fontWeight: 600,
                        }}
                      >
                        {prio.label}优先级
                      </span>
                    )}
                    <TaskListCount taskId={task.id} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: space.md, marginLeft: "auto" }}>
                    <span style={{ fontSize: fontSize.xs, color: neutral[400] }}>
                      {task.completedAt ? `完成于 ${formatDate(task.completedAt)}` : `创建于 ${formatDate(task.createdAt)}`}
                    </span>
                    <button
                      type="button"
                      data-testid="task-list-docs"
                      onClick={() => router.push(`/docs/${task.id}`)}
                      style={{
                        fontSize: fontSize.xs,
                        color: "#0D9488",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        fontWeight: 500,
                        fontFamily: fontFamily.body,
                      }}
                    >
                      文档站 ›
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
