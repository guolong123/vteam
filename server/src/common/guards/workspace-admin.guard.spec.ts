import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { WorkspaceAdminGuard } from './workspace-admin.guard';

function ctx(
  user: { id?: string } | undefined,
  tenant?: { workspaceId: string },
) {
  const request = { user, tenant };
  return { switchToHttp: () => ({ getRequest: () => request }) } as never;
}

describe('WorkspaceAdminGuard（平台管理员 / 空间管理员分层）', () => {
  let prisma: {
    user: { findUnique: jest.Mock };
    workspaceMember: { findUnique: jest.Mock };
  };
  let guard: WorkspaceAdminGuard;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn() },
      workspaceMember: { findUnique: jest.fn() },
    };
    guard = new WorkspaceAdminGuard(prisma as never);
  });

  it('未认证 → 401', async () => {
    await expect(guard.canActivate(ctx(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('平台管理员（permissions.all）→ 放行，且不查空间成员', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_admin',
      enabled: true,
      role: { permissions: { all: true } },
    });
    await expect(
      guard.canActivate(ctx({ id: 'u_admin' }, { workspaceId: 'ws_a' })),
    ).resolves.toBe(true);
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it('当前空间 owner/admin → 放行', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_space_admin',
      enabled: true,
      role: { permissions: { all: false } },
    });
    for (const role of ['owner', 'admin']) {
      prisma.workspaceMember.findUnique.mockResolvedValue({ role });
      await expect(
        guard.canActivate(
          ctx({ id: 'u_space_admin' }, { workspaceId: 'ws_a' }),
        ),
      ).resolves.toBe(true);
    }
  });

  it('当前空间普通成员 → 403', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_member',
      enabled: true,
      role: { permissions: { all: false } },
    });
    prisma.workspaceMember.findUnique.mockResolvedValue({ role: 'member' });
    await expect(
      guard.canActivate(ctx({ id: 'u_member' }, { workspaceId: 'ws_a' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('系统空间只允许平台管理员（空间管理员也不行）', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_space_admin',
      enabled: true,
      role: { permissions: { all: false } },
    });
    await expect(
      guard.canActivate(
        ctx({ id: 'u_space_admin' }, { workspaceId: 'ws_system' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it('无租户上下文且非平台管理员 → 403', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_member',
      enabled: true,
      role: { permissions: { all: false } },
    });
    await expect(
      guard.canActivate(ctx({ id: 'u_member' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
