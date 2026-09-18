/**
 * /system 二级导航目录（纯常量，无 "use client"）
 * =============================================
 * 唯一源是这里的 SYSTEM_NAV_ITEMS —— 侧栏（system-sidebar.tsx，client）与
 * /system 落地页（page.tsx，server redirect）共用同一份顺序。
 *
 * 为什么不把顺序写在 page.tsx 里：落地页要用「第一项」做重定向目标，若两处各自
 * 硬编码，调整侧栏顺序时落地页会静默指向旧项（顺序漂移 bug）。
 */
export interface SystemNavItem {
  key: string;
  label: string;
  href: string;
  icon: string;
}

/** /system 二级导航（顺序即落地页重定向目标：第一项为默认落点） */
export const SYSTEM_NAV_ITEMS: SystemNavItem[] = [
  { key: "triggers", label: "触发器", href: "/system/triggers", icon: "◷" },
  { key: "users", label: "用户管理", href: "/system/users", icon: "○" },
  { key: "roles", label: "角色权限", href: "/system/roles", icon: "⬡" },
  { key: "memories", label: "记忆管理", href: "/system/memories", icon: "◈" },
];

/** /system 落地页默认落点（第一项）；名册为空时为 null（调用方兜底） */
export const SYSTEM_DEFAULT_HREF: string | null =
  SYSTEM_NAV_ITEMS[0]?.href ?? null;
