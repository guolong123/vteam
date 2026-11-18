/**
 * serve 看门狗测试（2026-11-18）。
 *
 * 守住的语义（对应线上「心跳正常但发消息 502」）：
 * 1. 探测失败 → **立即** degraded（平台停止派单，别继续放大 502）；
 * 2. 未达阈值不重启（瞬时抖动不该打断活跃会话）；
 * 3. 达阈值才重启，且**只触发一次**（不刷屏、不重复打断）；
 * 4. 有活跃会话 → 重启挂起（绝不打断在跑的 agent）；
 * 5. 恢复后计数清零；
 * 6. 探测/重启自身异常都不能抛出去（否则看门狗会把心跳拖垮）。
 */
import {
  ServeWatchdog,
  DEFAULT_SERVE_FAILURE_THRESHOLD,
} from './serve-watchdog';

function makeWatchdog(overrides: {
  probe?: () => Promise<'ok' | 'unreachable'>;
  requestRestart?: () => Promise<'executed' | 'pending'>;
  threshold?: number;
}) {
  const restarts: string[] = [];
  const logs: string[] = [];
  const wd = new ServeWatchdog({
    probe: overrides.probe ?? (async () => 'ok'),
    requestRestart:
      overrides.requestRestart ??
      (async (reason: string) => {
        restarts.push(reason);
        return 'executed' as const;
      }),
    ...(overrides.threshold !== undefined
      ? { threshold: overrides.threshold }
      : {}),
    logger: {
      info: (m: string) => logs.push(`I ${m}`),
      warn: (m: string) => logs.push(`W ${m}`),
    },
  });
  return { wd, restarts, logs };
}

describe('ServeWatchdog', () => {
  it('探测成功 → healthy，不重启', async () => {
    const { wd, restarts } = makeWatchdog({});
    expect(await wd.check()).toBe('healthy');
    expect(wd.isUnhealthy).toBe(false);
    expect(restarts).toEqual([]);
  });

  it('单次失败 → degraded（立即降级，平台停止派单）但**不重启**', async () => {
    const { wd, restarts } = makeWatchdog({
      probe: async () => 'unreachable',
    });
    expect(await wd.check()).toBe('degraded');
    // 关键：一次失败就该让平台知道（否则继续派单 → 用户吃 502）
    expect(wd.isUnhealthy).toBe(true);
    expect(restarts).toEqual([]);
  });

  it(`连续失败达阈值（${DEFAULT_SERVE_FAILURE_THRESHOLD} 次）→ 重启`, async () => {
    const { wd, restarts } = makeWatchdog({
      probe: async () => 'unreachable',
    });
    for (let i = 1; i < DEFAULT_SERVE_FAILURE_THRESHOLD; i += 1) {
      expect(await wd.check()).toBe('degraded');
    }
    expect(await wd.check()).toBe('restarting');
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toContain('探测失败');
  });

  it('持续失败 → 重启**只触发一次**（不每轮重复打断）', async () => {
    const { wd, restarts } = makeWatchdog({
      probe: async () => 'unreachable',
      threshold: 2,
    });
    await wd.check();
    expect(await wd.check()).toBe('restarting');
    expect(await wd.check()).toBe('degraded');
    expect(await wd.check()).toBe('degraded');
    expect(restarts).toHaveLength(1);
  });

  it('有活跃会话（requestRestart 返回 pending）→ restart-pending，不打断会话', async () => {
    const { wd } = makeWatchdog({
      probe: async () => 'unreachable',
      threshold: 1,
      requestRestart: async () => 'pending' as const,
    });
    expect(await wd.check()).toBe('restart-pending');
    // 挂起期间仍算不健康（不能谎报 ok 让平台继续派单）
    expect(wd.isUnhealthy).toBe(true);
  });

  it('恢复后计数清零且允许再次触发重启（下一轮故障仍能自愈）', async () => {
    let healthy = false;
    const { wd, restarts } = makeWatchdog({
      probe: async () => (healthy ? 'ok' : 'unreachable'),
      threshold: 2,
    });
    await wd.check();
    expect(await wd.check()).toBe('restarting');
    expect(restarts).toHaveLength(1);

    healthy = true;
    expect(await wd.check()).toBe('healthy');
    expect(wd.failures).toBe(0);
    expect(wd.isUnhealthy).toBe(false);

    // 再次故障 → 应能重新触发（证明 restartRequested 已复位）
    healthy = false;
    await wd.check();
    expect(await wd.check()).toBe('restarting');
    expect(restarts).toHaveLength(2);
  });

  it('探测函数自身抛错 → 视为不可用，不把异常抛给调用方', async () => {
    const { wd } = makeWatchdog({
      probe: async () => {
        throw new Error('boom');
      },
      threshold: 1,
    });
    await expect(wd.check()).resolves.toBe('restarting');
  });

  it('重启失败 → 保持 degraded，下一轮重试（不抛错、不永久放弃）', async () => {
    let attempts = 0;
    const { wd } = makeWatchdog({
      probe: async () => 'unreachable',
      threshold: 1,
      requestRestart: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('restart failed');
        return 'executed' as const;
      },
    });
    expect(await wd.check()).toBe('degraded'); // 首次重启抛错 → 降级
    expect(attempts).toBe(1);
    expect(await wd.check()).toBe('restarting'); // 下一轮重试成功
    expect(attempts).toBe(2);
  });

  it('阈值下限夹到 1（配置错误不应导致永不重启）', async () => {
    const { wd, restarts } = makeWatchdog({
      probe: async () => 'unreachable',
      threshold: 0,
    });
    expect(await wd.check()).toBe('restarting');
    expect(restarts).toHaveLength(1);
  });
});
