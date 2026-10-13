import { ServeEventStream, ServeStreamPart } from './serve-event-stream';

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

/** 把事件对象包成 SSE data 帧（空行结尾）。 */
function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function partUpdated(part: Record<string, unknown>): string {
  return frame({ type: 'message.part.updated', properties: { part, time: Date.now() } });
}

describe('ServeEventStream（serve /event SSE 实时订阅）', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('server.connected 首帧 → onOpen 成活', async () => {
    const parts: ServeStreamPart[] = [];
    let opened = 0;
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([frame({ type: 'server.connected', properties: {} })]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: (p) => parts.push(p),
      onOpen: () => {
        opened += 1;
      },
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(opened).toBe(1);
    stream.close();
  });

  it('message.part.updated → 整 part 快照透传 onPart', async () => {
    const parts: ServeStreamPart[] = [];
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        frame({ type: 'server.connected', properties: {} }),
        partUpdated({ id: 'prt_1', type: 'text', sessionID: 'ses_a', messageID: 'msg_1', text: 'hello' }),
        partUpdated({
          id: 'prt_2',
          type: 'tool',
          sessionID: 'ses_a',
          messageID: 'msg_1',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt' },
        }),
      ]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: (p) => parts.push(p),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ id: 'prt_1', type: 'text', text: 'hello' });
    expect(parts[1]).toMatchObject({ id: 'prt_2', type: 'tool' });
    stream.close();
  });

  it('message.part.delta → 按 partID 累积成合成 text part，逐次增长', async () => {
    const parts: ServeStreamPart[] = [];
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        frame({
          type: 'message.part.delta',
          properties: { sessionID: 'ses_a', messageID: 'msg_1', partID: 'prt_t', field: 'text', delta: '你好' },
        }),
        frame({
          type: 'message.part.delta',
          properties: { sessionID: 'ses_a', messageID: 'msg_1', partID: 'prt_t', field: 'text', delta: '世界' },
        }),
      ]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: (p) => parts.push(p),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ id: 'prt_t', type: 'text', text: '你好' });
    expect(parts[1]).toMatchObject({ id: 'prt_t', type: 'text', text: '你好世界' });
    stream.close();
  });

  it('part.updated 到达 → 清除同 partID 的 delta 累积缓冲（权威快照覆盖）', async () => {
    const parts: ServeStreamPart[] = [];
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        frame({
          type: 'message.part.delta',
          properties: { sessionID: 'ses_a', messageID: 'msg_1', partID: 'prt_t', field: 'text', delta: '旧增量' },
        }),
        // 整快照覆盖后 buffered 的「旧增量」作废：后续 delta 从零累积
        partUpdated({ id: 'prt_t', type: 'text', sessionID: 'ses_a', messageID: 'msg_1', text: '完整文本' }),
        frame({
          type: 'message.part.delta',
          properties: { sessionID: 'ses_a', messageID: 'msg_1', partID: 'prt_t', field: 'text', delta: '续' },
        }),
      ]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: (p) => parts.push(p),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(parts).toHaveLength(3);
    expect(parts[0].text).toBe('旧增量');
    expect(parts[1].text).toBe('完整文本');
    expect(parts[2].text).toBe('续'); // 缓冲已清，不是「旧增量续」
    stream.close();
  });

  it('message.updated → onMessageInfo 透传 info（assistant 集合建立源）', async () => {
    const infos: Array<{ id?: unknown; role?: unknown }> = [];
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        frame({ type: 'message.updated', properties: { info: { id: 'msg_1', role: 'assistant' } } }),
        frame({ type: 'message.updated', properties: { info: { id: 'msg_u', role: 'user' } } }),
      ]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: () => {},
      onMessageInfo: (i) => infos.push(i),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(infos).toHaveLength(2);
    expect(infos[0]).toEqual({ id: 'msg_1', role: 'assistant' });
    expect(infos[1]).toEqual({ id: 'msg_u', role: 'user' });
    stream.close();
  });

  it('非 JSON 帧与未知事件类型：忽略不抛错、不中断流', async () => {
    const parts: ServeStreamPart[] = [];
    global.fetch = jest.fn().mockResolvedValue(
      sseResponse([
        'data: not-json\n\n',
        frame({ type: 'session.idle', properties: { sessionID: 'ses_a' } }),
        partUpdated({ id: 'prt_ok', type: 'text', sessionID: 'ses_a', messageID: 'msg_1', text: 'ok' }),
      ]),
    ) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: (p) => parts.push(p),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ id: 'prt_ok', text: 'ok' });
    stream.close();
  });

  it('多行 data 帧按 \\n 拼接解析', async () => {
    const parts: ServeStreamPart[] = [];
    const multi = `data: {"type":"message.part.updated",\n` + `data: "properties":{"part":{"id":"prt_m","type":"text","text":"x"}}}\n\n`;
    global.fetch = jest.fn().mockResolvedValue(sseResponse([multi])) as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: (p) => parts.push(p),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ id: 'prt_m', text: 'x' });
    stream.close();
  });

  it('流对端关闭 → onClose 回调 + 退避重连（新 fetch 调用）', async () => {
    jest.useFakeTimers();
    const closes: string[] = [];
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(sseResponse([frame({ type: 'server.connected', properties: {} })]))
      .mockImplementation(() => new Promise<Response>(() => {})); // 重连后挂起
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: () => {},
      onClose: (r) => closes.push(r),
    });
    stream.start();
    await jest.advanceTimersByTimeAsync(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1200); // 退避 1s 后重连
    expect(closes).toEqual(['stream-closed']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stream.close();
  });

  it('close() 后不再重连', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockResolvedValue(sseResponse([]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: () => {},
    });
    stream.start();
    await jest.advanceTimersByTimeAsync(50);
    stream.close();
    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetch 抛错（HTTP 非 2xx/网络错）→ onClose + 重连，不抛出到调用方', async () => {
    jest.useFakeTimers();
    const closes: string[] = [];
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockImplementation(() => new Promise<Response>(() => {}));
    global.fetch = fetchMock as unknown as typeof fetch;
    const stream = new ServeEventStream({
      baseUrl: 'http://127.0.0.1:4096',
      onPart: () => {},
      onClose: (r) => closes.push(r),
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
      onPart: () => {},
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 20));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4096/event'); // baseUrl 尾部斜线归一
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`);
    stream.close();
  });
});
