/**
 * 落地页分流（stats-dashboard 上线后调整）
 * =============================================
 * 登录成功后 / 直接进站时「第一眼落在哪」，由本文件**单点决定**。
 *
 * 规则：
 * - 平台管理员 → `/stats`（统计看板，经营全貌）
 * - 普通成员 → `/teams`（团队工作台）
 *
 * 为什么按角色分流而不是一律跳 `/stats`：
 * `GET /stats/overview` 的服务端门禁是 AdminGuard，普通成员进去只会看到 403 空态。
 * 这里的 `isPlatformAdmin` 与后端 AdminGuard **同一口径**（`lib/permissions.ts`），
 * 能提前分流到有权限的页面，而不是让用户先进去看报错。
 *
 * 为什么单独成文件而不是写在 `app/page.tsx` 里：
 * Next.js 的 page 文件只允许导出 `default` 与少数保留字段，导出辅助函数会触发
 * 「OmitWithTag ... does not satisfy the constraint」的类型错误（实测）。
 */
import { isPlatformAdmin } from "@/lib/permissions";

/** 管理员落地页：统计看板。 */
export const LANDING_ADMIN = "/stats";

/** 普通成员落地页：团队工作台。 */
export const LANDING_MEMBER = "/teams";

/**
 * 按用户权限解析落地页。
 * @param user 登录响应里的 AuthUserView（`permissions` 为未知形状的权限 JSON）
 */
export function resolveLandingPath(
  user: { permissions?: unknown } | null | undefined,
): string {
  return isPlatformAdmin(user?.permissions) ? LANDING_ADMIN : LANDING_MEMBER;
}
