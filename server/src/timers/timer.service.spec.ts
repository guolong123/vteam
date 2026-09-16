// ticker 在单测中禁用（TIMER_SCAN_INTERVAL_MS=0；ensureTicker 惰性读 env，
// import 之后设置依然有效；schedule 仍走完整落库分支）。
process.env.TIMER_SCAN_INTERVAL_MS = '0';

import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { TIMER_STATUS, TimerService } from './timer.service';

type PrismaMock = {
  timer: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
};

function makePrisma(): PrismaMock {
  return {
    timer: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
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
  const svc = new TimerService(
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
    status: TIMER_STATUS.PENDING,
    fireAt: PAST,
    payload: { hello: 'world' },
    dedupKey: 'test_kind:scope:1',
    attempts: 0,
    ...over,
  };
}

describe('TimerService（通用定时器基础设施，mocked PrismaService，无 DB）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('schedule', () => {
    it('落 pending 行（tmr_ id + dedupKey + fireAt/payload 透传）', async () => {
      const { svc, prisma, idGen } = makeService();
      prisma.timer.findUnique.mockResolvedValue(null);
      prisma.timer.create.mockImplementation(async ({ data }: any) => ({
        ...data,
        createdAt: NOW,
        updatedAt: NOW,
      }));

      const out = await svc.schedule(
        'test_kind',
        FUTURE,
        { hello: 'world' },
        'test_kind:scope:1',
      );

      expect(idGen.nextId).toHaveBeenCalledWith('tmr');
      expect(prisma.timer.create).toHaveBeenCalledTimes(1);
      expect(prisma.timer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'tmr_0000000001',
          kind: 'test_kind',
          status: TIMER_STATUS.PENDING,
          fireAt: FUTURE,
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
      const existing = dueRow({ status: TIMER_STATUS.PENDING });
      prisma.timer.findUnique.mockResolvedValue(existing);

      const out = await svc.schedule(
        'test_kind',
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
      const winner = dueRow({ status: TIMER_STATUS.PENDING });
      prisma.timer.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      prisma.timer.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
        }),
      );

      const out = await svc.schedule(
        'test_kind',
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
        dueRow({ status: TIMER_STATUS.CANCELLED }),
      );

      await svc.cancel('tmr_0000000001');

      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: { status: TIMER_STATUS.CANCELLED },
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
        .mockResolvedValueOnce(dueRow({ status: TIMER_STATUS.CANCELLED }));

      await svc.cancel('test_kind:scope:1');

      expect(prisma.timer.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'test_kind:scope:1' },
        data: { status: TIMER_STATUS.CANCELLED },
      });
      expect(prisma.timer.update).toHaveBeenNthCalledWith(2, {
        where: { dedupKey: 'test_kind:scope:1' },
        data: { status: TIMER_STATUS.CANCELLED },
      });
      svc.onModuleDestroy();
    });
  });

  describe('fireDue', () => {
    it('只取 due+pending 行并按 fireAt 升序触发（handler 按序调用）', async () => {
      const { svc, prisma } = makeService();
      const first = dueRow({
        id: 'tmr_0000000001',
        fireAt: new Date('2026-09-14T00:00:00.000Z'),
      });
      const second = dueRow({
        id: 'tmr_0000000002',
        fireAt: new Date('2026-09-15T00:00:00.000Z'),
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

      // 查询口径：pending + fireAt<=now（cancelled/未来行天然排除）+ fireAt 升序
      expect(prisma.timer.findMany).toHaveBeenCalledWith({
        where: { status: TIMER_STATUS.PENDING, fireAt: { lte: NOW } },
        orderBy: { fireAt: 'asc' },
      });
      expect(seen).toEqual(['tmr_0000000001', 'tmr_0000000002']);
      // 成功 → fired
      expect(prisma.timer.update).toHaveBeenCalledWith({
        where: { id: 'tmr_0000000001' },
        data: { status: TIMER_STATUS.FIRED, attempts: { increment: 1 } },
      });
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
          status: TIMER_STATUS.FAILED,
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
          status: TIMER_STATUS.FAILED,
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
      expect(where.status).toBe(TIMER_STATUS.PENDING);
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
});
