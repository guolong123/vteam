import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_EXEC_PORT,
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

    it('传入 model → body 仍为 {}（serve 1.18.15 拒收 model，模型在 prompt_async 指定）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({ id: 'ses_1' }) }));

      await client.createSession(worker, {
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({});
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

  describe('execute（方案 A：worker 执行端点 POST /execute）', () => {
    const execWorker = {
      id: 'w_1',
      capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
    };

    it('202 → resolve；URL = serve origin + execPort 拼接，body 含完整 payload', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 202 }));

      await expect(
        client.execute(execWorker, {
          prompt: [{ type: 'text', text: 'hi' }],
          model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
          agent: 'build',
          directory: '/tmp/tasks/t_1',
          taskId: 't_1',
          agentId: 'a_1',
          channelId: 'c_1',
          sessionId: 'ses_1',
        }),
      ).resolves.toBeUndefined();

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker:4198/execute');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
        agent: 'build',
        taskId: 't_1',
        agentId: 'a_1',
        channelId: 'c_1',
        sessionId: 'ses_1',
        directory: '/tmp/tasks/t_1',
        prompt: [{ type: 'text', text: 'hi' }],
      });
    });

    it('capabilities.execBaseUrl 优先（worker 上报完整执行端点基址，绕过拼接）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 202 }));
      const workerWithExecBase = {
        id: 'w_1',
        capabilities: { execBaseUrl: 'http://worker:4198' },
      };

      await client.execute(workerWithExecBase, { prompt: [{ type: 'text', text: 'x' }] });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://worker:4198/execute');
    });

    it('execPort 缺失 → 缺省 4198（对齐 worker WORKER_EXEC_PORT）；仅 prompt 也 2xx', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 202 }));
      const workerNoExecPort = { id: 'w_1', capabilities: { baseUrl: 'http://worker:46267' } };

      await client.execute(workerNoExecPort, { prompt: [{ type: 'text', text: 'x' }] });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://worker:${DEFAULT_EXEC_PORT}/execute`);
      expect(JSON.parse(String(init.body))).toEqual({ prompt: [{ type: 'text', text: 'x' }] });
    });

    it('baseUrl 缺失 → WORKER_BASE_URL 回退 origin 拼接 execPort', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 202 }));

      await client.execute(worker, { prompt: [{ type: 'text', text: 'x' }] });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(`http://localhost:${DEFAULT_EXEC_PORT}/execute`);
    });

    it('HTTP 非 2xx → WorkerUnavailableException（503，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 500 }));

      await expect(
        client.execute(execWorker, { prompt: [] }),
      ).rejects.toMatchObject({ workerId: 'w_1', status: 503 });
    });

    it('fetch 抛错 → WorkerUnavailableException（503，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(
        client.execute(execWorker, { prompt: [] }),
      ).rejects.toMatchObject({ workerId: 'w_1', status: 503 });
    });
  });

  describe('fetchFile（FR-41：GET /file 从 worker 工作区拉取文件）', () => {
    const execWorker = {
      id: 'w_1',
      capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
    };

    it('200 → 返回 Buffer 内容；URL 走 exec 端点并带 X-Worker-Token（默认 dev-worker-token）', async () => {
      const client = makeClient();
      const content = Buffer.from('hello world');
      const arrayBuffer = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      );
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => arrayBuffer,
      } as unknown as Response);

      await expect(
        client.fetchFile(execWorker, '/tmp/opencode/test_file.txt'),
      ).resolves.toEqual(content);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://worker:4198/file?path=%2Ftmp%2Fopencode%2Ftest_file.txt',
      );
      expect(init.method).toBe('GET');
      const headers = init.headers as Headers;
      expect(headers.get('X-Worker-Token')).toBe('dev-worker-token');
    });

    it('WORKER_TOKEN 配置时 X-Worker-Token 用配置值（对齐 compose 同一 token）', async () => {
      const config = {
        get: jest.fn((key: string, def?: unknown) => {
          if (key === 'WORKER_TOKEN') return 'compose-worker-token';
          return key === 'SERVER_PASSWORD' ? '' : def;
        }),
      } as unknown as ConfigService;
      const client = new WorkerClient(config);
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response);

      await client.fetchFile(execWorker, '/tmp/x.txt');

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Headers;
      expect(headers.get('X-Worker-Token')).toBe('compose-worker-token');
    });

    it('capabilities.execBaseUrl 优先（worker 上报完整执行端点基址）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response);

      await client.fetchFile(
        { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } },
        '/tmp/x.txt',
      );

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://worker:4198/file?path=%2Ftmp%2Fx.txt');
    });

    it('HTTP 非 2xx（404 文件不存在）→ WorkerUnavailableException（503，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 404 }));

      await expect(client.fetchFile(execWorker, '/tmp/missing.txt')).rejects.toMatchObject({
        workerId: 'w_1',
        status: 503,
      });
    });

    it('fetch 抛错（连接失败）→ WorkerUnavailableException（503，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(client.fetchFile(execWorker, '/tmp/x.txt')).rejects.toMatchObject({
        workerId: 'w_1',
        status: 503,
      });
    });
  });

  describe('questionReply / permissionReply（POST /question-reply 转发用户回复）', () => {
    const execWorker = {
      id: 'w_1',
      capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
    };

    it('questionReply：POST /question-reply 带 X-Worker-Token，body {sessionId, requestId, answers}', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 200 }));

      await client.questionReply(execWorker, {
        sessionId: 'ses_1',
        requestId: 'que_1',
        answers: [['继续']],
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker:4198/question-reply');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        sessionId: 'ses_1',
        requestId: 'que_1',
        answers: [['继续']],
      });
      const headers = init.headers as Headers;
      expect(headers.get('X-Worker-Token')).toBe('dev-worker-token');
    });

    it('questionReply：answers=null → 带 reject: true（用户拒绝走 serve rejectQuestion）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 200 }));

      await client.questionReply(execWorker, {
        sessionId: 'ses_1',
        requestId: 'que_1',
        answers: null,
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        sessionId: 'ses_1',
        requestId: 'que_1',
        answers: null,
        reject: true,
      });
    });

    it('permissionReply：POST /question-reply，body {sessionId, permissionId, response}', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 200 }));

      await client.permissionReply(execWorker, {
        sessionId: 'ses_1',
        permissionId: 'per_1',
        response: 'once',
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker:4198/question-reply');
      expect(JSON.parse(String(init.body))).toEqual({
        sessionId: 'ses_1',
        permissionId: 'per_1',
        response: 'once',
      });
    });

    it('HTTP 非 2xx → WorkerUnavailableException（503，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 400 }));

      await expect(
        client.questionReply(execWorker, { sessionId: 'ses_1', requestId: 'que_1', answers: [] }),
      ).rejects.toMatchObject({ workerId: 'w_1', status: 503 });
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
