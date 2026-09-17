import { EventEmitter } from 'events';
import { Prisma } from '@prisma/client';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEvent, RealtimeService } from '../realtime/realtime.service';
import { TriggerService } from '../timers/trigger.service';
import { HookFailureListener } from './hook-failure.listener';
import { buildHookFireDedupKey, HOOK_STATUS, TRIGGER_WAKE_FAILED_EVENT_TYPE } from './hook.constants';
import { HookService } from './hook.service';

/**
 * wake 执行失败记录缝合测（trigger-unification）。
 *
 * 覆盖：真实原因落 hook + 配对 trigger；成功（无 agent.error）零写；
 * 重复失败事件不双写；缺 sessionId/缺 message 安全降级；last_error 截 191；
 * 会话轮转（hook 已非 fired / wakeSessionId 不匹配）不误记。
 */

const makePrisma = () => {
  const store = {
    hook: null as Record<string, unknown> | null,
    trigger: null as Record<string, unknown> | null,
  };
  const hookFindFirst: jest.Mock = jest.fn(async () => store.hook);
  const hookUpdateMany: jest.Mock = jest.fn(async () => ({ count: 0 }));
  const triggerUpdateMany: jest.Mock = jest.fn(async () => ({ count: 0 }));
  return {
    store,
    hookFindFirst,
    hookUpdateMany,
    triggerUpdateMany,
    prisma: {
      hook: {
        findFirst: hookFindFirst,
        updateMany: hookUpdateMany,
      },
      trigger: { updateMany: triggerUpdateMany },
    },
  };
};

const makeHookService = (
  m: ReturnType<typeof makePrisma>,
  realtime: { emit: jest.Mock },
) => {
  const idGen = { nextId: jest.fn(async (p: string) => `${p}_1`), seed: jest.fn() };
  const triggers = {
    registerHandler: jest.fn(),
    schedule: jest.fn(async () => ({})),
    cancel: jest.fn(async () => ({})),
  };
  const dispatcher = {
    dispatchAgentMention: jest.fn(async () => 's_x'),
    isAgentExecuting: jest.fn().mockReturnValue(null),
    isSessionPending: jest.fn().mockReturnValue(false),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  return new HookService(
    m.prisma as unknown as PrismaService,
    idGen as unknown as IdGeneratorService,
    triggers as unknown as TriggerService,
    dispatcher as unknown as never,
    config as unknown as never,
    realtime as unknown as RealtimeService,
  );
};

const makeListener = () => {
  const m = makePrisma();
  const realtime = { emit: jest.fn(async () => ({})) };
  const hooks = makeHookService(m, realtime);
  const listener = new HookFailureListener(
    realtime as unknown as RealtimeService,
    hooks,
  );
  return { m, realtime, hooks, listener };
};

const agentErrorEvent = (payload: Record<string, unknown>): RealtimeEvent => ({
  id: 'ev_1',
  type: EVENT_TYPES.AGENT_ERROR,
  payload,
  timestamp: new Date().toISOString(),
  scopeType: 'task',
  scopeId: 't_1',
});

describe('HookFailureListener（wake 执行失败记录）', () => {
  beforeEach(() => jest.clearAllMocks());

  it('agent.error → 真实原因记到 hook + 配对 trigger + trigger.wake.failed 事件', async () => {
    const { m, realtime, hooks, listener } = makeListener();
    m.store.hook = {
      id: 'hks_0000000001',
      scopeType: 'task',
      scopeId: 't_0000000007',
      ownerInstanceId: 'tmm_0000000008',
      kind: 'time',
      status: HOOK_STATUS.FIRED,
      target: { wakeSessionId: 's_0000000018' },
    };
    m.hookUpdateMany.mockResolvedValue({ count: 1 });
    m.triggerUpdateMany.mockResolvedValue({ count: 1 });
    const spy = jest.spyOn(hooks, 'recordWakeFailure');

    const realReason =
      '执行失败：[prompt-await] 等待首字超时：模型无任何输出';

    await listener.handle(
      agentErrorEvent({ sessionId: 's_0000000018', error: realReason }),
    );

    expect(spy).toHaveBeenCalledWith({
      sessionId: 's_0000000018',
      reason: realReason,
    });
    expect(m.hookUpdateMany).toHaveBeenCalledWith({
      where: { id: 'hks_0000000001', status: HOOK_STATUS.FIRED, lastError: null },
      data: { lastError: realReason, skipReason: realReason },
    });
    expect(m.triggerUpdateMany).toHaveBeenCalledWith({
      where: { dedupKey: buildHookFireDedupKey('hks_0000000001') },
      data: { lastError: realReason, skipReason: realReason },
    });
    expect(realtime.emit).toHaveBeenCalledWith(
      TRIGGER_WAKE_FAILED_EVENT_TYPE,
      expect.objectContaining({
        hookId: 'hks_0000000001',
        status: HOOK_STATUS.FIRED,
        wakeSessionId: 's_0000000018',
        lastError: realReason,
      }),
      { type: 'task', id: 't_0000000007' },
    );
  });

  it('agent.error 用 message 字段（dispatcher 广播契约）优先于 error', async () => {
    const { m, hooks, listener } = makeListener();
    m.store.hook = { id: 'hks_1', target: { wakeSessionId: 's_1' } };
    m.hookUpdateMany.mockResolvedValue({ count: 1 });
    const spied = jest.spyOn(hooks, 'recordWakeFailure');

    await listener.handle(
      agentErrorEvent({ sessionId: 's_1', message: 'Rate limit exceeded', error: 'x' }),
    );

    expect(spied).toHaveBeenCalledWith({
      sessionId: 's_1',
      reason: 'Rate limit exceeded',
    });
  });

  it('成功唤醒（无失败事件）→ 零写库零事件（fired 保持绿）', async () => {
    const { m, realtime, listener } = makeListener();
    m.store.hook = { id: 'hks_1', target: { wakeSessionId: 's_ok' } };

    // 一条 running 状态的 session.updated（正常唤醒入 running）不是失败
    await listener.handle({
      id: 'ev_2',
      type: EVENT_TYPES.SESSION_UPDATED,
      payload: { sessionId: 's_ok', status: 'running' },
      timestamp: new Date().toISOString(),
      scopeType: 'task',
      scopeId: 't_1',
    });

    expect(m.hookFindFirst).not.toHaveBeenCalled();
    expect(m.hookUpdateMany).not.toHaveBeenCalled();
    expect(m.triggerUpdateMany).not.toHaveBeenCalled();
    expect(realtime.emit).not.toHaveBeenCalled();
  });

  it('重复失败事件 → 认领败者（count=0）零双写零事件', async () => {
    const { m, realtime, hooks, listener } = makeListener();
    m.store.hook = { id: 'hks_1', target: { wakeSessionId: 's_1' } };
    m.hookUpdateMany.mockResolvedValueOnce({ count: 1 });
    const spy = jest.spyOn(hooks, 'recordWakeFailure');

    await listener.handle(
      agentErrorEvent({ sessionId: 's_1', error: 'first' }),
    );
    expect(m.triggerUpdateMany).toHaveBeenCalledTimes(1);
    expect(realtime.emit).toHaveBeenCalledTimes(1);

    // 第二个失败事件：认领谓词 lastError:null 已不成立 → count=0
    m.hookUpdateMany.mockResolvedValueOnce({ count: 0 });
    await listener.handle(
      agentErrorEvent({ sessionId: 's_1', error: 'second' }),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(m.triggerUpdateMany).toHaveBeenCalledTimes(1);
    expect(realtime.emit).toHaveBeenCalledTimes(1);
  });

  it('缺 sessionId / 垃圾 sessionId → 安全跳过（不查库不 500）', async () => {
    const { m, listener } = makeListener();

    await listener.handle(agentErrorEvent({ error: 'no session' }));
    await listener.handle(agentErrorEvent({ sessionId: '', error: 'blank' }));

    expect(m.hookFindFirst).not.toHaveBeenCalled();
    expect(m.hookUpdateMany).not.toHaveBeenCalled();
  });

  it('缺 message/error（空 payload）→ 兜底文案落库，不崩', async () => {
    const { m, realtime, listener } = makeListener();
    m.store.hook = { id: 'hks_1', target: { wakeSessionId: 's_1' } };
    m.hookUpdateMany.mockResolvedValue({ count: 1 });

    await listener.handle(agentErrorEvent({ sessionId: 's_1' }));

    expect(m.hookUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('agent 执行失败'),
        }),
      }),
    );
    expect(realtime.emit).toHaveBeenCalledTimes(1);
  });

  it('session.updated(failed) 兜底：agent.error 缺席时仍记录通用原因', async () => {
    const { m, realtime, listener } = makeListener();
    m.store.hook = { id: 'hks_1', target: { wakeSessionId: 's_1' } };
    m.hookUpdateMany.mockResolvedValue({ count: 1 });

    await listener.handle({
      id: 'ev_3',
      type: EVENT_TYPES.SESSION_UPDATED,
      payload: { sessionId: 's_1', status: 'failed' },
      timestamp: new Date().toISOString(),
      scopeType: 'task',
      scopeId: 't_1',
    });

    expect(m.hookUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('session.updated status=failed'),
        }),
      }),
    );
    expect(realtime.emit).toHaveBeenCalledTimes(1);
  });

  it('stale_state：hook 非 fired / wakeSessionId 不匹配 → 不误记', async () => {
    const { m, listener } = makeListener();
    // findFirst 带 status=fired + wakeSessionId 谓词：查无 → null
    m.store.hook = null;

    await listener.handle(agentErrorEvent({ sessionId: 's_rotated', error: 'x' }));

    expect(m.hookFindFirst).toHaveBeenCalledWith({
      where: {
        status: HOOK_STATUS.FIRED,
        target: { path: '$.wakeSessionId', equals: 's_rotated' },
      },
    });
    expect(m.hookUpdateMany).not.toHaveBeenCalled();
  });

  it('last_error 超 191 字 → 截断落库', async () => {
    const { m, listener } = makeListener();
    m.store.hook = { id: 'hks_1', target: { wakeSessionId: 's_1' } };
    m.hookUpdateMany.mockResolvedValue({ count: 1 });

    await listener.handle(
      agentErrorEvent({ sessionId: 's_1', error: 'x'.repeat(500) }),
    );

    const call = m.hookUpdateMany.mock.calls[0][0] as {
      data: { lastError: string };
    };
    expect(call.data.lastError).toHaveLength(191);
  });

  it('DB 抛错 → recordWakeFailure 吞错返回 false（监听器永不抛）', async () => {
    const { m, listener } = makeListener();
    m.hookFindFirst.mockRejectedValue(new Error('db down'));

    await expect(
      listener.handle(agentErrorEvent({ sessionId: 's_1', error: 'x' })),
    ).resolves.toBeUndefined();
  });

  it('并发竞态：agent.error 先到（真实原因）→ session.updated(failed) 后到不覆盖', async () => {
    const bus = new EventEmitter();
    const realtime = {
      subscribe: jest.fn((cb: (e: RealtimeEvent) => void) => {
        bus.on('event', cb);
        return () => bus.off('event', cb);
      }),
      emit: jest.fn(async () => ({})),
    };
    const m = makePrisma();
    m.store.hook = { id: 'hks_1', target: { wakeSessionId: 's_1' } };
    // 首个认领成功；后续事件认领谓词 lastError:null 已不成立
    let claimed = 0;
    m.hookUpdateMany.mockImplementation(async () => {
      claimed += 1;
      return { count: claimed === 1 ? 1 : 0 };
    });
    const hooks = makeHookService(m, realtime);
    const listener = new HookFailureListener(
      realtime as unknown as RealtimeService,
      hooks,
    );

    const realReason = '执行失败：等待首字超时：模型无任何输出';
    // 模拟 bus 同步广播两个事件（agent.error 先行，fallback 紧随）
    listener.onModuleInit();
    bus.emit('event', agentErrorEvent({ sessionId: 's_1', error: realReason }));
    bus.emit('event', {
      id: 'ev_fallback',
      type: EVENT_TYPES.SESSION_UPDATED,
      payload: { sessionId: 's_1', status: 'failed' },
      timestamp: new Date().toISOString(),
      scopeType: 'task',
      scopeId: 't_1',
    });
    // 等待串行链排空
    await new Promise((r) => setTimeout(r, 20));

    const writes = m.hookUpdateMany.mock.calls.map(
      (c) => (c[0] as { data: { lastError: string } }).data.lastError,
    );
    // 首个到达（agent.error 真实原因）认领成功；后到兜底认领 count=0 不落库
    expect(writes[0]).toBe(realReason);
    expect(m.triggerUpdateMany).toHaveBeenCalledTimes(1);
    expect(realtime.emit).toHaveBeenCalledTimes(1);
    expect(realtime.emit).toHaveBeenCalledWith(
      TRIGGER_WAKE_FAILED_EVENT_TYPE,
      expect.objectContaining({ lastError: realReason }),
      expect.anything(),
    );
  });

  it('订阅接线：onModuleInit 订阅 bus，onModuleDestroy 退订', () => {
    const bus = new EventEmitter();
    const realtime = {
      subscribe: jest.fn((cb: (e: RealtimeEvent) => void) => {
        bus.on('event', cb);
        return () => bus.off('event', cb);
      }),
      emit: jest.fn(async () => ({})),
    };
    const m = makePrisma();
    const hooks = makeHookService(m, realtime);
    const listener = new HookFailureListener(
      realtime as unknown as RealtimeService,
      hooks,
    );
    listener.onModuleInit();
    expect(realtime.subscribe).toHaveBeenCalledTimes(1);
    listener.onModuleDestroy();
    expect(bus.listenerCount('event')).toBe(0);
  });
});
