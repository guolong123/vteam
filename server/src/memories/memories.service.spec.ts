import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { MemoriesService } from './memories.service';

describe('MemoriesService', () => {
  let service: MemoriesService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    memory: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    idGen = {
      nextId: jest.fn(),
      seed: jest.fn(),
    };
    prisma = {
      $transaction: jest.fn((args: Array<Promise<unknown>>) =>
        Promise.all(args),
      ),
      memory: {
        findMany: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
      ],
    }).compile();

    service = module.get<MemoriesService>(MemoriesService);
  });

  describe('onModuleInit（重启续号，对齐 me_ 前缀）', () => {
    it('库内已有 me_<数字> 最大 id 时对齐 memory 前缀序号', async () => {
      prisma.memory.findMany.mockResolvedValue([{ id: 'me_0000000042' }]);

      await service.onModuleInit();

      expect(prisma.memory.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'me_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('me', 42);
    });

    it('混入 me_builtin_* 命名 id 时仍按数字序号续号（parseInt NaN 防护）', async () => {
      prisma.memory.findMany.mockResolvedValue([
        { id: 'me_0000000001' },
        { id: 'me_builtin_sample' },
        { id: 'me_0000000010' },
      ]);

      await service.onModuleInit();

      expect(idGen.seed).toHaveBeenCalledWith('me', 10);
    });

    it('空库/无记录时跳过续号', async () => {
      prisma.memory.findMany.mockResolvedValue([]);

      await service.onModuleInit();

      expect(idGen.seed).not.toHaveBeenCalled();
    });
  });

  describe('findAll（分页 + 过滤）', () => {
    it('默认分页：deletedAt: null + createdAt desc + page/pageSize 归一', async () => {
      const rows = [{ id: 'me_0000000001', content: 'x' }];
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany.mockResolvedValue(rows);

      const out = await service.findAll({});

      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
      expect(prisma.memory.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(out).toEqual({ items: rows, total: 1, page: 1, pageSize: 20 });
    });

    it('level/taskId/projectId/keyword 过滤透传（keyword → content OR description contains）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({
        level: 'task',
        taskId: 't_1',
        projectId: 'p_1',
        keyword: '验收',
        page: 2,
        pageSize: 10,
      });

      expect(prisma.memory.findMany).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          level: 'task',
          taskId: 't_1',
          projectId: 'p_1',
          OR: [
            { content: { contains: '验收' } },
            { description: { contains: '验收' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
      });
    });

    it('description 字段透传：keyword 同时命中 content 与 description', async () => {
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany.mockResolvedValue([
        { id: 'me_1', description: 'token刷新' },
      ]);

      const out = await service.findAll({ keyword: 'token' });

      expect(out.items[0].description).toBe('token刷新');
      expect(prisma.memory.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });

    it('page/pageSize 非法值归一（page=0→1，pageSize=999→100）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({ page: 0 as never, pageSize: 999 as never });

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });
  });

  describe('remove（软删）', () => {
    it('置 deletedAt=now，返回软删后的条目', async () => {
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: null,
      });
      prisma.memory.update.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: new Date('2026-08-15T00:00:00Z'),
      });

      const out = await service.remove('me_0000000001');

      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'me_0000000001' },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(out.deletedAt).toBeInstanceOf(Date);
    });

    it('条目不存在 → 404 MEMORY_NOT_FOUND', async () => {
      prisma.memory.findUnique.mockResolvedValue(null);

      await expect(service.remove('me_9999999999')).rejects.toMatchObject({
        response: { code: 'MEMORY_NOT_FOUND', message: '记忆条目不存在' },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('已软删条目再次删除 → 404 MEMORY_NOT_FOUND', async () => {
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: new Date('2026-08-10T00:00:00Z'),
      });

      await expect(service.remove('me_0000000001')).rejects.toMatchObject({
        response: { code: 'MEMORY_NOT_FOUND' },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });
  });
});
