import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_EXEC_PORT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SECRET_COMMAND_TIMEOUT_MS,
  isWorkerRateLimited,
  isWorkerSessionInvalid,
  SECRET_COMMAND_REQUEST_TIMEOUT_SLACK_MS,
  WorkerClient,
  WorkerFileNotFoundException,
  WorkerUnavailableException,
} from './worker.client';
import type {
  CreateSessionRequestPayload as ServerCreateSessionRequestPayload,
  CreateSessionResponsePayload as ServerCreateSessionResponsePayload,
  SessionAbortResponsePayload as ServerSessionAbortResponsePayload,
  SessionMessagesQuery as ServerSessionMessagesQuery,
  SessionMessagesResponsePayload as ServerSessionMessagesResponsePayload,
  SessionPromptRequestPayload as ServerSessionPromptRequestPayload,
  SessionPromptResponsePayload as ServerSessionPromptResponsePayload,
  WorkerModelInfo as ServerWorkerModelInfo,
  WorkerModelsResponsePayload as ServerWorkerModelsResponsePayload,
} from './worker-session-protocol';
import type {
  CreateSessionRequestPayload as WorkerCreateSessionRequestPayload,
  CreateSessionResponsePayload as WorkerCreateSessionResponsePayload,
  SessionAbortResponsePayload as WorkerSessionAbortResponsePayload,
  SessionMessagesQuery as WorkerSessionMessagesQuery,
  SessionMessagesResponsePayload as WorkerSessionMessagesResponsePayload,
  SessionPromptRequestPayload as WorkerSessionPromptRequestPayload,
  SessionPromptResponsePayload as WorkerSessionPromptResponsePayload,
  WorkerModelInfo as WorkerWorkerModelInfo,
  WorkerModelsResponsePayload as WorkerWorkerModelsResponsePayload,
} from '../../../worker/src/protocol/worker-protocol';

/** mock global.fetch（Node 18+ 全局 fetch；worker.client.ts 裸 fetch 调 worker 执行端点）。 */
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

/** 构造 WorkerClient（公开字段可再覆盖）。 */
function makeClient() {
  const config = {
    get: jest.fn((key: string, def?: unknown) => def),
  } as unknown as ConfigService;
  return new WorkerClient(config);
}

/**
 * worker 行最小形态（capabilities 无 execPort/execBaseUrl → 走 WORKER_BASE_URL 回退）。
 *
 * ⚠️ T18：控制面**只**调 worker 执行端点（不再是 opencode serve），故这里的 URL 断言
 * 一律指向执行端点（默认 `http://localhost:4198`）。
 */
const worker = { id: 'w_00001', capabilities: {} };

/** 执行端点 worker（capabilities.execBaseUrl 优先）。 */
const execWorker = {
  id: 'w_1',
  capabilities: { execBaseUrl: 'http://worker:4198' },
};

describe('WorkerClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('createSession（POST /sessions：建会话走 worker 执行端点）', () => {
    it('POST /sessions 200 + {sessionId} → 返回 {sessionId}（vteam 协议拼写归一）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ sessionId: 'ses_abc' }) }),
      );

      await expect(client.createSession(worker)).resolves.toEqual({
        sessionId: 'ses_abc',
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://localhost:${DEFAULT_EXEC_PORT}/sessions`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({});
      // 执行端点鉴权：X-Worker-Token（不再有 opencode 的 Basic Auth）
      expect(new Headers(init.headers).get('X-Worker-Token')).toBe(
        'dev-worker-token',
      );
    });

    it('传入 model → 进 body（worker 侧按 providerID/modelID 选模型）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ sessionId: 'ses_1' }) }),
      );

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

    it('响应缺 sessionId → 抛 WorkerUnavailableException', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => ({ foo: 1 }) }));

      await expect(client.createSession(worker)).rejects.toThrow(
        WorkerUnavailableException,
      );
    });
  });

  describe('promptSession（POST /sessions/:id/prompt：下发提示走 worker 执行端点）', () => {
    it('200 → 回带收件条目 id + 实际生效的投递策略', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            sessionId: 'ses_1',
            messageId: 'msg_inbox_1',
            delivery: 'steer',
            admitted: true,
          }),
        }),
      );

      await expect(
        client.promptSession(worker, 'ses_1', { prompt: 'hello' }),
      ).resolves.toEqual({
        sessionId: 'ses_1',
        messageId: 'msg_inbox_1',
        delivery: 'steer',
        admitted: true,
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `http://localhost:${DEFAULT_EXEC_PORT}/sessions/ses_1/prompt`,
      );
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        prompt: 'hello',
        delivery: 'steer',
      });
      expect(new Headers(init.headers).get('X-Worker-Token')).toBe(
        'dev-worker-token',
      );
    });

    it('请求体是 vteam 形状 {prompt, model, agent, directory, system, delivery}（不再是 opencode 的 parts）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({ sessionId: 'ses_1', admitted: true }),
        }),
      );

      await client.promptSession(worker, 'ses_1', {
        prompt: [{ type: 'text', text: 'hi' }],
        model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
        agent: 'build',
        directory: '/data/git-project/vteam',
        system: '系统提示',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        prompt: [{ type: 'text', text: 'hi' }],
        model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
        agent: 'build',
        directory: '/data/git-project/vteam',
        system: '系统提示',
        delivery: 'steer',
      });
    });

    it('在飞注入（inFlight）→ 强制 delivery:"steer"（插队打断当前轮）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({ sessionId: 'ses_1', admitted: true }),
        }),
      );

      await client.promptSession(worker, 'ses_1', {
        prompt: '注入',
        inFlight: true,
        delivery: 'queue',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body)).delivery).toBe('steer');
    });

    it('常规下发也显式带 delivery（不依赖被驱动端默认值）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({ sessionId: 'ses_1', admitted: true }),
        }),
      );

      await client.promptSession(worker, 'ses_1', { prompt: 'x' });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body)).delivery).toBe('steer');
    });

    it('HTTP 500 → WorkerUnavailableException', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 500 }));

      await expect(
        client.promptSession(worker, 'ses_1', { prompt: 'x' }),
      ).rejects.toMatchObject({ workerId: 'w_00001' });
    });
  });

  describe('execute（方案 A：worker 执行端点 POST /execute）', () => {
    const execWorkerWithPort = {
      id: 'w_1',
      capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
    };

    it('202 → resolve；URL = worker 公布主机 + execPort 拼接，body 含完整 payload', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 202 }));

      await expect(
        client.execute(execWorkerWithPort, {
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

      await client.execute(execWorker, {
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

    it('worker 未公布主机 → WORKER_BASE_URL 回退 origin 拼接 execPort', async () => {
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
    const execWorkerWithPort = {
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
        client.fetchFile(execWorkerWithPort, '/tmp/opencode/test_file.txt'),
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
          return def;
        }),
      } as unknown as ConfigService;
      const client = new WorkerClient(config);
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response);

      await client.fetchFile(execWorkerWithPort, '/tmp/x.txt');

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

      await client.fetchFile(execWorker, '/tmp/x.txt');

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://worker:4198/file?path=%2Ftmp%2Fx.txt');
    });

    it('HTTP 404（worker 上没有这个文件）→ WorkerFileNotFoundException（404，**不是**「worker 不可用」）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          ok: false,
          status: 404,
          text: jest.fn(async () =>
            JSON.stringify({ error: '文件不存在: /tmp/missing.txt' }),
          ),
        }),
      );

      const err = await client
        .fetchFile(execWorkerWithPort, '/tmp/missing.txt')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WorkerFileNotFoundException);
      // 状态语义 = 找不到（404），不是节点故障（503）
      expect((err as WorkerUnavailableException).getStatus()).toBe(404);
      expect((err as WorkerUnavailableException).httpStatus).toBe(404);
      expect((err as WorkerUnavailableException).code).toBe('FILE_NOT_FOUND');
      expect((err as WorkerUnavailableException).message).not.toContain(
        '不可用',
      );
      expect((err as WorkerUnavailableException).message).toContain(
        '/tmp/missing.txt',
      );
      // 仍是 WorkerUnavailableException 的子类：platform-mcp 的多候选路径回退
      // 按 `instanceof WorkerUnavailableException && httpStatus === 404` 换下一个候选
      expect(err).toBeInstanceOf(WorkerUnavailableException);
    });

    it('fetch 抛错（连接失败）→ WorkerUnavailableException（503，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(
        client.fetchFile(execWorkerWithPort, '/tmp/x.txt'),
      ).rejects.toMatchObject({
        workerId: 'w_1',
        status: 503,
      });
    });

    it('worker 真不可达 → 仍是「worker 不可用」（503），与 404 区分开', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      const err = await client
        .fetchFile(execWorkerWithPort, '/tmp/x.txt')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WorkerUnavailableException);
      expect(err).not.toBeInstanceOf(WorkerFileNotFoundException);
      expect((err as WorkerUnavailableException).getStatus()).toBe(503);
      expect((err as WorkerUnavailableException).message).toContain('不可用');
    });
  });

  describe('questionReply / permissionReply（POST /question-reply 转发用户回复）', () => {
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

  describe('runSecretCommand（POST /secret-command 显式超时客户端）', () => {
    /** 哨兵 secret：只允许出现在测试代码与请求体里，绝不能出现在日志/异常消息。 */
    const SENTINEL = 's3cr3t-A9f';
    const okPayload = {
      requestId: 'scr_1',
      status: 'succeeded',
      exitCode: 0,
      durationMs: 12,
      stdout: 'done',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    };

    it('POST /secret-command：exec 端点 URL + X-Worker-Token + Content-Type + 完整请求体', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => okPayload }));

      await client.runSecretCommand(execWorker, {
        requestId: 'scr_1',
        commandTemplate: 'echo {{TOKEN}}',
        secrets: { TOKEN: SENTINEL },
        cwd: 'tasks/t_1',
        timeoutMs: 300_000,
        taskId: 't_1',
        sessionId: 'ses_1',
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker:4198/secret-command');
      expect(init.method).toBe('POST');
      const headers = init.headers as Headers;
      expect(headers.get('X-Worker-Token')).toBe('dev-worker-token');
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(String(init.body))).toEqual({
        requestId: 'scr_1',
        commandTemplate: 'echo {{TOKEN}}',
        secrets: { TOKEN: SENTINEL },
        cwd: 'tasks/t_1',
        timeoutMs: 300_000,
        taskId: 't_1',
        sessionId: 'ses_1',
      });
    });

    it('命令 300s → 实际请求超时 305000ms（> 默认 60000，绝不回落默认 60s）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => okPayload }));
      const spy = jest.spyOn(globalThis, 'setTimeout');
      try {
        await client.runSecretCommand(execWorker, {
          requestId: 'scr_1',
          commandTemplate: 'sleep 300',
          secrets: {},
          timeoutMs: 300_000,
        });
        const delays = (spy.mock.calls as unknown[][]).map((c) => Number(c[1]));
        // 断言真实生效的超时参数（不是调用次数）：命令超时 + 5000ms 余量
        expect(delays).toContain(
          300_000 + SECRET_COMMAND_REQUEST_TIMEOUT_SLACK_MS,
        );
        expect(delays).toContain(305_000);
        expect(delays).not.toContain(DEFAULT_REQUEST_TIMEOUT_MS);
        expect(Math.max(...delays)).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
      } finally {
        spy.mockRestore();
      }
    });

    it('缺省 timeoutMs → 请求超时 65000ms（对齐 worker 默认 60000 + 余量，仍 > 默认 60000）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ json: async () => okPayload }));
      const spy = jest.spyOn(globalThis, 'setTimeout');
      try {
        await client.runSecretCommand(execWorker, {
          requestId: 'scr_1',
          commandTemplate: 'echo hi',
          secrets: {},
        });
        const delays = (spy.mock.calls as unknown[][]).map((c) => Number(c[1]));
        expect(delays).toContain(
          DEFAULT_SECRET_COMMAND_TIMEOUT_MS +
            SECRET_COMMAND_REQUEST_TIMEOUT_SLACK_MS,
        );
        expect(delays).toContain(65_000);
        expect(delays).not.toContain(DEFAULT_REQUEST_TIMEOUT_MS);
      } finally {
        spy.mockRestore();
      }
    });

    it('请求超时（abort）→ WorkerUnavailableException，消息带真实超时 305000ms（非默认 60000 文案）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(
        new DOMException('The operation was aborted.', 'AbortError'),
      );

      const err = await client
        .runSecretCommand(execWorker, {
          requestId: 'scr_1',
          commandTemplate: 'sleep 300',
          secrets: {},
          timeoutMs: 300_000,
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(WorkerUnavailableException);
      expect(err.workerId).toBe('w_1');
      expect(err.status).toBe(503);
      expect(String(err.message)).toContain('请求超时（>305000ms）');
    });

    it('200 → 返回类型化结果（status/exitCode/durationMs/双流截断/requestId）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            ...okPayload,
            status: 'failed',
            exitCode: 1,
            stderr: 'boom',
            stdoutTruncated: true,
          }),
        }),
      );

      await expect(
        client.runSecretCommand(execWorker, {
          requestId: 'scr_1',
          commandTemplate: 'false',
          secrets: {},
          timeoutMs: 300_000,
        }),
      ).resolves.toEqual({
        requestId: 'scr_1',
        status: 'failed',
        exitCode: 1,
        durationMs: 12,
        stdout: 'done',
        stderr: 'boom',
        stdoutTruncated: true,
        stderrTruncated: false,
      });
    });

    it('HTTP 非 2xx（500/400/409）→ WorkerUnavailableException，httpStatus 保留原码且异常不含响应体', async () => {
      const client = makeClient();

      for (const status of [500, 400, 409]) {
        mockFetch.mockResolvedValue(
          response({
            ok: false,
            status,
            // 响应体带哨兵：异常消息不得回显它（连响应体都不读）
            json: async () => ({ error: `boom ${SENTINEL}` }),
            text: async () => `boom ${SENTINEL}`,
          }),
        );
        const err = await client
          .runSecretCommand(execWorker, {
            requestId: 'scr_1',
            commandTemplate: 'echo {{TOKEN}}',
            secrets: { TOKEN: SENTINEL },
            timeoutMs: 300_000,
          })
          .catch((e) => e);
        expect(err).toBeInstanceOf(WorkerUnavailableException);
        expect(err.workerId).toBe('w_1');
        expect(err.status).toBe(503);
        expect(err.httpStatus).toBe(status);
        expect(String(err.message)).toContain(`secret-command HTTP ${status}`);
        expect(String(err.message)).not.toContain(SENTINEL);
      }
    });

    it('200 但响应非 JSON → WorkerUnavailableException（坏输入归一，不当成功）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({ json: async () => Promise.reject(new Error('bad json')) }),
      );

      const err = await client
        .runSecretCommand(execWorker, {
          requestId: 'scr_1',
          commandTemplate: 'echo hi',
          secrets: {},
          timeoutMs: 300_000,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(WorkerUnavailableException);
      expect(err.status).toBe(503);
    });

    it('网络失败（ECONNREFUSED）→ WorkerUnavailableException（503，带 workerId）', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(
        client.runSecretCommand(execWorker, {
          requestId: 'scr_1',
          commandTemplate: 'echo hi',
          secrets: {},
          timeoutMs: 300_000,
        }),
      ).rejects.toMatchObject({ workerId: 'w_1', status: 503 });
    });

    it('成功与失败路径都不把请求体/secret 写进日志（sentinel 0 命中）', async () => {
      const client = makeClient();
      const methods = ['log', 'error', 'warn', 'debug', 'verbose'] as const;
      const spies = methods.map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      );
      try {
        mockFetch.mockResolvedValue(response({ json: async () => okPayload }));
        await client.runSecretCommand(execWorker, {
          requestId: 'scr_1',
          commandTemplate: 'echo {{TOKEN}}',
          secrets: { TOKEN: SENTINEL },
          timeoutMs: 300_000,
        });
        mockFetch.mockResolvedValue(
          response({
            ok: false,
            status: 500,
            json: async () => ({ error: `boom ${SENTINEL}` }),
            text: async () => `boom ${SENTINEL}`,
          }),
        );
        const err = await client
          .runSecretCommand(execWorker, {
            requestId: 'scr_2',
            commandTemplate: 'echo {{TOKEN}}',
            secrets: { TOKEN: SENTINEL },
            timeoutMs: 300_000,
          })
          .catch((e) => e);

        const logged = spies
          .flatMap((s) => s.mock.calls.flat())
          .map(String)
          .join('\n');
        expect(logged).not.toContain(SENTINEL);
        expect(String(err.message)).not.toContain(SENTINEL);
        expect(err).toBeInstanceOf(WorkerUnavailableException);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });

  describe('listModels（GET /models：模型目录走 worker 执行端点）', () => {
    it('GET /models 200 → 映射为 {id: providerID/modelID} 列表', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            models: [
              {
                id: 'opencode-go/deepseek-v4-flash',
                name: 'DeepSeek V4 Flash',
                providerID: 'opencode-go',
                modelID: 'deepseek-v4-flash',
                status: 'active',
              },
              {
                id: 'opencode/ling-3.0-tiny-free',
                name: 'Ling-3.0-tiny Free',
                providerID: 'opencode',
                modelID: 'ling-3.0-tiny-free',
                status: 'active',
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
          status: 'active',
        },
        {
          id: 'opencode/ling-3.0-tiny-free',
          name: 'Ling-3.0-tiny Free',
          providerID: 'opencode',
          modelID: 'ling-3.0-tiny-free',
          status: 'active',
        },
      ]);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://localhost:${DEFAULT_EXEC_PORT}/models`);
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('X-Worker-Token')).toBe(
        'dev-worker-token',
      );
    });

    it('GET /models：响应信封只有 models 一个键（与双写契约一致；拼错的键不被读取）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            models: [
              {
                id: 'opencode-go/deepseek-v4-flash',
                name: 'DeepSeek V4 Flash',
                providerID: 'opencode-go',
                modelID: 'deepseek-v4-flash',
              },
            ],
            // 反向：worker 若回 {model:[...]}（拼写漂移），控制面**读不到** ⇒ 降级
            model: [{ id: 'wrong-key' }],
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
      ]);
    });

    it('F2 MINOR：缺省 id/providerID/modelID → id 兜底为 /，不产出 undefined/undefined（与 worker 侧统一）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            models: [{ name: 'Bare Model' }],
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

    it('worker 端点 404（旧版 worker 无该端点）→ 回退 capabilities.models 数组', async () => {
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

  describe('listIntegrations（GET /integrations：opencode 集成注册表走 worker 执行端点）', () => {
    it('GET /integrations 200 → 映射 {id,name,apiKey,envNames?}（注册表 = 可配置 provider 全集）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            integrations: [
              {
                id: 'opencode-go',
                name: 'OpenCode Go',
                apiKey: true,
                envNames: ['OPENCODE_API_KEY'],
              },
              { id: '302ai', name: '302.AI', apiKey: true },
            ],
          }),
        }),
      );

      await expect(client.listIntegrations(worker)).resolves.toEqual([
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          apiKey: true,
          envNames: ['OPENCODE_API_KEY'],
        },
        { id: '302ai', name: '302.AI', apiKey: true },
      ]);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://localhost:${DEFAULT_EXEC_PORT}/integrations`);
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('X-Worker-Token')).toBe(
        'dev-worker-token',
      );
    });

    it('响应信封只有 integrations 一个键（拼错的键不被读取 → 降级 []）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            // 反向：worker 若回 {integration:[...]}（拼写漂移），控制面读不到 ⇒ 降级
            integration: [{ id: 'opencode-go' }],
          }),
        }),
      );

      await expect(client.listIntegrations(worker)).resolves.toEqual([]);
    });

    it('归一：纯空白 id 丢弃、去空白；缺 name 回退 id；apiKey 布尔化；空 envNames 不落键（无 secret）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            integrations: [
              { id: '  ', name: 'Blank ID' },
              { id: 'env-only', apiKey: false, envNames: [] },
              {
                id: ' opencode-go ',
                name: ' OpenCode Go ',
                apiKey: 1,
                envNames: ['OPENCODE_API_KEY'],
              },
              { name: 'No ID' },
            ],
          }),
        }),
      );

      const items = await client.listIntegrations(worker);

      expect(items).toEqual([
        { id: 'env-only', name: 'env-only', apiKey: false },
        {
          id: 'opencode-go',
          name: 'OpenCode Go',
          apiKey: true,
          envNames: ['OPENCODE_API_KEY'],
        },
      ]);
      // 输出只含声明字段：不得出现任何明文 key（apiKey 是「可配」声明，envNames 是变量名）
      expect(JSON.stringify(items)).not.toMatch(/sk-[A-Za-z0-9]/);
    });

    it('worker 端点 500 → 降级返回 []（列表端点不抛错，调用方以 degraded 提示）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 500 }));

      await expect(client.listIntegrations(worker)).resolves.toEqual([]);
    });

    it('网络错误（ECONNREFUSED）→ 降级返回 []', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('ECONNREFUSED'));

      await expect(client.listIntegrations(worker)).resolves.toEqual([]);
    });
  });

  describe('listAgents（GET /agents：opencode 原生 agent 清单）', () => {
    it('200 → 透传 agents 数组（含 native/hidden/mode 实测字段）', async () => {
      const client = makeClient();
      const agents = [
        { name: 'build', mode: 'primary', native: true },
        { name: 'plan', mode: 'primary', native: true },
        { name: 'title', mode: 'primary', native: true, hidden: true },
        { name: 'my-agent', mode: 'primary', native: false },
      ];
      mockFetch.mockResolvedValue(response({ json: async () => ({ agents }) }));

      await expect(client.listAgents(execWorker)).resolves.toEqual(agents);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://worker:4198/agents');
      expect(init.method).toBe('GET');
      // X-Worker-Token 鉴权（与 GET /file 同规格）
      expect(new Headers(init.headers).get('X-Worker-Token')).toBeTruthy();
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
    it('200 → 透传 todos 数组（含 content/status 实测字段）', async () => {
      const client = makeClient();
      const todos = [
        { content: '拆解任务', status: 'completed' },
        { content: '写代码', status: 'in_progress' },
      ];
      mockFetch.mockResolvedValue(response({ json: async () => ({ todos }) }));

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
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ todos: [] }) }),
      );

      await client.listTodos(
        execWorker,
        'ses_1',
        '/data/vteam-worker/tasks/t_1',
      );

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
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ files: [] }) }),
      );

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
          text: async () =>
            JSON.stringify({
              name: 'up.md',
              updatedAt: '2026-03-02T00:00:00.000Z',
            }),
        }),
      );

      await expect(
        client.writePlanFile(execWorker, {
          directory: '/data/vteam-worker/tasks/t_1',
          name: 'up.md',
          content: '# 正文',
        }),
      ).resolves.toEqual({
        name: 'up.md',
        updatedAt: '2026-03-02T00:00:00.000Z',
      });

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
          text: async () =>
            JSON.stringify({ error: 'name 非法：必须是纯文件名' }),
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

  describe('abort（POST /sessions/:id/abort）', () => {
    it('200 → 回带 sessionId + interrupted', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({ sessionId: 'ses_1', interrupted: true }),
        }),
      );

      await expect(client.abort(worker, 'ses_1')).resolves.toEqual({
        sessionId: 'ses_1',
        interrupted: true,
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `http://localhost:${DEFAULT_EXEC_PORT}/sessions/ses_1/abort`,
      );
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('X-Worker-Token')).toBe(
        'dev-worker-token',
      );
    });

    it('HTTP 非 2xx → WorkerUnavailableException', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: false, status: 500 }));

      await expect(client.abort(worker, 'ses_1')).rejects.toThrow(
        WorkerUnavailableException,
      );
    });
  });

  describe('getMessages（GET /sessions/:id/messages）', () => {
    it('200 + {sessionId, messages} → 返回消息数组', async () => {
      const client = makeClient();
      const messages = [
        { info: { id: 'msg_1', role: 'assistant' }, parts: [] },
      ];
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ sessionId: 'ses_1', messages }) }),
      );

      await expect(client.getMessages(worker, 'ses_1')).resolves.toEqual(
        messages,
      );

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(
        `http://localhost:${DEFAULT_EXEC_PORT}/sessions/ses_1/messages`,
      );
    });

    it('分页参数 → 作为 query 下发（limit/order/cursor）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ sessionId: 'ses_1', messages: [] }) }),
      );

      await client.getMessages(worker, 'ses_1', {
        limit: 20,
        order: 'asc',
        cursor: 'cur_1',
      });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(decodeURIComponent(url)).toBe(
        `http://localhost:${DEFAULT_EXEC_PORT}/sessions/ses_1/messages?limit=20&order=asc&cursor=cur_1`,
      );
    });

    it('fetch 抛错 → WorkerUnavailableException', async () => {
      const client = makeClient();
      mockFetch.mockRejectedValue(new TypeError('socket hang up'));

      await expect(client.getMessages(worker, 'ses_1')).rejects.toMatchObject({
        workerId: 'w_00001',
      });
    });
  });

  describe('错误语义：会话失效（404）与限流（429）必须可区分', () => {
    it('404 + code:SESSION_NOT_FOUND → 会话失效（httpStatus 404 + code SESSION_NOT_FOUND）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          ok: false,
          status: 404,
          text: async () =>
            JSON.stringify({
              error: 'session not found',
              code: 'SESSION_NOT_FOUND',
            }),
        }),
      );

      const err = await client.getMessages(worker, 'ses_1').catch((e) => e);

      expect(err).toBeInstanceOf(WorkerUnavailableException);
      expect(err.httpStatus).toBe(404);
      expect(err.code).toBe('SESSION_NOT_FOUND');
      expect(isWorkerSessionInvalid(err)).toBe(true);
      expect(isWorkerRateLimited(err)).toBe(false);
    });

    it('429 + code:RATE_LIMITED → 限流（httpStatus 429 + code RATE_LIMITED）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          ok: false,
          status: 429,
          text: async () =>
            JSON.stringify({ error: 'rate limited', code: 'RATE_LIMITED' }),
        }),
      );

      const err = await client
        .promptSession(worker, 'ses_1', { prompt: 'x' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(WorkerUnavailableException);
      expect(err.httpStatus).toBe(429);
      expect(err.code).toBe('RATE_LIMITED');
      expect(isWorkerRateLimited(err)).toBe(true);
      expect(isWorkerSessionInvalid(err)).toBe(false);
    });

    it('404 但**没有** SESSION_NOT_FOUND 码（旧版 worker 无该端点）→ 不误判为会话失效', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          ok: false,
          status: 404,
          text: async () =>
            JSON.stringify({ error: '未支持的路径: /sessions/ses_1/messages' }),
        }),
      );

      const err = await client.getMessages(worker, 'ses_1').catch((e) => e);

      expect(err.httpStatus).toBe(404);
      expect(err.code).toBe('WORKER_UNAVAILABLE');
      expect(isWorkerSessionInvalid(err)).toBe(false);
    });
  });

  describe('isHealthy（探活 worker 执行端点）', () => {
    it('GET /models 200 → true', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response({ ok: true, status: 200 }));

      await expect(client.isHealthy(worker)).resolves.toBe(true);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(`http://localhost:${DEFAULT_EXEC_PORT}/models`);
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
    it('capabilities.baseUrl 的**主机**用于发现执行端点（serve 端口不被使用）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response());

      await client.isHealthy({
        id: 'w_1',
        capabilities: { baseUrl: 'http://10.0.0.5:4300', execPort: 4198 },
      });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe('http://10.0.0.5:4198/models');
    });

    it('capabilities.port（serve 端口）**不再**被使用（控制面不连 opencode serve）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response());

      await client.isHealthy({
        id: 'w_1',
        capabilities: { port: 4321, execPort: 4198 },
      });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(`http://localhost:${DEFAULT_EXEC_PORT}/models`);
    });

    it('opencode 的 Basic Auth 不再注入（控制面只带 X-Worker-Token）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(response());

      await client.isHealthy(worker);

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Headers;
      expect(headers.get('Authorization')).toBeNull();
      expect(headers.get('X-Worker-Token')).toBeTruthy();
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
      const err = await client
        .setOmoConfig(execWorker, {}, true)
        .catch((e) => e);
      expect(String(err.message)).toMatch(/未内置 OmO/);
      expect(err).not.toBeInstanceOf(WorkerUnavailableException);
      expect(err).toBeInstanceOf(BadRequestException);
    });

    it('500（worker 故障）→ WorkerUnavailableException（503）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({ ok: false, status: 500, text: async () => 'boom' }),
      );
      await expect(
        client.setOmoConfig(execWorker, { a: 'b/c' }),
      ).rejects.toThrow(WorkerUnavailableException);
    });
  });

  /**
   * T21 双端契约一致性（五个会话/模型端点）。
   *
   * 协议类型在仓库里是**双写**的：worker 侧 `worker/src/protocol/worker-protocol.ts`
   * 与 server 侧 `server/src/workers/worker-session-protocol.ts`。控制面按自己那份读字段，
   * 一旦两侧漂移就是**静默丢字段**（`sessionId` vs `sessionID` ⇒ 会话 id 丢失）。
   *
   * - **编译期**：两侧副本逐类型相等（`Equals<>` 判定；任一字段漂移 ⇒ 编译失败）。
   * - **运行时**：客户端实际发出的 body 键集与实际读取的响应键集必须与协议一致
   *   （含**反向**断言：拼错的键名不被读取 ⇒ 漂移会立刻暴露，而不是静默降级）。
   */
  describe('T21 双端契约一致性（五个会话/模型端点）', () => {
    /** 类型恒等判定（字段名/可选性/类型任一不同即 false）。 */
    type Equals<X, Y> =
      (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
        ? true
        : false;
    type Expect<T extends true> = T;

    type _E1 = Expect<
      Equals<
        ServerCreateSessionRequestPayload,
        WorkerCreateSessionRequestPayload
      >
    >;
    type _E2 = Expect<
      Equals<
        ServerCreateSessionResponsePayload,
        WorkerCreateSessionResponsePayload
      >
    >;
    type _E3 = Expect<
      Equals<
        ServerSessionPromptRequestPayload,
        WorkerSessionPromptRequestPayload
      >
    >;
    type _E4 = Expect<
      Equals<
        ServerSessionPromptResponsePayload,
        WorkerSessionPromptResponsePayload
      >
    >;
    type _E5 = Expect<
      Equals<
        ServerSessionAbortResponsePayload,
        WorkerSessionAbortResponsePayload
      >
    >;
    type _E6 = Expect<
      Equals<ServerSessionMessagesQuery, WorkerSessionMessagesQuery>
    >;
    type _E7 = Expect<
      Equals<
        ServerSessionMessagesResponsePayload,
        WorkerSessionMessagesResponsePayload
      >
    >;
    type _E8 = Expect<Equals<ServerWorkerModelInfo, WorkerWorkerModelInfo>>;
    type _E9 = Expect<
      Equals<
        ServerWorkerModelsResponsePayload,
        WorkerWorkerModelsResponsePayload
      >
    >;

    it('两侧协议副本逐类型相等（编译期钉死；Equals<> 为 false 时本组编译失败）', () => {
      const createSessionEqual: true = true as Equals<
        ServerCreateSessionRequestPayload,
        WorkerCreateSessionRequestPayload
      >;
      const promptEqual: true = true as Equals<
        ServerSessionPromptRequestPayload,
        WorkerSessionPromptRequestPayload
      >;
      const promptResponseEqual: true = true as Equals<
        ServerSessionPromptResponsePayload,
        WorkerSessionPromptResponsePayload
      >;
      const abortEqual: true = true as Equals<
        ServerSessionAbortResponsePayload,
        WorkerSessionAbortResponsePayload
      >;
      const messagesQueryEqual: true = true as Equals<
        ServerSessionMessagesQuery,
        WorkerSessionMessagesQuery
      >;
      const messagesResponseEqual: true = true as Equals<
        ServerSessionMessagesResponsePayload,
        WorkerSessionMessagesResponsePayload
      >;
      const modelsEqual: true = true as Equals<
        ServerWorkerModelInfo,
        WorkerWorkerModelInfo
      >;
      const modelsEnvelopeEqual: true = true as Equals<
        ServerWorkerModelsResponsePayload,
        WorkerWorkerModelsResponsePayload
      >;
      expect([
        createSessionEqual,
        promptEqual,
        promptResponseEqual,
        abortEqual,
        messagesQueryEqual,
        messagesResponseEqual,
        modelsEqual,
        modelsEnvelopeEqual,
      ]).toEqual([true, true, true, true, true, true, true, true]);
    });

    it('createSession：body 只含 model 键；响应只认 sessionId（拼错的键不被读取）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ sessionId: 'ses_1' }) }),
      );
      await client.createSession(worker, {
        providerID: 'opencode',
        modelID: 'gpt-5',
      });
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
        'model',
      ]);

      // 反向：worker 若回 {sessionID:...}（拼写漂移），控制面**读不到** ⇒ 明确报错
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ sessionID: 'ses_1' }) }),
      );
      await expect(client.createSession(worker)).rejects.toThrow(
        WorkerUnavailableException,
      );
    });

    it('promptSession：body 键集 = prompt/model/agent/directory/system/delivery；响应只认 4 个键', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            sessionId: 'ses_1',
            messageId: 'inbox_1',
            delivery: 'steer',
            admitted: true,
          }),
        }),
      );
      await client.promptSession(worker, 'ses_1', {
        prompt: 'hello',
        model: { providerID: 'opencode', modelID: 'gpt-5' },
        agent: 'build',
        directory: '/work',
        system: 'SYS',
      });
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
        'agent',
        'delivery',
        'directory',
        'model',
        'prompt',
        'system',
      ]);

      // 反向：worker 若回 {sessionID:...}（拼写漂移）⇒ 控制面回落到请求里的 sessionId
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({ sessionID: 'ses_1', admitted: true }),
        }),
      );
      await expect(
        client.promptSession(worker, 'ses_1', { prompt: 'x' }),
      ).resolves.toEqual({ sessionId: 'ses_1', admitted: true });
    });

    it('abort：无请求体；响应只认 sessionId/interrupted（interrupted 严格取 true）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({ sessionId: 'ses_1', interrupted: true }),
        }),
      );
      await expect(client.abort(worker, 'ses_1')).resolves.toEqual({
        sessionId: 'ses_1',
        interrupted: true,
      });
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBeUndefined();

      // 反向：非布尔值不算「已中断」
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({ sessionId: 'ses_1', interrupted: 'yes' }),
        }),
      );
      await expect(client.abort(worker, 'ses_1')).resolves.toEqual({
        sessionId: 'ses_1',
        interrupted: false,
      });
    });

    it('getMessages：query 键集 = limit/order/cursor；响应只认 messages（不认 v1 的 data 包装）', async () => {
      const client = makeClient();
      const messages = [
        {
          info: { id: 'msg_1', role: 'assistant' },
          parts: [{ id: 'prt_1', type: 'text', text: '你好' }],
        },
      ];
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ sessionId: 'ses_1', messages }) }),
      );
      await expect(
        client.getMessages(worker, 'ses_1', {
          limit: 20,
          order: 'asc',
          cursor: 'cur_1',
        }),
      ).resolves.toEqual(messages);
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      const query = new URL(url).searchParams;
      expect([...query.keys()].sort()).toEqual(['cursor', 'limit', 'order']);

      // 反向：被驱动端的原始包装（data）不被当成消息数组
      mockFetch.mockResolvedValue(
        response({ json: async () => ({ data: messages }) }),
      );
      await expect(client.getMessages(worker, 'ses_1')).resolves.toEqual([]);
    });

    it('listModels：响应只认 models 信封（不认被驱动端的 {location,data} 包装）', async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            models: [
              {
                id: 'opencode/gpt-5',
                name: 'GPT-5',
                providerID: 'opencode',
                modelID: 'gpt-5',
                status: 'active',
              },
            ],
          }),
        }),
      );
      await expect(client.listModels(worker)).resolves.toEqual([
        {
          id: 'opencode/gpt-5',
          name: 'GPT-5',
          providerID: 'opencode',
          modelID: 'gpt-5',
          status: 'active',
        },
      ]);

      // 反向：被驱动端的原始包装不被识别 ⇒ 降级到 capabilities（此处为空 → []）
      mockFetch.mockResolvedValue(
        response({
          json: async () => ({
            location: '/tmp',
            data: [{ id: 'opencode/gpt-5' }],
          }),
        }),
      );
      await expect(client.listModels(worker)).resolves.toEqual([]);
    });
  });
});
