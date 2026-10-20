/**
 * 配置热重载（opencode v2 原生，不重启 serve）的决策逻辑单测。
 *
 * 钉住三条互斥出路：
 * 1. 安全时 → `POST /api/location/reload`（204）+ 效果确认 ⇒ 'reloaded'；
 * 2. **有待答复的表单/权限**（或结论不完整）⇒ 'deferred'（**不重载**：改走文件监听路径，
 *    它不取消任何待答复项）——这是本模块最关键的安全性质；
 * 3. 重载调用失败 / 效果未确认 ⇒ 'failed' / 'unverified'（调用方回退到真实重启）。
 */
import {
  ConfigReloader,
  ConfigReloadOutcome,
  combineVerifiers,
  LOCATION_RELOAD_PATH,
  requestServe,
  verifyMcpServersVisible,
  verifyProvidersVisible,
  verifySkillsVisible,
} from './config-reloader';
import { PendingRequestSnapshot } from './pending-requests';

const ENDPOINT = { baseUrl: 'http://127.0.0.1:4000', password: 'pw' };

/** 记录每次请求的路径/方法，返回给定响应。 */
function makeFetch(
  responses: Record<string, { status: number; body: unknown }>,
): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; method: string; auth?: string }>;
} {
  const calls: Array<{ url: string; method: string; auth?: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, auth: headers.Authorization });
    const key = `${method} ${url.replace(ENDPOINT.baseUrl, '')}`;
    const hit = responses[key];
    if (!hit) {
      throw new Error(`未预期的请求: ${key}`);
    }
    const text = typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body);
    return {
      status: hit.status,
      ok: hit.status >= 200 && hit.status < 300,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function snapshot(overrides: Partial<PendingRequestSnapshot> = {}): PendingRequestSnapshot {
  return { forms: 0, permissions: 0, sessions: [], incomplete: false, ...overrides };
}

describe('ConfigReloader（opencode v2 配置热重载）', () => {
  it('安全时 → POST /api/location/reload（204）且效果已确认 ⇒ reloaded', async () => {
    const { fetchImpl, calls } = makeFetch({
      [`POST ${LOCATION_RELOAD_PATH}`]: { status: 204, body: '' },
    });
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => snapshot(),
      fetchImpl,
    });

    const result = await reloader.reload('reload-config', async () => ({
      ok: true,
      detail: 'serve 侧可见 provider: p1',
    }));

    expect(result.outcome).toBe('reloaded');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${ENDPOINT.baseUrl}${LOCATION_RELOAD_PATH}`);
    // Basic Auth 头必须带（v2 恒开鉴权）
    expect(calls[0].auth).toBe(
      `Basic ${Buffer.from(`opencode:${ENDPOINT.password}`).toString('base64')}`,
    );
  });

  it('**有待答复的表单** ⇒ deferred：绝不调用 location/reload（不取消用户正在作答的问题）', async () => {
    const { fetchImpl, calls } = makeFetch({});
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => snapshot({ forms: 1, sessions: ['ses_1'] }),
      fetchImpl,
    });

    const result = await reloader.reload('reload-config');

    expect(result.outcome).toBe('deferred');
    expect(calls).toHaveLength(0);
    expect(result.pending?.forms).toBe(1);
    expect(result.detail).toContain('location/reload 会取消它们');
  });

  it('**有待答复的权限** ⇒ deferred（同样不重载）', async () => {
    const { fetchImpl, calls } = makeFetch({});
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => snapshot({ permissions: 2, sessions: ['ses_2'] }),
      fetchImpl,
    });

    const result = await reloader.reload('model-credentials');

    expect(result.outcome).toBe('deferred');
    expect(calls).toHaveLength(0);
    expect(result.pending?.permissions).toBe(2);
  });

  it('pending 检测结论不完整（查询失败）⇒ deferred（保守：不能假定没有待答复项）', async () => {
    const { fetchImpl, calls } = makeFetch({});
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => snapshot({ incomplete: true }),
      fetchImpl,
    });

    const result = await reloader.reload('reload-config');

    expect(result.outcome).toBe('deferred');
    expect(calls).toHaveLength(0);
  });

  it('pending 探测抛错 ⇒ deferred（按「可能有待答复项」处理）', async () => {
    const { fetchImpl, calls } = makeFetch({});
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => {
        throw new Error('serve 不可达');
      },
      fetchImpl,
    });

    const result = await reloader.reload('reload-config');

    expect(result.outcome).toBe('deferred');
    expect(calls).toHaveLength(0);
  });

  it('重载端点返回非 204 ⇒ failed（调用方回退真实重启）', async () => {
    const { fetchImpl } = makeFetch({
      [`POST ${LOCATION_RELOAD_PATH}`]: { status: 503, body: { error: 'busy' } },
    });
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => snapshot(),
      fetchImpl,
    });

    const result = await reloader.reload('reload-config');

    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('503');
  });

  it('重载调用抛错（serve 不可达）⇒ failed', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => snapshot(),
      fetchImpl,
    });

    const result = await reloader.reload('reload-config');

    expect(result.outcome).toBe('failed');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('重载成功但**效果未确认** ⇒ unverified（调用方回退真实重启，绝不静默）', async () => {
    const { fetchImpl } = makeFetch({
      [`POST ${LOCATION_RELOAD_PATH}`]: { status: 204, body: '' },
    });
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => snapshot(),
      fetchImpl,
    });

    const result = await reloader.reload('reload-config', async () => ({
      ok: false,
      detail: 'serve 侧未见 provider: p1',
    }));

    expect(result.outcome).toBe('unverified');
    expect(result.detail).toContain('未见 provider');
  });

  it('校验器抛错 ⇒ unverified（不吞）', async () => {
    const { fetchImpl } = makeFetch({
      [`POST ${LOCATION_RELOAD_PATH}`]: { status: 204, body: '' },
    });
    const reloader = new ConfigReloader({
      endpoint: () => ENDPOINT,
      pendingProbe: async () => snapshot(),
      fetchImpl,
    });

    const result = await reloader.reload('reload-config', async () => {
      throw new Error('读 /api/provider 失败');
    });

    expect(result.outcome).toBe('unverified');
  });

  it('端点未就绪（baseUrl 空）⇒ failed（不发起任何请求）', async () => {
    const { fetchImpl, calls } = makeFetch({});
    const reloader = new ConfigReloader({
      endpoint: () => ({ baseUrl: '', password: 'pw' }),
      pendingProbe: async () => snapshot(),
      fetchImpl,
    });

    const result = await reloader.reload('reload-config');

    expect(result.outcome).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('未注入 pending 探测 ⇒ 视为无 pending（仍走重载）', async () => {
    const { fetchImpl, calls } = makeFetch({
      [`POST ${LOCATION_RELOAD_PATH}`]: { status: 204, body: '' },
    });
    const reloader = new ConfigReloader({ endpoint: () => ENDPOINT, fetchImpl });

    const result = await reloader.reload('reload-config');

    expect(result.outcome).toBe('reloaded');
    expect(calls).toHaveLength(1);
  });
});

describe('效果确认器', () => {
  it('provider 可见 ⇒ ok', async () => {
    const { fetchImpl } = makeFetch({
      'GET /api/provider': {
        status: 200,
        body: { location: { directory: '/w' }, data: [{ id: 'p1', name: 'p1' }] },
      },
    });
    const result = await verifyProvidersVisible(ENDPOINT, ['p1'], { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it('provider 不可见 ⇒ 失败并点名缺失项', async () => {
    const { fetchImpl } = makeFetch({
      'GET /api/provider': { status: 200, body: { location: {}, data: [] } },
    });
    const result = await verifyProvidersVisible(ENDPOINT, ['p1'], { fetchImpl, settleMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('p1');
  });

  it('MCP server 可见 ⇒ ok（裸数组形态也认）', async () => {
    const { fetchImpl } = makeFetch({
      'GET /api/mcp': { status: 200, body: [{ name: 'vteam', status: { status: 'connected' } }] },
    });
    const result = await verifyMcpServersVisible(ENDPOINT, ['vteam'], { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it('skill 可见 ⇒ ok（按 id 或 name 命中）', async () => {
    const { fetchImpl } = makeFetch({
      'GET /api/skill': {
        status: 200,
        body: { location: {}, data: [{ id: 's1', name: 'skill-a', path: '/p', content: 'x' }] },
      },
    });
    const expectOk = await verifySkillsVisible(ENDPOINT, ['s1'], { fetchImpl });
    expect(expectOk.ok).toBe(true);
    const expectByName = await verifySkillsVisible(ENDPOINT, ['skill-a'], { fetchImpl });
    expect(expectByName.ok).toBe(true);
  });

  it('读端点非 2xx ⇒ 失败', async () => {
    const { fetchImpl } = makeFetch({
      'GET /api/mcp': { status: 401, body: { error: 'unauthorized' } },
    });
    const result = await verifyMcpServersVisible(ENDPOINT, ['vteam'], { fetchImpl, settleMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('401');
  });

  it('稳定窗口内重试：第一次读不到、第二次读到 ⇒ ok（重载后配置是异步重建的）', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const body =
        calls === 1
          ? { location: {}, data: [] }
          : { location: {}, data: [{ id: 'p1', name: 'p1' }] };
      const text = JSON.stringify(body);
      return {
        status: 200,
        ok: true,
        text: async () => text,
        json: async () => JSON.parse(text),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await verifyProvidersVisible(ENDPOINT, ['p1'], { fetchImpl, settleMs: 1000 });
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(1);
  });

  it('待确认清单为空 ⇒ 跳过确认（ok）', async () => {
    const { fetchImpl, calls } = makeFetch({});
    const result = await verifyProvidersVisible(ENDPOINT, [], { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('combineVerifiers：全部通过才 ok；任一失败即失败', async () => {
    const ok = combineVerifiers([
      async () => ({ ok: true, detail: 'a' }),
      async () => ({ ok: true, detail: 'b' }),
    ]);
    expect(await ok!()).toEqual({ ok: true, detail: 'a；b' });

    const bad = combineVerifiers([
      async () => ({ ok: true, detail: 'a' }),
      async () => ({ ok: false, detail: 'b 失败' }),
    ]);
    const result = await bad!();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('b 失败');
  });

  it('combineVerifiers：校验器抛错 ⇒ 失败（不吞）', async () => {
    const combined = combineVerifiers([
      async () => {
        throw new Error('boom');
      },
    ]);
    const result = await combined!();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('boom');
  });
});

describe('requestServe（鉴权请求）', () => {
  it('密码为空 ⇒ 不带 Authorization 头', async () => {
    const { fetchImpl, calls } = makeFetch({ 'GET /api/info': { status: 200, body: {} } });
    await requestServe({ baseUrl: 'http://127.0.0.1:4000', password: null }, '/api/info', {
      fetchImpl,
    });
    expect(calls[0].auth).toBeUndefined();
  });

  it('响应不是合法 JSON ⇒ json 为 undefined，text 保留原文', async () => {
    const fetchImpl = (async () =>
      ({
        status: 200,
        ok: true,
        text: async () => '<html>spa</html>',
        json: async () => {
          throw new Error('not json');
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const res = await requestServe(ENDPOINT, '/api/info', { fetchImpl });
    expect(res.json).toBeUndefined();
    expect(res.text).toContain('<html>');
  });
});
