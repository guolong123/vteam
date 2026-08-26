import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionGuard } from './permission.guard';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';

function mockContext(user: { id?: string } | undefined) {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

function mockWorkerContext(workerToken: string) {
  const request = { user: undefined, workerToken };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

describe('PermissionGuard', () => {
  let guard: PermissionGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let prisma: {
    user: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
    };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue('agents.view') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: Reflector, useValue: reflector },
      ],
    }).compile();

    guard = module.get<PermissionGuard>(PermissionGuard);
  });

  it('未挂 @RequirePermission 的端点放行（防御空标记）', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(mockContext(undefined))).resolves.toBe(true);
  });

  it('request.user 缺失抛 401', async () => {
    await expect(guard.canActivate(mockContext(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('worker 通道（request.workerToken 已由 WorkerOrJwtGuard 验证）放行且不查用户', async () => {
    reflector.getAllAndOverride.mockReturnValue('skills.view');
    const context = mockWorkerContext('sk-worker-token');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
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

  it('角色 permissions.all=true（seed admin 简写）任意权限点放行', async () => {
    reflector.getAllAndOverride.mockReturnValue('projects.create');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_admin',
      enabled: true,
      role: { permissions: { all: true } },
    });
    await expect(
      guard.canActivate(mockContext({ id: 'u_admin' })),
    ).resolves.toBe(true);
  });

  it('矩阵格式 agents.view=true 放行 view', async () => {
    reflector.getAllAndOverride.mockReturnValue('agents.view');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_viewer',
      enabled: true,
      role: {
        permissions: {
          tasks: { view: true, create: false },
          agents: { view: true, create: false },
        },
      },
    });
    await expect(
      guard.canActivate(mockContext({ id: 'u_viewer' })),
    ).resolves.toBe(true);
  });

  it('矩阵格式 agents.create=false 抛 403 FORBIDDEN_PERMISSION', async () => {
    reflector.getAllAndOverride.mockReturnValue('agents.create');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_restricted',
      enabled: true,
      role: {
        permissions: {
          agents: { view: true, create: false },
        },
      },
    });
    const err = await guard
      .canActivate(mockContext({ id: 'u_restricted' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.response.code).toBe('FORBIDDEN_PERMISSION');
    expect(err.response.message).toContain('agents.create');
  });

  it('矩阵格式缺省资源（无 projects 域）projects.create 抛 403', async () => {
    reflector.getAllAndOverride.mockReturnValue('projects.create');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_restricted',
      enabled: true,
      role: {
        permissions: {
          agents: { view: true },
        },
      },
    });
    const err = await guard
      .canActivate(mockContext({ id: 'u_restricted' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.response.code).toBe('FORBIDDEN_PERMISSION');
  });

  it('角色 permissions.all=false（seed member 简写）view 放行（成员只读）', async () => {
    reflector.getAllAndOverride.mockReturnValue('workers.view');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_member',
      enabled: true,
      role: { permissions: { all: false } },
    });
    await expect(
      guard.canActivate(mockContext({ id: 'u_member' })),
    ).resolves.toBe(true);
  });

  it('角色 permissions.all=false（seed member 简写）写操作抛 403', async () => {
    reflector.getAllAndOverride.mockReturnValue('projects.create');
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_member',
      enabled: true,
      role: { permissions: { all: false } },
    });
    const err = await guard
      .canActivate(mockContext({ id: 'u_member' }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.response.code).toBe('FORBIDDEN_PERMISSION');
  });

  it('permission metadata 从 handler/class 读取（REQUIRE_PERMISSION_KEY）', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_admin',
      enabled: true,
      role: { permissions: { all: true } },
    });
    const context = mockContext({ id: 'u_admin' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
  });
});
