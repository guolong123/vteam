/**
 * Agent Platform 原型设计 token
 * =============================================
 * 供 _shared/components.tsx 与各原型页面（T8~T11）统一引用。
 * 原则：所有颜色/间距/圆角/字号都收敛在此，组件内不散落 magic number。
 */

/* ---------------------------------- 角色 ---------------------------------- */
export type RoleKey = "product" | "project_manager" | "architect" | "developer" | "tester";

export interface RoleTheme {
  label: string;
  color: string;
  bg: string;
  border: string;
}

/** 五类 Agent 角色的语义色（产品=青蓝 / 项目经理=蓝 / 架构=紫 / 开发=绿 / 测试=橙，深色下半透明跟随 surface） */
export const roles: Record<RoleKey, RoleTheme> = {
  product: { label: "产品经理", color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4" },
  project_manager: { label: "项目经理", color: "#0284C7", bg: "#F0F9FF", border: "#BAE6FD" },
  architect: { label: "架构师", color: "#7C3AED", bg: "#F5F3FF", border: "#DDD6FE" },
  developer: { label: "开发者", color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  tester: { label: "测试", color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
};

/** 角色对应导航/面板上的强调色（深一档，用于文字） */
export const roleText: Record<RoleKey, string> = {
  product: "#0F766E",
  project_manager: "#0369A1",
  architect: "#6D28D9",
  developer: "#047857",
  tester: "#B45309",
};

/* ---------------------------------- 任务状态 ---------------------------------- */
export type StatusKey = "进行中" | "待验收" | "已完成" | "已归档";

export interface StatusTheme {
  color: string;
  bg: string;
  border: string;
}

/** 任务状态四色：进行中=青蓝 / 待验收=琥珀 / 已完成=绿 / 已归档=灰（深色下半透明） */
export const statusColors: Record<StatusKey, StatusTheme> = {
  "进行中": { color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4" },
  "待验收": { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  "已完成": { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  "已归档": { color: "var(--color-neutral-500)", bg: "var(--color-neutral-100)", border: "var(--color-neutral-200)" },
};

/* ---------------------------------- 中性色（CSS 变量驱动，自动跟随 light/dark） ---------------------------------- */
export const neutral = {
  900: "var(--color-neutral-900)",
  800: "var(--color-neutral-800)",
  700: "var(--color-neutral-700)",
  600: "var(--color-neutral-600)",
  500: "var(--color-neutral-500)",
  400: "var(--color-neutral-400)",
  300: "var(--color-neutral-300)",
  200: "var(--color-neutral-200)",
  100: "var(--color-neutral-100)",
  50: "var(--color-neutral-50)",
} as const;

/* 语义面：卡片/背景/边框（对齐 CSS 变量） */
export const surface = "var(--color-surface)";
export const bg = "var(--color-bg)";
export const border = "var(--color-border)";

/* @高亮：跟随 light/dark 自动切换（对齐 globals.css 双主题变量） */
export const mention = {
  bg: "var(--color-mention-bg)",
  border: "var(--color-mention-border)",
  accent: "var(--color-mention-accent)",
  text: "var(--color-mention-text)",
} as const;

/* ---------------------------------- 间距（4px 基准） ---------------------------------- */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/* ---------------------------------- 圆角 ---------------------------------- */
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

/* ---------------------------------- 字号 ---------------------------------- */
export const fontSize = {
  xs: 11,
  sm: 12,
  md: 13,
  lg: 15,
  xl: 18,
  xxl: 22,
} as const;

/* ---------------------------------- 字体 ---------------------------------- */
export const fontFamily = {
  body: `"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", -apple-system, "Segoe UI", sans-serif`,
  display: `Sora, "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", sans-serif`,
  mono: `"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace`,
} as const;

/* ---------------------------------- 阴影 ---------------------------------- */
export const shadow = {
  sm: "0 1px 2px rgba(15,23,42,.05), 0 1px 3px rgba(15,23,42,.08)",
  md: "0 4px 14px rgba(15,23,42,.08), 0 2px 4px rgba(15,23,42,.05)",
  lg: "0 16px 40px rgba(15,23,42,.14)",
} as const;
