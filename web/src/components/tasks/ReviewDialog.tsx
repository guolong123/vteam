"use client";
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

/* ================================ 评审弹窗（verdict + reason textarea） ================================ */
export function ReviewDialog({
  open,
  planId,
  verdict,
  reason,
  error,
  submitting,
  onClose,
  onVerdictChange,
  onReasonChange,
  onSubmit,
}: {
  open: boolean;
  planId: string | null;
  verdict: "approved" | "rejected";
  reason: string;
  error: string | null;
  submitting: boolean;
  onClose: () => void;
  onVerdictChange: (v: "approved" | "rejected") => void;
  onReasonChange: (r: string) => void;
  onSubmit: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open || !planId) return null;

  const inputBase: CSSProperties = {
    width: "100%", boxSizing: "border-box",
    padding: `${space.md}px ${space.lg}px`, borderRadius: radius.md,
    border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)",
    fontSize: fontSize.md, color: neutral[800], outline: "none",
    fontFamily: fontFamily.body,
  };

  return (
    <div data-testid="review-dialog-overlay" onClick={(e) => e.stopPropagation()} style={{ position: "absolute", inset: 0, zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "8%", ...baseFont }}>
      <div aria-hidden data-testid="review-dialog-mask" onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: "absolute", inset: 0, backgroundColor: "rgba(15,23,42,.32)" }} />
      <div data-testid="review-dialog-modal" style={{ position: "relative", width: 440, maxWidth: "calc(100% - 48px)", display: "flex", flexDirection: "column", gap: space.md, padding: space.xl, borderRadius: radius.lg, backgroundColor: "var(--color-surface)", border: `1px solid ${neutral[200]}`, boxShadow: shadow.lg }}>
        <div>
          <div style={{ fontSize: fontSize.xl, fontWeight: 600, color: neutral[900], lineHeight: 1.3 }}>评审执行计划</div>
          <div style={{ fontSize: fontSize.sm, color: neutral[400], marginTop: space.xs }}>通过后任务可按计划驱动执行</div>
        </div>

        <div style={{ display: "flex", gap: space.sm }}>
          {(["approved", "rejected"] as const).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`review-verdict-${v}`}
              onClick={() => onVerdictChange(v)}
              style={{
                flex: 1, padding: `${space.sm}px ${space.md}px`, borderRadius: radius.md,
                border: `1px solid ${verdict === v ? (v === "approved" ? "#059669" : "#DC2626") : neutral[200]}`,
                backgroundColor: verdict === v ? (v === "approved" ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.10)") : "var(--color-surface)",
                color: verdict === v ? (v === "approved" ? "#059669" : "#DC2626") : neutral[600],
                fontSize: fontSize.md, fontWeight: 500, cursor: "pointer", fontFamily: fontFamily.body,
              }}
            >
              {v === "approved" ? "通过" : "驳回"}
            </button>
          ))}
        </div>

        {verdict === "rejected" && (
          <label style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
            <span style={{ fontSize: fontSize.md, fontWeight: 500, color: neutral[700] }}>
              驳回原因 <span style={{ color: "#DC2626" }}>*</span>
            </span>
            <textarea
              data-testid="review-reason-input"
              value={reason}
              rows={3}
              maxLength={512}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder="请填写驳回原因…"
              style={{ ...inputBase, resize: "vertical", lineHeight: 1.6 }}
            />
          </label>
        )}

        {error && (
          <div role="alert" style={{ fontSize: fontSize.sm, color: "#DC2626", fontWeight: 500 }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm }}>
          <button type="button" data-testid="review-cancel" onClick={onClose} disabled={submitting} style={{ padding: `${space.sm + 1}px ${space.lg}px`, borderRadius: radius.pill, border: `1px solid ${neutral[200]}`, backgroundColor: "var(--color-surface)", color: neutral[600], fontSize: fontSize.md, cursor: submitting ? "default" : "pointer", fontFamily: fontFamily.body }}>
            取消
          </button>
          <button
            type="button"
            data-testid="review-submit"
            disabled={submitting || (verdict === "rejected" && !reason.trim())}
            onClick={onSubmit}
            style={{
              padding: `${space.sm + 1}px ${space.lg}px`, borderRadius: radius.pill, border: "none",
              backgroundColor: verdict === "approved" ? "#059669" : "#DC2626",
              color: "#FFFFFF", fontSize: fontSize.md, fontWeight: 500,
              cursor: submitting || (verdict === "rejected" && !reason.trim()) ? "default" : "pointer",
              opacity: submitting || (verdict === "rejected" && !reason.trim()) ? 0.6 : 1,
              fontFamily: fontFamily.body,
            }}
          >
            {submitting ? "提交中…" : "提交评审"}
          </button>
        </div>
      </div>
    </div>
  );
}

