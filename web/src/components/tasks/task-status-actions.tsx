"use client";

/**
 * 任务状态流转操作按钮组（OBS-010 修复）
 * =============================================
 * 看板卡片（board/page.tsx）与任务详情面板（tasks/[id]/page.tsx）共用。
 * 按五态渲染可执行操作，调用后端五态端点（tasks.controller.ts:103-154）：
 * - pending        → 开始任务（POST /tasks/:id/start）
 * - in_progress    → 提交验收（POST /tasks/:id/mark-pending-review）
 * - pending_review → 验收通过（POST /tasks/:id/accept）+ 驳回（POST /tasks/:id/reject，可带原因）
 * - completed      → 归档（POST /tasks/:id/archive）
 * - archived       → 终态，无操作
 * 全部操作 onSettled 后失效 ["tasks"] 与 ["task", id] 缓存（SSE task.status.changed
 * 亦会失效，双保险）；reject 原因弹窗复用项目 Modal 模式（absolute 相对宿主 + 遮罩 +
 * Esc 关闭，铁律 T15：无 fixed / 100vh / 100vw）。
 * data-testid 对齐既有约定：start-task-button / start-task-hint / task-submit-review /
 * task-accept / task-reject / task-archive / reject-modal / reject-reason-input /
 * reject-confirm / reject-cancel。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 后端五态（TASK_STATUS，对齐 board / tasks 页局部类型）。 */
export type TaskApiStatus =
  | "pending"
  | "in_progress"
  | "pending_review"
  | "completed"
  | "archived";

/** 可执行操作 key（对齐后端端点后缀）。 */
type TaskAction = "start" | "mark-pending-review" | "accept" | "reject" | "archive";

interface TaskStatusActionsProps {
  taskId: string;
  status: TaskApiStatus;
}

/** 各状态可执行操作组（archived 终态返回 null 不渲染）。 */
const ACTION_SETS: Record<TaskApiStatus, TaskAction[] | null> = {
  pending: ["start"],
  in_progress: ["mark-pending-review"],
  pending_review: ["accept", "reject"],
  completed: ["archive"],
  archived: null,
};

/** 操作元信息：按钮文案 / 强调色 / pending 文案。颜色对齐既有状态语义（进行中蓝/完成绿/驳回琥珀/归档灰）。 */
const ACTION_META: Record<TaskAction, { label: string; color: string; pendingLabel: string }> = {
  start: { label: "开始任务", color: "#475569", pendingLabel: "启动中…" },
  "mark-pending-review": { label: "提交验收", color: "#2563EB", pendingLabel: "提交中…" },
  accept: { label: "验收通过", color: "#059669", pendingLabel: "处理中…" },
  reject: { label: "驳回", color: "#D97706", pendingLabel: "驳回中…" },
  archive: { label: "归档", color: "#64748B", pendingLabel: "归档中…" },
};

/** 操作按钮（对齐 board 原「开始任务」按钮样式）。 */
function ActionButton({
  action,
  pending,
  disabled,
  onClick,
}: {
  action: TaskAction;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const meta = ACTION_META[action];
  return (
    <button
      type="button"
      data-testid={
        action === "start" ? "start-task-button"
        : action === "mark-pending-review" ? "task-submit-review"
        : action === "accept" ? "task-accept"
        : action === "reject" ? "task-reject"
        : "task-archive"
      }
      disabled={disabled}
      onClick={(e) => {
        // 看板卡片宿主带 onClick 跳转详情，必须阻止冒泡避免误跳
        e.stopPropagation();
        onClick();
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        padding: `${space.sm + 2}px ${space.lg}px`,
        borderRadius: radius.md,
        border: "none",
        backgroundColor: meta.color,
        color: "#FFFFFF",
        fontSize: fontSize.md,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.65 : 1,
        fontFamily: fontFamily.body,
        transition: "background-color .15s ease",
      }}
    >
      {pending ? meta.pendingLabel : meta.label}
    </button>
  );
}

/**
 * 按任务状态渲染操作按钮组 + reject 原因弹窗。
 * 内部持有 mutation（onSettled 失效任务缓存），调用方无需感知请求细节。
 */
export function TaskStatusActions({ taskId, status }: TaskStatusActionsProps) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  const actionMutation = useMutation({
    mutationFn: ({ action, rejectReason }: { action: TaskAction; rejectReason?: string }) =>
      api.post(`/tasks/${taskId}/${action}`, rejectReason ? { reason: rejectReason } : undefined),
    onError: (err) => {
      setActionError(isApiError(err) ? err.message : "操作失败，请稍后重试");
    },
    onSuccess: () => setActionError(null),
    onSettled: () => {
      // 看板（["tasks", ...]）与详情（["task", id]）缓存双失效；SSE task.status.changed 亦失效，双保险
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

  // Esc 关闭驳回弹窗（对齐 CreateProjectModal 模式）
  useEffect(() => {
    if (!rejectOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRejectOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [rejectOpen]);

  // 每次打开驳回弹窗重置原因
  useEffect(() => {
    if (rejectOpen) setReason("");
  }, [rejectOpen]);

  const actions = ACTION_SETS[status];
  if (!actions) return null;

  const pending = actionMutation.isPending;
  const showStartHint = status === "pending" && (pending || !!actionError);
  const showErrorBar = status !== "pending" && !!actionError;

  const handleAction = (action: TaskAction) => {
    setActionError(null);
    if (action === "reject") {
      setRejectOpen(true);
      return;
    }
    actionMutation.mutate({ action });
  };

  const handleRejectConfirm = () => {
    setRejectOpen(false);
    actionMutation.mutate({ action: "reject", rejectReason: reason.trim() || undefined });
  };

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: space.sm,
        width: "100%",
        ...baseFont,
      }}
    >
      {actions.map((action) => (
        <ActionButton
          key={action}
          action={action}
          pending={pending}
          disabled={pending}
          onClick={() => handleAction(action)}
        />
      ))}

      {/* 开始前检查（对齐 board 原版 hint，仅 pending 状态操作中/失败时展示） */}
      {showStartHint && (
        <div
          data-testid="start-task-hint"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            padding: `${space.sm + 2}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "#F8FAFC",
            border: "1px solid #CBD5E1",
            fontSize: fontSize.sm,
            lineHeight: 1.6,
            color: neutral[600],
          }}
        >
          <div style={{ fontWeight: 600, color: "#475569" }}>开始前检查</div>
          <div>未选择 Agent 将先弹出 Agent 选择；多 Agent 需指定主 Agent 作为任务负责人（默认产品经理）。</div>
          {actionError && (
            <div role="alert" style={{ color: "#DC2626", fontWeight: 500 }}>
              {actionError}
            </div>
          )}
        </div>
      )}

      {/* 非 start 操作失败提示 */}
      {showErrorBar && (
        <div
          data-testid="task-action-error"
          role="alert"
          style={{ fontSize: fontSize.sm, lineHeight: 1.6, color: "#DC2626", fontWeight: 500 }}
        >
          {actionError}
        </div>
      )}

      {/* 驳回原因弹窗（absolute 相对宿主，宿主需 position: relative；点击/遮罩/Esc 关闭） */}
      {rejectOpen && (
        <div
          data-testid="reject-modal"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 40,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: "8%",
          }}
        >
          <div
            aria-hidden
            onClick={(e) => {
              e.stopPropagation();
              setRejectOpen(false);
            }}
            style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleRejectConfirm();
            }}
            noValidate
            style={{
              position: "relative",
              width: 360,
              maxWidth: "calc(100% - 32px)",
              display: "flex",
              flexDirection: "column",
              gap: space.md,
              padding: `${space.xl}px`,
              borderRadius: radius.lg,
              backgroundColor: "#FFFFFF",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.lg,
              ...baseFont,
            }}
          >
            <div>
              <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>验收驳回</div>
              <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
                驳回后任务回到「进行中」，原因将写入任务事件供团队可见
              </div>
            </div>
            <textarea
              data-testid="reject-reason-input"
              value={reason}
              maxLength={512}
              rows={3}
              placeholder="填写驳回原因（可选，最多 512 字）"
              onChange={(e) => setReason(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: `${space.md}px ${space.lg}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "#FFFFFF",
                fontSize: fontSize.md,
                color: neutral[800],
                outline: "none",
                resize: "vertical",
                fontFamily: fontFamily.body,
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button
                type="button"
                data-testid="reject-cancel"
                onClick={() => setRejectOpen(false)}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "#FFFFFF",
                  color: neutral[600],
                  fontSize: fontSize.md,
                  fontWeight: 500,
                  cursor: "pointer",
                  fontFamily: fontFamily.body,
                }}
              >
                取消
              </button>
              <button
                type="submit"
                data-testid="reject-confirm"
                disabled={pending}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#D97706",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 600,
                  cursor: pending ? "default" : "pointer",
                  opacity: pending ? 0.65 : 1,
                  fontFamily: fontFamily.body,
                }}
              >
                确认驳回
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
