import { Test, TestingModule } from '@nestjs/testing';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TriggerService } from '../timers/trigger.service';
import {
  DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS,
  MEMORY_MAINTENANCE_COOLDOWN_GUARD,
  MEMORY_MAINTENANCE_DEDUP_KEY,
  MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT,
  MemoryMaintenanceService,
} from './memory-maintenance.service';

const DAY = 86_400_000;

describe('MemoryMaintenanceService', () => {
  let service: MemoryMaintenanceService;
  let prisma: {
    memory: {
      groupBy: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    message: { create: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    team: { findUnique: jest.Mock };
    trigger: { findUnique: jest.Mock; delete: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let triggers: {
    registerHandler: jest.Mock;
    registerGuard: jest.Mock;
    schedule: jest.Mock;
    cancel: jest.Mock;
  };
  let dispatcher: { dispatchAgentMention: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  const savedEnv = { ...process.env };

  /** 注册到 TriggerService 的 guard 谓词（取回以便直接断言冷却语义）。 */
  const guardFn = (): (() => Promise<boolean>) => {
    const call = triggers.registerGuard.mock.calls.find(
      (c) => c[0] === MEMORY_MAINTENANCE_COOLDOWN_GUARD,
    );
    return call?.[1] as () => Promise<boolean>;
  };

  const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);

  /**
   * team 级活跃记忆行（默认：合规标签 + 被引用过 + 建档于 1 天前 → 首轮算「新」）。
   * 服务端零检测下**没有**「脏/干净」之分：只要行活跃就是事实清单的一行。
   */
  const newRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    content: `新记忆 ${id}`,
    tags: ['howto'],
    refCount: 3,
    lastUsedAt: daysAgo(1),
    createdAt: daysAgo(1),
    ...over,
  });

  /** 两条可派发的新记忆（各团队测试默认素材）。 */
  const twoRows = () => [newRow('me_a'), newRow('me_b')];

  /** 认游标的 findMany（不认游标的 mock 会让第二轮凭空又冒出「首轮全量」）。 */
  const memoriesHonouringCursor = () =>
    prisma.memory.findMany.mockImplementation(
      async (args: {
        where: { teamId: string; createdAt?: { gt: Date } };
      }) => {
        const gt = args.where.createdAt?.gt;
        return twoRows().filter((r) => !gt || r.createdAt > gt);
      },
    );

  const loggerOf = (
    level: 'log' | 'warn' | 'error',
  ): jest.SpyInstance<jest.Mock, unknown[]> =>
    jest.spyOn(
      (service as unknown as { logger: Record<string, jest.Mock> }).logger,
      level,
    );

  beforeEach(async () => {
    delete process.env.MEMORY_MAINTENANCE_INTERVAL_MS;

    prisma = {
      memory: {
        groupBy: jest.fn().mockResolvedValue([{ teamId: 'tm_1' }]),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      message: {
        create: jest.fn().mockResolvedValue({ id: 'm_0000000001' }),
      },
      chatChannel: {
        findFirst: jest.fn().mockResolvedValue({ id: 'c_group' }),
      },
      team: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ mainAgentMemberId: 'tmm_main' }),
      },
      trigger: {
        findUnique: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue({ id: 'tmr_1' }),
        update: jest.fn().mockResolvedValue({ id: 'tmr_1' }),
      },
      $transaction: jest.fn((args: Array<Promise<unknown>>) =>
        Promise.all(args),
      ),
    };
    triggers = {
      registerHandler: jest.fn(),
      registerGuard: jest.fn(),
      schedule: jest.fn().mockResolvedValue({ id: 'tmr_1' }),
      cancel: jest.fn().mockResolvedValue({ id: 'tmr_1' }),
    };
    dispatcher = { dispatchAgentMention: jest.fn().mockResolvedValue('s_1') };
    realtime = { broadcast: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryMaintenanceService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: IdGeneratorService,
          useValue: { nextId: jest.fn(() => 'm_0000000002'), seed: jest.fn() },
        },
        { provide: RealtimeService, useValue: realtime },
        { provide: TriggerService, useValue: triggers },
        { provide: WorkerDispatcher, useValue: dispatcher },
      ],
    }).compile();

    service = module.get<MemoryMaintenanceService>(MemoryMaintenanceService);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe('onModuleInit 接线', () => {
    it('注册 memory_maintenance handler 与冷却 guard', async () => {
      await service.onModuleInit();
      expect(triggers.registerHandler).toHaveBeenCalledWith(
        'memory_maintenance',
        expect.any(Function),
      );
      expect(triggers.registerGuard).toHaveBeenCalledWith(
        MEMORY_MAINTENANCE_COOLDOWN_GUARD,
        expect.any(Function),
      );
    });

    it('全局单行排期：dedupKey 固定 + intervalMs/guardKey 透传', async () => {
      await service.onModuleInit();
      expect(triggers.schedule).toHaveBeenCalledWith(
        'memory_maintenance',
        expect.any(Date),
        expect.objectContaining({ scope: 'global' }),
        MEMORY_MAINTENANCE_DEDUP_KEY,
        {
          intervalMs: DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS,
          guardKey: MEMORY_MAINTENANCE_COOLDOWN_GUARD,
        },
      );
    });

    it('默认间隔 = 7 天（决策修订：24h 过于频繁，记忆整理本无实时性要求）', async () => {
      expect(DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS).toBe(604_800_000);
      await service.onModuleInit();
      expect(triggers.schedule).toHaveBeenCalledWith(
        'memory_maintenance',
        expect.any(Date),
        expect.anything(),
        MEMORY_MAINTENANCE_DEDUP_KEY,
        expect.objectContaining({ intervalMs: 604_800_000 }),
      );
    });

    it('排期 purpose 用「新记忆」口径（不再是列候选）', async () => {
      await service.onModuleInit();
      expect(triggers.schedule).toHaveBeenCalledWith(
        'memory_maintenance',
        expect.any(Date),
        expect.objectContaining({
          purpose: expect.stringContaining('新记忆'),
        }),
        MEMORY_MAINTENANCE_DEDUP_KEY,
        expect.anything(),
      );
    });

    it('幂等：既有 pending 行且间隔一致 → 原样保留（不 update 不 schedule）', async () => {
      prisma.trigger.findUnique.mockResolvedValue({
        id: 'tmr_1',
        status: 'pending',
        intervalMs: DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS,
      });
      await service.onModuleInit();
      expect(triggers.schedule).not.toHaveBeenCalled();
      expect(triggers.cancel).not.toHaveBeenCalled();
      expect(prisma.trigger.update).not.toHaveBeenCalled();
    });

    it('既有 pending 行但间隔不一致（生产那条 24h 行）→ 就地改 intervalMs + nextFireAt，保留 id/status/fireCount', async () => {
      prisma.trigger.findUnique.mockResolvedValue({
        id: 'tmr_prod',
        status: 'pending',
        intervalMs: 86_400_000,
        fireCount: 3,
      });

      await service.onModuleInit();

      expect(prisma.trigger.update).toHaveBeenCalledWith({
        where: { id: 'tmr_prod' },
        data: {
          intervalMs: DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS,
          nextFireAt: expect.any(Date),
        },
      });
      const nextFireAt = (
        prisma.trigger.update.mock.calls[0][0] as {
          data: { nextFireAt: Date };
        }
      ).data.nextFireAt;
      expect(nextFireAt.getTime()).toBeGreaterThan(Date.now());
      // 走的是 update 分支，不该再 schedule（schedule 会按 dedupKey 幂等回旧行）
      expect(triggers.schedule).not.toHaveBeenCalled();
    });

    it('既有 pending 行 intervalMs 为 null（脏数据）也走就地改分支', async () => {
      prisma.trigger.findUnique.mockResolvedValue({
        id: 'tmr_1',
        status: 'pending',
        intervalMs: null,
      });
      await service.onModuleInit();
      expect(prisma.trigger.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            intervalMs: DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS,
          }),
        }),
      );
    });

    it('既有终态行先删后建（改 env 后能生效，不被 dedupKey 幂等卡死）', async () => {
      prisma.trigger.findUnique.mockResolvedValue({
        id: 'tmr_1',
        status: 'fired',
        intervalMs: 86_400_000,
      });
      await service.onModuleInit();
      expect(prisma.trigger.delete).toHaveBeenCalledWith({
        where: { dedupKey: MEMORY_MAINTENANCE_DEDUP_KEY },
      });
      expect(triggers.schedule).toHaveBeenCalled();
    });

    it('既有终态行删除失败 → 跳过本次重建（不再 schedule 幂等回旧行），且不抛错', async () => {
      prisma.trigger.findUnique.mockResolvedValue({
        id: 'tmr_1',
        status: 'fired',
        intervalMs: 86_400_000,
      });
      prisma.trigger.delete.mockRejectedValue(new Error('db locked'));

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      expect(triggers.schedule).not.toHaveBeenCalled();
    });

    it('interval=0（禁用）→ 不排期，且取消既有 pending 行', async () => {
      process.env.MEMORY_MAINTENANCE_INTERVAL_MS = '0';
      prisma.trigger.findUnique.mockResolvedValue({
        id: 'tmr_1',
        status: 'pending',
        intervalMs: 86_400_000,
      });
      await service.onModuleInit();
      expect(triggers.schedule).not.toHaveBeenCalled();
      expect(triggers.cancel).toHaveBeenCalledWith('tmr_1');
    });

    it('interval=0 且无既有行 → 既不排期也不 cancel', async () => {
      process.env.MEMORY_MAINTENANCE_INTERVAL_MS = '0';
      await service.onModuleInit();
      expect(triggers.schedule).not.toHaveBeenCalled();
      expect(triggers.cancel).not.toHaveBeenCalled();
    });

    it('非法 env（非数字）回落默认值，不让进程起不来', async () => {
      process.env.MEMORY_MAINTENANCE_INTERVAL_MS = 'abc';
      await service.onModuleInit();
      expect(triggers.schedule).toHaveBeenCalledWith(
        'memory_maintenance',
        expect.any(Date),
        expect.anything(),
        MEMORY_MAINTENANCE_DEDUP_KEY,
        expect.objectContaining({
          intervalMs: DEFAULT_MEMORY_MAINTENANCE_INTERVAL_MS,
        }),
      );
    });
  });

  describe('冷却 guard', () => {
    it('尚未跑过时放行；一轮跑完后（间隔内）拒绝重入', async () => {
      await service.onModuleInit();
      const guard = guardFn();
      await expect(guard()).resolves.toBe(true);

      prisma.memory.findMany.mockResolvedValue(twoRows());
      await service.runOnce();

      await expect(guard()).resolves.toBe(false);
    });

    it('间隔 env=0（禁用）时 guard 不按间隔否决（fail-open 放行）', async () => {
      process.env.MEMORY_MAINTENANCE_INTERVAL_MS = '0';
      await service.onModuleInit();
      const guard = guardFn();
      prisma.memory.findMany.mockResolvedValue(twoRows());
      await service.runOnce();
      await expect(guard()).resolves.toBe(true);
    });
  });

  describe('触发闸门：是否有新记忆', () => {
    it('首轮（无游标）→ 全部活跃行都算新（有界全量扫描）', async () => {
      prisma.memory.findMany.mockResolvedValue(twoRows());

      const summary = await service.runOnce();

      expect(summary).toEqual({ teams: 1, newMemories: 2 });
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { level: 'team', teamId: 'tm_1', deletedAt: null },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('首轮 0 条活跃记忆 → 静默跳过（不派发、不落 system 条）', async () => {
      prisma.memory.findMany.mockResolvedValue([]);

      const summary = await service.runOnce();

      expect(summary).toEqual({ teams: 0, newMemories: 0 });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('游标之后无新记忆 → 静默跳过（不落 system 条、不派发）', async () => {
      prisma.memory.findMany.mockResolvedValue(twoRows());
      await service.runOnce();
      prisma.message.create.mockClear();
      prisma.memory.findMany.mockResolvedValue([]);

      const summary = await service.runOnce();

      expect(summary).toEqual({ teams: 0, newMemories: 0 });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    });

    it('跳过时只记一行 info，不 warn 不 error', async () => {
      prisma.memory.findMany.mockResolvedValue([]);
      const warn = loggerOf('warn');
      const error = loggerOf('error');
      const log = loggerOf('log');

      await service.runOnce();

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('自上次整理无新记忆'),
      );
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('每轮按 createdAt ASC 取新记忆（游标语义 = created_at > 上轮边界）', async () => {
      prisma.memory.findMany.mockResolvedValue(twoRows());
      await service.runOnce();
      prisma.memory.findMany.mockClear();

      prisma.memory.findMany.mockResolvedValue([newRow('me_c')]);
      await service.runOnce();

      const where = prisma.memory.findMany.mock.calls[0][0].where as {
        createdAt: { gt: Date };
      };
      expect(where.createdAt.gt).toBeInstanceOf(Date);
    });

    it('每团队游标互相独立：团队 A 跑过不挡团队 B 首轮', async () => {
      prisma.memory.groupBy.mockResolvedValue([
        { teamId: 'tm_a' },
        { teamId: 'tm_b' },
      ]);
      // 每团队首批都算新，第二轮 A 空、B 仍有新
      prisma.memory.findMany.mockImplementation(
        async (args: { where: { teamId: string; createdAt?: { gt: Date } } }) =>
          args.where.teamId === 'tm_b' || !args.where.createdAt
            ? [newRow(`me_${args.where.teamId}`)]
            : [],
      );

      const first = await service.runOnce();
      expect(first).toEqual({ teams: 2, newMemories: 2 });

      const second = await service.runOnce();
      expect(second).toEqual({ teams: 1, newMemories: 1 });
      expect(
        dispatcher.dispatchAgentMention.mock.calls.map((c) => c[0].teamId),
      ).toEqual(['tm_a', 'tm_b', 'tm_b']);
    });

    it('主 Agent 缺失 → 不派发且不推进游标（下轮仍会带上这批新记忆）', async () => {
      prisma.memory.findMany.mockResolvedValue(twoRows());
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
      const warn = loggerOf('warn');

      await service.runOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('mainAgentMemberId'),
      );

      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: 'tmm_main' });
      const second = await service.runOnce();
      expect(second).toEqual({ teams: 1, newMemories: 2 });
    });
  });

  describe('游标推进与截断续跑', () => {
    const manyRows = (n: number): ReturnType<typeof newRow>[] =>
      Array.from({ length: n }, (_, i) =>
        newRow(`me_${String(i).padStart(2, '0')}`, {
          createdAt: new Date(Date.now() - (n - i) * 60_000),
        }),
      );

    it('全量入 prompt → 游标推进到 now（第二轮空集跳过）', async () => {
      memoriesHonouringCursor();

      await service.runOnce();
      const second = await service.runOnce();

      expect(second).toEqual({ teams: 0, newMemories: 0 });
    });

    it('超过单轮上限 → prompt 只列前 20 条且说明余量留待下轮', async () => {
      prisma.memory.findMany.mockResolvedValue(manyRows(25));

      await service.runOnce();

      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('me_19');
      expect(prompt).not.toContain('me_20');
      expect(prompt).toContain('还有 5 条留待下轮');
    });

    it('截断时游标 = 末条已列入行的 createdAt → 下轮从余量续跑（cap 之上的行不饿死）', async () => {
      const rows = manyRows(25);
      prisma.memory.findMany.mockResolvedValue(rows);
      await service.runOnce();
      prisma.message.create.mockClear();

      // 第二轮：余下 5 条仍在游标之后
      prisma.memory.findMany.mockResolvedValue(rows.slice(20));
      const second = await service.runOnce();

      expect(second).toEqual({ teams: 1, newMemories: 5 });
      const prompt = dispatcher.dispatchAgentMention.mock.calls[1][0].text;
      expect(prompt).toContain('me_24');
      expect(prompt).toContain('已全部列出');
      // 游标落在 me_19 的 createdAt（本例 createdAt = now-5min）
      expect(prisma.memory.findMany.mock.calls[1][0].where.createdAt.gt).toEqual(
        rows[19].createdAt,
      );
    });

    it('摘要条数按团队新记忆总数计（截断时 summary 仍报全量 25）', async () => {
      prisma.memory.findMany.mockResolvedValue(manyRows(25));

      const summary = await service.runOnce();

      expect(summary).toEqual({ teams: 1, newMemories: 25 });
    });
  });

  describe('事实清单与 prompt', () => {
    beforeEach(() => {
      prisma.memory.findMany.mockResolvedValue([
        newRow('me_a', { refCount: 0, lastUsedAt: null, tags: ['note'] }),
      ]);
    });

    it('只列事实（id / tags / refCount / 建档与命中时间 / 内容），不给任何服务端建议动作', async () => {
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('[me_a]');
      expect(prompt).toContain('tags=note');
      expect(prompt).toContain('refCount=0');
      expect(prompt).toContain('最近命中=从未');
      expect(prompt).toContain(`建于=${new Date(Date.now() - DAY).toISOString().slice(0, 10)}`);
      expect(prompt).not.toContain('建议动作');
    });

    it('声明平台零判断，并把判断权与「拿不准就别动」纪律交给 Agent', async () => {
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('平台只负责**列事实**');
      expect(prompt).toContain('平台不做任何判断');
      expect(prompt).toContain('拿不准就不动');
    });

    it('引用 agent 侧工具名并给标签词表', async () => {
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('vteam_memory_search');
      expect(prompt).toContain('vteam_memory_merge');
      expect(prompt).toContain('vteam_memory_archive');
      expect(prompt).toContain('vteam_memory_update');
      expect(prompt).toContain('howto / pitfall / constraint');
      expect(prompt).toContain('信息最全的一条');
    });

    it('收尾汇报格式：合并/归档/改标签/不动', async () => {
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('合并 X 条 / 归档 Y 条 / 改标签 Z 条 / 判断为不该动 W 条');
    });

    it('单轮上限常量进 prompt', async () => {
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain(
        `单轮上限 ${MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT} 条`,
      );
    });

    it('tags 非数组 / 含非字符串项 → 只留字符串（事实行不炸）', async () => {
      prisma.memory.findMany.mockResolvedValue([
        newRow('me_a', { tags: 'howto' }),
        newRow('me_b', { tags: [1, 'pitfall', null] }),
      ]);
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('tags=（无）');
      expect(prompt).toContain('tags=pitfall');
    });

    it('内容节选截断至 160 字', async () => {
      prisma.memory.findMany.mockResolvedValue([
        newRow('me_a', { content: '长'.repeat(400) }),
      ]);
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('长'.repeat(160));
      expect(prompt).not.toContain('长'.repeat(161));
    });
  });

  describe('灰色 system 条', () => {
    beforeEach(() => {
      prisma.memory.findMany.mockResolvedValue(twoRows());
    });

    it('首轮落 team_group 频道的 system 消息（新记忆条数 + 无「上轮实际结果」从句）', async () => {
      await service.runOnce();
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      const arg = prisma.message.create.mock.calls[0][0];
      expect(arg.data.senderType).toBe('system');
      expect(arg.data.channelId).toBe('c_group');
      expect(arg.data.content.text).toBe('【记忆整理】发现 2 条新记忆，已派发整理');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        'chat.message.new',
        expect.objectContaining({
          message: expect.objectContaining({
            channelId: 'c_group',
            senderType: 'system',
          }),
        }),
        { type: 'channel', id: 'c_group' },
      );
    });

    it('第二轮带上轮实际结果（服务端 DB 统计，窗口 = 该团队上轮游标，不依赖 Agent 回传）', async () => {
      await service.runOnce();
      prisma.message.create.mockClear();
      prisma.memory.findMany.mockClear();
      prisma.memory.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
      prisma.memory.findMany.mockResolvedValue([newRow('me_c')]);

      await service.runOnce();
      const text = prisma.message.create.mock.calls[0][0].data.content
        .text as string;
      expect(text).toBe(
        '【记忆整理】发现 1 条新记忆，已派发整理。上轮实际结果：合并 3 条 · 归档 2 条',
      );
      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          level: 'team',
          teamId: 'tm_1',
          mergedIntoId: { not: null },
        }),
      });
      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          level: 'team',
          teamId: 'tm_1',
          deletedAt: { gte: expect.any(Date) },
        }),
      });
      // 统计窗口起点 = 第二轮的查询游标（同一次读，避免两处 Date.now 漂移）
      const cursor = (prisma.memory.findMany.mock.calls[0][0].where as {
        createdAt: { gt: Date };
      }).createdAt.gt;
      expect(prisma.memory.count).toHaveBeenCalledWith({
        where: expect.objectContaining({ updatedAt: { gte: cursor } }),
      });
    });

    it('无 team_group 频道 → 只 warn，不阻断派发', async () => {
      // 私聊在、群聊缺（system 条落不了群）→ 仍照常私聊派发
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_private' })
        .mockResolvedValue(null);
      const warn = loggerOf('warn');

      await service.runOnce();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('无 team_group 频道'),
      );
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    });
  });

  describe('派发主 Agent', () => {
    beforeEach(() => {
      prisma.memory.findMany.mockResolvedValue(twoRows());
    });

    it('kind=wake + internal=true + target=mainAgentMemberId + 私聊频道优先', async () => {
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_private' })
        .mockResolvedValueOnce({ id: 'c_group' });
      await service.runOnce();
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'tm_1',
          channelId: 'c_private',
          targetInstanceId: 'tmm_main',
          kind: 'wake',
          internal: true,
        }),
      );
    });

    it('主 Agent 私聊缺失时回退 team_group 频道', async () => {
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'c_group' });
      await service.runOnce();
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'c_group' }),
      );
    });
  });

  describe('单轮日志', () => {
    it('新记忆计数进日志 + scope 后缀', async () => {
      prisma.memory.findMany.mockResolvedValue(twoRows());
      const log = loggerOf('log');

      await service.runOnce('tm_1');

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('单轮完成 teams=1 新记忆=2'),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('scope=tm_1'),
      );
    });

    it('无新记忆也只记一行摘要（teams=0 新记忆=0）', async () => {
      const log = loggerOf('log');
      await service.runOnce();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('单轮完成 teams=0 新记忆=0'),
      );
    });
  });

  describe('单团队异常隔离', () => {
    it('一个团队派发抛错不中断其他团队', async () => {
      prisma.memory.groupBy.mockResolvedValue([
        { teamId: 'tm_bad' },
        { teamId: 'tm_ok' },
      ]);
      prisma.memory.findMany.mockResolvedValue(twoRows());
      prisma.team.findUnique.mockImplementation(
        async (args: { where: { id: string } }) =>
          args.where.id === 'tm_bad'
            ? { mainAgentMemberId: 'tmm_bad' }
            : { mainAgentMemberId: 'tmm_ok' },
      );
      dispatcher.dispatchAgentMention.mockImplementation(
        async (arg: { teamId: string }) => {
          if (arg.teamId === 'tm_bad') throw new Error('boom');
          return 's_ok';
        },
      );
      const error = loggerOf('error');

      const summary = await service.runOnce();

      expect(summary).toEqual({ teams: 1, newMemories: 2 });
      const dispatched = dispatcher.dispatchAgentMention.mock.calls.map(
        (c) => c[0].teamId,
      );
      expect(dispatched).toContain('tm_bad');
      expect(dispatched).toContain('tm_ok');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('team=tm_bad'),
        expect.any(String),
      );
    });

    it('新记忆查询抛错同样被隔离（不冒泡出 runOnce）', async () => {
      prisma.memory.groupBy.mockResolvedValue([
        { teamId: 'tm_bad' },
        { teamId: 'tm_ok' },
      ]);
      prisma.memory.findMany.mockImplementation(
        async (args: { where: { teamId: string } }) => {
          if (args.where.teamId === 'tm_bad') throw new Error('db down');
          return twoRows();
        },
      );
      const summary = await service.runOnce();
      expect(summary).toEqual({ teams: 1, newMemories: 2 });
    });
  });

  describe('团队范围', () => {
    it('只取 level=team 且有活跃记忆的团队（global/role 不进）', async () => {
      await service.runOnce();
      expect(prisma.memory.groupBy).toHaveBeenCalledWith({
        by: ['teamId'],
        where: {
          level: 'team',
          deletedAt: null,
          teamId: { not: null },
        },
      });
    });

    it('新记忆查询只覆盖本团队 team 级活跃行，且不选服务端检测用的 contentHash', async () => {
      prisma.memory.findMany.mockResolvedValue(twoRows());
      await service.runOnce();
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { level: 'team', teamId: 'tm_1', deletedAt: null },
          select: {
            id: true,
            content: true,
            tags: true,
            refCount: true,
            lastUsedAt: true,
            createdAt: true,
          },
        }),
      );
    });
  });

  describe('单团队范围（点谁整理谁）', () => {
    const allTeams = [{ teamId: 'tm_1' }, { teamId: 'tm_2' }, { teamId: 'tm_3' }];
    // groupBy mock 按 where 语义过滤：只有范围真的进了 where，收窄才成立。
    const groupByHonouringWhere = () =>
      prisma.memory.groupBy.mockImplementation(
        async (args: { where: { teamId: string | { not: null } } }) =>
          typeof args.where.teamId === 'string'
            ? allTeams.filter((r) => r.teamId === args.where.teamId)
            : allTeams,
      );
    // 群频道按 teamId 命名：可断言 system 条只落在范围内那个团队的频道。
    const perTeamChannel = () =>
      prisma.chatChannel.findFirst.mockImplementation(
        async (args: { where: { teamId: string } }) => ({
          id: `c_group_${args.where.teamId}`,
        }),
      );

    it('runOnce(teamId) 把团队迭代查询收窄到该团队（where teamId = 传入值）', async () => {
      groupByHonouringWhere();
      prisma.memory.findMany.mockResolvedValue(twoRows());

      await service.runOnce('tm_2');

      expect(prisma.memory.groupBy).toHaveBeenCalledWith({
        by: ['teamId'],
        where: { level: 'team', deletedAt: null, teamId: 'tm_2' },
      });
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { level: 'team', teamId: 'tm_2', deletedAt: null },
        }),
      );
    });

    it('范围内只有该团队：其他团队不落 system 条、不派发（摘要也只含本团队）', async () => {
      groupByHonouringWhere();
      perTeamChannel();
      prisma.memory.findMany.mockResolvedValue(twoRows());

      const summary = await service.runOnce('tm_2');

      expect(summary).toEqual({ teams: 1, newMemories: 2 });
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'tm_2', internal: true }),
      );
      expect(prisma.team.findUnique).toHaveBeenCalledWith({
        where: { id: 'tm_2' },
        select: { mainAgentMemberId: true },
      });
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      const channels = prisma.message.create.mock.calls.map(
        (c) => c[0].data.channelId,
      );
      expect(channels).toEqual(['c_group_tm_2']);
    });

    it('范围内团队无活跃记忆 → teams=0 且不落条不派发', async () => {
      groupByHonouringWhere();
      perTeamChannel();
      prisma.memory.findMany.mockResolvedValue(twoRows());

      const summary = await service.runOnce('tm_404');

      expect(summary).toEqual({ teams: 0, newMemories: 0 });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('手动重跑同一团队：首轮已整理完的增量在下轮带上（新记忆才派发）', async () => {
      groupByHonouringWhere();
      memoriesHonouringCursor();

      const first = await service.runOnce('tm_2');
      expect(first).toEqual({ teams: 1, newMemories: 2 });

      const second = await service.runOnce('tm_2');
      expect(second).toEqual({ teams: 0, newMemories: 0 });
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    });

    it('回归：runOnce()（无 scope）仍全局——where 保持 teamId:{not:null} 且逐团队都派发', async () => {
      groupByHonouringWhere();
      perTeamChannel();
      prisma.memory.findMany.mockImplementation(
        async (args: {
          where: { teamId: string; createdAt?: { gt: Date } };
        }) =>
          args.where.createdAt ? [] : [newRow(`me_${args.where.teamId}`)],
      );

      const summary = await service.runOnce();

      expect(prisma.memory.groupBy).toHaveBeenCalledWith({
        by: ['teamId'],
        where: { level: 'team', deletedAt: null, teamId: { not: null } },
      });
      expect(summary).toEqual({ teams: 3, newMemories: 3 });
      expect(
        dispatcher.dispatchAgentMention.mock.calls.map((c) => c[0].teamId),
      ).toEqual(['tm_1', 'tm_2', 'tm_3']);
      expect(prisma.message.create).toHaveBeenCalledTimes(3);
    });

    it('定时 handler 固定走全局变体（不继承手动端的 scope）', async () => {
      await service.onModuleInit();
      const call = triggers.registerHandler.mock.calls.find(
        (c) => c[0] === 'memory_maintenance',
      );
      const handler = call?.[1] as (ctx: unknown) => Promise<void>;
      groupByHonouringWhere();
      prisma.memory.findMany.mockResolvedValue(twoRows());

      await handler({});

      expect(prisma.memory.groupBy).toHaveBeenCalledWith({
        by: ['teamId'],
        where: { level: 'team', deletedAt: null, teamId: { not: null } },
      });
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(3);
    });
  });
});