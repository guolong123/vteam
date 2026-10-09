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
    trigger: { findUnique: jest.Mock; delete: jest.Mock };
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

  /** team 级活跃记忆行（默认合规标签 + 被引用过，落不进任何候选组）。 */
  const healthyRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    content: `正常记忆 ${id}`,
    contentHash: `hash_${id}`,
    tags: ['howto'],
    refCount: 3,
    lastUsedAt: daysAgo(1),
    createdAt: daysAgo(40),
    ...over,
  });

  beforeEach(async () => {
    delete process.env.MEMORY_MAINTENANCE_INTERVAL_MS;
    delete process.env.MEMORY_ORG_UNUSED_DAYS;
    delete process.env.MEMORY_ORG_CANDIDATE_LIMIT;

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

    it('幂等：既有 pending 行原样保留（不重复 schedule）', async () => {
      prisma.trigger.findUnique.mockResolvedValue({
        id: 'tmr_1',
        status: 'pending',
      });
      await service.onModuleInit();
      expect(triggers.schedule).not.toHaveBeenCalled();
      expect(triggers.cancel).not.toHaveBeenCalled();
    });

    it('既有终态行先删后建（改 env 后能生效，不被 dedupKey 幂等卡死）', async () => {
      prisma.trigger.findUnique.mockResolvedValue({
        id: 'tmr_1',
        status: 'fired',
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

      prisma.memory.findMany.mockResolvedValue([healthyRow('me_1')]);
      await service.runOnce();

      await expect(guard()).resolves.toBe(false);
    });

    it('间隔 env=0（禁用）时 guard 不按间隔否决（fail-open 放行）', async () => {
      process.env.MEMORY_MAINTENANCE_INTERVAL_MS = '0';
      await service.onModuleInit();
      const guard = guardFn();
      prisma.memory.findMany.mockResolvedValue([healthyRow('me_1')]);
      await service.runOnce();
      await expect(guard()).resolves.toBe(true);
    });
  });

  describe('候选收集', () => {
    it('三分组各自正确：同 hash 重复 / 低频未引用 / 标签不规范', async () => {
      prisma.memory.findMany.mockResolvedValue([
        // duplicates：me_a 与 me_b 同 contentHash
        healthyRow('me_a', {
          contentHash: 'dup',
          tags: ['howto'],
          refCount: 5,
        }),
        healthyRow('me_b', {
          contentHash: 'dup',
          tags: ['howto'],
          refCount: 4,
        }),
        // unused：refCount=0 且 90 天前建、从没被引用
        healthyRow('me_c', {
          refCount: 0,
          lastUsedAt: null,
          createdAt: daysAgo(90),
        }),
        // untags：标签含白名单外的值
        healthyRow('me_d', { tags: ['note', 'howto'] }),
        // untags：标签缺失
        healthyRow('me_e', { tags: null }),
        // 合规行：不该进任何组
        healthyRow('me_ok'),
        // 被引用过的新鲜 unused 候选（refCount=0 但 lastUsedAt 是昨天）→ 不算低频
        healthyRow('me_f', { refCount: 0, lastUsedAt: daysAgo(1) }),
      ]);

      const summary = await service.runOnce();

      expect(summary.candidates).toEqual({
        duplicates: 2,
        unused: 1,
        untags: 2,
      });
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('me_a');
      expect(prompt).toContain('me_b');
      expect(prompt).toContain('me_c');
      expect(prompt).toContain('me_d');
      expect(prompt).toContain('me_e');
      expect(prompt).not.toContain('me_ok');
      expect(prompt).not.toContain('me_f');
    });

    it('同一条同时命中多组时只提示一次（重复组优先）', async () => {
      prisma.memory.findMany.mockResolvedValue([
        healthyRow('me_x', {
          contentHash: 'dup',
          refCount: 0,
          lastUsedAt: null,
          createdAt: daysAgo(90),
          tags: ['bad'],
        }),
        healthyRow('me_y', {
          contentHash: 'dup',
          refCount: 1,
          tags: ['howto'],
        }),
      ]);
      const summary = await service.runOnce();
      expect(summary.candidates).toEqual({
        duplicates: 2,
        unused: 0,
        untags: 0,
      });
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt.match(/\[me_x\]/g)).toHaveLength(1);
    });

    it('候选上限生效（env CANDIDATE_LIMIT）', async () => {
      process.env.MEMORY_ORG_CANDIDATE_LIMIT = '2';
      prisma.memory.findMany.mockResolvedValue([
        healthyRow('me_a', { contentHash: 'dup' }),
        healthyRow('me_b', { contentHash: 'dup' }),
        healthyRow('me_c', { contentHash: 'dup' }),
      ]);
      const summary = await service.runOnce();
      expect(summary.candidates.duplicates).toBe(2);
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('me_a');
      expect(prompt).toContain('me_b');
      expect(prompt).not.toContain('me_c');
    });

    it('摘要截断至 80 字', async () => {
      prisma.memory.findMany.mockResolvedValue([
        healthyRow('me_a', {
          contentHash: 'dup',
          content: '长'.repeat(200),
        }),
        healthyRow('me_b', { contentHash: 'dup' }),
      ]);
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('长'.repeat(80));
      expect(prompt).not.toContain('长'.repeat(81));
    });

    it('无候选团队不落 system 条、不派发', async () => {
      prisma.memory.findMany.mockResolvedValue([healthyRow('me_ok')]);
      const summary = await service.runOnce();
      expect(summary).toEqual({
        teams: 0,
        candidates: { duplicates: 0, unused: 0, untags: 0 },
      });
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });
  });

  describe('灰色 system 条', () => {
    beforeEach(() => {
      prisma.memory.findMany.mockResolvedValue([
        healthyRow('me_a', { contentHash: 'dup' }),
        healthyRow('me_b', { contentHash: 'dup' }),
        healthyRow('me_c', {
          refCount: 0,
          lastUsedAt: null,
          createdAt: daysAgo(90),
        }),
        healthyRow('me_d', { tags: ['oops'] }),
      ]);
    });

    it('首轮落 team_group 频道的 system 消息（无「上轮实际结果」从句）', async () => {
      await service.runOnce();
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      const arg = prisma.message.create.mock.calls[0][0];
      expect(arg.data.senderType).toBe('system');
      expect(arg.data.channelId).toBe('c_group');
      expect(arg.data.content.text).toBe(
        '【记忆整理】本轮检测：疑似重复 2 · 低频未引用 1 · 标签不规范 1，已派发整理',
      );
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

    it('第二轮带上轮实际结果（服务端 DB 统计，不依赖 Agent 回传）', async () => {
      await service.runOnce();
      prisma.message.create.mockClear();
      prisma.memory.count.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

      await service.runOnce();
      const text = prisma.message.create.mock.calls[0][0].data.content
        .text as string;
      expect(text).toContain('上轮实际结果：合并 3 条 · 归档 2 条');
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
    });
  });

  describe('派发主 Agent', () => {
    beforeEach(() => {
      prisma.memory.findMany.mockResolvedValue([
        healthyRow('me_a', { contentHash: 'dup' }),
        healthyRow('me_b', { contentHash: 'dup' }),
      ]);
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

    it('mainAgentMemberId 缺失 → 跳过该团队并告警', async () => {
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
      const warn = jest.spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      );
      const summary = await service.runOnce();
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(summary.teams).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('mainAgentMemberId'),
      );
    });

    it('prompt 引用 agent 侧工具名并给出单轮处理上限', async () => {
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('vteam_memory_search');
      expect(prompt).toContain('vteam_memory_merge');
      expect(prompt).toContain('vteam_memory_archive');
      expect(prompt).toContain('vteam_memory_update');
      expect(prompt).toContain('howto / pitfall / constraint');
      expect(prompt).toContain(
        `单轮最多处理 ${MEMORY_MAINTENANCE_PROMPT_ITEM_LIMIT} 条`,
      );
    });

    it('候选多于单轮上限时 prompt 只列前 20 条并说明余量留待下轮', async () => {
      process.env.MEMORY_ORG_CANDIDATE_LIMIT = '25';
      const rows: ReturnType<typeof healthyRow>[] = [];
      for (let i = 0; i < 25; i++) {
        rows.push(
          healthyRow(`me_${String(i).padStart(2, '0')}`, {
            contentHash: 'dup',
          }),
        );
      }
      prisma.memory.findMany.mockResolvedValue(rows);
      await service.runOnce();
      const prompt = dispatcher.dispatchAgentMention.mock.calls[0][0].text;
      expect(prompt).toContain('me_19');
      expect(prompt).not.toContain('me_20');
      expect(prompt).toContain('本轮超出部分（5 条）留待下轮');
    });
  });

  describe('单团队异常隔离', () => {
    const dupRows = () => [
      healthyRow('me_a', { contentHash: 'dup' }),
      healthyRow('me_b', { contentHash: 'dup' }),
    ];

    it('一个团队派发抛错不中断其他团队', async () => {
      prisma.memory.groupBy.mockResolvedValue([
        { teamId: 'tm_bad' },
        { teamId: 'tm_ok' },
      ]);
      prisma.memory.findMany.mockResolvedValue(dupRows());
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
      const error = jest.spyOn(
        (service as unknown as { logger: { error: jest.Mock } }).logger,
        'error',
      );

      const summary = await service.runOnce();

      expect(summary.teams).toBe(1);
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

    it('候选收集抛错同样被隔离（不冒泡出 runOnce）', async () => {
      prisma.memory.groupBy.mockResolvedValue([
        { teamId: 'tm_bad' },
        { teamId: 'tm_ok' },
      ]);
      prisma.memory.findMany.mockImplementation(
        async (args: { where: { teamId: string } }) => {
          if (args.where.teamId === 'tm_bad') throw new Error('db down');
          return dupRows();
        },
      );
      const summary = await service.runOnce();
      expect(summary.teams).toBe(1);
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

    it('候选查询只覆盖本团队 team 级活跃行', async () => {
      await service.runOnce();
      expect(prisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { level: 'team', teamId: 'tm_1', deletedAt: null },
        }),
      );
    });
  });
});
