/**
 * V1Driver 单元测试（T4）。
 *
 * mock 全局 fetch（Node 原生 Response 构造响应体），覆盖：
 * - createSession：POST /session body、{id}→sessionID 映射、缺 id 报错
 * - sendMessage：prompt_async 路径/directory query/body、2xx 成功与非 2xx 失败
 * - getMessages：Array<{info,parts}> 直通 + {data} 包裹兼容
 * - abort / listModels 映射（id=providerID/modelID）/ isHealthy 三态
 * - Basic Auth header、15s 超时（AbortError→DriverRequestError）、baseUrl 未设置报错
 */

import { V1Driver, DriverRequestError } from './v1-driver';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  // 204 No Content 不允许带 body（Response 构造器会抛 Invalid response status code 204）
  if (status === 204) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), { status });
}

function newDriver(opts: { baseUrl?: string; serverPassword?: string; timeoutMs?: number } = {}): V1Driver {
  return new V1Driver({
    baseUrl: opts.baseUrl ?? 'http://127.0.0.1:4199',
    serverPassword: opts.serverPassword,
    timeoutMs: opts.timeoutMs,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('V1Driver.createSession', () => {
  it('POST /session 无 model → body {}，响应 {id} 映射为 sessionID', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'ses_abc123' }));
    const driver = newDriver();
    const sessionID = await driver.createSession();

    expect(sessionID).toBe('ses_abc123');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4199/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});
  });

  it('带 model 参数 → body 仍为 {}（serve 1.18.15 拒收 model，模型在 prompt_async 指定）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'ses_xyz' }));
    const driver = newDriver();
    await driver.createSession({ providerID: 'opencode-go', modelID: 'deepseek-v4-flash' });

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({});
  });

  it('响应同时兼容 {sessionID}（防御性，SDK 旧声明）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ sessionID: 'ses_legacy' }));
    const driver = newDriver();
    await expect(driver.createSession()).resolves.toBe('ses_legacy');
  });

  it('响应缺 id → DriverRequestError', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const driver = newDriver();
    await expect(driver.createSession()).rejects.toThrow(DriverRequestError);
    // 第二次调用需新 Response（body 只能读一次）
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(driver.createSession()).rejects.toThrow(/缺少 session id/);
  });
});

describe('V1Driver.sendMessage', () => {
  it('POST prompt_async：directory 为 query 参数（D2 铁律），body 含 parts', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 204));
    const driver = newDriver();
    await driver.sendMessage('ses_1', {
      parts: [{ type: 'text', text: 'hi' }],
      directory: '/tmp/work',
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'http://127.0.0.1:4199/session/ses_1/prompt_async?directory=%2Ftmp%2Fwork',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ parts: [{ type: 'text', text: 'hi' }] });
  });

  it('body 含 model/agent（可选）；directory 缺省不带 query', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 200));
    const driver = newDriver();
    await driver.sendMessage('ses_1', {
      model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      agent: 'build',
      parts: [],
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4199/session/ses_1/prompt_async');
    expect(JSON.parse(init.body)).toEqual({
      model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      agent: 'build',
      parts: [],
    });
  });

  it('非 2xx → DriverRequestError（带 HTTP 状态）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'bad' }, 400));
    const driver = newDriver();
    await expect(
      driver.sendMessage('ses_1', { parts: [] }),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe('V1Driver.getMessages', () => {
  it('返回 Array<{info,parts}> 直接透传（轮询完成判定用）', async () => {
    const msgs = [
      { info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
      { info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'step-finish', reason: 'stop' }] },
    ];
    mockFetch.mockResolvedValue(jsonResponse(msgs));
    const driver = newDriver();
    await expect(driver.getMessages('ses_1')).resolves.toEqual(msgs);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'http://127.0.0.1:4199/session/ses_1/message',
    );
  });

  it('兼容 {data:[...]} 包裹（防御性）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ info: { id: 'm1', role: 'user' }, parts: [] }] }));
    const driver = newDriver();
    const msgs = await driver.getMessages('ses_1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].info.id).toBe('m1');
  });
});

describe('V1Driver.abort / listModels / isHealthy', () => {
  it('abort：POST /session/{id}/abort', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 200));
    const driver = newDriver();
    await driver.abort('ses_1');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4199/session/ses_1/abort');
    expect(init.method).toBe('POST');
  });

  it('listModels：GET /api/model，data 映射 id=providerID/modelID', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        location: 'local',
        data: [
          { id: 'deepseek-v4-flash', providerID: 'opencode-go', name: 'DeepSeek V4 Flash' },
          { id: 'qwen3.5', providerID: 'ollama-local', name: 'Qwen 3.5' },
        ],
      }),
    );
    const driver = newDriver();
    const models = await driver.listModels();
    expect(models).toEqual([
      { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash', providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      { id: 'ollama-local/qwen3.5', name: 'Qwen 3.5', providerID: 'ollama-local', modelID: 'qwen3.5' },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4199/api/model');
  });

  it('isHealthy：2xx → true；非 2xx → false；网络错 → false（不抛异常）', async () => {
    const driver = newDriver();

    mockFetch.mockResolvedValue(jsonResponse({}, 200));
    await expect(driver.isHealthy()).resolves.toBe(true);

    mockFetch.mockResolvedValue(jsonResponse({}, 401));
    await expect(driver.isHealthy()).resolves.toBe(false);

    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(driver.isHealthy()).resolves.toBe(false);
  });
});

describe('V1Driver 鉴权 / 超时 / baseUrl', () => {
  it('serverPassword 非空 → 请求带 Basic Auth header（username=opencode）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'ses_1' }));
    const driver = newDriver({ serverPassword: 'pw' });
    await driver.createSession();

    const [, init] = mockFetch.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(
      `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
    );
  });

  it('serverPassword 空 → 不设 Authorization header', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'ses_1' }));
    const driver = newDriver();
    await driver.createSession();

    const [, init] = mockFetch.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('请求超时：AbortError → DriverRequestError（带超时文案）', async () => {
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const driver = newDriver({ timeoutMs: 20 });
    await expect(driver.createSession()).rejects.toThrow(/请求超时/);
  });

  it('baseUrl 未设置（serve 未就绪）→ DriverRequestError', async () => {
    const driver = newDriver({ baseUrl: '' });
    await expect(driver.createSession()).rejects.toThrow(/baseUrl 未设置/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('baseUrl setter 更新后走新地址（随机端口场景 start() 后注入）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'ses_2' }));
    const driver = newDriver({ baseUrl: '' });
    driver.baseUrl = 'http://127.0.0.1:53001';
    await driver.createSession();
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:53001/session');
  });

  it('网络错误 → DriverRequestError', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const driver = newDriver();
    await expect(driver.createSession()).rejects.toThrow(/ECONNREFUSED/);
  });
});
