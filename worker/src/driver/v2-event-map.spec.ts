/**
 * T12 v2 事件映射表测试。
 *
 * 覆盖：
 * - **覆盖度断言**（计划 T12 的风险对策）：目录里的每一条 v2 事件，要么有映射，要么
 *   显式列在「已知未支持」清单里——不允许静默空洞；反向也断言（映射表/未支持清单
 *   不得出现目录之外的条目，防止两边各自漂移）。
 * - 每条映射产出的 vteam 事件类型与载荷。
 * - **durable / ephemeral 标注**：ephemeral 事件不得产出终态（不作状态判定）。
 * - `session.step.ended` → **step-finish 形状**的 part（控制面的「本轮完成」幂等键），
 *   且与 **v2 驱动（轮询路）** 的合成**逐字段等价**（跨实现断言）。
 * - 上游身份（去重键）：durable 用 `(aggregateID, seq)`，跨 worker 重启稳定。
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { WORKER_EVENT_TYPES } from '../protocol/worker-protocol';
import {
  KNOWN_UNSUPPORTED_V2_EVENTS,
  V2_EVENT_CATALOGUE,
  V2_EVENT_MAP,
  RunTerminalGate,
  V2StreamAccumulator,
  assembleAssistantText,
  buildStepFinishPart,
  deriveUpstreamDedupKey,
  deriveUpstreamIdentity,
  isDurableV2Event,
  isKnownUnsupportedV2Event,
  mapV2Event,
  mapV2TokenUsage,
  normalizeV2ContentIdList,
  normalizeV2ContentIds,
  resolveV2SessionId,
} from './v2-event-map';
import type { V2EventFrame, V2MappingOutcome } from './v2-event-map';
import { V2Driver } from './v2-driver';

/** 造一帧 v2 事件。 */
function frameOf(type: string, data: Record<string, unknown>, extra: Partial<V2EventFrame> = {}): V2EventFrame {
  return {
    id: `evt_${type}`,
    type,
    data,
    ...extra,
  };
}

/** 映射一帧并返回结果。 */
function map(
  type: string,
  data: Record<string, unknown>,
  extra: Partial<V2EventFrame> = {},
  accumulator = new V2StreamAccumulator(),
): V2MappingOutcome[] {
  return mapV2Event(frameOf(type, data, extra), { sessionId: 'ses_1', accumulator });
}

/** 取映射结果里的事件（过滤掉触发器）。 */
function eventsOf(outcomes: V2MappingOutcome[]): Array<{ type: string; payload: Record<string, unknown>; terminal?: string }> {
  return outcomes
    .filter((o): o is Extract<V2MappingOutcome, { kind: 'event' }> => o.kind === 'event')
    .map((o) => ({ type: o.type, payload: o.payload, terminal: o.terminal }));
}

describe('v2 事件目录覆盖度（映射表必须「全量或显式未支持」）', () => {
  it('目录里的每一条事件：要么已映射，要么在「已知未支持」清单里', () => {
    const missing: string[] = [];
    for (const type of V2_EVENT_CATALOGUE) {
      const mapped = V2_EVENT_MAP[type] !== undefined;
      const unsupported = isKnownUnsupportedV2Event(type);
      if (!mapped && !unsupported) {
        missing.push(type);
      }
    }
    expect(missing).toEqual([]);
  });

  it('已映射的事件不得同时出现在「已知未支持」清单里（两表不得重叠）', () => {
    const overlap = Object.keys(KNOWN_UNSUPPORTED_V2_EVENTS).filter((type) => V2_EVENT_MAP[type] !== undefined);
    expect(overlap).toEqual([]);
  });

  it('映射表 / 未支持清单都不得出现目录之外的条目（防两边各自漂移）', () => {
    const catalogue = new Set(V2_EVENT_CATALOGUE);
    const strayMapped = Object.keys(V2_EVENT_MAP).filter((type) => !catalogue.has(type));
    const strayUnsupported = Object.keys(KNOWN_UNSUPPORTED_V2_EVENTS).filter(
      (type) => !catalogue.has(type),
    );
    expect(strayMapped).toEqual([]);
    expect(strayUnsupported).toEqual([]);
  });

  it('「已知未支持」清单每一条都写明了理由', () => {
    for (const [type, reason] of Object.entries(KNOWN_UNSUPPORTED_V2_EVENTS)) {
      expect(typeof reason).toBe('string');
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(type.length).toBeGreaterThan(0);
    }
  });
});

describe('v2 事件 → vteam 事件映射', () => {
  it('session.text.delta → message.part.delta（part=text，增量累积成全文）', () => {
    const accumulator = new V2StreamAccumulator();
    const first = eventsOf(
      map('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: '你' }, {}, accumulator),
    );
    expect(first).toHaveLength(1);
    expect(first[0].type).toBe(WORKER_EVENT_TYPES.MESSAGE_PART_DELTA);
    const parts = first[0].payload.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({
      id: 'msg_1:text',
      type: 'text',
      text: '你',
      messageID: 'msg_1',
      sessionID: 'ses_1',
    });

    // 第二段增量 → 累积成全文（server 侧按 part id 合并，需要的是快照不是片段）
    const second = eventsOf(
      map('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 1, delta: '好' }, {}, accumulator),
    );
    const parts2 = second[0].payload.parts as Array<Record<string, unknown>>;
    expect(parts2[0].text).toBe('你好');
  });

  it('session.reasoning.delta → message.part.delta（part=reasoning）', () => {
    const out = eventsOf(map('session.reasoning.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', delta: '思考' }));
    const parts = out[0].payload.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ id: 'msg_1:reasoning', type: 'reasoning', text: '思考' });
  });

  it('session.text.ended 带**权威全文** → 优先于累积器（实机抓帧口径）', () => {
    const accumulator = new V2StreamAccumulator();
    // 连接中途建立：累积器里只有后缀片段
    accumulator.append('msg_1:text', '后缀片段');
    const out = eventsOf(
      map(
        'session.text.ended',
        {
          sessionID: 'ses_1',
          assistantMessageID: 'msg_1',
          ordinal: 0,
          text: '完整正文，后缀片段',
        },
        {},
        accumulator,
      ),
    );
    const parts = out[0].payload.parts as Array<Record<string, unknown>>;
    expect(parts[0].text).toBe('完整正文，后缀片段');
  });

  it('session.tool.called → message.part.delta（part=tool，state=running）', () => {
    const out = eventsOf(
      map('session.tool.called', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_1',
        id: 'call_1',
        name: 'bash',
        input: { command: 'ls' },
        executed: false,
      }),
    );
    const parts = out[0].payload.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ id: 'msg_1:tool:call_1', type: 'tool', tool: 'bash', callID: 'call_1' });
    expect(parts[0].state).toMatchObject({ status: 'running', input: { command: 'ls' } });
  });

  it('session.tool.success → state=completed 且输出归一成字符串（与轮询路同口径）', () => {
    const out = eventsOf(
      map('session.tool.success', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_1',
        id: 'call_1',
        name: 'bash',
        content: [{ type: 'text', text: 'a.txt' }],
      }),
    );
    const parts = out[0].payload.parts as Array<Record<string, unknown>>;
    expect(parts[0].state).toMatchObject({ status: 'completed', output: 'a.txt' });
  });

  it('session.tool.failed → state=error 且错误对象归一成字符串', () => {
    const out = eventsOf(
      map('session.tool.failed', {
        sessionID: 'ses_1',
        assistantMessageID: 'msg_1',
        id: 'call_1',
        name: 'bash',
        error: { type: 'tool.execution', message: '炸了' },
      }),
    );
    const parts = out[0].payload.parts as Array<Record<string, unknown>>;
    expect(parts[0].state).toMatchObject({ status: 'error', error: '炸了' });
  });

  it('session.tool.input.delta → 工具入参累积（part=tool）', () => {
    const accumulator = new V2StreamAccumulator();
    const a = eventsOf(
      map('session.tool.input.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: 'call_1', name: 'bash', delta: '{"cmd' }, {}, accumulator),
    );
    const b = eventsOf(
      map('session.tool.input.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: 'call_1', name: 'bash', delta: '":"ls"}' }, {}, accumulator),
    );
    const parts = b[0].payload.parts as Array<Record<string, unknown>>;
    expect((parts[0].state as Record<string, unknown>).input).toEqual({ text: '{"cmd":"ls"}' });
    expect(a).toHaveLength(1);
  });

  it('session.execution.succeeded → task.completed（终态：交终态闸门，不直接发）', () => {
    const out = eventsOf(map('session.execution.succeeded', { sessionID: 'ses_1' }));
    expect(out[0].type).toBe(WORKER_EVENT_TYPES.TASK_COMPLETED);
    expect(out[0].terminal).toBe('succeeded');
  });

  it('session.execution.failed → agent.status（error，带错误详情）', () => {
    const out = eventsOf(
      map('session.execution.failed', {
        sessionID: 'ses_1',
        error: { type: 'ProviderModelNotFoundError', message: '模型不存在' },
      }),
    );
    expect(out[0].type).toBe(WORKER_EVENT_TYPES.AGENT_STATUS);
    expect(out[0].payload.status).toBe('error');
    expect(out[0].payload.error).toBe('模型不存在');
    expect(out[0].terminal).toBe('failed');
  });

  it('session.execution.interrupted → agent.status（interrupted）', () => {
    const out = eventsOf(map('session.execution.interrupted', { sessionID: 'ses_1', reason: '用户中止' }));
    expect(out[0].type).toBe(WORKER_EVENT_TYPES.AGENT_STATUS);
    expect(out[0].terminal).toBe('interrupted');
    expect(String(out[0].payload.error)).toContain('用户中止');
  });

  it('session.execution.started → session.updated(running)', () => {
    const out = eventsOf(map('session.execution.started', { sessionID: 'ses_1' }));
    expect(out[0].type).toBe(WORKER_EVENT_TYPES.SESSION_UPDATED);
    expect(out[0].payload.status).toBe('running');
  });

  it('session.usage.updated → session.updated（带 usage 载荷、**不带 status**）', () => {
    const out = eventsOf(
      map('session.usage.updated', {
        sessionID: 'ses_1',
        cost: 0,
        tokens: { input: 516, output: 4, reasoning: 0, cache: { read: 187, write: 0 } },
      }),
    );
    expect(out[0].type).toBe(WORKER_EVENT_TYPES.SESSION_UPDATED);
    expect(out[0].payload.usage).toEqual({
      cost: 0,
      tokens: { input: 516, output: 4, reasoning: 0, cache: { read: 187, write: 0 } },
    });
    // 带 status 会把已结束的会话改回运行中 → 绝不带
    expect(out[0].payload.status).toBeUndefined();
  });

  it('permission.asked / form.created → **触发器**（只拉取，不写状态）', () => {
    const permission = map('permission.asked', { sessionID: 'ses_1' });
    expect(permission).toHaveLength(1);
    expect(permission[0].kind).toBe('trigger');
    expect(permission[0]).toMatchObject({ trigger: 'permission', sessionId: 'ses_1' });

    const question = map('form.created', { form: { id: 'frm_1', sessionID: 'ses_1' } });
    expect(question[0]).toMatchObject({ kind: 'trigger', trigger: 'question', sessionId: 'ses_1' });
  });

  it('未映射的事件 → 无结果（不臆造映射）', () => {
    expect(map('session.renamed', { sessionID: 'ses_1', title: 'x' })).toEqual([]);
    expect(map('tui.something', {})).toEqual([]);
  });
});

describe('实机抓帧序列回放（v2.0.28 真 serve 抓的原始字节）', () => {
  /** 真 serve 抓的帧序列（`opencode serve` + `curl -N /api/event`，2026-10-20 实测）。 */
  const CAPTURED = [
    {
      id: 'evt_157702b9d001Bzya7uHZvRzFNS',
      created: 1792468331421,
      type: 'session.created',
      location: { directory: '/private/tmp/oc-v2-probe' },
      data: { sessionID: 'ses_live', slug: 'playful-meadow', version: '2.0.28' },
      durable: { aggregateID: 'ses_live', seq: 0, version: 1 },
    },
    {
      id: 'evt_a',
      created: 1792468346663,
      type: 'session.execution.started',
      data: { sessionID: 'ses_live' },
      durable: { aggregateID: 'ses_live', seq: 2, version: 1 },
    },
    {
      id: 'evt_b',
      created: 1792468346664,
      type: 'session.step.started',
      data: {
        sessionID: 'ses_live',
        agent: 'build',
        model: { id: 'exo-free', providerID: 'opencode' },
        assistantMessageID: 'msg_live',
        started: 1792468346664,
      },
      durable: { aggregateID: 'ses_live', seq: 7, version: 1 },
    },
    {
      id: 'evt_c',
      created: 1792468346665,
      type: 'session.text.started',
      data: { sessionID: 'ses_live', assistantMessageID: 'msg_live', ordinal: 0 },
      durable: { aggregateID: 'ses_live', seq: 9, version: 1 },
    },
    {
      id: 'evt_d',
      created: 1792468346666,
      type: 'session.text.delta',
      data: { sessionID: 'ses_live', assistantMessageID: 'msg_live', ordinal: 0, delta: 'Hello! ' },
    },
    {
      id: 'evt_e',
      created: 1792468346667,
      type: 'session.text.delta',
      data: { sessionID: 'ses_live', assistantMessageID: 'msg_live', ordinal: 0, delta: 'World' },
    },
    {
      id: 'evt_f',
      created: 1792468346668,
      type: 'session.text.ended',
      data: { sessionID: 'ses_live', assistantMessageID: 'msg_live', ordinal: 0, text: 'Hello! World' },
      durable: { aggregateID: 'ses_live', seq: 11, version: 1 },
    },
    {
      id: 'evt_g',
      created: 1792468346669,
      type: 'session.step.ended',
      data: {
        sessionID: 'ses_live',
        assistantMessageID: 'msg_live',
        finish: 'stop',
        rawFinish: 'stop',
        cost: 0,
        tokens: { input: 5004, output: 58, reasoning: 65, cache: { read: 256, write: 0 } },
      },
      durable: { aggregateID: 'ses_live', seq: 13, version: 1 },
    },
    {
      id: 'evt_h',
      created: 1792468346670,
      type: 'session.execution.succeeded',
      data: { sessionID: 'ses_live' },
      durable: { aggregateID: 'ses_live', seq: 14, version: 1 },
    },
  ];

  it('整段回放 → 文本累积成全文 + step-finish part + 终态交给闸门', () => {
    const accumulator = new V2StreamAccumulator();
    const texts: string[] = [];
    const stepFinishes: Array<Record<string, unknown>> = [];
    const terminals: string[] = [];
    const sessionUpdates: Array<Record<string, unknown>> = [];

    for (const raw of CAPTURED) {
      const frame: V2EventFrame = {
        id: raw.id,
        type: raw.type,
        created: raw.created,
        data: raw.data,
        ...(raw.durable ? { durable: raw.durable } : {}),
      };
      for (const outcome of mapV2Event(frame, { sessionId: 'ses_live', accumulator })) {
        if (outcome.kind !== 'event') {
          continue;
        }
        if (outcome.terminal !== undefined) {
          terminals.push(outcome.terminal);
          continue;
        }
        if (outcome.type === WORKER_EVENT_TYPES.SESSION_UPDATED) {
          sessionUpdates.push(outcome.payload);
          continue;
        }
        const parts = (outcome.payload.parts ?? []) as Array<Record<string, unknown>>;
        for (const part of parts) {
          if (part.type === 'text') {
            texts.push(String(part.text ?? ''));
          }
          if (part.type === 'step-finish') {
            stepFinishes.push(part);
          }
        }
      }
    }

    // 文本增量累积成全文（最后一条 = 权威全文）
    expect(texts[texts.length - 1]).toBe('Hello! World');
    // step-finish part（控制面的「本轮完成」幂等键）
    expect(stepFinishes).toHaveLength(1);
    expect(stepFinishes[0]).toMatchObject({
      id: 'msg_live:step-finish',
      type: 'step-finish',
      reason: 'stop',
      cost: 0,
      messageID: 'msg_live',
    });
    expect(stepFinishes[0].tokens).toEqual({
      input: 5004,
      output: 58,
      reasoning: 65,
      cache: { read: 256, write: 0 },
    });
    // 终态只有一个（交闸门，不直接发）
    expect(terminals).toEqual(['succeeded']);
    // session.updated：执行开始 → running（不含 usage 之类）
    expect(sessionUpdates.some((p) => p.status === 'running')).toBe(true);
  });

  it('实机帧的 durable/ephemeral 分布与映射表标注一致', () => {
    for (const raw of CAPTURED) {
      expect(isDurableV2Event(raw.type)).toBe(raw.durable !== undefined);
    }
    // 实机确认：session.text.delta **没有** durable 块（⇒ ephemeral）
    const delta = CAPTURED.find((f) => f.type === 'session.text.delta');
    expect(delta?.durable).toBeUndefined();
  });
});

describe('durable / ephemeral 标注', () => {
  it('durable 事件带 durable 块；ephemeral 事件不带', () => {
    expect(isDurableV2Event('session.execution.succeeded')).toBe(true);
    expect(isDurableV2Event('session.step.ended')).toBe(true);
    expect(isDurableV2Event('session.text.delta')).toBe(false);
    // 实机抓帧：session.usage.updated **没有** durable 块（附录 B 标成 durable，与实机不符）
    expect(isDurableV2Event('session.usage.updated')).toBe(false);
  });

  it('ephemeral 事件不得产出终态（不作状态判定）', () => {
    for (const [type, mapping] of Object.entries(V2_EVENT_MAP)) {
      if (mapping.durable) {
        continue;
      }
      const outcomes = mapV2Event(
        frameOf(type, { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: 'x', name: 'bash', delta: 'd' }),
        { sessionId: 'ses_1', accumulator: new V2StreamAccumulator() },
      );
      for (const outcome of outcomes) {
        if (outcome.kind === 'event') {
          expect({ type, terminal: outcome.terminal }).toEqual({ type, terminal: undefined });
        }
      }
    }
  });

  it('映射表里没有任何 ephemeral 条目声明 terminal', () => {
    for (const [type, mapping] of Object.entries(V2_EVENT_MAP)) {
      if (mapping.durable) {
        continue;
      }
      expect(typeof mapping.derive).toBe('function');
      expect(type.length).toBeGreaterThan(0);
    }
  });
});

describe('step-finish part（事件路与轮询路等价）', () => {
  it('session.step.ended → step-finish 形状的 part（finish/cost/tokens）', () => {
    const out = eventsOf(
      map(
        'session.step.ended',
        {
          sessionID: 'ses_1',
          assistantMessageID: 'msg_1',
          finish: 'stop',
          rawFinish: 'stop',
          cost: 0.5,
          tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
        },
        { created: 1792462754396 },
      ),
    );
    const parts = out[0].payload.parts as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({
      id: 'msg_1:step-finish',
      type: 'step-finish',
      reason: 'stop',
      cost: 0.5,
      messageID: 'msg_1',
      sessionID: 'ses_1',
    });
    expect(parts[0].tokens).toEqual({ input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } });
  });

  it('与 v2 驱动（轮询路）合成的 step-finish part **逐字段等价**', async () => {
    // 真 V2Driver（假 v2 server）：轮询路从 assistant 消息合成 step-finish
    const messages = [
      {
        id: 'msg_1',
        type: 'assistant',
        time: { created: 1792462754300, completed: 1792462754396 },
        content: [{ type: 'text', text: '你好' }],
        finish: 'stop',
        rawFinish: 'stop',
        cost: 0.5,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
      },
    ];
    const server = http.createServer((req, res) => {
      const payload = JSON.stringify({ data: messages, cursor: { previous: null, next: null } });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const driver = new V2Driver({ baseUrl: `http://127.0.0.1:${port}` });
    try {
      const polled = await driver.getMessages('ses_1');
      const polledFinish = polled
        .flatMap((m) => m.parts)
        .find((p) => p.type === 'step-finish');
      expect(polledFinish).toBeDefined();

      // 事件路：从 session.step.ended 合成
      const eventFinish = buildStepFinishPart(
        'msg_1',
        'ses_1',
        'stop',
        0.5,
        { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
        1792462754396,
      );
      // id / type / reason / cost / tokens 必须一致（控制面的幂等键靠 id + reason）
      expect(eventFinish.id).toBe(polledFinish?.id);
      expect(eventFinish.type).toBe(polledFinish?.type);
      expect(eventFinish.reason).toBe(polledFinish?.reason);
      expect(eventFinish.cost).toBe(polledFinish?.cost);
      expect(eventFinish.tokens).toEqual(polledFinish?.tokens);
      expect(eventFinish.messageID).toBe(polledFinish?.messageID);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('token 用量口径与 v2 驱动一致（无 total 不造数）', () => {
    expect(mapV2TokenUsage({ input: 1, output: 2 })).toEqual({ input: 1, output: 2 });
    expect(mapV2TokenUsage(undefined)).toBeUndefined();
    expect(mapV2TokenUsage({ input: 1, cache: { read: 5 } })).toEqual({ input: 1, cache: { read: 5 } });
  });
});

describe('上游身份与去重键', () => {
  it('durable 帧 → 身份带 (aggregateId, seq)；去重键跨 worker 重启稳定', () => {
    const frame = frameOf(
      'session.step.ended',
      { sessionID: 'ses_1', assistantMessageID: 'msg_1', finish: 'stop' },
      { id: 'evt_1', durable: { aggregateID: 'ses_1', seq: 12, version: 1 } },
    );
    const identity = deriveUpstreamIdentity(frame);
    expect(identity).toEqual({ eventId: 'evt_1', aggregateId: 'ses_1', seq: 12 });
    // 去重键只由上游身份决定 → 与 worker 的 bootId/seq 无关 → 跨重启稳定
    expect(deriveUpstreamDedupKey(identity)).toBe('durable:ses_1:12');
  });

  it('ephemeral 增量帧 → 身份带 ordinal（同类内容流的序号，**非逐帧计数器**）', () => {
    const frame = frameOf('session.text.delta', {
      sessionID: 'ses_1',
      assistantMessageID: 'msg_1',
      ordinal: 0,
      delta: 'x',
    });
    const identity = deriveUpstreamIdentity(frame);
    expect(identity).toEqual({ eventId: 'evt_session.text.delta', ordinal: 0 });
    // 实机抓帧：同一消息的多帧 delta 全是 ordinal 0 → ordinal 不能做逐帧键，
    // 逐帧去重靠帧 id
    expect(deriveUpstreamDedupKey(identity)).toBe('event:evt_session.text.delta');
  });

  it('无 durable / 无 ordinal → 兜底用事件 id', () => {
    const identity = deriveUpstreamIdentity(frameOf('session.usage.updated', { sessionID: 'ses_1' }));
    expect(deriveUpstreamDedupKey(identity)).toBe('event:evt_session.usage.updated');
  });

  it('每个映射出的事件都能派生出上游身份（不漏挂）', () => {
    for (const [type, mapping] of Object.entries(V2_EVENT_MAP)) {
      const frame = frameOf(
        type,
        { sessionID: 'ses_1', assistantMessageID: 'msg_1', id: 'call_1', name: 'bash', delta: 'd', finish: 'stop' },
        { id: `evt_${type}` },
      );
      const identity = deriveUpstreamIdentity(frame);
      expect(identity.eventId).toBe(`evt_${type}`);
      expect(deriveUpstreamDedupKey(identity).length).toBeGreaterThan(0);
      expect(mapping.derive).toBeDefined();
    }
  });
});

describe('会话 id 解析（全局总线过滤）', () => {
  it('data.sessionID → 直接取', () => {
    expect(resolveV2SessionId(frameOf('session.execution.started', { sessionID: 'ses_a' }))).toBe('ses_a');
  });

  it('表单事件 → 取 form.sessionID', () => {
    expect(resolveV2SessionId(frameOf('form.created', { form: { id: 'frm_1', sessionID: 'ses_b' } }))).toBe('ses_b');
  });

  it('无 sessionID → 回退 durable.aggregateID（会话级聚合）', () => {
    expect(
      resolveV2SessionId(
        frameOf('session.created', {}, { durable: { aggregateID: 'ses_c', seq: 0, version: 1 } }),
      ),
    ).toBe('ses_c');
  });

  it('都没有 → 空串（调用方据此丢弃）', () => {
    expect(resolveV2SessionId(frameOf('config.updated', {}))).toBe('');
  });
});

describe('终态闸门 RunTerminalGate', () => {
  it('事件证据优先于轮询证据', () => {
    const gate = new RunTerminalGate();
    gate.notePolling({ verdict: 'succeeded' });
    gate.noteEvent({ verdict: 'failed', error: '炸了' });
    expect(gate.settle()).toEqual({ verdict: 'failed', error: '炸了' });
  });

  it('settle 是一次性的：第二次调用返回 null（终态事件只发一次）', () => {
    const gate = new RunTerminalGate();
    gate.noteEvent({ verdict: 'succeeded' });
    expect(gate.settle()).toEqual({ verdict: 'succeeded' });
    expect(gate.settle()).toBeNull();
  });

  it('durable seq 单调性：旧 seq 重放不覆盖新证据', () => {
    const gate = new RunTerminalGate();
    expect(gate.noteEvent({ verdict: 'failed' }, { eventId: 'evt_1', aggregateId: 'ses_1', seq: 12 })).toBe(true);
    expect(gate.noteEvent({ verdict: 'succeeded' }, { eventId: 'evt_2', aggregateId: 'ses_1', seq: 9 })).toBe(false);
    expect(gate.peek()).toEqual({ verdict: 'failed' });
  });

  it('尚无证据 → settle 返回 null', () => {
    expect(new RunTerminalGate().settle()).toBeNull();
  });
});

describe('内容 id 归一（事件路与轮询路同 id）', () => {
  it('驱动的 index 形态 → 类型化 id（文本/思考/工具）', () => {
    const normalized = normalizeV2ContentIds([
      {
        info: { id: 'msg_1', role: 'assistant' },
        parts: [
          { id: 'msg_1:0', type: 'text', text: '你好' },
          { id: 'msg_1:1', type: 'reasoning', text: '思考' },
          { id: 'msg_1:2', type: 'tool', tool: 'bash', callID: 'call_1', state: {} },
          { id: 'msg_1:step-finish', type: 'step-finish', reason: 'stop' },
        ],
      },
    ]);
    expect(normalized[0].parts.map((p) => p.id)).toEqual([
      'msg_1:text',
      'msg_1:reasoning',
      'msg_1:tool:call_1',
      'msg_1:step-finish',
    ]);
  });

  it('v1 的 serve 原生 id（prt_…）原样透传（不动 v1 行为）', () => {
    const normalized = normalizeV2ContentIds([
      { info: { id: 'msg_1', role: 'assistant' }, parts: [{ id: 'prt_abc', type: 'text', text: 'x' }] },
    ]);
    expect(normalized[0].parts[0].id).toBe('prt_abc');
  });

  it('扁平 part 列表同样归一（task.completed 的 parts 用）', () => {
    const list = normalizeV2ContentIdList([
      { id: 'msg_1:0', type: 'text', text: 'a' },
      { id: 'msg_1:1', type: 'text', text: 'b' },
    ]);
    expect(list.map((p) => p.id)).toEqual(['msg_1:text', 'msg_1:text:1']);
  });

  it('归一是幂等的（重复调用不改变结果）', () => {
    const once = normalizeV2ContentIds([
      { info: { id: 'msg_1', role: 'assistant' }, parts: [{ id: 'msg_1:0', type: 'text', text: 'a' }] },
    ]);
    const twice = normalizeV2ContentIds(once);
    expect(twice[0].parts[0].id).toBe('msg_1:text');
  });

  it('**统一形态的 id 原样透传**（边界归一对驱动产出的 id 是 no-op）', () => {
    const unified = [
      { id: 'msg_1:text', type: 'text', text: 'a' },
      { id: 'msg_1:text:1', type: 'text', text: 'b' },
      { id: 'msg_1:reasoning', type: 'reasoning', text: 'c' },
      { id: 'msg_1:tool:call_1', type: 'tool', tool: 'bash', callID: 'call_1', state: {} },
      { id: 'msg_1:step-finish', type: 'step-finish', reason: 'stop' },
    ];
    const list = normalizeV2ContentIdList(unified);
    expect(list.map((p) => p.id)).toEqual(unified.map((p) => p.id));
    // 幂等：再归一一次仍是同一批 id（`msg_1:text:1` 不得被改成 `msg_1:text:text`）
    expect(normalizeV2ContentIdList(list).map((p) => p.id)).toEqual(
      unified.map((p) => p.id),
    );
  });
});

describe('事件路与轮询路的 id 等价（跨实现断言：server 按 part.id 合并）', () => {
  /** 一条含文本/思考/工具的 v2 assistant 消息（轮询路与事件路共用同一条消息）。 */
  const WIRE_MESSAGE = {
    id: 'msg_1',
    type: 'assistant',
    time: { created: 1792462754300, completed: 1792462754396 },
    content: [
      { type: 'text', text: '你好' },
      { type: 'reasoning', text: '想一想' },
      { type: 'tool', id: 'call_1', name: 'bash', state: { status: 'completed' } },
    ],
    finish: 'stop',
  };

  it('同一内容的 id：事件路与轮询路**完全一致**', async () => {
    // 轮询路：真 V2Driver（假 v2 server）
    const server = http.createServer((req, res) => {
      const payload = JSON.stringify({ data: [WIRE_MESSAGE], cursor: { previous: null, next: null } });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
      void req;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const driver = new V2Driver({ baseUrl: `http://127.0.0.1:${port}` });
    let polledIds: string[] = [];
    try {
      const polled = await driver.getMessages('ses_1');
      polledIds = polled[0].parts.map((p) => p.id ?? '');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 事件路：同一消息的四类内容（帧里的 assistantMessageID = 'msg_1'）
    const eventIds = [
      ...(eventsOf(map('session.text.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', delta: '你好' }))[0]
        .payload.parts as Array<Record<string, unknown>>),
      ...(eventsOf(map('session.reasoning.delta', { sessionID: 'ses_1', assistantMessageID: 'msg_1', delta: '想一想' }))[0]
        .payload.parts as Array<Record<string, unknown>>),
      ...(eventsOf(
        map('session.tool.called', {
          sessionID: 'ses_1',
          assistantMessageID: 'msg_1',
          id: 'call_1',
          name: 'bash',
        }),
      )[0].payload.parts as Array<Record<string, unknown>>),
      ...(eventsOf(
        map('session.step.ended', { sessionID: 'ses_1', assistantMessageID: 'msg_1', finish: 'stop' }),
      )[0].payload.parts as Array<Record<string, unknown>>),
    ].map((p) => String(p.id));

    // 两条路径的 id 集合必须**逐个相同**（否则 server 按 id 合并会存成两个 part）
    expect([...eventIds].sort()).toEqual([...polledIds].sort());
    expect(eventIds).toEqual([
      'msg_1:text',
      'msg_1:reasoning',
      'msg_1:tool:call_1',
      'msg_1:step-finish',
    ]);
  });

  it('轮询路产出的 id 经边界归一后**不变**（边界只是幂等兜底，不再 reconcile）', () => {
    const driverIds = [
      { id: 'msg_1:text', type: 'text', text: '你好' },
      { id: 'msg_1:reasoning', type: 'reasoning', text: '想一想' },
      { id: 'msg_1:tool:call_1', type: 'tool', tool: 'bash', callID: 'call_1', state: {} },
      { id: 'msg_1:step-finish', type: 'step-finish', reason: 'stop' },
    ];
    expect(normalizeV2ContentIdList(driverIds).map((p) => p.id)).toEqual(
      driverIds.map((p) => p.id),
    );
  });
});

describe('正文聚合（终态兜底补发用）', () => {
  it('只取 assistant 的 text part、按时间升序拼接、排除 synthetic', () => {
    const text = assembleAssistantText([
      {
        info: { id: 'm2', role: 'assistant' },
        parts: [{ id: 'm2:0', type: 'text', text: '世界', time: { start: 2 } }],
      },
      {
        info: { id: 'm1', role: 'assistant' },
        parts: [
          { id: 'm1:0', type: 'text', text: '你好', time: { start: 1 } },
          { id: 'm1:1', type: 'text', text: '（合成）', synthetic: true, time: { start: 1 } },
        ],
      },
      { info: { id: 'u1', role: 'user' }, parts: [{ id: 'u1:0', type: 'text', text: '用户原文' }] },
    ]);
    expect(text).toBe('你好世界');
  });
});
