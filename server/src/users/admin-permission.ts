/**
 * 平台管理员判定谓词（**单一事实来源**，对齐 users/admin.guard.ts 的授权语义）。
 *
 * 判定口径（与 AdminGuard 完全一致，勿分叉）：
 *   1. `permissions.all === true`（seed 预置 admin 简写格式，兼容既有数据）；
 *   2. `permissions.users.manage === true`（权限矩阵 8 资源 × 6 操作格式）。
 *
 * 用法分层：
 *   - `hasAdminPermission(permissions)`：纯函数，判定角色权限 JSON；
 *   - `isPlatformAdminUser(user)`：附加「账号存在 + enabled」门禁的纯函数；
 *   - `isPlatformAdminByUserId(prisma, userId)`：查库版（service 层
 *     「读/写成员感知过滤」场景复用，避免各处再抄一遍守卫逻辑）。
 *
 * 为什么不放 admin.guard.ts 内：守卫在请求期执行，而 service 需要在
 * 无守卫的成员感知端点上复用同一口径（例如 memories 的非 admin 过滤）。
 */
import type { PrismaService } from '../prisma/prisma.service';

/** 角色权限 JSON 的宽松形状（Role.permissions 为 Prisma Json 列）。 */
export type AdminPermissionPayload = unknown;

/** 判定角色权限 JSON 是否满足平台管理员口径。 */
export function hasAdminPermission(permissions: AdminPermissionPayload): boolean {
  if (!permissions || typeof permissions !== 'object') {
    return false;
  }
  const perms = permissions as Record<string, unknown>;
  if (perms.all === true) {
    return true;
  }
  const usersPerm = perms.users as { manage?: boolean } | undefined;
  return usersPerm?.manage === true;
}

/**
 * 判定「用户 + 其角色」是否为平台管理员。
 * 账号不存在 / 已禁用 / 角色缺失 → false（与守卫的 401 前置分流保持同一取值）。
 */
export function isPlatformAdminUser(
  user:
    | { enabled: boolean; role?: { permissions: AdminPermissionPayload } | null }
    | null
    | undefined,
): boolean {
  if (!user || !user.enabled) {
    return false;
  }
  return hasAdminPermission(user.role?.permissions);
}

/**
 * 查库版平台管理员判定（service 层复用 AdminGuard 口径）。
 * 用户不存在 / 已禁用 / 角色无 users.manage → false（收敛为「非管理员」，由调用方按成员口径过滤）。
 */
export async function isPlatformAdminByUserId(
  prisma: Pick<PrismaService, 'user'>,
  userId: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });
  return isPlatformAdminUser(user);
}
