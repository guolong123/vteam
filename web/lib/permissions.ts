/**
 * 前端权限判定工具（对齐后端守卫语义，ISSUE-005）。
 *
 * 数据源：登录响应 AuthUserView.permissions（后端 auth.service.ts toUserView 透传
 * role.permissions）。三种兼容格式（见 server/src/users/roles.constants.ts）：
 * - `{ all: true }`（seed admin 简写）→ 全权限；
 * - `{ all: false }`（seed member 简写）→ 仅 view 类（成员只读）；
 * - 完整矩阵 `{ [resource]: { [action]: boolean } }`（自定义角色）→ 精确判定。
 */

/** 角色权限原始值（unknown 兼容旧持久化数据与后端 JSON 字段）。 */
export type RolePermissions = unknown;

/**
 * 按权限点判定（对齐后端 PermissionGuard.canActivate）：
 * `all:true` 全放行；`all:false` 仅 view 放行（写操作拒绝）；矩阵格式精确匹配。
 */
export function hasPermission(
  perms: RolePermissions,
  resource: string,
  action = "view",
): boolean {
  const p = (perms ?? {}) as Record<string, unknown>;
  if (p.all === true) return true;
  if (p.all === false) return action === "view";
  const row = p[resource] as Record<string, boolean> | undefined;
  return row?.[action] === true;
}

/**
 * 平台管理判定（对齐后端 AdminGuard：users/roles/models 管理端点语义）：
 * `all:true` 或矩阵 `users.manage === true`。
 */
export function isPlatformAdmin(perms: RolePermissions): boolean {
  const p = (perms ?? {}) as Record<string, unknown>;
  if (p.all === true) return true;
  const users = p.users as { manage?: boolean } | undefined;
  return users?.manage === true;
}
