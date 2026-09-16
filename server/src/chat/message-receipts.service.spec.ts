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
