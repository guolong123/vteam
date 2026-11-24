import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { TenantContext } from '../tenant/tenant-context';

/**
 * `@CurrentWorkspace()` 参数装饰器：返回 WorkspaceGuard 解析出的当前租户上下文
 * （`{ workspaceId, userId, mode, readOnly, isPlatformAdmin }`）。
 *
 * 仅在已挂载 WorkspaceGuard 的 HTTP 请求内有值。
 */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext | undefined => {
    const request = ctx.switchToHttp().getRequest<{ tenant?: TenantContext }>();
    return request.tenant;
  },
);
