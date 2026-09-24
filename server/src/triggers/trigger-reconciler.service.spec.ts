import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  HOOK_KIND,
  HOOK_STATUS,
  buildHookFireDedupKey,
} from './hook.constants';
import {
  TRIGGER_RECONCILE_BATCH_LIMIT,
  TRIGGER_RECONCILE_EVENT_TYPE,
  TRIGGER_RECONCILE_INTERVAL_MS_DEFAULT,
  TriggerReconcilerService,
} from './trigger-reconciler.service';

describe('TriggerReconcilerService（hook↔trigger 自愈，todo-3）', () => {
  let svc: TriggerReconcilerService;
  let prisma: {
    hook: { findMany: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
    trigger: {
      findMany: jest.Mock;
      create: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { emit: jest.Mock };

  const hookRow = (over: Record<string, unknown> = {}) => ({
    id: 'hks_0000000001',
    kind: HOOK_KIND.TIME,
    status: HOOK_STATUS.PENDING,
    dueAt: new Date(Date.now() + 3_600_000),
    expiresAt: new Date(Date.now() + 7_200_000),
    scopeType: 'team',
    scopeId: 'tm_1',
    ownerInstanceId: 'tmm_1',
    ...over,
  });

  const fireRow = (over: Record<string, unknown> = {}) => ({
    id: 'tmr_0000000001',
    kind: 'hook_fire',
    status: 'pending',
    dedupKey: buildHookFireDedupKey('hks_0000000001'),
    payload: { hookId: 'hks_0000000001' },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      hook: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      trigger: {
        findMany: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    idGen = { nextId: jest.fn(async () => 'tmr_0000000099'), seed: jest.fn() };
    realtime = { emit: jest.fn(async () => ({})) };
    svc = new TriggerReconcilerService(
      prisma as unknown as PrismaService,
      idGen as unknown as IdGeneratorService,
      realtime as unknown as RealtimeService,
    );
    // 默认健康空库：两方向查询皆空（各用例按需覆盖）
    prisma.hook.findMany.mockResolvedValue([]);
    prisma.trigger.findMany.mockResolvedValue([]);
    delete process.env.TRIGGER_RECONCILE_INTERVAL_MS;
  });

  afterEach(() => {
    svc.onModuleDestroy();
    delete process.env.TRIGGER_RECONCILE_INTERVAL_MS;
    jest.restoreAllMocks();
  });

  it('方向A：failed 行认领后重建 + trigger.reconcile 告警', async () => {
    const hook = hookRow();
    prisma.hook.findMany.mockResolvedValue([hook]);
    prisma.trigger.findMany.mockImplementation(async (args: unknown) => {
      const where = (
        args as { where: { dedupKey?: { in?: string[] }; kind?: string } }
      ).where;
      if (where.dedupKey?.in) {
        return [fireRow({ status: 'failed', lastError: 'boom' })];
      }
      return [];
    });
    prisma.trigger.deleteMany.mockResolvedValue({ count: 1 });
    prisma.trigger.create.mockResolvedValue({ id: 'tmr_0000000099' });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts).toEqual({ directionA: 1, directionB: 0 });
    expect(prisma.trigger.deleteMany).toHaveBeenCalledWith({
      where: { dedupKey: buildHookFireDedupKey(hook.id), status: 'failed' },
    });
    expect(prisma.trigger.create).toHaveBeenCalledTimes(1);
    const created = prisma.trigger.create.mock.calls[0][0];
    expect(created.data.dedupKey).toBe(buildHookFireDedupKey(hook.id));
    expect(created.data.payload).toEqual({ hookId: hook.id });
    expect(created.data.status).toBe('pending');
    expect(realtime.emit).toHaveBeenCalledWith(
      TRIGGER_RECONCILE_EVENT_TYPE,
      expect.objectContaining({ direction: 'A', hookId: hook.id }),
    );
  });

  it('方向A：缺失行直接重建（无 deleteMany）', async () => {
    const hook = hookRow();
    prisma.hook.findMany.mockResolvedValue([hook]);
    prisma.trigger.findMany.mockResolvedValue([]);
    prisma.trigger.create.mockResolvedValue({ id: 'tmr_0000000099' });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts.directionA).toBe(1);
    expect(prisma.trigger.deleteMany).not.toHaveBeenCalled();
    expect(prisma.trigger.create).toHaveBeenCalledTimes(1);
    expect(realtime.emit).toHaveBeenCalledTimes(1);
  });

  it('方向A：cancelled 行同缺失处理（认领后重建）', async () => {
    const hook = hookRow();
    prisma.hook.findMany.mockResolvedValue([hook]);
    prisma.trigger.findMany.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { dedupKey?: { in?: string[] } } }).where;
      return where.dedupKey?.in ? [fireRow({ status: 'cancelled' })] : [];
    });
    prisma.trigger.deleteMany.mockResolvedValue({ count: 1 });
    prisma.trigger.create.mockResolvedValue({ id: 'tmr_0000000099' });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts.directionA).toBe(1);
    expect(prisma.trigger.create).toHaveBeenCalledTimes(1);
    expect(realtime.emit).toHaveBeenCalledTimes(1);
  });

  it('方向A：pending/firing/fired 行皆健康跳过（fired 归方向B）', async () => {
    const hook = hookRow();
    prisma.hook.findMany.mockResolvedValue([
      hook,
      hookRow({ id: 'hks_0000000002' }),
      hookRow({ id: 'hks_0000000003' }),
    ]);
    prisma.trigger.findMany.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { dedupKey?: { in?: string[] } } }).where;
      if (!where.dedupKey?.in) return [];
      return [
        fireRow({ status: 'pending' }),
        fireRow({
          id: 'tmr_0000000002',
          status: 'firing',
          dedupKey: buildHookFireDedupKey('hks_0000000002'),
          payload: { hookId: 'hks_0000000002' },
        }),
        fireRow({
          id: 'tmr_0000000003',
          status: 'fired',
          dedupKey: buildHookFireDedupKey('hks_0000000003'),
          payload: { hookId: 'hks_0000000003' },
        }),
      ];
    });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts.directionA).toBe(0);
    expect(prisma.trigger.create).not.toHaveBeenCalled();
    expect(realtime.emit).not.toHaveBeenCalled();
  });

  it('方向A：已过期 hook 直接 claim-expire，不重建 fire 行', async () => {
    const hook = hookRow({ expiresAt: new Date(Date.now() - 1000) });
    prisma.hook.findMany.mockResolvedValue([hook]);
    prisma.trigger.findMany.mockResolvedValue([]);
    prisma.hook.updateMany.mockResolvedValue({ count: 1 });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts.directionA).toBe(1);
    expect(prisma.hook.updateMany).toHaveBeenCalledWith({
      where: { id: hook.id, status: 'pending' },
      data: expect.objectContaining({ status: 'expired' }),
    });
    expect(prisma.trigger.create).not.toHaveBeenCalled();
    expect(realtime.emit).toHaveBeenCalledWith(
      TRIGGER_RECONCILE_EVENT_TYPE,
      expect.objectContaining({ direction: 'A', action: 'expired' }),
    );
  });

  it('方向B：fired 行 + pending time hook → hook 补结算 fired + 事件', async () => {
    const row = fireRow({ status: 'fired' });
    prisma.trigger.findMany.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { kind?: string; dedupKey?: unknown } })
        .where;
      return where.kind ? [row] : [];
    });
    prisma.hook.findUnique.mockResolvedValue(hookRow());
    prisma.hook.updateMany.mockResolvedValue({ count: 1 });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts).toEqual({ directionA: 0, directionB: 1 });
    expect(prisma.hook.updateMany).toHaveBeenCalledWith({
      where: { id: 'hks_0000000001', status: 'pending' },
      data: expect.objectContaining({ status: 'fired' }),
    });
    expect(realtime.emit).toHaveBeenCalledWith(
      TRIGGER_RECONCILE_EVENT_TYPE,
      expect.objectContaining({ direction: 'B', action: 'settled-fired' }),
    );
  });

  it('方向B：all_idle 的 fired+pending 系正常态（poll 拥有唤醒权），跳过', async () => {
    const row = fireRow({ status: 'fired' });
    prisma.trigger.findMany.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { kind?: string; dedupKey?: unknown } })
        .where;
      return where.kind ? [row] : [];
    });
    prisma.hook.findUnique.mockResolvedValue(
      hookRow({ kind: HOOK_KIND.ALL_IDLE }),
    );

    const counts = await svc.reconcileOnce(new Date());

    expect(counts.directionB).toBe(0);
    expect(prisma.hook.updateMany).not.toHaveBeenCalled();
    expect(realtime.emit).not.toHaveBeenCalled();
  });

  it('方向B：hook 已终态/缺失/payload 无 hookId 皆跳过', async () => {
    prisma.trigger.findMany.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { kind?: string; dedupKey?: unknown } })
        .where;
      return where.kind
        ? [
            fireRow({ id: 'tmr_a', payload: { hookId: 'hks_a' } }),
            fireRow({
              id: 'tmr_b',
              payload: { hookId: 'hks_b' },
              dedupKey: 'hook_fire:hook:hks_b',
            }),
            fireRow({ id: 'tmr_c', payload: {} }),
          ]
        : [];
    });
    prisma.hook.findUnique.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id: string } }).where.id;
      if (id === 'hks_a') return hookRow({ id, status: 'fired' });
      return null;
    });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts.directionB).toBe(0);
    expect(prisma.hook.updateMany).not.toHaveBeenCalled();
    expect(realtime.emit).not.toHaveBeenCalled();
  });

  it('幂等：修复后第二 pass 无查询外写入（no-op）', async () => {
    const hook = hookRow();
    // 首 pass：缺失 → 重建
    prisma.hook.findMany.mockResolvedValue([hook]);
    prisma.trigger.findMany.mockResolvedValue([]);
    prisma.trigger.create.mockResolvedValue({ id: 'tmr_0000000099' });
    const first = await svc.reconcileOnce(new Date());
    expect(first.directionA).toBe(1);
    expect(prisma.trigger.create).toHaveBeenCalledTimes(1);

    // 次 pass：库态已收敛（fire 行 pending）→ 零写入零事件
    prisma.trigger.create.mockClear();
    realtime.emit.mockClear();
    prisma.trigger.findMany.mockImplementation(async (args: unknown) => {
      const where = (
        args as { where: { dedupKey?: { in?: string[] }; kind?: string } }
      ).where;
      if (where.dedupKey?.in) return [fireRow({ status: 'pending' })];
      return [];
    });
    const second = await svc.reconcileOnce(new Date());
    expect(second).toEqual({ directionA: 0, directionB: 0 });
    expect(prisma.trigger.create).not.toHaveBeenCalled();
    expect(realtime.emit).not.toHaveBeenCalled();
  });

  it('分页：两方向查询皆 take=500 封顶', async () => {
    await svc.reconcileOnce(new Date());
    expect(prisma.hook.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: TRIGGER_RECONCILE_BATCH_LIMIT }),
    );
    expect(TRIGGER_RECONCILE_BATCH_LIMIT).toBe(500);
    expect(prisma.trigger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: TRIGGER_RECONCILE_BATCH_LIMIT }),
    );
  });

  it('claim：并发败者（deleteMany/updateMany count=0）零重建零事件', async () => {
    const hookA = hookRow({ id: 'hks_0000000001' });
    prisma.hook.findMany.mockResolvedValue([hookA]);
    prisma.trigger.findMany.mockImplementation(async (args: unknown) => {
      const where = (
        args as { where: { dedupKey?: { in?: string[] }; kind?: string } }
      ).where;
      if (where.dedupKey?.in) return [fireRow({ status: 'failed' })];
      return [
        fireRow({
          id: 'tmr_b',
          status: 'fired',
          dedupKey: 'hook_fire:hook:hks_b',
          payload: { hookId: 'hks_b' },
        }),
      ];
    });
    prisma.trigger.deleteMany.mockResolvedValue({ count: 0 });
    prisma.hook.findUnique.mockResolvedValue(hookRow({ id: 'hks_b' }));
    prisma.hook.updateMany.mockResolvedValue({ count: 0 });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts).toEqual({ directionA: 0, directionB: 0 });
    expect(prisma.trigger.create).not.toHaveBeenCalled();
    expect(realtime.emit).not.toHaveBeenCalled();
  });

  it('缺失行并发：P2002 即败者静默跳过（不抛不计数）', async () => {
    const hook = hookRow();
    prisma.hook.findMany.mockResolvedValue([hook]);
    prisma.trigger.findMany.mockResolvedValue([]);
    prisma.trigger.create.mockRejectedValue({ code: 'P2002' });

    const counts = await svc.reconcileOnce(new Date());

    expect(counts.directionA).toBe(0);
    expect(realtime.emit).not.toHaveBeenCalled();
  });

  it('reconcileOnce 永不抛（查询失败回零，tick 不死）', async () => {
    prisma.hook.findMany.mockRejectedValue(new Error('db down'));
    prisma.trigger.findMany.mockRejectedValue(new Error('db down'));

    await expect(svc.reconcileOnce(new Date())).resolves.toEqual({
      directionA: 0,
      directionB: 0,
    });
  });

  it('启动 pass 跑在首个周期之前（onModuleInit 先 await 自愈再起 interval）', async () => {
    const order: string[] = [];
    const reconcileSpy = jest
      .spyOn(svc, 'reconcileOnce')
      .mockImplementation(async () => {
        order.push('reconcile');
        return { directionA: 0, directionB: 0 };
      });
    const realSetInterval = global.setInterval;
    (global as unknown as { setInterval: unknown }).setInterval = (
      ...args: [Parameters<typeof setInterval>[0], number]
    ): NodeJS.Timeout => {
      order.push('interval');
      return realSetInterval(...args);
    };
    try {
      await svc.onModuleInit();
    } finally {
      (global as unknown as { setInterval: unknown }).setInterval =
        realSetInterval;
    }

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['reconcile', 'interval']);
    expect(
      (svc as unknown as { reconcileTimer: unknown }).reconcileTimer,
    ).not.toBeNull();
  });

  it('周期缺省 15min；env=0 停周期但启动 pass 照跑', async () => {
    expect(TRIGGER_RECONCILE_INTERVAL_MS_DEFAULT).toBe(15 * 60_000);
    const reconcileSpy = jest
      .spyOn(svc, 'reconcileOnce')
      .mockResolvedValue({ directionA: 0, directionB: 0 });
    process.env.TRIGGER_RECONCILE_INTERVAL_MS = '0';
    await svc.onModuleInit();
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(
      (svc as unknown as { reconcileTimer: unknown }).reconcileTimer,
    ).toBeNull();
  });
});
