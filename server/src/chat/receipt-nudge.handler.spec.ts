import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TimerService } from '../timers/trigger.service';
import { MessageReceiptsService } from './message-receipts.service';
import {
  buildAutoNudgeText,
  buildEscalationNotice,
  buildReceiptNudgeDedupKey,
  MAX_AUTO_NUDGES,
  normalizeReceiptTimeoutMin,
  RECEIPT_NUDGE_KIND,
  RECEIPT_TIMEOUT_DEFAULT_MIN,
  ReceiptNudgeHandler,
} from './receipt-nudge.handler';
import { WorkerDispatcher } from './worker-dispatcher';

describe('normalizeReceiptTimeoutMin（缺省 30，夹取 [1,1440]，非法回缺省永不抛）', () => {
  it.each([[undefined], [null], [NaN], ['abc'], [{}], [Infinity]])(
    '非法输入 %p → 缺省 30',
    (input: unknown) => {
      expect(normalizeReceiptTimeoutMin(input)).toBe(
        RECEIPT_TIMEOUT_DEFAULT_MIN,
      );
    },
  );

  it.each([[0], [-1], [-100]])(
    '非正数 %p → 缺省 30（非夹到 1）',
    (n: number) => {
      expect(normalizeReceiptTimeoutMin(n)).toBe(RECEIPT_TIMEOUT_DEFAULT_MIN);
    },
  );

  it('合法值原样（小数下取整）', () => {
    expect(normalizeReceiptTimeoutMin(5)).toBe(5);
    expect(normalizeReceiptTimeoutMin(1)).toBe(1);
    expect(normalizeReceiptTimeoutMin(1440)).toBe(1440);
    expect(normalizeReceiptTimeoutMin(2.7)).toBe(2);
    expect(normalizeReceiptTimeoutMin('30')).toBe(30);
  });

  it('超上限夹到 1440', () => {
    expect(normalizeReceiptTimeoutMin(1441)).toBe(1440);
    expect(normalizeReceiptTimeoutMin(100000)).toBe(1440);
  });

  it('dedupKey 格式 kind:scope:id', () => {
    expect(buildReceiptNudgeDedupKey('tm_1', 'mr_9')).toBe(
      'receipt_nudge:tm_1:mr_9',
    );
  });
});

describe('ReceiptNudgeHandler（平台回执自动催办，chat 域注册）', () => {
  let handler: ReceiptNudgeHandler;
  let prisma: {
    messageReceipt: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      // MessageReceiptsService.onModuleInit 的 mr_ 前缀续号扫描
      findMany: jest.Mock;
      update: jest.Mock;
    };
    chatChannel: { findFirst: jest.Mock };
  };
  let timers: { registerHandler: jest.Mock };
  let receipts: MessageReceiptsService;
  let realtime: { broadcast: jest.Mock };
  let workerDispatcher: { dispatchAgentMention: jest.Mock };
  let registeredKind: string | null;
  let registeredFn: ((t: unknown) => Promise<void>) | null;

  const payload = {
    receiptId: 'mr_1',
    teamId: 'tm_1',
    taskId: 't_1',
    channelId: 'c_1',
    messageId: 'm_1',
    fromInstanceId: 'tmm_pm',
    toInstanceId: 'tmm_dev',
    assigneeName: '开发者',
  };

  beforeEach(async () => {
    prisma = {
      messageReceipt: {
        findUnique: jest.fn(),
        // 缺省：无冷却命中、无同消息催办记录（两条防线均放行）
        findFirst: jest.fn().mockResolvedValue(null),
        // 缺省：无既有 mr_ 行（续号扫描空结果）
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      chatChannel: { findFirst: jest.fn() },
    };
    registeredKind = null;
    registeredFn = null;
    timers = {
      registerHandler: jest.fn(
        (kind: string, fn: (t: unknown) => Promise<void>) => {
          registeredKind = kind;
          registeredFn = fn;
        },
      ),
    };
    realtime = { broadcast: jest.fn() };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiptNudgeHandler,
        MessageReceiptsService,
        { provide: PrismaService, useValue: prisma },
        { provide: TimerService, useValue: timers },
        { provide: RealtimeService, useValue: realtime },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
      ],
    }).compile();
    await module.init();

    handler = module.get(ReceiptNudgeHandler);
    receipts = module.get(MessageReceiptsService);
  });

  it('onModuleInit 以 receipt_nudge kind 注册 handler', () => {
    expect(registeredKind).toBe(RECEIPT_NUDGE_KIND);
    expect(typeof registeredFn).toBe('function');
  });

  it('MAX_AUTO_NUDGES 为 1（单次催办后即升级）', () => {
    expect(MAX_AUTO_NUDGES).toBe(1);
  });

  it('回执行缺失 → 静默 no-op（零分派零写库）', async () => {
    prisma.messageReceipt.findUnique.mockResolvedValue(null);

    await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(prisma.messageReceipt.update).not.toHaveBeenCalled();
  });

  it.each([['acked'], ['expired']])(
    '回执已 %s → 静默 no-op（ack-race 安全：ack 早 1 秒也零催办）',
    async (status: string) => {
      prisma.messageReceipt.findUnique.mockResolvedValue({
        id: 'mr_1',
        status,
        nudgeCount: 0,
      });

      await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.messageReceipt.update).not.toHaveBeenCalled();
    },
  );

  it('pending + 未催办过 → 恰一次 nudge（kind=nudge）+ nudgeCount++', async () => {
    prisma.messageReceipt.findUnique.mockResolvedValue({
      id: 'mr_1',
      messageId: 'm_1',
      taskId: 't_1',
      teamId: 'tm_1',
      fromInstanceId: 'tmm_pm',
      toInstanceId: 'tmm_dev',
      status: 'pending',
      nudgeCount: 0,
      createdAt: new Date(Date.now() - 7 * 60 * 1000),
    });
    prisma.messageReceipt.update.mockImplementation(
      ({ data }: { data: unknown }) =>
        Promise.resolve({
          id: 'mr_1',
          nudgeCount: 1,
          ...((data as object) ?? {}),
        }),
    );

    await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    const call = workerDispatcher.dispatchAgentMention.mock.calls[0][0] as {
      kind: string;
      text: string;
      targetInstanceId: string;
    };
    expect(call.kind).toBe('nudge');
    expect(call.targetInstanceId).toBe('tmm_dev');
    expect(call.text).toContain('m_1');
    expect(call.text).toContain('平台自动催办');
    expect(call.text).toContain('第1次');
    expect(call.text).toContain('7 分钟');
    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mr_1' },
        data: expect.objectContaining({ nudgeCount: { increment: 1 } }),
      }),
    );
  });

  it('pending + 已自动催办过 → expired + 升级通知 + 不分派 + 不排新 timer', async () => {
    prisma.messageReceipt.findUnique.mockResolvedValue({
      id: 'mr_1',
      messageId: 'm_1',
      taskId: 't_1',
      teamId: 'tm_1',
      fromInstanceId: 'tmm_pm',
      toInstanceId: 'tmm_dev',
      status: 'pending',
      nudgeCount: 1,
      createdAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    prisma.messageReceipt.update.mockImplementation(
      ({ data }: { data: unknown }) =>
        Promise.resolve({ id: 'mr_1', ...((data as object) ?? {}) }),
    );
    prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
    const scheduleSpy = jest.fn();

    await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'mr_1' },
        data: expect.objectContaining({ status: 'expired' }),
      }),
    );
    const expiredCall = realtime.broadcast.mock.calls.find(
      (c) => c[0] === EVENT_TYPES.RECEIPT_EXPIRED && c[2]?.type === 'team',
    );
    expect(expiredCall?.[2]).toEqual({ type: 'team', id: 'tm_1' });
    expect(expiredCall?.[1]).toMatchObject({
      receiptId: 'mr_1',
      messageId: 'm_1',
      status: 'expired',
      notice: '【自动催办】tmm_pm → 开发者：已自动催办1次仍无回执，请升级处理',
    });
  });

  it('payload 缺 receiptId → warn 后返回（不重排）', async () => {
    const warnSpy = jest
      .spyOn(
        (handler as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((() => undefined) as unknown as jest.Mock);

    await handler.handle({
      id: 'tmr_x',
      kind: RECEIPT_NUDGE_KIND,
      payload: {},
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(prisma.messageReceipt.findUnique).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  describe('催办去重（按人冷却 + 同消息幂等）', () => {
    const pendingRow = () => ({
      id: 'mr_1',
      messageId: 'm_1',
      taskId: 't_1',
      teamId: 'tm_1',
      fromInstanceId: 'tmm_pm',
      toInstanceId: 'tmm_dev',
      status: 'pending',
      nudgeCount: 0,
      createdAt: new Date(),
    });

    it('同被指派人冷却期内已催过 → 跳过（防连环 call）', async () => {
      prisma.messageReceipt.findUnique.mockResolvedValue(pendingRow());
      prisma.messageReceipt.findFirst.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            where.toInstanceId || where.lastNudgedAt ? { id: 'mr_9' } : null,
          ),
      );

      await handler.handle({
        id: 'tmr_a',
        kind: RECEIPT_NUDGE_KIND,
        payload: { ...payload },
      });

      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.messageReceipt.update).not.toHaveBeenCalled();
    });

    it('冷却窗口外 → 允许新催办（不永久静音）', async () => {
      prisma.messageReceipt.findUnique.mockResolvedValue(pendingRow());
      prisma.messageReceipt.findFirst.mockResolvedValue(null);

      await handler.handle({
        id: 'tmr_b',
        kind: RECEIPT_NUDGE_KIND,
        payload: { ...payload },
      });

      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    });

    it('同 messageId 已被兄弟回执行催办过 → 跳过（同消息永不再推）', async () => {
      prisma.messageReceipt.findUnique.mockResolvedValue(pendingRow());
      prisma.messageReceipt.findFirst.mockImplementation(
        ({ where }: { where: { messageId?: string } }) =>
          Promise.resolve(where.messageId ? { id: 'mr_sibling' } : null),
      );

      await handler.handle({
        id: 'tmr_c',
        kind: RECEIPT_NUDGE_KIND,
        payload: { ...payload },
      });

      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('冷却查询失败 → fail-open（不阻断正常催办）', async () => {
      prisma.messageReceipt.findUnique.mockResolvedValue(pendingRow());
      prisma.messageReceipt.findFirst.mockRejectedValue(new Error('db down'));

      await handler.handle({
        id: 'tmr_d',
        kind: RECEIPT_NUDGE_KIND,
        payload: { ...payload },
      });

      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    });
  });

  it('recordAutoNudge 走 receipts-service 模式（increment + lastNudgedAt）', async () => {
    prisma.messageReceipt.update.mockImplementation(
      ({ data }: { data: unknown }) =>
        Promise.resolve({ id: 'mr_1', ...((data as object) ?? {}) }),
    );

    await receipts.recordAutoNudge('mr_1');

    expect(prisma.messageReceipt.update).toHaveBeenCalledWith({
      where: { id: 'mr_1' },
      data: expect.objectContaining({
        nudgeCount: { increment: 1 },
        lastNudgedAt: expect.any(Date),
      }),
    });
  });

  it('催办文案/升级文案引用 messageId、次数与来源→目标（平台断言时长，agent 永不自断言）', () => {
    const text = buildAutoNudgeText({
      messageId: 'm_42',
      receiptId: 'mr_7',
      attempt: 1,
      elapsedMin: 10,
      fromLabel: '项目经理-1',
      toLabel: '开发者-1',
    });
    expect(text).toContain('m_42');
    expect(text).toContain('项目经理-1 → 开发者-1');
    expect(buildEscalationNotice(1)).toBe(
      '【自动催办】已自动催办1次仍无回执，请升级处理',
    );
    expect(buildEscalationNotice(1, '项目经理-1', '开发者-1')).toBe(
      '【自动催办】项目经理-1 → 开发者-1：已自动催办1次仍无回执，请升级处理',
    );
  });
});
