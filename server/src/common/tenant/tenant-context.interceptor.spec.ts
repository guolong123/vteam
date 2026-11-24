import { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { runWithTenant, getTenantContext } from './tenant-context';
import { TenantContextInterceptor } from './tenant-context.interceptor';

function ctxOf(request: any): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('TenantContextInterceptor', () => {
  const interceptor = new TenantContextInterceptor();

  it('无 tenant（@Public/worker）时透传，不建立上下文', async () => {
    const request: any = {};
    const next = {
      handle: () => of(getTenantContext()),
    };
    const result = await lastValueFrom(
      interceptor.intercept(ctxOf(request), next as any),
    );
    expect(result).toBeUndefined();
  });

  it('有 tenant 时在 ALS 上下文中执行 handler', async () => {
    const request: any = {
      tenant: { workspaceId: 'ws_a', userId: 'u_a', mode: 'request' as const },
    };
    const next = {
      handle: () => of(getTenantContext()),
    };
    const result = await lastValueFrom(
      interceptor.intercept(ctxOf(request), next as any),
    );
    expect(result).toMatchObject({ workspaceId: 'ws_a', userId: 'u_a' });
  });

  it('handler 异步执行期间上下文仍可见', async () => {
    const request: any = {
      tenant: { workspaceId: 'ws_b', userId: 'u_b', mode: 'request' as const },
    };
    const next = {
      handle: () =>
        new (require('rxjs').Observable)((subscriber: any) => {
          setTimeout(() => {
            subscriber.next(getTenantContext());
            subscriber.complete();
          }, 1);
        }),
    };
    const result = await lastValueFrom(
      interceptor.intercept(ctxOf(request), next as any),
    );
    expect(result).toMatchObject({ workspaceId: 'ws_b' });
  });
});
