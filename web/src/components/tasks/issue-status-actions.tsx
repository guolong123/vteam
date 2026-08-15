"use client";

/**
 * Issue 状态流转操作按钮组（issue-management plan todo 4；is_0000000013 增 rejected 态）
 * =============================================================
 * 任务内 issue 的状态机与 Task 五态不同（Metis m6：两者 action 同名 start/reject，
 * 禁止复用 TaskStatusActions 的 start/reject 常量/组件），独立实现：
 *   open        → start  → in_progress
 *   in_progress → resolve → resolved；in_progress → reject → rejected（必填原因）
 *   resolved    → close  → closed
 *   closed      → reopen → open
 *   rejected    → reopen → open
 * 调用 POST /issues/:id/transition（TransitionIssueDto {action, reason}），
 * from 不匹配 → 后端 409 ISSUE_INVALID_TRANSITION（前端按状态渲染，正常不触发）；
 * action=reject 无 reason → 后端 400 ISSUE_REJECT_REASON_REQUIRED（前端点击后弹原因输入）。
 * 行内横向小按钮（列表行操作列，区别于看板卡片竖向 TaskStatusActions）。
 * data-testid：issue-transition-<action>。
 */
import type { CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { isApiError } from "@/lib/errors";
import { neutral, space, radius, fontSize, fontFamily } from "@/src/theme/tokens";
import type { IssueStatus, TransitionIssuePayload } from "@/src/types/issues";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

/** issue 流转动作（对齐后端 ISSUE_TRANSITIONS keys）。 */
type IssueAction = "start" | "resolve" | "close" | "reopen" | "reject";

interface IssueStatusActionsProps {
  issueId: string;
  status: IssueStatus;
  /** 流转完成后额外回调（详情弹窗失效 ["issue", id] 缓存用，is_0000000012）。 */
  onSettled?: () => void;
}

/** 各状态可执行动作组（终态之外均至少一项）。 */
const ACTION_SETS: Record<IssueStatus, IssueAction[]> = {
  open: ["start"],
  in_progress: ["resolve", "reject"],
  resolved: ["close"],
  closed: ["reopen"],
};

/** 动作元信息：按钮文案 / 强调色。颜色对齐 issue 状态语义（开始蓝/解决绿/关闭灰/重开琥珀/退回琥珀）。 */
const ACTION_META: Record<IssueAction, { label: string; color: string; pendingLabel: string }> = {
  start: { label: "开始处理", color: "#2563EB", pendingLabel: "处理中…" },
  resolve: { label: "标记解决", color: "#059669", pendingLabel: "解决中…" },
  close: { label: "关闭", color: "#64748B", pendingLabel: "关闭中…" },
  reopen: { label: "重新打开", color: "#D97706", pendingLabel: "重开中…" },
  reject: { label: "退回", color: "#D97706", pendingLabel: "退回中…" },
};

/**
 * 按 issue 状态渲染横向流转按钮组。
 * 内部持有 mutation（onSettled 失效 issues 缓存），调用方无需感知请求细节。
 */
export function IssueStatusActions({ issueId, status, onSettled }: IssueStatusActionsProps) {
  const queryClient = useQueryClient();
  const transitionMutation = useMutation({
    mutationFn: (action: TransitionIssuePayload["action"]) =>
      api.post(`/issues/${issueId}/transition`, { action } satisfies TransitionIssuePayload),
    onSettled: () => {
      // 列表（["issues", ...]）缓存失效重取，按钮随新状态重渲染
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      onSettled?.();
    },
  });

  const actions = ACTION_SETS[status];
  const pending = transitionMutation.isPending;
  const error = isApiError(transitionMutation.error)
    ? transitionMutation.error.message
    : transitionMutation.isError
      ? "操作失败，请稍后重试"
      : null;

  return (
    <div
      data-testid="issue-status-actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        flexWrap: "wrap",
        ...baseFont,
      }}
    >
      {actions.map((action) => {
        const meta = ACTION_META[action];
        return (
          <button
            key={action}
            type="button"
            data-testid={`issue-transition-${action}`}
            disabled={pending}
            onClick={(e) => {
              e.stopPropagation();
              transitionMutation.mutate(action);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: space.xs,
              padding: `${space.xs + 1}px ${space.md}px`,
              borderRadius: radius.pill,
              border: `1px solid ${meta.color}`,
              backgroundColor: "#FFFFFF",
              color: meta.color,
              fontSize: fontSize.sm,
              fontWeight: 500,
              cursor: pending ? "default" : "pointer",
              opacity: pending ? 0.6 : 1,
              fontFamily: fontFamily.body,
              transition: "background-color .15s ease, color .15s ease",
            }}
          >
            {pending ? meta.pendingLabel : meta.label}
          </button>
        );
      })}
      {error && (
        <span
          data-testid="issue-transition-error"
          role="alert"
          style={{ fontSize: fontSize.sm, color: "#DC2626", fontWeight: 500 }}
        >
          {error}
        </span>
      )}
      {actions.length === 0 && (
        <span style={{ fontSize: fontSize.sm, color: neutral[400] }}>无可用操作</span>
      )}
    </div>
  );
}
