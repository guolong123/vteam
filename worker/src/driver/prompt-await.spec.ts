/**
 * prompt-await 单元测试（T4，D2 完成判定铁律）。
 *
 * mock V1Driver，覆盖：
 * - 完成判定：assistant 消息含 step-finish(reason=stop) → 返回文本/tokens/cost
 * - 无 step-finish 持续轮询（getMessages 多次调用）
 * - 超时 → abort 被调用 + CompletionTimeoutError 携带部分文本
 * - abort 后消息只有 step-start+reasoning（无 step-finish）不误判为完整回复
 * - 文本聚合：多段按时间排序、messageID 分组、排除 synthetic 合成文本
 * - findFinish：user 消息带 step-finish 不判定（必须 assistant）
 * - sendAndAwait：sendMessage → awaitCompletion 组合
 */

import {
  awaitCompletion,
  sendAndAwait,
  aggregateText,
  findFinish,
  CompletionTimeoutError,
  MessageDeltaTracker,
} from './prompt-await';
import { V1Driver, ServeMessage, ServePart } from './v1-driver';

function userMsg(parts: ServePart[] = []): ServeMessage {
  return { info: { id: 'm_user', role: 'user' }, parts };
}

function asstMsg(id: string, parts: ServePart[]): ServeMessage {
  return { info: { id, role: 'assistant' }, parts };
}

function textPart(text: string, start: number, opts: { synthetic?: boolean } = {}): ServePart {
  return { id: `p_${start}`, type: 'text', text, time: { start }, ...(opts.synthetic ? { synthetic: true } : {}) };
}

function stepFinishPart(over: { reason?: string; cost?: number; tokens?: unknown } = {}): ServePart {
  return {
    id: 'p_fin',
    type: 'step-finish',
    reason: over.reason ?? 'stop',
    cost: over.cost ?? 0.5,
    tokens: over.tokens ?? { input: 100, output: 10 },
  };
}

function mockDriver(): {
  driver: V1Driver;
  getMessages: jest.Mock;
  abort: jest.Mock;
  sendMessage: jest.Mock;
} {
  const getMessages = jest.fn();
  const abort = jest.fn();
  const sendMessage = jest.fn();
  const driver = { getMessages, abort, sendMessage } as unknown as V1Driver;
  return { driver, getMessages, abort, sendMessage };
}

describe('findFinish（完成判定铁律）', () => {
  it('assistant 消息含 step-finish(reason=stop) → 命中', () => {
    const msgs = [asstMsg('a1', [stepFinishPart()])];
    expect(findFinish(msgs)?.reason).toBe('stop');
  });

  it('step-finish 但 reason≠stop → 不命中（只有 stop 才算完整回复）', () => {
    const msgs = [asstMsg('a1', [stepFinishPart({ reason: 'error' })])];
    expect(findFinish(msgs)).toBeUndefined();
  });

  it('user 消息带 step-finish → 不命中（必须 assistant 消息）', () => {
    const msgs = [userMsg([stepFinishPart()])];
    expect(findFinish(msgs)).toBeUndefined();
  });

  it('assistant 消息存在但无 step-finish（如 abort 后只有 step-start+reasoning）→ 不命中', () => {
    const msgs = [
      asstMsg('a1', [
        { id: 'p1', type: 'step-start' },
        { id: 'p2', type: 'reasoning', text: '...' },
      ]),
    ];
    expect(findFinish(msgs)).toBeUndefined();
  });
});

describe('aggregateText（多段拼接规则）', () => {
  it('按 time.start 升序串接全部 text part', () => {
    const msgs = [
      asstMsg('a1', [textPart('B', 200), textPart('A', 100)]),
      asstMsg('a2', [textPart('C', 300)]),
    ];
    expect(aggregateText(msgs)).toBe('ABC');
  });

  it('排除 synthetic 合成文本（工具调用占位，非模型输出）', () => {
    const msgs = [
      asstMsg('a1', [textPart('tool-result', 100, { synthetic: true }), textPart('real', 200)]),
    ];
    expect(aggregateText(msgs)).toBe('real');
  });

  it('无 time 字段的 part 按 0 排序（不抛错）', () => {
    const msgs = [asstMsg('a1', [{ id: 'p1', type: 'text', text: 'x' }, textPart('y', 50)])];
    expect(aggregateText(msgs)).toBe('xy');
  });
});

describe('awaitCompletion', () => {
  it('首次轮询即含 step-finish → 返回文本/tokens/cost，getMessages 只调 1 次', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([
      userMsg([textPart('hi', 100)]),
      asstMsg('a1', [textPart('Hello!', 200), stepFinishPart({ cost: 0.25, tokens: { input: 50, output: 8 } })]),
    ]);

    const result = await awaitCompletion(driver, 'ses_1', { timeoutMs: 1000, pollMs: 5 });
    expect(result.text).toBe('Hello!');
    expect(result.cost).toBe(0.25);
    expect(result.tokens).toEqual({ input: 50, output: 8 });
    expect(getMessages).toHaveBeenCalledTimes(1);
  });

  it('无 step-finish 持续轮询直到出现（getMessages 多次调用）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages
      .mockResolvedValueOnce([asstMsg('a1', [])])
      .mockResolvedValueOnce([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])])
      .mockResolvedValueOnce([asstMsg('a1', [textPart('done', 100), stepFinishPart()])]);

    const result = await awaitCompletion(driver, 'ses_1', { timeoutMs: 1000, pollMs: 5 });
    expect(result.text).toBe('done');
    expect(getMessages).toHaveBeenCalledTimes(3);
  });

  it('超时（无 step-finish）→ abort 被调用 + CompletionTimeoutError 携带部分文本', async () => {
    const { driver, getMessages, abort } = mockDriver();
    // abort 后消息只有 step-start+reasoning（D2：无 step-finish 不应误判为完整回复）
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }, textPart('partial', 100)])]);

    const promise = awaitCompletion(driver, 'ses_1', { timeoutMs: 40, pollMs: 5 });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    await expect(promise).rejects.toThrow(/等待完成超时/);
    expect(abort).toHaveBeenCalledWith('ses_1');
    // 错误携带已收集文本（部分回复可展示）
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.result.text).toBe('partial');
    expect(err.sessionID).toBe('ses_1');
  });

  it('超时后 abort 失败不掩盖超时错误（双保险中 HTTP abort 已尽力）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    abort.mockRejectedValue(new Error('abort HTTP 500'));

    await expect(
      awaitCompletion(driver, 'ses_1', { timeoutMs: 40, pollMs: 5 }),
    ).rejects.toBeInstanceOf(CompletionTimeoutError);
  });

  it('onPoll 回调收到每轮消息与已耗时间', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages
      .mockResolvedValueOnce([asstMsg('a1', [])])
      .mockResolvedValueOnce([asstMsg('a1', [stepFinishPart()])]);
    const onPoll = jest.fn();

    await awaitCompletion(driver, 'ses_1', { timeoutMs: 1000, pollMs: 5, onPoll });
    expect(onPoll).toHaveBeenCalledTimes(2);
    expect(onPoll.mock.calls[1][0]).toHaveLength(1);
    expect(onPoll.mock.calls[1][1]).toBeGreaterThanOrEqual(0);
  });
});

describe('sendAndAwait', () => {
  it('先 sendMessage（带 input）再 awaitCompletion', async () => {
    const { driver, getMessages, sendMessage } = mockDriver();
    sendMessage.mockResolvedValue(undefined);
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);

    const input = { parts: [{ type: 'text', text: 'go' }], directory: '/tmp' };
    const result = await sendAndAwait(driver, 'ses_1', input, { timeoutMs: 1000, pollMs: 5 });
    expect(sendMessage).toHaveBeenCalledWith('ses_1', input);
    expect(result.text).toBe('ok');
  });
});

describe('MessageDeltaTracker（T10：增量上送去重）', () => {
  it('首次轮询：返回全部消息的 parts（按消息扁平拼接）', () => {
    const tracker = new MessageDeltaTracker();
    const msgs = [
      asstMsg('a1', [textPart('A', 100)]),
      asstMsg('a2', [textPart('B', 200), textPart('C', 300)]),
    ];
    const fresh = tracker.extractNewParts(msgs);
    expect(fresh).toHaveLength(3);
    expect(fresh.map((p) => p.text)).toEqual(['A', 'B', 'C']);
  });

  it('同消息重复轮询：不重复上送（serve 累积列表，按消息 id 去重）', () => {
    const tracker = new MessageDeltaTracker();
    const msg = asstMsg('a1', [textPart('A', 100)]);
    expect(tracker.extractNewParts([msg])).toHaveLength(1);
    expect(tracker.extractNewParts([msg])).toHaveLength(0);
    expect(tracker.extractNewParts([msg])).toHaveLength(0);
  });

  it('后续轮询出现新消息：只送新增消息的 parts', () => {
    const tracker = new MessageDeltaTracker();
    tracker.extractNewParts([asstMsg('a1', [textPart('A', 100)])]);
    const fresh = tracker.extractNewParts([
      asstMsg('a1', [textPart('A', 100)]),
      asstMsg('a2', [textPart('B', 200)]),
    ]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.text).toBe('B');
  });

  it('消息无 id 的条目跳过（不参与去重也不上送）', () => {
    const tracker = new MessageDeltaTracker();
    const noId = { info: { id: '', role: 'assistant' }, parts: [textPart('X', 1)] } as ServeMessage;
    expect(tracker.extractNewParts([noId])).toHaveLength(0);
  });

  it('reset 清空已上送集合（多轮执行复用实例时隔离）', () => {
    const tracker = new MessageDeltaTracker();
    const msg = asstMsg('a1', [textPart('A', 100)]);
    expect(tracker.extractNewParts([msg])).toHaveLength(1);
    tracker.reset();
    expect(tracker.extractNewParts([msg])).toHaveLength(1);
  });
});
