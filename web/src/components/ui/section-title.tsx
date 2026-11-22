"use client";

/**
 * SectionTitle：卡片 / 面板标题的唯一规格
 * =============================================
 * 背景（视觉优化清单 AES-07）：同级面板标题此前有三种规格 ——
 *   「Worker 节点池」「任务与产出趋势」= 15px/600
 *   「平台技能」「全部 Provider」「消息渠道（入站）」= 13px/600
 *   「团队成员」= 13px/700
 * 三种规格放在同一页（或相邻页）会让层级读不出来：同样是「一个白色面板的标题」，
 * 有时比正文大一号，有时只和正文一样大。
 *
 * 统一规格：15px / 600 / neutral[900]，可选 13px 副标题，右侧可选 action 插槽。
 * 需要更弱的「分组标签」（面板内的小标题）请用 SectionLabel，不要复用本组件。
 */
import type { CSSProperties, ReactNode } from "react";
import { neutral, space, fontSize, fontFamily } from "@/src/theme/tokens";

export interface SectionTitleProps {
  children: ReactNode;
  /** 标题右侧的弱化后缀（如「3 个节点 · 在线 2 个」） */
  hint?: ReactNode;
  /** 标题下方的说明行 */
  subtitle?: ReactNode;
  /** 右侧操作区（按钮 / 图例） */
  action?: ReactNode;
  testid?: string;
  style?: CSSProperties;
}

export function SectionTitle({ children, hint, subtitle, action, testid, style }: SectionTitleProps) {
  return (
    <div
      data-testid={testid}
      style={{
        display: "flex",
        alignItems: subtitle ? "flex-start" : "center",
        gap: space.sm,
        fontFamily: fontFamily.body,
        ...style,
      }}
    >
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: space.sm, flexWrap: "wrap" }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: 600, color: neutral[900], lineHeight: 1.4 }}>
            {children}
          </span>
          {hint && (
            <span style={{ fontSize: fontSize.xs, color: neutral[500], lineHeight: 1.5 }}>{hint}</span>
          )}
        </div>
        {subtitle && (
          <div style={{ fontSize: fontSize.sm, color: neutral[500], lineHeight: 1.6 }}>{subtitle}</div>
        )}
      </div>
      {action && <div style={{ marginLeft: "auto", flexShrink: 0, display: "flex", alignItems: "center", gap: space.sm }}>{action}</div>}
    </div>
  );
}

/** 面板内的分组小标签（比 SectionTitle 弱一档，用于「表单里的一组字段」） */
export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: fontSize.md,
        fontWeight: 600,
        color: neutral[800],
        fontFamily: fontFamily.body,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
