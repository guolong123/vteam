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

/** 判定所需的最小用户形状（避免 permissions.ts 反向依赖 store 运行时）。 */
export interface SpaceAwareUser {
  currentWorkspaceId?: string | null;
  workspaces?: Array<{ id: string; role?: string }> | null;
  permissions?: RolePermissions;
}

/** 当前空间的成员角色（owner/admin/member）；找不到返回 undefined。 */
export function currentWorkspaceRole(
  user: SpaceAwareUser | null | undefined,
): string | undefined {
  const wsId = user?.currentWorkspaceId;
  if (!wsId || !user?.workspaces) return undefined;
  return user.workspaces.find((w) => w.id === wsId)?.role;
}

/**
 * 当前空间管理员（owner/admin）判定：对齐后端 WorkspaceAdminGuard /
 * PermissionGuard 的空间管理员兜底语义。
 */
export function isWorkspaceManager(
  user: SpaceAwareUser | null | undefined,
): boolean {
  const role = currentWorkspaceRole(user);
  return role === "owner" || role === "admin";
}

/**
 * 是否可管理当前空间（平台管理员不受限；空间管理员限本空间）。
 * 跨空间与平台级能力仍用 isPlatformAdmin。
 */
export function canManageCurrentSpace(
  user: SpaceAwareUser | null | undefined,
): boolean {
  return isPlatformAdmin(user?.permissions) || isWorkspaceManager(user);
}
