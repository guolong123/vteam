/**
 * T8c MCP 三态探测器单测：
 * - parseMcpListOutput：三态识别（connected/failed/needs_auth）+ ANSI 剥离 +
 *   failed 错误行 + 非状态行跳过
 * - McpStatusProbe：30s 节流缓存（窗口内复用）、探测失败保留上次结果、
 *   probeFn 注入、默认 spawnSync 形态
 */
import {
  BUILTIN_MCP_SERVERS,
  McpStatusProbe,
  isClusterInternalUrl,
  parseMcpListOutput,
  stripAnsi,
} from './mcp-status-probe';

describe('stripAnsi', () => {
  it('剥除 ANSI 转义序列（[90m 灰色着色等）', () => {
    expect(stripAnsi('\u001B[0m\u001B[90mconnected\u001B[0m')).toBe('connected');
  });

  it('无 ANSI 文本原样返回', () => {
    expect(stripAnsi('●  ✓ gitee-ent connected')).toBe('●  ✓ gitee-ent connected');
  });
});

describe('parseMcpListOutput（T8c 三态解析）', () => {
  it('真实输出形态：✓ connected 行 → connected（含 ANSI）', () => {
    const raw = [
      '\u001B[0m',
      '┌  MCP Servers',
      '│',
      '●  ✓ gitee-ent \u001B[90mconnected',
      '│      \u001B[90mnpx -y @gitee/mcp-gitee-ent@latest',
      '│',
      '●  ✓ swagger \u001B[90mconnected',
      '│      \u001B[90mhttps://keta-mcp.ketaops.cc/swagger',
      '│',
      '└  2 server(s)',
      '',
    ].join('\n');

    expect(parseMcpListOutput(raw)).toEqual([
      { serverName: 'gitee-ent', status: 'connected' },
      { serverName: 'swagger', status: 'connected' },
    ]);
  });

  it('✗ failed 行 → failed（失败行不产出额外条目）', () => {
    const raw = [
      '●  ✗ test-bad-local failed',
      '│      Error: command not found: nope',
      '│',
      '●  ✓ ok-server connected',
    ].join('\n');

    expect(parseMcpListOutput(raw)).toEqual([
      { serverName: 'test-bad-local', status: 'failed' },
      { serverName: 'ok-server', status: 'connected' },
    ]);
  });

  it('needs_auth 识别：状态词含 needs auth / unauthorized（OAuth 未授权）', () => {
    expect(parseMcpListOutput('●  ✓ github-remote needs auth\n●  ✓ other unauthorized')).toEqual([
      { serverName: 'github-remote', status: 'needs_auth' },
      { serverName: 'other', status: 'needs_auth' },
    ]);
  });

  it('⚠ 标记行亦识别为 needs_auth（实测 `●  ⚠ <name> needs authentication`）', () => {
    expect(parseMcpListOutput('●  ⚠ oauth-demo needs authentication')).toEqual([
      { serverName: 'oauth-demo', status: 'needs_auth' },
    ]);
  });

  it('disconnected 状态词归 failed（三态模型：非连接即失败）', () => {
    expect(parseMcpListOutput('●  ✗ stale-server disconnected')).toEqual([
      { serverName: 'stale-server', status: 'failed' },
    ]);
  });

  it('非状态行（标题/分隔/命令详情/空行）跳过', () => {
    expect(parseMcpListOutput('┌  MCP Servers\n│\n└  2 server(s)\n\n')).toEqual([]);
  });

  it('ASCII 环境标记 x/! 亦识别为状态行', () => {
    expect(parseMcpListOutput('●  x ascii-fail failed\n●  v ascii-ok connected')).toEqual([
      { serverName: 'ascii-fail', status: 'failed' },
      { serverName: 'ascii-ok', status: 'connected' },
    ]);
  });
});

describe('McpStatusProbe（30s 节流缓存）', () => {
  it('节流窗口内复用缓存，不重复调用 probeFn', () => {
    let calls = 0;
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => {
        calls++;
        return { stdout: '●  ✓ filesystem-demo connected', stderr: '' };
      },
    });

    const first = probe.getStatus();
    const second = probe.getStatus();

    expect(calls).toBe(1);
    expect(first).toEqual([{ serverName: 'filesystem-demo', status: 'connected' }]);
    expect(second).toBe(first);
  });

  it('窗口外重新探测：可注入 fake timers 验证节流过期', () => {
    jest.useFakeTimers();
    let calls = 0;
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => {
        calls++;
        return { stdout: '●  ✓ a connected', stderr: '' };
      },
    });

    probe.getStatus();
    jest.advanceTimersByTime(29_999);
    probe.getStatus();
    expect(calls).toBe(1);

    jest.advanceTimersByTime(2);
    probe.getStatus();
    expect(calls).toBe(2);
    jest.useRealTimers();
  });

  it('探测抛错保留上次结果并告警', () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: jest
        .fn()
        .mockReturnValueOnce({ stdout: '●  ✓ ok connected', stderr: '' })
        .mockImplementation(() => {
          throw new Error('opencode 不存在');
        }),
      logger: { warn },
    });

    const first = probe.getStatus();
    expect(first).toEqual([{ serverName: 'ok', status: 'connected' }]);
    // 越过节流窗口后再次探测触发抛错路径（窗口内直接返回缓存，不会调用 probeFn）
    jest.advanceTimersByTime(30_001);
    const second = probe.getStatus();
    expect(second).toEqual(first);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[mcp-status] 探测失败'),
    );
    jest.useRealTimers();
  });

  it('首次探测失败返回空数组（不抛错，心跳链路不受影响）', () => {
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => {
        throw new Error('spawn ENOENT');
      },
    });

    expect(probe.getStatus()).toEqual([]);
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
  it('内置 vteam failed + 集群内地址 → 输出 WORKER_MCP_URL 引导', () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => ({
        stdout: '●  ✗ vteam failed',
        stderr: '',
      }),
      resolveBuiltinMcpUrl: () => 'http://vteam-server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    probe.getStatus();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[mcp-status] 内置 MCP 不可达'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('http://vteam-server:3000/api/v1/platform-mcp'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('WORKER_MCP_URL'),
    );
  });

  it('存量旧名 keta-platform failed 亦触发（改名迁移兼容）', () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => ({ stdout: '●  ✗ keta-platform failed', stderr: '' }),
      resolveBuiltinMcpUrl: () => 'http://server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    probe.getStatus();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WORKER_MCP_URL'));
  });

  it('内置 MCP 地址为外部可达地址时不告警（不打扰）', () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => ({ stdout: '●  ✗ vteam failed', stderr: '' }),
      resolveBuiltinMcpUrl: () => 'http://mcp.example.com/api/v1/platform-mcp',
      logger: { warn },
    });

    probe.getStatus();
    expect(warn).not.toHaveBeenCalled();
  });

  it('内置 MCP connected 不告警', () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => ({ stdout: '●  ✓ vteam connected', stderr: '' }),
      resolveBuiltinMcpUrl: () => 'http://vteam-server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    probe.getStatus();
    expect(warn).not.toHaveBeenCalled();
  });

  it('非内置 server failed 不告警', () => {
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => ({ stdout: '●  ✗ gitee-ent failed', stderr: '' }),
      resolveBuiltinMcpUrl: () => 'http://vteam-server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    probe.getStatus();
    expect(warn).not.toHaveBeenCalled();
  });

  it('节流窗口内复用缓存不重复告警', () => {
    jest.useFakeTimers();
    const warn = jest.fn();
    const probe = new McpStatusProbe({
      throttleMs: 30_000,
      probeFn: () => ({ stdout: '●  ✗ vteam failed', stderr: '' }),
      resolveBuiltinMcpUrl: () => 'http://vteam-server:3000/api/v1/platform-mcp',
      logger: { warn },
    });

    probe.getStatus();
    probe.getStatus();
    jest.advanceTimersByTime(29_999);
    probe.getStatus();
    expect(warn).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('默认 resolver 从 <cwd>/opencode.json 读取实际注入地址', () => {
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
        probeFn: () => ({ stdout: '●  ✗ vteam failed', stderr: '' }),
        logger: { warn },
      });

      probe.getStatus();
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
