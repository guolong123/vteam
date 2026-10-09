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
      findFirst: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    teamUserMember: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    user: {
      findUnique: jest.Mock;
    };
  };

  /** 平台管理员用户行（permissions.all 简写，AdminGuard 口径）。 */
  const adminUser = {
    id: 'u_admin',
    enabled: true,
    role: { permissions: { all: true } },
  };
  /** 普通成员用户行（无 users:manage）。 */
  const memberUser = {
    id: 'u_member',
    enabled: true,
    role: { permissions: { tasks: { view: true } } },
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
        findFirst: jest.fn(),
        count: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      teamUserMember: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
    };
    // 默认：调用者为平台管理员 + 团队过滤不生效（各用例按需覆盖）
    prisma.user.findUnique.mockResolvedValue(adminUser);
    prisma.teamUserMember.findMany.mockResolvedValue([]);

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

  describe('findAll（分页 + 过滤；管理员全量）', () => {
    it('默认分页：deletedAt: null + createdAt desc + page/pageSize 归一', async () => {
      const rows = [{ id: 'me_0000000001', content: 'x' }];
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany.mockResolvedValue(rows);

      const out = await service.findAll({}, { id: 'u_admin' });

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

    it('level/teamId/keyword 过滤透传（keyword → content OR description contains）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll(
        {
          level: 'team',
          teamId: 'tm_1',
          keyword: '验收',
          page: 2,
          pageSize: 10,
        },
        { id: 'u_admin' },
      );

      expect(prisma.memory.findMany).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          level: 'team',
          teamId: 'tm_1',
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

    it('level=task → 400 MEMORY_LEVEL_INVALID（任务级记忆已删除，不触达 Prisma）', async () => {
      await expect(
        service.findAll({ level: 'task', teamId: 'tm_1' }),
      ).rejects.toMatchObject({
        response: {
          code: 'MEMORY_LEVEL_INVALID',
        },
      });
      expect(prisma.memory.count).not.toHaveBeenCalled();
      expect(prisma.memory.findMany).not.toHaveBeenCalled();
    });

    it('非法 level → 400 MEMORY_LEVEL_INVALID（不触达 Prisma）', async () => {
      await expect(service.findAll({ level: 'bogus' })).rejects.toMatchObject({
        response: {
          code: 'MEMORY_LEVEL_INVALID',
        },
      });
      expect(prisma.memory.findMany).not.toHaveBeenCalled();
    });

    it('level=role 放行（2026-09-30 角色级记忆）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({ level: 'role', roleId: 'ar_1' }, { id: 'u_admin' });

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ level: 'role', roleId: 'ar_1' }),
        }),
      );
    });

    it('autoInject=false 显式下推为 where 条件（不被当成 falsy 丢弃）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({ autoInject: false }, { id: 'u_admin' });

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ autoInject: false }),
        }),
      );
    });

    it('autoInject 缺省时不进 where（不筛，三档全返回）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({}, { id: 'u_admin' });

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null },
        }),
      );
    });

    it('GET /memories?teamId= 团队级过滤可用（teamId 精确匹配）', async () => {
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany.mockResolvedValue([{ id: 'me_1', level: 'team' }]);

      const out = await service.findAll(
        { level: 'team', teamId: 'tm_1' },
        { id: 'u_admin' },
      );

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ level: 'team', teamId: 'tm_1' }),
        }),
      );
      expect(out).toEqual({
        items: [{ id: 'me_1', level: 'team' }],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });

    it('description 字段透传：keyword 同时命中 content 与 description', async () => {
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany.mockResolvedValue([
        { id: 'me_1', description: 'token刷新' },
      ]);

      const out = await service.findAll({ keyword: 'token' }, { id: 'u_admin' });

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

      await service.findAll(
        { page: 0 as never, pageSize: 999 as never },
        { id: 'u_admin' },
      );

      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });
  });

  describe('findAll（成员感知过滤：非 admin 仅见 global ∪ 自己团队）', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
    });

    it('非 admin：where 强制 AND global ∪ teamId in 我的团队（安全红线）', async () => {
      prisma.teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_mine' },
        { teamId: 'tm_mine2' },
      ]);
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({}, { id: 'u_member' });

      expect(prisma.teamUserMember.findMany).toHaveBeenCalledWith({
        where: { userId: 'u_member' },
        select: { teamId: true },
      });
      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          AND: [
            {
              OR: [
                { level: 'global' },
                { teamId: { in: ['tm_mine', 'tm_mine2'] } },
              ],
            },
          ],
        },
      });
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ AND: expect.any(Array) }),
        }),
      );
    });

    it('非 admin：跨团队行不可见（响应 items 仅 global 或自己团队）', async () => {
      prisma.teamUserMember.findMany.mockResolvedValue([{ teamId: 'tm_mine' }]);
      // 模拟 DB 侧过滤后的返回（Prisma 已按 where 收窄）
      prisma.memory.count.mockResolvedValue(2);
      prisma.memory.findMany.mockResolvedValue([
        { id: 'me_global', level: 'global', teamId: null },
        { id: 'me_mine', level: 'team', teamId: 'tm_mine' },
      ]);

      const out = await service.findAll({}, { id: 'u_member' });

      for (const item of out.items) {
        expect(
          item.level === 'global' || item.teamId === 'tm_mine',
        ).toBeTruthy();
      }
    });

    it('非 admin + keyword：成员过滤走 AND 不覆盖 keyword 的 OR（两条件并存）', async () => {
      prisma.teamUserMember.findMany.mockResolvedValue([{ teamId: 'tm_mine' }]);
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({ keyword: '验收' }, { id: 'u_member' });

      const where = prisma.memory.count.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { content: { contains: '验收' } },
        { description: { contains: '验收' } },
      ]);
      expect(where.AND).toEqual([
        { OR: [{ level: 'global' }, { teamId: { in: ['tm_mine'] } }] },
      ]);
    });

    it('非 admin：不属于任何团队 → teamId in [] 只剩 global 行', async () => {
      prisma.teamUserMember.findMany.mockResolvedValue([]);
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({}, { id: 'u_orphan' });

      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          AND: [{ OR: [{ level: 'global' }, { teamId: { in: [] } }] }],
        },
      });
    });

    it('无 viewer（未认证直入 service）→ fail closed 仅 global，不查成员表', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({});

      expect(prisma.teamUserMember.findMany).not.toHaveBeenCalled();
      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          AND: [{ OR: [{ level: 'global' }, { teamId: { in: [] } }] }],
        },
      });
    });

    it('非 admin + level=global：成员过滤仍叠加（不因显式 level 而放行）', async () => {
      prisma.teamUserMember.findMany.mockResolvedValue([{ teamId: 'tm_mine' }]);
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({ level: 'global' }, { id: 'u_member' });

      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: {
          deletedAt: null,
          level: 'global',
          AND: [
            {
              OR: [{ level: 'global' }, { teamId: { in: ['tm_mine'] } }],
            },
          ],
        },
      });
    });

    it('非 admin + level=task → 400 MEMORY_LEVEL_INVALID（不触达 Prisma，校验优先于鉴权）', async () => {
      await expect(
        service.findAll({ level: 'task' }, { id: 'u_member' }),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_LEVEL_INVALID' },
      });
      expect(prisma.memory.count).not.toHaveBeenCalled();
      expect(prisma.teamUserMember.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findAll（archived 三态过滤，归档复用 deletedAt）', () => {
    it('管理员 archived=true → deletedAt not null（只看已归档）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({ archived: true }, { id: 'u_admin' });

      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: { deletedAt: { not: null } },
      });
    });

    it('管理员 archived=false → deletedAt null（只看活跃）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({ archived: false }, { id: 'u_admin' });

      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
    });

    it('管理员 archived 缺省 → deletedAt null（默认活跃）', async () => {
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({}, { id: 'u_admin' });

      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
    });

    it('非 admin archived=true → 已归档且团队可见性同时收窄', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.teamUserMember.findMany.mockResolvedValue([{ teamId: 'tm_mine' }]);
      prisma.memory.count.mockResolvedValue(0);
      prisma.memory.findMany.mockResolvedValue([]);

      await service.findAll({ archived: true }, { id: 'u_member' });

      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: {
          deletedAt: { not: null },
          AND: [
            {
              OR: [{ level: 'global' }, { teamId: { in: ['tm_mine'] } }],
            },
          ],
        },
      });
    });
  });

  describe('remove（归档软删，per-row 鉴权）', () => {
    it('置 deletedAt=now，返回软删后的条目', async () => {
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_0000000001',
        teamId: 'tm_1',
        deletedAt: null,
      });
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.update.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: new Date('2026-08-15T00:00:00Z'),
      });

      const out = await service.remove('me_0000000001', { id: 'u_1' });

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
        teamId: 'tm_1',
        deletedAt: new Date('2026-08-10T00:00:00Z'),
      });

      await expect(
        service.remove('me_0000000001', { id: 'u_1' }),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_NOT_FOUND' },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('team 级行非成员 → 403 MEMORY_FORBIDDEN（不删除，per-row 鉴权）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_0000000001',
        teamId: 'tm_1',
        deletedAt: null,
      });
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.remove('me_0000000001', { id: 'u_stranger' }),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_FORBIDDEN' },
      });
      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'tm_1', userId: 'u_stranger' } },
        select: { id: true },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('成员归档本团队行成功（非 admin 也可，团队成员即可）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_0000000001',
        teamId: 'tm_1',
        deletedAt: null,
      });
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.update.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: new Date('2026-08-15T00:00:00Z'),
      });

      const out = await service.remove('me_0000000001', { id: 'u_member' });

      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'me_0000000001' },
          data: { deletedAt: expect.any(Date) },
        }),
      );
      expect(out.deletedAt).toBeInstanceOf(Date);
    });

    it('成员归档 global 行 → 403 MEMORY_FORBIDDEN（不查成员表，只判管理员）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_global',
        teamId: null,
        deletedAt: null,
      });

      await expect(
        service.remove('me_global', { id: 'u_member' }),
      ).rejects.toMatchObject({
        response: {
          code: 'MEMORY_FORBIDDEN',
          message: '全局记忆仅平台管理员可操作',
        },
      });
      expect(prisma.teamUserMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('无 viewer 归档 global 行 → 403 MEMORY_FORBIDDEN（fail closed）', async () => {
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_global',
        teamId: null,
        deletedAt: null,
      });

      await expect(service.remove('me_global')).rejects.toMatchObject({
        response: { code: 'MEMORY_FORBIDDEN' },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('管理员归档 global 行成功（AdminGuard 移除后由 service 兜底管理员门）', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_global',
        teamId: null,
        deletedAt: null,
      });
      prisma.memory.update.mockResolvedValue({
        id: 'me_global',
        deletedAt: new Date('2026-08-15T00:00:00Z'),
      });

      await service.remove('me_global', { id: 'u_admin' });

      expect(prisma.teamUserMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'me_global' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('成员操作他人团队行 → 403 MEMORY_FORBIDDEN（跨团队不可写）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_other',
        teamId: 'tm_other',
        deletedAt: null,
      });
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.remove('me_other', { id: 'u_member' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_FORBIDDEN' } });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('team 级行成员可删：软删落库', async () => {
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_0000000001',
        teamId: 'tm_1',
        deletedAt: null,
      });
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.update.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: new Date('2026-08-15T00:00:00Z'),
      });

      const out = await service.remove('me_0000000001', { id: 'u_1' });

      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'me_0000000001' },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(out.deletedAt).toBeInstanceOf(Date);
    });

    it('global 级行（teamId 为空）不查成员表，管理员直接软删', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_0000000001',
        teamId: null,
        deletedAt: null,
      });
      prisma.memory.update.mockResolvedValue({
        id: 'me_0000000001',
        deletedAt: new Date('2026-08-15T00:00:00Z'),
      });

      await service.remove('me_0000000001', { id: 'u_admin' });

      expect(prisma.teamUserMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.memory.update).toHaveBeenCalled();
    });
  });

  describe('restore（恢复归档行 + 撞活跃重复 409）', () => {
    const archivedRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'me_0000000001',
      level: 'team',
      teamId: 'tm_1',
      roleId: null,
      contentHash: 'hash-abc',
      deletedAt: new Date('2026-08-10T00:00:00Z'),
      ...overrides,
    });

    it('已归档行 → 清除 deletedAt 回到活跃列表', async () => {
      prisma.memory.findUnique.mockResolvedValue(archivedRow());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.findFirst.mockResolvedValue(null);
      prisma.memory.update.mockResolvedValue(
        archivedRow({ deletedAt: null }),
      );

      const out = await service.restore('me_0000000001', { id: 'u_member' });

      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
        data: { deletedAt: null },
      });
      expect(out.deletedAt).toBeNull();
    });

    it('条目不存在 → 404 MEMORY_NOT_FOUND', async () => {
      prisma.memory.findUnique.mockResolvedValue(null);

      await expect(
        service.restore('me_missing', { id: 'u_member' }),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_NOT_FOUND' },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('本就活跃的行 → 404 MEMORY_NOT_FOUND（不重复恢复）', async () => {
      prisma.memory.findUnique.mockResolvedValue(archivedRow({ deletedAt: null }));

      await expect(
        service.restore('me_0000000001', { id: 'u_member' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_NOT_FOUND' } });
      expect(prisma.memory.update).not.toHaveBeenCalled();
      expect(prisma.memory.findFirst).not.toHaveBeenCalled();
    });

    it('撞同 scope 活跃同 hash 行 → 409 MEMORY_RESTORE_DUPLICATE', async () => {
      prisma.memory.findUnique.mockResolvedValue(archivedRow());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.findFirst.mockResolvedValue({ id: 'me_dup' });

      await expect(
        service.restore('me_0000000001', { id: 'u_member' }),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_RESTORE_DUPLICATE' },
      });
      // 查重条件抄 findDuplicateMemory：同 level/teamId/roleId/contentHash、deletedAt null、id 不同
      expect(prisma.memory.findFirst).toHaveBeenCalledWith({
        where: {
          id: { not: 'me_0000000001' },
          deletedAt: null,
          level: 'team',
          teamId: 'tm_1',
          roleId: null,
          contentHash: 'hash-abc',
        },
        select: { id: true },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('存量行 contentHash 为 null → 跳过查重直接恢复（避免误报 409）', async () => {
      prisma.memory.findUnique.mockResolvedValue(
        archivedRow({ contentHash: null }),
      );
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.update.mockResolvedValue(archivedRow({ deletedAt: null }));

      await service.restore('me_0000000001', { id: 'u_member' });

      expect(prisma.memory.findFirst).not.toHaveBeenCalled();
      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
        data: { deletedAt: null },
      });
    });

    it('role 级行查重带 roleId（不与同团队其他岗位行混淆）', async () => {
      prisma.memory.findUnique.mockResolvedValue(
        archivedRow({ level: 'role', roleId: 'ar_1' }),
      );
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.findFirst.mockResolvedValue(null);
      prisma.memory.update.mockResolvedValue({ id: 'me_0000000001' });

      await service.restore('me_0000000001', { id: 'u_member' });

      expect(prisma.memory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ level: 'role', roleId: 'ar_1' }),
        }),
      );
    });

    it('成员恢复本团队行成功（非 admin 也可）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue(archivedRow());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.findFirst.mockResolvedValue(null);
      prisma.memory.update.mockResolvedValue(archivedRow({ deletedAt: null }));

      const out = await service.restore('me_0000000001', { id: 'u_member' });

      expect(out.deletedAt).toBeNull();
    });

    it('归档→恢复闭环：恢复后重新命中活跃列表查询（archived 缺省）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.teamUserMember.findUnique.mockResolvedValue([{ teamId: 'tm_1' }]);
      prisma.teamUserMember.findUnique.mockResolvedValueOnce({
        id: 'tum_1',
      });
      prisma.memory.findUnique.mockResolvedValue(archivedRow());
      prisma.memory.findFirst.mockResolvedValue(null);
      prisma.memory.update.mockResolvedValue(archivedRow({ deletedAt: null }));
      prisma.memory.count.mockResolvedValue(1);
      prisma.memory.findMany.mockResolvedValue([
        { id: 'me_0000000001', level: 'team', teamId: 'tm_1', deletedAt: null },
      ]);

      await service.restore('me_0000000001', { id: 'u_member' });
      const active = await service.findAll({}, { id: 'u_member' });

      expect(active.items).toHaveLength(1);
      expect(prisma.memory.count).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
      );
    });

    it('成员恢复 global 行 → 403 MEMORY_FORBIDDEN（鉴权先于查重）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue(
        archivedRow({ level: 'global', teamId: null }),
      );

      await expect(
        service.restore('me_global', { id: 'u_member' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_FORBIDDEN' } });
      expect(prisma.memory.findFirst).not.toHaveBeenCalled();
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('管理员恢复 global 行成功', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      prisma.memory.findUnique.mockResolvedValue(
        archivedRow({ level: 'global', teamId: null }),
      );
      prisma.memory.findFirst.mockResolvedValue(null);
      prisma.memory.update.mockResolvedValue({ id: 'me_global' });

      await service.restore('me_global', { id: 'u_admin' });

      expect(prisma.teamUserMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.memory.update).toHaveBeenCalled();
    });

    it('成员恢复他人团队行 → 403 MEMORY_FORBIDDEN（跨团队不可写）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue(
        archivedRow({ teamId: 'tm_other' }),
      );
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.restore('me_other', { id: 'u_member' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_FORBIDDEN' } });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('已合并行（mergedIntoId 非空）→ 409 MEMORY_RESTORE_MERGED，deletedAt 不动', async () => {
      prisma.memory.findUnique.mockResolvedValue(
        archivedRow({ mergedIntoId: 'me_target' }),
      );
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });

      await expect(
        service.restore('me_0000000001', { id: 'u_member' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'MEMORY_RESTORE_MERGED' },
      });
      // 不许写库：refCount 已在合并时转移给目标行，恢复会让它二次参与排序/注入
      expect(prisma.memory.update).not.toHaveBeenCalled();
      expect(prisma.memory.findFirst).not.toHaveBeenCalled();
    });

    it('已合并的 global 行同样拒绝恢复（管理员也不例外）', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      prisma.memory.findUnique.mockResolvedValue(
        archivedRow({
          level: 'global',
          teamId: null,
          mergedIntoId: 'me_target',
        }),
      );

      await expect(
        service.restore('me_global', { id: 'u_admin' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_RESTORE_MERGED' } });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });
  });

  describe('purge（硬删，per-row 鉴权）', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: 'me_0000000001',
      level: 'team',
      teamId: 'tm_1',
      deletedAt: null,
      ...overrides,
    });

    it('真硬删：prisma.memory.delete 落库（不再是软删）', async () => {
      prisma.memory.findUnique.mockResolvedValue(row());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.delete.mockResolvedValue({ id: 'me_0000000001' });

      const out = await service.purge('me_0000000001', { id: 'u_member' });

      expect(prisma.memory.delete).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
      expect(out).toEqual({ id: 'me_0000000001' });
    });

    it('行已归档也可硬删（已归档视图的「永久删除」）', async () => {
      prisma.memory.findUnique.mockResolvedValue(
        row({ deletedAt: new Date('2026-08-10T00:00:00Z') }),
      );
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.delete.mockResolvedValue({ id: 'me_0000000001' });

      await service.purge('me_0000000001', { id: 'u_member' });

      expect(prisma.memory.delete).toHaveBeenCalled();
    });

    it('已合并的归档行仍可硬删（误合并的唯一清理出口）', async () => {
      prisma.memory.findUnique.mockResolvedValue(
        row({
          deletedAt: new Date('2026-08-10T00:00:00Z'),
          mergedIntoId: 'me_target',
        }),
      );
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.delete.mockResolvedValue({ id: 'me_0000000001' });

      await service.purge('me_0000000001', { id: 'u_member' });

      expect(prisma.memory.delete).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
      });
    });

    it('条目不存在 → 404 MEMORY_NOT_FOUND（不删）', async () => {
      prisma.memory.findUnique.mockResolvedValue(null);

      await expect(
        service.purge('me_missing', { id: 'u_member' }),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_NOT_FOUND' },
      });
      expect(prisma.memory.delete).not.toHaveBeenCalled();
    });

    it('成员硬删 global 行 → 403 MEMORY_FORBIDDEN', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue(
        row({ level: 'global', teamId: null }),
      );

      await expect(
        service.purge('me_global', { id: 'u_member' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_FORBIDDEN' } });
      expect(prisma.memory.delete).not.toHaveBeenCalled();
    });

    it('成员硬删他人团队行 → 403 MEMORY_FORBIDDEN（跨团队不可写）', async () => {
      prisma.user.findUnique.mockResolvedValue(memberUser);
      prisma.memory.findUnique.mockResolvedValue(row({ teamId: 'tm_other' }));
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.purge('me_other', { id: 'u_member' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_FORBIDDEN' } });
      expect(prisma.memory.delete).not.toHaveBeenCalled();
    });

    it('管理员硬删 global 行成功', async () => {
      prisma.user.findUnique.mockResolvedValue(adminUser);
      prisma.memory.findUnique.mockResolvedValue(
        row({ level: 'global', teamId: null }),
      );
      prisma.memory.delete.mockResolvedValue({ id: 'me_global' });

      await service.purge('me_global', { id: 'u_admin' });

      expect(prisma.memory.delete).toHaveBeenCalledWith({
        where: { id: 'me_global' },
      });
    });
  });

  describe('update（PATCH 部分更新 + 团队归属）', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: 'me_0000000001',
      level: 'team',
      teamId: 'tm_1',
      content: '旧经验',
      description: '旧摘要',
      tags: null,
      deletedAt: null,
      ...overrides,
    });

    it('条目不存在 → 404 MEMORY_NOT_FOUND（不更新）', async () => {
      prisma.memory.findUnique.mockResolvedValue(null);

      await expect(
        service.update('me_missing', { content: 'x' }, { id: 'u_1' }),
      ).rejects.toMatchObject({
        response: { code: 'MEMORY_NOT_FOUND', message: '记忆条目不存在' },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('已软删条目 → 404 MEMORY_NOT_FOUND（不更新）', async () => {
      prisma.memory.findUnique.mockResolvedValue(
        row({ deletedAt: new Date('2026-08-10T00:00:00Z') }),
      );

      await expect(
        service.update('me_0000000001', { content: 'x' }, { id: 'u_1' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_NOT_FOUND' } });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('全空 → 400 MEMORY_UPDATE_EMPTY（不更新）', async () => {
      prisma.memory.findUnique.mockResolvedValue(row());

      await expect(
        service.update('me_0000000001', {}, { id: 'u_1' }),
      ).rejects.toMatchObject({ response: { code: 'MEMORY_UPDATE_EMPTY' } });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('仅切 autoInject 即为有效更新（记忆页行内开关，2026-09-30）', async () => {
      prisma.memory.findUnique.mockResolvedValue(row());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.update.mockResolvedValue(row({ autoInject: true }));

      await service.update(
        'me_0000000001',
        { autoInject: true },
        { id: 'u_1' },
      );

      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
        data: { autoInject: true },
      });
    });

    it('autoInject=false 也能落库（不被当成未提供而 400）', async () => {
      prisma.memory.findUnique.mockResolvedValue(row());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.update.mockResolvedValue(row({ autoInject: false }));

      await service.update(
        'me_0000000001',
        { autoInject: false },
        { id: 'u_1' },
      );

      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
        data: { autoInject: false },
      });
    });

    it('role 级行同样要求团队成员（非成员 → 403）', async () => {
      prisma.memory.findUnique.mockResolvedValue(
        row({ level: 'role', roleId: 'ar_1' }),
      );
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.update('me_0000000001', { autoInject: true }, { id: 'u_x' }),
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_TEAM_NOT_MEMBER' },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('team 级行非成员 → 403 PERMISSION_TEAM_NOT_MEMBER（不更新）', async () => {
      prisma.memory.findUnique.mockResolvedValue(row());
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.update('me_0000000001', { content: 'x' }, { id: 'u_stranger' }),
      ).rejects.toMatchObject({
        response: { code: 'PERMISSION_TEAM_NOT_MEMBER' },
      });
      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'tm_1', userId: 'u_stranger' } },
        select: { id: true },
      });
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('成员更新 content：同步重算 contentHash（sha256 hex）', async () => {
      prisma.memory.findUnique.mockResolvedValue(row());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.update.mockResolvedValue({
        id: 'me_0000000001',
        content: '新经验',
      });

      const out = await service.update(
        'me_0000000001',
        { content: '新经验' },
        { id: 'u_1' },
      );

      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
        data: expect.objectContaining({
          content: '新经验',
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      });
      expect(out).toMatchObject({ id: 'me_0000000001' });
    });

    it('成员部分更新 tags：仅透传 tags，不碰 contentHash', async () => {
      prisma.memory.findUnique.mockResolvedValue(row());
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.memory.update.mockResolvedValue({ id: 'me_0000000001' });

      await service.update('me_0000000001', { tags: ['复盘'] }, { id: 'u_1' });

      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
        data: { tags: ['复盘'] },
      });
    });

    it('global 级行（teamId 为空）不查成员表，直接更新', async () => {
      prisma.memory.findUnique.mockResolvedValue(
        row({ level: 'global', teamId: null }),
      );
      prisma.memory.update.mockResolvedValue({ id: 'me_0000000001' });

      await service.update(
        'me_0000000001',
        { description: '新摘要' },
        { id: 'u_admin' },
      );

      expect(prisma.teamUserMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'me_0000000001' },
        data: { description: '新摘要' },
      });
    });
  });
});
