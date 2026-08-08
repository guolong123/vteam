import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  WorkerClient,
  WorkerUnavailableException,
} from './worker.client';

/** mock global.fetch（Node 18+ 全局 fetch；worker.client.ts 裸 fetch 调 serve）。 */
const mockFetch = jest.fn();
const originalFetch = global.fetch;

/** 最小 Response 形态（fetch mock 返回值）。 */
function response(
  overrides: Partial<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }> = {},
): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn(async () => ({})),
    ...overrides,
  } as unknown as Response;
}

/** 构造 WorkerClient（SERVER_PASSWORD 默认为空=不鉴权；公开字段可再覆盖）。 */
function makeClient(password = '') {
  const config = {
    get: jest.fn((key: string, def?: unknown) =>
      key === 'SERVER_PASSWORD' ? password : def,
    ),
  } as unknown as ConfigService;
  return new WorkerClient(config);
}

/** worker 行最小形态（capabilities 无 baseUrl/port → 走 WORKER_BASE_URL 回退）。 */
const worker = { id: 'w_00001', capabilities: {} };

describe('WorkerClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('createSession', () => {
    it('POST /session 200 + {id} → 返回 {sessionID}（映射 serve 实际返回的 id 字段）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({ id: 'ses_abc' }) }));

      await expect(client.createSession(worker)).resolves.toEqual({
        sessionID: 'ses_abc',
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4199/session');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({});
    });

    it('传入 model → body 为 { model: { providerID, modelID } }', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({ id: 'ses_1' }) }));

      await client.createSession(worker, {
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      });
    });

    it('fetch 抛错 → WorkerUnavailableException（503 语义，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(client.createSession(worker)).rejects.toMatchObject({
        workerId: 'w_00001',
        status: 503,
      });
    });

    it('响应缺 session id → 抛 WorkerUnavailableException', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({ foo: 1 }) }));

      await expect(client.createSession(worker)).rejects.toThrow(WorkerUnavailableException);
    });
  });

  describe('promptAsync', () => {
    it('204 → resolve（成功，不抛异常）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 204 }));

      await expect(
        client.promptAsync(worker, 'ses_1', {
          parts: [{ type: 'text', text: 'hello' }],
        }),
      ).resolves.toBeUndefined();

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4199/session/ses_1/prompt_async');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        parts: [{ type: 'text', text: 'hello' }],
      });
    });

    it('directory 走 query 参数；model/agent 进 body', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 204 }));

      await client.promptAsync(
        worker,
        'ses_1',
        {
          model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
          agent: 'build',
          parts: [{ type: 'text', text: 'hi' }],
          directory: '/data/git-project/aiagents',
        },
      );

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://localhost:4199/session/ses_1/prompt_async?directory=%2Fdata%2Fgit-project%2Faiagents',
      );
      expect(JSON.parse(String(init.body))).toEqual({
        model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
        agent: 'build',
        parts: [{ type: 'text', text: 'hi' }],
      });
    });

    it('HTTP 500 → WorkerUnavailableException', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 500 }));

      await expect(
        client.promptAsync(worker, 'ses_1', { parts: [] }),
      ).rejects.toMatchObject({ workerId: 'w_00001' });
    });
  });

  describe('listModels', () => {
    it('GET /api/model → 映射为 {id: providerID/modelID} 列表', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            data: [
              { id: 'deepseek-v4-flash', providerID: 'opencode-go', name: 'DeepSeek V4 Flash' },
              { id: 'ling-3.0-tiny-free', providerID: 'opencode', name: 'Ling-3.0-tiny Free' },
            ],
          }),
        }),
      );

      await expect(client.listModels(worker)).resolves.toEqual([
        {
          id: 'opencode-go/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          providerID: 'opencode-go',
          modelID: 'deepseek-v4-flash',
        },
        {
          id: 'opencode/ling-3.0-tiny-free',
          name: 'Ling-3.0-tiny Free',
          providerID: 'opencode',
          modelID: 'ling-3.0-tiny-free',
        },
      ]);
    });

    it('F2 MINOR：缺省 providerID/id → id 兜底为 /，不产出 undefined/undefined（与 worker 侧统一）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            data: [{ name: 'Bare Model' }],
          }),
        }),
      );

      await expect(client.listModels(worker)).resolves.toEqual([
        {
          id: '/',
          name: 'Bare Model',
          providerID: '',
          modelID: '',
        },
      ]);
    });

    it('/api/model 404（旧版 serve）→ 回退 capabilities.models 数组', async () => {      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 404 }));
      const workerWithModels = {
        id: 'w_1',
        capabilities: {
          models: [
            { id: 'deepseek-v3', name: 'DeepSeek V3', providerID: 'opencode' },
          ],
        },
      };

      await expect(client.listModels(workerWithModels)).resolves.toEqual([
        {
          id: 'deepseek-v3',
          name: 'DeepSeek V3',
          providerID: 'opencode',
          modelID: 'deepseek-v3',
        },
      ]);
    });

    it('全部失败且无 capabilities.models → 空数组', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(client.listModels(worker)).resolves.toEqual([]);
    });
  });

  describe('abort', () => {
    it('200 → resolve', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 200 }));

      await expect(client.abort(worker, 'ses_1')).resolves.toBeUndefined();

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:4199/session/ses_1/abort');
      expect(init.method).toBe('POST');
    });

    it('HTTP 非 2xx → WorkerUnavailableException', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 500 }));

      await expect(client.abort(worker, 'ses_1')).rejects.toThrow(
        WorkerUnavailableException,
      );
    });
  });

  describe('getMessages', () => {
    it('200 + 数组 → 原样返回', async () => {
      const client = makeClient();
      const messages = [{ id: 'msg_1', info: { role: 'assistant' } }];
      mockFetch.mockResolvedValue(response({ json: async () => messages }));

      await expect(client.getMessages(worker, 'ses_1')).resolves.toEqual(messages);

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://localhost:4199/session/ses_1/message');
    });

    it('fetch 抛错 → WorkerUnavailableException', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('socket hang up'));

      await expect(client.getMessages(worker, 'ses_1')).rejects.toMatchObject({
        workerId: 'w_00001',
      });
    });
  });

  describe('isHealthy', () => {
    it('GET / 200 → true', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 200 }));

      await expect(client.isHealthy(worker)).resolves.toBe(true);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://localhost:4199/');
    });

    it('非 200 → false（不抛异常）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 503 }));

      await expect(client.isHealthy(worker)).resolves.toBe(false);
    });

    it('fetch 抛错 → false（不抛异常）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(client.isHealthy(worker)).resolves.toBe(false);
    });
  });

  describe('baseUrl / 鉴权解析', () => {
    it('capabilities.baseUrl 优先于 WORKER_BASE_URL 回退', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response());

      await client.isHealthy({ id: 'w_1', capabilities: { baseUrl: 'http://10.0.0.5:4300' } });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://10.0.0.5:4300/');
    });

    it('capabilities.port 拼 localhost', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response());

      await client.isHealthy({ id: 'w_1', capabilities: { port: 4321 } });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://localhost:4321/');
    });

    it('SERVER_PASSWORD 设置时注入 Basic Auth 头（opencode:<password>）', async () => {
      const client = makeClient('secret-pass');
      mockFetch.mockResolvedValue(response());

      await client.isHealthy(worker);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Headers;
      expect(headers.get('Authorization')).toBe(
        `Basic ${Buffer.from('opencode:secret-pass', 'utf8').toString('base64')}`,
      );
    });

    it('SERVER_PASSWORD 为空 → 不注入 Authorization 头', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response());

      await client.isHealthy(worker);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Headers;
      expect(headers.get('Authorization')).toBeNull();
    });
  });

  describe('超时', () => {
    it('fetch abort（AbortError）→ WorkerUnavailableException 且消息含超时提示', async () => {
      const client = makeClient();
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      mockFetch.mockRejectedValue(abortError);

      await expect(client.getMessages(worker, 'ses_1')).rejects.toMatchObject({
        workerId: 'w_00001',
        status: 503,
      });
      // describeError 把 AbortError 归一为超时提示，消息应包含超时文案
      await expect(client.getMessages(worker, 'ses_1')).rejects.toThrow(
        `请求超时（>${DEFAULT_REQUEST_TIMEOUT_MS}ms）`,
      );
    });
  });
});
