"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 任务状态流转操作按钮组（OBS-010 修复）
 * =============================================
 * 看板卡片（board/page.tsx）与团队会话右侧任务面板共用。
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
 * reject-confirm / reject-cancel / force-confirm-modal / force-blockers /
 * force-confirm / force-cancel。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { teamsApi } from "@/src/api/teams";
import { neutral, space, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** 后端七态与流转表唯一定义见 `@/src/types/task-status`；此处重导出类型供既有调用方兼容。 */
export type { TaskApiStatus, TaskAction } from "@/src/types/task-status";
import { ACTION_SETS } from "@/src/types/task-status";
import type { TaskAction, TaskApiStatus } from "@/src/types/task-status";

interface TaskStatusActionsProps {
  taskId: string;
  status: TaskApiStatus;
  /**
   * `column`（默认）竖向堆叠：看板卡片/详情抽屉依赖此形态，不可改默认值；
   * `row` 等宽并排一行：会话页状态卡使用，仅操作数 ≥2 时生效。
   */
  layout?: "column" | "row";
}

/** 各状态可执行操作组（唯一定义见 `@/src/types/task-status`，此处直接引用导入的 `ACTION_SETS`）。 */

/** 操作元信息：按钮文案 / 强调色 / pending 文案。颜色对齐既有状态语义（进行中蓝/完成绿/驳回琥珀/归档灰）。中性色用固定深灰（neutral token 在暗色下翻转会变浅，白字压不住）。 */
const ACTION_META: Record<TaskAction, { label: string; color: string; pendingLabel: string }> = {
  start: { label: "开始任务", color: "#475569", pendingLabel: "启动中…" },
  "mark-pending-review": { label: "提交验收", color: "#0D9488", pendingLabel: "提交中…" },
  accept: { label: "验收通过", color: "#059669", pendingLabel: "处理中…" },
  reject: { label: "驳回", color: "#D97706", pendingLabel: "驳回中…" },
  archive: { label: "归档", color: "#64748B", pendingLabel: "归档中…" },
  block: { label: "置阻塞", color: "#B91C1C", pendingLabel: "置阻塞中…" },
  resume: { label: "恢复执行", color: "#0D9488", pendingLabel: "恢复中…" },
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
        : action === "block" ? "task-block"
        : action === "resume" ? "task-resume"
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
export function TaskStatusActions({ taskId, status, layout = "column" }: TaskStatusActionsProps) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [forceTarget, setForceTarget] = useState<TaskAction | null>(null);

  const actionMutation = useMutation({
    mutationFn: ({
      action,
      rejectReason,
      force,
    }: {
      action: TaskAction;
      rejectReason?: string;
      force?: boolean;
    }) =>
      api.post(
        `/tasks/${taskId}/${action}`,
        force ? { force: true } : rejectReason ? { reason: rejectReason } : undefined,
      ),
    onError: (err, vars) => {
      setActionError(isApiError(err) ? err.message : "操作失败，请稍后重试");
      if (
        isApiError(err) &&
        err.code === "TASK_COMPLETION_PREFLIGHT_FAILED" &&
        (vars.action === "accept" || vars.action === "archive")
      ) {
        setForceTarget(vars.action);
      } else {
        setForceTarget(null);
      }
    },
    onSuccess: () => {
      setActionError(null);
      setForceTarget(null);
    },
    onSettled: () => {
      // 看板（["tasks", ...]）与详情（["task", id]）缓存双失效；SSE task.status.changed 亦失效，双保险
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

  // Esc 关闭驳回/阻塞弹窗 / 强制确认弹窗（对齐 CreateProjectModal 模式）
  useEffect(() => {
    if (!rejectOpen && !blockOpen && !forceTarget) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRejectOpen(false);
        setBlockOpen(false);
        setForceTarget(null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [rejectOpen, blockOpen, forceTarget]);

  // 每次打开驳回/阻塞弹窗重置原因
  useEffect(() => {
    if (rejectOpen || blockOpen) setReason("");
  }, [rejectOpen, blockOpen]);

  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.get<any>(`/tasks/${taskId}`),
    enabled: status === "pending",
    retry: false,
  });
  const taskDetail: any = taskQuery.data;
  const teamSize: number = Array.isArray(taskDetail?.instances)
    ? taskDetail.instances.length
    : 0;
  // 主 Agent 判定唯一依据 instances[].main（服务端按 team.mainAgentMemberId 算）。
  const hasMainAgent: boolean = Array.isArray(taskDetail?.instances)
    ? taskDetail.instances.some((i: { main?: boolean }) => i.main === true)
    : false;

  // 排队等待 mutation 必须位于 early return 之前（hooks 顺序规则）；teamId 取自任务详情查询
  const teamId: string | null = taskDetail?.teamId ?? null;
  const enqueueMutation = useMutation({
    mutationFn: () => teamsApi.enqueue(teamId!, taskId),
    onError: (err) => {
      setActionError(isApiError(err) ? err.message : "排队失败，请稍后重试");
    },
    onSuccess: () => setActionError(null),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      if (teamId) queryClient.invalidateQueries({ queryKey: ["team", teamId] });
    },
  });

  const actions = ACTION_SETS[status];
  if (!actions) return null;

  const pending = actionMutation.isPending;
  // 排队等待：pending 孤儿重入队（有团队才展示，无团队的任务先去详情指派）
  const showStartHint = status === "pending" && (pending || !!actionError);
  const showErrorBar = status !== "pending" && !!actionError;
  const errText: string = actionError ?? "";
  const isEmptyTeamErr = /TASK_EMPTY_TEAM|团队为空/.test(errText);
  const isMainAgentErr = /MAIN_AGENT_NOT_SET|主 Agent/.test(errText) && !/额度|plan/.test(errText);

  const handleAction = (action: TaskAction) => {
    setActionError(null);
    setForceTarget(null);
    if (action === "reject") {
      setRejectOpen(true);
      return;
    }
    if (action === "block") {
      setBlockOpen(true);
      return;
    }
    actionMutation.mutate({ action });
  };

  const handleRejectConfirm = () => {
    setRejectOpen(false);
    actionMutation.mutate({ action: "reject", rejectReason: reason.trim() || undefined });
  };

  const handleBlockConfirm = () => {
    if (!reason.trim()) return;
    setBlockOpen(false);
    actionMutation.mutate({ action: "block", rejectReason: reason.trim() });
  };

  const handleForceConfirm = () => {
    if (!forceTarget) return;
    setForceTarget(null);
    actionMutation.mutate({ action: forceTarget, force: true });
  };

  /** 主操作按钮节点（row 布局下会被包进等宽网格；column 布局下直接作为竖排子节点）。 */
  const actionButtons = actions.map((action) => (
    <ActionButton
      key={action}
      action={action}
      pending={pending}
      disabled={pending}
      onClick={() => handleAction(action)}
    />
  ));
  /** row 布局且操作数 ≥2 才分列；单操作整行（否则会出现半宽孤按钮）。 */
  const useRowGrid = layout === "row" && actions.length > 1;

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
      {useRowGrid ? (
        <div
          data-testid="task-status-actions-row"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${actions.length}, 1fr)`,
            gap: space.sm,
          }}
        >
          {actionButtons}
        </div>
      ) : (
        actionButtons
      )}
      {status === "pending" && teamId && (
        <button
          type="button"
          data-testid="enqueue-task-button"
          disabled={pending || enqueueMutation.isPending}
          onClick={(e) => {
            e.stopPropagation();
            setActionError(null);
            enqueueMutation.mutate();
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: space.xs,
            padding: `${space.sm + 2}px ${space.lg}px`,
            borderRadius: radius.md,
            border: `1px solid ${neutral[200]}`,
            backgroundColor: "var(--color-surface)",
            color: "#D97706",
            fontSize: fontSize.md,
            fontWeight: 600,
            cursor: pending || enqueueMutation.isPending ? "default" : "pointer",
            opacity: pending || enqueueMutation.isPending ? 0.65 : 1,
            fontFamily: fontFamily.body,
            transition: "background-color .15s ease",
            width: "100%",
          }}
        >
          {enqueueMutation.isPending ? "排队中…" : "排队等待"}
        </button>
      )}

      {showStartHint && (
        <div
          data-testid="start-task-hint"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.xs,
            padding: `${space.sm + 2}px ${space.md}px`,
            borderRadius: radius.md,
            backgroundColor: "var(--color-neutral-50)",
            border: "1px solid var(--color-neutral-300)",
            fontSize: fontSize.sm,
            lineHeight: 1.6,
            color: neutral[600],
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--color-neutral-600)" }}>开始前检查</div>
          {(() => {
            const teamOk = teamSize > 0;
            const mainOk = teamSize <= 1 ? hasMainAgent || teamSize === 0 : hasMainAgent;
            const teamColor = isEmptyTeamErr ? "#DC2626" : teamOk ? "#059669" : neutral[600];
            const mainColor = isMainAgentErr ? "#DC2626" : mainOk ? "#059669" : neutral[600];
            const teamIcon = teamOk ? "✓" : "✗";
            const mainIcon = mainOk ? "✓" : "✗";
            return (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: space.xs, color: teamColor }}>
                  <span style={{ fontWeight: 700 }}>{teamIcon}</span>
                  <span>{teamOk ? `已选择 ${teamSize} 个 Agent` : "未选择 Agent — 点击开始将先弹出 Agent 选择"}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: space.xs, color: mainColor }}>
                  <span style={{ fontWeight: 700 }}>{mainIcon}</span>
                  <span>{mainOk ? "已指定主 Agent（任务负责人）" : "多 Agent 需指定主 Agent 作为任务负责人（默认产品经理）"}</span>
                </div>
              </>
            );
          })()}
          {actionError && (
            <div role="alert" style={{ color: "#DC2626", fontWeight: 500, borderTop: `1px dashed ${neutral[200]}`, paddingTop: space.xs, marginTop: space.xs }}>
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

      {/* 强制通过确认弹窗（完工预检未通过时展示未完成项，需用户显式确认；样式复用驳回弹窗） */}
      {forceTarget && (
        <div
          data-testid="force-confirm-modal"
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
              setForceTarget(null);
            }}
            style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleForceConfirm();
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
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.lg,
              ...baseFont,
            }}
          >
            <div>
              <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>
                {forceTarget === "accept" ? "验收确认" : "归档确认"}
              </div>
              <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
                存在未完成项，确认仍要强制通过吗？强制记录将写入任务事件
              </div>
            </div>
            <div
              data-testid="force-blockers"
              role="alert"
              style={{ fontSize: fontSize.sm, lineHeight: 1.6, color: "#DC2626", fontWeight: 500 }}
            >
              {actionError}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button
                type="button"
                data-testid="force-cancel"
                onClick={() => setForceTarget(null)}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "var(--color-surface)",
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
                data-testid="force-confirm"
                disabled={pending}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#DC2626",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 600,
                  cursor: pending ? "default" : "pointer",
                  opacity: pending ? 0.65 : 1,
                  fontFamily: fontFamily.body,
                }}
              >
                确认强制通过
              </button>
            </div>
          </form>
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
              backgroundColor: "var(--color-surface)",
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
                backgroundColor: "var(--color-surface)",
                fontSize: fontSize.md,
                color: neutral[800],

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
                  backgroundColor: "var(--color-surface)",
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

      {/* 置阻塞原因弹窗（原因必填，复用驳回弹窗形态；红色强调） */}
      {blockOpen && (
        <div
          data-testid="block-modal"
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
              setBlockOpen(false);
            }}
            style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleBlockConfirm();
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
              backgroundColor: "var(--color-surface)",
              border: `1px solid ${neutral[200]}`,
              boxShadow: shadow.lg,
              ...baseFont,
            }}
          >
            <div>
              <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900] }}>置阻塞</div>
              <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>
                任务将挂起等待人工介入，原因必填（卡在哪里、缺什么、等谁），写入任务事件供团队可见
              </div>
            </div>
            <textarea
              data-testid="block-reason-input"
              value={reason}
              maxLength={512}
              rows={3}
              placeholder="填写阻塞原因（必填，最多 512 字）"
              onChange={(e) => setReason(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: `${space.md}px ${space.lg}px`,
                borderRadius: radius.md,
                border: `1px solid ${neutral[200]}`,
                backgroundColor: "var(--color-surface)",
                fontSize: fontSize.md,
                color: neutral[800],

                resize: "vertical",
                fontFamily: fontFamily.body,
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm }}>
              <button
                type="button"
                data-testid="block-cancel"
                onClick={() => setBlockOpen(false)}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: `1px solid ${neutral[200]}`,
                  backgroundColor: "var(--color-surface)",
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
                data-testid="block-confirm"
                disabled={pending || !reason.trim()}
                style={{
                  padding: `${space.sm}px ${space.lg}px`,
                  borderRadius: radius.md,
                  border: "none",
                  backgroundColor: "#B91C1C",
                  color: "#FFFFFF",
                  fontSize: fontSize.md,
                  fontWeight: 600,
                  cursor: pending || !reason.trim() ? "default" : "pointer",
                  opacity: pending || !reason.trim() ? 0.65 : 1,
                  fontFamily: fontFamily.body,
                }}
              >
                确认置阻塞
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
