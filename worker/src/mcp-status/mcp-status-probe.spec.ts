/**
 * T8c MCP 状态探测器单测（**v2：数据源 = worker 自己那个 serve 的 `GET /api/mcp`**）。
 *
 * ⚠️ **本文件是本轮修复的回归守卫**：v2 的 CLI 子命令绑**共享后台服务**（49374），
 * 读的是**另一个配置作用域** ⇒ 用 CLI 观测 worker 的 serve 原理上就是错的。
 * 最后一条用例显式断言：**探针不再 shell out 到 opencode CLI**。
 */
import { execSync, spawnSync } from 'child_process';
import {
  BUILTIN_MCP_SERVERS,
  McpStatusProbe,
  isClusterInternalUrl,
  isMcpStatusPayload,
  parseMcpStatusPayload,
} from './mcp-status-probe';

// 回归守卫用：把 child_process 的执行入口全部 mock 掉，任何 CLI 调用都会被记录下来。
jest.mock('child_process', () => ({ spawnSync: jest.fn(), execSync: jest.fn() }));

const mockedSpawnSync = spawnSync as unknown as jest.Mock;
const mockedExecSync = execSync as unknown as jest.Mock;

/** v2 `GET /api/mcp` 的实测响应（worker serve，2026-10-20 实测）。 */
const REAL_MCP_PAYLOAD = {
  location: { directory: '/data/vteam-worker' },
  data: [
    { name: 'vteam', status: { status: 'connected' }, integrationID: 'mcp_0a2d2522d731065f' },
  ],
};

describe('parseMcpStatusPayload（v2 五态 → 线契约五态，1:1）', () => {
  it('五个状态逐个映射（不折叠、不丢服务器）', () => {
    const parsed = parseMcpStatusPayload({
      location: { directory: '/data' },
      data: [
        { name: 'a', status: { status: 'connected' } },
        { name: 'b', status: { status: 'failed', error: 'ConnectionRefused' } },
        { name: 'c', status: { status: 'needs_auth', error: 'needs client registration' } },
        { name: 'd', status: { status: 'pending' } },
        { name: 'e', status: { status: 'disabled' } },
      ],
    });

    expect(parsed.entries).toEqual([
      { serverName: 'a', status: 'connected' },
      { serverName: 'b', status: 'failed' },
      { serverName: 'c', status: 'needs_auth' },
      { serverName: 'd', status: 'pending' },
      { serverName: 'e', status: 'disabled' },
    ]);
    expect(parsed.unknownStatuses).toEqual([]);
    expect(parsed.unnamedCount).toBe(0);
  });

  it('裸数组形态（2.0.32 spec 形态漂移）同样解析', () => {
    const parsed = parseMcpStatusPayload([
      { name: 'vteam', status: { status: 'connected' } },
    ]);
    expect(parsed.entries).toEqual([{ serverName: 'vteam', status: 'connected' }]);
  });

  it('status 容忍裸字符串（上游形态漂移）', () => {
    const parsed = parseMcpStatusPayload({ data: [{ name: 'x', status: 'connected' }] });
    expect(parsed.entries).toEqual([{ serverName: 'x', status: 'connected' }]);
  });

  it('未知/缺失状态 → 保守按 failed 上报 + 显式记账（**不静默丢弃服务器**）', () => {
    const parsed = parseMcpStatusPayload({
      data: [
        { name: 'weird', status: { status: 'reconnecting' } },
        { name: 'nostatus' },
      ],
    });

    expect(parsed.entries).toEqual([
      { serverName: 'weird', status: 'failed' },
      { serverName: 'nostatus', status: 'failed' },
    ]);
    expect(parsed.unknownStatuses).toEqual([
      { serverName: 'weird', rawStatus: 'reconnecting' },
      { serverName: 'nostatus', rawStatus: '' },
    ]);
  });

  it('缺名字的条目不产出条目但计数（线契约要求 serverName 非空）', () => {
    const parsed = parseMcpStatusPayload({ data: [{ status: { status: 'connected' } }, 'junk'] });
    expect(parsed.entries).toEqual([]);
    expect(parsed.unnamedCount).toBe(2);
  });
});

describe('isMcpStatusPayload（形状闸门：形状不对 ≠ "没有 MCP 服务器"）', () => {
  it('数组 / 带 data 数组的对象 → 合法', () => {
    expect(isMcpStatusPayload([])).toBe(true);
    expect(isMcpStatusPayload({ location: {}, data: [] })).toBe(true);
  });

  it('HTML 字符串 / 空对象 / null → 不合法（探针必须报 probe_failed）', () => {
    expect(isMcpStatusPayload('<!DOCTYPE html><html></html>')).toBe(false);
    expect(isMcpStatusPayload({})).toBe(false);
    expect(isMcpStatusPayload(null)).toBe(false);
    expect(isMcpStatusPayload('No MCP servers configured')).toBe(false);
  });
});

describe('McpStatusProbe（serve 作用域 + 30s 节流缓存）', () => {
  it('节流窗口内复用缓存，不重复调用 probeFn', async () => {
    let calls = 0;
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => {
        calls++;
        return { data: [{ name: 'vteam', status: { status: 'connected' } }] };
      },
    });

    const first = await probe.getStatus();
    const second = await probe.getStatus();

    expect(calls).toBe(1);
    expect(first).toEqual([{ serverName: 'vteam', status: 'connected' }]);
    expect(second).toBe(first);
  });

  it('窗口外重新探测（fake timers 验证节流过期）', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => {
        calls++;
        return { data: [{ name: 'a', status: { status: 'connected' } }] };
      },
    });

    await probe.getStatus();
    jest.advanceTimersByTime(29_999);
    await probe.getStatus();
    expect(calls).toBe(1);

    jest.advanceTimersByTime(2);
    await probe.getStatus();
    expect(calls).toBe(2);
    jest.useRealTimers();
  });

  it('探测抛错保留上次结果并告警', async () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: jest
        .fn()
        .mockResolvedValueOnce({ data: [{ name: 'ok', status: { status: 'connected' } }] })
        .mockRejectedValueOnce(new Error('serve 不可达')),
      logger: { warn },
    });

    const first = await probe.getStatus();
    expect(first).toEqual([{ serverName: 'ok', status: 'connected' }]);
    jest.advanceTimersByTime(30_001);
    const second = await probe.getStatus();
    expect(second).toEqual(first);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[mcp-status] 探测失败'));
    jest.useRealTimers();
  });

  it('首次探测失败返回空数组（不抛错，心跳链路不受影响）', async () => {
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => {
        throw new Error('serve 未就绪');
      },
    });

    expect(await probe.getStatus()).toEqual([]);
  });

  it('探测失败后**保留上次成功结果**（不降级成空列表）', async () => {
    jest.useFakeTimers();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: jest
        .fn()
        .mockResolvedValueOnce({ data: [{ name: 'vteam', status: { status: 'connected' } }] })
        .mockResolvedValueOnce({}),
    });

    expect((await probe.getSnapshot()).entries).toEqual([
      { serverName: 'vteam', status: 'connected' },
    ]);
    jest.advanceTimersByTime(30_001);
    const failed = await probe.getSnapshot();
    expect(failed.outcome).toBe('probe_failed');
    expect(failed.reason).toContain('/api/mcp');
    expect(failed.entries).toEqual([{ serverName: 'vteam', status: 'connected' }]);
    jest.useRealTimers();
  });

  it('形状不对的响应 → probe_failed（**不得**报成"没有 MCP 服务器"）', async () => {
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => '<!DOCTYPE html><html></html>',
    });

    const snapshot = await probe.getSnapshot();
    expect(snapshot.outcome).toBe('probe_failed');
    expect(snapshot.reason).toContain('/api/mcp');
    expect(snapshot.entries).toEqual([]);
  });

  it('成功读到空列表（真的没配 MCP）→ outcome=ok（与 probe_failed 区分开）', async () => {
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ location: { directory: '/data' }, data: [] }),
    });

    const snapshot = await probe.getSnapshot();
    expect(snapshot.outcome).toBe('ok');
    expect(snapshot.entries).toEqual([]);
  });

  it('节流窗口内复用同一快照（outcome 也不变）', async () => {
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ data: [{ name: 'a', status: { status: 'connected' } }] }),
    });

    const first = await probe.getSnapshot();
    const second = await probe.getSnapshot();
    expect(second).toBe(first);
    expect(second.outcome).toBe('ok');
  });

  it('未知状态 → 显式告警（含原始状态串）+ 保守按 failed 上报', async () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ data: [{ name: 'weird', status: { status: 'reconnecting' } }] }),
      logger: { warn },
    });

    const entries = await probe.getStatus();
    expect(entries).toEqual([{ serverName: 'weird', status: 'failed' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('未知 MCP 状态'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reconnecting'));
  });
});

describe('McpStatusProbe 默认数据源：serve 的 GET /api/mcp（Basic Auth）', () => {
  const fakeResponse = (body: unknown, ok = true, status = 200): Response =>
    ({
      ok,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }) as unknown as Response;

  it('请求 worker 自己那个 serve 的 /api/mcp，带 serve 密码的 Basic Auth', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(REAL_MCP_PAYLOAD));
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      endpoint: () => ({ baseUrl: 'http://127.0.0.1:4000', password: 'serve-pw' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const entries = await probe.getStatus();

    expect(entries).toEqual([{ serverName: 'vteam', status: 'connected' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4000/api/mcp');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('opencode:serve-pw', 'utf8').toString('base64')}`,
    );
  });

  it('serve 端点每次探测时读取（serve 重启换端口后自动跟上）', async () => {
    let port = 4000;
    const fetchImpl = jest.fn().mockImplementation(async () => fakeResponse(REAL_MCP_PAYLOAD));
    const probe = new McpStatusProbe({
      throttleMs: 0,
      endpoint: () => ({ baseUrl: `http://127.0.0.1:${port}`, password: 'pw' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await probe.getStatus();
    port = 4100;
    await probe.getStatus();

    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://127.0.0.1:4000/api/mcp');
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toBe('http://127.0.0.1:4100/api/mcp');
  });

  it('HTTP 非 2xx → probe_failed（保留上次结果）', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse('boom', false, 500));
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      endpoint: () => ({ baseUrl: 'http://127.0.0.1:4000', password: 'pw' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const snapshot = await probe.getSnapshot();
    expect(snapshot.outcome).toBe('probe_failed');
    expect(snapshot.reason).toContain('HTTP 500');
  });

  it('响应不是合法 JSON → probe_failed（不报成"没有 MCP 服务器"）', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse('<!DOCTYPE html><html></html>'));
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      endpoint: () => ({ baseUrl: 'http://127.0.0.1:4000', password: 'pw' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const snapshot = await probe.getSnapshot();
    expect(snapshot.outcome).toBe('probe_failed');
    expect(snapshot.reason).toContain('JSON');
  });

  it('serve 端点未就绪（baseUrl 空）→ probe_failed', async () => {
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      endpoint: () => undefined,
      fetchImpl: (jest.fn() as unknown) as typeof fetch,
    });

    const snapshot = await probe.getSnapshot();
    expect(snapshot.outcome).toBe('probe_failed');
    expect(snapshot.reason).toContain('serve 端点未就绪');
  });
});

describe('isClusterInternalUrl（集群内服务名判定）', () => {
  it('compose/k8s 服务名视为集群内地址', () => {
    expect(isClusterInternalUrl('http://server:3000/api/v1/platform-mcp')).toBe(true);
    expect(isClusterInternalUrl('http://vteam-server:3000/api/v1/platform-mcp')).toBe(true);
  });

  it('外部域名/IP 不算集群内地址', () => {
    expect(isClusterInternalUrl('http://mcp.example.com/api/v1/platform-mcp')).toBe(false);
    expect(isClusterInternalUrl('http://192.168.10.78:3000/api/v1/platform-mcp')).toBe(false);
  });

  it('非法 URL 返回 false 不抛错', () => {
    expect(isClusterInternalUrl('not a url')).toBe(false);
    expect(isClusterInternalUrl('')).toBe(false);
  });
});

describe('内置 MCP 集群内地址引导告警', () => {
  it('内置 vteam failed + 集群内地址 → 输出 WORKER_MCP_URL 引导', async () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ data: [{ name: 'vteam', status: { status: 'failed', error: 'refused' } }] }),
      resolveBuiltinMcpUrl: () => 'http://vteam-server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    await probe.getStatus();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[mcp-status] 内置 MCP 不可达'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('http://vteam-server:3000/api/v1/platform-mcp'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WORKER_MCP_URL'));
  });

  it('存量旧名 keta-platform failed 亦触发（改名迁移兼容）', async () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ data: [{ name: 'keta-platform', status: { status: 'failed' } }] }),
      resolveBuiltinMcpUrl: () => 'http://server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    await probe.getStatus();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WORKER_MCP_URL'));
  });

  it('内置 MCP 地址为外部可达地址时不告警（不打扰）', async () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ data: [{ name: 'vteam', status: { status: 'failed' } }] }),
      resolveBuiltinMcpUrl: () => 'http://mcp.example.com/api/v1/platform-mcp',
      logger: { warn },
    });

    await probe.getStatus();
    expect(warn).not.toHaveBeenCalled();
  });

  it('内置 MCP connected 不告警', async () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ data: [{ name: 'vteam', status: { status: 'connected' } }] }),
      resolveBuiltinMcpUrl: () => 'http://vteam-server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    await probe.getStatus();
    expect(warn).not.toHaveBeenCalled();
  });

  it('非内置 server failed 不告警', async () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ data: [{ name: 'gitee-ent', status: { status: 'failed' } }] }),
      resolveBuiltinMcpUrl: () => 'http://vteam-server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    await probe.getStatus();
    expect(warn).not.toHaveBeenCalled();
  });

  it('节流窗口内复用缓存不重复告警', async () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: async () => ({ data: [{ name: 'vteam', status: { status: 'failed' } }] }),
      resolveBuiltinMcpUrl: () => 'http://vteam-server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    await probe.getStatus();
    await probe.getStatus();
    jest.advanceTimersByTime(29_999);
    await probe.getStatus();
    expect(warn).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('默认 resolver 从 <cwd>/opencode.json 读取实际注入地址', async () => {
    const warn = jest.fn();
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-probe-'));
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ mcp: { vteam: { type: 'remote', url: 'http://vteam-server:3000/api/v1/platform-mcp' } } }),
      'utf8',
    );
    try {
      const probe = new McpStatusProbe({
        throttleMs: 30_000,
        cwd: dir,
        probeFn: async () => ({ data: [{ name: 'vteam', status: { status: 'failed' } }] }),
        logger: { warn },
      });

      await probe.getStatus();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('WORKER_MCP_URL'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BUILTIN_MCP_SERVERS 覆盖新名与存量旧名', () => {
    expect(BUILTIN_MCP_SERVERS).toContain('vteam');
    expect(BUILTIN_MCP_SERVERS).toContain('keta-platform');
  });
});

describe('回归守卫：探针**不再** shell out 到 opencode CLI', () => {
  beforeEach(() => {
    mockedSpawnSync.mockReset();
    mockedExecSync.mockReset();
  });

  it('默认数据源与注入探针都不触发任何子进程', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(REAL_MCP_PAYLOAD),
    });
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      endpoint: () => ({ baseUrl: 'http://127.0.0.1:4000', password: 'pw' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const entries = await probe.getStatus();

    expect(entries).toEqual([{ serverName: 'vteam', status: 'connected' }]);
    expect(mockedSpawnSync).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalled();
  });
});
