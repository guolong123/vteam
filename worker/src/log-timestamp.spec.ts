import {
  installTimestampedConsole,
  logTimestamp,
  resetTimestampedConsoleForTest,
  withLogTimestamp,
} from './log-timestamp';

describe('worker 日志时间戳', () => {
  beforeEach(() => {
    resetTimestampedConsoleForTest();
  });

  afterEach(() => {
    resetTimestampedConsoleForTest();
  });

  it('logTimestamp：ISO 8601 且可被 Date 解析', () => {
    const d = new Date('2026-11-27T09:36:18.123Z');
    expect(logTimestamp(d)).toBe('2026-11-27T09:36:18.123Z');
    expect(Number.isFinite(Date.parse(logTimestamp(d)))).toBe(true);
  });

  it('withLogTimestamp：字符串首参加前缀，其余参数原样保留', () => {
    const d = new Date('2026-11-27T09:36:18.123Z');
    expect(withLogTimestamp(['[worker] 就绪'], d)).toEqual([
      '[2026-11-27T09:36:18.123Z] [worker] 就绪',
    ]);
    expect(withLogTimestamp(['[exec] 失败 %s', 'fetch failed'], d)).toEqual([
      '[2026-11-27T09:36:18.123Z] [exec] 失败 %s',
      'fetch failed',
    ]);
    expect(withLogTimestamp([{ a: 1 }], d)).toEqual([
      '[2026-11-27T09:36:18.123Z]',
      { a: 1 },
    ]);
  });

  it('installTimestampedConsole：四种 console 方法均加前缀，且重复调用幂等', () => {
    const calls: Array<[string, unknown[]]> = [];
    const target = {
      log: (...a: unknown[]) => calls.push(['log', a]),
      info: (...a: unknown[]) => calls.push(['info', a]),
      warn: (...a: unknown[]) => calls.push(['warn', a]),
      error: (...a: unknown[]) => calls.push(['error', a]),
    } as unknown as Console;

    expect(installTimestampedConsole(target)).toBe(true);
    target.log('[worker] A');
    target.info('[worker] B');
    target.warn('[worker] C');
    target.error('[worker] D');
    expect(calls.map(([level]) => level)).toEqual(['log', 'info', 'warn', 'error']);
    for (const [, args] of calls) {
      expect(String(args[0])).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*Z\] \[worker\] [A-D]$/);
    }

    const before = calls.length;
    expect(installTimestampedConsole(target)).toBe(false);
    target.log('第二次');
    expect(calls.length).toBe(before + 1);
    // 幂等 ⇒ 不会叠加两个时间前缀
    expect(String(calls[calls.length - 1][1][0]).match(/\[20/g)).toHaveLength(1);
  });
});
