/**
 * 僵尸 running 收敛测试（2026-11-20）。
 *
 * 对应线上故障：聊天页永久显示「XXX 会话运行中」，实际早已结束
 * （`s_0000000058`：status=running、busy_state=idle、最后活动停在 29 小时前）。
 *
 * 守住的语义：
 * 1. 只收敛「超阈值无活动的 running」；
 * 2. **不碰** `busy_state='running'` 的会话（那是真在跑，判死归 scanIdleSessions）；
 * 3. 活动列为 NULL 时回退 updatedAt（否则新建会话永久逃逸）；
 * 4. 只改 status → idle，不动其它字段（不伪造 lastTurnOutcome 等事实）；
 * 5. CAS：并发下目标行已被改走 → 不算收敛（避免覆盖真实回传）；
 * 6. 扫描/更新失败都不抛（后台清理不该影响主流程）。
 */
import {
  StaleSessionConverger,
  DEFAULT_STALE_SESSION_THRESHOLD_MS,
} from './stale-session-converger';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');

function makeConverger(
  rows: Array<{
    id: string;
    teamMemberId?: string | null;
    lastActivityAt?: Date | null;
    updatedAt?: Date;
  }>,
  options: {
    thresholdMs?: number;
    updateCount?: number;
    findManyThrows?: boolean;
    updateThrows?: boolean;
  } = {},
) {
  const updateCalls: unknown[] = [];
  const logs: string[] = [];
  const converger = new StaleSessionConverger({
    prisma: {
      session: {
        findMany: async (args: unknown) => {
          if (options.findManyThrows) throw new Error('db down');
          (findManyArgs as unknown as { v: unknown }).v = args;
          return rows.map((r) => ({
            id: r.id,
            teamMemberId: r.teamMemberId ?? null,
            lastActivityAt: r.lastActivityAt ?? null,
            updatedAt: r.updatedAt ?? new Date(NOW - 60 * 60 * 1000),
          }));
        },
        updateMany: async (args: unknown) => {
          if (options.updateThrows) throw new Error('update failed');
          updateCalls.push(args);
          return { count: options.updateCount ?? 1 };
        },
      },
    },
    ...(options.thresholdMs !== undefined
      ? { thresholdMs: options.thresholdMs }
      : {}),
    now: () => NOW,
    logger: {
      log: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
    },
  });
  // findMany 收到的最新查询参数（供断言 where 语义）
  const findManyArgs = { v: undefined as unknown };
  return { converger, updateCalls, logs, findManyArgs };
}

describe('StaleSessionConverger', () => {
  it('超阈值无活动的 running → 收敛为 idle（只改 status）', async () => {
    const { converger, updateCalls, logs } = makeConverger([
      { id: 's_58', teamMemberId: 'tmm_47' },
    ]);

    const out = await converger.converge();

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('s_58');
    // 关键：data 里**只有** status，不伪造其它字段（lastTurnOutcome 等不是我们的事实）
    expect(updateCalls[0]).toEqual({
      where: { id: 's_58', status: 'running' },
      data: { status: 'idle' },
    });
    expect(logs[0]).toContain('收敛 1 条僵尸');
  });

  it('查询谓词：只挑 status=running 且 busy_state≠running 的超时会话', async () => {
    const { converger, findManyArgs } = makeConverger([]);

    await converger.converge();

    const where = (findManyArgs.v as { where: Record<string, unknown> }).where;
    expect(where.status).toBe('running');
    // 真在跑（轮次台账）的会话不归本模块管 —— 那是 scanIdleSessions 的判死职责
    expect(where.busyState).toEqual({ not: 'running' });
    // 活动列为主，NULL 回退 updatedAt
    expect(where.OR).toEqual([
      { lastActivityAt: { lt: expect.any(Date) } },
      { lastActivityAt: null, updatedAt: { lt: expect.any(Date) } },
    ]);
  });

  it('CAS 落空（行已被并发改走）→ 不计入收敛，不重复报告', async () => {
    const { converger, logs } = makeConverger([{ id: 's_1' }], {
      updateCount: 0,
    });

    const out = await converger.converge();

    expect(out).toEqual([]);
    expect(logs.filter((l) => l.includes('收敛 1 条'))).toEqual([]);
  });

  it('没有超时会话 → 不写库、不打印噪音日志', async () => {
    const { converger, updateCalls, logs } = makeConverger([]);

    const out = await converger.converge();

    expect(out).toEqual([]);
    expect(updateCalls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('活动列为 NULL → 用 updatedAt 判定（新建会话不会永久逃逸）', async () => {
    const { converger, updateCalls } = makeConverger([
      {
        id: 's_old',
        lastActivityAt: null,
        updatedAt: new Date(NOW - 2 * 60 * 60 * 1000), // 2 小时前
      },
    ]);

    const out = await converger.converge();

    expect(out).toHaveLength(1);
    expect(out[0].lastActivityAt).toBe(
      new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    );
    expect(updateCalls).toHaveLength(1);
  });

  it('扫描异常 → 返回空、不抛（后台清理失败只 warn）', async () => {
    const { converger, logs } = makeConverger([], { findManyThrows: true });

    await expect(converger.converge()).resolves.toEqual([]);
    expect(logs[0]).toContain('扫描失败');
  });

  it('单条更新异常 → 跳过该条，其余照常收敛', async () => {
    const { converger } = makeConverger([{ id: 's_a' }, { id: 's_b' }], {
      updateThrows: true,
    });

    // 两条都失败 → 空结果但不抛
    await expect(converger.converge()).resolves.toEqual([]);
  });

  it('默认阈值 30 分钟（与线上实证的 29 小时僵尸对比，收得动）', () => {
    expect(DEFAULT_STALE_SESSION_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });
});
