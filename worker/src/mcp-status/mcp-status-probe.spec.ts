/**
 * T8c MCP 三态探测器单测：
 * - parseMcpListOutput：三态识别（connected/failed/needs_auth）+ ANSI 剥离 +
 *   failed 错误行 + 非状态行跳过
 * - McpStatusProbe：30s 节流缓存（窗口内复用）、探测失败保留上次结果、
 *   probeFn 注入、默认 spawnSync 形态
 */
import { McpStatusProbe, parseMcpListOutput, stripAnsi } from './mcp-status-probe';

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
