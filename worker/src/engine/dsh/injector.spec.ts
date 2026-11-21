/**
 * dsh 注入器：**平台注册的 MCP 必须下发到 patch**（本轮修复的回归闸门）。
 *
 * ── 为什么这些断言必须有 ──────────────────────────────────────────────
 * 此前的实现只挂一条内置 `platformMcpUrl`，`snapshot.mcpServers` 与
 * `GET /mcp-servers` **都没人读** ⇒ 用户在「MCP 服务器」页注册的条目在 dsh worker
 * 上永远不会出现在 patch 里，agent 看不到工具，且 worker/server 两侧**零报错**。
 * 这类"少写几行 YAML"的缺口没法靠界面发现，只能靠这里钉死。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DshResourceInjector } from './injector';
import type { EngineConfigSnapshot } from '../types';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function workDirFor(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inject-spec-'));
}

function snapshotOf(overrides: Partial<EngineConfigSnapshot> = {}): EngineConfigSnapshot {
  return {
    workDir: '/tmp/unused',
    skills: [],
    tools: [],
    mcpServers: [],
    agentPolicies: [],
    modelCredentials: [
      { providerID: 'deepseek-official', modelID: 'deepseek-v4-flash', apiKey: 'k' },
    ],
    ...overrides,
  };
}

/** 按 URL 路由的 mock fetch（仅 `/mcp-servers` 被用到）。 */
function makeFetch(items: unknown[], total = items.length): jest.Mock {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/v1/mcp-servers') {
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ items, total, page: 1, pageSize: 100 }),
    } as unknown as Response;
  });
}

function readPatch(workDir: string): string {
  return fs.readFileSync(path.join(workDir, '.vteam', 'dsh-profile.patch.yml'), 'utf8');
}

describe('DshResourceInjector：平台 MCP 注册表下发', () => {
  it('注册表里的 remote MCP → patch 里出现 dsh-mcp-client 挂载（insert: 形态）', async () => {
    const workDir = workDirFor();
    const injector = new DshResourceInjector({
      mcpRegistry: {
        serverUrl: 'http://server:3000',
        workerToken: 'tok',
        workerId: 'w_test',
        fetchImpl: makeFetch([
          {
            id: 'ms_1',
            name: 'gitee-ent',
            type: 'remote',
            url: 'https://mcp.example.com/sse',
            headers: { Authorization: 'Bearer abc' },
            command: null,
            oauth: null,
            enabled: true,
          },
        ]) as unknown as typeof fetch,
      },
      logger: silent,
    });

    await injector.apply(snapshotOf({ workDir }), workDir);
    const patch = readPatch(workDir);

    // 必须是 insert: 包裹的新增条目（P0 实测：平铺会被当成"修改已有 id"并静默跳过）
    expect(patch).toContain('- insert:');
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain("serverName: 'gitee-ent'");
    expect(patch).toContain("transport: 'streamable-http'");
    expect(patch).toContain("url: 'https://mcp.example.com/sse'");
    expect(patch).toContain('Authorization: ');
    // ⚠️ 第三方 MCP 必须**软失败**：设 true 会让 dsh 的 loader 因这一条不可达
    // 而拒绝启动整个运行时（实测：一条 DNS 失败 ⇒ worker 完全没有 agent）
    const echoBlock = patch.slice(patch.indexOf("serverName: 'gitee-ent'"));
    expect(echoBlock).toContain('failOnStartupError: false');
  });

  it('local MCP：command 数组首元拆成 command，余元进 args（dsh 是两字段形态）', async () => {
    const workDir = workDirFor();
    const injector = new DshResourceInjector({
      mcpRegistry: {
        serverUrl: 'http://server:3000',
        workerToken: 'tok',
        workerId: 'w_test',
        fetchImpl: makeFetch([
          {
            id: 'ms_2',
            name: 'gitlab-local',
            type: 'local',
            command: {
              command: ['npx', '-y', '@some/mcp-gitlab', '--stdio'],
              cwd: '/srv/gitlab',
              environment: { GITLAB_TOKEN: 'secret', IGNORED: 42 },
            },
            url: null,
            headers: null,
            oauth: null,
            enabled: true,
          },
        ]) as unknown as typeof fetch,
      },
      logger: silent,
    });

    await injector.apply(snapshotOf({ workDir }), workDir);
    const patch = readPatch(workDir);

    expect(patch).toContain("serverName: 'gitlab-local'");
    expect(patch).toContain("transport: 'stdio'");
    expect(patch).toContain("command: 'npx'");
    expect(patch).toContain("- '-y'");
    expect(patch).toContain("- '@some/mcp-gitlab'");
    expect(patch).toContain("cwd: '/srv/gitlab'");
    expect(patch).toContain('GITLAB_TOKEN: ');
    // 非字符串 env 值必须被丢掉（dsh 的 env 是 z.dict(String)，混入数字会整条配置校验失败）
    expect(patch).not.toContain('IGNORED');
  });

  it('headers 里的 {env:...} 模板被解析（否则把字面量发出去 ⇒ 401）', async () => {
    const workDir = workDirFor();
    const injector = new DshResourceInjector({
      mcpRegistry: {
        serverUrl: 'http://server:3000',
        workerToken: 'tok-123',
        workerId: 'w_abc',
        fetchImpl: makeFetch([
          {
            id: 'ms_3',
            name: 'platform-alias',
            type: 'remote',
            url: 'https://mcp.example.com/sse',
            headers: {
              'x-worker-token': '{env:X_WORKER_TOKEN}',
              'x-worker-id': '{env:WORKER_ID}',
            },
            command: null,
            oauth: null,
            enabled: true,
          },
        ]) as unknown as typeof fetch,
      },
      logger: silent,
    });

    await injector.apply(snapshotOf({ workDir }), workDir);
    const patch = readPatch(workDir);

    expect(patch).toContain("x-worker-token: 'tok-123'");
    expect(patch).toContain("x-worker-id: 'w_abc'");
    expect(patch).not.toContain('{env:');
  });

  it('snapshot.mcpServers 也被接受（引擎无关快照通道不能是"只取凭据"）', async () => {
    const workDir = workDirFor();
    const injector = new DshResourceInjector({ logger: silent });

    await injector.apply(
      snapshotOf({
        workDir,
        mcpServers: [
          {
            name: 'from-snapshot',
            transport: 'streamable-http',
            url: 'https://snapshot.example.com/mcp',
          },
        ],
      }),
      workDir,
    );

    const patch = readPatch(workDir);
    expect(patch).toContain("serverName: 'from-snapshot'");
    expect(patch).toContain("url: 'https://snapshot.example.com/mcp'");
  });

  it('拉取失败 → 抛错（调用方保留旧 patch），且不写出"少几个 MCP"的半份 patch', async () => {
    const workDir = workDirFor();
    const injector = new DshResourceInjector({
      mcpRegistry: {
        serverUrl: 'http://server:3000',
        workerToken: 'tok',
        workerId: 'w_test',
        fetchImpl: jest.fn(async () => ({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({}),
        })) as unknown as typeof fetch,
      },
      logger: silent,
    });

    await expect(injector.apply(snapshotOf({ workDir }), workDir)).rejects.toThrow(/mcp-servers/);
    // 原子写：失败 ⇒ 磁盘上不应出现 patch
    expect(fs.existsSync(path.join(workDir, '.vteam', 'dsh-profile.patch.yml'))).toBe(false);
  });

  it('内置平台 MCP 与注册表条目合并（同名以注册表为准，vteam 不重复两条）', async () => {
    const workDir = workDirFor();
    const injector = new DshResourceInjector({
      platformMcpUrl: 'http://fallback:3000/api/v1/platform-mcp',
      platformMcpHeaders: { 'X-Worker-Token': 'tok' },
      mcpRegistry: {
        serverUrl: 'http://server:3000',
        workerToken: 'tok',
        workerId: 'w_test',
        fetchImpl: makeFetch([
          {
            id: 'ms_vteam',
            name: 'vteam',
            type: 'remote',
            // server 按 x-worker-id 覆盖成该 worker 可达的地址
            url: 'http://server:3000/api/v1/platform-mcp',
            headers: null,
            command: null,
            oauth: null,
            enabled: true,
          },
          {
            id: 'ms_4',
            name: 'gitee-ent',
            type: 'remote',
            url: 'https://mcp.example.com/sse',
            headers: null,
            command: null,
            oauth: null,
            enabled: true,
          },
        ]) as unknown as typeof fetch,
      },
      logger: silent,
    });

    await injector.apply(snapshotOf({ workDir }), workDir);
    const patch = readPatch(workDir);

    expect(patch.match(/serverName: 'vteam'/g)).toHaveLength(1);
    expect(patch).toContain("serverName: 'gitee-ent'");
    // vteam 条目必须带超时下限（secret_command 最坏 855s，缺省 60s 会被掐断）
    expect(patch).toContain('toolCallTimeoutMs: 900000');
  });

  it('只有内置 vteam 硬失败，第三方条目不阻断运行时启动', async () => {
    const workDir = workDirFor();
    const injector = new DshResourceInjector({
      platformMcpUrl: 'http://server:3000/api/v1/platform-mcp',
      platformMcpHeaders: { 'X-Worker-Token': 'tok' },
      mcpRegistry: {
        serverUrl: 'http://server:3000',
        workerToken: 'tok',
        workerId: 'w_test',
        fetchImpl: makeFetch([
          {
            id: 'ms_unreachable',
            name: 'third-party-down',
            type: 'remote',
            // 真实事故形态：一条 DNS 不可达的第三方 MCP
            url: 'https://mcp.example.invalid/echo',
            command: null,
            headers: null,
            oauth: null,
          },
        ]) as unknown as typeof fetch,
      },
      logger: silent,
    });

    await injector.apply(snapshotOf({ workDir }), workDir);
    const patch = readPatch(workDir);

    const vteamBlock = patch.slice(patch.indexOf("serverName: 'vteam'"));
    const thirdBlock = patch.slice(patch.indexOf("serverName: 'third-party-down'"));
    // vteam 不通 ⇒ agent 只会"假装工作"（核心协作工具全丢）⇒ 必须硬失败暴露
    expect(vteamBlock).toContain('failOnStartupError: true');
    // 第三方不通 ⇒ 只少了它的工具，**不许**把整台 worker 拖死
    expect(thirdBlock).toContain('failOnStartupError: false');
  });

  it('配置不完整的条目被跳过（缺 url 的 remote / 空 command 的 local），不污染 patch', async () => {
    const workDir = workDirFor();
    const warn = jest.fn();
    const injector = new DshResourceInjector({
      mcpRegistry: {
        serverUrl: 'http://server:3000',
        workerToken: 'tok',
        workerId: 'w_test',
        fetchImpl: makeFetch([
          { id: 'ms_5', name: 'bad-remote', type: 'remote', url: '', command: null, headers: null, oauth: null },
          { id: 'ms_6', name: 'bad-local', type: 'local', url: null, command: { command: [] }, headers: null, oauth: null },
          {
            id: 'ms_7',
            name: 'ok-remote',
            type: 'remote',
            url: 'https://ok.example.com/mcp',
            command: null,
            headers: null,
            oauth: null,
          },
        ]) as unknown as typeof fetch,
      },
      logger: { ...silent, warn },
    });

    await injector.apply(snapshotOf({ workDir }), workDir);
    const patch = readPatch(workDir);

    expect(patch).toContain("serverName: 'ok-remote'");
    expect(patch).not.toContain('bad-remote');
    expect(patch).not.toContain('bad-local');
    expect(warn).toHaveBeenCalled();
  });

  it('currentSignature：内容变化才变（供运行时判断"要不要重建"）', async () => {
    const workDir = workDirFor();
    let items: unknown[] = [];
    const injector = new DshResourceInjector({
      mcpRegistry: {
        serverUrl: 'http://server:3000',
        workerToken: 'tok',
        workerId: 'w_test',
        // 每次调用都读当前 items ⇒ 模拟平台侧新增一条 MCP
        fetchImpl: jest.fn(async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ items, total: items.length, page: 1, pageSize: 100 }),
        })) as unknown as typeof fetch,
      },
      logger: silent,
    });

    await injector.apply(snapshotOf({ workDir }), workDir);
    const first = injector.currentSignature;
    expect(first).toMatch(/^[0-9a-f]{16}$/);

    // 内容未变 ⇒ 签名不变（幂等轮次不该触发运行时重建）
    await injector.apply(snapshotOf({ workDir }), workDir);
    expect(injector.currentSignature).toBe(first);

    // 平台新增一条 MCP ⇒ 签名必须变
    items = [
      {
        id: 'ms_8',
        name: 'new-one',
        type: 'remote',
        url: 'https://new.example.com/mcp',
        command: null,
        headers: null,
        oauth: null,
      },
    ];
    await injector.apply(snapshotOf({ workDir }), workDir);
    expect(injector.currentSignature).not.toBe(first);
    expect(readPatch(workDir)).toContain("serverName: 'new-one'");
  });
});
