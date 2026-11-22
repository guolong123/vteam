"use client";

/**
 * PrimaryButton：页面级主 CTA 的唯一形态
 * =============================================
 * 背景（视觉优化清单 AES-02）：此前「页面唯一主按钮」在 6 个页面有 2 种圆角、6 档高度 ——
 * 团队 10px/h34、成员 10px/h36、集成 10px/h42、技能 999px/h38、仓库 999px/h30、用户 999px/h40。
 * 并排看像两个产品。
 *
 * 收敛规格：圆角 10px、高度 36px、12px/600 文字、品牌青底白字。
 * 胶囊（999px）只留给筛选 chip —— 它是「可切换的选项」，不是「执行动作」，
 * 两者共用同一形状会让用户分不清「点了会执行」还是「点了会筛选」。
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { neutral, radius, fontSize, fontFamily, shadow } from "@/src/theme/tokens";

/** 主色（与 tokens 里 statusColors「进行中」同源；主按钮统一走这一个值） */
const BRAND = "var(--color-brand-fill)";
const BRAND_HOVER = "var(--color-brand-fill-hover)";

export interface PrimaryButtonProps {
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  type?: "button" | "submit";
  testid?: string;
  /** 次要形态：白底描边（同尺寸，用于「上传」「同步」这类并列动作） */
  variant?: "solid" | "outline";
  /** 占满父容器宽度（表单底部提交按钮） */
  block?: boolean;
  title?: string;
  style?: CSSProperties;
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
  testid,
  variant = "solid",
  block = false,
  title,
  style,
}: PrimaryButtonProps) {
  const [hover, setHover] = useState(false);
  const solid = variant === "solid";

  return (
    <button
      type={type}
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        width: block ? "100%" : undefined,
        height: 36,
        padding: "0 16px",
        borderRadius: radius.md,
        border: solid ? "none" : `1px solid ${neutral[200]}`,
        backgroundColor: solid
          ? disabled
            ? "var(--color-neutral-200)"
            : hover
              ? BRAND_HOVER
              : BRAND
          : hover
            ? "var(--color-neutral-50)"
            : "var(--color-surface)",
        color: solid ? "#FFFFFF" : neutral[700],
        fontSize: fontSize.sm,
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: "nowrap",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        boxShadow: solid && !disabled ? shadow.sm : "none",
        fontFamily: fontFamily.body,
        transition: "background-color .15s ease",
        ...style,
      }}
    >
      {children}
    </button>
  );
}
