import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from '../users/admin.guard';
import { QueryMemoriesDto } from './dto/query-memories.dto';
import { MemoryMaintenanceService } from './memory-maintenance.service';
import { MemoriesController } from './memories.controller';
import { MemoriesService } from './memories.service';

describe('MemoriesController', () => {
  let controller: MemoriesController;
  let service: {
    findAll: jest.Mock;
    remove: jest.Mock;
    update: jest.Mock;
    restore: jest.Mock;
    purge: jest.Mock;
  };
  let maintenance: { runOnce: jest.Mock };
  let prisma: { team: { findUnique: jest.Mock } };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
      restore: jest.fn(),
      purge: jest.fn(),
    };
    maintenance = { runOnce: jest.fn() };
    prisma = { team: { findUnique: jest.fn().mockResolvedValue({ id: 'tm_1' }) } };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MemoriesController],
      providers: [
        { provide: MemoriesService, useValue: service },
        { provide: MemoryMaintenanceService, useValue: maintenance },
        { provide: PrismaService, useValue: prisma },
      ],
    })
      // @UseGuards(AdminGuard) 在模块 compile 时即被 Nest 实例化（非请求期）→ 必须 override
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<MemoriesController>(MemoriesController);
  });

  describe('守卫元数据（memory-enhancement Todo 2：权限下沉 service）', () => {
    it('GET /memories 不再挂 AdminGuard（成员感知过滤下沉 service）', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        MemoriesController.prototype.findAll,
      );
      expect(guards ?? []).not.toContain(AdminGuard);
    });

    it('DELETE /memories/:id 不再挂 AdminGuard（per-row 鉴权在 service）', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        MemoriesController.prototype.remove,
      );
      expect(guards ?? []).not.toContain(AdminGuard);
    });

    it('POST /memories/:id/restore 与 /purge 不挂 AdminGuard（per-row 鉴权在 service）', () => {
      expect(
        Reflect.getMetadata(
          '__guards__',
          MemoriesController.prototype.restore,
        ) ?? [],
      ).not.toContain(AdminGuard);
      expect(
        Reflect.getMetadata('__guards__', MemoriesController.prototype.purge) ??
          [],
      ).not.toContain(AdminGuard);
    });

    it('PATCH /memories/:id 保留 AdminGuard（编辑权限不放开）', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        MemoriesController.prototype.update,
      );
      expect(guards).toContain(AdminGuard);
    });

    it('POST /memories/maintain 保留 AdminGuard（跨团队全局动作，仅管理员）', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        MemoriesController.prototype.maintain,
      );
      expect(guards).toContain(AdminGuard);
    });
  });

  describe('端点路由转发', () => {
    it('GET /memories 透传查询参数与调用方到 findAll', async () => {
      const result = { items: [], total: 0, page: 1, pageSize: 20 };
      service.findAll.mockResolvedValue(result);

      const out = await controller.findAll(
        {
          level: 'team',
          teamId: 'tm_1',
          page: 1,
          pageSize: 20,
        },
        { user: { id: 'u_member' } } as never,
      );

      expect(service.findAll).toHaveBeenCalledWith(
        {
          level: 'team',
          teamId: 'tm_1',
          page: 1,
          pageSize: 20,
        },
        { id: 'u_member' },
      );
      expect(out).toMatchObject({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('GET /memories 无 req.user 时传 undefined viewer（service 内 fail closed）', async () => {
      service.findAll.mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });

      await controller.findAll({}, {} as never);

      expect(service.findAll).toHaveBeenCalledWith({}, undefined);
    });

    it('POST /memories/maintain 透传单轮摘要 {teams, candidates}', async () => {
      const summary = {
        teams: 2,
        candidates: { duplicates: 3, unused: 1, untags: 4 },
      };
      maintenance.runOnce.mockResolvedValue(summary);

      await expect(controller.maintain()).resolves.toEqual(summary);
      expect(maintenance.runOnce).toHaveBeenCalledTimes(1);
    });

    it('POST /memories/maintain 带 teamId → 只整理该团队（点谁整理谁）', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_9' });
      const summary = {
        teams: 1,
        candidates: { duplicates: 0, unused: 0, untags: 5 },
      };
      maintenance.runOnce.mockResolvedValue(summary);

      await expect(controller.maintain({ teamId: 'tm_9' })).resolves.toEqual(
        summary,
      );
      expect(prisma.team.findUnique).toHaveBeenCalledWith({
        where: { id: 'tm_9' },
        select: { id: true },
      });
      expect(maintenance.runOnce).toHaveBeenCalledWith('tm_9');
    });

    it('POST /memories/maintain 无 body / 空 body → 全局一轮（runOnce 零参）', async () => {
      await controller.maintain();
      expect(maintenance.runOnce).toHaveBeenCalledWith();
      expect(prisma.team.findUnique).not.toHaveBeenCalled();

      maintenance.runOnce.mockClear();
      await controller.maintain({});
      expect(maintenance.runOnce).toHaveBeenCalledWith();
    });

    it('POST /memories/maintain 未知 teamId → 404 TEAM_NOT_FOUND 且不整理', async () => {
      prisma.team.findUnique.mockResolvedValue(null);

      await expect(controller.maintain({ teamId: 'tm_nope' })).rejects.toMatchObject(
        { response: { code: 'TEAM_NOT_FOUND' } },
      );
      expect(maintenance.runOnce).not.toHaveBeenCalled();
    });

    it('GET /memories 的 autoInject 查询串按字面量解析（"false" ≠ true，2026-09-30）', () => {
      // 回归防护：@Type(() => Boolean) 会把 query 串 "false" 变成 true，导致
      // 「仅看按需检索的记忆」反向筛出自动注入的记忆。改用 @Transform 字面量解析
      // （对齐 QueryModelsDto.enabled 的既有写法）。
      const parse = (raw: string) =>
        plainToInstance(
          QueryMemoriesDto,
          Object.fromEntries(new URLSearchParams(raw)),
        ).autoInject;

      expect(parse('autoInject=true')).toBe(true);
      expect(parse('autoInject=false')).toBe(false);
      expect(parse('autoInject=')).toBeUndefined();
      expect(parse('')).toBeUndefined();
    });

    it('GET /memories 的 archived 查询串按字面量解析三态（缺省=活跃）', () => {
      const parse = (raw: string) =>
        plainToInstance(
          QueryMemoriesDto,
          Object.fromEntries(new URLSearchParams(raw)),
        ).archived;

      expect(parse('archived=true')).toBe(true);
      expect(parse('archived=false')).toBe(false);
      expect(parse('archived=')).toBeUndefined();
      expect(parse('')).toBeUndefined();
    });

    it('DELETE /memories/:id 转发 id/viewer 到 remove（per-row 鉴权下沉 service）', async () => {
      service.remove.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: new Date('2026-08-15T00:00:00Z'),
      });
      const req = { user: { id: 'u_member' } };

      const out = await controller.remove('me_0000000001', req as never);

      expect(service.remove).toHaveBeenCalledWith('me_0000000001', {
        id: 'u_member',
      });
      expect(out.deletedAt).toBeInstanceOf(Date);
    });

    it('POST /memories/:id/restore 转发 id/viewer 到 restore', async () => {
      service.restore.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: null,
      });

      const out = await controller.restore('me_0000000001', {
        user: { id: 'u_member' },
      } as never);

      expect(service.restore).toHaveBeenCalledWith('me_0000000001', {
        id: 'u_member',
      });
      expect(out.deletedAt).toBeNull();
    });

    it('POST /memories/:id/purge 转发 id/viewer 到 purge', async () => {
      service.purge.mockResolvedValue({ id: 'me_0000000001' });

      const out = await controller.purge('me_0000000001', {
        user: { id: 'u_admin' },
      } as never);

      expect(service.purge).toHaveBeenCalledWith('me_0000000001', {
        id: 'u_admin',
      });
      expect(out).toEqual({ id: 'me_0000000001' });
    });

    it('PATCH /memories/:id 转发 id/dto/ viewer 到 update（团队归属下沉 service）', async () => {
      service.update.mockResolvedValue({
        id: 'me_0000000001',
        content: '新经验',
      });
      const req = { user: { id: 'u_admin' } };

      const out = await controller.update(
        'me_0000000001',
        { content: '新经验' },
        req as never,
      );

      expect(service.update).toHaveBeenCalledWith(
        'me_0000000001',
        { content: '新经验' },
        { id: 'u_admin' },
      );
      expect(out).toMatchObject({ id: 'me_0000000001' });
    });

    it('service 抛 404 MEMORY_NOT_FOUND 时透传给客户端', async () => {
      service.remove.mockRejectedValue(
        new NotFoundException({
          code: 'MEMORY_NOT_FOUND',
          message: '记忆条目不存在',
        }),
      );

      await expect(
        controller.remove('me_9999999999', { user: { id: 'u_1' } } as never),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_NOT_FOUND', message: '记忆条目不存在' },
      });
    });

    it('service 抛 403 MEMORY_FORBIDDEN（成员操作 global 行）时透传给客户端', async () => {
      service.purge.mockRejectedValue(
        Object.assign(new Error('Forbidden'), {
          status: 403,
          response: {
            code: 'MEMORY_FORBIDDEN',
            message: '全局记忆仅平台管理员可操作',
          },
        }),
      );

      await expect(
        controller.purge('me_1', { user: { id: 'u_member' } } as never),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_FORBIDDEN' },
      });
    });

    it('service 抛 409 MEMORY_RESTORE_DUPLICATE（撞活跃同 hash）时透传给客户端', async () => {
      service.restore.mockRejectedValue(
        Object.assign(new Error('Conflict'), {
          status: 409,
          response: {
            code: 'MEMORY_RESTORE_DUPLICATE',
            message: '同内容记忆已处于活跃状态，请先删除重复条目',
          },
        }),
      );

      await expect(
        controller.restore('me_1', { user: { id: 'u_member' } } as never),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_RESTORE_DUPLICATE' },
      });
    });
  });
});

describe('MemoriesController AdminGuard（PATCH 编辑仍 admin-only）', () => {
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

    await expect(
      guard.canActivate(mockContext({ id: 'u_member' })),
    ).rejects.toMatchObject({ response: { code: 'FORBIDDEN_ADMIN' } });
  });
});
