/**
 * D6 候选 (f) 的**真 v2 serve** 契约测试：逐消息 system blob 真的进**模型请求的
 * system 段**（而不是 user 段的文本前缀）。
 *
 * 断言三件事（都是**证据**，不是推断）：
 * 1. blob 出现在**最终模型请求的 system 段**里（mock provider 记录了每一次请求体）；
 * 2. blob **不**出现在 user 段里（文本前缀兜底没有生效 ⇒ 两条路互斥）；
 * 3. 同一会话的**第二次**派发（同一个 blob）→ 模型请求里的 blob **逐字节相同**
 *    （交接文件写一次、读多次 ⇒ provider 侧的 prompt 前缀缓存不受影响）。
 *
 * 约束：**无凭据、无额度**——模型由仓库内的 mock provider 应答
 * （`docs/agent-platform/opencode-v2-spike-results/mock-provider.mjs`）；serve 跑在
 * **隔离配置域**里（宿主机的全局配置/凭据/插件一律不在作用域内）。
 *
 * 默认**跳过**：设 `VTEAM_REALSTACK_SMOKE=1` 才跑（与仓库既有真栈冒烟同一个开关）；
 * 跳过时必须打一条显式标记（不允许静默跳过）。
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { V2Driver } from './v2-driver';
import {
  SystemHandoffStore,
  installSystemHandoffPlugin,
  renderSystemHandoffPlugin,
  resolveSystemHandoffDir,
} from './v2-system-handoff';

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
const ENABLED = process.env.VTEAM_REALSTACK_SMOKE === '1';
const SKIP_REASON = !ENABLED
  ? '未设置 VTEAM_REALSTACK_SMOKE=1（真栈契约测试默认跳过：需要真实 opencode v2 二进制）'
  : !OPENCODE_BIN
    ? '未找到 opencode 二进制（设置 OPENCODE_BIN 或安装到 ~/.opencode/bin/opencode）'
    : !fs.existsSync(MOCK_PROVIDER)
      ? `未找到 mock provider（${MOCK_PROVIDER}）`
      : null;

const describeMaybe = SKIP_REASON ? describe.skip : describe;

/** 逐消息 blob 的标记（必须出现在模型请求的 **system** 段，不在 user 段）。 */
const BLOB_MARKER = 'SYSTEM_BLOB_MARKER_VTEAM_HANDOFF';
/** 用户正文标记（用于从记录到的请求里挑出"主请求"）。 */
const USER_MARKER = 'USER_TEXT_MARKER_VTEAM_HANDOFF';

interface RecordedModelRequest {
  n: number;
  headers: Record<string, string>;
  body: {
    model?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
    tools?: unknown[];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 探一个空闲端口。 */
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

/** 一次模型请求里的 system 文本（把所有 system 消息拼起来）。 */
function systemTextOf(request: RecordedModelRequest): string {
  return (request.body.messages ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n');
}

/** 一次模型请求里的 user 文本（把所有 user 消息拼起来）。 */
function userTextOf(request: RecordedModelRequest): string {
  return (request.body.messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n');
}

/**
 * 标题生成请求的判据。
 *
 * ⚠️ `context` hook **只作用于 primary 请求**（标题/压缩/生成各有自己的 hook——T4 实测）⇒
 * 标题请求的 system 段里**不会**有 blob（那是上游既有行为，不是本方案的缺陷）。
 */
function isTitleRequest(request: RecordedModelRequest): boolean {
  return /title generator/i.test(systemTextOf(request));
}

function readRecorded(requestsOut: string): RecordedModelRequest[] {
  if (!fs.existsSync(requestsOut)) {
    return [];
  }
  return fs
    .readFileSync(requestsOut, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedModelRequest);
}

describeMaybe('D6 (f) 真 v2 serve：逐消息 blob 进模型请求的 system 段', () => {
  jest.setTimeout(240_000);

  it('blob 在 system 段、不在 user 段；同一会话第二次派发时 blob 逐字节相同', async () => {
    const bin = OPENCODE_BIN!;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-handoff-real-'));
    const projectDir = path.join(scratch, 'proj');
    const taskDir = path.join(projectDir, 'teams', 'tm_test');
    const isoRoot = path.join(scratch, 'iso');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    for (const sub of ['home', 'config', 'data', 'state', 'cache']) {
      fs.mkdirSync(path.join(isoRoot, sub), { recursive: true });
    }

    const mockPort = await freePort();
    const servePort = await freePort();
    const requestsOut = path.join(scratch, 'requests.jsonl');

    // 插件产物落在**项目侧** `.opencode/plugins/`（隔离配置域里只有项目侧会被发现）
    installSystemHandoffPlugin(projectDir);
    const store = new SystemHandoffStore(projectDir);

    fs.writeFileSync(
      path.join(projectDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'spike-mock/spike-model',
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

    const password = 'handoff-contract-pass';
    let mock: ChildProcess | undefined;
    let serve: ChildProcess | undefined;

    try {
      mock = spawn(process.execPath, [MOCK_PROVIDER], {
        env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_OUT: requestsOut },
        stdio: 'ignore',
      });
      await sleep(800);

      const serveLog = path.join(scratch, 'serve.log');
      const logFd = fs.openSync(serveLog, 'w');
      serve = spawn(
        bin,
        [
          'serve',
          '--port',
          String(servePort),
          '--hostname',
          '127.0.0.1',
          '--print-logs',
          '--log-level',
          'debug',
        ],
        {
          cwd: projectDir,
          env: {
            PATH: process.env.PATH,
            HOME: path.join(isoRoot, 'home'),
            XDG_CONFIG_HOME: path.join(isoRoot, 'config'),
            XDG_DATA_HOME: path.join(isoRoot, 'data'),
            XDG_STATE_HOME: path.join(isoRoot, 'state'),
            XDG_CACHE_HOME: path.join(isoRoot, 'cache'),
            OPENCODE_SERVER_PASSWORD: password,
            OPENCODE_SERVER_USERNAME: 'opencode',
          },
          stdio: ['ignore', logFd, logFd],
        },
      );

      const driver = new V2Driver({
        baseUrl: `http://127.0.0.1:${servePort}`,
        serverPassword: password,
        directory: projectDir,
        systemHandoff: store,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      // 等 serve 就绪（插件发现是按 location 惰性的 ⇒ 必须先建会话）
      let sessionId = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(500);
        try {
          sessionId = await driver.createSession();
          if (sessionId) {
            break;
          }
        } catch {
          // serve 还没起来
        }
      }
      expect(sessionId).not.toBe('');

      const blob = `${BLOB_MARKER}\n【平台协议】产出物协议\n【岗位职责】你是开发工程师`;
      // ⚠️ **带 directory 下发**（与生产一致）：会话先建在默认 location，再 `move` 到目标目录
      // ⇒ move 触发**目标 location 启动** ⇒ 插件的 setup 在那一刻跑 ⇒ 就绪标记出现 ⇒
      // 驱动（在 move **之后**才做载体选择）能等到它 ⇒ 插件路径生效。
      await driver.sendMessage(sessionId, {
        directory: taskDir,
        system: blob,
        parts: [{ type: 'text', text: `${USER_MARKER} 干活` }],
      });
      await sleep(4000);
      // 同一会话的第二次派发（**同一个** blob）⇒ 交接文件不重写 ⇒ 模型请求里的 blob 逐字节相同
      await driver.sendMessage(sessionId, {
        directory: taskDir,
        system: blob,
        parts: [{ type: 'text', text: `${USER_MARKER} 再干一次` }],
      });
      await sleep(4000);

      const requests = readRecorded(requestsOut);
      const mainRequests = requests.filter(
        (r) => userTextOf(r).includes(USER_MARKER) && !isTitleRequest(r),
      );
      expect(mainRequests.length).toBeGreaterThanOrEqual(2);

      for (const request of mainRequests) {
        // ① blob 在 **system 段**
        expect(systemTextOf(request)).toContain(BLOB_MARKER);
        // ② blob **不在** user 段（文本前缀兜底没有生效 ⇒ 两条路互斥）
        expect(userTextOf(request)).not.toContain(BLOB_MARKER);
        // ③ blob 被**追加**在 system 段末尾（`event.system.push` 落在内置 system 段之后）
        expect(systemTextOf(request).trimEnd().endsWith(blob)).toBe(true);
      }

      // ④ 同一会话的两次派发 ⇒ blob 在模型请求里**逐字节相同**（前缀缓存不受影响）
      const extracted = mainRequests.map((r) => {
        const text = systemTextOf(r);
        return text.slice(text.indexOf(BLOB_MARKER));
      });
      expect(extracted[0]).toBe(extracted[1]);

      // 交接目录里**只有**该会话的一个条目（每会话一文件）
      const handoffFiles = fs
        .readdirSync(resolveSystemHandoffDir(projectDir))
        .filter((name) => name.endsWith('.txt'));
      expect(handoffFiles).toEqual([`${sessionId}.txt`]);

      // 产物能被 tsc 编译（编译期检查：类型错必须构建失败）
      const pluginTypes = path.join(REPO_ROOT, '.opencode/node_modules/@opencode/plugin');
      if (fs.existsSync(pluginTypes)) {
        const typeDir = path.join(REPO_ROOT, '.opencode', `.handoff-typecheck-${process.pid}`);
        fs.mkdirSync(typeDir, { recursive: true });
        fs.writeFileSync(
          path.join(typeDir, 'plugin.ts'),
          renderSystemHandoffPlugin({ handoffDir: resolveSystemHandoffDir(projectDir) }),
          'utf8',
        );
        const tsc = path.join(REPO_ROOT, '.opencode/node_modules/typescript/bin/tsc');
        const typeRoots = path.join(REPO_ROOT, '.opencode/node_modules/@types');
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
            '--strict',
            path.join(typeDir, 'plugin.ts'),
          ],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        fs.rmSync(typeDir, { recursive: true, force: true });
        expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/error TS/);
      }
    } finally {
      serve?.kill('SIGTERM');
      mock?.kill('SIGTERM');
      await sleep(500);
      serve?.kill('SIGKILL');
      mock?.kill('SIGKILL');
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
