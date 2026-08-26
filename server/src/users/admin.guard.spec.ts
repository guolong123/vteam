import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';

function mockContext(user?: { id?: string }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as any;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let prisma: {
    user: {
      findUnique: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AdminGuard, { provide: PrismaService, useValue: prisma }],
    }).compile();

    guard = module.get<AdminGuard>(AdminGuard);
  });

  it('request.user 缺失抛 401', async () => {
    await expect(guard.canActivate(mockContext(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('用户不存在抛 401', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(mockContext({ id: 'u_x' }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('用户已禁用抛 401', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_x',
      enabled: false,
      role: { permissions: { all: true } },
    });
    await expect(guard.canActivate(mockContext({ id: 'u_x' }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('角色 permissions.all=true（seed admin 简写）放行', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_admin',
      enabled: true,
      role: { permissions: { all: true } },
    });
    await expect(
      guard.canActivate(mockContext({ id: 'u_admin' })),
    ).resolves.toBe(true);
  });

  it('矩阵格式 users.manage=true 放行', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_usr_mgr',
      enabled: true,
      role: {
        permissions: {
          users: { view: true, create: true, manage: true },
          tasks: { view: true },
        },
      },
    });
    await expect(
      guard.canActivate(mockContext({ id: 'u_usr_mgr' })),
    ).resolves.toBe(true);
  });

  it('无 users:manage 权限抛 403 FORBIDDEN_ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_member',
      enabled: true,
      role: {
        permissions: {
          all: false,
          users: { view: false, manage: false },
          tasks: { view: true },
        },
      },
    });
    const err = await guard
      .canActivate(mockContext({ id: 'u_member' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.response.code).toBe('FORBIDDEN_ADMIN');
  });
});
