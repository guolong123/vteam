import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, type Subscription } from 'rxjs';
import { runWithTenant, type TenantContext } from './tenant-context';

/**
 * 请求级租户上下文拦截器（APP_INTERCEPTOR）。
 *
 * 在 WorkspaceGuard 解析出 `req.tenant` 之后，用 AsyncLocalStorage 包裹本次请求的
 * 处理链，使 Prisma 租户中间件在任意深度的 service 调用里都能取到当前空间。
 * 无 tenant（@Public / worker 通道）时直接放行。
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const request = context
      .switchToHttp()
      .getRequest<Request & { tenant?: TenantContext }>();
    const tenant = request.tenant;
    if (!tenant) {
      return next.handle();
    }
    return new Observable((subscriber) => {
      let subscription: Subscription | undefined;
      runWithTenant(tenant, () => {
        subscription = next.handle().subscribe(subscriber);
      });
      return () => subscription?.unsubscribe();
    });
  }
}
