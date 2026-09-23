"use client";

/**
 * DocModalShell：右侧面板文档弹窗的共用外壳（标题栏 + 可滚动正文 + Esc/遮罩关闭）。
 *
 * 目前有两个消费方：PlanDocModal（任务目录本地计划文件）与 ArtifactDocModal（计划类产出物）。
 * 两者正文渲染完全不同，但弹窗外壳一致——抽出来避免两处各写一份导致行为漂移
 * （关闭方式、层级、尺寸、头部布局）。
 *
 * 纯布局组件：不取数、不管业务，子内容由调用方决定。
 */
import { useEffect } from "react";
import {
  neutral,
  space,
  radius,
  fontSize,
  fontFamily,
  shadow,
} from "@/src/theme/tokens";

export function DocModalShell({
  testid,
  title,
  subtitle,
  subtitleTestid,
  closeTestid,
  headerExtra,
  onClose,
  children,
}: {
  /** 根节点 testid（如 plan-doc-modal）。 */
  testid: string;
  title: string;
  /** 头部标题右侧的次要文案（如更新时间 / 版本号）。 */
  subtitle?: string;
  subtitleTestid?: string;
  closeTestid?: string;
  /** 关闭按钮左侧的额外头部动作（如「在文档站打开」）。 */
  headerExtra?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div
      data-testid={testid}
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
            {title}
          </span>
          {subtitle !== undefined && (
            <span
              data-testid={subtitleTestid}
              style={{ flexShrink: 0, fontSize: fontSize.xs, color: neutral[400] }}
            >
              {subtitle}
            </span>
          )}
          {headerExtra}
          <button
            type="button"
            data-testid={closeTestid}
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
          data-testid="doc-modal-body"
          style={{
            padding: `${space.md}px ${space.lg}px`,
            overflowY: "auto",
            fontSize: fontSize.sm,
            color: neutral[700],
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
