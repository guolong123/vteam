/**
 * T11 SSE 帧解析器测试（v2 帧格式）。
 *
 * 覆盖计划 T11 的五条验收标准 + 两条风险对策：
 * 1. 真实抓帧（`docs/agent-platform/opencode-v2-contract-baseline/sse-sample.txt` 与
 *    T4 spike 抓帧）能解析出 type / durable；
 * 2. **不要求 `event:` 行**（v2 运行时不发它——OpenAPI schema 声明必填是错的）；
 * 3. `event:` 行存在时优先取它；
 * 4. 心跳注释行不报错，且计入「连接成活」；
 * 5. 多行 `data:` 拼接与空行分帧正确；
 * 6. **解析失败的帧计数 + 告警，不静默丢、不抛**。
 */

import { ServeEventStream, parseV2EventFrame } from './serve-event-stream';
import type { V2EventFrame } from './v2-event-map';

/** 构造一次性的 SSE 响应体（ReadableStream，按帧推入后关闭）。 */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(encoder.encode(f));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** 把事件对象包成 SSE data 帧（空行结尾）——v2 形态：**没有** event: 行。 */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** 实机抓帧（v2.0.28）：文本增量。 */
const REAL_TEXT_DELTA =
  'data: {"id":"evt_1571b1268001K7PnDkKSWqkYu9","created":1792462754408,"type":"session.text.delta",' +
  '"location":{"directory":"/tmp/x"},"data":{"sessionID":"ses_ea8e4faa7ffeLwZGHdvHNdLXEL",' +
  '"assistantMessageID":"msg_1571b1262001G29sNnwsKHmcTE","ordinal":0,"delta":"MOCK_OK"}}\n\n';

/** 实机抓帧（v2.0.28）：step 结束（带 finish/cost/tokens + durable 游标）。 */
const REAL_STEP_ENDED =
  'data: {"id":"evt_1571b125c001LXQpVc0f5Pg7kj","created":1792462754396,"type":"session.step.ended",' +
  '"location":{"directory":"/tmp/x"},"data":{"sessionID":"ses_ea8e4faa7ffeLwZGHdvHNdLXEL",' +
  '"assistantMessageID":"msg_1571b1262001G29sNnwsKHmcTE","finish":"tool-calls","rawFinish":"tool_calls",' +
  '"cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}},' +
  '"durable":{"aggregateID":"ses_ea8e4faa7ffeLwZGHdvHNdLXEL","seq":12,"version":1}}\n\n';

describe('parseV2EventFrame（v2 帧信封解析）', () => {
  it('真实抓帧 → 解析出 type / data / durable / created', () => {
    const parsed = parseV2EventFrame(
      REAL_TEXT_DELTA.slice('data: '.length, -2),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame.type).toBe('session.text.delta');
    expect(parsed.frame.id).toBe('evt_1571b1268001K7PnDkKSWqkYu9');
    expect(parsed.frame.created).toBe(1792462754408);
    // data 是**扁平**的（不是 v1 的 properties 嵌套）
    expect(parsed.frame.data).toMatchObject({
      sessionID: 'ses_ea8e4faa7ffeLwZGHdvHNdLXEL',
      assistantMessageID: 'msg_1571b1262001G29sNnwsKHmcTE',
      ordinal: 0,
      delta: 'MOCK_OK',
    });
    // 文本增量**没有** durable 块（⇒ ephemeral）
    expect(parsed.frame.durable).toBeUndefined();
    expect(parsed.typeSource).toBe('data');
  });

  it('durable 帧 → 解析出 durable 游标（aggregateID/seq/version）', () => {
    const parsed = parseV2EventFrame(REAL_STEP_ENDED.slice('data: '.length, -2));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame.type).toBe('session.step.ended');
    expect(parsed.frame.durable).toEqual({
      aggregateID: 'ses_ea8e4faa7ffeLwZGHdvHNdLXEL',
      seq: 12,
      version: 1,
    });
    expect(parsed.frame.data.finish).toBe('tool-calls');
    expect(parsed.frame.location?.directory).toBe('/tmp/x');
  });

  it('无 event: 行也能解析（v2 运行时不发该行——解析器不得要求它）', () => {
    const parsed = parseV2EventFrame('{"id":"evt_1","type":"session.created","data":{}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame.type).toBe('session.created');
    expect(parsed.typeSource).toBe('data');
  });

  it('有 event: 行时优先取它（缺失时回退 data.type）', () => {
    const withEvent = parseV2EventFrame(
      '{"id":"evt_1","type":"session.text.delta","data":{}}',
      'session.text.delta',
    );
    expect(withEvent.ok).toBe(true);
    if (!withEvent.ok) return;
    expect(withEvent.typeSource).toBe('event');
    expect(withEvent.frame.type).toBe('session.text.delta');

    // event: 行与 data.type 冲突 → 以 event: 为准（防御性口径），但 dataType 原样带出
    const conflict = parseV2EventFrame(
      '{"id":"evt_1","type":"session.text.delta","data":{}}',
      'message.part.delta',
    );
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) return;
    expect(conflict.frame.type).toBe('message.part.delta');
    expect(conflict.dataType).toBe('session.text.delta');
  });

  it('非 JSON 帧 → 失败原因（非抛），不产出帧', () => {
    const parsed = parseV2EventFrame('not-json');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('非 JSON');
  });

  it('缺 type 的帧 → 失败原因（event: 行也没有）', () => {
    const parsed = parseV2EventFrame('{"id":"evt_1","data":{}}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('缺少类型');
  });
});

describe('ServeEventStream（v2 /api/event SSE 实时订阅）', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('真实抓帧 → 派发已解析的 v2 帧', async () => {
    const frames: V2EventFrame[] = [];
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([REAL_TEXT_DELTA, REAL_STEP_ENDED]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onEvent: (f) => frames.push(f),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe('session.text.delta');
    expect(frames[1].type).toBe('session.step.ended');
    expect(frames[1].durable?.seq).toBe(12);
    stream.close();
  });

  it('订阅路径是 v2 的 /api/event（不是 v1 的 /event）', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sseResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({ baseUrl: 'http://127.0.0.1:4096/' });
    stream.start();
    await new Promise((r) => setTimeout(r, 20));
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4096/api/event');
    stream.close();
  });

  it('server.connected 首帧 → onOpen 成活（且不进事件映射）', async () => {
    const frames: V2EventFrame[] = [];
    let opened = 0;
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([frame({ id: 'evt_c', type: 'server.connected', data: {} })]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onEvent: (f) => frames.push(f),
      onOpen: () => {
        opened += 1;
      },
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toBe(1);
    expect(frames).toHaveLength(0);
    stream.close();
  });

  it('心跳注释行（: heartbeat）不报错，且计入「连接成活」', async () => {
    let opened = 0;
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([': heartbeat\n\n', ': heartbeat\n\n']),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onEvent: () => {
        throw new Error('心跳不应产生事件');
      },
      onOpen: () => {
        opened += 1;
      },
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toBe(1);
    stream.close();
  });

  it('非 JSON 帧 → 计数 + 告警，不抛、不中断流（后续帧照常派发）', async () => {
    const frames: V2EventFrame[] = [];
    const malformed: Array<{ reason: string; count: number }> = [];
    const warns: string[] = [];
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        'data: not-json\n\n',
        frame({ id: 'evt_ok', type: 'session.text.delta', data: { delta: 'x' } }),
      ]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onEvent: (f) => frames.push(f),
      onMalformed: (info) => malformed.push({ reason: info.reason, count: info.count }),
      logger: { warn: (m) => warns.push(m) },
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(malformed).toHaveLength(1);
    expect(malformed[0].count).toBe(1);
    expect(malformed[0].reason).toContain('非 JSON');
    expect(warns.some((w) => w.includes('解析失败'))).toBe(true);
    expect(stream.malformedFrames).toBe(1);
    // 后续帧照常派发（解析失败不中断流）
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('session.text.delta');
    stream.close();
  });

  it('缺 type 的帧 → 计数 + 告警，不抛', async () => {
    const malformed: string[] = [];
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse(['data: {"id":"evt_1","data":{}}\n\n']),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onEvent: () => {},
      onMalformed: (info) => malformed.push(info.reason),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(malformed).toHaveLength(1);
    expect(malformed[0]).toContain('缺少类型');
    expect(stream.malformedFrames).toBe(1);
    stream.close();
  });

  it('多行 data 帧按 \\n 拼接解析 + 空行分帧', async () => {
    const frames: V2EventFrame[] = [];
    const multi =
      `data: {"id":"evt_m","type":"session.text.delta",\n` +
      `data: "data":{"delta":"你好"}}\n\n`;
    global.fetch = jest.fn().mockResolvedValue(sseResponse([multi])) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onEvent: (f) => frames.push(f),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('session.text.delta');
    expect(frames[0].data.delta).toBe('你好');
    stream.close();
  });

  it('记录 durable 游标（断线补齐的锚点）：同一聚合取最大 seq', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        frame({
          id: 'evt_1',
          type: 'session.step.ended',
          data: { assistantMessageID: 'msg_1', finish: 'stop' },
          durable: { aggregateID: 'ses_a', seq: 3, version: 1 },
        }),
        frame({
          id: 'evt_2',
          type: 'session.step.ended',
          data: { assistantMessageID: 'msg_1', finish: 'stop' },
          durable: { aggregateID: 'ses_a', seq: 9, version: 1 },
        }),
        frame({
          id: 'evt_3',
          type: 'session.step.ended',
          data: { assistantMessageID: 'msg_1', finish: 'stop' },
          durable: { aggregateID: 'ses_a', seq: 5, version: 1 },
        }),
      ]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({ baseUrl: 'http://127.0.0.1:4096' });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(stream.lastSeq('ses_a')).toBe(9);
    stream.close();
  });

  it('流对端关闭 → onClose 回调 + 退避重连（新 fetch 调用）', async () => {
    jest.useFakeTimers();
    const closes: Array<{ reason: string; frames: number }> = [];
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(sseResponse([frame({ id: 'evt_c', type: 'server.connected', data: {} })]))
      .mockImplementation(() => new Promise<Response>(() => {})); // 重连后挂起
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onClose: (reason, info) => closes.push({ reason, frames: info.frames }),
    });
    stream.start();
    await jest.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1200); // 退避 1s 后重连
    expect(closes[0].reason).toBe('stream-closed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stream.close();
  });

  it('重连成功 → onReconnect 被调用（重连后状态重同步的钩子）', async () => {
    jest.useFakeTimers();
    const reconnects: number[] = [];
    // 第二次连接：响应头已到、body 保持打开（连接建立成功但不再断）
    const hangingBody = new ReadableStream<Uint8Array>({
      start() {
        /* 永不结束 */
      },
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(sseResponse([]))
      .mockResolvedValue(new Response(hangingBody, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onReconnect: (info) => {
        reconnects.push(info.attempt);
      },
    });
    stream.start();
    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(1200);
    expect(reconnects).toEqual([1]);
    stream.close();
  });

  it('onReconnect 返回的 Promise 未兑现前不派发新帧（补齐先于新帧）', async () => {
    jest.useFakeTimers();
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(sseResponse([]))
      .mockImplementation(() => new Promise<Response>(() => {}));
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onReconnect: () => gate,
      onEvent: (f) => events.push(f.type),
    });
    stream.start();
    await jest.advanceTimersByTimeAsync(50);
    await jest.advanceTimersByTimeAsync(1200);
    // 重连已发起但被闸门挡住：此时不应有任何新帧被派发
    expect(events).toHaveLength(0);
    release();
    await jest.advanceTimersByTimeAsync(10);
    stream.close();
  });

  it('close() 后不再重连', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(sseResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({ baseUrl: 'http://127.0.0.1:4096' });
    stream.start();
    await jest.advanceTimersByTimeAsync(50);
    stream.close();
    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetch 抛错（HTTP 非 2xx/网络错）→ onClose + 重连，不抛出到调用方', async () => {
    jest.useFakeTimers();
    const closes: string[] = [];
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockImplementation(() => new Promise<Response>(() => {}));
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onClose: (reason) => closes.push(reason),
    });
    stream.start();
    await jest.advanceTimersByTimeAsync(50);
    expect(closes[0]).toContain('HTTP 503');
    await jest.advanceTimersByTimeAsync(1200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stream.close();
  });

  it('Basic Auth：serverPassword 非空时带 Authorization 头', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sseResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096/',
      serverPassword: 'pw',
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 20));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4096/api/event');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`);
    stream.close();
  });
});
