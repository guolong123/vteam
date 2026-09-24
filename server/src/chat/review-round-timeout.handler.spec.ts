import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { TriggerService } from '../timers/trigger.service';
import { ReviewRoundGateService } from '../issues/review-round-gate.service';
import { createLedger, embedLedger } from '../issues/review-round-ledger';
import {
  REVIEW_ROUND_TIMEOUT_KIND,
  ReviewRoundTimeoutHandler,
  buildReviewRoundTimeoutDedupKey,
} from './review-round-timeout.handler';

describe('ReviewRoundTimeoutHandler（超时→stale 消费者）', () => {
  let handler: ReviewRoundTimeoutHandler;
  let prisma: { issue: { findUnique: jest.Mock } };
  let timers: { registerHandler: jest.Mock };
  let gate: { checkTimeout: jest.Mock };

  const issueId = 'is_0000000007';

  function ledgerDescription(status: 'collecting' | 'complete' | 'stale') {
    return embedLedger(
      '人类可读标题',
      createLedger({
        round: 2,
        planVersion: { version: 'v0.3', hash: 'abcd1234' },
        taskId: 't_0000000001',
        issueId,
        expected: ['tmm_arch', 'tmm_dev'],
        status,
        timeoutAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
  }

  beforeEach(async () => {
    prisma = { issue: { findUnique: jest.fn() } };
    timers = { registerHandler: jest.fn() };
    gate = { checkTimeout: jest.fn().mockResolvedValue({ stale: true }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewRoundTimeoutHandler,
        { provide: PrismaService, useValue: prisma },
        { provide: TriggerService, useValue: timers },
        { provide: ReviewRoundGateService, useValue: gate },
      ],
    }).compile();

    handler = module.get(ReviewRoundTimeoutHandler);
    jest
      .spyOn(
        (handler as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((() => undefined) as unknown as jest.Mock);
  });

  it('onModuleInit 注册 review_round_timeout handler', () => {
    handler.onModuleInit();

    expect(timers.registerHandler).toHaveBeenCalledTimes(1);
    expect(timers.registerHandler).toHaveBeenCalledWith(
      REVIEW_ROUND_TIMEOUT_KIND,
      expect.any(Function),
    );
  });

  it('dedupKey 口径 kind:scope:id', () => {
    expect(buildReviewRoundTimeoutDedupKey(issueId, 2)).toBe(
      `review_round_timeout:${issueId}:2`,
    );
  });

  it('payload 缺 issueId → no-op（gate 不调用，不抛错）', async () => {
    await handler.handle({
      id: 'tmr_1',
      kind: REVIEW_ROUND_TIMEOUT_KIND,
      payload: {},
    });

    expect(gate.checkTimeout).not.toHaveBeenCalled();
    expect(prisma.issue.findUnique).not.toHaveBeenCalled();
  });

  it('无账本机器段 → no-op', async () => {
    prisma.issue.findUnique.mockResolvedValue({
      id: issueId,
      description: '纯人类文本',
    });

    await handler.handle({
      id: 'tmr_1',
      kind: REVIEW_ROUND_TIMEOUT_KIND,
      payload: { issueId },
    });

    expect(gate.checkTimeout).not.toHaveBeenCalled();
  });

  it.each([['complete'], ['stale']])(
    '账本 status=%s → no-op（不委托 gate）',
    async (status: string) => {
      prisma.issue.findUnique.mockResolvedValue({
        id: issueId,
        description: ledgerDescription(status as 'complete' | 'stale'),
      });

      await handler.handle({
        id: 'tmr_1',
        kind: REVIEW_ROUND_TIMEOUT_KIND,
        payload: { issueId },
      });

      expect(gate.checkTimeout).not.toHaveBeenCalled();
    },
  );

  it('collecting → 委托 gate.checkTimeout（stale 逻辑不复刻）', async () => {
    prisma.issue.findUnique.mockResolvedValue({
      id: issueId,
      description: ledgerDescription('collecting'),
    });

    await handler.handle({
      id: 'tmr_1',
      kind: REVIEW_ROUND_TIMEOUT_KIND,
      payload: { issueId, taskId: 't_0000000001', round: 2 },
    });

    expect(gate.checkTimeout).toHaveBeenCalledTimes(1);
    expect(gate.checkTimeout).toHaveBeenCalledWith(issueId, expect.any(Date));
  });

  it('F2#6：payload.round 与账本轮次不一致 → 不委托 gate（旧 timer 不越权）', async () => {
    prisma.issue.findUnique.mockResolvedValue({
      id: issueId,
      description: ledgerDescription('collecting'),
    });

    await handler.handle({
      id: 'tmr_1',
      kind: REVIEW_ROUND_TIMEOUT_KIND,
      payload: { issueId, taskId: 't_0000000001', round: 1 },
    });

    expect(gate.checkTimeout).not.toHaveBeenCalled();
  });

  it('gate 抛错 → handle 不抛（warn 吞掉，timer 行由 TriggerService 记 failed）', async () => {
    prisma.issue.findUnique.mockResolvedValue({
      id: issueId,
      description: ledgerDescription('collecting'),
    });
    gate.checkTimeout.mockRejectedValueOnce(new Error('db down'));

    await expect(
      handler.handle({
        id: 'tmr_1',
        kind: REVIEW_ROUND_TIMEOUT_KIND,
        payload: { issueId },
      }),
    ).resolves.toEqual({ done: true });
  });

  it('gate 未装配 → warn 后 no-op，不抛错', async () => {
    const bare: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewRoundTimeoutHandler,
        { provide: PrismaService, useValue: prisma },
        { provide: TriggerService, useValue: timers },
      ],
    }).compile();
    const bareHandler = bare.get(ReviewRoundTimeoutHandler);
    prisma.issue.findUnique.mockResolvedValue({
      id: issueId,
      description: ledgerDescription('collecting'),
    });

    await expect(
      bareHandler.handle({
        id: 'tmr_1',
        kind: REVIEW_ROUND_TIMEOUT_KIND,
        payload: { issueId },
      }),
    ).resolves.toEqual({ done: true });
  });
});
