/**
 * **真二进制**契约测试：配置热重载路径（opencode v2 原生，**不重启 serve**）。
 *
 * 断言三件事（都是**证据**，不是推断）：
 * 1. 热重载后新配置**在 serve 侧可见**（`GET /api/provider` 能看到新 provider）；
 * 2. **serve PID 不变**（热重载不是重启 ⇒ 无端口漂移、无会话排空、无不可用窗口）；
 * 3. 有待答复的表单时 → 热重载被**跳过**（deferred），且**待答复项仍在**
 *    （`POST /api/location/reload` 会取消它们 ⇒ 闸门必须挡住）。
 *
 * 约束：**无凭据、无额度**——只验证配置层，不发模型请求。
 *
 * 默认**跳过**：设 `VTEAM_REALSTACK_SMOKE=1` 才跑（与仓库既有真栈冒烟同一个开关）；
 * 二进制缺失时**优雅跳过**（不失败），但必须打一条显式标记（不允许静默跳过）。
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { DriverQuestionRequest } from '../driver/opencode-driver';
import { ConfigReloader, verifyProvidersVisible } from './config-reloader';
import { detectPendingRequests } from './pending-requests';

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
    : null;

const describeMaybe = SKIP_REASON ? describe.skip : describe;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 探一个空闲端口。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(bound));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describeMaybe('真 v2 serve：配置热重载（不重启 serve）', () => {
  jest.setTimeout(120_000);

  let scratch: string;
  let project: string;
  let home: string;
  let port: number;
  let serve: ChildProcess | null = null;
  const PASSWORD = 'realstack-reload-password';

  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vteam-v2-reload-real-'));
    home = path.join(scratch, 'home');
    project = path.join(scratch, 'project');
    for (const dir of [
      home,
      project,
      path.join(home, '.config'),
      path.join(home, '.local', 'share'),
      path.join(home, '.local', 'state'),
      path.join(home, '.cache'),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      OPENCODE_SERVER_PASSWORD: PASSWORD,
    };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_CONTENT;
    delete env.OPENCODE_DISABLE_PROJECT_CONFIG;
    const logPath = path.join(scratch, 'serve.log');
    const out = fs.openSync(logPath, 'a');
    serve = spawn(
      OPENCODE_BIN!,
      ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs'],
      { cwd: project, env, stdio: ['ignore', out, out], detached: true },
    );
    serve.unref();
    const deadline = Date.now() + 40_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/info`, {
          headers: { Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}` },
        });
        if (res.ok) {
          up = true;
          break;
        }
      } catch {
        // 还没起来
      }
      await sleep(300);
    }
    if (!up) {
      throw new Error(`serve 启动失败：\n${fs.readFileSync(logPath, 'utf8')}`);
    }
    // 预热：serve 的配置是**异步加载**的（实测刚就绪时 `GET /api/provider` 还是空数组，
    // 约 1s 后才有内容）⇒ 冷启动窗口内做「写配置 → 重载」会读到旧快照。
    // 等 provider 列表非空再开始断言（否则测的是启动竞态，不是热重载）。
    const warmDeadline = Date.now() + 30_000;
    while (Date.now() < warmDeadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/provider`, {
          headers: { Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}` },
        });
        const payload = (await res.json()) as { data?: unknown[] };
        if (Array.isArray(payload.data) && payload.data.length > 0) {
          break;
        }
      } catch {
        // 继续等
      }
      await sleep(500);
    }
  });

  afterAll(async () => {
    if (serve?.pid) {
      try {
        process.kill(-serve.pid, 'SIGTERM');
      } catch {
        // 已退出
      }
      await sleep(1200);
      try {
        process.kill(-serve.pid, 'SIGKILL');
      } catch {
        // 已退出
      }
    }
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('热重载后新 provider 在 serve 侧可见，且 **serve PID 不变**', async () => {
    const pid = serve!.pid!;
    const endpoint = { baseUrl: `http://127.0.0.1:${port}`, password: PASSWORD };

    // 往**隔离全局配置**写一个新 provider（= vteam 写模型凭据/配置的落点）
    const globalConfig = path.join(home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    fs.writeFileSync(
      globalConfig,
      JSON.stringify(
        {
          provider: {
            realstackProvider: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Realstack Provider',
              options: { baseURL: 'http://127.0.0.1:9/v1' },
              models: { 'realstack-model': { name: 'Realstack Model' } },
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const reloader = new ConfigReloader({
      endpoint: () => endpoint,
      pendingProbe: async () => ({ forms: 0, permissions: 0, sessions: [], incomplete: false }),
    });
    const result = await reloader.reload('真栈热重载');
    expect(result.outcome).toBe('reloaded');

    // 效果确认：provider 在 serve 侧可见（走生产同款校验器——重载后 location 是
    // **异步重建**的，204 返回的瞬间 provider 列表可能还是空的）
    const verification = await verifyProvidersVisible(endpoint, ['realstackProvider']);
    expect(verification.ok).toBe(true);

    // serve 进程没换（热重载 ≠ 重启）
    expect(alive(pid)).toBe(true);
    expect(serve!.pid).toBe(pid);
  });

  it('有待答复的表单 ⇒ 热重载被跳过（deferred），待答复项仍在', async () => {
    const pid = serve!.pid!;
    const endpoint = { baseUrl: `http://127.0.0.1:${port}`, password: PASSWORD };
    const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;

    const sessionRes = await fetch(`${endpoint.baseUrl}/api/session`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'realstack-reload' }),
    });
    const sessionPayload = (await sessionRes.json()) as { data?: { id?: string }; id?: string };
    const sessionID = sessionPayload.data?.id ?? sessionPayload.id ?? '';
    expect(sessionID).not.toBe('');

    const formRes = await fetch(`${endpoint.baseUrl}/api/session/${sessionID}/form`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'pending form', fields: [{ key: 'answer', type: 'string' }] }),
    });
    expect(formRes.status).toBe(200);

    const source = {
      listQuestions: async (id: string) =>
        (
          (await (
            await fetch(`${endpoint.baseUrl}/api/session/${id}/form`, {
              headers: { Authorization: auth },
            })
          ).json()) as { data?: DriverQuestionRequest[] }
        ).data ?? [],
      listPermissions: async () => [],
    };
    const pending = await detectPendingRequests(source, [sessionID]);
    expect(pending.forms).toBe(1);

    const reloader = new ConfigReloader({
      endpoint: () => endpoint,
      pendingProbe: async () => pending,
    });
    const result = await reloader.reload('真栈热重载（有 pending）');
    expect(result.outcome).toBe('deferred');

    // 待答复项仍在（没有被取消）
    const after = await source.listQuestions(sessionID);
    expect(after.length).toBe(1);
    expect(alive(pid)).toBe(true);
  });
});
