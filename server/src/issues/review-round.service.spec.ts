import { parseLedger } from './review-round-ledger';
import { ReviewRoundService } from './review-round.service';

/**
 * 并发串行化仿真：以互斥队列模拟 InnoDB `SELECT ... FOR UPDATE`
 * 行锁语义——同一 issue 的事务回调互斥执行，后开的事务读到先行者
 * 已提交的 description。生产实现靠 MySQL 行锁保证，本单测断言
 * service 确实把"读-改-写"包进同一事务且先取行锁。
 */
const setup = (initialDescription: string | null = null) => {
  const store = new Map<string, string | null>([
    ['is_0000000007', initialDescription],
  ]);
  let mutex: Promise<void> = Promise.resolve();
  const lock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = mutex;
    let release!: () => void;
    mutex = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ id: 'is_0000000007' }]),
    issue: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (!store.has(where.id)) return null;
        return { id: where.id, description: store.get(where.id) };
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { description: string };
        }) => {
          // 模拟行锁持有下的写：延迟 5ms 放大"读-改-写"竞态窗口——
          // 若实现未串行化，双写必丢其一。
          await new Promise((r) => setTimeout(r, 5));
          store.set(where.id, data.description);
          return { id: where.id, description: data.description };
        },
      ),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) =>
      lock(() => fn(tx)),
    ),
  };
  const service = new ReviewRoundService(prisma as never);
  return { service, tx, store };
};

const OPEN_ROUND = (hash: string) =>
  [
    '评审派发 R2（v0.3，架构/开发/测试三视角）',
    '',
    '<!-- REVIEW-ROUND-JSON -->',
    '```json',
    JSON.stringify({
      schemaVersion: 1,
      round: 2,
      planVersion: { version: 'v0.3', lines: 233, hash },
      expected: ['tmm_0000000012', 'tmm_0000000009'],
      received: {},
      status: 'collecting',
      timeoutAt: '2026-09-16T00:40:00Z',
    }),
    '```',
    '',
  ].join('\n');

describe('ReviewRoundService.applyRoundUpdate', () => {
  it('并发双写串行化：两成员回执都不丢失', async () => {
    const { service, tx, store } = setup(OPEN_ROUND('a1b2c3d4'));
    const [r1, r2] = await Promise.all([
      service.applyRoundUpdate('is_0000000007', {
        received: {
          member: 'tmm_0000000012',
          verdict: 'APPROVE',
          msgId: 'm_540',
          version: 'v0.3',
        },
      }),
      service.applyRoundUpdate('is_0000000007', {
        received: {
          member: 'tmm_0000000009',
          verdict: 'REJECT',
          msgId: 'm_541',
          version: 'v0.3',
        },
      }),
    ]);
    // 事务内先取行锁（MySQL SELECT FOR UPDATE）
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      'is_0000000007',
    );
    // 串行化语义：先提交者只见自己，后提交者见全量；落盘终态两者俱全。
    expect(Object.keys(r1.received)).toEqual(['tmm_0000000012']);
    expect(Object.keys(r2.received).sort()).toEqual([
      'tmm_0000000009',
      'tmm_0000000012',
    ]);
    expect(
      Object.keys(
        parseLedger(store.get('is_0000000007'))?.received ?? {},
      ).sort(),
    ).toEqual(['tmm_0000000009', 'tmm_0000000012']);
  });

  it('同一轮同一人多次回执取最后一次', async () => {
    const { service } = setup(OPEN_ROUND('a1b2c3d4'));
    await service.applyRoundUpdate('is_0000000007', {
      received: {
        member: 'tmm_0000000012',
        verdict: 'REJECT',
        msgId: 'm_1',
        version: 'v0.3',
      },
    });
    const done = await service.applyRoundUpdate('is_0000000007', {
      received: {
        member: 'tmm_0000000012',
        verdict: 'APPROVE',
        msgId: 'm_2',
        version: 'v0.3',
      },
    });
    expect(done.received['tmm_0000000012']).toEqual({
      verdict: 'APPROVE',
      msgId: 'm_2',
      version: 'v0.3',
    });
  });

  it('hash 缺失 → 回执挂起 pending-hash，不标 superseded', async () => {
    const { service } = setup(OPEN_ROUND(''));
    const done = await service.applyRoundUpdate('is_0000000007', {
      received: {
        member: 'tmm_0000000012',
        verdict: 'APPROVE',
        msgId: 'm_9',
        version: 'v0.3',
      },
    });
    expect(done.received['tmm_0000000012']).toBeUndefined();
    expect(done.superseded ?? []).toHaveLength(0);
    expect(done.pending).toHaveLength(1);
    expect(done.pending?.[0]).toMatchObject({
      member: 'tmm_0000000012',
      reason: 'pending-hash',
    });
  });

  it('派发即宿主：applyRoundUpdate 写回 issueId 链接', async () => {
    const { service } = setup(null);
    const done = await service.applyRoundUpdate('is_0000000007', {
      taskId: 't_0000000001',
      round: 1,
      planVersion: { version: 'v0.1', lines: 10, hash: 'abcd1234' },
      expected: ['tmm_0000000012'],
      timeoutAt: '2026-09-16T00:40:00Z',
    });
    expect(done.issueId).toBe('is_0000000007');
    expect(done.taskId).toBe('t_0000000001');
    expect(parseLedger).toBeDefined();
  });

  it('issue 不存在 → REVIEW_ROUND_ISSUE_NOT_FOUND', async () => {
    const { service } = setup();
    await expect(
      service.applyRoundUpdate('is_missing', {
        received: {
          member: 'tmm_0000000012',
          verdict: 'APPROVE',
          msgId: 'm_1',
          version: 'v0.3',
        },
      }),
    ).rejects.toMatchObject({
      response: { code: 'REVIEW_ROUND_ISSUE_NOT_FOUND' },
    });
  });
});
