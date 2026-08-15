import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from '../users/admin.guard';
import { MemoriesController } from './memories.controller';
import { MemoriesService } from './memories.service';

describe('MemoriesController', () => {
  let controller: MemoriesController;
  let service: {
    findAll: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemoriesController],
      providers: [{ provide: MemoriesService, useValue: service }],
    })
      // @UseGuards(AdminGuard) 在模块 compile 时即被 Nest 实例化（非请求期）→ 必须 override
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<MemoriesController>(MemoriesController);
  });

  describe('守卫元数据（全端点 admin，Metis m6）', () => {
    it('GET /memories 挂 AdminGuard', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        MemoriesController.prototype.findAll,
      );
      expect(guards).toContain(AdminGuard);
    });

    it('DELETE /memories/:id 挂 AdminGuard', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        MemoriesController.prototype.remove,
      );
      expect(guards).toContain(AdminGuard);
    });
  });

  describe('端点路由转发', () => {
    it('GET /memories 透传查询参数到 findAll', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20 };
      service.findAll.mockResolvedValue(result);

      const out = await controller.findAll({
        level: 'task',
        taskId: 't_1',
        page: 1,
        pageSize: 20,
      });

      expect(service.findAll).toHaveBeenCalledWith({
        level: 'task',
        taskId: 't_1',
        page: 1,
        pageSize: 20,
      });
      expect(out).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('DELETE /memories/:id 转发 id 到 remove', async () => {
      service.remove.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: new Date('2026-08-15T00:00:00Z'),
      });

      const out = await controller.remove('me_0000000001');

      expect(service.remove).toHaveBeenCalledWith('me_0000000001');
      expect(out.deletedAt).toBeInstanceOf(Date);
    });

    it('service 抛 404 MEMORY_NOT_FOUND 时透传给客户端', async () => {
      service.remove.mockRejectedValue(
        new NotFoundException({ code: 'MEMORY_NOT_FOUND', message: '记忆条目不存在' }),
      );

      await expect(controller.remove('me_9999999999')).rejects.toMatchObject({
        response: { code: 'MEMORY_NOT_FOUND', message: '记忆条目不存在' },
      });
    });
  });
});

describe('MemoriesController AdminGuard（非 admin 403）', () => {
  let guard: AdminGuard;
  let prisma: {
    user: {
      findUnique: jest.Mock;
    };
  };

  function mockContext(user?: { id?: string }) {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as never;
  }

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

  it('非 admin（无 users:manage）→ 403 FORBIDDEN_ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u_member',
      enabled: true,
      role: { permissions: { tasks: { view: true } } },
    });

    await expect(guard.canActivate(mockContext({ id: 'u_member' }))).rejects.toMatchObject(
      { response: { code: 'FORBIDDEN_ADMIN' } },
    );
  });
});
