import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MessageReceiptsService } from './message-receipts.service';

describe('MessageReceiptsService（plan-review-execution-gates Todo 5）', () => {
  let service: MessageReceiptsService;
  let prisma: {
    messageReceipt: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    task: { findUnique: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
  };
  let realtime: { broadcast: jest.Mock };

  beforeEach(async () => {
    prisma = {
      messageReceipt: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      task: { findUnique: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
    };
    realtime = { broadcast: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageReceiptsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
      ],
    }).compile();

    service = module.get<MessageReceiptsService>(MessageReceiptsService);
  });

  describe('ack', () => {
    it('pending→acked 清账并向 team: + channel: 广播 receipt.acked（零丢失）', async () => {
      prisma.messageReceipt.findUnique.mockResolvedValue({
        id: 'mr_1',
        messageId: 'm_1',
        taskId: 't_1',
        teamId: 'tm_1',
        fromInstanceId: 'tmm_pm',
        toInstanceId: 'tmm_arch',
        status: 'pending',
      });
      prisma.messageReceipt.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'mr_1', status: 'acked', ...data }),
      );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });

      const row = await service.ack('mr_1');

      expect(row.status).toBe('acked');
      expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'mr_1' },
          data: expect.objectContaining({ status: 'acked' }),
        }),
      );
      const types = realtime.broadcast.mock.calls.map((c) => c[0]);
      expect(types).toContain(EVENT_TYPES.RECEIPT_ACKED);
      const teamCall = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.RECEIPT_ACKED && c[2]?.type === 'team',
      );
      const channelCall = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.RECEIPT_ACKED && c[2]?.type === 'channel',
      );
      expect(teamCall?.[2]).toEqual({ type: 'team', id: 'tm_1' });
      expect(channelCall?.[2]).toEqual({ type: 'channel', id: 'c_1' });
      expect(teamCall?.[1]).toMatchObject({
        receiptId: 'mr_1',
        taskId: 't_1',
        teamId: 'tm_1',
        status: 'acked',
      });
    });

    it('已 acked 幂等：不再写库不再广播', async () => {
      prisma.messageReceipt.findUnique.mockResolvedValue({
        id: 'mr_1',
        status: 'acked',
      });

      const row = await service.ack('mr_1');

      expect(row.status).toBe('acked');
      expect(prisma.messageReceipt.update).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('expireDue', () => {
    it('超时 pending→expired 并广播 receipt.expired（team: 订阅收到）', async () => {
      prisma.messageReceipt.findMany.mockResolvedValue([
        {
          id: 'mr_2',
          messageId: 'm_2',
          taskId: 't_1',
          teamId: 'tm_1',
          fromInstanceId: 'tmm_pm',
          toInstanceId: 'tmm_dev',
          status: 'pending',
          nudgeCount: 1,
        },
      ]);
      prisma.messageReceipt.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ status: 'expired', ...data }),
      );
      prisma.chatChannel.findFirst.mockResolvedValue(null);

      const rows = await service.expireDue(new Date('2026-09-16T00:00:00Z'));

      expect(rows).toHaveLength(1);
      const teamCall = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.RECEIPT_EXPIRED && c[2]?.type === 'team',
      );
      expect(teamCall?.[2]).toEqual({ type: 'team', id: 'tm_1' });
      expect(teamCall?.[1]).toMatchObject({
        receiptId: 'mr_2',
        status: 'expired',
      });
    });

    it('清账后触发 settled hook（fromInstanceId=派发方主 Agent），供 drain 重查', async () => {
      prisma.messageReceipt.findMany.mockResolvedValue([
        {
          id: 'mr_2',
          messageId: 'm_2',
          taskId: 't_1',
          teamId: 'tm_1',
          fromInstanceId: 'tmm_pm',
          toInstanceId: 'tmm_dev',
          status: 'pending',
          nudgeCount: 1,
        },
      ]);
      prisma.messageReceipt.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ status: 'expired', ...data }),
      );
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      const hook = jest.fn();
      service.registerSettledHook(hook);

      await service.expireDue(new Date('2026-09-16T00:00:00Z'));

      expect(hook).toHaveBeenCalledWith({
        fromInstanceId: 'tmm_pm',
        teamId: 'tm_1',
      });
    });
  });

  describe('sweepExpiredReceipts（C1 周期到期清账）', () => {
    it('清账到期回执并返回条数', async () => {
      prisma.messageReceipt.findMany.mockResolvedValue([
        {
          id: 'mr_2',
          messageId: 'm_2',
          taskId: 't_1',
          teamId: 'tm_1',
          fromInstanceId: 'tmm_pm',
          toInstanceId: 'tmm_dev',
          status: 'pending',
          nudgeCount: 0,
        },
      ]);
      prisma.messageReceipt.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ status: 'expired', ...data }),
      );
      prisma.chatChannel.findFirst.mockResolvedValue(null);

      await expect(
        service.sweepExpiredReceipts(new Date('2026-09-16T00:00:00Z')),
      ).resolves.toBe(1);
    });

    it('重入护栏：首轮未结束则跳过并发轮（不双清账）', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      prisma.messageReceipt.findMany.mockImplementation(() =>
        gate.then(() => [] as unknown),
      );

      const first = service.sweepExpiredReceipts();
      const second = await service.sweepExpiredReceipts();

      expect(second).toBe(0);
      release();
      await expect(first).resolves.toBe(0);
    });
  });

  describe('countPendingFor（C2 到期过滤，drain 防御纵深）', () => {
    interface StoreRow {
      id: string;
      messageId: string | null;
      taskId: string | null;
      teamId: string;
      fromInstanceId: string;
      toInstanceId: string;
      status: string;
      nudgeCount: number;
      expiresAt: Date;
    }
    let store: StoreRow[];

    beforeEach(() => {
      store = [];
      prisma.messageReceipt.count.mockImplementation(
        (args: {
          where: {
            status?: string;
            fromInstanceId?: string;
            teamId?: string;
            expiresAt?: { gt: Date };
          };
        }) =>
          Promise.resolve(
            store.filter(
              (r) =>
                (args.where.status === undefined ||
                  r.status === args.where.status) &&
                (args.where.fromInstanceId === undefined ||
                  r.fromInstanceId === args.where.fromInstanceId) &&
                (args.where.teamId === undefined ||
                  r.teamId === args.where.teamId) &&
                (args.where.expiresAt === undefined ||
                  r.expiresAt.getTime() > args.where.expiresAt.gt.getTime()),
            ).length,
          ),
      );
      prisma.messageReceipt.findUnique.mockImplementation(
        (args: { where: { id: string } }) =>
          Promise.resolve(store.find((r) => r.id === args.where.id) ?? null),
      );
      prisma.messageReceipt.update.mockImplementation(
        (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = store.find((r) => r.id === args.where.id);
          if (!row) return Promise.resolve(null);
          Object.assign(row, args.data);
          return Promise.resolve(row);
        },
      );
      prisma.chatChannel.findFirst.mockResolvedValue(null);
    });

    it('排除 expiresAt<=now，计入 expiresAt>now（where 带 expiresAt.gt）', async () => {
      store.push(
        {
          id: 'mr_stale',
          messageId: 'm_s',
          taskId: null,
          teamId: 'tm_x',
          fromInstanceId: 'tmm_main',
          toInstanceId: 'tmm_dead',
          status: 'pending',
          nudgeCount: 0,
          expiresAt: new Date('2000-01-01T00:00:00Z'),
        },
        {
          id: 'mr_live',
          messageId: 'm_l',
          taskId: null,
          teamId: 'tm_x',
          fromInstanceId: 'tmm_main',
          toInstanceId: 'tmm_live',
          status: 'pending',
          nudgeCount: 0,
          expiresAt: new Date('2100-01-01T00:00:00Z'),
        },
      );

      await expect(
        service.countPendingFor({ fromInstanceId: 'tmm_main', teamId: 'tm_x' }),
      ).resolves.toBe(1);
      expect(prisma.messageReceipt.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          fromInstanceId: 'tmm_main',
          teamId: 'tm_x',
          status: 'pending',
          expiresAt: { gt: expect.any(Date) },
        }),
      });
    });

    it('事故镜像：一条 stale pending（已过期未清）+ fresh 被 ack → drain 计数 0 → 主 Agent 被唤醒', async () => {
      store.push(
        {
          id: 'mr_stale',
          messageId: 'm_s',
          taskId: null,
          teamId: 'tm_x',
          fromInstanceId: 'tmm_main',
          toInstanceId: 'tmm_dead',
          status: 'pending',
          nudgeCount: 0,
          // 真实事故：expires_at 早于 now 却仍是 pending（清账周期缺席）。
          expiresAt: new Date('2000-01-01T00:00:00Z'),
        },
        {
          id: 'mr_fresh',
          messageId: 'm_f',
          taskId: null,
          teamId: 'tm_x',
          fromInstanceId: 'tmm_main',
          toInstanceId: 'tmm_live',
          status: 'pending',
          nudgeCount: 0,
          expiresAt: new Date('2100-01-01T00:00:00Z'),
        },
      );

      const wake = jest.fn();
      // 复刻 PlatformMcpService.registerSettledHook → checkAndDrainFanOut 的口径。
      service.registerSettledHook(async (row) => {
        const pending = await service.countPendingFor({
          fromInstanceId: row.fromInstanceId,
          teamId: row.teamId,
        });
        if (pending === 0) wake();
      });

      // stale 已过期 → 被排除：此刻计数=1（只剩 fresh；未修复时 stale 计入为 2）。
      await expect(
        service.countPendingFor({ fromInstanceId: 'tmm_main', teamId: 'tm_x' }),
      ).resolves.toBe(1);

      // fresh 被 ack → settled hook → drain 计数 0 → 主 Agent 被唤醒。
      await service.ack('mr_fresh');
      await new Promise((r) => setImmediate(r));

      expect(wake).toHaveBeenCalledTimes(1);
    });
  });

  describe('countPending', () => {
    it('返回 n/N 计数（pending/total，仅计数无分析页）', async () => {
      prisma.messageReceipt.count
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(5);

      await expect(service.countPending({ taskId: 't_1' })).resolves.toEqual({
        pending: 2,
        total: 5,
      });
      expect(prisma.messageReceipt.count).toHaveBeenCalledTimes(2);
    });
  });

  describe('round 事件', () => {
    it('emitRoundComplete 广播 round.complete（team: + channel: 双订阅零丢失）', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });

      await service.emitRoundComplete({
        issueId: 'is_1',
        taskId: 't_1',
        teamId: 'tm_1',
        round: 2,
        version: 3,
        received: ['tmm_a', 'tmm_b', 'tmm_c'],
        expected: ['tmm_a', 'tmm_b', 'tmm_c'],
      });

      const scopes = realtime.broadcast.mock.calls
        .filter((c) => c[0] === EVENT_TYPES.ROUND_COMPLETE)
        .map((c) => c[2]);
      expect(scopes).toContainEqual({ type: 'team', id: 'tm_1' });
      expect(scopes).toContainEqual({ type: 'channel', id: 'c_1' });
    });

    it('emitRoundStale 广播 round.stale（含 received/expected 缺席点名）', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue(null);

      await service.emitRoundStale({
        issueId: 'is_1',
        taskId: 't_1',
        teamId: 'tm_1',
        round: 2,
        version: 3,
        received: ['tmm_a', 'tmm_b'],
        expected: ['tmm_a', 'tmm_b', 'tmm_c'],
        reason: 'timeout',
      });

      const call = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.ROUND_STALE,
      );
      expect(call?.[1]).toMatchObject({
        issueId: 'is_1',
        received: ['tmm_a', 'tmm_b'],
        expected: ['tmm_a', 'tmm_b', 'tmm_c'],
        reason: 'timeout',
      });
      expect(call?.[2]).toEqual({ type: 'team', id: 'tm_1' });
    });
  });

  describe('plan 事件', () => {
    it('emitPlanStatusChanged 广播 plan.status.<to>（team: 订阅收到翻转）', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.chatChannel.findFirst.mockResolvedValue(null);

      await service.emitPlanStatusChanged({
        taskId: 't_1',
        from: 'approved',
        to: 'executing',
      });

      const call = realtime.broadcast.mock.calls.find(
        (c) => c[0] === 'plan.status.executing',
      );
      expect(call?.[1]).toMatchObject({
        taskId: 't_1',
        teamId: 'tm_1',
        from: 'approved',
        to: 'executing',
      });
      expect(call?.[2]).toEqual({ type: 'team', id: 'tm_1' });
    });
  });
});
