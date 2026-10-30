/**
 * prompt-await 单元测试（T4 + T14，D2 完成判定铁律）。
 *
 * mock 驱动接缝（OpenCodeDriver 的三个方法），覆盖：
 * - 完成判定：assistant 消息含 step-finish(reason=stop) → 返回文本/tokens/cost
 * - 实际模型：info.providerID/modelID → CompletionResult.model（缺失/半截/非字符串 → undefined）
 * - 无 step-finish 持续轮询（getMessages 多次调用）
 * - 首字判定：reasoning（思考）产出即算首字（serve 先 reasoning 后 text）——只有
 *   reasoning 无 text 时不超时、持续轮询到 step-finish；仅「text/reasoning 均无」才超时
 * - 首字超时 → abort 被调用 + CompletionTimeoutError 携带已收集消息
 * - 首字出现后无完成超时（超过 firstTokenTimeoutMs 总时长仍等待 step-finish，不 abort）
 * - abort 后消息只有 step-start+reasoning（无 step-finish）不误判为完整回复
 * - 文本聚合：多段按时间排序、messageID 分组、排除 synthetic 合成文本
 * - findFinish：user 消息带 step-finish 不判定（必须 assistant）
 * - sendAndAwait：sendMessage → awaitCompletion 组合
 *
 * T14（v2 语义）覆盖：
 * - 五条语义逐条对齐 v1 口径：完成判定 / 首字 / 在飞工具态 / 文本聚合 / 错误抽取
 * - **真 V2Driver + 假 v2 server**：把 v2 的 wire 消息喂给真驱动，再喂给语义层——
 *   证明「v1 形状的 part 契约在 v2 上继续成立」（完成判定/聚合/错误抽取都验一遍）
 * - 终态与事件路合流：轮询路**先问闸门、记下自己的证据**，一轮只收口一次
 */

import * as http from 'http';
import {
  awaitCompletion,
  sendAndAwait,
  aggregateText,
  findFinish,
  findAssistantModel,
  isFirstTokenEvent,
  CompletionTimeoutError,
  RunTerminalError,
  describeTimeoutReason,
  extractServeError,
  MessageDeltaTracker,
} from './prompt-await';
import type { EventSignal, RunOutcome } from './prompt-await';
import { RunTerminalGate } from './v2-event-map';
import { V2Driver } from './v2-driver';
import type {
  DriverContent,
  DriverMessage,
  OpenCodeDriver,
} from './opencode-driver';

/** vteam 侧的 part / message 类型（接缝文件自有；T18 起不再经 v1 driver 的兼容别名）。 */
type ServePart = DriverContent;
type ServeMessage = DriverMessage;

function userMsg(parts: ServePart[] = []): ServeMessage {
  return { info: { id: 'm_user', role: 'user' }, parts };
}

function asstMsg(id: string, parts: ServePart[]): ServeMessage {
  return { info: { id, role: 'assistant' }, parts };
}

/** assistant 消息带 serve 回报的实际模型字段（info.providerID / info.modelID）。 */
function asstModelMsg(id: string, parts: ServePart[], modelInfo: Record<string, unknown>): ServeMessage {
  const msg = asstMsg(id, parts);
  Object.assign(msg.info, modelInfo);
  return msg;
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
  driver: OpenCodeDriver;
  getMessages: jest.Mock;
  abort: jest.Mock;
  sendMessage: jest.Mock;
} {
  const getMessages = jest.fn();
  const abort = jest.fn();
  const sendMessage = jest.fn();
  const driver: OpenCodeDriver = {
    baseUrl: 'http://127.0.0.1:4199',
    authPassword: '',
    createSession: jest.fn().mockResolvedValue('ses_stub'),
    sendMessage,
    getMessages,
    listQuestions: jest.fn().mockResolvedValue([]),
    replyQuestion: jest.fn().mockResolvedValue(undefined),
    rejectQuestion: jest.fn().mockResolvedValue(undefined),
    listPermissions: jest.fn().mockResolvedValue([]),
    replyPermission: jest.fn().mockResolvedValue(undefined),
    abort,
    listAgents: jest.fn().mockResolvedValue([]),
    listTodos: jest.fn().mockResolvedValue([]),
    listModels: jest.fn().mockResolvedValue([]),
    listIntegrations: jest.fn().mockResolvedValue([]),
    isHealthy: jest.fn().mockResolvedValue(true),
  };
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

describe('findAssistantModel（serve 实际使用模型）', () => {
  it('info 携带 providerID + modelID → 原样带出（零配置环境的真实模型）', () => {
    const msgs = [
      asstModelMsg('a1', [textPart('x', 100), stepFinishPart()], {
        providerID: 'opencode',
        modelID: 'grok-code',
      }),
    ];
    expect(findAssistantModel(msgs)).toEqual({ providerID: 'opencode', modelID: 'grok-code' });
  });

  it('取持有 step-finish 的那条消息（工具循环换模型时以最后真实调用为准）', () => {
    const msgs = [
      asstModelMsg('a1', [stepFinishPart({ reason: 'tool-calls' })], {
        providerID: 'p1',
        modelID: 'm1',
      }),
      asstModelMsg('a2', [stepFinishPart()], { providerID: 'p2', modelID: 'm2' }),
    ];
    expect(findAssistantModel(msgs)).toEqual({ providerID: 'p2', modelID: 'm2' });
  });

  it('无 step-finish（超时路径）→ 退化为最后一条 assistant 消息的模型', () => {
    const msgs = [
      asstModelMsg('a1', [], { providerID: 'p1', modelID: 'm1' }),
      asstModelMsg('a2', [{ id: 'p1', type: 'reasoning', text: '...' }], {
        providerID: 'p2',
        modelID: 'm2',
      }),
    ];
    expect(findAssistantModel(msgs)).toEqual({ providerID: 'p2', modelID: 'm2' });
  });

  it('只有 modelID 缺 providerID → undefined（不半截拼接）', () => {
    const msgs = [asstModelMsg('a1', [stepFinishPart()], { modelID: 'grok-code' })];
    expect(findAssistantModel(msgs)).toBeUndefined();
  });

  it('只有 providerID 缺 modelID → undefined', () => {
    const msgs = [asstModelMsg('a1', [stepFinishPart()], { providerID: 'opencode' })];
    expect(findAssistantModel(msgs)).toBeUndefined();
  });

  it('非字符串（malformed）→ undefined', () => {
    const msgs = [
      asstModelMsg('a1', [stepFinishPart()], { providerID: 42, modelID: { id: 'grok-code' } }),
    ];
    expect(findAssistantModel(msgs)).toBeUndefined();
  });

  it('空串/空白串 → undefined', () => {
    expect(findAssistantModel([asstModelMsg('a1', [stepFinishPart()], { providerID: '', modelID: 'm' })])).toBeUndefined();
    expect(findAssistantModel([asstModelMsg('a2', [stepFinishPart()], { providerID: 'p', modelID: '   ' })])).toBeUndefined();
  });

  it('info 无任何模型字段（serve 未回报）→ undefined', () => {
    expect(findAssistantModel([asstMsg('a1', [stepFinishPart()])])).toBeUndefined();
    expect(findAssistantModel([])).toBeUndefined();
  });

  it('user 消息携带模型字段 → 不采信（只有 assistant 消息是模型输出）', () => {
    const user = userMsg();
    Object.assign(user.info, { providerID: 'p', modelID: 'm' });
    expect(findAssistantModel([user])).toBeUndefined();
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

  it('serveErrorText 为模型下架（Model not found）→ 明确「模型不可用」+ 提示更换成员模型', () => {
    const reason = describeTimeoutReason(
      [],
      'Model not found: opencode-go/space-bunny-free. Did you mean: space-bunny, cat-jam-free?',
    );
    expect(reason).toContain('模型不可用');
    expect(reason).toContain('更换可用的模型');
    expect(reason).toContain('opencode-go/space-bunny-free');
    expect(reason).not.toContain('模型调用报错');
  });

  it('info.error 为模型下架（ProviderModelNotFoundError）同样产出可执行提示', () => {
    const msgs = [
      asstErrMsg('a1', {
        name: 'ProviderModelNotFoundError',
        data: { message: 'Model not found: opencode/gone' },
      }),
    ];
    const reason = describeTimeoutReason(msgs);
    expect(reason).toContain('模型不可用');
    expect(reason).toContain('更换可用的模型');
    expect(reason).toContain('opencode/gone');
  });

  it('serveLogTail 提供且无其它证据 → 兜底原因附原始日志行（失败必带证据，不只一句笼统话）', () => {
    const tail = [
      'level=INFO message=loading path=/root/.config/opencode/opencode.json',
      'level=INFO message=loop',
    ];
    const reason = describeTimeoutReason([], undefined, tail);
    expect(reason).toContain('无任何输出');
    expect(reason).toContain('level=INFO message=loading path=/root/.config/opencode/opencode.json');
    expect(reason).toContain('level=INFO message=loop');
  });

  it('serveLogTail 为空行/空白 → 忽略（回归纯笼统文案，不产生空证据块）', () => {
    expect(describeTimeoutReason([], undefined, ['', '   '])).toBe(
      '模型无任何输出（可能模型凭据缺失/模型不可用/serve 异常）',
    );
  });

  it('serveErrorText 与 serveLogTail 同时存在 → 提取到的错误优先，不附原始证据', () => {
    const reason = describeTimeoutReason([], 'Rate limit exceeded.', ['level=INFO message=noise']);
    expect(reason).toBe('模型调用报错：Rate limit exceeded.');
    expect(reason).not.toContain('level=INFO message=noise');
  });

  it('info.error 存在时优先于 serveLogTail（证据兜底只在无任何可提取错误时使用）', () => {
    const msgs = [asstErrMsg('a1', { name: 'APIError', data: { message: 'Invalid API key.' } })];
    const reason = describeTimeoutReason(msgs, undefined, ['level=INFO message=noise']);
    expect(reason).toBe('模型调用报错：Invalid API key.');
    expect(reason).not.toContain('原始证据');
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

  it('CompletionResult 带出 serve 实际模型（info.providerID/modelID）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([
      userMsg([textPart('hi', 100)]),
      asstModelMsg('a1', [textPart('Hello!', 200), stepFinishPart()], {
        providerID: 'opencode',
        modelID: 'grok-code',
      }),
    ]);
    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
    expect(result.model).toEqual({ providerID: 'opencode', modelID: 'grok-code' });
  });

  it('info 未回报模型 → result.model 为 undefined（不造假数据）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('x', 100), stepFinishPart()])]);
    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
    expect(result.model).toBeUndefined();
  });

  it('info 只带 modelID → result.model undefined（严格，与 usageModelKey 口径一致）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([
      asstModelMsg('a1', [textPart('x', 100), stepFinishPart()], { modelID: 'grok-code' }),
    ]);
    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
    expect(result.model).toBeUndefined();
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

  it('总时长超限 → abort + 抛 CompletionTimeoutError（执行总时长超限）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    // 首字立即出现（text part），但永不 step-finish → 总时长上限触发（首字超时禁用，隔离本路径）
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('partial', 100)])]);

    const promise = awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 0,
      totalTimeoutMs: 30,
      pollMs: 5,
    });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    await expect(promise).rejects.toThrow(/执行总时长超限/);
    expect(abort).toHaveBeenCalledWith('ses_1');
    // 已收集文本随错误携带（不丢部分回复）
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.result.text).toBe('partial');
  });

  it('总时长上限缺省 = 禁用：首字出现后长轮询不被总时长误杀（default 0 契约）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls <= 10) return [asstMsg('a1', [textPart('x', 100)])];
      return [asstMsg('a1', [textPart('x', 100), stepFinishPart()])];
    });

    const result = await awaitCompletion(driver, 'ses_1', { totalTimeoutMs: 0, pollMs: 5 });
    expect(result.text).toBe('x');
    expect(abort).not.toHaveBeenCalled();
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

  it('空壳 reasoning（思考期 text 恒空、part 数不变）→ 算首字，不误判「模型无任何输出」（线上 ses_f339ae60 误杀回归）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      // 线上实证（opencode 1.18.32 + 免费 provider）：reasoning part 在思考开始时创建，
      // 文本要等 step 结束才一次性落盘——期间 text 恒为 ''、part 数不变、无 step-finish。
      // 若按「文本非空」判首字，这里会在 40ms 后 abort 一个一直在思考的会话（= 误杀）。
      if (calls <= 30) {
        return [
          asstMsg('a1', [
            { id: 'p1', type: 'step-start' },
            { id: 'p2', type: 'reasoning', text: '', time: { start: 1000 } },
          ]),
        ];
      }
      return [
        asstMsg('a1', [
          { id: 'p1', type: 'step-start' },
          { id: 'p2', type: 'reasoning', text: 'thinking done' },
          stepFinishPart(),
        ]),
      ];
    });

    const result = await awaitCompletion(driver, 'ses_shell', {
      firstTokenTimeoutMs: 40,
      pollMs: 5,
    });

    expect(abort).not.toHaveBeenCalled();
    expect(result.text).toBe('');
    expect(getMessages).toHaveBeenCalledTimes(31);
  });

  it('连 reasoning part 都没有（只有 step-start）→ 仍判首字超时 + abort（真·模型无响应兜底不被放宽）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([
      asstMsg('a1', [{ id: 'p1', type: 'step-start' }]),
    ]);

    await expect(
      awaitCompletion(driver, 'ses_noresp', { firstTokenTimeoutMs: 20, pollMs: 5 }),
    ).rejects.toThrow(/等待首字超时/);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('tool 执行中（part 数不变、仅 state/output 推进）→ 活性顺延，不误判首字超时', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls <= 20) {
        // 单个长工具：part 数恒为 1，但 output 持续增长（工具执行中的真实形态）——
        // 若活性只数 parts，则 60ms 时限内零增长 → 误判「无输出」abort 一个活着的会话
        return [
          asstMsg('a1', [
            { id: 'tp1', type: 'tool', state: { status: 'running', output: `chunk-${calls}` } },
          ]),
        ];
      }
      return [
        asstMsg('a1', [
          { id: 'tp1', type: 'tool', state: { status: 'completed', output: 'done' } },
          stepFinishPart(),
        ]),
      ];
    });

    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 60, pollMs: 5 });
    expect(result).toBeDefined();
    expect(abort).not.toHaveBeenCalled();
    expect(calls).toBeGreaterThan(10);
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

  it('serveErrorReader/serveLogReader 收到会话 id（按会话过滤，stale 隔离）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const serveErrorReader = jest.fn(() => [] as string[]);
    const serveLogReader = jest.fn(() => [] as string[]);

    const promise = awaitCompletion(driver, 'ses_42', {
      firstTokenTimeoutMs: 30,
      pollMs: 5,
      serveErrorReader,
      onServeError: () => false,
      serveLogReader,
    });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    expect(serveErrorReader).toHaveBeenCalledWith('ses_42');
    expect(serveLogReader).toHaveBeenCalledWith('ses_42');
  });

  it('cause= 形态（实测 share subscriber failed）→ 提取最深详情并剥 Cause([Fail( 包装，不整行当原因', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const serveLines = [
      'timestamp=2026-09-17T13:49:36.059Z level=ERROR run=8227c1d2 message="share subscriber failed" type=message.updated cause="Cause([Fail(ProviderModelNotFoundError: Model not found: opencode/no-such-model-xyz. Did you mean: gpt-5-nano, gpt-5.4-nano?)])"',
    ];

    const promise = awaitCompletion(driver, 'ses_9', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => serveLines,
      onServeError: (text) => /level=ERROR\b/.test(text),
    });
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.serveErrorText).toBe(
      'Model not found: opencode/no-such-model-xyz. Did you mean: gpt-5-nano, gpt-5.4-nano?',
    );
    expect(err.message).not.toContain('Cause([Fail(');
    expect(err.message).not.toContain('timestamp=');
  });

  it('无任何可提取错误 + serveLogReader 有原始行 → 抛错原因附原始日志（证据不丢）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const tail = [
      'timestamp=t level=INFO message=loading path=/x',
      'timestamp=t level=INFO message=loop',
    ];

    const promise = awaitCompletion(driver, 'ses_9', {
      firstTokenTimeoutMs: 30,
      pollMs: 5,
      serveErrorReader: () => [],
      onServeError: () => false,
      serveLogReader: () => tail,
    });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.message).toContain('timestamp=t level=INFO message=loop');
    expect(err.message).toContain('level=INFO message=loading path=/x');
    expect(abort).toHaveBeenCalledWith('ses_9');
  });

  it('serveLogTailLines 截断：仅附最近 N 行（默认 20）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const tail = Array.from({ length: 50 }, (_, i) => `level=INFO message=line-${i}`);

    const promise = awaitCompletion(driver, 'ses_9', {
      firstTokenTimeoutMs: 30,
      pollMs: 5,
      serveErrorReader: () => [],
      onServeError: () => false,
      serveLogReader: () => tail,
      serveLogTailLines: 3,
    });
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.message).toContain('level=INFO message=line-49');
    expect(err.message).not.toContain('level=INFO message=line-46');
  });

  it('有可提取错误时不用原始证据兜底（提取优先，证据不冗余）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const serveLines = [
      'message="stream error" error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
    ];

    const promise = awaitCompletion(driver, 'ses_9', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => serveLines,
      onServeError: (text) => /Rate limit/.test(text),
      serveLogReader: () => ['level=INFO message=noise'],
    });
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.message).toContain('模型调用报错：Rate limit exceeded. Please try again later.');
    expect(err.message).not.toContain('level=INFO message=noise');
    expect(err.message).not.toContain('模型无任何输出');
  });

  it('基线内陈旧错误行不触发快检（复用会话/文件回退旧行不秒杀新一轮）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return [asstMsg('a1', [{ id: 'p1', type: 'step-start' }])];
      }
      return [asstMsg('a1', [textPart('ok', 100), stepFinishPart()])];
    });
    // 上一轮失败的旧错误行（recentErrors 文件回退跨重启残留）——已在基线内
    const staleLine =
      'timestamp=2026-09-21T06:05:33.649Z level=ERROR run=0356f23f message="stream error" providerID=qwen-27b modelID=coldfusion-27b session.id=ses_1 small=false agent=vteam-tester mode=primary error.error="AI_APICallError: Headquarters mode"';
    const onServeError = jest.fn(
      (text: string) => /level=ERROR\b/.test(text) && /AI_APICallError/.test(text),
    );

    const result = await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => [staleLine],
      onServeError,
      baselineServeErrorLines: new Set([staleLine]),
    });
    expect(result.text).toBe('ok');
    expect(abort).not.toHaveBeenCalled();
    expect(onServeError).not.toHaveBeenCalled();
  });

  it('基线外新追加错误行仍触发快检（真错误不漏报，文案为完整提取文本）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const staleLine = 'timestamp=t level=ERROR message="stream error" error.error="AI_APICallError: Old failure"';
    const freshLine =
      'timestamp=t2 level=ERROR run=x message="stream error" session.id=ses_1 error.error="AI_APICallError: Rate limit exceeded. Please try again later."';
    let reads = 0;
    const serveErrorReader = jest.fn(() => {
      reads += 1;
      // 首轮只有旧行（基线内），次轮新错误行追加
      return reads === 1 ? [staleLine] : [staleLine, freshLine];
    });
    const onServeError = jest.fn(
      (text: string) => /level=ERROR\b/.test(text) && /AI_APICallError/.test(text),
    );

    const promise = awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader,
      onServeError,
      baselineServeErrorLines: new Set([staleLine]),
    });
    const err = (await promise.catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err.message).toContain('模型调用报错：Rate limit exceeded. Please try again later.');
    expect(err.serveErrorText).toBe('Rate limit exceeded. Please try again later.');
    expect(abort).toHaveBeenCalledWith('ses_1');
  });

  it('主循环持续追加新 parts（长 tool 循环，无 text/reasoning）→ 首字超时顺延，不误杀', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    getMessages.mockImplementation(async () => {
      calls += 1;
      // 每轮 20ms + poll 间隔：10 轮累计远超 100ms 超时——无顺延会在第 ~5 轮误杀
      await new Promise((r) => setTimeout(r, 20));
      if (calls < 10) {
        const parts = Array.from({ length: calls }, (_, i) => ({
          id: `pt_${i}`,
          type: 'tool',
          tool: 'vteam_group_post',
        }));
        return [asstMsg('a1', parts)];
      }
      return [asstMsg('a1', [textPart('done', 100), stepFinishPart()])];
    });

    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 100, pollMs: 5 });
    expect(result.text).toBe('done');
    expect(abort).not.toHaveBeenCalled();
    expect(calls).toBeGreaterThanOrEqual(10);
  });

  it('无任何新输出（静态空壳）→ 首字超时仍触发（顺延不掩护真 hang）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);

    const promise = awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 60, pollMs: 5 });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    expect(abort).toHaveBeenCalledWith('ses_1');
  });

  it('secret 等待：仅在途 tool part（无 text/reasoning）且 serve 静止 → 首字窗口过期不 abort，直到工具返回', async () => {
    const { driver, getMessages, abort } = mockDriver();
    let calls = 0;
    const runningTool = {
      id: 'tp1',
      type: 'tool',
      tool: 'vteam_secret_command',
      state: { status: 'running', time: { start: 1 } },
    };
    getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls <= 60) {
        return [asstMsg('a1', [runningTool])];
      }
      return [
        asstMsg('a1', [
          { ...runningTool, state: { status: 'completed', time: { start: 1, end: 9 } } },
          stepFinishPart(),
        ]),
      ];
    });

    const result = await awaitCompletion(driver, 'ses_secret_wait', {
      firstTokenTimeoutMs: 40,
      pollMs: 5,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(calls).toBeGreaterThan(60);
    expect(result).toBeDefined();
  });

  it('工具已终态（completed）且无任何新输出 → 首字超时照常（在途豁免不掩护真 hang）', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([
      asstMsg('a1', [
        { id: 'tp1', type: 'tool', state: { status: 'completed', output: 'done' } },
      ]),
    ]);

    const promise = awaitCompletion(driver, 'ses_done_tool', {
      firstTokenTimeoutMs: 60,
      pollMs: 5,
    });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    expect(abort).toHaveBeenCalledWith('ses_done_tool');
  });

  it('tool part 无 state（未知状态）→ 不享受在途豁免，首字超时照常', async () => {
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([
      asstMsg('a1', [{ id: 'tp1', type: 'tool', tool: 'vteam_group_post' }]),
    ]);

    const promise = awaitCompletion(driver, 'ses_stateless_tool', {
      firstTokenTimeoutMs: 60,
      pollMs: 5,
    });
    await expect(promise).rejects.toBeInstanceOf(CompletionTimeoutError);
    expect(abort).toHaveBeenCalledWith('ses_stateless_tool');
  });
});

describe('extractServeError（转义引号）', () => {
  it('error.error 值内转义引号完整捕获（线上 vLLM 400 行，不再截成 \\）', () => {
    const line =
      'timestamp=2026-09-21T06:05:33.649Z level=ERROR run=0356f23f message="stream error" providerID=qwen-27b modelID=coldfusion-27b session.id=ses_1 small=false agent=vteam-tester mode=primary error.error="AI_APICallError: \\"auto\\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"';
    expect(extractServeError(line)).toBe(
      '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
    );
  });

  it('无转义的普通行行为不变', () => {
    expect(
      extractServeError(
        'message="stream error" error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
      ),
    ).toBe('Rate limit exceeded. Please try again later.');
  });

  it('顶层 prompt_async failed 的 Cause([Die(ProviderModelNotFoundError: …)]) → 剥包装并去类型前缀', () => {
    const line =
      'level=ERROR message="prompt_async failed" sessionID=ses_mine cause="Cause([Die(ProviderModelNotFoundError: Model not found: opencode-go/space-bunny-free. Did you mean: space-bunny, cat-jam-free, longcat-2.5-preview-free?)])"';
    expect(extractServeError(line)).toBe(
      'Model not found: opencode-go/space-bunny-free. Did you mean: space-bunny, cat-jam-free, longcat-2.5-preview-free?',
    );
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

  it('buildResult parts 排除 user 消息（prompt 注入的 [群聊历史消息]/<doclib> 块不进入回复 parts）', async () => {    const { driver, getMessages, sendMessage } = mockDriver();
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

  it('send 前快照 serve 错误基线：旧行不秒杀新一轮（线上陈旧秒杀根因）', async () => {
    const { driver, getMessages, sendMessage, abort } = mockDriver();
    sendMessage.mockResolvedValue(undefined);
    getMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);
    const staleLine =
      'timestamp=2026-09-21T06:05:33.649Z level=ERROR run=0356f23f message="stream error" session.id=ses_1 error.error="AI_APICallError: Old failure"';
    const serveErrorReader = jest.fn(() => [staleLine]);
    const onServeError = jest.fn(
      (text: string) => /level=ERROR\b/.test(text) && /AI_APICallError/.test(text),
    );

    const result = await sendAndAwait(
      driver,
      'ses_1',
      { parts: [{ type: 'text', text: 'go' }] },
      { firstTokenTimeoutMs: 1000, pollMs: 5, serveErrorReader, onServeError },
    );
    expect(result.text).toBe('ok');
    expect(abort).not.toHaveBeenCalled();
    expect(onServeError).not.toHaveBeenCalled();
    expect(serveErrorReader).toHaveBeenCalledWith('ses_1');
  });

  it('serveErrorReader 快照失败不阻断执行（降级无基线）', async () => {
    const { driver, getMessages, sendMessage } = mockDriver();
    sendMessage.mockResolvedValue(undefined);
    getMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);

    const result = await sendAndAwait(
      driver,
      'ses_1',
      { parts: [{ type: 'text', text: 'go' }] },
      {
        firstTokenTimeoutMs: 1000,
        pollMs: 5,
        serveErrorReader: () => {
          throw new Error('log unreadable');
        },
        onServeError: () => false,
      },
    );
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

  it('tool part 状态指纹重发：pending({})→running(带 input)→completed(带 output) 逐态上送', () => {
    const tracker = new MessageDeltaTracker();
    const tool = (state: Record<string, unknown>): ServePart =>
      ({ id: 'prt_tool', type: 'tool', tool: 'bash', state }) as ServePart;
    // 首发：pending + input {}（模型参数解析前的空壳，曾致 UI 永远 running + 输入 {}）
    expect(
      tracker.extractNewParts([asstMsg('a1', [tool({ status: 'pending', input: {} })])]),
    ).toHaveLength(1);
    // 同状态重复轮询 → 指纹不变，不重发
    expect(
      tracker.extractNewParts([asstMsg('a1', [tool({ status: 'pending', input: {} })])]),
    ).toHaveLength(0);
    // running：参数解析完成写入 input → 指纹变化，重发
    expect(
      tracker.extractNewParts([asstMsg('a1', [tool({ status: 'running', input: { command: 'ls' } })])]),
    ).toHaveLength(1);
    // completed：输出写入 output → 指纹变化，重发
    expect(
      tracker.extractNewParts([asstMsg('a1', [tool({ status: 'completed', input: { command: 'ls' }, output: 'a.txt' })])]),
    ).toHaveLength(1);
    // 终态后重复轮询 → 不再重发
    expect(
      tracker.extractNewParts([asstMsg('a1', [tool({ status: 'completed', input: { command: 'ls' }, output: 'a.txt' })])]),
    ).toHaveLength(0);
  });

  it('text part 增长阈值重发：累计增长 <64 字符不重发，≥64 才重发（流式刷新 + 带宽受控）', () => {
    const tracker = new MessageDeltaTracker();
    const text = (s: string): ServePart => ({ id: 'prt_text', type: 'text', text: s }) as ServePart;
    expect(tracker.extractNewParts([asstMsg('a1', [text('短思考')])])).toHaveLength(1); // 首发
    expect(tracker.extractNewParts([asstMsg('a1', [text('短思考，又长了几个字')])])).toHaveLength(0); // 增长不足阈值
    const grown = 'x'.repeat(80);
    expect(tracker.extractNewParts([asstMsg('a1', [text(grown)])])).toHaveLength(1); // 累计 80-3=77 ≥64 → 重发
    expect(tracker.extractNewParts([asstMsg('a1', [text(`${grown}又几个字`)])])).toHaveLength(0); // 再增长 4 <64
    expect(tracker.extractNewParts([asstMsg('a1', [text(`${grown}又几个字${'y'.repeat(64)}`)])])).toHaveLength(1); // 再累计 ≥64 → 重发
  });

  it('reasoning part 增长重发：text / summary 等候选字段均计入长度', () => {
    const tracker = new MessageDeltaTracker();
    const reasoning = (s: string): ServePart => ({ id: 'prt_r', type: 'reasoning', text: s }) as ServePart;
    expect(tracker.extractNewParts([asstMsg('a1', [reasoning('想')])])).toHaveLength(1); // 首发
    expect(tracker.extractNewParts([asstMsg('a1', [reasoning('想'.repeat(10))])])).toHaveLength(0); // 增长不足
    expect(tracker.extractNewParts([asstMsg('a1', [reasoning('想'.repeat(80))])])).toHaveLength(1); // 累计 ≥64
    // summary 字段（部分 serve 模型 reasoning 内容落 summary）同样计入
    const r1 = { id: 'prt_r2', type: 'reasoning', summary: '摘'.repeat(70) } as ServePart;
    expect(tracker.extractNewParts([asstMsg('a1', [r1])])).toHaveLength(1); // 首发
    const r2 = { id: 'prt_r2', type: 'reasoning', summary: '摘'.repeat(140) } as ServePart;
    expect(tracker.extractNewParts([asstMsg('a1', [r2])])).toHaveLength(1); // 增长 70 ≥64 → 重发
  });

  it('reasoning 空壳（无任何文本字段）→ 首发后不再重发', () => {
    const tracker = new MessageDeltaTracker();
    const shell = { id: 'prt_r', type: 'reasoning' } as ServePart;
    expect(tracker.extractNewParts([asstMsg('a1', [shell])])).toHaveLength(1); // 首发仍上送
    expect(tracker.extractNewParts([asstMsg('a1', [shell])])).toHaveLength(0); // 空壳不重发
  });

  it('step-start/step-finish 等非 tool 非 text part：仅首次上送（回归增量语义）', () => {
    const tracker = new MessageDeltaTracker();
    const msg = asstMsg('a1', [{ id: 'prt_s', type: 'step-start' } as ServePart]);
    expect(tracker.extractNewParts([msg])).toHaveLength(1);
    expect(tracker.extractNewParts([msg])).toHaveLength(0);
  });

  it('双路协同：noteSent 记录 SSE 已发进度后，轮询旧快照被压制（不回退覆盖）', () => {
    const tracker = new MessageDeltaTracker();
    const tool = (status: string, extra: Record<string, unknown> = {}): ServePart =>
      ({ id: 'prt_t', type: 'tool', tool: 'bash', state: { status, ...extra } }) as ServePart;
    // SSE 路先送达 completed（快照外的实时事件）并记录基准
    tracker.noteSent(tool('completed', { input: { command: 'ls' }, output: 'a.txt' }));
    // 轮询路随后拿到**旧**快照（running，无 output）：进度值更小 → 压制，不重发
    expect(tracker.extractNewParts([asstMsg('a1', [tool('running', { input: { command: 'ls' } })])])).toHaveLength(0);
    // 轮询快照反而更新（terminal 后又写入更多 output）：进度更大 → 正常重发
    expect(
      tracker.extractNewParts([asstMsg('a1', [tool('completed', { input: { command: 'ls' }, output: 'a.txt\nb.txt' })])]),
    ).toHaveLength(1);
  });

  it('双路协同：text 经 noteSent 记录长度后，旧/微增长快照不重发，大增长才重发', () => {
    const tracker = new MessageDeltaTracker();
    const text = (s: string): ServePart => ({ id: 'prt_t', type: 'text', text: s }) as ServePart;
    tracker.noteSent(text('x'.repeat(80))); // SSE 已发到 80 字符
    expect(tracker.extractNewParts([asstMsg('a1', [text('x'.repeat(84))])])).toHaveLength(0); // 增长 4 <64
    expect(tracker.extractNewParts([asstMsg('a1', [text('y'.repeat(10))])])).toHaveLength(0); // 旧长度 10 <80
    expect(tracker.extractNewParts([asstMsg('a1', [text('x'.repeat(200))])])).toHaveLength(1); // 增长 120 ≥64
  });

  it('tool 进度含 input/output 长度：参数写入（rank 不变）也触发重发', () => {
    const tracker = new MessageDeltaTracker();
    const tool = (state: Record<string, unknown>): ServePart =>
      ({ id: 'prt_t', type: 'tool', tool: 'bash', state }) as ServePart;
    // 首发：running + 空 input
    expect(tracker.extractNewParts([asstMsg('a1', [tool({ status: 'running', input: {} })])])).toHaveLength(1);
    // 同 rank 但 input 变长 → 进度推进 → 重发
    expect(tracker.extractNewParts([asstMsg('a1', [tool({ status: 'running', input: { command: 'ls -la' } })])])).toHaveLength(1);
    // 完全相同的快照 → 进度相等 → 不重发
    expect(tracker.extractNewParts([asstMsg('a1', [tool({ status: 'running', input: { command: 'ls -la' } })])])).toHaveLength(0);
  });
});

describe('MessageDeltaTracker.admitSsePart（SSE 路单调准入：拒绝回退快照）', () => {
  const text = (body: string): ServePart =>
    ({ id: 'prt_t', type: 'text', text: body }) as ServePart;
  const tool = (state: Record<string, unknown>): ServePart =>
    ({ id: 'prt_tool', type: 'tool', tool: 'bash', state }) as ServePart;

  it('首次出现放行并记录基准；同长度 delta 不重发（要求严格增长）', () => {
    const tracker = new MessageDeltaTracker();
    expect(tracker.admitSsePart(text('你好'), 'delta')).toBe(true);
    expect(tracker.admitSsePart(text('你好'), 'delta')).toBe(false); // 等长非 update → 拒绝
  });

  it('回归护栏：轮询已发全文后，SSE 重连片段（更短）被拒绝且不降低基准', () => {
    const tracker = new MessageDeltaTracker();
    // 轮询路先上送全文（player: 已发 100 字符）
    expect(
      tracker.extractNewParts([asstMsg('a1', [text('x'.repeat(100))])]),
    ).toHaveLength(1);
    // SSE 路（重连后 delta 缓冲从零累积）拿到的是更短的后缀片段 → 拒绝（不覆盖全文）
    expect(tracker.admitSsePart(text('x'.repeat(10)), 'delta')).toBe(false);
    // 基准未被降低：随后轮询的更大全量快照仍能上送
    expect(
      tracker.extractNewParts([asstMsg('a1', [text('x'.repeat(200))])]),
    ).toHaveLength(1);
  });

  it('advancing delta（严格增长）放行；kind=update 允许等长替换（权威快照修正）', () => {
    const tracker = new MessageDeltaTracker();
    expect(tracker.admitSsePart(text('a'), 'delta')).toBe(true);
    expect(tracker.admitSsePart(text('ab'), 'delta')).toBe(true); // 增长 → 放行
    expect(tracker.admitSsePart(text('ab'), 'update')).toBe(true); // 等长 update → 放行（修正 time/type）
    expect(tracker.admitSsePart(text('a'), 'update')).toBe(false); // 更短 → 即使 update 也拒绝
  });

  it('text 空壳（无文本字段）不重发；其余类型仅首次放行', () => {
    const tracker = new MessageDeltaTracker();
    const shell = { id: 'prt_r', type: 'reasoning' } as ServePart;
    expect(tracker.admitSsePart(shell, 'update')).toBe(true); // 首发
    expect(tracker.admitSsePart(shell, 'delta')).toBe(false); // 空壳不重发
    const step = { id: 'prt_s', type: 'step-start' } as ServePart;
    expect(tracker.admitSsePart(step, 'update')).toBe(true);
    expect(tracker.admitSsePart(step, 'update')).toBe(false);
  });

  it('tool part：进度推进（pending→running→completed）放行；旧快照回退被拒绝', () => {
    const tracker = new MessageDeltaTracker();
    expect(tracker.admitSsePart(tool({ status: 'pending', input: {} }), 'update')).toBe(true);
    expect(
      tracker.admitSsePart(tool({ status: 'running', input: { command: 'ls' } }), 'update'),
    ).toBe(true);
    expect(
      tracker.admitSsePart(tool({ status: 'completed', input: { command: 'ls' }, output: 'a.txt' }), 'update'),
    ).toBe(true);
    // 旧快照（更小进度）到达 → 拒绝，不回退卡片
    expect(
      tracker.admitSsePart(tool({ status: 'running', input: { command: 'ls' } }), 'update'),
    ).toBe(false);
  });

  it('reset 清空基准后 admitSsePart 重新接受首帧（多轮隔离契约不回退）', () => {
    const tracker = new MessageDeltaTracker();
    expect(tracker.admitSsePart(text('abc'), 'delta')).toBe(true);
    tracker.reset();
    expect(tracker.admitSsePart(text('a'), 'delta')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T14：v2 语义（五条语义逐条对齐 v1 口径 + 终态与事件路合流）
// ---------------------------------------------------------------------------

/** 假 v2 server：`GET /api/session/:id/message` 返回预置的 **v2 wire 消息**。 */
async function startFakeV2MessageServer(messages: unknown[]): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const send = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (req.method === 'GET' && /^\/api\/session\/[^/]+\/message$/.test(url.pathname)) {
        send(200, { data: messages, cursor: { previous: null, next: null } });
        return;
      }
      if (req.method === 'POST' && /^\/api\/session\/[^/]+\/interrupt$/.test(url.pathname)) {
        send(200, { data: { interrupted: false } });
        return;
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** v2 的 assistant 消息（wire 形状；`finish` 缺省 = 该步还没结束）。 */
function v2Assistant(
  over: {
    id?: string;
    content?: unknown[];
    finish?: string;
    cost?: number;
    tokens?: unknown;
    error?: unknown;
    created?: number;
    completed?: number;
  } = {},
): Record<string, unknown> {
  const created = over.created ?? 1000;
  return {
    id: over.id ?? 'msg_a1',
    type: 'assistant',
    time: { created, ...(over.completed !== undefined ? { completed: over.completed } : {}) },
    agent: 'build',
    model: { id: 'spike-model', providerID: 'spike-mock' },
    ...(over.finish !== undefined ? { finish: over.finish, rawFinish: over.finish } : {}),
    ...(over.cost !== undefined ? { cost: over.cost } : {}),
    ...(over.tokens !== undefined ? { tokens: over.tokens } : {}),
    ...(over.error !== undefined ? { error: over.error } : {}),
    ...(over.content !== undefined ? { content: over.content } : {}),
  };
}

/** 事件路信号的可控替身（结构上等价 v2 的 `RunTerminalGate` + 一个首字标志）。 */
class FakeEventSignal implements EventSignal {
  private outcome: RunOutcome | null = null;
  /** 轮询路记进闸门的证据（用于断言「轮询路也留了痕」）。 */
  readonly pollingEvidence: RunOutcome[] = [];
  firstTokenSeen = false;

  peek(): RunOutcome | null {
    return this.outcome;
  }

  notePolling(outcome: RunOutcome): void {
    this.pollingEvidence.push(outcome);
  }

  firstToken(): boolean {
    return this.firstTokenSeen;
  }

  /** 事件路送来终态证据。 */
  setTerminal(outcome: RunOutcome | null): void {
    this.outcome = outcome;
  }
}

describe('T14 完成判定（v2）', () => {
  it('有 assistant 正文但无终态信号 → 不判完成（v1 铁律在 v2 继续成立）', async () => {
    const server = await startFakeV2MessageServer([
      // 消息已产出正文，但**没有 finish** ⇒ 驱动不合成 step-finish ⇒ 不是终态
      v2Assistant({ content: [{ type: 'text', text: 'MOCK_OK' }] }),
    ]);
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl });
      const messages = await driver.getMessages('ses_1');
      expect(findFinish(messages)).toBeUndefined();
      expect(aggregateText(messages)).toBe('MOCK_OK');
      // 轮询路也不会把它当完成（首字已出现 → 无首字超时，只能靠总时长上限收尾）
      const err = (await awaitCompletion(driver, 'ses_1', {
        firstTokenTimeoutMs: 30,
        totalTimeoutMs: 120,
        pollMs: 5,
      }).catch((e: unknown) => e)) as CompletionTimeoutError;
      expect(err).toBeInstanceOf(CompletionTimeoutError);
      expect(err.message).toContain('执行总时长超限');
    } finally {
      await server.close();
    }
  });

  it('消息带 finish=stop → 驱动合成 step-finish(reason=stop) → 判完成，正文/用量/模型齐出', async () => {
    const server = await startFakeV2MessageServer([
      v2Assistant({
        content: [{ type: 'text', text: 'MOCK_OK' }],
        finish: 'stop',
        cost: 0.25,
        tokens: { input: 50, output: 8 },
        completed: 2000,
      }),
    ]);
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl });
      const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
      expect(result.text).toBe('MOCK_OK');
      expect(result.cost).toBe(0.25);
      expect(result.tokens).toEqual({ input: 50, output: 8 });
      expect(result.model).toEqual({ providerID: 'spike-mock', modelID: 'spike-model' });
    } finally {
      await server.close();
    }
  });

  it('finish=tool-calls → 不判完成（tool-calls 不是 stop；v2 实测中间步骤就是它）', async () => {
    const server = await startFakeV2MessageServer([
      v2Assistant({
        content: [{ type: 'tool', id: 'call_1', name: 'spike_probe', executed: false }],
        finish: 'tool-calls',
      }),
    ]);
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl });
      const messages = await driver.getMessages('ses_1');
      expect(findFinish(messages)).toBeUndefined();
      await expect(
        awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 40, pollMs: 5 }),
      ).rejects.toBeInstanceOf(CompletionTimeoutError);
    } finally {
      await server.close();
    }
  });

  it('事件路 session.execution.succeeded → 判完成（v2 的 run 级结果只在事件路有）', async () => {
    const { driver, getMessages } = mockDriver();
    // 轮询路**永远**看不到 step-finish（v2 的 idle 消息被驱动丢弃，轮询路看不到 outcome）
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('MOCK_OK', 100)])]);
    const signal = new FakeEventSignal();
    signal.setTerminal({ verdict: 'succeeded' });

    const result = await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      eventSignal: signal,
    });
    expect(result.text).toBe('MOCK_OK');
    expect(result.terminalEvidence).toBe('event');
  });
});

describe('T14 首字判定（v2：轮询路四例 + 事件路四例）', () => {
  const cases: { name: string; parts: ServePart[]; expected: boolean }[] = [
    { name: '非空 text part', parts: [textPart('你好', 100)], expected: true },
    { name: '仅 reasoning part（思考也算已响应）', parts: [{ id: 'p1', type: 'reasoning', text: '' }], expected: true },
    { name: '空 text part（空文本不算首字）', parts: [textPart('   ', 100)], expected: false },
    { name: '无任何输出', parts: [{ id: 'p1', type: 'step-start' }], expected: false },
  ];

  it.each(cases)('轮询路：$name', async ({ parts, expected }) => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', parts)]);
    // 用**总时长上限**收尾（首字出现后没有完成超时，否则本例会永远轮询下去）：
    // 判据 = 触发的是「执行总时长超限」（首字已出现）还是「等待首字超时」（首字没出现）。
    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 30,
      totalTimeoutMs: 120,
      pollMs: 5,
    }).catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err).toBeInstanceOf(CompletionTimeoutError);
    if (expected) {
      expect(err.message).toContain('执行总时长超限');
      expect(err.message).not.toContain('等待首字超时');
    } else {
      expect(err.message).toContain('等待首字超时');
    }
  });

  it('事件路四例：非空 text.delta / 任意 reasoning 事件 / 空 text.delta / 无事件', () => {
    // v1 的「非空 text」对应事件路的**非空** text.delta
    expect(isFirstTokenEvent({ type: 'session.text.delta', data: { delta: '你好' } })).toBe(true);
    // v1 的「仅 reasoning」对应事件路的 reasoning.started / reasoning.delta（任意都算）
    expect(isFirstTokenEvent({ type: 'session.reasoning.started', data: {} })).toBe(true);
    expect(isFirstTokenEvent({ type: 'session.reasoning.delta', data: { delta: '想…' } })).toBe(true);
    // v1 的「空 text」对应事件路的空 text.delta / text.started（空文本不算首字）
    expect(isFirstTokenEvent({ type: 'session.text.delta', data: { delta: '' } })).toBe(false);
    expect(isFirstTokenEvent({ type: 'session.text.started', data: {} })).toBe(false);
    // v1 的「无任何输出」= 没有任何相关事件
    expect(isFirstTokenEvent({ type: 'session.execution.started', data: {} })).toBe(false);
    expect(isFirstTokenEvent({})).toBe(false);
  });

  it('事件路首字 → 不触发首字超时（纯思考/纯事件流不被误杀）', async () => {
    const { driver, getMessages } = mockDriver();
    // 轮询路**看不到**任何输出（v2 的 reasoning 尚未落进消息快照）
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const signal = new FakeEventSignal();
    signal.firstTokenSeen = true;

    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 30,
      totalTimeoutMs: 120,
      pollMs: 5,
      eventSignal: signal,
    }).catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err).toBeInstanceOf(CompletionTimeoutError);
    // 首字已出现（事件路给的）⇒ 触发的不是「等待首字超时」
    expect(err.message).not.toContain('等待首字超时');
    expect(err.message).toContain('执行总时长超限');
  });
});

describe('T14 在飞工具态（v2 无 pending）', () => {
  const inFlight: { status: string; expected: boolean }[] = [
    { status: 'running', expected: true },
    { status: 'streaming', expected: true },
    { status: 'completed', expected: false },
    { status: 'error', expected: false },
    // v1 形态仍在集合里（回退路径不退化）；v2 上游**不会**产出它
    { status: 'pending', expected: true },
  ];

  it.each(inFlight)('state.status=$status → 首字超时豁免=$expected', async ({ status, expected }) => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([
      asstMsg('a1', [
        { id: 'tp1', type: 'tool', tool: 'vteam_secret_command', state: { status, time: { start: 1 } } },
      ]),
    ]);
    // 判据同上：在飞 ⇒ 触发的是总时长上限（首字超时没触发）；不在飞 ⇒ 触发首字超时
    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 30,
      totalTimeoutMs: 120,
      pollMs: 5,
    }).catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err).toBeInstanceOf(CompletionTimeoutError);
    if (expected) {
      expect(err.message).toContain('执行总时长超限');
      expect(err.message).not.toContain('等待首字超时');
    } else {
      expect(err.message).toContain('等待首字超时');
    }
  });

  it('v2 形状的工具 part（只有 running → completed）→ 在飞窗口内豁免生效', async () => {
    const server = await startFakeV2MessageServer([
      v2Assistant({
        content: [
          {
            type: 'tool',
            id: 'call_1',
            name: 'spike_probe',
            executed: false,
            state: { status: 'running', input: { ms: 6000 } },
            time: { created: 1000, ran: 1001 },
          },
        ],
      }),
    ]);
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl });
      const err = (await awaitCompletion(driver, 'ses_1', {
        firstTokenTimeoutMs: 30,
        totalTimeoutMs: 120,
        pollMs: 5,
      }).catch((e: unknown) => e)) as CompletionTimeoutError;
      expect(err).toBeInstanceOf(CompletionTimeoutError);
      // 工具在飞 ⇒ 豁免 ⇒ 不 abort（错误来自「首字后无完成超时」而非首字超时）
      expect(err.message).not.toContain('等待首字超时');
    } finally {
      await server.close();
    }
  });

  it('大小写不敏感（OpenAPI 的类型名形态 Running/Streaming 也算在飞）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([
      asstMsg('a1', [
        { id: 'tp1', type: 'tool', tool: 'x', state: { status: 'Running', time: { start: 1 } } },
      ]),
    ]);
    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 30,
      totalTimeoutMs: 120,
      pollMs: 5,
    }).catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err).toBeInstanceOf(CompletionTimeoutError);
    expect(err.message).not.toContain('等待首字超时');
  });
});

describe('T14 文本聚合（v2）', () => {
  it('同一条消息的多段文本按 content 顺序拼接（v2 的 content[] 本身有序）', async () => {
    const server = await startFakeV2MessageServer([
      v2Assistant({
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
        finish: 'stop',
        completed: 2000,
      }),
    ]);
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl });
      const messages = await driver.getMessages('ses_1');
      expect(aggregateText(messages)).toBe('第一段第二段');
    } finally {
      await server.close();
    }
  });

  it('工具调用的输出不进回复正文（v2：工具是独立的 content 项，输出在 state.output 里）', async () => {
    const server = await startFakeV2MessageServer([
      v2Assistant({
        id: 'msg_a1',
        content: [
          {
            type: 'tool',
            id: 'call_1',
            name: 'spike_probe',
            executed: false,
            state: {
              status: 'completed',
              input: { note: 'hi' },
              content: [{ type: 'text', text: 'SPIKE_PROBE_OK' }],
            },
            time: { created: 1000, ran: 1001, completed: 1002 },
          },
        ],
        finish: 'tool-calls',
      }),
      v2Assistant({
        id: 'msg_a2',
        content: [{ type: 'text', text: 'MOCK_OK' }],
        finish: 'stop',
        created: 2000,
        completed: 3000,
      }),
    ]);
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl });
      const messages = await driver.getMessages('ses_1');
      // 工具输出（SPIKE_PROBE_OK）不污染正文
      expect(aggregateText(messages)).toBe('MOCK_OK');
      // 调工具那条消息不是完成（tool-calls），最后一条才是（stop）
      expect(findFinish(messages)?.reason).toBe('stop');
    } finally {
      await server.close();
    }
  });

  it('synthetic 过滤在 v2 下是空操作（驱动从不设置该标记）→ 聚合结果不变', async () => {
    const server = await startFakeV2MessageServer([
      v2Assistant({ content: [{ type: 'text', text: '模型正文' }], finish: 'stop' }),
    ]);
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl });
      const messages = await driver.getMessages('ses_1');
      const texts = messages.flatMap((m) => m.parts ?? []).filter((p) => p.type === 'text');
      expect(texts).toHaveLength(1);
      expect(texts[0]?.synthetic).toBeUndefined();
      expect(aggregateText(messages)).toBe('模型正文');
    } finally {
      await server.close();
    }
  });

  it('vteam 注入的 synthetic 文本仍被排除（该过滤的真实用途）', () => {
    const msgs = [
      asstMsg('a1', [textPart('注入上下文', 100, { synthetic: true }), textPart('模型正文', 200)]),
    ];
    expect(aggregateText(msgs)).toBe('模型正文');
  });
});

describe('T14 错误抽取（v2 结构化错误 + 事件载荷 + 日志兜底）', () => {
  it('v2 结构化错误 {type,message,status} → 透传 message 并附 HTTP 码', () => {
    const msgs = [
      asstErrMsg('a1', {
        type: 'provider.auth',
        message: 'Invalid API key.',
        status: 401,
        response: { body: '{"error":{"message":"Invalid API key."}}' },
      }),
    ];
    expect(describeTimeoutReason(msgs)).toBe('模型调用报错：Invalid API key. (HTTP 401)');
  });

  it('v2 的失败消息**没有 content**（= parts=[]），错误只在 info.error → 提前失败并带详情', async () => {
    const server = await startFakeV2MessageServer([
      v2Assistant({
        finish: 'error',
        error: {
          type: 'provider.auth',
          message: 'Invalid API key.',
          status: 401,
          response: { body: '{"error":{"message":"Invalid API key."}}' },
        },
      }),
    ]);
    try {
      const driver = new V2Driver({ baseUrl: server.baseUrl });
      const messages = await driver.getMessages('ses_1');
      // 失败消息的内容为空（v1 的 parts=[] 等价形态）——错误只在 info.error
      expect(messages[0]?.parts.filter((p) => p.type === 'text')).toHaveLength(0);
      const err = (await awaitCompletion(driver, 'ses_1', {
        firstTokenTimeoutMs: 1000,
        pollMs: 5,
      }).catch((e: unknown) => e)) as CompletionTimeoutError;
      expect(err).toBeInstanceOf(CompletionTimeoutError);
      expect(err.message).toContain('Invalid API key.');
      expect(err.message).toContain('HTTP 401');
    } finally {
      await server.close();
    }
  });

  it('事件路的 session.execution.failed 载荷 → 错误详情优先于轮询路的抽取', async () => {
    const { driver, getMessages } = mockDriver();
    // 轮询路只看到「没有内容的失败消息」，抽不出细节
    getMessages.mockResolvedValue([asstErrMsg('a1', { type: 'provider.auth', message: '' })]);
    const signal = new FakeEventSignal();
    signal.setTerminal({ verdict: 'failed', error: 'Invalid API key.' });

    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      eventSignal: signal,
    }).catch((e: unknown) => e)) as RunTerminalError;
    expect(err).toBeInstanceOf(RunTerminalError);
    expect(err.verdict).toBe('failed');
    expect(err.message).toContain('Invalid API key.');
  });

  it('事件路与日志都还没到 → serve 日志兜底仍是最后一道（v1 行为不变）', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [{ id: 'p1', type: 'step-start' }])]);
    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      serveErrorReader: () => [
        'message="stream error" error.error="AI_APICallError: Rate limit exceeded. Please try again later."',
      ],
      onServeError: (text) => /Rate limit/.test(text),
    }).catch((e: unknown) => e)) as CompletionTimeoutError;
    expect(err).toBeInstanceOf(CompletionTimeoutError);
    expect(err.message).toContain('Rate limit exceeded. Please try again later.');
  });
});

describe('T14 终态收口（与 RunTerminalGate 合流：一轮只收口一次）', () => {
  it('轮询路与事件路都看到完成 → settle() 第二次返回 null（控制面只收一个 task.completed）', async () => {
    const gate = new RunTerminalGate();
    gate.noteEvent({ verdict: 'succeeded' });
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);

    const result = await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      eventSignal: gate,
      eventGraceMs: 50,
    });
    expect(result.text).toBe('ok');
    // 事件证据与轮询证据一致 → 证据来源标成 event
    expect(result.terminalEvidence).toBe('event');
    // 一次性收口：第一次拿到判定，第二次为空 ⇒ 终态事件只允许发一次
    expect(gate.settle()).toEqual({ verdict: 'succeeded' });
    expect(gate.settle()).toBeNull();
  });

  it('轮询路**不消耗**闸门的一次性收口（settle 由调用方做）', async () => {
    const gate = new RunTerminalGate();
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);

    await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      eventSignal: gate,
      eventGraceMs: 0,
    });
    // 轮询路把**自己的**证据记进了闸门，但没有把闸门收口掉
    expect(gate.settle()).toEqual({ verdict: 'succeeded' });
  });

  it('事件路已判失败 → 轮询路不宣告成功（事件证据优先），且不再轮询', async () => {
    const gate = new RunTerminalGate();
    gate.noteEvent({ verdict: 'failed', error: 'Invalid API key.' });
    const { driver, getMessages, abort } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);

    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      eventSignal: gate,
    }).catch((e: unknown) => e)) as RunTerminalError;
    expect(err).toBeInstanceOf(RunTerminalError);
    expect(err.verdict).toBe('failed');
    expect(err.message).toContain('Invalid API key.');
    // 事件证据优先 ⇒ 轮询路连消息都不拉（不可能宣告成功）
    expect(getMessages).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith('ses_1');
  });

  it('轮询路先看到完成、事件路在宽限期内判失败 → 与「事件先到」同一个结论（事件证据优先）', async () => {
    const gate = new RunTerminalGate();
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);
    const timer = setTimeout(() => gate.noteEvent({ verdict: 'failed', error: 'Invalid API key.' }), 20);

    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      eventSignal: gate,
      eventGraceMs: 500,
    }).catch((e: unknown) => e)) as RunTerminalError;
    clearTimeout(timer);
    expect(err).toBeInstanceOf(RunTerminalError);
    expect(err.message).toContain('Invalid API key.');
  });

  it('陈旧的 durable seq 不能覆盖更新的终态证据（轮询路跟着新证据走）', async () => {
    const gate = new RunTerminalGate();
    // 新证据（seq 12）先到
    gate.noteEvent({ verdict: 'failed', error: '新证据' }, { eventId: 'evt_2', aggregateId: 'ses_1', seq: 12 });
    // 陈旧证据（seq 9）后到 → 闸门拒绝采纳
    expect(
      gate.noteEvent({ verdict: 'succeeded' }, { eventId: 'evt_1', aggregateId: 'ses_1', seq: 9 }),
    ).toBe(false);

    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);
    const err = (await awaitCompletion(driver, 'ses_1', {
      firstTokenTimeoutMs: 1000,
      pollMs: 5,
      eventSignal: gate,
    }).catch((e: unknown) => e)) as RunTerminalError;
    expect(err).toBeInstanceOf(RunTerminalError);
    expect(err.message).toContain('新证据');
  });

  it('证据来源写进结果（分歧可诊断）：轮询路独自判完成 → evidence=polling', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);
    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
    expect(result.terminalEvidence).toBe('polling');
  });

  it('没有事件路（v1 回退路径）→ 行为零变化：不等待宽限期、证据=polling', async () => {
    const { driver, getMessages } = mockDriver();
    getMessages.mockResolvedValue([asstMsg('a1', [textPart('ok', 100), stepFinishPart()])]);
    const started = Date.now();
    const result = await awaitCompletion(driver, 'ses_1', { firstTokenTimeoutMs: 1000, pollMs: 5 });
    expect(result.terminalEvidence).toBe('polling');
    // 没有事件路就没有宽限期（不加延迟）
    expect(Date.now() - started).toBeLessThan(200);
  });
});
