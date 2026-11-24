import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { TENANT_WORKSPACE_HEADER } from '../common/tenant/tenant.constants';
import type { TenantContext } from '../common/tenant/tenant-context';
import { WorkspacesService } from './workspaces.service';

/**
 * 全局工作空间守卫（挂在 JwtAuthGuard 之后，作为 APP_GUARD）。
 *
 * 职责：把「当前空间」解析成 `req.tenant`，供 TenantContextInterceptor 写入
 * AsyncLocalStorage，再由 Prisma 租户中间件自动注入过滤/归属。
 *
 * 解析规则见 WorkspacesService.resolveRequestWorkspace：
 * - 平台管理员可用 `x-workspace-id` 跨空间读（readOnly，写会被中间件拒绝）；
 * - 普通用户只能用自己可访问的空间（JWT wid / lastWorkspaceId / 首个成员空间 / 自动建个人空间）。
 *
 * 安全兜底：无 `req.user` 时直接放行（由 JwtAuthGuard 统一 401；@Public 与 worker 通道
 * 无用户上下文，不建立租户上下文——它们的显式空间注入在后续阶段接入）。
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly workspaces: WorkspacesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const request = context
      .switchToHttp()
      .getRequest<
        Request & { user?: AuthenticatedUser; tenant?: TenantContext }
      >();
    const user = request.user;
    if (!user?.id) {
      // worker 注入拉取通道（@WorkerOrJwtAllowed）：按 x-worker-id 解析该节点归属空间，
      // 让列表/注入查询只返回「该空间 + 平台共享」资源（否则 worker 会拉到所有空间数据）。
      const workerToken = (request as Request & { workerToken?: string })
        .workerToken;
      const workerIdHeader = request.headers['x-worker-id'];
      const workerId =
        typeof workerIdHeader === 'string' ? workerIdHeader.trim() : '';
      if (workerToken && workerId) {
        const workspaceId =
          await this.workspaces.resolveWorkerWorkspaceId(workerId);
        if (workspaceId) {
          request.tenant = { workspaceId, mode: 'request' };
        }
      }
      return true;
    }

    const headerValue = request.headers[TENANT_WORKSPACE_HEADER];
    const headerWorkspaceId =
      typeof headerValue === 'string' && headerValue.trim().length > 0
        ? headerValue.trim()
        : undefined;

    const tenant = await this.workspaces.buildTenantContext(
      { id: user.id, workspaceId: user.workspaceId },
      headerWorkspaceId,
    );
    request.tenant = tenant;
    // 便于 handler 直接取（不修改 JWT 本身）
    user.workspaceId = tenant.workspaceId;
    return true;
  }
}
