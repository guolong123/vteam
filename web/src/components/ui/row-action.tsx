"use client";

/**
 * RowAction：列表行内操作的唯一按钮形态
 * =============================================
 * 背景（视觉优化清单 AES-01）：此前同一类「行操作」在 5 个页面有 4 种长相 ——
 * 团队/成员是裸文字链接（11px、无 padding、点击热区 22×17px），用户管理是描边按钮
 * （13px/10px 圆角），技能是描边按钮（12px），模型是胶囊（999px）。
 *
 * 本组件把它们收敛成一套：
 * - 几何：padding 6/10、圆角 radius.sm、最小高度 30px（点击热区达标）
 * - 字号：12px / 500（比正文小一档，但不再是 11px 的裸字）
 * - 形态：默认 Ghost（透明底、无描边），hover 出 neutral[100] 浅底
 * - 三种语气：default（中性灰）/ accent（品牌青）/ danger（红）
 * - 危险动作在前，次要动作在后由调用方决定，本组件只管单个按钮
 *
 * 为什么不改成常驻描边：行内按钮一多，描边会形成一堵「按钮墙」，反而盖过内容。
 * Ghost + hover 是列表行的通行做法，也让 20 行表格的视觉噪声降一档。
 */
import { useState, type CSSProperties } from "react";
import { space, radius, fontSize, fontFamily } from "@/src/theme/tokens";

export type RowActionTone = "default" | "accent" | "danger";

export interface RowActionProps {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** 语气：default 中性 / accent 品牌青 / danger 危险红 */
  tone?: RowActionTone;
  disabled?: boolean;
  title?: string;
  testid?: string;
  /** 附加 data-* 属性（如 data-user-id / data-skill-id） */
  dataAttrs?: Record<string, string | undefined>;
  style?: CSSProperties;
}

const TONE_COLOR: Record<RowActionTone, string> = {
  default: "var(--color-neutral-600)",
  accent: "var(--color-accent-text)",
  danger: "var(--color-danger-text)",
};

export function RowAction({
  children,
  onClick,
  tone = "default",
  disabled,
  title,
  testid,
  dataAttrs,
  style,
}: RowActionProps) {
  const [hover, setHover] = useState(false);
  const color = TONE_COLOR[tone];

  return (
    <button
      type="button"
      data-testid={testid}
      {...(dataAttrs ?? {})}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        minHeight: 30,
        padding: `${space.xs + 2}px 10px`,
        borderRadius: radius.sm,
        border: "none",
        backgroundColor: hover && !disabled ? "var(--color-neutral-100)" : "transparent",
        color: disabled ? "var(--color-neutral-400)" : color,
        fontSize: fontSize.sm,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontFamily: fontFamily.body,
        transition: "background-color .15s ease, color .15s ease",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** 行操作容器：统一 8px 间距 + 右对齐，避免各页各写一套 gap。 */
export function RowActions({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: space.xs,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
