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

/** 五类 Agent 角色的语义色（产品=蓝 / 项目经理=sky / 架构=紫 / 开发=绿 / 测试=橙） */
export const roles: Record<RoleKey, RoleTheme> = {
  product: { label: "产品经理", color: "#3B82F6", bg: "#EFF6FF", border: "#BFDBFE" },
  project_manager: { label: "项目经理", color: "#0EA5E9", bg: "#F0F9FF", border: "#BAE6FD" },
  architect: { label: "架构师", color: "#8B5CF6", bg: "#F5F3FF", border: "#DDD6FE" },
  developer: { label: "开发者", color: "#10B981", bg: "#ECFDF5", border: "#A7F3D0" },
  tester: { label: "测试", color: "#F59E0B", bg: "#FFFBEB", border: "#FDE68A" },
};

/** 角色对应导航/面板上的强调色（深一档，用于文字） */
export const roleText: Record<RoleKey, string> = {
  product: "#2563EB",
  project_manager: "#0284C7",
  architect: "#7C3AED",
  developer: "#059669",
  tester: "#D97706",
};

/* ---------------------------------- 任务状态 ---------------------------------- */
export type StatusKey = "进行中" | "待验收" | "已完成" | "已归档";

export interface StatusTheme {
  color: string;
  bg: string;
  border: string;
}

/** 任务状态四色：进行中=蓝 / 待验收=琥珀 / 已完成=绿 / 已归档=灰 */
export const statusColors: Record<StatusKey, StatusTheme> = {
  "进行中": { color: "#2563EB", bg: "#EFF6FF", border: "#BFDBFE" },
  "待验收": { color: "#D97706", bg: "#FFFBEB", border: "#FDE68A" },
  "已完成": { color: "#059669", bg: "#ECFDF5", border: "#A7F3D0" },
  "已归档": { color: "#64748B", bg: "#F1F5F9", border: "#E2E8F0" },
};

/* ---------------------------------- 中性色 ---------------------------------- */
export const neutral = {
  900: "#0F172A",
  800: "#1E293B",
  700: "#334155",
  600: "#475569",
  500: "#64748B",
  400: "#94A3B8",
  300: "#CBD5E1",
  200: "#E2E8F0",
  100: "#F1F5F9",
  50: "#F8FAFC",
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
