// ticker 在单测中禁用（TIMER_SCAN_INTERVAL_MS=0；ensureTicker 惰性读 env，
// import 之后设置依然有效；schedule 仍走完整落库分支）。
process.env.TIMER_SCAN_INTERVAL_MS = '0';

import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { TRIGGER_STATUS, TriggerService } from './trigger.service';

type PrismaMock = {
  timer: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  trigger: PrismaMock['timer'];
};

function makePrisma(): PrismaMock {
  const delegate = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  // trigger 改名过渡：service 走 prisma.trigger，断言沿用 prisma.timer（同 mock 引用）
  return { timer: delegate, trigger: delegate };
}

function makeIdGen() {
  return {
    nextId: jest.fn(async (prefix: string) => `${prefix}_0000000001`),
    seed: jest.fn(),
  };
}

function makeService(prisma?: PrismaMock) {
  const p = prisma ?? makePrisma();
  const idGen = makeIdGen();
  const svc = new TriggerService(
    p as unknown as PrismaService,
    idGen as unknown as IdGeneratorService,
  );
  return { svc, prisma: p, idGen };
}

const NOW = new Date('2026-09-16T00:00:00.000Z');
const PAST = new Date('2026-09-15T00:00:00.000Z');
const FUTURE = new Date('2026-09-17T00:00:00.000Z');

function dueRow(over: Record<string, unknown> = {}) {
  return {
    id: 'tmr_0000000001',
    kind: 'test_kind',
    status: TRIGGER_STATUS.PENDING,
    dueAt: PAST,
    intervalMs: null,
    nextFireAt: null,
    guardKey: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: null,
    payload: { hello: 'world' },
    dedupKey: 'test_kind:scope:1',
    attempts: 0,
    ...over,
  };
}

describe('TriggerService（通用定时器基础设施，mocked PrismaService，无 DB）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('schedule', () => {
    it('落 pending 行（tmr_ id + dedupKey + dueAt/fireAt 双写 + payload 透传）', async () => {
      const { svc, prisma, idGen } = makeService();
      prisma.timer.findUnique.mockResolvedValue(null);
      prisma.timer.create.mockImplementation(async ({ data }: any) => ({
        ...data,
        createdAt: NOW,
        updatedAt: NOW,
      }));

      const out = await svc.schedule(
        'receipt_nudge',
        FUTURE,
        { hello: 'world' },
        'test_kind:scope:1',
      );

      expect(idGen.nextId).toHaveBeenCalledWith('tmr');
      expect(prisma.timer.create).toHaveBeenCalledTimes(1);
      expect(prisma.timer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'tmr_0000000001',
          kind: 'receipt_nudge',
          status: TRIGGER_STATUS.PENDING,
          fireAt: FUTURE,
          dueAt: FUTURE,
          payload: { hello: 'world' },
          dedupKey: 'test_kind:scope:1',
          attempts: 0,
        }),
      });
      expect(out).toMatchObject({ id: 'tmr_0000000001' });
      svc.onModuleDestroy();
    });

    it('dedup 命中 → 返回既有行且不再 create（幂等重排）', async () => {
      const { svc, prisma } = makeService();
      const existing = dueRow({ status: TRIGGER_STATUS.PENDING });
      prisma.timer.findUnique.mockResolvedValue(existing);

      const out = await svc.schedule(
        'receipt_nudge',
        FUTURE,
        { hello: 'world' },
        'test_kind:scope:1',
      );

      expect(prisma.timer.findUnique).toHaveBeenCalledWith({
        where: { dedupKey: 'test_kind:scope:1' },
      });
      expect(prisma.timer.create).not.toHaveBeenCalled();
      expect(out).toBe(existing);
      svc.onModuleDestroy();
    });

    it('并发竞态 create 撞 P2002 → 回读返回胜者行（幂等仍成立）', async () => {
      const { svc, prisma } = makeService();
      const winner = dueRow({ status: TRIGGER_STATUS.PENDING });
      prisma.timer.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      prisma.timer.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
        }),
      );

      const out = await svc.schedule(
        'receipt_nudge',
        FUTURE,
        { hello: 'world' },
        'test_kind:scope:1',
      );

      expect(out).toBe(winner);
      expect(prisma.timer.findUnique).toHaveBeenLastCalledWith({
        where: { dedupKey: 'test_kind:scope:1' },
      });
      svc.onModuleDestroy();
    });
  });

  describe('cancel', () => {
    it('按 id 取消 → status=cancelled', async () => {
      const { svc, prisma } = makeService();
      prisma.timer.update.mockResolvedValue(
        dueRow({ status: TRIGGER_STATUS.CANCELLED }),
      );

      await svc.cancel('tmr_0000000001');

      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: { status: TRIGGER_STATUS.CANCELLED },
      });
      svc.onModuleDestroy();
    });

    it('id 未命中（P2025）→ 回退按 dedupKey 取消', async () => {
      const { svc, prisma } = makeService();
      const notFound = Object.assign(new Error('not found'), {
        code: 'P2025',
      });
      prisma.timer.update
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce(dueRow({ status: TRIGGER_STATUS.CANCELLED }));

      await svc.cancel('test_kind:scope:1');

      expect(prisma.timer.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'test_kind:scope:1' },
        data: { status: TRIGGER_STATUS.CANCELLED },
      });
      expect(prisma.timer.update).toHaveBeenNthCalledWith(2, {
        where: { dedupKey: 'test_kind:scope:1' },
        data: { status: TRIGGER_STATUS.CANCELLED },
      });
      svc.onModuleDestroy();
    });
  });

  describe('fireDue', () => {
    it('只取 due+pending 行并按 dueAt 升序触发（handler 按序调用）', async () => {
      const { svc, prisma } = makeService();
      const first = dueRow({
        id: 'tmr_0000000001',
        dueAt: new Date('2026-09-14T00:00:00.000Z'),
      });
      const second = dueRow({
        id: 'tmr_0000000002',
        dueAt: new Date('2026-09-15T00:00:00.000Z'),
        dedupKey: 'test_kind:scope:2',
      });
      prisma.timer.findMany.mockResolvedValue([first, second]);
      prisma.timer.updateMany.mockResolvedValue({ count: 1 });
      prisma.timer.update.mockImplementation(async ({ data }: any) => data);
      const seen: string[] = [];
      svc.registerHandler('test_kind', async (t) => {
        seen.push(t.id);
      });

      await svc.fireDue(NOW);

      // 查询口径：pending + due_at IS NOT NULL + dueAt<=now（cancelled/未来/NULL 行天然排除）+ dueAt 升序 + LIMIT 100
      expect(prisma.timer.findMany).toHaveBeenCalledWith({
        where: {
          status: TRIGGER_STATUS.PENDING,
          dueAt: { not: null, lte: NOW },
        },
        orderBy: { dueAt: 'asc' },
        take: 100,
      });
      expect(seen).toEqual(['tmr_0000000001', 'tmr_0000000002']);
      // 成功 → fired
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.FIRED,
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
        },
      });
      svc.onModuleDestroy();
    });

    it('due_at=NULL 即使旧 fire_at 已过期也不回退触发', async () => {
      const { svc, prisma } = makeService();
      prisma.timer.findMany.mockResolvedValue([
        dueRow({ dueAt: null, fireAt: PAST }),
      ]);
      prisma.timer.updateMany.mockResolvedValue({ count: 1 });
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);

      const out = await svc.fireDue(NOW);

      expect(handler).not.toHaveBeenCalled();
      expect(prisma.timer.updateMany).not.toHaveBeenCalled();
      expect(prisma.timer.update).not.toHaveBeenCalled();
      expect(out).toEqual([]);
      svc.onModuleDestroy();
    });

    it('重叠 claim（updateMany count=0）→ handler 不调用', async () => {
      const { svc, prisma } = makeService();
      prisma.timer.findMany.mockResolvedValue([dueRow()]);
      prisma.timer.updateMany.mockResolvedValue({ count: 0 });
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);

      const out = await svc.fireDue(NOW);

      expect(handler).not.toHaveBeenCalled();
      expect(prisma.timer.update).not.toHaveBeenCalled();
      expect(out).toEqual([]);
      svc.onModuleDestroy();
    });

    it('handler 抛错 → failed + lastError（tick 不抛错）', async () => {
      const { svc, prisma } = makeService();
      prisma.timer.findMany.mockResolvedValue([dueRow()]);
      prisma.timer.updateMany.mockResolvedValue({ count: 1 });
      prisma.timer.update.mockImplementation(async ({ data }: any) => data);
      svc.registerHandler('test_kind', async () => {
        throw new Error('boom-nudge-failed');
      });

      await expect(svc.fireDue(NOW)).resolves.not.toThrow();

      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.FAILED,
          lastError: 'boom-nudge-failed',
          attempts: { increment: 1 },
        },
      });
      svc.onModuleDestroy();
    });

    it('无注册 handler → failed + no-handler lastError（大声暴露缺失消费者）', async () => {
      const { svc, prisma } = makeService();
      prisma.timer.findMany.mockResolvedValue([
        dueRow({ kind: 'receipt_nudge' }),
      ]);
      prisma.timer.updateMany.mockResolvedValue({ count: 1 });
      prisma.timer.update.mockImplementation(async ({ data }: any) => data);
      // 故意不 registerHandler('receipt_nudge')

      await svc.fireDue(NOW);

      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.FAILED,
          lastError: 'no handler for kind receipt_nudge',
          attempts: { increment: 1 },
        },
      });
      svc.onModuleDestroy();
    });

    it('cancelled 行永不触发（查询口径限定 pending）', async () => {
      const { svc, prisma } = makeService();
      prisma.timer.findMany.mockResolvedValue([]);
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);

      await svc.fireDue(NOW);

      const where = prisma.timer.findMany.mock.calls[0][0].where;
      expect(where.status).toBe(TRIGGER_STATUS.PENDING);
      expect(handler).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    });

    it('单行坏数据不杀死本轮（其余行照常触发）', async () => {
      const { svc, prisma } = makeService();
      const bad = dueRow({ id: 'tmr_bad', dedupKey: 'test_kind:scope:bad' });
      const good = dueRow({ id: 'tmr_good', dedupKey: 'test_kind:scope:good' });
      prisma.timer.findMany.mockResolvedValue([bad, good]);
      prisma.timer.updateMany.mockImplementation(async ({ where }: any) => ({
        count: where.id === 'tmr_good' ? 1 : 0,
      }));
      // good 行 claim 成功但终态 update 抛错 → 本轮记日志后继续（方法不 reject）
      prisma.timer.update.mockRejectedValueOnce(new Error('db gone'));
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);

      await expect(svc.fireDue(NOW)).resolves.not.toThrow();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tmr_good' }),
      );
      svc.onModuleDestroy();
    });
  });

  describe('onModuleInit eager ticker（todo-1 重启证明）', () => {
    const OLD_ENV = process.env.TIMER_SCAN_INTERVAL_MS;

    afterEach(() => {
      process.env.TIMER_SCAN_INTERVAL_MS = OLD_ENV;
    });

    it('重启场景：onModuleInit 后无需 schedule()，过期 pending 行被 ticker 拾取 → fired', async () => {
      process.env.TIMER_SCAN_INTERVAL_MS = '30000';
      const { svc, prisma } = makeService();
      const overdue = dueRow({ dueAt: PAST });
      // resync 查询（where.id.startsWith）→ 空；fireDue 查询（where.status）→ 过期行
      prisma.timer.findMany.mockImplementation(async (args: any) => {
        if (args?.where?.id?.startsWith !== undefined) {
          return [];
        }
        return [overdue];
      });
      prisma.timer.updateMany.mockResolvedValue({ count: 1 });
      prisma.timer.update.mockImplementation(async ({ data }: any) => data);
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);

      await svc.onModuleInit();
      // 模拟 ticker 的一次 tick（不断言内部 scanTimer，只驱动公开 fireDue）
      await svc.fireDue(NOW);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tmr_0000000001', kind: 'test_kind' }),
      );
      // 原子 claim 走 updateMany where {id, pending, dueAt IS NOT NULL + <=now}
      expect(prisma.timer.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'tmr_0000000001',
          status: TRIGGER_STATUS.PENDING,
          dueAt: { not: null, lte: NOW },
        },
        data: { status: TRIGGER_STATUS.FIRING },
      });
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.FIRED,
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
        },
      });
      // 全程无 schedule() → 无落库 create
      expect(prisma.timer.create).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    });

    it('TIMER_SCAN_INTERVAL_MS=0 时 onModuleInit 不创建 interval', async () => {
      process.env.TIMER_SCAN_INTERVAL_MS = '0';
      const { svc, prisma } = makeService();
      prisma.timer.findMany.mockResolvedValue([]);
      const spy = jest.spyOn(global, 'setInterval');

      await svc.onModuleInit();

      expect(spy).not.toHaveBeenCalled();
      expect((svc as unknown as { scanTimer: unknown }).scanTimer).toBeNull();
      svc.onModuleDestroy();
    });

    it('onModuleInit 后再 schedule() 不创建第二个 interval（守卫去重）', async () => {
      process.env.TIMER_SCAN_INTERVAL_MS = '1000';
      const { svc, prisma } = makeService();
      prisma.timer.findMany.mockResolvedValue([]);
      const spy = jest.spyOn(global, 'setInterval');

      await svc.onModuleInit();
      expect(spy).toHaveBeenCalledTimes(1);

      prisma.timer.findUnique.mockResolvedValue(null);
      prisma.timer.create.mockImplementation(async ({ data }: any) => data);
      await svc.schedule(
        'receipt_nudge',
        FUTURE,
        { hello: 'world' },
        'test_kind:scope:1',
      );

      expect(spy).toHaveBeenCalledTimes(1);
      svc.onModuleDestroy();
    });
  });

  describe('trigger 三形态（todo-2 白名单/outcome/interval/guard/强制上限）', () => {
    function dueMocks(row: Record<string, unknown>) {
      const { svc, prisma } = makeService();
      prisma.timer.findMany.mockResolvedValue([dueRow(row)]);
      prisma.timer.updateMany.mockResolvedValue({ count: 1 });
      prisma.timer.update.mockImplementation(async ({ data }: any) => data);
      return { svc, prisma };
    }

    it('未知 kind schedule → 直接抛错（loud，不落库）', async () => {
      const { svc, prisma } = makeService();
      await expect(
        svc.schedule('nope_kind', FUTURE, {}, 'nope_kind:s:1'),
      ).rejects.toThrow('unknown trigger kind nope_kind');
      expect(prisma.timer.create).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    });

    it('未注册 guardKey schedule → 直接抛错（loud，不落库）', async () => {
      const { svc, prisma } = makeService();
      await expect(
        svc.schedule('receipt_nudge', FUTURE, {}, 'receipt_nudge:s:1', {
          guardKey: 'never_registered',
        }),
      ).rejects.toThrow('unknown guard key never_registered');
      expect(prisma.timer.create).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    });

    it('handler 返回 void → 视为 done 落 fired（向后兼容，见 fireOne 落透分支）', async () => {
      const { svc, prisma } = dueMocks({});
      svc.registerHandler('test_kind', async () => undefined);
      await svc.fireDue(NOW);
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.FIRED,
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
        },
      });
      svc.onModuleDestroy();
    });

    it('handler {done:true} → fired（显式 done 与 void 同终态）', async () => {
      const { svc, prisma } = dueMocks({});
      svc.registerHandler('test_kind', async () => ({ done: true }));
      await svc.fireDue(NOW);
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.FIRED,
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
        },
      });
      svc.onModuleDestroy();
    });

    it('逾期 one-shot 只触发一次（dueAt 远过去 → fired，不追补不重排）', async () => {
      const { svc, prisma } = dueMocks({ dueAt: PAST });
      svc.registerHandler('test_kind', async () => undefined);
      await svc.fireDue(NOW);
      expect(prisma.timer.update).toHaveBeenCalledTimes(1);
      const data = prisma.timer.update.mock.calls[0][0].data;
      expect(data.status).toBe(TRIGGER_STATUS.FIRED);
      expect(data.dueAt).toBeUndefined();
      expect(data.nextFireAt).toBeUndefined();
      svc.onModuleDestroy();
    });

    it('handler {expire:true} → cancelled（handler 不可绕过）', async () => {
      const { svc, prisma } = dueMocks({});
      svc.registerHandler('test_kind', async () => ({ expire: true }));
      await svc.fireDue(NOW);
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.CANCELLED,
          lastError: 'expired by handler',
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
        },
      });
      svc.onModuleDestroy();
    });

    it('handler {rescheduleAt: 过去} → 钳制到 now+jitter 回 pending（不追补）', async () => {
      const { svc, prisma } = dueMocks({});
      svc.registerHandler('test_kind', async () => ({
        rescheduleAt: PAST,
      }));
      await svc.fireDue(NOW);
      const data = prisma.timer.update.mock.calls[0][0].data;
      expect(data.status).toBe(TRIGGER_STATUS.PENDING);
      expect((data.dueAt as Date).getTime()).toBeGreaterThanOrEqual(
        NOW.getTime(),
      );
      expect((data.dueAt as Date).getTime()).toBeLessThan(
        NOW.getTime() + 30_000,
      );
      svc.onModuleDestroy();
    });

    it('interval 行 done → nextFireAt = now + intervalMs + jitter 回 pending', async () => {
      const { svc, prisma } = dueMocks({ intervalMs: 60_000 });
      svc.registerHandler('test_kind', async () => undefined);
      await svc.fireDue(NOW);
      const data = prisma.timer.update.mock.calls[0][0].data;
      expect(data.status).toBe(TRIGGER_STATUS.PENDING);
      expect((data.dueAt as Date).getTime()).toBeGreaterThanOrEqual(
        NOW.getTime() + 60_000,
      );
      expect((data.dueAt as Date).getTime()).toBeLessThan(
        NOW.getTime() + 90_000,
      );
      svc.onModuleDestroy();
    });

    it('fireCount>=maxFires → claim 前 cancelled（handler 不调用，不可绕过）', async () => {
      const { svc, prisma } = dueMocks({ fireCount: 3, maxFires: 3 });
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);
      await svc.fireDue(NOW);
      expect(handler).not.toHaveBeenCalled();
      expect(prisma.timer.updateMany).not.toHaveBeenCalled();
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.CANCELLED,
          lastError: 'maxFires reached (3/3)',
        },
      });
      svc.onModuleDestroy();
    });

    it('now>=expiresAt → claim 前 cancelled（handler 不调用，不可绕过）', async () => {
      const { svc, prisma } = dueMocks({ expiresAt: PAST });
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);
      await svc.fireDue(NOW);
      expect(handler).not.toHaveBeenCalled();
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: { status: TRIGGER_STATUS.CANCELLED, lastError: 'expired' },
      });
      svc.onModuleDestroy();
    });

    it('guard false → skipReason 留 pending 待下轮（handler 不调用）', async () => {
      const { svc, prisma } = dueMocks({ guardKey: 'g1' });
      svc.registerGuard('g1', () => false);
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);
      await svc.fireDue(NOW);
      expect(handler).not.toHaveBeenCalled();
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.PENDING,
          skipReason: 'guard g1 not satisfied',
        },
      });
      svc.onModuleDestroy();
    });
  });

  describe('fireDue 生产路径（D12-1 DB NOW(3)，无参调用）', () => {
    const DB_NOW = new Date('2026-09-16T00:00:05.000Z');

    function makeDbService(
      dueRows: Record<string, unknown>[],
      claimCount: number,
    ) {
      const p = makePrisma();
      const queryRaw: jest.Mock = jest.fn(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT NOW(3)')) {
          return [{ now: DB_NOW }];
        }
        return dueRows;
      });
      const executeRaw: jest.Mock = jest.fn(async () => claimCount);
      const ext = Object.assign(p, {
        $queryRawUnsafe: queryRaw,
        $executeRawUnsafe: executeRaw,
      });
      const { svc, idGen } = makeService(
        ext as unknown as Parameters<typeof makeService>[0],
      );
      prismaTimer(p).update.mockImplementation(async ({ data }: any) => data);
      prismaTimer(p).updateMany.mockResolvedValue({ count: 1 });
      return { svc, prisma: p, queryRaw, executeRaw, idGen };
    }

    function prismaTimer(p: PrismaMock) {
      return p.timer;
    }

    it('无参调用走 DB 时钟：SQL 含 NOW(3)+IS NOT NULL，不碰 findMany/updateMany', async () => {
      const { svc, prisma, queryRaw, executeRaw } = makeDbService(
        [dueRow()],
        1,
      );
      const seen: any[] = [];
      svc.registerHandler('test_kind', async (t) => {
        seen.push(t);
      });

      const out = await svc.fireDue();

      // select 与 claim 都在 DB 侧用 NOW(3) 求值，且 NULL 行永不入选
      const selectSql = queryRaw.mock.calls.map((c) => c[0]).join('\n');
      expect(selectSql).toContain('NOW(3)');
      expect(selectSql).toContain('`due_at` IS NOT NULL');
      expect(selectSql).toContain('ORDER BY `due_at` ASC LIMIT 100');
      expect(selectSql).toContain('`next_fire_at` AS `nextFireAt`');
      expect(selectSql).not.toContain('`fire_at` AS `fireAt`');
      const claimSql = executeRaw.mock.calls[0][0] as string;
      expect(claimSql).toContain('NOW(3)');
      expect(claimSql).toContain('`due_at` IS NOT NULL');
      expect(executeRaw.mock.calls[0][1]).toBe('tmr_0000000001');
      // app 时钟路径的两个 Prisma 查询完全未被使用
      expect(prisma.timer.findMany).not.toHaveBeenCalled();
      expect(prisma.timer.updateMany).not.toHaveBeenCalled();
      // 行正常触发 → fired（下游语义与 app 路径一致）
      expect(seen).toHaveLength(1);
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: {
          status: TRIGGER_STATUS.FIRED,
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
        },
      });
      expect(out).toHaveLength(1);
      svc.onModuleDestroy();
    });

    it('DB claim 影响 0 行（重叠 tick）→ handler 不调用且返回空', async () => {
      const { svc, prisma } = makeDbService([dueRow()], 0);
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);

      const out = await svc.fireDue();

      expect(handler).not.toHaveBeenCalled();
      expect(prisma.timer.update).not.toHaveBeenCalled();
      expect(out).toEqual([]);
      svc.onModuleDestroy();
    });

    it('DB 原生行（snake_case + 字符串日期）归一为 TriggerRow（ctx.dueAt 为 Date）', async () => {
      const raw = {
        ...dueRow(),
        dueAt: '2026-09-15T00:00:00.000Z',
        nextFireAt: null,
        expiresAt: null,
      };
      const { svc } = makeDbService([raw], 1);
      const seen: any[] = [];
      svc.registerHandler('test_kind', async (t) => {
        seen.push(t);
      });

      await svc.fireDue();

      expect(seen).toHaveLength(1);
      expect(seen[0].dueAt).toBeInstanceOf(Date);
      expect((seen[0].dueAt as Date).getTime()).toBe(
        new Date('2026-09-15T00:00:00.000Z').getTime(),
      );
      svc.onModuleDestroy();
    });

    it('SELECT NOW(3) 失败 → 返回空数组不抛错', async () => {
      const p = makePrisma();
      const ext = Object.assign(p, {
        $queryRawUnsafe: jest.fn(async () => {
          throw new Error('db gone');
        }),
        $executeRawUnsafe: jest.fn(async () => 1),
      });
      const { svc } = makeService(
        ext as unknown as Parameters<typeof makeService>[0],
      );
      const handler = jest.fn();
      svc.registerHandler('test_kind', handler);

      await expect(svc.fireDue()).resolves.toEqual([]);

      expect(handler).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    });
  });
});
