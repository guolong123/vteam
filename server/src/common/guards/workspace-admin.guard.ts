import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { hasAdminPermission } from '../../users/admin-permission';
import { TENANT_WORKSPACE_ID } from '../../common/tenant/tenant.constants';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { WORKSPACE_ROLE } from '../../workspaces/workspaces.constants';

/**
 * 「平台管理员 或 当前空间管理员」守卫（M4 角色分层）。
 *
 * 背景：数据面按空间隔离后，模型/Worker/技能/工具/MCP/仓库/记忆等平台功能
 * 都应在**所属空间内**由空间 owner/admin 自行运营，不再要求平台管理员。
 * 但账号、角色、平台统计、跨空间迁移等平台级操作仍归 AdminGuard。
 *
 * 判定：
 * 1. 平台管理员（`permissions.all` 或 `users.manage`）→ 放行；
 * 2. 当前空间（WorkspaceGuard 写入的 `req.tenant.workspaceId`）的 owner/admin → 放行；
 * 3. 系统空间只允许平台管理员；
 * 4. 其余 → 403 FORBIDDEN_WORKSPACE_ADMIN。
 *
 * 数据隔离不变：放行后 service 仍在当前空间租户上下文内读写，跨空间按 id 访问
 * 会被 findUnique 兜底（按不存在）拦截。
 */
@Injectable()
export class WorkspaceAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<
        Request & { user?: { id?: string }; tenant?: TenantContext }
      >();
    const userId = request.user?.id;
    if (!userId) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '未认证或 token 无效',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user || !user.enabled) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '账号不存在或已禁用',
      });
    }
    if (hasAdminPermission(user.role?.permissions)) {
      return true;
    }

    const workspaceId = request.tenant?.workspaceId;
    if (!workspaceId || workspaceId === TENANT_WORKSPACE_ID.SYSTEM) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_WORKSPACE_ADMIN',
        message: '需要平台管理员或当前空间管理员权限',
      });
    }
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (
      member &&
      (member.role === WORKSPACE_ROLE.OWNER ||
        member.role === WORKSPACE_ROLE.ADMIN)
    ) {
      return true;
    }
    throw new ForbiddenException({
      code: 'FORBIDDEN_WORKSPACE_ADMIN',
      message: '需要平台管理员或当前空间管理员权限',
    });
  }
}
