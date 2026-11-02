/**
 * 引擎事件通道单测（P3）。
 *
 * 断言两件事：
 * 1. **契约形状**：`EngineEvent` 的语义分类与终态映射（这是 exec-server 消费的口径）。
 * 2. **DshDriver 的扇出行为**：订阅 → 收到归一事件 → close 后不再收。
 *
 * 为什么值得写：P3 的价值是"exec-server 不再知道引擎怎么订阅"。这个抽象一旦被
 * 后续实现按 v2 的形状理解（比如期望 token 级 delta、期望 trigger 带内容），
 * 就会在 dsh 上静默失效——故用测试把口径钉死。
 */

import { toTerminalVerdict, hasEventChannel, type EngineEvent } from './engine-events';
import { DshDriver } from './dsh-driver';
import type { DshSessionEvent } from './dsh-event-map';

describe('toTerminalVerdict（终态归一）', () => {
  it('completed → succeeded', () => {
    expect(toTerminalVerdict('completed')).toBe('succeeded');
  });

  it('aborted → interrupted（用户中断**不是**失败）', () => {
    expect(toTerminalVerdict('aborted')).toBe('interrupted');
  });

  it('error → failed', () => {
    expect(toTerminalVerdict('error')).toBe('failed');
  });
});

describe('hasEventChannel（运行期能力判定，不用 instanceof）', () => {
  it('具备 subscribeEvents 的对象 → true', () => {
    expect(hasEventChannel({ subscribeEvents: () => ({ close: () => {} }) })).toBe(true);
  });

  it('普通驱动对象（v2，无该方法）→ false', () => {
    expect(hasEventChannel({ sendMessage: () => {} })).toBe(false);
  });

  it('null/原始值 → false（不抛错）', () => {
    expect(hasEventChannel(null)).toBe(false);
    expect(hasEventChannel(undefined)).toBe(false);
    expect(hasEventChannel('x')).toBe(false);
  });
});

describe('DshDriver 事件通道（扇出行为）', () => {
  /** 直接调用私有的 consumeEvent 来模拟引擎事件到达（不启真实子进程）。 */
  function feed(driver: DshDriver, event: DshSessionEvent): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).consumeEvent(event);
  }

  function newDriver(): DshDriver {
    return new DshDriver({ provider: 'mock', model: 'mock-model', logger: silentLogger });
  }

  const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

  it('assistant/message → parts 事件（含 messageID，控制面靠它关联消息）', () => {
    const driver = newDriver();
    const received: EngineEvent[] = [];
    const sessionId = 'dsh-test-session';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);
    driver.subscribeEvents(sessionId, (e) => received.push(e));

    feed(driver, {
      type: 'assistant/message',
      data: {
        message: { id: 'msg-1', content: [{ type: 'text', text: 'PONG' }] },
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe('parts');
    expect(received[0]?.parts?.[0]?.messageID).toBe('msg-1');
    expect(received[0]?.parts?.[0]?.type).toBe('text');
    expect(received[0]?.parts?.[0]?.text).toBe('PONG');
  });

  it('turn/end completed → terminal=succeeded', () => {
    const driver = newDriver();
    const received: EngineEvent[] = [];
    const sessionId = 'dsh-test-2';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);
    driver.subscribeEvents(sessionId, (e) => received.push(e));

    feed(driver, { type: 'turn/end', data: { kind: 'completed' }, seq: 42 });

    expect(received[0]?.kind).toBe('terminal');
    expect(received[0]?.terminal).toBe('succeeded');
    expect(received[0]?.identity?.seq).toBe(42);
  });

  it('turn/end aborted → terminal=interrupted（控制面据此不发 task.completed）', () => {
    const driver = newDriver();
    const received: EngineEvent[] = [];
    const sessionId = 'dsh-test-3';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);
    driver.subscribeEvents(sessionId, (e) => received.push(e));

    feed(driver, { type: 'turn/end', data: { kind: 'aborted', reason: { kind: 'user' } } });

    expect(received[0]?.terminal).toBe('interrupted');
  });

  it('turn/end error → terminal=failed 且带 error 文案', () => {
    const driver = newDriver();
    const received: EngineEvent[] = [];
    const sessionId = 'dsh-test-4';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);
    driver.subscribeEvents(sessionId, (e) => received.push(e));

    feed(driver, {
      type: 'turn/end',
      data: { kind: 'error', error: { message: 'AUTH 失败' } },
    });

    expect(received[0]?.terminal).toBe('failed');
    expect(received[0]?.error).toBe('AUTH 失败');
  });

  it('tool/call → parts 事件（tool part）', () => {
    const driver = newDriver();
    const received: EngineEvent[] = [];
    const sessionId = 'dsh-test-5';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);
    driver.subscribeEvents(sessionId, (e) => received.push(e));

    feed(driver, { type: 'tool/call', data: { callId: 'c1', name: 'mcp__vteam__like', arguments: '{}' } });

    expect(received[0]?.kind).toBe('parts');
    expect(received[0]?.parts?.[0]?.type).toBe('tool');
    expect(received[0]?.parts?.[0]?.tool).toBe('mcp__vteam__like');
  });

  it('close() 后不再收到事件（幂等）', () => {
    const driver = newDriver();
    const received: EngineEvent[] = [];
    const sessionId = 'dsh-test-6';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);
    const sub = driver.subscribeEvents(sessionId, (e) => received.push(e));

    feed(driver, { type: 'turn/end', data: { kind: 'completed' } });
    expect(received).toHaveLength(1);

    sub.close();
    sub.close(); // 幂等
    feed(driver, { type: 'turn/end', data: { kind: 'completed' } });
    expect(received).toHaveLength(1);
  });

  it('未订阅时事件不影响镜像维护（两路独立）', () => {
    const driver = newDriver();
    const sessionId = 'dsh-test-7';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mirror = (driver as any).ensureMirror(sessionId);

    feed(driver, {
      type: 'assistant/message',
      data: { message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } },
    });

    // 镜像照常更新（getMessages 的数据来源）
    expect(mirror.messages.length).toBeGreaterThan(0);
  });

  it('订阅者抛错不冻结其它订阅者（一条失败不毒化整个流）', () => {
    const driver = newDriver();
    const ok: EngineEvent[] = [];
    const sessionId = 'dsh-test-8';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);

    driver.subscribeEvents(sessionId, () => {
      throw new Error('坏订阅者');
    });
    driver.subscribeEvents(sessionId, (e) => ok.push(e));

    expect(() => feed(driver, { type: 'turn/end', data: { reason: { kind: 'completed' } } })).not.toThrow();
    expect(ok).toHaveLength(1);
  });
});
