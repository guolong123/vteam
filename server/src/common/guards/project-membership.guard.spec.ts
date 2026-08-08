import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectMembershipGuard,
  PROJECT_MEMBERSHIP_ERRORS,
} from './project-membership.guard';
import { AUTH_ERRORS } from '../../auth/auth.constants';
import { TASK_ERRORS } from '../constants/task.constants';

describe('ProjectMembershipGuard', () => {
  let prisma: {
    projectMember: { findUnique: jest.Mock };
    task: { findUnique: jest.Mock };
  };
  let reflector: { getAllAndOverride: jest.Mock };

  const buildGuard = () =>
    new ProjectMembershipGuard(prisma as unknown as PrismaService, {
      getAllAndOverride: reflector.getAllAndOverride,
    } as unknown as Reflector);

  const buildContext = (opts: {
    user?: { id: string } | null;
    params?: Record<string, string>;
  }) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: opts.user, params: opts.params ?? {} }),
      }),
    }) as any;

  beforeEach(() => {
    prisma = {
      projectMember: { findUnique: jest.fn() },
      task: { findUnique: jest.fn() },
    };
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
  });

  it('成员：project_members 存在 (projectId, userId) 记录 → 通过', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({
      id: 'pm_1',
      projectId: 'p_1',
      userId: 'u_1',
      role: 'owner',
    });

    const guard = buildGuard();
    const ctx = buildContext({ user: { id: 'u_1' }, params: { pid: 'p_1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.projectMember.findUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'p_1', userId: 'u_1' } },
    });
  });

  it('非成员：无记录 → 403 PERMISSION_PROJECT_NOT_MEMBER', async () => {
    prisma.projectMember.findUnique.mockResolvedValue(null);

    const guard = buildGuard();
    const ctx = buildContext({ user: { id: 'u_1' }, params: { pid: 'p_1' } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    try {
      await guard.canActivate(ctx);
      fail('应抛出 ForbiddenException');
    } catch (e) {
      expect((e as ForbiddenException).getResponse()).toMatchObject({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
      });
    }
  });

  it('无 token（req.user 缺失）→ 401 AUTH_UNAUTHORIZED', async () => {
    const guard = buildGuard();
    const ctx = buildContext({ user: null, params: { pid: 'p_1' } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    try {
      await guard.canActivate(ctx);
      fail('应抛出 UnauthorizedException');
    } catch (e) {
      expect((e as UnauthorizedException).getResponse()).toMatchObject({
        code: AUTH_ERRORS.UNAUTHORIZED,
      });
    }
  });

  it('缺 pid 路由参数 → 400 PROJECT_ID_REQUIRED', async () => {
    const guard = buildGuard();
    const ctx = buildContext({ user: { id: 'u_1' }, params: {} });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    try {
      await guard.canActivate(ctx);
      fail('应抛出 BadRequestException');
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toMatchObject({
        code: PROJECT_MEMBERSHIP_ERRORS.PROJECT_ID_REQUIRED,
      });
    }
  });

  it('支持 @ProjectId() metadata（PROJECT_ID_KEY）作为 projectId 来源', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({
      id: 'pm_1',
      projectId: 'p_x',
      userId: 'u_1',
      role: 'member',
    });
    reflector.getAllAndOverride.mockReturnValue('p_x');

    const guard = buildGuard();
    const ctx = buildContext({ user: { id: 'u_1' }, params: {} });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.projectMember.findUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'p_x', userId: 'u_1' } },
    });
  });

  it('任务路由 /tasks/:id：从任务反查 projectId 并校验成员', async () => {
    prisma.task.findUnique.mockResolvedValue({ projectId: 'p_1' });
    prisma.projectMember.findUnique.mockResolvedValue({
      id: 'pm_1',
      projectId: 'p_1',
      userId: 'u_1',
      role: 'member',
    });

    const guard = buildGuard();
    const ctx = buildContext({ user: { id: 'u_1' }, params: { id: 't_1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.task.findUnique).toHaveBeenCalledWith({
      where: { id: 't_1' },
      select: { projectId: true },
    });
    expect(prisma.projectMember.findUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'p_1', userId: 'u_1' } },
    });
  });

  it('任务路由任务不存在 → 404 TASK_NOT_FOUND', async () => {
    prisma.task.findUnique.mockResolvedValue(null);

    const guard = buildGuard();
    const ctx = buildContext({ user: { id: 'u_1' }, params: { id: 't_missing' } });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    try {
      await guard.canActivate(ctx);
      fail('应抛出 NotFoundException');
    } catch (e) {
      expect((e as NotFoundException).getResponse()).toMatchObject({
        code: TASK_ERRORS.TASK_NOT_FOUND,
      });
    }
  });
});
