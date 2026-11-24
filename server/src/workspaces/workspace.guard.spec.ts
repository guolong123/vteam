import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspacesService } from './workspaces.service';

function ctxOf(request: any): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('WorkspaceGuard', () => {
  const tenant = {
    workspaceId: 'ws_a',
    userId: 'u_a',
    mode: 'request' as const,
    readOnly: false,
    isPlatformAdmin: false,
  };
  const workspaces = {
    buildTenantContext: jest.fn(async () => tenant),
  } as unknown as WorkspacesService;

  const make = (publicRoute = false) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(publicRoute),
    } as unknown as Reflector;
    return new WorkspaceGuard(reflector, workspaces);
  };

  beforeEach(() => jest.clearAllMocks());

  it('@Public 端点直接放行，不建立租户上下文', async () => {
    const req: any = { headers: {} };
    await expect(make(true).canActivate(ctxOf(req))).resolves.toBe(true);
    expect(workspaces.buildTenantContext).not.toHaveBeenCalled();
    expect(req.tenant).toBeUndefined();
  });

  it('无 req.user（worker 通道/未认证）放行，由 JwtAuthGuard 负责 401', async () => {
    const req: any = { headers: {} };
    await expect(make().canActivate(ctxOf(req))).resolves.toBe(true);
    expect(workspaces.buildTenantContext).not.toHaveBeenCalled();
  });

  it('已认证用户：解析当前空间并写入 req.tenant / req.user.workspaceId', async () => {
    const req: any = {
      headers: {},
      user: { id: 'u_a', workspaceId: 'ws_a' },
    };
    await expect(make().canActivate(ctxOf(req))).resolves.toBe(true);
    expect(req.tenant).toEqual(tenant);
    expect(req.user.workspaceId).toBe('ws_a');
    expect(workspaces.buildTenantContext).toHaveBeenCalledWith(
      { id: 'u_a', workspaceId: 'ws_a' },
      undefined,
    );
  });

  it('透传 x-workspace-id 请求头（平台管理员跨空间读）', async () => {
    const req: any = {
      headers: { 'x-workspace-id': ' ws_other ' },
      user: { id: 'u_admin' },
    };
    await make().canActivate(ctxOf(req));
    expect(workspaces.buildTenantContext).toHaveBeenCalledWith(
      { id: 'u_admin', workspaceId: undefined },
      'ws_other',
    );
  });
});
