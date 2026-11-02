/**
 * DSH 事件映射单测（P2）。
 *
 * 断言基于 **P0 实测的真实事件形状**（见 md-docs/dsh-worker-p0-poc-report.md）：
 * - `assistant/message` 带 `usage: {inputTokens, outputTokens, totalTokens, cacheReadTokens}`
 * - `turn/end` 的 `reason` 为 `{kind:'completed'}` / `{kind:'aborted',reason:{kind:'user'}}`
 * - `tool/call{callId,name,arguments}` / `tool/result{message:{content,isError,toolCallId}}`
 *
 * 这些断言的价值：映射层是 DshDriver 唯一"有判断逻辑"的部分，错一个字段就导致
 * 控制面判不出完成、或用量记 0（既有 v2 实现踩过 step-finish 幂等键的坑）。
 */

import {
  classifyTurnEnd,
  mapUsage,
  readAssistantMessage,
  readToolCall,
  readToolResult,
  stepFinishReason,
  synthesizeStepFinish,
  toDriverMessage,
  type DshAssistantMessageData,
} from './dsh-event-map';

describe('classifyTurnEnd（本轮终态归一）', () => {
  it('kind=completed → completed', () => {
    expect(classifyTurnEnd({ kind: 'completed' })).toBe('completed');
  });

  it('kind=aborted（用户取消）→ aborted', () => {
    expect(classifyTurnEnd({ kind: 'aborted', reason: { kind: 'user' } })).toBe('aborted');
  });

  it('kind=error → error', () => {
    expect(classifyTurnEnd({ kind: 'error', error: { message: 'boom' } })).toBe('error');
  });

  it('未知 kind → error（宁可报失败，不可把未完成当成功）', () => {
    expect(classifyTurnEnd({ kind: 'future-kind' })).toBe('error');
    expect(classifyTurnEnd(undefined)).toBe('error');
  });
});

describe('stepFinishReason（控制面认 stop 为正常完成）', () => {
  it('completed → stop', () => {
    expect(stepFinishReason('completed')).toBe('stop');
  });

  it('aborted → aborted', () => {
    expect(stepFinishReason('aborted')).toBe('aborted');
  });

  it('error → error', () => {
    expect(stepFinishReason('error')).toBe('error');
  });
});

describe('mapUsage（DSH camelCase → vteam DriverTokenUsage）', () => {
  it('P0 实测完整形状：四个字段全映射', () => {
    expect(
      mapUsage({ inputTokens: 96, outputTokens: 7, totalTokens: 108, cacheReadTokens: 5 }),
    ).toEqual({
      input: 96,
      output: 7,
      total: 108,
      cache: { read: 5 },
    });
  });

  it('thinking/cache-write 也映射（DSH 有则带）', () => {
    expect(
      mapUsage({ inputTokens: 10, outputTokens: 2, thoughtTokens: 3, cacheWriteTokens: 4 }),
    ).toEqual({
      input: 10,
      output: 2,
      reasoning: 3,
      cache: { write: 4 },
    });
  });

  it('非法/缺失 → undefined（不返回空对象让上层误以为有用量）', () => {
    expect(mapUsage(undefined)).toBeUndefined();
    expect(mapUsage(null)).toBeUndefined();
    expect(mapUsage({})).toBeUndefined();
    expect(mapUsage({ inputTokens: 'not-a-number' })).toBeUndefined();
  });

  it('非有限数（NaN/Infinity）被丢弃', () => {
    expect(mapUsage({ inputTokens: Number.NaN })).toBeUndefined();
    expect(mapUsage({ inputTokens: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
});

describe('readAssistantMessage（assistant/message 投影）', () => {
  const p0Message = {
    message: {
      id: 'msg-1',
      content: [{ type: 'text', text: 'PONG' }],
      source: { provider: 'mock', model: 'mock-model' },
    },
    usage: { inputTokens: 96, outputTokens: 7, totalTokens: 108, cacheReadTokens: 5 },
  };

  it('P0 实测形状：取 id/text/provider/model/usage', () => {
    const result = readAssistantMessage(p0Message);
    expect(result).not.toBeNull();
    expect(result?.messageID).toBe('msg-1');
    expect(result?.text).toBe('PONG');
    expect(result?.providerID).toBe('mock');
    expect(result?.modelID).toBe('mock-model');
    expect(result?.usage).toEqual({ input: 96, output: 7, total: 108, cache: { read: 5 } });
  });

  it('reasoning block 也提取（DSH 可能用 reasoning/thinking/thought 之一）', () => {
    for (const type of ['reasoning', 'thinking', 'thought']) {
      const result = readAssistantMessage({
        message: { id: 'm', content: [{ type, text: '思考中' }] },
      });
      expect(result?.reasoning).toBe('思考中');
    }
  });

  it('多个 text block 拼接', () => {
    const result = readAssistantMessage({
      message: { id: 'm', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] },
    });
    expect(result?.text).toBe('AB');
  });

  it('缺 message/id → null（不构造半个对象）', () => {
    expect(readAssistantMessage(undefined)).toBeNull();
    expect(readAssistantMessage({})).toBeNull();
    expect(readAssistantMessage({ message: {} })).toBeNull();
    expect(readAssistantMessage({ message: { id: '' } })).toBeNull();
  });
});

describe('readToolCall / readToolResult（工具事件）', () => {
  it('tool/call：构造 running 状态 part', () => {
    const part = readToolCall({ callId: 'c1', name: 'mcp__vteam__like', arguments: '{"text":"hi"}' }, 'msg-1');
    expect(part).not.toBeNull();
    expect(part?.callId).toBe('c1');
    expect(part?.part.type).toBe('tool');
    expect(part?.part.tool).toBe('mcp__vteam__like');
    expect(part?.part.messageID).toBe('msg-1');
    expect((part?.part.state as Record<string, unknown>)?.status).toBe('running');
  });

  it('tool/result：成功 → completed + 输出文本', () => {
    const part = readToolResult(
      {
        message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] },
      },
      'msg-1',
    );
    expect(part?.callId).toBe('c1');
    expect((part?.part.state as Record<string, unknown>)?.status).toBe('completed');
    expect((part?.part.state as Record<string, unknown>)?.output).toBe('ok');
  });

  it('tool/result：isError → error 状态（P0 实测错误透传）', () => {
    const part = readToolResult(
      {
        message: {
          toolCallId: 'c1',
          isError: true,
          content: [{ type: 'text', text: 'Error: unknown tool' }],
        },
      },
      'msg-1',
    );
    expect((part?.part.state as Record<string, unknown>)?.status).toBe('error');
  });

  it('缺关键字段 → null', () => {
    expect(readToolCall(undefined, 'm')).toBeNull();
    expect(readToolCall({ name: 'x' }, 'm')).toBeNull();
    expect(readToolResult(undefined, 'm')).toBeNull();
    expect(readToolResult({ message: {} }, 'm')).toBeNull();
  });
});

describe('synthesizeStepFinish（本轮完成锚点 —— 控制面靠它判完成 + 落库用量）', () => {
  it('id 固定为 ${messageID}:step-finish（跨轮询/事件两路稳定，否则控制面存双份）', () => {
    const part = synthesizeStepFinish('msg-1', 'completed', { input: 1, output: 2 });
    expect(part.id).toBe('msg-1:step-finish');
    expect(part.messageID).toBe('msg-1');
    expect(part.type).toBe('step-finish');
    expect(part.reason).toBe('stop');
    expect(part.tokens).toEqual({ input: 1, output: 2 });
  });

  it('无 usage 时不带 tokens（控制面回退指纹去重）', () => {
    const part = synthesizeStepFinish('m', 'completed');
    expect(part.tokens).toBeUndefined();
  });

  it('aborted 的 reason 不是 stop（控制面据此不发 task.completed）', () => {
    expect(synthesizeStepFinish('m', 'aborted').reason).toBe('aborted');
  });
});

describe('toDriverMessage（assistant 消息 → vteam DriverMessage）', () => {
  const assistant: DshAssistantMessageData = {
    messageID: 'msg-1',
    text: 'PONG',
    reasoning: '思考',
    providerID: 'mock',
    modelID: 'mock-model',
    usage: { input: 96, output: 7, total: 108 },
    raw: {},
  };

  it('未知终态 → 不合成 step-finish（否则控制面会提前认为本轮结束）', () => {
    const msg = toDriverMessage(assistant, undefined);
    expect(msg.parts.some((p) => p.type === 'step-finish')).toBe(false);
    expect(msg.info.id).toBe('msg-1');
    expect(msg.info.role).toBe('assistant');
  });

  it('已知终态 → 文字 + reasoning + step-finish 三段', () => {
    const msg = toDriverMessage(assistant, 'completed');
    expect(msg.parts.map((p) => p.type)).toEqual(['reasoning', 'text', 'step-finish']);
    expect(msg.parts[0]?.text).toBe('思考');
    expect(msg.parts[1]?.text).toBe('PONG');
    expect(msg.parts[2]?.reason).toBe('stop');
    expect(msg.parts[2]?.tokens).toEqual({ input: 96, output: 7, total: 108 });
  });

  it('无 reasoning 时不生成 reasoning part', () => {
    const msg = toDriverMessage({ ...assistant, reasoning: '' }, 'completed');
    expect(msg.parts.map((p) => p.type)).toEqual(['text', 'step-finish']);
  });

  it('provider/model 缺失时不塞空字段', () => {
    const msg = toDriverMessage({ ...assistant, providerID: undefined, modelID: undefined }, 'completed');
    expect(msg.info.providerID).toBeUndefined();
    expect(msg.info.modelID).toBeUndefined();
  });
});
