/**
 * v2「integration 维度」凭据同步单测（credential store ↔ serve REST）。
 *
 * 全部请求走注入的 fake requestServe（不打真 serve），覆盖：
 * 新建 / 幂等不变 / 值变更（DELETE+POST）/ 吊销删除 / 配置段 provider 排除 /
 * 写入后 provider 不可见（静默失败诊断）/ 读取失败抛错 / 日志无 key 明文。
 */

import {
  IntegrationCredentialSyncRequest,
  ServeRequester,
  syncIntegrationCredentials,
} from './integration-credential-sync';
import type { ServeEndpoint, ServeResponse } from '../reload/config-reloader';

const ENDPOINT: ServeEndpoint = { baseUrl: 'http://127.0.0.1:4000', password: 'pw' };

interface CredentialRow {
  id: string;
  integrationID: string;
  label: string;
  active: boolean;
  value: { type: string; key: string };
}

/** 假 serve：内存 credential 表 + provider 注册表 + 调用轨迹。 */
function makeFakeServe() {
  const state: {
    credentials: CredentialRow[];
    providers: string[];
    failList: boolean;
    calls: Array<{ path: string; method: string; body?: unknown }>;
  } = { credentials: [], providers: [], failList: false, calls: [] };

  const respond = (status: number, json?: unknown): ServeResponse => ({
    status,
    ok: status >= 200 && status < 300,
    text: json === undefined ? '' : JSON.stringify(json),
    json,
  });

  const requestServe = jest.fn(
    async (
      _endpoint: ServeEndpoint | undefined,
      path: string,
      options: { method?: string; body?: unknown } = {},
    ): Promise<ServeResponse> => {
      const method = options.method ?? 'GET';
      state.calls.push({ path, method, body: options.body });
      if (path === '/api/credential' && method === 'GET') {
        return state.failList ? respond(500) : respond(200, { data: state.credentials });
      }
      if (path === '/api/credential' && method === 'POST') {
        const body = options.body as { integrationID: string; value: { type: string; key: string } };
        const row: CredentialRow = {
          id: `cred_${state.credentials.length + 1}_${rowSeq++}`,
          integrationID: body.integrationID,
          label: 'default',
          active: true,
          value: body.value,
        };
        state.credentials.push(row);
        state.providers.push(body.integrationID);
        return respond(200, { data: row });
      }
      if (path.startsWith('/api/credential/') && method === 'DELETE') {
        const id = path.slice('/api/credential/'.length);
        state.credentials = state.credentials.filter((row) => row.id !== id);
        return respond(204);
      }
      if (path === '/api/provider' && method === 'GET') {
        return respond(200, { data: state.providers.map((id) => ({ id })) });
      }
      return respond(404);
    },
  ) as jest.MockedFunction<ServeRequester>;

  return { state, requestServe };
}

let rowSeq = 0;

function makeDeps(requestServe: jest.MockedFunction<ServeRequester>) {
  return {
    endpoint: ENDPOINT,
    requestServe,
    log: jest.fn(),
    warn: jest.fn(),
  };
}

const KEY_ONLY: IntegrationCredentialSyncRequest = {
  providerKeys: [{ providerID: 'opencode-go', key: 'sk-secret-a' }],
};

describe('syncIntegrationCredentials（v2 integration 维度凭据 ↔ serve /api/credential）', () => {
  it('store 里没有该 integration → POST 新建，并回读 provider 注册表确认可见', async () => {
    const { state, requestServe } = makeFakeServe();
    state.providers = ['opencode'];

    const result = await syncIntegrationCredentials(KEY_ONLY, makeDeps(requestServe));

    expect(result.ok).toBe(true);
    expect(result.created).toEqual(['opencode-go']);
    expect(result.changed).toBe(true);
    expect(result.missing).toEqual([]);
    const post = state.calls.find((c) => c.method === 'POST' && c.path === '/api/credential');
    expect(post?.body).toEqual({
      integrationID: 'opencode-go',
      value: { type: 'key', key: 'sk-secret-a' },
    });
    // 写完必须回读 /api/provider 做效果确认（写入 ≠ 生效）
    expect(state.calls.some((c) => c.path === '/api/provider')).toBe(true);
    expect(requestServe).toHaveBeenCalledWith(
      ENDPOINT,
      '/api/credential',
      expect.objectContaining({ method: 'POST', body: expect.any(Object) }),
    );
  });

  it('key 已一致 → 只读不写（幂等，不制造生效循环），changed=false', async () => {
    const { state, requestServe } = makeFakeServe();
    state.credentials = [
      {
        id: 'cred_existing',
        integrationID: 'opencode-go',
        label: 'default',
        active: true,
        value: { type: 'key', key: 'sk-secret-a' },
      },
    ];
    state.providers = ['opencode-go'];

    const result = await syncIntegrationCredentials(KEY_ONLY, makeDeps(requestServe));

    expect(result).toMatchObject({ ok: true, changed: false, unchanged: 1 });
    expect(result.created).toEqual([]);
    expect(state.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('key 变更 → DELETE 旧行 + POST 新值（PATCH value 实测不生效，故重建）', async () => {
    const { state, requestServe } = makeFakeServe();
    state.credentials = [
      {
        id: 'cred_old',
        integrationID: 'opencode-go',
        label: 'default',
        active: true,
        value: { type: 'key', key: 'sk-old-key' },
      },
    ];
    state.providers = ['opencode-go'];

    const result = await syncIntegrationCredentials(KEY_ONLY, makeDeps(requestServe));

    expect(result.updated).toEqual(['opencode-go']);
    expect(result.created).toEqual([]);
    expect(result.changed).toBe(true);
    const methods = state.calls
      .filter((c) => c.path === '/api/credential' || c.path.startsWith('/api/credential/'))
      .map((c) => `${c.method} ${c.path}`);
    expect(methods).toEqual([
      'GET /api/credential',
      'DELETE /api/credential/cred_old',
      'POST /api/credential',
    ]);
    expect(state.credentials).toHaveLength(1);
    expect(state.credentials[0].value.key).toBe('sk-secret-a');
  });

  it('revokedProviderIDs 命中 → 删除对应 store 行（吊销同步，serve 不再握有旧 key）', async () => {
    const { state, requestServe } = makeFakeServe();
    state.credentials = [
      {
        id: 'cred_gone',
        integrationID: 'opencode-go',
        label: 'default',
        active: true,
        value: { type: 'key', key: 'sk-revoked' },
      },
    ];
    state.providers = ['opencode-go'];

    const result = await syncIntegrationCredentials(
      { providerKeys: [], revokedProviderIDs: ['opencode-go'] },
      makeDeps(requestServe),
    );

    expect(result.removed).toEqual(['opencode-go']);
    expect(result.changed).toBe(true);
    expect(state.credentials).toEqual([]);
    expect(state.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('providerConfigs 里的 provider（有 baseUrl，走 opencode.json）完全不进 credential store；其吊销也交给配置段处理', async () => {
    const { state, requestServe } = makeFakeServe();

    const result = await syncIntegrationCredentials(
      {
        providerKeys: [{ providerID: 'qwenlocal', key: 'local-noop' }],
        providerConfigs: { qwenlocal: {} },
        revokedProviderIDs: ['qwenlocal'],
      },
      makeDeps(requestServe),
    );

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(requestServe).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });

  it('写入后 provider 仍不在注册表 → missing + warn（静默失败必须显式暴露）', async () => {
    const { requestServe } = makeFakeServe();
    // GET 空表 → POST 写入成功，但 GET /api/provider 里没有它
    // （模拟"store 存得进、provider 却没注册"——本次线上故障的形态）
    requestServe.mockImplementation(
      async (_endpoint, path, options = {}): Promise<ServeResponse> => {
        const method = options.method ?? 'GET';
        if (path === '/api/credential' && method === 'GET') {
          return { status: 200, ok: true, text: '[]', json: { data: [] } };
        }
        if (path === '/api/credential' && method === 'POST') {
          return {
            status: 200,
            ok: true,
            text: '{}',
            json: { data: { id: 'cred_x', integrationID: 'opencode-go' } },
          };
        }
        if (path === '/api/provider' && method === 'GET') {
          return { status: 200, ok: true, text: '[]', json: { data: [{ id: 'opencode' }] } };
        }
        return { status: 404, ok: false, text: '', json: undefined };
      },
    );
    const deps = makeDeps(requestServe);

    const result = await syncIntegrationCredentials(KEY_ONLY, deps);

    expect(result.created).toEqual(['opencode-go']);
    expect(result.missing).toEqual(['opencode-go']);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('未注册该 provider'));
  });

  it('读取 credential store 失败 → 抛错（交上层 warn，文件注入不受影响）', async () => {
    const { requestServe } = makeFakeServe();
    requestServe.mockResolvedValue({ status: 500, ok: false, text: '', json: undefined });

    await expect(syncIntegrationCredentials(KEY_ONLY, makeDeps(requestServe))).rejects.toThrow(
      'GET /api/credential HTTP 500',
    );
  });

  it('日志/告警只出现 providerID 与计数，**绝不出现 key 明文**', async () => {
    const { state, requestServe } = makeFakeServe();
    state.providers = ['opencode'];

    const deps = makeDeps(requestServe);
    await syncIntegrationCredentials(KEY_ONLY, deps);

    const allLogs = [...deps.log.mock.calls.flat(), ...deps.warn.mock.calls.flat()].join('\n');
    expect(allLogs).toContain('opencode-go');
    expect(allLogs).not.toContain('sk-secret-a');
  });
});
