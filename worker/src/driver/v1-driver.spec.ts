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

  it('非 2xx → DriverRequestError（带 HTTP 状态，err.status 透传）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'bad' }, 400));
    const driver = newDriver();
    await expect(
      driver.sendMessage('ses_1', { parts: [] }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/HTTP 400/), status: 400 });
  });

  it('404 → err.status === 404（exec-server isSessionNotFound 会话失效重建判定依赖）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 404));
    const driver = newDriver();
    await expect(
      driver.sendMessage('ses_stale', { parts: [] }),
    ).rejects.toMatchObject({ status: 404 });
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

  it('listModels：GET /provider，有 key 的 provider 模型 + opencode 免费模型上报，无凭据外部 provider 不上报', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        all: [
          {
            id: 'opencode-go',
            name: 'OpenCode Go',
            key: 'sk-xxx',
            models: {
              'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', providerID: 'opencode-go' },
              'qwen3.7-plus': { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', providerID: 'opencode-go' },
            },
          },
          {
            id: 'opencode',
            name: 'OpenCode',
            models: {
              'deepseek-v4-flash-free': { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', providerID: 'opencode' },
            },
          },
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: {
              'claude-3-5-sonnet': { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', providerID: 'anthropic' },
            },
          },
        ],
      }),
    );
    const driver = newDriver();
    const models = await driver.listModels();
    expect(models).toEqual([
      { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash', providerID: 'opencode-go', modelID: 'deepseek-v4-flash', status: 'active' },
      { id: 'opencode-go/qwen3.7-plus', name: 'Qwen 3.7 Plus', providerID: 'opencode-go', modelID: 'qwen3.7-plus', status: 'active' },
      { id: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', providerID: 'opencode', modelID: 'deepseek-v4-flash-free', status: 'active' },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4199/provider');
  });

  it('listModels：/provider models 项缺 name 用 modelID 兜底；key 空串视为无凭据不收集', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        all: [
          {
            id: 'opencode-go',
            key: '',
            models: { 'glm-5.1': { id: 'glm-5.1' } },
          },
          {
            id: 'ollama-local',
            key: 'sk-ollama',
            models: { 'qwen3.5': {} },
          },
        ],
      }),
    );
    const driver = newDriver();
    const models = await driver.listModels();
    expect(models).toEqual([
      { id: 'ollama-local/qwen3.5', name: 'qwen3.5', providerID: 'ollama-local', modelID: 'qwen3.5', status: 'active' },
    ]);
  });

  it('listModels：/provider 失败（404）→ 回退 GET /api/model，data 映射 id=providerID/modelID', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(
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
      { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash', providerID: 'opencode-go', modelID: 'deepseek-v4-flash', status: undefined },
      { id: 'ollama-local/qwen3.5', name: 'Qwen 3.5', providerID: 'ollama-local', modelID: 'qwen3.5', status: undefined },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4199/provider');
    expect(mockFetch.mock.calls[1][0]).toBe('http://127.0.0.1:4199/api/model');
  });

  it('listModels：回退 /api/model，过滤 deprecated，仅保留 status=active（CONF-01：26 个含 deprecated → 8 个 active）', async () => {
    const activeModels = [
      'ling-3.0-tiny-free',
      'deepseek-v4-flash-free',
      'laguna-s-2.1-free',
      'longcat-2.0-free',
      'north-mini-code-free',
      'nemotron-3-ultra-free',
      'mimo-v2.5-free',
      'big-pickle',
    ];
    const deprecatedModels = [
      'ling-3.0-flash-free',
      'hy3-free',
      'minimax-m3-free',
      'ring-2.6-1t-free',
      'ling-2.6-flash-free',
      'hy3-preview-free',
      'qwen3.6-plus-free',
      'mimo-v2-omni-free',
      'mimo-v2-pro-free',
      'nemotron-3-super-free',
      'minimax-m2.5-free',
      'glm-5-free',
      'trinity-large-preview-free',
      'kimi-k2.5-free',
      'minimax-m2.1-free',
      'glm-4.7-free',
      'mimo-v2-flash-free',
      'grok-code',
    ];
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(
        jsonResponse({
          location: 'local',
          data: [
            ...activeModels.map((id) => ({ id, providerID: 'opencode', name: id, status: 'active' })),
            ...deprecatedModels.map((id) => ({ id, providerID: 'opencode', name: id, status: 'deprecated' })),
          ],
        }),
      );
    const driver = newDriver();
    const models = await driver.listModels();
    expect(models).toHaveLength(8);
    expect(models.every((m) => m.status === 'active')).toBe(true);
    expect(models.map((m) => m.modelID).sort()).toEqual([...activeModels].sort());
  });

  it('listModels：回退 /api/model，status 缺失（旧版 serve）→ 视为可用保留，不误杀', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(
        jsonResponse({
          location: 'local',
          data: [
            { id: 'deepseek-v4-flash', providerID: 'opencode-go', name: 'DeepSeek V4 Flash' },
            { id: 'grok-code', providerID: 'opencode', name: 'Grok Code', status: 'deprecated' },
          ],
        }),
      );
    const driver = newDriver();
    const models = await driver.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: 'opencode-go/deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
      status: undefined,
    });
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

describe('V1Driver.listQuestions / replyQuestion / rejectQuestion / listPermissions / replyPermission', () => {
  it('listQuestions：GET /question（v1 全局端点）返回数组，按 sessionID 过滤本会话 pending', async () => {
    // serve 1.18.16 实测：模型提问走 v1 Question 通道，全局 GET /question 直接返回数组；
    // v2 /api/session/{id}/question 为独立通道恒空（Bug1 根因）。此处验证跨会话过滤。
    const body = [
      {
        id: 'que_1',
        sessionID: 'ses_1',
        questions: [
          {
            question: '继续执行吗？',
            header: '确认',
            options: [{ label: '继续', description: '放行' }],
          },
        ],
      },
      { id: 'que_other', sessionID: 'ses_other', questions: [] },
    ];
    mockFetch.mockResolvedValue(jsonResponse(body));
    const driver = newDriver();
    const questions = await driver.listQuestions('ses_1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4199/question');
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe('que_1');
    expect(questions[0].questions[0].header).toBe('确认');
  });

  it('listQuestions：空数组 → 空结果（无 pending）', async () => {
    mockFetch.mockResolvedValue(jsonResponse([]));
    const driver = newDriver();
    await expect(driver.listQuestions('ses_1')).resolves.toEqual([]);
  });

  it('listQuestions：{data:[...]} 包裹解包兼容', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ id: 'que_1', sessionID: 'ses_1', questions: [] }] }));
    const driver = newDriver();
    const questions = await driver.listQuestions('ses_1');
    expect(questions).toHaveLength(1);
  });

  it('replyQuestion：POST /question/{requestID}/reply（v1 端点，v2 实测 404），body {answers}', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 200));
    const driver = newDriver();
    await driver.replyQuestion('ses_1', 'que_1', [['继续']]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4199/question/que_1/reply');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ answers: [['继续']] });
  });

  it('rejectQuestion：POST /question/{requestID}/reject（v1 端点）', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 200));
    const driver = newDriver();
    await driver.rejectQuestion('ses_1', 'que_1');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4199/question/que_1/reject');
    expect(init.method).toBe('POST');
  });

  it('listPermissions：GET /permission（v1 全局端点）返回数组，按 sessionID 过滤，字段归一 action/resources', async () => {
    // serve 1.18.16 实测：工具权限确认走 v1 Permission 通道，全局 GET /permission 直接返回
    // 数组（permission=action 名、patterns=资源模式）；v2 /api/session/{id}/permission 为
    // 独立通道恒空（Bug2 根因）。此处验证跨会话过滤 + v1 字段归一为 action/resources。
    const body = [
      {
        id: 'per_1',
        sessionID: 'ses_1',
        permission: 'external_directory',
        patterns: ['/etc/*'],
      },
      { id: 'per_other', sessionID: 'ses_other', permission: 'bash', patterns: ['/data/*'] },
    ];
    mockFetch.mockResolvedValue(jsonResponse(body));
    const driver = newDriver();
    const permissions = await driver.listPermissions('ses_1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4199/permission');
    expect(permissions).toHaveLength(1);
    expect(permissions[0].id).toBe('per_1');
    expect(permissions[0].action).toBe('external_directory');
    expect(permissions[0].resources).toEqual(['/etc/*']);
  });

  it('listPermissions：v2 {data:[...]} 包裹 + action/resources 形态仍兼容', async () => {
    const body = {
      data: [
        {
          id: 'per_1',
          sessionID: 'ses_1',
          action: 'bash',
          resources: ['/data/*'],
        },
      ],
    };
    mockFetch.mockResolvedValue(jsonResponse(body));
    const driver = newDriver();
    const permissions = await driver.listPermissions('ses_1');
    expect(permissions).toHaveLength(1);
    expect(permissions[0].action).toBe('bash');
    expect(permissions[0].resources).toEqual(['/data/*']);
  });

  it('replyPermission：POST /permission/{requestID}/reply，body {reply}（v1 全局端点实测生效，v2 端点 404）', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, 200));
    const driver = newDriver();
    await driver.replyPermission('ses_1', 'per_1', 'once');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4199/permission/per_1/reply');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reply: 'once' });
  });

  it('reply 端点非 2xx → DriverRequestError（status 透传，server 侧据此报错）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    const driver = newDriver();
    await expect(driver.replyQuestion('ses_1', 'que_stale', [['x']])).rejects.toMatchObject({
      status: 404,
    });
  });
});
