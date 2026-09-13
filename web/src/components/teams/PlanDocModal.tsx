/**
 * PlanDocModal：计划文档弹窗（任务 Tab 下"计划"子 Tab 点击标题弹出）。
 *
 * 纯展示组件（dumb modal）：**不发请求、不取数**。列表接口
 * `GET /tasks/:id/plan-docs` 已把正文随列表一次下发，本组件只负责渲染，
 * 因此打开弹窗是零延迟的，也不会出现"列表有、点开转圈"的不一致窗口。
 *
 * 数据来源是任务目录 `.opencode/plans/*.md` 的真实文件内容——vteam 不自维护
 * 计划版本，故这里不再有 vN/版本列表的概念，只显示文件名与最后修改时间。
 */
"use client";
import { useEffect } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

export interface PlanDocContent {
  /** 文件名（等于弹窗标题）。 */
  name: string;
  /** 最后修改时间（ISO 字符串）。 */
  updatedAt: string;
  /** 正文（可能被服务端截断）。 */
  content: string;
  /** 正文是否被截断（截断时显示提示，避免用户以为文件就这么多）。 */
  truncated?: boolean;
}

/** 相对时间展示（计划文件由 agent 反复覆盖写，绝对时间意义不大）。 */
function formatUpdatedAt(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚更新";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前更新`;
  return new Date(t).toLocaleString();
}

export function PlanDocModal({
  doc,
  onClose,
}: {
  /** 当前展示的文档（null=关闭）。 */
  doc: PlanDocContent | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!doc) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [doc, onClose]);

  if (!doc) return null;

  return (
    <div
      data-testid="plan-doc-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        backgroundColor: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "var(--color-surface)",
          borderRadius: radius.md,
          boxShadow: shadow.md,
          overflow: "hidden",
          fontFamily: fontFamily.body,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `${space.sm}px ${space.md}px`,
            borderBottom: `1px solid ${neutral[200]}`,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: fontSize.md,
              fontWeight: 600,
              color: neutral[800],
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {doc.name}
          </span>
          <span
            data-testid="plan-doc-modal-updated"
            style={{
              flexShrink: 0,
              fontSize: fontSize.xs,
              color: neutral[400],
            }}
          >
            {formatUpdatedAt(doc.updatedAt)}
          </span>
          <button
            type="button"
            data-testid="plan-doc-modal-close"
            onClick={onClose}
            aria-label="关闭"
            style={{
              border: "none",
              background: "transparent",
              color: neutral[400],
              cursor: "pointer",
              fontSize: fontSize.md,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>
        <div
          style={{
            padding: `${space.md}px ${space.lg}px`,
            overflowY: "auto",
            fontSize: fontSize.sm,
            color: neutral[700],
          }}
        >
          {doc.content ? (
            <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, wordBreak: "break-word" }}>
              {doc.content}
            </div>
          ) : (
            <span style={{ color: neutral[400] }}>（空文件）</span>
          )}
          {doc.truncated && (
            <div
              data-testid="plan-doc-modal-truncated"
              style={{
                marginTop: space.md,
                fontSize: fontSize.xs,
                color: "#B45309",
                backgroundColor: "rgba(245,158,11,0.10)",
                border: "1px solid rgba(245,158,11,0.30)",
                borderRadius: radius.md,
                padding: `${space.xs}px ${space.sm}px`,
              }}
            >
              文件较大，此处仅显示前 256KB。完整内容见任务目录 .opencode/plans/{doc.name}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
