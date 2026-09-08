import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TeamsService } from './teams.service';

/**
 * Todo 15 回归：种子 idGen 续号跳过非数字后缀 id。
 *
 * 根因（T14 隔离栈实测）：team_user_members 表混入种子行 `tum_admin_seed`
 * 后，旧 seedPrefix 用 `findFirst({ orderBy: { id: 'desc' } })` 取字典序最大行
 * （'tum_admin_seed' > 'tum_0000000001'，'a' > '0'），再 parseInt('admin_seed')
 * 得 NaN → 跳过 seed → 计数器从 0 起 → 首个 nextId('tum') 生成
 * `tum_0000000001` 撞库中已有主键 → 建团队首试 500（retry 才过）。
 *
 * 本 spec 在 onModuleInit 层锁定：mock 表态复刻 fresh-seed
 *（`tum_0000000001` + `tum_admin_seed` 共存），断言续号后首个 id 为
 * `tum_0000000002`（即 fresh-seed 后首次建团队成员 create 201 而非 500）。
 * mock delegate 同时提供 findFirst（旧路径）与 findMany（新路径），
 * 使同一断言在修复前后均可执行：修复前红（取到 ...0001），修复后绿。
 */
describe('TeamsService seed续号（Todo 15：跳过非数字后缀 id）', () => {
  let service: TeamsService;
  let idGen: IdGeneratorService;

  /** 按表名配置各 delegate 的 id 行；findFirst 仿真 orderBy id desc。 */
  const buildPrisma = (rowsByTable: Record<string, string[]>) => {
    const delegate = (table: string) => {
      const rows = (rowsByTable[table] ?? []).map((id) => ({ id }));
      return {
        findFirst: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(
              [...rows].sort((a, b) => (a.id < b.id ? 1 : -1))[0] ?? null,
            ),
          ),
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const prefix: string = where?.id?.startsWith ?? '';
          return Promise.resolve(rows.filter((r) => r.id.startsWith(prefix)));
        }),
      };
    };
    return {
      team: delegate('team'),
      teamMember: delegate('teamMember'),
      teamUserMember: delegate('teamUserMember'),
      teamQueue: delegate('teamQueue'),
    };
  };

  const setup = async (rowsByTable: Record<string, string[]>) => {
    idGen = new IdGeneratorService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamsService,
        { provide: PrismaService, useValue: buildPrisma(rowsByTable) },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
      ],
    }).compile();
    service = module.get<TeamsService>(TeamsService);
  };

  it('fresh-seed 表态（tum_0000000001 + tum_admin_seed）→ 首个续号 id 为 tum_0000000002', async () => {
    await setup({
      teamUserMember: ['tum_0000000001', 'tum_admin_seed'],
    });

    await service.onModuleInit();

    // 旧实现此处得 tum_0000000001（与种子行碰撞 → 建团队 500）；修复后跳过非数字行取 max=1。
    await expect(idGen.nextId('tum')).resolves.toBe('tum_0000000002');
  });

  it('全非数字表（仅 tum_admin_seed）→ 不抛错，计数器从 0 起首个 id 为 tum_0000000001', async () => {
    await setup({
      teamUserMember: ['tum_admin_seed'],
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(idGen.nextId('tum')).resolves.toBe('tum_0000000001');
  });
});
