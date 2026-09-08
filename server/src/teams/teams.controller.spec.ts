import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { PermissionGuard } from '../common/guards/permission.guard';

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
    cancelQueue: jest.Mock;
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
      cancelQueue: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TeamsController],
      providers: [
        { provide: TeamsService, useValue: service },
        PermissionGuard,
        {
          provide: PrismaService,
          useValue: {
            user: { findUnique: jest.fn() },
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

  it('GET /teams 转发 query 到 findAll', async () => {
    service.findAll.mockResolvedValue({ items: [], total: 0 });
    const result = await controller.findAll({ page: 1, pageSize: 20 } as any);
    expect(service.findAll).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
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

  it('DELETE /teams/:id 转发到 remove', async () => {
    service.remove.mockResolvedValue({ deleted: true });
    const result = await controller.remove('tm_1');
    expect(service.remove).toHaveBeenCalledWith('tm_1');
    expect(result).toEqual({ deleted: true });
  });

  it('POST /teams/:id/members 转发到 addMember', async () => {
    service.addMember.mockResolvedValue({ id: 'tm_1' });
    const result = await controller.addMember('tm_1', {
      agentId: 'a_1',
    } as any);
    expect(service.addMember).toHaveBeenCalledWith('tm_1', { agentId: 'a_1' });
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

  it('DELETE /teams/:id/queue/:taskId 转发到 cancelQueue', async () => {
    service.cancelQueue.mockResolvedValue({ id: 'tm_1' });
    const result = await controller.cancelQueue('tm_1', 't_1');
    expect(service.cancelQueue).toHaveBeenCalledWith('tm_1', 't_1');
    expect(result).toEqual({ id: 'tm_1' });
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
});
