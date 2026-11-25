import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { PermissionGuard } from '../common/guards/permission.guard';
import { TeamMembershipGuard } from '../common/guards/team-membership.guard';

describe('TeamsController', () => {
  let controller: TeamsController;
  let service: {
    create: jest.Mock;
    findAll: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    addMember: jest.Mock;
    removeMember: jest.Mock;
    addUserMember: jest.Mock;
    removeUserMember: jest.Mock;
    updateMember: jest.Mock;
    resetSessions: jest.Mock;
    resetMemberSession: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      addMember: jest.fn(),
      removeMember: jest.fn(),
      addUserMember: jest.fn(),
      removeUserMember: jest.fn(),
      updateMember: jest.fn(),
      resetSessions: jest.fn(),
      resetMemberSession: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamsController],
      providers: [
        { provide: TeamsService, useValue: service },
        PermissionGuard,
        // 类级 @UseGuards(TeamMembershipGuard)：compile 时实例化，依赖 PrismaService
        TeamMembershipGuard,
        {
          provide: PrismaService,
          useValue: {
            user: { findUnique: jest.fn() },
            team: { findUnique: jest.fn() },
            task: { findUnique: jest.fn() },
            teamUserMember: { findUnique: jest.fn() },
          },
        },
      ],
    })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get<TeamsController>(TeamsController);
  });

  it('POST /teams 转发 userId + dto 到 create', async () => {
    service.create.mockResolvedValue({ id: 'tm_0000000001' });
    const result = await controller.create(
      { id: 'u_1' } as any,
      { name: 'alpha' } as any,
    );
    expect(service.create).toHaveBeenCalledWith('u_1', { name: 'alpha' });
    expect(result).toEqual({ id: 'tm_0000000001' });
  });

  it('GET /teams 转发 query + 调用者 userId 到 findAll（成员可见性过滤依赖它）', async () => {
    service.findAll.mockResolvedValue({ items: [], total: 0 });
    const result = await controller.findAll(
      { id: 'u_1' } as any,
      { page: 1, pageSize: 20 } as any,
    );
    expect(service.findAll).toHaveBeenCalledWith(
      { page: 1, pageSize: 20 },
      'u_1',
    );
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('GET /teams/:id 转发 id 到 findOne', async () => {
    service.findOne.mockResolvedValue({ id: 'tm_1' });
    const result = await controller.findOne('tm_1');
    expect(service.findOne).toHaveBeenCalledWith('tm_1');
    expect(result).toEqual({ id: 'tm_1' });
  });

  it('PATCH /teams/:id 转发 id + dto 到 update', async () => {
    service.update.mockResolvedValue({ id: 'tm_1', name: 'new' });
    const result = await controller.update('tm_1', { name: 'new' } as any);
    expect(service.update).toHaveBeenCalledWith('tm_1', { name: 'new' });
    expect(result).toEqual({ id: 'tm_1', name: 'new' });
  });

  it('DELETE /teams/:id 转发到 remove（默认不带 force）', async () => {
    service.remove.mockResolvedValue({ deleted: true });
    const result = await controller.remove('tm_1');
    expect(service.remove).toHaveBeenCalledWith('tm_1', { force: false });
    expect(result).toEqual({ deleted: true });
  });

  it('DELETE /teams/:id?force=true 转发 force 强制删除', async () => {
    service.remove.mockResolvedValue({ deleted: true });
    await controller.remove('tm_1', 'true');
    expect(service.remove).toHaveBeenCalledWith('tm_1', { force: true });
  });

  it('POST /teams/:id/members 转发到 addMember', async () => {
    service.addMember.mockResolvedValue({ id: 'tm_1' });
    const result = await controller.addMember(
      'tm_1',
      { agentId: 'a_1' } as any,
      { id: 'u_1', username: 'admin', roleId: 'r_admin' } as any,
    );
    expect(service.addMember).toHaveBeenCalledWith(
      'tm_1',
      { agentId: 'a_1' },
      'u_1',
    );
    expect(result).toEqual({ id: 'tm_1' });
  });

  it('DELETE /teams/:id/members/:memberId 转发到 removeMember', async () => {
    service.removeMember.mockResolvedValue({ id: 'tm_1' });
    const result = await controller.removeMember('tm_1', 'tmm_1');
    expect(service.removeMember).toHaveBeenCalledWith('tm_1', 'tmm_1');
    expect(result).toEqual({ id: 'tm_1' });
  });

  it('PATCH /teams/:id/members/:memberId 转发到 updateMember', async () => {
    service.updateMember.mockResolvedValue({ id: 'tm_1' });
    const result = await controller.updateMember('tm_1', 'tmm_1', {
      alias: 'x',
    } as any);
    expect(service.updateMember).toHaveBeenCalledWith('tm_1', 'tmm_1', {
      alias: 'x',
    });
    expect(result).toEqual({ id: 'tm_1' });
  });

  it('POST /teams/:id/reset-sessions 转发到 resetSessions', async () => {
    service.resetSessions.mockResolvedValue({ reset: 2, teamId: 'tm_1' });
    const result = await controller.resetSessions('tm_1');
    expect(service.resetSessions).toHaveBeenCalledWith('tm_1');
    expect(result).toEqual({ reset: 2, teamId: 'tm_1' });
  });

  it('Todo11：POST /teams/:id/members/:memberId/reset-session 转发到 resetMemberSession（空 body）', async () => {
    service.resetMemberSession.mockResolvedValue({
      teamId: 'tm_1',
      memberId: 'tmm_1',
      session: { id: 's_1' },
    });
    const result = await controller.resetMemberSession('tm_1', 'tmm_1');
    expect(service.resetMemberSession).toHaveBeenCalledWith('tm_1', 'tmm_1');
    expect(result).toEqual({
      teamId: 'tm_1',
      memberId: 'tmm_1',
      session: { id: 's_1' },
    });
  });

  it('POST /teams/:id/users 转发到 addUserMember', async () => {
    service.addUserMember.mockResolvedValue({ id: 'tm_1' });
    const result = await controller.addUserMember('tm_1', {
      userId: 'u_2',
    } as any);
    expect(service.addUserMember).toHaveBeenCalledWith('tm_1', {
      userId: 'u_2',
    });
    expect(result).toEqual({ id: 'tm_1' });
  });

  it('DELETE /teams/:id/users/:userId 转发到 removeUserMember', async () => {
    service.removeUserMember.mockResolvedValue({ id: 'tm_1' });
    const result = await controller.removeUserMember('tm_1', 'u_2');
    expect(service.removeUserMember).toHaveBeenCalledWith('tm_1', 'u_2');
    expect(result).toEqual({ id: 'tm_1' });
  });

  // ── M0 止血：按 :id 的团队端点补团队用户成员门 ─────────────────────────
  describe('团队归属门（TeamMembershipGuard）', () => {
    it('类级挂 TeamMembershipGuard（非团队成员 GET/PATCH/DELETE :id、加删成员一律 403）', () => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, TeamsController) ??
        []) as unknown[];
      expect(guards).toContain(TeamMembershipGuard);
    });

    it('守卫从 :id 团队反查并拒绝非成员（与共享门实现同源，:id 先按团队解释）', async () => {
      const prisma = {
        team: { findUnique: jest.fn().mockResolvedValue({ id: 'tm_1' }) },
        task: { findUnique: jest.fn() },
        teamUserMember: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      const guard = new TeamMembershipGuard(prisma as never);
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({ user: { id: 'u_out' }, params: { id: 'tm_1' } }),
        }),
      } as never;

      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({
          code: 'PERMISSION_TEAM_NOT_MEMBER',
        }),
      });
    });

    it('POST /teams（create）无 :id 参数：守卫仅要求登录，保持宽松', async () => {
      const prisma = {
        team: { findUnique: jest.fn() },
        task: { findUnique: jest.fn() },
        teamUserMember: { findUnique: jest.fn() },
      };
      const guard = new TeamMembershipGuard(prisma as never);
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({ user: { id: 'u_1' }, params: {} }),
        }),
      } as never;

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(prisma.team.findUnique).not.toHaveBeenCalled();
      expect(prisma.teamUserMember.findUnique).not.toHaveBeenCalled();
    });
  });
});
