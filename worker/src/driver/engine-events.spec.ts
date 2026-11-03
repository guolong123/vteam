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

describe('会话归属：信封 sessionId 优先于启发式（流式不被误丢）', () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {} };

  /**
   * 复现现场：池代理的 `__default__` 角色同时挂多个会话 ⇒ 「本驱动只有一个会话 /
   * 只有一个在途 turn」的启发式必然失效。此时若不带信封 sessionId，
   * `plugin:vteam/stream-chunk` 会被判成「无归属」丢弃 ⇒ 首字超时误报
   * （实测丢过 9000+ 条并打出「模型无任何输出」）。
   */
  function driverWithTwoSessions(): DshDriver {
    const driver = new DshDriver({ provider: 'mock', model: 'mock-model', logger: silent });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDriver = driver as any;
    anyDriver.ensureMirror('dsh-aaa');
    anyDriver.ensureMirror('dsh-bbb');
    return driver;
  }

  it('两个会话共存时，带信封 sessionId 的 chunk 仍能正确归属并扇出', () => {
    const driver = driverWithTwoSessions();
    const received: EngineEvent[] = [];
    driver.subscribeEvents('dsh-bbb', (e) => received.push(e));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).consumeEvent(
      {
        type: 'plugin:vteam/stream-chunk',
        data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '你好' } },
      },
      'dsh-bbb',
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe('parts');
    expect(received[0]?.parts?.[0]?.type).toBe('text');
    expect(received[0]?.parts?.[0]?.text).toBe('你好');
    // part id 含 sessionId：多会话下必须唯一
    expect(String(received[0]?.parts?.[0]?.id)).toContain('dsh-bbb');
  });

  it('同一 chunk 经两条通道各到一次时只累积一次（否则正文/思考翻倍）', () => {
    const driver = driverWithTwoSessions();
    const received: EngineEvent[] = [];
    driver.subscribeEvents('dsh-bbb', (e) => received.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDriver = driver as any;

    const chunk = { type: 'text-delta', index: 0, text: 'AB' };
    // 通道一：durable plugin record
    anyDriver.consumeEvent({ type: 'plugin:vteam/stream-chunk', data: { turn: 1, step: 0, chunk } }, 'dsh-bbb');
    // 通道二：vendored stream-frame（同一个 chunk 的第二次到达）
    anyDriver.consumeEvent(
      { type: 'assistant/stream-frame', data: { frame: { type: 'chunk', turn: 1, step: 0, chunk } } },
      'dsh-bbb',
    );

    // 只应有一次累积：文本是 'AB' 而不是 'ABAB'
    expect(received).toHaveLength(1);
    expect(received[0]?.parts?.[0]?.text).toBe('AB');
  });

  it('无信封 sessionId 且多会话歧义时仍丢弃（保守，不瞎猜）', () => {
    const driver = driverWithTwoSessions();
    const received: EngineEvent[] = [];
    driver.subscribeEvents('dsh-bbb', (e) => received.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).consumeEvent({
      type: 'plugin:vteam/stream-chunk',
      data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'X' } },
    });
    expect(received).toHaveLength(0);
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

  // ⚠️ DSH turn/end 的真实形状是 `{ turn, reason: { kind } }`（vteam P0 实测：
  // {"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}）。
  // 这三条用例此前喂的是**扁平** `{ kind }`，与 `0476387` 修复后的实现口径不符：
  // completed/aborted 两条误红，error 那条因「未知 kind 也判 error」而**误绿**。
  // 现统一改为真实形状，让它们真正守住 turn/end 分类。
  it('turn/end completed → terminal=succeeded', () => {
    const driver = newDriver();
    const received: EngineEvent[] = [];
    const sessionId = 'dsh-test-2';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);
    driver.subscribeEvents(sessionId, (e) => received.push(e));

    feed(driver, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
      seq: 42,
    });

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

    feed(driver, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    });

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
      data: { turn: 1, reason: { kind: 'error' }, error: { message: 'AUTH 失败' } },
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

  it('未订阅时事件仍维护镜像（两路独立）：turn/end 后定稿为一条消息', () => {
    const driver = newDriver();
    const sessionId = 'dsh-test-7';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mirror = (driver as any).ensureMirror(sessionId);

    feed(driver, {
      type: 'assistant/message',
      data: { message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } },
    });
    // 一 turn 未结束前只在待定区累积（一次 turn = 一条 vteam 消息）
    expect(mirror.messages.length).toBe(0);
    expect(mirror.pendingTurn).toBeDefined();

    feed(driver, { type: 'turn/end', data: { kind: 'completed' } });
    // turn/end 定稿：一条消息，含 text + step-finish
    expect(mirror.messages.length).toBe(1);
    expect(mirror.messages[0].parts.some((p: { type: string }) => p.type === 'text')).toBe(true);
    expect(mirror.messages[0].parts.some((p: { type: string }) => p.type === 'step-finish')).toBe(true);
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

describe('系统提示词走 persona 通道（不拼进用户消息）', () => {
  /**
   * 设计变更（P5 修正）：早期把 system 拼成用户消息前缀，导致对话记录被污染、
   * 每轮重复消耗 token、破坏 KV cache 前缀稳定。
   * 正确机制：DSH 的 `dsh-system-prompt.personaPrefix`（patch + spawn env）。
   * 故 contentBlocks **必须保持纯净**（只含真正的用户内容）。
   */
  const silent = { info: () => {}, warn: () => {}, error: () => {} };

  async function captureBlocks(
    driver: DshDriver,
    sessionId: string,
    system: string,
    text: string,
  ): Promise<{ blocks: string; personaEnv: string }> {
    const captured: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).client.request = async (_m: string, params: any) => {
      captured.push(String(params?.contentBlocks?.[0]?.text ?? ''));
      return { messageId: 'm1' };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureStarted = async () => {};
    // switchPersona 会走 client.close/request，这里桩掉以观察 env 变化
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).client.close = async () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).ensureMirror(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (driver as any).sendMessage(sessionId, { parts: [{ type: 'text', text }], system });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { blocks: captured[0] ?? '', personaEnv: ((driver as any).options.env ?? {}).DSH_SYSTEM_PROMPT ?? '' };
  }

  it('contentBlocks 保持纯净（system 不进用户消息）', async () => {
    const driver = new DshDriver({ provider: 'mock', model: 'm', logger: silent });
    // 预置 persona（避免首轮触发 switchPersona 重启流程干扰捕获）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (driver as any).options.env = { DSH_SYSTEM_PROMPT: '【岗位职责】你是项目经理' };
    const { blocks } = await captureBlocks(driver, 'p-1', '【岗位职责】你是项目经理', '你好');
    expect(blocks).toBe('你好');
    expect(blocks).not.toContain('岗位职责');
  });

  it('system 进入 persona env（DSH 正规通道）', async () => {
    const driver = new DshDriver({ provider: 'mock', model: 'm', logger: silent });
    const { personaEnv } = await captureBlocks(driver, 'p-2', '【岗位职责】你是项目经理', '你好');
    expect(personaEnv).toBe('【岗位职责】你是项目经理');
  });

  it('system 为空时不设置 persona env', async () => {
    const driver = new DshDriver({ provider: 'mock', model: 'm', logger: silent });
    const { blocks, personaEnv } = await captureBlocks(driver, 'p-3', '', '只有正文');
    expect(blocks).toBe('只有正文');
    expect(personaEnv).toBe('');
  });
});
