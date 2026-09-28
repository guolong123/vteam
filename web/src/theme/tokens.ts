/**
 * Agent Platform 原型设计 token
 * =============================================
 * 供 _shared/components.tsx 与各原型页面（T8~T11）统一引用。
 * 原则：所有颜色/间距/圆角/字号都收敛在此，组件内不散落 magic number。
 */

/* ---------------------------------- 角色 ---------------------------------- */
export type RoleKey = "product" | "project_manager" | "architect" | "developer" | "tester" | "plan";

export interface RoleTheme {
  label: string;
  color: string;
  bg: string;
  border: string;
}

/**
 * 六类 Agent 角色的语义色（产品=青蓝 / 项目经理=蓝 / 架构=紫 / 开发=绿 / 测试=橙 / 计划员= indigo）
 * =============================================
 * 角色色**唯一来源**是 `app/globals.css` 的 `:root` / `.dark` 变量对
 * （`--color-role-<kebab-role>-{color,bg,border}`）；此处只存 `var()` 引用，
 * 不复制 hex —— 否则深色下会锁死浅色不透明值（B10 角色色主题化）。
 */
export const roles: Record<RoleKey, RoleTheme> = {
  product: { label: "产品经理", color: "var(--color-role-product-color)", bg: "var(--color-role-product-bg)", border: "var(--color-role-product-border)" },
  project_manager: { label: "项目经理", color: "var(--color-role-project-manager-color)", bg: "var(--color-role-project-manager-bg)", border: "var(--color-role-project-manager-border)" },
  architect: { label: "架构师", color: "var(--color-role-architect-color)", bg: "var(--color-role-architect-bg)", border: "var(--color-role-architect-border)" },
  developer: { label: "开发者", color: "var(--color-role-developer-color)", bg: "var(--color-role-developer-bg)", border: "var(--color-role-developer-border)" },
  tester: { label: "测试", color: "var(--color-role-tester-color)", bg: "var(--color-role-tester-bg)", border: "var(--color-role-tester-border)" },
  plan: { label: "计划员", color: "var(--color-role-plan-color)", bg: "var(--color-role-plan-bg)", border: "var(--color-role-plan-border)" },
};

/** 全部 RoleKey（键序 = `roles` 声明序），由 `roles` 派生以保证与色板永不漂移。 */
export const ROLE_KEYS: readonly RoleKey[] = Object.keys(roles) as RoleKey[];

/** 角色对应导航/面板上的强调色：与 `roles.color` 同源同变量（`--color-role-*-color`），不维护第二套深色 hex */
export const roleText: Record<RoleKey, string> = {
  product: "var(--color-role-product-color)",
  project_manager: "var(--color-role-project-manager-color)",
  architect: "var(--color-role-architect-color)",
  developer: "var(--color-role-developer-color)",
  tester: "var(--color-role-tester-color)",
  plan: "var(--color-role-plan-color)",
};

/* ---------------------------------- 任务状态 ---------------------------------- */
export type StatusKey = "进行中" | "阻塞中" | "待验收" | "已完成" | "已归档";

export interface StatusTheme {
  color: string;
  bg: string;
  border: string;
}

/** 任务状态五色：进行中=青蓝 / 阻塞中=红 / 待验收=琥珀 / 已完成=绿 / 已归档=灰（深色下半透明） */
export const statusColors: Record<StatusKey, StatusTheme> = {
  "进行中": { color: "#0D9488", bg: "#F0FDFA", border: "#99F6E4" },
  "阻塞中": { color: "#B91C1C", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.22)" },
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

/**
 * 消息作用域三级字号（chat-ux-hierarchy-and-streaming A4）：
 * 正文 14 / 身份 12 / 元信息 11，只作用于聊天消息渲染。
 * 刻意独立于全局 `fontSize`——`fontSize.md` 保持 13，消息密度不牵动全站字号。
 */
export const messageFontSize = {
  body: 14,
  identity: 12,
  meta: 11,
} as const;

/** 消息身份名字重：semibold（正文与元信息为 400，形成 400/600/400 层级） */
export const messageFontWeight = {
  identity: 600,
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
