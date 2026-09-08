"use client";
import { useState } from "react";
import { isApiError } from "@/lib/errors";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
} from "@/src/theme/tokens";
import {
  PLAN_STATUS_THEME,
  PLAN_TASK_STATUS_LABEL,
  type PlanWithTasks,
} from "@/src/components/tasks/task-detail-types";

/* ================================ 执行计划区块（plan-section） ================================ */
export function PlanSection({
  plan,
  loading,
  error,
  onReview,
  reviewPending,
  taskExecutionMode,
}: {
  plan: PlanWithTasks | null;
  loading: boolean;
  error: unknown;
  onReview: (planId: string) => void;
  reviewPending: boolean;
  taskExecutionMode: string;
}) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  if (loading) {
    return (
      <div style={{ padding: `${space.sm + 2}px ${space.md}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, color: neutral[400], fontSize: fontSize.sm }}>
        加载中…
      </div>
    );
  }

  if (error) {
    const is404 = isApiError(error) && error.status === 404;
    if (is404) {
      return (
        <div data-testid="plan-section" style={{ padding: `${space.sm + 2}px ${space.md}px`, borderRadius: radius.md, backgroundColor: neutral[50], border: `1px solid ${neutral[200]}`, color: neutral[400], fontSize: fontSize.sm, lineHeight: 1.5 }}>
          暂无执行计划
          {taskExecutionMode === "plan" && (
            <span style={{ display: "block", marginTop: space.xs, color: neutral[500] }}>请先提交执行计划</span>
          )}
        </div>
      );
    }
    return (
      <div role="alert" style={{ padding: `${space.sm + 2}px ${space.md}px`, borderRadius: radius.md, backgroundColor: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.22)", color: "#DC2626", fontSize: fontSize.sm }}>
        加载计划失败：{isApiError(error) ? error.message : "未知错误"}
      </div>
    );
  }

  if (!plan) return null;

  const statusTheme = PLAN_STATUS_THEME[plan.status] ?? PLAN_STATUS_THEME.reviewing;
  const isReviewing = plan.status === "reviewing";

  return (
    <div data-testid="plan-section" style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
        <span style={{ fontSize: fontSize.sm, fontWeight: 600, color: neutral[600] }}>执行计划</span>
        <span
          style={{
            display: "inline-flex", alignItems: "center", gap: space.xs,
            padding: `${space.xs - 1}px ${space.sm + 1}px`,
            borderRadius: radius.pill, backgroundColor: statusTheme.bg,
            border: `1px solid ${statusTheme.border}`, color: statusTheme.color,
            fontSize: fontSize.xs, fontWeight: 500, lineHeight: 1.4, whiteSpace: "nowrap",
          }}
        >
          <span aria-hidden style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: statusTheme.color, flexShrink: 0 }} />
          {statusTheme.label}
        </span>
      </div>

      {plan.summary && (
        <div style={{ fontSize: fontSize.sm, color: neutral[600], lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {plan.summary}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
        {plan.tasks.map((pt) => {
          const expanded = expandedTaskId === pt.id;
          const taskStatusLabel = PLAN_TASK_STATUS_LABEL[pt.status] ?? pt.status;
          return (
            <div
              key={pt.id}
              data-testid="plan-task-item"
              style={{
                borderRadius: radius.md, backgroundColor: neutral[50],
                border: `1px solid ${neutral[200]}`, overflow: "hidden",
              }}
            >
              <button
                type="button"
                data-testid="plan-task-toggle"
                aria-expanded={expanded}
                onClick={() => setExpandedTaskId(expanded ? null : pt.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: space.sm,
                  padding: `${space.sm}px ${space.md}px`,
                  cursor: "pointer",
                  transition: "background-color .15s ease",
                  background: "transparent",
                  border: "none",
                  textAlign: "left",
                  width: "100%",
                  fontFamily: fontFamily.body,
                  fontSize: fontSize.md,
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--color-surface)"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent"; }}
              >
                <span style={{ fontSize: fontSize.xs, color: neutral[400], fontWeight: 600, flexShrink: 0 }}>
                  #{pt.seq}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: fontSize.md, color: neutral[800], fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pt.title}
                </span>
                {pt.assigneeAlias ? (
                  <span style={{ fontSize: fontSize.xs, color: "#0D9488", backgroundColor: "#EFF6FF", border: `1px solid #BFDBFE`, borderRadius: radius.pill, padding: "1px 6px", flexShrink: 0 }}>
                    {pt.assigneeAlias}
                  </span>
                ) : (
                  <span style={{ fontSize: 10, color: "#D97706", flexShrink: 0 }}>未指派</span>
                )}
                <span style={{ fontSize: fontSize.xs, color: neutral[400], flexShrink: 0 }}>
                  {taskStatusLabel}
                </span>
                <span style={{ color: neutral[400], fontSize: fontSize.sm, transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s ease" }} aria-hidden>
                  ›
                </span>
              </button>
              {expanded && pt.content != null ? (
                <div style={{ padding: `${space.sm}px ${space.md}px`, borderTop: `1px solid ${neutral[200]}`, fontSize: fontSize.sm, color: neutral[600], lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {typeof pt.content === "string" ? pt.content : JSON.stringify(pt.content, null, 2)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {isReviewing && !reviewPending && (
        <button
          type="button"
          data-testid="plan-review-entry"
          onClick={() => onReview(plan.id)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: space.xs,
            padding: `${space.sm - 1}px ${space.md}px`,
            borderRadius: radius.md, border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)", color: neutral[600],
            fontSize: fontSize.sm, fontWeight: 500, cursor: "pointer",
            fontFamily: fontFamily.body,
          }}
        >
          评审计划
        </button>
      )}
    </div>
  );
}

