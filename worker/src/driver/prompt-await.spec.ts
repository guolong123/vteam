/**
 * prompt-await 单元测试（T4，D2 完成判定铁律）。
 *
 * mock V1Driver，覆盖：
 * - 完成判定：assistant 消息含 step-finish(reason=stop) → 返回文本/tokens/cost
 * - 无 step-finish 持续轮询（getMessages 多次调用）
 * - 首字判定：reasoning（思考）产出即算首字（serve 先 reasoning 后 text）——只有
 *   reasoning 无 text 时不超时、持续轮询到 step-finish；仅「text/reasoning 均无」才超时
 * - 首字超时 → abort 被调用 + CompletionTimeoutError 携带已收集消息
 * - 首字出现后无完成超时（超过 firstTokenTimeoutMs 总时长仍等待 step-finish，不 abort）
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
  describeTimeoutReason,
  MessageDeltaTracker,
} from './prompt-await';
import { V1Driver, ServeMessage, ServePart } from './v1-driver';

function userMsg(parts: ServePart[] = []): ServeMessage {
  return { info: { id: 'm_user', role: 'user' }, parts };
}

function asstMsg(id: string, parts: ServePart[]): ServeMessage {
  return { info: { id, role: 'assistant' }, parts };
}

/** assistant 消息带 serve 直接透传的 info.error（如 APIError；实测 parts=[]）。 */
function asstErrMsg(id: string, error: unknown): ServeMessage {
  return { info: { id, role: 'assistant', error }, parts: [] };
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

describe('describeTimeoutReason（首字超时根因诊断）', () => {
  it('info.error = APIError（parts=[]，实测结构）→ 诊断含具体模型错误与 HTTP 码', () => {
    const msgs = [
      asstErrMsg('a1', { name: 'APIError', data: { message: 'Invalid API key.', statusCode: 401 } }),
    ];
    expect(describeTimeoutReason(msgs)).toBe('模型调用报错：Invalid API key. (HTTP 401)');
  });

  it('info.error 无 data 但带 message → 透传 message（防御 data 缺失）', () => {
    const msgs = [asstErrMsg('a1', { name: 'APIError', message: 'Unauthorized' })];
    expect(describeTimeoutReason(msgs)).toBe('模型调用报错：Unauthorized');
  });

  it('info.error 优先于 error part（同消息两者并存取 info.error）', () => {
    const msgs: ServeMessage[] = [
      {
        info: { id: 'a1', role: 'assistant', error: { name: 'APIError', data: { message: 'Invalid API key.', statusCode: 401 } } },
        parts: [{ id: 'p_err', type: 'error', error: { message: 'old part error' } }],
      },
    ];
    expect(describeTimeoutReason(msgs)).toBe('模型调用报错：Invalid API key. (HTTP 401)');
  });

  it('info.error = Aborted（MessageAbortedError）→ 不诊断为模型调用报错（aborted 会话可复用），走后续逻辑', () => {
    const msgs = [
      asstErrMsg('a1', { name: 'MessageAbortedError', data: { message: 'Aborted' } }),
    ];
    expect(describeTimeoutReason(msgs)).not.toContain('模型调用报错');
    expect(describeTimeoutReason(msgs)).toContain('无任何输出');
  });

  it('error part → 诊断含「模型调用报错」', () => {
    const msgs = [
      asstMsg('a1', [
        { id: 'p_err', type: 'error', error: { message: 'No authentication/credential provided' } },
      ]),
    ];
    expect(describeTimeoutReason(msgs)).toContain('模型调用报错');
  });

  it('step-finish(reason=error) 带 error.message → 透传该 message', () => {
    const msgs = [
      asstMsg('a1', [
        { id: 'p_fin', type: 'step-finish', reason: 'error', error: { message: '模型凭证无效' } },
      ]),
    ];
    expect(describeTimeoutReason(msgs)).toBe('模型调用报错：模型凭证无效');
  });

  it('error part 无 error.message 但带 text → 透传 text（防御 part.error 缺失）', () => {
    const msgs = [
      asstMsg('a1', [{ id: 'p_err', type: 'error', text: 'provider error: connection refused' }]),
    ];
    expect(describeTimeoutReason(msgs)).toContain('connection refused');
  });

  it('error part 无任何错误详情 → 兜底「未知错误」不抛错', () => {
    const msgs = [asstMsg('a1', [{ id: 'p_err', type: 'error' }])];
    expect(describeTimeoutReason(msgs)).toContain('模型调用报错');
  });

  it('step-finish(reason=tool-calls)（含 reasoning，无 text）→ 诊断含「工具调用循环」（保留：完成但循环调工具仍可能判死）', () => {
    const msgs = [
      asstMsg('a1', [
        { id: 'p1', type: 'reasoning', text: 'Let me check...' },
        { id: 'p2', type: 'step-finish', reason: 'tool-calls' },
      ]),
    ];
    expect(describeTimeoutReason(msgs)).toContain('工具调用循环');
  });

  it('仅 reasoning 无 text（无 step-finish）→ 不再诊断为「思考阶段」（reasoning 已算首字），走「无任何输出」兜底', () => {
    const msgs = [
      asstMsg('a1', [{ id: 'p1', type: 'step-start' }, { id: 'p2', type: 'reasoning', text: 'Let me check...' }]),
    ];
    // reasoning 已算首字：仅 reasoning 场景不会触发首字超时（awaitCompletion 会持续轮询
    // 到 step-finish），本函数只在超时后被调用；纯函数逻辑下此输入无 step-finish(tool-calls)
    // → 走「无任何输出」兜底，且不再含「思考」诊断
    const reason = describeTimeoutReason(msgs);
    expect(reason).not.toContain('思考');
    expect(reason).not.toContain('工具调用循环');
    expect(reason).toContain('无任何输出');
  });

  it('空消息/纯 step-start → 诊断含「无任何输出」', () => {
    expect(describeTimeoutReason([])).toContain('无任何输出');
    const msgs = [asstMsg('a1', [{ id: 'p1', type: 'step-start' }])];
    expect(describeTimeoutReason(msgs)).toContain('无任何输出');
  });

  it('user 消息带 error part 不误诊（诊断只看 assistant）', () => {
    const msgs = [userMsg([{ id: 'p_err', type: 'error', error: { message: 'x' } }])];
    expect(describeTimeoutReason(msgs)).toContain('无任何输出');
  });

  it('serveErrorText 提供时优先于 info.error/兜底（serve 日志模型错误最高优先级）', () => {
    // 无任何消息 + serve 日志错误 → 输出 serve 错误文本
    expect(describeTimeoutReason([], 'Rate limit exceeded. Please try again later.')).toBe(
      '模型调用报错：Rate limit exceeded. Please try again later.',
    );
    // info.error 同时存在也输 serve 日志错误（serve 日志是最近的真实模型调用失败）
    const msgs = [
      asstErrMsg('a1', { name: 'APIError', data: { message: 'Invalid API key.', statusCode: 401 } }),
    ];
    expect(describeTimeoutReason(msgs, 'Free usage exceeded.')).toBe(
      '模型调用报错：Free usage exceeded.',
    );
  });

  it('serveErrorText 空白 → 忽略（走后续诊断兜底）', () => {
    const msgs = [asstErrMsg('a1', { name: 'APIError', data: { message: 'Invalid API key.', statusCode: 401 } })];
    expect(describeTimeoutReason(msgs, '   ')).toBe('模型调用报错：Invalid API key. (HTTP 401)');
  });
});

describe('awaitCompletion', () => {
  it('首次轮询即含 step-finish → 返回文本/tokens/cost，getMessages 只调 1 次', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([
      userMsg([textPart('hi', 100)]),
      asstMsg('a1', [textPart('Hello!', 200), stepFinishPart({ cost: 0.25, tokens: { input: 50, output: 8 } })]),
    ]);

    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
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

    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
    expect(result.text).toBe('done');
    expect(getMessages).toHaveBeenCalledTimes(3);
  });

  it('首字超时（时限内无模型输出）→ abort 被调用 + CompletionTimeoutError 携带已收集消息', async () => {
    const { driver, getMessages, abort } = mockDriver();
    // 只有 step-start（无 text 也无 reasoning）→ 首字永不出现 → 首字超时
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);

    const promise = awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 40, pollMs: 5 });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    await expect(promise).rejects.toThrow(/等待首字超时/);
    expect(abort).toHaveBeenCalledWith('ses_1');
    // 错误携带已收集消息（无首字 → 无文本）
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.result.text).toBe('');
    expect(err.sessionID).toBe('ses_1');
  });

  it('首字出现后无完成超时：超过 firstTokenTimeoutMs 总时长仍持续轮询直到 step-finish（不 abort）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls <= 3) return [asstMsg('a1', [])];                     // 前 3 轮无内容（首字未出现）
      if (calls <= 40) return [asstMsg('a1', [textPart('x', 100)])];  // 首字出现后长轮询（远超总时限）
      return [asstMsg('a1', [textPart('x', 100), stepFinishPart()])]; // 最终完成
    });

    const promise = awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 60, pollMs: 5 });
    await expect(promise).resolves.toMatchObject({ text: 'x' });
    expect(abort).not.toHaveBeenCalled();
    // 首字（约 20ms 出现）后继续轮询 30+ 轮，远超 60ms 总时限，未被误杀
    expect(calls).toBeGreaterThan(10);
  });

  it('仅 reasoning（无 text）→ reasoning 算首字，不超时，持续轮询直到 step-finish 完成', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // 首轮只有 reasoning（无 text）——serve 实测模型先产出思考内容
        return [asstMsg('a1', [{ id: 'p1', type: 'reasoning', text: 'thinking...' }])];
      }
      // 次轮 reasoning + step-finish(stop) 完成（仍无 text）
      return [
        asstMsg('a1', [
          { id: 'p1', type: 'reasoning', text: 'thinking...' },
          stepFinishPart(),
        ]),
      ];
    });

    // 首轮 reasoning 即算首字：不会触发 40ms 首字超时，持续轮询到 step-finish
    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 40, pollMs: 5 });
    expect(result.text).toBe('');
    expect(abort).not.toHaveBeenCalled();
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it('reasoning + 最终 text 完成 → 正常完成（回归：思考后产出正文）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return [asstMsg('a1', [{ id: 'p1', type: 'reasoning', text: 'thinking...' }])];
      }
      return [
        asstMsg('a1', [
          { id: 'p1', type: 'reasoning', text: 'thinking...' },
          { id: 'p2', type: 'text', text: '最终回复', time: { start: 100 } },
          stepFinishPart(),
        ]),
      ];
    });

    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 40, pollMs: 5 });
    expect(result.text).toBe('最终回复');
    expect(abort).not.toHaveBeenCalled();
  });

  it('超时后 abort 失败不掩盖超时错误（双保险中 HTTP abort 已尽力）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    abort.mockRejectedValue(new Error('abort HTTP 500'));

    await expect(
      awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 40, pollMs: 5 }),
    ).rejects.toBeInstanceOf(CompletionTimeoutError);
  });

  it('轮询出现 info.error=APIError → 立即抛 CompletionTimeoutError（不等首字超时），abort 被调用', async () => {
    const { driver, getMessages, abort } = mockDriver();
    // 首字超时设 1000ms 远大于测试耗时：能抛错说明是 info.error 提前失败而非超时
    getMessages.mockResolvedValue([
      asstErrMsg('a1', { name: 'APIError', data: { message: 'Invalid API key.', statusCode: 401 } }),
    ]);

    const promise = awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.message).toContain('Invalid API key.');
    expect(err.message).toContain('HTTP 401');
    expect(abort).toHaveBeenCalledWith('ses_1');
  });

  it('info.error = Aborted → 不提前抛（aborted 会话可复用），继续轮询直到完成', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // 首轮 assistant 消息带 Aborted error（无 parts）——不应触发提前失败
        return [asstErrMsg('a1', { name: 'MessageAbortedError', data: { message: 'Aborted' } })];
      }
      // 次轮完成（step-finish stop）——证明 Aborted 后轮询未被中断
      return [asstMsg('a1', [textPart('ok', 100), stepFinishPart()])];
    });

    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
    expect(result.text).toBe('ok');
    expect(abort).not.toHaveBeenCalled();
  });

  it('onPoll 回调收到每轮消息与已耗时间', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages
      .mockResolvedValueOnce([asstMsg('a1', [])])
      .mockResolvedValueOnce([asstMsg('a1', [stepFinishPart()])]);
    const onPoll = jest.fn();

    await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5, onPoll });
    expect(onPoll).toHaveBeenCalledTimes(2);
    expect(onPoll.mock.calls[1][0]).toHaveLength(1);
    expect(onPoll.mock.calls[1][1]).toBeGreaterThanOrEqual(0);
  });

  it('serve 日志出现模型错误（onServeError 返回 true）→ 提前失败：abort + 抛 CompletionTimeoutError（文案含 serve 错误，不等首字超时）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    // 只有 step-start（无 text/reasoning）：首字永不出现——但 serve 日志错误应提前失败，
    // 不等到 1000ms 首字超时
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const serveLines = [
      'message="stream error" time="2026-01-01T00:00:00Z" error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
    ];
    const onServeError = jest.fn((text: string) => /Rate limit/.test(text));

    const promise = awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => serveLines,
      onServeError,
    });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    // 文案用 serve 错误文本（提取 error.error 并去 AI_APICallError: 前缀），非「模型无任何输出」
    expect(err.message).toContain('模型调用报错');
    expect(err.message).toContain('Rate limit exceeded. Please try again later.');
    expect(err.message).not.toContain('AI_APICallError');
    expect(err.message).not.toContain('模型无任何输出');
    expect(err.serveErrorText).toBe('Rate limit exceeded. Please try again later.');
    expect(onServeError).toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith('ses_1');
  });

  it('serve 日志无匹配错误（onServeError 返回 false）→ 不提前失败，继续轮询直到完成', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return [asstMsg('a1', [])]; // 首轮无内容
      }
      return [asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]; // 次轮完成
    });
    // serve 日志只有正常行（无模型错误关键词）——即使每轮都读到也不触发
    const serveLines = ['message="session created"'];

    const result = await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => serveLines,
      onServeError: (text) => /Rate limit/.test(text),
    });
    expect(result.text).toBe('ok');
    expect(abort).not.toHaveBeenCalled();
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it('serve 日志出现模型错误但消息已完成（step-finish 先命中）→ 正常完成，不误杀', async () => {
    const { driver, getMessages, abort } = mockDriver();
    // 首轮即完成（step-finish）——即使 serve 日志有错误关键词也不触发（完成判定优先）
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('done', 100), stepFinishPart()])]);
    const serveLines = [
      'message="stream error" error.error="AI_APICallError: Rate limit exceeded."',
    ];
    const onServeError = jest.fn();

    const result = await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => serveLines,
      onServeError,
    });
    expect(result.text).toBe('done');
    expect(abort).not.toHaveBeenCalled();
  });

  it('serve 错误文本去重：同一错误行重复出现只触发一次（onServeError 对命中行只调用一次）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const onServeError = jest.fn((text: string) => /Rate limit/.test(text));
    // 同一错误行在 serve 日志中出现两次（环形缓冲残留）——首个命中后即停，不重复调用
    const serveLines = [
      'message="stream error" error.error="AI_APICallError: Rate limit exceeded."',
      'message="stream error" error.error="AI_APICallError: Rate limit exceeded."',
    ];

    const promise = awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => serveLines,
      onServeError,
    });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    // 首个匹配行触发后 break for 循环，同文本不重复调用
    expect(onServeError).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith('ses_1');
  });
});

describe('sendAndAwait', () => {
  it('先取基线（sendMessage 前）再 sendMessage，最后 awaitCompletion（只聚合基线后消息）', async () => {
    const { driver, getMessages, sendMessage } = mockDriver();
    sendMessage.mockResolvedValue(undefined);
    // 第 1 次 getMessages：sendMessage 前基线（空会话）→ 空集合
    // 第 2 次 getMessages：awaitCompletion 轮询 → 本轮完成消息
    getMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);

    const input = { parts: [{ type: 'text', text: 'go' }], directory: '/tmp' };
    const result = await sendAndAwait(driver, 'ses_1', input, { firstTokenTimeoutMs: 1000, pollMs: 5 });
    expect(sendMessage).toHaveBeenCalledWith('ses_1', input);
    expect(result.text).toBe('ok');
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it('复用会话：历史轮次消息（含 step-finish/回复）被基线排除，只聚合本轮新增', async () => {
    const { driver, getMessages, sendMessage } = mockDriver();
    sendMessage.mockResolvedValue(undefined);
    // 基线快照：历史轮次已有 assistant 回复（含 step-finish）——复用会话场景
    getMessages
      .mockResolvedValueOnce([
        asstMsg('h1', [textPart('旧轮回复', 100), stepFinishPart()]),
        userMsg([textPart('旧轮 prompt', 50)]),
      ])
      .mockResolvedValueOnce([
        asstMsg('h1', [textPart('旧轮回复', 100), stepFinishPart()]),
        userMsg([textPart('旧轮 prompt', 50)]),
        userMsg([textPart('本轮 prompt', 60)]),
        asstMsg('n1', [textPart('本轮新回复', 200), stepFinishPart()]),
      ]);

    const result = await sendAndAwait(driver, 'ses_1', { parts: [{ type: 'text', text: '本轮' }] }, { firstTokenTimeoutMs: 1000, pollMs: 5 });
    // 历史 step-finish 不误判完成；历史回复不进入聚合；仅本轮 assistant 文本
    expect(result.text).toBe('本轮新回复');
    // P1 补充：parts 只含 assistant 消息——user 消息（含 prompt 注入的上下文块）不混入，
    // 否则前端 MsgParts 渲染 text part 会显示用户消息/注入内容
    expect(result.parts).toEqual([textPart('本轮新回复', 200), stepFinishPart()]);
  });

  it('buildResult parts 排除 user 消息（prompt 注入的 [群聊历史消息]/<doclib> 块不进入回复 parts）', async () => {
    const { driver, getMessages, sendMessage } = mockDriver();
    sendMessage.mockResolvedValue(undefined);
    getMessages
      .mockResolvedValueOnce([]) // 基线（空会话）
      .mockResolvedValueOnce([
        // 本轮 user 消息含注入上下文块（[群聊历史消息]/<doclib>）
        userMsg([
          { id: 'p_inject', type: 'text', text: '[群聊历史消息]\n用户: 旧问题', time: { start: 1 } },
          { id: 'p_doclib', type: 'text', text: '<doclib>...</doclib>', time: { start: 2 } },
        ]),
        asstMsg('a1', [
          textPart('正常回复', 100),
          { id: 'p_reason', type: 'reasoning', text: '思考过程', time: { start: 50 } },
          stepFinishPart(),
        ]),
      ]);

    const result = await sendAndAwait(driver, 'ses_1', { parts: [{ type: 'text', text: '问' }] }, { firstTokenTimeoutMs: 1000, pollMs: 5 });
    // text 正常（只 assistant）
    expect(result.text).toBe('正常回复');
    // parts 不含 user 消息的注入块 parts
    const partTexts = result.parts.map((p) => p.text ?? '');
    expect(partTexts).not.toContain('[群聊历史消息]');
    expect(partTexts).not.toContain('<doclib>');
    expect(result.parts).toContainEqual(textPart('正常回复', 100));
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

  it('同消息重复轮询：不重复上送（serve 累积列表，按 part 粒度去重）', () => {
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

  it('同消息 parts 增量轮询：空壳不上送，新 part（新 id）逐轮只送增量', () => {
    const tracker = new MessageDeltaTracker();
    // a. 首轮空壳 parts=[] → 返回 0（不上送，不产生 key）
    expect(tracker.extractNewParts([asstMsg('a1', [])])).toHaveLength(0);
    // b. 次轮同消息增补 step-start+reasoning → 返回 2（新增）
    const second = tracker.extractNewParts([
      asstMsg('a1', [
        { id: 'prt1', type: 'step-start' },
        { id: 'prt2', type: 'reasoning' },
      ]),
    ]);
    expect(second).toHaveLength(2);
    expect(second.map((p) => p.id)).toEqual(['prt1', 'prt2']);
    // c. 三轮同消息继续增补 text+step-finish → 只送 prt3+prt4（prt1/prt2 已送不重复）
    const third = tracker.extractNewParts([
      asstMsg('a1', [
        { id: 'prt1', type: 'step-start' },
        { id: 'prt2', type: 'reasoning' },
        { id: 'prt3', type: 'text', text: '你好' },
        { id: 'prt4', type: 'step-finish' },
      ]),
    ]);
    expect(third).toHaveLength(2);
    expect(third.map((p) => p.id)).toEqual(['prt3', 'prt4']);
  });

  it('part 无 id：按 消息id:partIndex 回退去重（增量 part 的索引必然是新值）', () => {
    const tracker = new MessageDeltaTracker();
    // 首轮只有 step-start（无 id）→ 返回 1，记 key `a1:0`
    expect(tracker.extractNewParts([asstMsg('a1', [{ type: 'step-start' }])])).toHaveLength(1);
    // 次轮 append 了 text（仍无 id）→ 只送 index=1 的 text（index=0 已送）
    const fresh = tracker.extractNewParts([
      asstMsg('a1', [{ type: 'step-start' }, { type: 'text', text: '你好' }]),
    ]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.type).toBe('text');
  });
});
