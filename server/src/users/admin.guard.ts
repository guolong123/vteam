import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 平台管理员守卫（Phase 3 T8 落地）。
 *
 * 前置：全局 JwtAuthGuard 已解析 access token 并填充 request.user =
 * `{ id, username, roleId, tokenType }`（见 auth/jwt.strategy.ts validate）。
 *
 * 校验链路：
 *   1. request.user.id → 查 users 表（含 role）；
 *   2. 用户不存在或已禁用 → 401；
 *   3. 角色权限满足任一 → 放行：
 *      - `permissions.all === true`（seed 预置 admin 的简写格式，兼容既有数据）；
 *      - `permissions.users.manage === true`（Phase 3 权限矩阵 8 资源 × 6 操作格式）。
 *   4. 否则 → 403 FORBIDDEN_ADMIN。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authUser = request.user as
      { id?: string; username?: string } | undefined;

    if (!authUser?.id) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '未认证或 token 无效',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: authUser.id },
      include: { role: true },
    });
    if (!user || !user.enabled) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '账号不存在或已禁用',
      });
    }

    const permissions = (user.role.permissions ?? {}) as Record<
      string,
      unknown
    >;
    if (permissions.all === true) {
      return true;
    }
    const usersPerm = permissions.users as { manage?: boolean } | undefined;
    if (usersPerm?.manage === true) {
      return true;
    }

    throw new ForbiddenException({
      code: 'FORBIDDEN_ADMIN',
      message: '需要 users:manage 管理员权限',
    });
  }
}
