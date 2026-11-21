/**
 * DshDriver / 角色池：**patch 变更后运行时必须换掉**（否则改了配置也不生效）。
 *
 * ── 为什么值得单测 ────────────────────────────────────────────────────
 * DSH 的 profile patch 只在 spawn 时读取，**不监听文件变化**。所以"平台上加了 MCP"
 * 写进 patch 之后，还得有人去换运行时；而换的时机有硬约束：
 * - 空闲 ⇒ 立即关（下次 spawn 读新 patch）；
 * - **有在途回合 ⇒ 不能关**（关了会丢 `turn/end` ⇒ 上层 `awaitCompletion` 卡死、
 *   消息永久 processing —— 这是本仓库反复踩到的老坑）。
 * 这两条互相冲突，只能靠测试钉死。
 */

import { DshDriver } from './dsh-driver';
import { DshRolePool } from './dsh-role-pool';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function makeDriver(sessionIds: string[] = []) {
  const driver = new DshDriver({ provider: 'p', model: 'm', logger: silent });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDriver = driver as any;
  const close = jest.fn(async () => undefined);
  anyDriver.client = { isRunning: true, initialized: true, request: jest.fn(), close };
  for (const id of sessionIds) {
    anyDriver.sessions.set(id, anyDriver.newMirror(id));
  }
  return { driver, anyDriver, close };
}

describe('DshDriver.reloadForPatch', () => {
  it('空闲 → 立即关闭运行时（下次 spawn 按新 patch 握手）', async () => {
    const { driver, close } = makeDriver();

    const applied = await driver.reloadForPatch();

    expect(applied).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(driver.hasPendingPatchReload).toBe(false);
  });

  it('有在途回合 → 不关进程，只登记排队（绝不打断在跑的那一轮）', async () => {
    const { driver, anyDriver, close } = makeDriver(['s1']);
    // 模拟本轮尚未 turn/end
    anyDriver.sessions.get('s1').pendingTurn = { parts: [] };

    const applied = await driver.reloadForPatch();

    expect(applied).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(driver.hasPendingPatchReload).toBe(true);
  });

  it('排队的重载在 turn/end 之后执行（且此时才关运行时）', async () => {
    jest.useFakeTimers();
    try {
      const { driver, anyDriver, close } = makeDriver(['s1']);
      const mirror = anyDriver.sessions.get('s1');
      mirror.pendingTurn = { parts: [] };
      await driver.reloadForPatch();
      expect(close).not.toHaveBeenCalled();

      // 本轮结束
      mirror.pendingTurn = undefined;
      anyDriver.notifyTurnEnd('s1');
      // 延到下一个 tick（让上层先把终态收完）
      await jest.runAllTimersAsync();

      expect(close).toHaveBeenCalledTimes(1);
      expect(driver.hasPendingPatchReload).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('运行时有多个会话：仍有会话在跑 ⇒ 继续排队', async () => {
    jest.useFakeTimers();
    try {
      const { driver, anyDriver, close } = makeDriver(['s1', 's2']);
      anyDriver.sessions.get('s1').pendingTurn = { parts: [] };
      anyDriver.sessions.get('s2').pendingTurn = { parts: [] };
      await driver.reloadForPatch();

      anyDriver.sessions.get('s1').pendingTurn = undefined;
      anyDriver.notifyTurnEnd('s1');
      await jest.runAllTimersAsync();
      expect(close).not.toHaveBeenCalled();

      anyDriver.sessions.get('s2').pendingTurn = undefined;
      anyDriver.notifyTurnEnd('s2');
      await jest.runAllTimersAsync();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('DshRolePool.reloadAllForPatch', () => {
  it('逐个角色运行时刷新：空闲的重载、在跑的排队', async () => {
    const pool = new DshRolePool({ logger: silent, idleTimeoutMs: 0 });
    const idle = await pool.runtimeFor('vteam-developer');
    const busy = await pool.runtimeFor('vteam-tester');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idleAny = idle as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const busyAny = busy as any;
    const idleClose = jest.fn(async () => undefined);
    const busyClose = jest.fn(async () => undefined);
    idleAny.client = { isRunning: true, initialized: true, request: jest.fn(), close: idleClose };
    busyAny.client = { isRunning: true, initialized: true, request: jest.fn(), close: busyClose };
    busyAny.sessions.set('s1', busyAny.newMirror('s1'));
    busyAny.sessions.get('s1').pendingTurn = { parts: [] };

    const result = await pool.reloadAllForPatch();

    expect(result).toEqual({ reloaded: 1, deferred: 1 });
    expect(idleClose).toHaveBeenCalledTimes(1);
    expect(busyClose).not.toHaveBeenCalled();
    await pool.closeAll();
  });
});
