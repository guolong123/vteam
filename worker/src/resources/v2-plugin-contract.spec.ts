/**
 * T19 契约测试：生成的**插件模块**在**真实 opencode v2 serve** 下被加载并被模型直接调用。
 *
 * 覆盖计划 T19 的验收标准 1/2/8：
 * - 产物形态：`.opencode/plugins/<name>.ts`（v2 的插件发现路径）；
 * - 插件被加载（判据 = serve 日志的 `msg="loading plugin"` 行；⚠️ `GET /api/plugin` 不可靠）；
 * - 工具出现在**模型请求的 `tools[]`** 里（= 模型能直接 `tool_calls`，不经 Code Mode）；
 * - 工具被真正调用（`session.tool.called` + `session.tool.success` 事件）；
 * - **`options: { codemode: false }` 的必要性**：不带该选项的工具**不进** `tools[]`，
 *   只出现在 system 的 Code Mode 目录里（模型无法直接调用）。
 *
 * 无 opencode 二进制 / 无 mock provider 时**整组跳过**（不失败）——CI 没装二进制时
 * 这条契约测试形同虚设，但也不能因此把构建打红。
 */

import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { renderCustomToolPlugin } from './custom-tool';
import { renderBrowserToolsFile } from '../browser/browser-tools';
import { renderGitToolsFile } from '../git/git-tools';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MOCK_PROVIDER = path.join(
  REPO_ROOT,
  'docs/agent-platform/opencode-v2-spike-results/mock-provider.mjs',
);

/** 真实 opencode 二进制候选路径（env 优先）。 */
function resolveOpencodeBin(): string | null {
  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(os.homedir(), '.opencode/bin/opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 试下一个
    }
  }
  return null;
}

const OPENCODE_BIN = resolveOpencodeBin();
const SKIP_REASON = !OPENCODE_BIN
  ? '未找到 opencode 二进制（设置 OPENCODE_BIN 或安装到 ~/.opencode/bin/opencode）'
  : !fs.existsSync(MOCK_PROVIDER)
    ? `未找到 mock provider（${MOCK_PROVIDER}）`
    : null;

/** 探一个空闲端口（先占再放，避免与并行测试撞端口）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basicAuthHeader(user: string, password: string): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  };
}

function httpJson(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          ...headers,
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = undefined;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 打开 SSE 连接并持续收集原始帧。 */
function openEventStream(
  port: number,
  headers: Record<string, string>,
  onChunk: (text: string) => void,
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/event', headers },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => onChunk(chunk));
        resolve({
          close: () => {
            req.destroy();
          },
        });
      },
    );
    req.on('error', reject);
  });
}

/** 生成的探针插件（code execution，无外部二进制依赖）。 */
function renderProbePlugin(fileName: string): string {
  return renderCustomToolPlugin({
    fileName,
    exports: [
      {
        exportName: 'default',
        description: `T19 probe tool (${fileName})`,
        args: [{ name: 'jobName', type: 'string', required: true, description: '任务名' }],
        execute: { type: 'code', code: 'return "VTEAM_T19_OK:" + JSON.stringify(args);' },
      },
    ],
  });
}

/** 去掉 `options: { codemode: false }` → 造一个「只能经 Code Mode 调用」的对照组。 */
function withoutCodemodeOption(source: string): string {
  return source.replace(/^\s*options: \{ codemode: false \},\n/m, '');
}

const describeMaybe = SKIP_REASON ? describe.skip : describe;

describeMaybe('T19 生成插件的真实 v2 serve 契约', () => {
  jest.setTimeout(240_000);

  it('插件被加载、工具进 tools[]、被模型直接调用；不带 codemode:false 则只进 Code Mode 目录', async () => {
    const bin = OPENCODE_BIN!;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-t19-v2-'));
    const projectDir = path.join(scratch, 'proj');
    const pluginDir = path.join(projectDir, '.opencode', 'plugins');
    const isoRoot = path.join(scratch, 'iso');
    fs.mkdirSync(pluginDir, { recursive: true });
    for (const sub of ['home', 'config', 'data', 'state', 'cache']) {
      fs.mkdirSync(path.join(isoRoot, sub), { recursive: true });
    }

    const directName = 't19-direct';
    const codemodeName = 't19-codemode';
    fs.writeFileSync(
      path.join(pluginDir, `${directName}.ts`),
      renderProbePlugin(directName),
      'utf8',
    );
    fs.writeFileSync(
      path.join(pluginDir, `${codemodeName}.ts`),
      withoutCodemodeOption(renderProbePlugin(codemodeName)),
      'utf8',
    );
    // 平台自己的 browser 工具（agent-browser）——与 v2 内置浏览器插件同名，必须靠
    // `plugins: ["-opencode.browser"]` 让位，否则会被**静默遮蔽**（不进 tools[]）。
    fs.writeFileSync(path.join(pluginDir, 'browser.ts'), renderBrowserToolsFile(), 'utf8');

    const mockPort = await freePort();
    const servePort = await freePort();
    const requestsOut = path.join(scratch, 'requests.jsonl');
    fs.writeFileSync(
      path.join(projectDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'spike-mock/spike-model',
        plugins: ['-opencode.browser'],
        providers: {
          'spike-mock': {
            name: 'Spike Mock',
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: `http://127.0.0.1:${mockPort}/v1` },
            models: {
              'spike-model': {
                name: 'spike-model',
                capabilities: { tools: true, input: ['text'], output: ['text'] },
                limit: { context: 8192, output: 1024 },
              },
            },
          },
        },
      }),
      'utf8',
    );

    const password = 't19-contract-pass';
    const headers = basicAuthHeader('opencode', password);
    let mock: ReturnType<typeof spawn> | undefined;
    let serve: ReturnType<typeof spawn> | undefined;
    let sseText = '';
    let closeSse: (() => void) | undefined;

    try {
      mock = spawn(process.execPath, [MOCK_PROVIDER], {
        env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_OUT: requestsOut },
        stdio: 'ignore',
      });
      await sleep(800);

      // 隔离 env：宿主机的全局配置/凭据不在作用域内（T16b 的口径）
      const serveEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: path.join(isoRoot, 'home'),
        XDG_CONFIG_HOME: path.join(isoRoot, 'config'),
        XDG_DATA_HOME: path.join(isoRoot, 'data'),
        XDG_STATE_HOME: path.join(isoRoot, 'state'),
        XDG_CACHE_HOME: path.join(isoRoot, 'cache'),
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: 'opencode',
      };
      const serveLog = path.join(scratch, 'serve.log');
      const logFd = fs.openSync(serveLog, 'w');
      serve = spawn(
        bin,
        ['serve', '--port', String(servePort), '--hostname', '127.0.0.1', '--print-logs', '--log-level', 'debug'],
        { cwd: projectDir, env: serveEnv, stdio: ['ignore', logFd, logFd] },
      );

      // 等 serve 起来（插件发现是按 location 惰性触发 → 必须先建会话）
      let sessionId = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(500);
        try {
          const created = await httpJson(
            servePort,
            'POST',
            '/api/session',
            headers,
            { location: { directory: projectDir } },
          );
          if (created.status === 200 && created.json?.data?.id) {
            sessionId = created.json.data.id as string;
            break;
          }
        } catch {
          // serve 还没起来
        }
      }
      expect(sessionId).not.toBe('');

      const stream = await openEventStream(servePort, headers, (chunk) => {
        sseText += chunk;
      });
      closeSse = stream.close;

      await sleep(2000);
      await httpJson(servePort, 'POST', `/api/session/${sessionId}/prompt`, headers, {
        text: `T19 __TOOL__:${directName}:{"jobName":"probe-1"}`,
      });

      // 插件 setup 是异步的、模型请求有延迟 → 等够时间再断言（否则假阴性）
      let requestBodies: any[] = [];
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(500);
        if (fs.existsSync(requestsOut)) {
          requestBodies = fs
            .readFileSync(requestsOut, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line));
        }
        if (requestBodies.some((r) => (r.body?.tools ?? []).length > 0)) break;
      }

      const log = fs.readFileSync(serveLog, 'utf8');
      expect(log).toContain('loading plugin');
      expect(log).toContain(`${directName}.ts`);

      const withTools = requestBodies.find((r) => (r.body?.tools ?? []).length > 0);
      expect(withTools).toBeDefined();
      const toolNames: string[] = (withTools.body.tools ?? []).map(
        (t: any) => t?.function?.name ?? t?.name,
      );
      // 直接工具进 tools[]（模型可直接 tool_calls）
      expect(toolNames).toContain(directName);
      // 不带 codemode:false 的工具**不进** tools[]（只在 Code Mode 目录里）
      expect(toolNames).not.toContain(codemodeName);
      // 平台自己的 browser 工具（与 v2 内置浏览器插件同名）：禁用内置插件后正常进 tools[]
      expect(toolNames).toContain('browser');

      const systemText = (withTools.body.messages ?? [])
        .filter((m: any) => m?.role === 'system')
        .map((m: any) => JSON.stringify(m.content ?? ''))
        .join('\n');
      expect(systemText).toContain(codemodeName);
      expect(systemText).not.toContain(directName);

      // 工具被真正调用
      await sleep(2000);
      expect(sseText).toContain('session.tool.called');
      expect(sseText).toContain('session.tool.success');
      expect(sseText).toContain(directName);
      expect(sseText).toContain('VTEAM_T19_OK');
    } finally {
      closeSse?.();
      serve?.kill('SIGTERM');
      mock?.kill('SIGTERM');
      await sleep(500);
      serve?.kill('SIGKILL');
      mock?.kill('SIGKILL');
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('生成的产物能被 tsc 编译（编译期检查：类型错必须构建失败）', () => {
    const pluginTypes = path.join(REPO_ROOT, '.opencode/node_modules/@opencode/plugin');
    if (!fs.existsSync(pluginTypes)) {
      // 未安装类型依赖（例如 CI 未跑 npm install）→ 跳过，不阻塞构建
      return;
    }
    const scratch = path.join(REPO_ROOT, '.opencode', `.t19-typecheck-${process.pid}`);
    fs.mkdirSync(scratch, { recursive: true });
    const tsc = path.join(REPO_ROOT, '.opencode/node_modules/typescript/bin/tsc');
    const typeRoots = path.join(REPO_ROOT, '.opencode/node_modules/@types');
    const run = (files: string[], extraArgs: string[]): string => {
      const result = spawnSync(
        process.execPath,
        [
          tsc,
          '--noEmit',
          '--target',
          'ES2022',
          '--module',
          'esnext',
          '--moduleResolution',
          'bundler',
          '--skipLibCheck',
          '--typeRoots',
          typeRoots,
          ...extraArgs,
          ...files.map((f) => path.join(scratch, f)),
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      return `${result.stdout}\n${result.stderr}`;
    };
    try {
      fs.writeFileSync(path.join(scratch, 'probe.ts'), renderProbePlugin('t19-typecheck'), 'utf8');
      fs.writeFileSync(path.join(scratch, 'browser.ts'), renderBrowserToolsFile(), 'utf8');
      fs.writeFileSync(path.join(scratch, 'git.ts'), renderGitToolsFile(), 'utf8');
      // 自定义工具与 browser 插件：源码即 TS → 走严格模式
      expect(run(['probe.ts', 'browser.ts'], ['--strict'])).not.toMatch(/error TS/);
      // git 插件：凭证辅助函数是 toString() 内联的 JS（TS 注解在编译期已抹掉）→
      // 隐式 any 无法避免，故关掉 noImplicitAny；其余类型错误仍会 fail。
      expect(run(['git.ts'], ['--noImplicitAny', 'false'])).not.toMatch(/error TS/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
