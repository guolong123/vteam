/**
 * DshDriver 模型路由切换单测
 * =============================================
 * 钉死两件事：
 * 1. **首选运行期换**：`switchRoute` 走 vendor 的 `session/selectModel`，
 *    **不 close 运行时**（此前是「close + 重新 initialize 重启」）。
 * 2. **兜底仍能重启**：目标镜像没有该 vendor 方法（全部会话切失败）时，
 *    退回原来的重启路径 —— 不能让换模型彻底失效。
 *
 * 为什么值得单测：这条路径决定了「平台上改模型能不能免重启生效」，
 * 而它在真实环境里不容易造出「另一条模型路由」（patch 里只声明一个模型），
 * 故用 mock 把行为钉死在本层。
 */

import { DshDriver } from './dsh-driver';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** 造一个驱动，并注入一个受控的假 RPC 客户端 + 一个已登记的会话。 */
function makeDriver(options: {
  isRunning: boolean;
  requestImpl?: (method: string, params: unknown) => Promise<unknown>;
  sessionIds?: string[];
}) {
  const driver = new DshDriver({ provider: 'p-old', model: 'm-old', logger: silent });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDriver = driver as any;
  const request = jest.fn(async (method: string, params: unknown) =>
    options.requestImpl === undefined
      ? { selected: {} }
      : options.requestImpl(method, params),
  );
  const close = jest.fn(async () => undefined);
  anyDriver.client = { isRunning: options.isRunning, request, close };
  for (const id of options.sessionIds ?? []) {
    anyDriver.sessions.set(id, anyDriver.newMirror(id));
  }
  return { driver, anyDriver, request, close };
}

describe('DshDriver.switchRoute（模型路由切换）', () => {
  it('有会话且运行时在跑 → 走 session/selectModel，**不 close 运行时**', async () => {
    const { anyDriver, request, close } = makeDriver({
      isRunning: true,
      sessionIds: ['s1', 's2'],
    });

    await anyDriver.switchRoute('p-new', 'm-new');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      'session/selectModel',
      { sessionId: 's1', provider: 'p-new', model: 'm-new' },
      15_000,
    );
    expect(request).toHaveBeenCalledWith(
      'session/selectModel',
      { sessionId: 's2', provider: 'p-new', model: 'm-new' },
      15_000,
    );
    // 关键断言：运行期生效 ⇒ 绝不重启
    expect(close).not.toHaveBeenCalled();
    expect(anyDriver.options.provider).toBe('p-new');
    expect(anyDriver.options.model).toBe('m-new');
  });

  it('部分会话切换失败 → 只要有一个成功就不重启', async () => {
    const { anyDriver, close } = makeDriver({
      isRunning: true,
      sessionIds: ['s1', 's2'],
      requestImpl: async (_method, params) => {
        const sid = (params as { sessionId: string }).sessionId;
        if (sid === 's2') throw new Error('session not found');
        return { selected: {} };
      },
    });

    await anyDriver.switchRoute('p-new', 'm-new');

    expect(close).not.toHaveBeenCalled();
    expect(anyDriver.options.model).toBe('m-new');
  });

  it('全部会话切换失败（旧镜像无该 vendor 方法）→ 回退重启运行时', async () => {
    const { anyDriver, close } = makeDriver({
      isRunning: true,
      sessionIds: ['s1'],
      requestImpl: async (method) => {
        if (method === 'session/selectModel') {
          throw new Error('Method not found: session/selectModel');
        }
        // 重启路径里的 session/cancel 等放行
        return {};
      },
    });

    await anyDriver.switchRoute('p-new', 'm-new');

    // 兜底路径必须关掉运行时（下次 ensureStarted 用新路由握手）
    expect(close).toHaveBeenCalled();
    expect(anyDriver.options.model).toBe('m-new');
  });

  it('无会话 → 直接走重启路径（此时重启零成本）', async () => {
    const { anyDriver, close, request } = makeDriver({ isRunning: true, sessionIds: [] });

    await anyDriver.switchRoute('p-new', 'm-new');

    expect(request).not.toHaveBeenCalledWith(
      'session/selectModel',
      expect.anything(),
      expect.anything(),
    );
    expect(close).toHaveBeenCalled();
  });

  it('目标路由与当前一致 → 幂等直接返回（不发 RPC、不重启）', async () => {
    const { anyDriver, request, close } = makeDriver({
      isRunning: true,
      sessionIds: ['s1'],
    });

    await anyDriver.switchRoute('p-old', 'm-old');

    expect(request).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('DshDriver.ensureModel（复用会话每轮对齐）', () => {
  it('委托到 switchRoute：会话在、运行时在 ⇒ 走 selectModel 不重启', async () => {
    const { driver, request, close } = makeDriver({ isRunning: true, sessionIds: ['s1'] });

    await driver.ensureModel({ providerID: 'p-new', modelID: 'm-new' });

    expect(request).toHaveBeenCalledWith(
      'session/selectModel',
      { sessionId: 's1', provider: 'p-new', model: 'm-new' },
      15_000,
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('model 为空/字段缺失 → 什么都不做（不误触发重启）', async () => {
    const { driver, request, close } = makeDriver({ isRunning: true, sessionIds: ['s1'] });

    await driver.ensureModel(null);
    await driver.ensureModel({ providerID: '', modelID: 'm' });

    expect(request).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
