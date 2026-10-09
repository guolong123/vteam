import {
  computeMemoryImportance,
  MEMORY_IMPORTANCE_HALF_LIFE_DAYS,
  MEMORY_IMPORTANCE_HALF_LIFE_DAYS_DEFAULT,
  resolveMemoryImportanceHalfLifeDays,
  sortMemoriesByImportance,
} from './memory-importance';

const DAY = 86_400_000;
const NOW = new Date('2026-10-09T00:00:00.000Z');

const daysAgo = (days: number, from: Date = NOW): Date =>
  new Date(from.getTime() - days * DAY);

/** 便捷构造：refCount + 计龄基准（默认 lastUsedAt 为 null = 从未被引用）。 */
const row = (refCount: number, ageDays: number, lastUsedAt?: Date | null) => ({
  refCount,
  lastUsedAt: lastUsedAt ?? null,
  createdAt: daysAgo(ageDays),
});

describe('computeMemoryImportance', () => {
  it('默认半衰期为 30 天（未配 env 时取默认值）', () => {
    expect(MEMORY_IMPORTANCE_HALF_LIFE_DAYS_DEFAULT).toBe(30);
    // 模块加载时若测试环境未设该 env，导出的常量应等于默认值。
    expect(resolveMemoryImportanceHalfLifeDays()).toBe(
      MEMORY_IMPORTANCE_HALF_LIFE_DAYS_DEFAULT,
    );
  });

  it('env 非法时静默回落默认值（配置写错不该让进程起不来）', () => {
    const prev = process.env.MEMORY_IMPORTANCE_HALF_LIFE_DAYS;
    try {
      for (const raw of ['', 'abc', 'NaN', 'Infinity', '0', '-5']) {
        process.env.MEMORY_IMPORTANCE_HALF_LIFE_DAYS = raw;
        expect(resolveMemoryImportanceHalfLifeDays()).toBe(
          MEMORY_IMPORTANCE_HALF_LIFE_DAYS_DEFAULT,
        );
      }
      process.env.MEMORY_IMPORTANCE_HALF_LIFE_DAYS = '7';
      expect(resolveMemoryImportanceHalfLifeDays()).toBe(7);
    } finally {
      if (prev === undefined) {
        delete process.env.MEMORY_IMPORTANCE_HALF_LIFE_DAYS;
      } else {
        process.env.MEMORY_IMPORTANCE_HALF_LIFE_DAYS = prev;
      }
    }
  });

  it('全新未被引用的记忆 score ≈ 1.0（落 (0.9, 1.1]，不被新鲜度项饿死）', () => {
    const fresh = computeMemoryImportance(row(0, 0), undefined, NOW);
    expect(fresh).toBeGreaterThan(0.9);
    expect(fresh).toBeLessThanOrEqual(1.1);

    // 同一刻度下「1 小时前建」与「0 天前」同量级：指数项只认天数。
    const anHourAgo = computeMemoryImportance(
      row(0, 0),
      undefined,
      new Date(NOW.getTime() - 3_600_000),
    );
    expect(anHourAgo).toBeGreaterThan(0.9);
    expect(anHourAgo).toBeLessThanOrEqual(1.1);
  });

  it('同龄下 refCount 越高 score 单调越高（引用多的压过引用少的）', () => {
    const scores = [0, 1, 2, 5, 20, 100].map((n) =>
      computeMemoryImportance(row(n, 1), undefined, NOW),
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
    // 引用项是 ln(1+n)：n=0 → 0，n=2 → ln(3) ≈ 1.0986，加上 exp 项后仍 > 1.1 附近，
    // 但不该等于裸 ln——断言公式确实按「ln(1+n) + exp(...)」合成而非只取其中一项。
    const two = computeMemoryImportance(row(2, 0), undefined, NOW);
    expect(two).toBeCloseTo(Math.log(3) + 1, 10);
  });

  it('同 refCount 下越老 score 越低（指数衰减，30 天半衰）', () => {
    const scores = [0, 1, 7, 30, 90, 365].map((age) =>
      computeMemoryImportance(row(3, age), undefined, NOW),
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
    // 半衰期语义：age = 30 天时新鲜项恰好 = 0.5。
    const thirty = computeMemoryImportance(row(0, 30), undefined, NOW);
    expect(thirty).toBeCloseTo(Math.exp(-1), 10);
  });

  it('省略 halfLifeDays 时用导出的 MEMORY_IMPORTANCE_HALF_LIFE_DAYS（默认 30）', () => {
    const r = row(1, 30);
    expect(computeMemoryImportance(r, undefined, NOW)).toBe(
      computeMemoryImportance(r, MEMORY_IMPORTANCE_HALF_LIFE_DAYS, NOW),
    );
  });

  it('lastUsedAt 优先于 createdAt 计龄（半年前建、昨天命中 → 记昨天的龄）', () => {
    const lastUsed = daysAgo(1);
    const withLastUsed = computeMemoryImportance(
      row(4, 180, lastUsed),
      undefined,
      NOW,
    );
    // 退回 createdAt（180 天）会显著更低；用 lastUsedAt 则接近「1 天前」。
    const ignoringLastUsed = computeMemoryImportance(
      row(4, 180, null),
      undefined,
      NOW,
    );
    expect(withLastUsed).toBeGreaterThan(ignoringLastUsed);
    expect(withLastUsed).toBeCloseTo(Math.log(5) + Math.exp(-1 / 30), 10);
  });

  it('半衰期越小越看重新鲜度（同一行，调小半衰期后老行掉分更多）', () => {
    const freshOld = computeMemoryImportance(row(0, 1), 30, NOW);
    const freshOldShort = computeMemoryImportance(row(0, 1), 1, NOW);
    const veryOldShort = computeMemoryImportance(row(0, 60), 1, NOW);

    expect(veryOldShort).toBeLessThan(freshOldShort);
    expect(computeMemoryImportance(row(0, 1), 1, NOW)).toBeLessThan(freshOld);
  });

  it('半衰期非法（0/负数/NaN）时回落默认值，不产出 NaN/Infinity', () => {
    for (const hl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const score = computeMemoryImportance(row(2, 10), hl, NOW);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBe(computeMemoryImportance(row(2, 10), undefined, NOW));
    }
  });

  it('异常行不毁排序：负数/非有限的 refCount 与未来时间戳都被钳住', () => {
    for (const rc of [-1, -100, Number.NaN]) {
      const score = computeMemoryImportance(row(rc, 5), undefined, NOW);
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBe(computeMemoryImportance(row(0, 5), undefined, NOW));
    }
    // lastUsedAt 落在未来（跨机时钟漂移）不应让分数 >1 并排到最前。
    const future = computeMemoryImportance(
      row(1, 10, new Date(NOW.getTime() + 10 * DAY)),
      undefined,
      NOW,
    );
    expect(future).toBeCloseTo(Math.log(2) + 1, 10);
  });
});

describe('sortMemoriesByImportance', () => {
  const named = (id: string, refCount: number, ageDays: number, lastUsedAt?: Date | null) => ({
    id,
    ...row(refCount, ageDays, lastUsedAt),
  });

  it('降序：分高者在前（与逐行 computeMemoryImportance 同序）', () => {
    const rows = [
      named('cold', 0, 30),
      named('hot', 5, 30),
      named('mid', 1, 1),
    ];
    expect(sortMemoriesByImportance(rows, NOW).map((r) => r.id)).toEqual([
      'hot',
      'mid',
      'cold',
    ]);
  });

  it('同分时 lastUsedAt ?? createdAt 新者优先；同分同龄保持入参次序（sort 稳定）', () => {
    const rows = [
      named('older', 2, 40),
      named('newer', 2, 5),
      named('twins_a', 2, 10),
      named('twins_b', 2, 10),
      // lastUsedAt 比 createdAt 新：计龄基准取 lastUsedAt → 它排最前
      named('used_recently', 2, 90, daysAgo(1)),
    ];
    expect(sortMemoriesByImportance(rows, NOW).map((r) => r.id)).toEqual([
      'used_recently',
      'newer',
      'twins_a',
      'twins_b',
      'older',
    ]);
  });

  it('now 只求值一次：冻结时钟下同一批候选反复排序结果稳定', () => {
    const rows = [
      named('a', 0, 2),
      named('b', 1, 2),
      named('c', 2, 2),
    ];
    const frozen = new Date(NOW.getTime());
    const first = sortMemoriesByImportance(rows, frozen).map((r) => r.id);
    // 若 now 在比较器里逐次求值，跨一次时钟跳动会让同分行的次序漂移；
    // 传入同一个 now 对象则每次调用都必须给出同一结果。
    for (let i = 0; i < 5; i += 1) {
      expect(sortMemoriesByImportance(rows, frozen).map((r) => r.id)).toEqual(
        first,
      );
    }
    expect(first).toEqual(['c', 'b', 'a']);
  });

  it('零平局字段（同分 + 同计龄基准）时名次只由 sort 稳定性决定，冻结时钟下反复排序稳定', () => {
    // refCount 与计龄基准（lastUsedAt ?? createdAt）逐行相同 → 重要度恒相等，
    // 平局字段也被抹平：任何时钟取值都改不了名次，只剩 sort 稳定性（入参次序）。
    const twins = [
      { id: 'twin_1', refCount: 2, lastUsedAt: null, createdAt: daysAgo(10) },
      { id: 'twin_2', refCount: 2, lastUsedAt: null, createdAt: daysAgo(10) },
      { id: 'twin_3', refCount: 2, lastUsedAt: null, createdAt: daysAgo(10) },
    ];
    const frozen = new Date(NOW.getTime());
    const first = sortMemoriesByImportance(twins, frozen).map((r) => r.id);
    expect(first).toEqual(['twin_1', 'twin_2', 'twin_3']);
    for (let i = 0; i < 5; i += 1) {
      expect(sortMemoriesByImportance(twins, frozen).map((r) => r.id)).toEqual(
        first,
      );
    }
    // now 推到 10 年后（两条都进衰减底）仍同序：分数相等 + 平局字段相等 ⇒ 输出与时钟无关。
    const far = new Date(NOW.getTime() + 3650 * DAY);
    expect(sortMemoriesByImportance(twins, far).map((r) => r.id)).toEqual(
      first,
    );
  });

  it('定序依赖传入的 now：同一批候选换一个冻结时刻名次翻转（逐次取钟的排序器无法复现）', () => {
    const rows = [
      {
        id: 'stale_hot',
        refCount: 2,
        lastUsedAt: null,
        createdAt: daysAgo(60),
      },
      {
        id: 'fresh_quiet',
        refCount: 1,
        lastUsedAt: null,
        createdAt: daysAgo(0),
      },
    ];
    // NOW 下新鲜度项（e^-60/30≈0.135 vs 1）压过 ln(3)-ln(2)≈0.405 → fresh_quiet 在前。
    expect(sortMemoriesByImportance(rows, NOW).map((r) => r.id)).toEqual([
      'fresh_quiet',
      'stale_hot',
    ]);
    // now 前推 60 天让两条都进衰减底（新鲜度项同为 1）→ 只剩 ln 差距，stale_hot 反超。
    const frozenLate = new Date(NOW.getTime() + 60 * DAY);
    const late = sortMemoriesByImportance(rows, frozenLate).map((r) => r.id);
    expect(late).toEqual(['stale_hot', 'fresh_quiet']);
    // 名次确实随时钟翻转（比较器逐次 new Date() 就落进这条缝里，排序不再可复现）；
    // 冻结时钟下同一批候选必须反复给同一结果。
    for (let i = 0; i < 5; i += 1) {
      expect(
        sortMemoriesByImportance(rows, frozenLate).map((r) => r.id),
      ).toEqual(late);
    }
  });

  it('纯函数：不改入参、总是返回新数组', () => {
    const rows = [named('a', 0, 1), named('b', 9, 1)];
    const snapshot = [...rows];
    const out = sortMemoriesByImportance(rows, NOW);
    expect(rows).toEqual(snapshot);
    expect(out).not.toBe(rows);
    expect(sortMemoriesByImportance([], NOW)).toEqual([]);
  });
});
