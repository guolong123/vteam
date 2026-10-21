/**
 * T15 契约层：注入器产出的 `<workDir>/opencode.json` 被**真 opencode v2** 加载时的行为。
 *
 * 为什么要有这一层：v2 接受 v1 形配置并**静默归一化**，"看着对"不等于"生效"：
 * - 硬闸门：**serve 日志里不得出现 `configuration normalization diagnostic`**（D12 铁律）；
 * - 角色提示闸门：回显里 `agents.<n>.system` 内容**完整**、且**没有 `prompt` 键**
 *   （v2 原生 `agents:` 节里的 `prompt` 是未知键 → **被静默丢弃、无任何告警**——
 *   实测：半改名配置既不报错也不产生诊断，只有回显里少一段提示）；
 * - 权限闸门：`permissions[]` 的**极性**原样（ask 仍是 ask、deny 仍是 deny）；
 * - MCP 闸门：`mcp.servers.<n>.disabled` 极性正确、`timeout` **三段齐全**
 *   （v1 单值归一化会**丢 `startup` 段**）。
 *
 * 真二进制不在时**整组跳过**（CI 镜像未必装 opencode）——与 `v2-driver.spec.ts` 的契约层同款。
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRandomFreePort } from '../runtime/port-probe';
import { ResourceInjector } from './injector';

/** 找 opencode v2 二进制：环境变量 → 固定路径。 */
function findOpencodeBinary(): string | null {
  const candidates = [
    process.env.OPENCODE_BIN,
    '/Users/mac/.opencode/bin/opencode',
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ].filter((value): value is string => typeof value === 'string' && value !== '');
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // 忽略
    }
  }
  return null;
}

const opencodeBinary = findOpencodeBinary();
const describeReal = opencodeBinary ? describe : describe.skip;

/** v2 的 `GET /api/config` 回显：配置文档数组（实测 2.0.28）。 */
interface ConfigDocument {
  type: string;
  path?: string;
  info?: Record<string, any>;
}

const PASSWORD = 't15-contract-test-pw';

/** 造一份"控制面下发"负载（mcp + agent 策略），走**真实注入器**产出 opencode.json。 */
function makeControlPlaneFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const body =
      url.pathname === '/api/v1/mcp-servers'
        ? {
            items: [
              {
                id: 'ms_1',
                name: 'vteam',
                type: 'remote',
                command: null,
                url: 'https://vteam.example.com/api/v1/platform-mcp',
                headers: null,
                oauth: null,
                enabled: true,
                timeout: 8000,
              },
              {
                id: 'ms_2',
                name: 'filesystem',
                type: 'local',
                command: { command: ['/bin/echo', 'ok'] },
                url: null,
                headers: null,
                oauth: null,
                enabled: true,
              },
              {
                id: 'ms_0',
                name: 'remote-1',
                type: 'remote',
                command: null,
                url: 'https://remote.example.com/mcp',
                headers: null,
                oauth: null,
                enabled: true,
                timeout: 8000,
              },
            ],
            total: 3,
            page: 1,
            pageSize: 100,
          }
        : url.pathname === '/api/v1/agent-policies'
          ? {
              agents: [
                {
                  name: 'vteam-developer',
                  description: 'dev scope',
                  mode: 'primary',
                  permission: {
                    edit: { '*': 'deny', '**/tasks/*/docs/**': 'allow' },
                    read: { '*': 'allow' },
                    bash: 'ask',
                    task: 'deny',
                  },
                  prompt: 'ROLE_PROMPT_MARKER',
                },
              ],
            }
          : { items: [], total: 0, page: 1, pageSize: 100 };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describeReal('注入的 opencode.json 被真 opencode v2 加载（T15 硬闸门）', () => {
  jest.setTimeout(120_000);

  let projectDir: string;
  let isoHome: string;
  let child: ChildProcess;
  let log = '';
  let baseUrl: string;
  let configDocs: ConfigDocument[];

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 't15-v2-contract-'));
    isoHome = fs.mkdtempSync(path.join(os.tmpdir(), 't15-v2-home-'));
    const injector = new ResourceInjector({
      serverUrl: 'http://localhost:3000',
      workerToken: 'tok',
      workerId: 'w_t15',
      workDir: projectDir,
      fetchImpl: makeControlPlaneFetch(),
    });
    await injector.injectAll();

    const port = await getRandomFreePort();
    child = spawn(
      opencodeBinary as string,
      ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: projectDir,
        env: {
          ...process.env,
          HOME: isoHome,
          XDG_CONFIG_HOME: path.join(isoHome, '.config'),
          XDG_DATA_HOME: path.join(isoHome, '.local', 'share'),
          XDG_STATE_HOME: path.join(isoHome, '.local', 'state'),
          XDG_CACHE_HOME: path.join(isoHome, '.cache'),
          OPENCODE_SERVER_PASSWORD: PASSWORD,
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    baseUrl = await new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + 60_000;
      const timer = setInterval(() => {
        const match = /listening on http:\/\/[^:\s/]+:(\d+)/.exec(log);
        if (match) {
          clearInterval(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
          return;
        }
        if (child.exitCode !== null) {
          clearInterval(timer);
          reject(new Error(`opencode serve 提前退出（exit=${child.exitCode}）:\n${log}`));
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`opencode serve 启动超时:\n${log}`));
        }
      }, 100);
    });
    const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
    const res = await fetch(`${baseUrl}/api/config`, { headers: { Authorization: auth } });
    configDocs = (await res.json()) as ConfigDocument[];
  });

  afterAll(async () => {
    const pid = child?.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // 已退出
      }
    }
    for (const dir of [projectDir, isoHome]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
  });

  /** 注入器产出的那份配置（项目 opencode.json）在 v2 里的回显。 */
  function echoedProjectConfig(): Record<string, any> {
    const doc = configDocs.find(
      (item) => item.type === 'document' && (item.path ?? '').endsWith('opencode.json'),
    );
    expect(doc).toBeDefined();
    return (doc as ConfigDocument).info as Record<string, any>;
  }

  it('**硬闸门**：serve 日志里没有 `configuration normalization diagnostic`', () => {
    expect(log).not.toContain('configuration normalization diagnostic');
  });

  it('**角色提示闸门**：回显里 `agents.<n>.system` 内容完整、且**没有 `prompt` 键**', () => {
    const info = echoedProjectConfig();
    expect(info.agents['vteam-developer'].system).toBe('ROLE_PROMPT_MARKER');
    expect(Object.keys(info.agents['vteam-developer'])).not.toContain('prompt');
  });

  it('**权限闸门**：`permissions[]` 原样回显，极性不变（ask 仍 ask、deny 仍 deny）', () => {
    const info = echoedProjectConfig();
    expect(info.agents['vteam-developer'].permissions).toEqual([
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '**/tasks/*/docs/**', effect: 'allow' },
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
    ]);
  });

  it('**MCP 闸门**：`mcp.servers.<n>` 存在、`disabled` 极性正确、`timeout` **三段齐全**', () => {
    const info = echoedProjectConfig();
    expect(info.mcp.servers.remote_1 ?? info.mcp.servers['remote-1']).toBeDefined();
    expect(info.mcp.servers['remote-1'].disabled).toBe(false);
    expect(info.mcp.servers['remote-1'].timeout).toEqual({
      startup: 8000,
      catalog: 8000,
      execution: 8000,
    });
    // vteam 远端条目走 secret_command 的 900s 下限（三段同值）
    expect(info.mcp.servers.vteam.timeout).toEqual({
      startup: 900000,
      catalog: 900000,
      execution: 900000,
    });
    expect(info.mcp.servers.filesystem.command).toEqual(['/bin/echo', 'ok']);
  });

  it('**段名闸门**：回显里只有 v2 段名（agents / mcp.servers / plugins），无 v1 段名', () => {
    const info = echoedProjectConfig();
    expect(info.agent).toBeUndefined();
    expect(info.plugin).toBeUndefined();
    expect(info.agents).toBeDefined();
    expect(info.mcp.servers).toBeDefined();
    expect(info.plugins).toEqual(['oh-my-openagent@latest', '-opencode.browser']);
  });
});
