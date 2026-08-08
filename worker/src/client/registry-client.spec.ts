import {
  extractCommands,
  registerWorker,
  registerWorkerWithRetry,
  sendHeartbeat,
  WORKER_TOKEN_HEADER,
} from './registry-client';

/**
 * T6 RegistryClient 测试（mock fetch，Node 18+ 全局 fetch）。
 * 覆盖：register 成功（URL/header/body/返回）/非 2xx 抛错；heartbeat 成功；
 * registerWorkerWithRetry 指数退避重试成功 / 重试耗尽抛错。
 */

const fetchMock = jest.fn();

function mockFetch(): void {
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock as unknown as typeof fetch;
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const REG_BASE = {
  serverUrl: 'http://localhost:3000/',
  workerToken: 'dev-worker-token',
  workerId: 'w_test-1',
  workerName: 'test-worker',
  opencodeVersion: '1.18.15',
  capabilities: { maxInstances: 1, skills: [], tools: ['git_clone'] },
};

describe('registerWorker（POST /api/v1/workers/register）', () => {
  beforeEach(mockFetch);

  it('成功：URL 对齐 /api/v1/workers/register，X-Worker-Token header 与 body 字段完整', async () => {
    const serverResp = {
      workerId: 'w_test-1',
      heartbeatIntervalMs: 10_000,
      serverTime: '2026-08-08T00:00:00.000Z',
    };
    fetchMock.mockResolvedValue(okJson(serverResp));

    const result = await registerWorker(REG_BASE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/v1/workers/register');
    expect((init.headers as Record<string, string>)[WORKER_TOKEN_HEADER]).toBe('dev-worker-token');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      workerId: 'w_test-1',
      name: 'test-worker',
      opencodeVersion: '1.18.15',
      capabilities: { maxInstances: 1, skills: [], tools: ['git_clone'] },
      load: { instances: 0 },
    });
    expect(result).toEqual(serverResp);
  });

  it('serverUrl 尾斜杠容忍（不产生 // 双斜杠）', async () => {
    fetchMock.mockResolvedValue(okJson({ workerId: 'w', heartbeatIntervalMs: 1000, serverTime: '' }));
    await registerWorker({ ...REG_BASE, serverUrl: 'http://localhost:3000/' });
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toBe('http://localhost:3000/api/v1/workers/register');
    expect(url).not.toContain('//api');
  });

  it('非 2xx（401 token 无效）抛错', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));
    await expect(registerWorker(REG_BASE)).rejects.toThrow(/401/);
  });

  it('网络错误抛错', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(registerWorker(REG_BASE)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('sendHeartbeat（POST /api/v1/workers/:id/heartbeat）', () => {
  beforeEach(mockFetch);

  it('成功：URL 含 workerId，body 含 load/health，X-Worker-Token 生效', async () => {
    fetchMock.mockResolvedValue(okJson({ workerId: 'w_test-1', status: 'online', lastHeartbeatAt: '' }));

    await sendHeartbeat({
      serverUrl: 'http://localhost:3000',
      workerToken: 'dev-worker-token',
      workerId: 'w_test-1',
      load: { instances: 1 },
      health: 'ok',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/v1/workers/w_test-1/heartbeat');
    expect((init.headers as Record<string, string>)[WORKER_TOKEN_HEADER]).toBe('dev-worker-token');
    expect(JSON.parse(init.body as string)).toEqual({
      workerId: 'w_test-1',
      load: { instances: 1 },
      health: 'ok',
    });
  });

  it('workerId 含特殊字符时 encodeURIComponent', async () => {
    fetchMock.mockResolvedValue(okJson({}));
    await sendHeartbeat({
      serverUrl: 'http://localhost:3000',
      workerToken: 't',
      workerId: 'w a/b',
      load: { instances: 0 },
      health: 'degraded',
    });
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toBe('http://localhost:3000/api/v1/workers/w%20a%2Fb/heartbeat');
  });

  it('T8c：带 mcpStatus 时 body 携带三态快照', async () => {
    fetchMock.mockResolvedValue(
      okJson({ workerId: 'w_test-1', status: 'online', lastHeartbeatAt: '' }),
    );

    await sendHeartbeat({
      serverUrl: 'http://localhost:3000',
      workerToken: 'dev-worker-token',
      workerId: 'w_test-1',
      load: { instances: 1 },
      health: 'ok',
      mcpStatus: [
        { serverName: 'gitee-ent', status: 'connected' },
        { serverName: 'test-bad-local', status: 'failed' },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      workerId: 'w_test-1',
      load: { instances: 1 },
      health: 'ok',
      mcpStatus: [
        { serverName: 'gitee-ent', status: 'connected' },
        { serverName: 'test-bad-local', status: 'failed' },
      ],
    });
  });

  it('T8c：mcpStatus 为空数组时不携带该字段（兼容旧 server DTO 严格校验）', async () => {
    fetchMock.mockResolvedValue(okJson({}));

    await sendHeartbeat({
      serverUrl: 'http://localhost:3000',
      workerToken: 't',
      workerId: 'w_test-1',
      load: { instances: 0 },
      health: 'ok',
      mcpStatus: [],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      workerId: 'w_test-1',
      load: { instances: 0 },
      health: 'ok',
    });
  });

  it('T4a：解析响应 body 中的 commands 下行命令', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        workerId: 'w_test-1',
        status: 'online',
        lastHeartbeatAt: '2026-08-08T00:00:00Z',
        commands: [{ type: 'reload-config', resourceVersion: 'v3' }],
      }),
    );

    const result = await sendHeartbeat({
      serverUrl: 'http://localhost:3000',
      workerToken: 'dev-worker-token',
      workerId: 'w_test-1',
      load: { instances: 1 },
      health: 'ok',
    });

    expect(result).toMatchObject({
      workerId: 'w_test-1',
      status: 'online',
      lastHeartbeatAt: '2026-08-08T00:00:00Z',
    });
    expect(result.commands).toEqual([
      { type: 'reload-config', resourceVersion: 'v3' },
    ]);
  });

  it('T4a：响应无 commands 时字段缺省（兼容旧 server 不带命令）', async () => {
    fetchMock.mockResolvedValue(
      okJson({ workerId: 'w_test-1', status: 'online', lastHeartbeatAt: '' }),
    );

    const result = await sendHeartbeat({
      serverUrl: 'http://localhost:3000',
      workerToken: 'dev-worker-token',
      workerId: 'w_test-1',
      load: { instances: 0 },
      health: 'ok',
    });

    expect(result.commands).toBeUndefined();
    expect(extractCommands(result)).toEqual([]);
  });

  it('T4a：extractCommands 提取命令数组（无命令返回空数组）', async () => {
    expect(
      extractCommands({
        workerId: 'w',
        status: 'online',
        lastHeartbeatAt: '',
      }),
    ).toEqual([]);
    expect(
      extractCommands({
        workerId: 'w',
        status: 'online',
        lastHeartbeatAt: '',
        commands: [{ type: 'reload-config', resourceVersion: 'v1' }],
      }),
    ).toEqual([{ type: 'reload-config', resourceVersion: 'v1' }]);
  });
});

describe('registerWorkerWithRetry（指数退避重试，1s/2s/4s/8s... 封顶 30s）', () => {
  beforeEach(mockFetch);

  it('前 2 次失败第 3 次成功：共 3 次请求，返回注册结果', async () => {
    jest.useFakeTimers();
    try {
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce(
          okJson({ workerId: 'w_test-1', heartbeatIntervalMs: 10_000, serverTime: 'now' }),
        );

      const promise = registerWorkerWithRetry(REG_BASE, {
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
        maxRetries: 5,
      });

      // 第 1 次重试延迟 1s、第 2 次 2s
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ workerId: 'w_test-1', heartbeatIntervalMs: 10_000, serverTime: 'now' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('重试延迟按指数退避且封顶 maxDelayMs（第 4 次起 30s 封顶）', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const promise = registerWorkerWithRetry(REG_BASE, {
        baseDelayMs: 10_000,
        maxDelayMs: 30_000,
        maxRetries: 4,
      });
      // 提前挂 rejection handler（避免重试耗尽后 unhandled rejection 被 jest 误报）
      const assertion = expect(promise).rejects.toThrow(/ECONNREFUSED/);
      // 期望退避序列：10s、20s、30s(封顶)、30s(封顶)
      for (const delay of [10_000, 20_000, 30_000, 30_000]) {
        await jest.advanceTimersByTimeAsync(delay);
      }
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('重试耗尽仍失败抛错：fetch 调用 maxRetries + 1 次', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const promise = registerWorkerWithRetry(REG_BASE, { baseDelayMs: 1, maxDelayMs: 4, maxRetries: 3 });
      const assertion = expect(promise).rejects.toThrow(/注册重试 3 次仍失败/);
      // 退避 1、2、4（封顶）
      await jest.advanceTimersByTimeAsync(1);
      await jest.advanceTimersByTimeAsync(2);
      await jest.advanceTimersByTimeAsync(4);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });
});
