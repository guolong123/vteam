/**
 * 平台级权限点（跨空间能力，不绑定具体资源域）。
 *
 * 与 8 资源 × 6 操作矩阵共存于 `Role.permissions` JSON：
 * ```json
 * { "platform": { "relocate_resource": true, "cross_space_read": true } }
 * ```
 * seed 的 admin 角色用 `{ all: true }` 覆盖全部权限点；自定义角色可单独授予。
 *
 * 用法：`@RequirePermission('platform.relocate_resource')` + PermissionGuard。
 */
export const PLATFORM_PERMISSIONS = {
  /** 资源空间迁移（发布共享到系统空间 / 回收）与迁移审计查看 */
  RELOCATE_RESOURCE: 'platform.relocate_resource',
  /** 跨空间只读查看（全部空间列表、跨空间排障） */
  CROSS_SPACE_READ: 'platform.cross_space_read',
} as const;

export type PlatformPermission =
  (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];
