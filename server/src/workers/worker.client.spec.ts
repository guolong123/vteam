import { BadRequestException } from '@nestjs/common';
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
    text: () => Promise<string>;
  }> = {},
): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn(async () => ({})),
    text: jest.fn(async () => ''),
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
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ id: 'ses_abc' }) }),
      );

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
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ id: 'ses_1' }) }),
      );

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

      await expect(client.createSession(worker)).rejects.toThrow(
        WorkerUnavailableException,
      );
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

      await client.promptAsync(worker, 'ses_1', {
        model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
        agent: 'build',
        parts: [{ type: 'text', text: 'hi' }],
        directory: '/data/git-project/aiagents',
      });

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

      await client.execute(workerWithExecBase, {
        prompt: [{ type: 'text', text: 'x' }],
      });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://worker:4198/execute');
    });

    it('execPort 缺失 → 缺省 4198（对齐 worker WORKER_EXEC_PORT）；仅 prompt 也 2xx', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 202 }));
      const workerNoExecPort = {
        id: 'w_1',
        capabilities: { baseUrl: 'http://worker:46267' },
      };

      await client.execute(workerNoExecPort, {
        prompt: [{ type: 'text', text: 'x' }],
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://worker:${DEFAULT_EXEC_PORT}/execute`);
      expect(JSON.parse(String(init.body))).toEqual({
        prompt: [{ type: 'text', text: 'x' }],
      });
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

      await expect(
        client.fetchFile(execWorker, '/tmp/missing.txt'),
      ).rejects.toMatchObject({
        workerId: 'w_1',
        status: 503,
      });
    });

    it('fetch 抛错（连接失败）→ WorkerUnavailableException（503，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(
        client.fetchFile(execWorker, '/tmp/x.txt'),
      ).rejects.toMatchObject({
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
        client.questionReply(execWorker, {
          sessionId: 'ses_1',
          requestId: 'que_1',
          answers: [],
        }),
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
              {
                id: 'deepseek-v4-flash',
                providerID: 'opencode-go',
                name: 'DeepSeek V4 Flash',
              },
              {
                id: 'ling-3.0-tiny-free',
                providerID: 'opencode',
                name: 'Ling-3.0-tiny Free',
              },
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

    it('/api/model 404（旧版 serve）→ 回退 capabilities.models 数组', async () => {
      const client = makeClient();
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

  describe('listAgents（GET /agents：opencode 原生 agent 清单）', () => {
    const execWorker = {
      id: 'w_1',
      capabilities: { execBaseUrl: 'http://worker:4198' },
    };

    it('200 → 透传 agents 数组（含 native/hidden/mode 实测字段）', async () => {
      const client = makeClient();
      const agents = [
        { name: 'build', mode: 'primary', native: true },
        { name: 'plan', mode: 'primary', native: true },
        { name: 'title', mode: 'primary', native: true, hidden: true },
        { name: 'my-agent', mode: 'primary', native: false },
      ];
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ agents }) }),
      );

      await expect(client.listAgents(execWorker)).resolves.toEqual(agents);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker:4198/agents');
      expect(init.method).toBe('GET');
      // X-Worker-Token 鉴权（与 GET /file 同规格）
      expect(
        new Headers(init.headers).get('X-Worker-Token'),
      ).toBeTruthy();
    });

    it('directory 传入 → 作为 query 参数下发（per-directory 隔离依赖它）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ agents: [] }) }),
      );

      await client.listAgents(execWorker, '/data/vteam-worker/tasks/t_1');

      const [url] = mockFetch.mock.calls[0] as [string];
      // encodeURIComponent 会把 / 转义为 %2F
      expect(decodeURIComponent(url)).toBe(
        'http://worker:4198/agents?directory=/data/vteam-worker/tasks/t_1',
      );
    });

    it('agents 字段缺失/非数组 → 返回 []（不抛错）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({}) }));
      await expect(client.listAgents(execWorker)).resolves.toEqual([]);
    });

    it('HTTP 非 2xx → 降级返回 []（对齐 listModels：列表端点不阻断页面，不抛 503）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 502 }));
      await expect(client.listAgents(execWorker)).resolves.toEqual([]);
    });

    it('网络错 → 降级返回 []（不抛错）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(client.listAgents(execWorker)).resolves.toEqual([]);
    });
  });
  describe('listTodos（GET /todos：opencode 会话 todo 步骤）', () => {
    const execWorker = {
      id: 'w_1',
      capabilities: { execBaseUrl: 'http://worker:4198' },
    };

    it('200 → 透传 todos 数组（含 content/status 实测字段）', async () => {
      const client = makeClient();
      const todos = [
        { content: '拆解任务', status: 'completed' },
        { content: '写代码', status: 'in_progress' },
      ];
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ todos }) }),
      );

      await expect(client.listTodos(execWorker, 'ses_1')).resolves.toEqual(
        todos,
      );

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker:4198/todos?sessionId=ses_1');
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('X-Worker-Token')).toBeTruthy();
    });

    it('directory 传入 → 追加 query 参数', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({ todos: [] }) }));

      await client.listTodos(execWorker, 'ses_1', '/data/vteam-worker/tasks/t_1');

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(decodeURIComponent(url)).toBe(
        'http://worker:4198/todos?sessionId=ses_1&directory=/data/vteam-worker/tasks/t_1',
      );
    });

    it('todos 缺失/非数组 → []；HTTP 非 2xx/网络错 → []（列表端点不阻断）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({}) }));
      await expect(client.listTodos(execWorker, 'ses_1')).resolves.toEqual([]);

      mockFetch.mockResolvedValue(response({ ok: false, status: 502 }));
      await expect(client.listTodos(execWorker, 'ses_1')).resolves.toEqual([]);

      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(client.listTodos(execWorker, 'ses_1')).resolves.toEqual([]);
    });
  });


  describe('listPlanFiles / writePlanFile（计划文档同步：GET /plan-files + POST /plan-file）', () => {
    const execWorker = {
      id: 'w_1',
      capabilities: { execBaseUrl: 'http://worker:4198' },
    };

    it('listPlanFiles 200 → 透传 files 数组（含正文，Modal 免二次请求）', async () => {
      const client = makeClient();
      const files = [
        {
          name: 'plan.md',
          updatedAt: '2026-03-01T00:00:00.000Z',
          size: 10,
          content: '# 计划',
          truncated: false,
        },
      ];
      mockFetch.mockResolvedValue(response({ json: async () => ({ files }) }));

      await expect(
        client.listPlanFiles(execWorker, '/data/vteam-worker/tasks/t_1'),
      ).resolves.toEqual(files);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(decodeURIComponent(url)).toBe(
        'http://worker:4198/plan-files?directory=/data/vteam-worker/tasks/t_1',
      );
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('X-Worker-Token')).toBeTruthy();
    });

    it('listPlanFiles 未传 directory → 不带 query（worker 侧回落 workDir）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({ files: [] }) }));

      await client.listPlanFiles(execWorker);

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://worker:4198/plan-files');
    });

    it('listPlanFiles files 缺失/非数组、HTTP 非 2xx、网络错 → []（列表端点不阻断页面）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({}) }));
      await expect(client.listPlanFiles(execWorker)).resolves.toEqual([]);

      mockFetch.mockResolvedValue(response({ ok: false, status: 500 }));
      await expect(client.listPlanFiles(execWorker)).resolves.toEqual([]);

      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(client.listPlanFiles(execWorker)).resolves.toEqual([]);
    });

    it('writePlanFile 200 → 回传 name/updatedAt，POST 带 directory/name/content', async () => {
      const client = makeClient();
      // 实现用 res.text() 读体（错误体可能非 JSON，读文本才能保留原文），故这里 mock text。
      mockFetch.mockResolvedValue(
        response({
          text: async () => JSON.stringify({ name: 'up.md', updatedAt: '2026-03-02T00:00:00.000Z' }),
        }),
      );

      await expect(
        client.writePlanFile(execWorker, {
          directory: '/data/vteam-worker/tasks/t_1',
          name: 'up.md',
          content: '# 正文',
        }),
      ).resolves.toEqual({ name: 'up.md', updatedAt: '2026-03-02T00:00:00.000Z' });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker:4198/plan-file');
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        directory: '/data/vteam-worker/tasks/t_1',
        name: 'up.md',
        content: '# 正文',
      });
    });

    it('writePlanFile 非 2xx → 抛 WorkerUnavailableException 并带上 worker 侧错误文本（写路径不静默）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: 'name 非法：必须是纯文件名' }),
        }),
      );

      await expect(
        client.writePlanFile(execWorker, {
          directory: '/d',
          name: '../x.md',
          content: 'x',
        }),
      ).rejects.toThrow(/name 非法：必须是纯文件名/);
    });

    it('writePlanFile 响应体缺字段 → 用入参 name + 当前时间兜底（不返回 undefined）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ text: async () => '{}' }));

      const out = await client.writePlanFile(execWorker, {
        directory: '/d',
        name: 'fallback.md',
        content: 'x',
      });

      expect(out.name).toBe('fallback.md');
      expect(typeof out.updatedAt).toBe('string');
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

      await expect(client.getMessages(worker, 'ses_1')).resolves.toEqual(
        messages,
      );

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

      await client.isHealthy({
        id: 'w_1',
        capabilities: { baseUrl: 'http://10.0.0.5:4300' },
      });

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
      const abortError = new DOMException(
        'The operation was aborted.',
        'AbortError',
      );
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
    describe('setOmoConfig 错误映射（4xx vs 5xx）', () => {
    const execWorker = { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } };

    it('400（请求不合法）→ 原样 BadRequestException，不误报为 worker 不可用', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ error: '本 worker 镜像未内置 OmO，无法开启' }),
        }),
      );
      // 关键：错误信息保留 worker 侧原因，且**不是** WorkerUnavailableException
      //（否则前端会提示"节点不可用"，把用户引去查节点状态）
      const err = await client.setOmoConfig(execWorker, {}, true).catch((e) => e);
      expect(String(err.message)).toMatch(/未内置 OmO/);
      expect(err).not.toBeInstanceOf(WorkerUnavailableException);
      expect(err).toBeInstanceOf(BadRequestException);
    });

    it('500（worker 故障）→ WorkerUnavailableException（503）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({ ok: false, status: 500, text: async () => 'boom' }),
      );
      await expect(client.setOmoConfig(execWorker, { a: 'b/c' })).rejects.toThrow(
        WorkerUnavailableException,
      );
    });
  });

});
