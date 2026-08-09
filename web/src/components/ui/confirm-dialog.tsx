/**
 * ConfirmDialog：关键/危险操作二次确认弹窗（OBS-003 + UX-17 修复）
 * =============================================================
 * Provider 凭据删除 / 角色删除 / 用户禁用等高误触风险操作前展示，
 * 确认后才执行，防止误删误禁（凭据删除不可恢复）。
 *
 * 对齐项目 Modal 模式（reject-modal / user-form-overlay / ConfigureModal）：
 * - 铁律 T15：absolute 相对宿主（宿主需 position:relative）+ 遮罩点击关闭 + Esc 关闭，
 *   无 fixed / 100vh / 100vw。
 * - 结构：标题 + 描述 + 取消 / 确认（danger 红色，与 roles 页 delete-role-button 同色系）。
 * - data-testid 默认 confirm-delete-modal / confirm-delete-cancel / confirm-delete-confirm；
 *   可通过 testid prop 按上下文定制前缀（如用户禁用 confirm-toggle-*）。
 */
import { useEffect, type CSSProperties } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

const baseFont: CSSProperties = { fontFamily: fontFamily.body };

export interface ConfirmDialogProps {
  open: boolean;
  /** testid 前缀（默认 "confirm-delete"，生成 <prefix>-modal / <prefix>-cancel / <prefix>-confirm） */
  testid?: string;
  title: string;
  description?: string;
  /** 确认按钮文案（默认「确认删除」） */
  confirmLabel?: string;
  /** 确认按钮 pending 文案（默认「处理中…」） */
  pendingLabel?: string;
  /** 危险操作红色确认按钮（默认 true；非危险如启用操作传 false 走蓝） */
  danger?: boolean;
  submitting?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  testid = "confirm-delete",
  title,
  description,
  confirmLabel = "确认删除",
  pendingLabel = "处理中…",
  danger = true,
  submitting = false,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  // Esc 关闭（对齐 reject-modal / user-form-overlay 模式）
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid={`${testid}-modal`}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10%",
        ...baseFont,
      }}
    >
      {/* 遮罩：点击关闭 */}
      <div
        aria-hidden
        data-testid={`${testid}-mask`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }}
      />
      {/* 弹窗卡片 */}
      <div
        role="alertdialog"
        aria-label={title}
        style={{
          position: "relative",
          width: 400,
          maxWidth: "calc(100% - 48px)",
          display: "flex",
          flexDirection: "column",
          gap: space.md,
          padding: `${space.xl}px`,
          borderRadius: radius.lg,
          backgroundColor: "#FFFFFF",
          border: `1px solid ${neutral[200]}`,
          boxShadow: shadow.lg,
        }}
      >
        <div>
          <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>
            {title}
          </div>
          {description && (
            <div
              style={{
                fontSize: fontSize.sm,
                color: neutral[500],
                marginTop: space.xs,
                lineHeight: 1.6,
              }}
            >
              {description}
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button
            type="button"
            data-testid={`${testid}-cancel`}
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: `1px solid ${neutral[200]}`,
              backgroundColor: "#FFFFFF",
              color: neutral[600],
              fontSize: fontSize.md,
              cursor: submitting ? "default" : "pointer",
              fontFamily: fontFamily.body,
            }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid={`${testid}-confirm`}
            onClick={onConfirm}
            disabled={submitting}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`,
              borderRadius: radius.pill,
              border: "none",
              backgroundColor: danger ? "#DC2626" : "#2563EB",
              color: "#FFFFFF",
              fontSize: fontSize.md,
              fontWeight: 500,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.6 : 1,
              boxShadow: `0 6px 16px ${danger ? "rgba(220,38,38,.3)" : "rgba(37,99,235,.3)"}`,
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
