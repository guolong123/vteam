/**
 * worker 自更新执行器 + 自动回滚 单测（worker-self-update Todo 4）。
 *
 * 全链路 mock：fs（内存实现）、http（真实 Response + 手写 fetch）、systemctl/tar/npm
 * （命令执行器），断言状态机迁移、备份-覆盖顺序、以及每条铁律：
 * 校验不过绝不覆盖 dist、无 systemd 绝不退出、回滚只做一次、重入 no-op。
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  CommandOutcome,
  CommandRunner,
  readUpdateCommandVersion,
  resolveWorkerSourceUrls,
  RunCommandOptions,
  UpdateFs,
  WorkerUpdater,
} from './worker-updater';
import { WORKER_UPDATE_STATES } from '../protocol/worker-protocol';

/** 内存文件系统（记录全部操作，用于断言「dist 是否被动过」与操作顺序）。 */
class FakeFs implements UpdateFs {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();
  readonly ops: string[] = [];
  private tempSeq = 0;

  constructor() {
    this.dirs.add('/');
  }

  async mkdtemp(prefix: string): Promise<string> {
    const dir = `${prefix}${this.tempSeq++}`;
    this.dirs.add(dir);
    this.ops.push(`mkdtemp:${dir}`);
    return dir;
  }

  async writeFile(filePath: string, data: Buffer): Promise<void> {
    this.files.set(filePath, data);
    this.ops.push(`write:${filePath}`);
  }

  async readFile(filePath: string): Promise<Buffer> {
    const found = this.files.get(filePath);
    if (!found) {
      throw new Error(`ENOENT: no such file, open '${filePath}'`);
    }
    return found;
  }

  async exists(target: string): Promise<boolean> {
    return (
      this.files.has(target) ||
      this.dirs.has(target) ||
      [...this.files.keys()].some((key) => key.startsWith(`${target}/`))
    );
  }

  async isDirectory(target: string): Promise<boolean> {
    return this.dirs.has(target);
  }

  async rm(target: string): Promise<void> {
    this.ops.push(`rm:${target}`);
    this.files.delete(target);
    this.dirs.delete(target);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${target}/`)) this.files.delete(key);
    }
    for (const key of [...this.dirs]) {
      if (key === target || key.startsWith(`${target}/`)) this.dirs.delete(key);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    this.ops.push(`rename:${from}->${to}`);
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from) as Buffer);
      this.files.delete(from);
    } else if (this.dirs.has(from)) {
      this.dirs.delete(from);
      this.dirs.add(to);
    }
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${from}/`)) {
        this.files.set(key.replace(from, to), this.files.get(key) as Buffer);
        this.files.delete(key);
      }
    }
    for (const key of [...this.dirs]) {
      if (key.startsWith(`${from}/`)) {
        this.dirs.delete(key);
        this.dirs.add(key.replace(from, to));
      }
    }
  }

  async cp(from: string, to: string): Promise<void> {
    this.ops.push(`cp:${from}->${to}`);
    this.dirs.add(to);
    for (const [key, value] of [...this.files.entries()]) {
      if (key === from || key.startsWith(`${from}/`)) {
        this.files.set(key.replace(from, to), value);
      }
    }
  }

  /** 断言某路径从未被写入/删除/改名（即更新过程没碰它）。 */
  untouched(target: string): boolean {
    return !this.ops.some((op) => op.includes(target));
  }
}

const INSTALL_DIR = '/opt/aiagents-worker';
const USER_UNIT = '/home/tester/.config/systemd/user/aiagents-worker.service';
const TARBALL = Buffer.from('fake-worker-tarball-bytes');
const TARBALL_SHA = createHash('sha256').update(TARBALL).digest('hex');
const LOCK_V1 = Buffer.from('lockfile-v1');
const LOCK_V2 = Buffer.from('lockfile-v2');
const BASE_ENV = { HOME: '/home/tester' } as NodeJS.ProcessEnv;

interface HarnessOptions {
  activeSessions?: number;
  /** 远端包内 package-lock.json 内容（默认与本地一致 → 不触发 npm ci）。 */
  remoteLock?: Buffer;
  npmCiExitCode?: number;
  systemctlExitCode?: number;
  hasSystemctl?: boolean;
  versionJson?: string;
  tarballSha?: string;
  installDir?: string;
  clockStart?: number;
}

function seedInstallDir(fsImpl: FakeFs, installDir: string, lock: Buffer): void {
  fsImpl.dirs.add(installDir);
  fsImpl.files.set(`${installDir}/dist/index.js`, Buffer.from('old-code'));
  fsImpl.files.set(`${installDir}/package.json`, Buffer.from('{"name":"worker"}'));
  fsImpl.files.set(`${installDir}/package-lock.json`, lock);
  fsImpl.dirs.add(`${installDir}/scripts`);
  fsImpl.files.set(`${installDir}/scripts/start.sh`, Buffer.from('old-start'));
  fsImpl.files.set(`${installDir}/.env`, Buffer.from('X_WORKER_TOKEN=secret'));
  fsImpl.files.set(`${installDir}/.env.example`, Buffer.from('# template'));
}

/** 构造执行器 + 全部 mock；返回执行器与断言用的假件句柄。 */
function createHarness(options: HarnessOptions = {}) {
  const installDir = options.installDir ?? INSTALL_DIR;
  const lock = LOCK_V1;
  const fsImpl = new FakeFs();
  seedInstallDir(fsImpl, installDir, lock);

  const calls: Array<{ command: string; args: string[]; options?: RunCommandOptions }> = [];
  const remoteLock = options.remoteLock ?? LOCK_V1;
  let stagingDir = '';
  let systemctlExit = options.systemctlExitCode ?? 0;
  const npmCiExit = options.npmCiExitCode ?? 0;
  const hasSystemctl = options.hasSystemctl ?? true;

  const run: CommandRunner = async (command, args, runOptions) => {
    calls.push({ command, args, options: runOptions });
    const outcome = (code: number, stderr = ''): CommandOutcome => ({ code, stdout: '', stderr });
    if (command === 'tar') {
      const target = args[args.indexOf('-C') + 1];
      stagingDir = target;
      fsImpl.dirs.add(target);
      fsImpl.dirs.add(`${target}/dist`);
      fsImpl.dirs.add(`${target}/scripts`);
      fsImpl.files.set(`${target}/dist/index.js`, Buffer.from('new-code'));
      fsImpl.files.set(`${target}/package.json`, Buffer.from('{"name":"worker"}'));
      fsImpl.files.set(`${target}/package-lock.json`, remoteLock);
      fsImpl.files.set(`${target}/scripts/start.sh`, Buffer.from('new-start'));
      fsImpl.files.set(`${target}/.env.example`, Buffer.from('# new template'));
      return outcome(0);
    }
    if (command === 'npm') {
      return outcome(npmCiExit, npmCiExit === 0 ? '' : 'npm ERR! lock mismatch');
    }
    if (command === 'systemctl') {
      if (args[0] === '--version') {
        return hasSystemctl ? outcome(0) : outcome(127, 'not found');
      }
      systemctlExit = systemctlExit; // 保持可读性：重启结果由下面返回
      return outcome(systemctlExit);
    }
    return outcome(0);
  };

  const fetchMock = jest.fn(async (url: string) => {
    if (url.endsWith('worker-src.version.json')) {
      if (options.versionJson !== undefined) {
        return new Response(options.versionJson, { status: 200 });
      }
      return new Response(
        JSON.stringify({ version: 'v2', sha256: options.tarballSha ?? TARBALL_SHA, builtAt: 'x' }),
        { status: 200 },
      );
    }
    return new Response(new Uint8Array(TARBALL), { status: 200 });
  });

  const clock = { t: options.clockStart ?? 1_000_000 };
  const updater = new WorkerUpdater({
    serverUrl: 'http://server.example.com',
    installDir,
    activeSessionCount: () => options.activeSessions ?? 0,
    fetchImpl: fetchMock as unknown as typeof fetch,
    fsImpl,
    run,
    now: () => clock.t,
    env: BASE_ENV,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  });

  return { updater, fsImpl, calls, fetchMock, clock, stagingDir: () => stagingDir, installDir };
}

const UPDATE_CMD = { type: 'update-worker', resourceVersion: 'v2' } as const;

describe('resolveWorkerSourceUrls（与 install-worker.sh 缺省推导同源）', () => {
  it('serverUrl 推导 tarball + 同目录 version.json（尾斜杠容忍）', () => {
    expect(resolveWorkerSourceUrls('http://host:3000/', {})).toEqual({
      tarball: 'http://host:3000/worker-src.tar.gz',
      versionJson: 'http://host:3000/worker-src.version.json',
    });
  });

  it('env WORKER_SRC_URL 覆盖（机器可能是从镜像站装的），version.json 跟随 tarball 同目录', () => {
    expect(
      resolveWorkerSourceUrls('http://host:3000', {
        WORKER_SRC_URL: 'https://mirror.internal/pkgs/worker-src.tar.gz',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      tarball: 'https://mirror.internal/pkgs/worker-src.tar.gz',
      versionJson: 'https://mirror.internal/pkgs/worker-src.version.json',
    });
  });
});

describe('WorkerUpdater 正常路径（状态机 + 备份覆盖顺序）', () => {
  it('happy path：pending→downloading→restarting，备份在前覆盖在后，systemctl 被调用', async () => {
    const h = createHarness();
    // systemd 可用：systemctl 存在 + 运行时目录是目录 + 用户级 unit 存在
    h.fsImpl.dirs.add('/run/systemd/system');
    h.fsImpl.files.set(USER_UNIT, Buffer.from('[Unit]'));

    const outcome = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(outcome).toBe('applied-restarting');
    expect(h.updater.state).toBe('restarting');
    // 备份 dist → dist.prev，且严格早于把新 dist 拷进去
    const backupIdx = h.fsImpl.ops.findIndex((op) =>
      op.startsWith(`rename:${INSTALL_DIR}/dist->${INSTALL_DIR}/dist.prev`),
    );
    const overwriteIdx = h.fsImpl.ops.findIndex((op) =>
      op.startsWith(`cp:`) && op.endsWith(`->${INSTALL_DIR}/dist`),
    );
    expect(backupIdx).toBeGreaterThanOrEqual(0);
    expect(overwriteIdx).toBeGreaterThan(backupIdx);
    // 新码落盘、旧码留在 dist.prev
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('new-code');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist.prev/index.js`)?.toString()).toBe('old-code');
    // .env 不在发布包清单里 → 运行时配置零改动
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/.env`)?.toString()).toBe('X_WORKER_TOKEN=secret');
    // 用户级 systemctl + 用户总线环境兜底
    const restart = h.calls.find(
      (call) => call.command === 'systemctl' && call.args.includes('restart'),
    );
    expect(restart?.args).toEqual(['--user', 'restart', 'aiagents-worker']);
    expect(restart?.options?.env?.XDG_RUNTIME_DIR).toBeDefined();
    expect(restart?.options?.env?.DBUS_SESSION_BUS_ADDRESS).toContain('unix:path=');
    // lock 未变化 → 不装依赖
    expect(h.calls.some((call) => call.command === 'npm')).toBe(false);
    // 临时目录清理干净
    expect(await h.fsImpl.exists(h.stagingDir())).toBe(false);
  });

  it('lock 变化 → 覆盖后执行 npm ci --omit=dev（cwd=安装目录）', async () => {
    const h = createHarness({ remoteLock: LOCK_V2 });
    h.fsImpl.dirs.add('/run/systemd/system');
    h.fsImpl.files.set(USER_UNIT, Buffer.from('[Unit]'));

    await h.updater.handleCommand({ ...UPDATE_CMD });

    const npmCall = h.calls.find((call) => call.command === 'npm');
    expect(npmCall?.args).toEqual(['ci', '--omit=dev']);
    expect(npmCall?.options?.cwd).toBe(INSTALL_DIR);
  });

  it('系统级 unit 存在时走 systemctl（不带 --user）', async () => {
    const h = createHarness();
    h.fsImpl.dirs.add('/run/systemd/system');
    h.fsImpl.files.set('/etc/systemd/system/aiagents-worker.service', Buffer.from('[Unit]'));

    await h.updater.handleCommand({ ...UPDATE_CMD });

    const restart = h.calls.find(
      (call) => call.command === 'systemctl' && call.args.includes('restart'),
    );
    expect(restart?.args).toEqual(['restart', 'aiagents-worker']);
  });
});

describe('WorkerUpdater 空闲与重入护栏', () => {
  it('有活跃会话：停在 pending，完全不下载', async () => {
    const h = createHarness({ activeSessions: 2 });

    const outcome = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(outcome).toBe('deferred-idle');
    expect(h.updater.state).toBe('pending');
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.fsImpl.untouched(`${INSTALL_DIR}/dist`)).toBe(true);
  });

  it('重入：执行期间再来一条指令只 debug 记一笔就返回（单飞锁）', async () => {
    const h = createHarness();
    let releaseDownload = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const originalFetch = h.fetchMock.getMockImplementation() as (
      url: string,
    ) => Promise<Response>;
    h.fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('.tar.gz')) {
        await gate;
      }
      return originalFetch(url);
    });

    const first = h.updater.handleCommand({ ...UPDATE_CMD });
    await Promise.resolve();
    await Promise.resolve();
    const second = await h.updater.handleCommand({ ...UPDATE_CMD });
    expect(second).toBe('deferred-inflight');

    releaseDownload();
    expect(await first).toBe('applied-ready-manual');
    // 只下载了一次（重入那条没有产生第二次 tarball 拉取）
    const tarballFetches = h.fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith('.tar.gz'),
    );
    expect(tarballFetches).toHaveLength(1);
  });

  it('同版本重复指令（server 未收敛时的心跳重放）不重复下载', async () => {
    const h = createHarness();
    h.fsImpl.dirs.add('/run/systemd/system');
    h.fsImpl.files.set(USER_UNIT, Buffer.from('[Unit]'));

    await h.updater.handleCommand({ ...UPDATE_CMD });
    const fetchesAfterFirst = h.fetchMock.mock.calls.length;

    const second = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(second).toBe('skipped-already-applied');
    expect(h.fetchMock.mock.calls).toHaveLength(fetchesAfterFirst);
  });
});

describe('WorkerUpdater 校验失败（铁律：绝不覆盖 dist）', () => {
  it('sha256 不符：停在 pending，dist 与 dist.prev 都没被碰过', async () => {
    const h = createHarness({ tarballSha: 'f'.repeat(64) });

    const outcome = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(outcome).toBe('aborted');
    expect(h.updater.state).toBe('pending');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('old-code');
    expect(await h.fsImpl.exists(`${INSTALL_DIR}/dist.prev`)).toBe(false);
    // tar 从未执行 → 连解包都没发生
    expect(h.calls.some((call) => call.command === 'tar')).toBe(false);
    expect(h.fetchMock.mock.calls[0][0]).toContain('worker-src.version.json');
  });

  it('version.json 缺失（HTTP 404）：放弃本轮，不下载包', async () => {
    const h = createHarness();
    h.fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('worker-src.version.json')
        ? new Response('nope', { status: 404, statusText: 'Not Found' })
        : new Response(new Uint8Array(TARBALL), { status: 200 }),
    );

    const outcome = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(outcome).toBe('aborted');
    expect(h.updater.state).toBe('pending');
    expect(h.calls.some((call) => call.command === 'tar')).toBe(false);
  });

  it('version.json 版本与指令目标版本不符：放弃本轮（绝不猜版本硬更）', async () => {
    const h = createHarness({
      versionJson: JSON.stringify({ version: 'v9', sha256: TARBALL_SHA }),
    });

    const outcome = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(outcome).toBe('aborted');
    expect(h.calls.some((call) => call.command === 'tar')).toBe(false);
  });

  it('下载失败后退避：退避窗口内的下一次指令被跳过（dist 仍未动）', async () => {
    const h = createHarness();
    h.fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('worker-src.version.json')
        ? new Response(JSON.stringify({ version: 'v2', sha256: TARBALL_SHA }), { status: 200 })
        : new Response('boom', { status: 500, statusText: 'Server Error' }),
    );

    expect(await h.updater.handleCommand({ ...UPDATE_CMD })).toBe('aborted');
    h.clock.t += 1_000;
    expect(await h.updater.handleCommand({ ...UPDATE_CMD })).toBe('deferred-backoff');
    // 退避 60s 后恢复尝试
    h.clock.t += 60_000;
    h.fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('worker-src.version.json')
        ? new Response(JSON.stringify({ version: 'v2', sha256: TARBALL_SHA }), { status: 200 })
        : new Response(new Uint8Array(TARBALL), { status: 200 }),
    );
    expect(await h.updater.handleCommand({ ...UPDATE_CMD })).toBe('applied-ready-manual');
  });

  it('指令未携带版本号：降级执行（只要求 version.json 存在，sha256 校验照做）', async () => {
    // wire 契约：空版本必须降级而非硬失败——server 漏传版本时更新仍要能推得动。
    const h = createHarness();
    h.fsImpl.dirs.add('/run/systemd/system');
    h.fsImpl.files.set(USER_UNIT, Buffer.from('[Unit]'));

    const outcome = await h.updater.handleCommand({
      type: 'update-worker',
      resourceVersion: '   ',
    });

    expect(outcome).toBe('applied-restarting');
    expect(h.updater.state).toBe('restarting');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('new-code');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist.prev/index.js`)?.toString()).toBe('old-code');
  });

  it('降级执行同样受 sha256 铁律约束：校验不过照样放弃，dist 一个字节不动', async () => {
    const h = createHarness({ tarballSha: 'f'.repeat(64) });

    const outcome = await h.updater.handleCommand({
      type: 'update-worker',
      resourceVersion: '',
    });

    expect(outcome).toBe('aborted');
    expect(h.updater.state).toBe('pending');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('old-code');
    expect(await h.fsImpl.exists(`${INSTALL_DIR}/dist.prev`)).toBe(false);
  });

  it('降级执行在 version.json 缺失时仍然放弃（校验不可省）', async () => {
    const h = createHarness();
    h.fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('worker-src.version.json')
        ? new Response('nope', { status: 404, statusText: 'Not Found' })
        : new Response(new Uint8Array(TARBALL), { status: 200 }),
    );

    const outcome = await h.updater.handleCommand({
      type: 'update-worker',
      resourceVersion: '',
    });

    expect(outcome).toBe('aborted');
    expect(h.calls.some((call) => call.command === 'tar')).toBe(false);
  });
});

describe('update-worker 指令信封（对齐 server Todo 3 的入队形态）', () => {
  it('resourceVersion 形态：{type,resourceVersion} 触发完整执行链', async () => {
    const h = createHarness();
    h.fsImpl.dirs.add('/run/systemd/system');
    h.fsImpl.files.set(USER_UNIT, Buffer.from('[Unit]'));

    const outcome = await h.updater.handleCommand({
      type: 'update-worker',
      resourceVersion: 'v2',
    });

    expect(outcome).toBe('applied-restarting');
    expect(h.updater.debugState.appliedVersion).toBe('v2');
  });

  it('payload.version 形态：payload 优先于 resourceVersion（server 换负载形态也不炸）', () => {
    expect(
      readUpdateCommandVersion({
        type: 'update-worker',
        resourceVersion: 'rv-1',
        payload: { version: 'pv-2' },
      }),
    ).toBe('pv-2');
  });

  it('resourceVersion 回退：payload 缺席时读 resourceVersion', () => {
    expect(
      readUpdateCommandVersion({ type: 'update-worker', resourceVersion: 'rv-1' }),
    ).toBe('rv-1');
  });

  it('payload.version 存在时 resourceVersion 完全不参与取值', async () => {
    const h = createHarness({
      // 发布物自称 v2；指令以 payload 形态下发同一个版本号
      versionJson: JSON.stringify({ version: 'v2', sha256: TARBALL_SHA }),
    });

    const outcome = await h.updater.handleCommand({
      type: 'update-worker',
      resourceVersion: 'rv-完全不同的版本',
      payload: { version: 'v2' },
    });

    // 若误读了 resourceVersion，这轮会因版本不符被放弃
    expect(outcome).toBe('applied-ready-manual');
    expect(h.updater.debugState.appliedVersion).toBe('v2');
  });

  it('两处版本皆空 → undefined（执行器据此降级，不硬失败）', () => {
    expect(
      readUpdateCommandVersion({ type: 'update-worker', resourceVersion: '  ' }),
    ).toBeUndefined();
    expect(
      readUpdateCommandVersion({
        type: 'update-worker',
        resourceVersion: 'rv-1',
        payload: { version: '   ' },
      }),
    ).toBeUndefined();
  });
});

describe('WorkerUpdater 无 systemd（决策⑤：只标记不退出）', () => {
  it('无 unit：不调用 restart，落在 ready-manual，进程继续（无 exit）', async () => {
    const h = createHarness();
    h.fsImpl.dirs.add('/run/systemd/system'); // 有 systemd 运行时，但没有 unit 文件

    const outcome = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(outcome).toBe('applied-ready-manual');
    expect(h.updater.state).toBe('ready-manual');
    expect(h.calls.some((call) => call.args.includes('restart'))).toBe(false);
    // 新码确实落盘（等人工重启即生效），旧码留证
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('new-code');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist.prev/index.js`)?.toString()).toBe('old-code');
  });

  it('systemctl restart 失败（如总线不可用）：同样落 ready-manual，不谎报 restarting', async () => {
    const h = createHarness({ systemctlExitCode: 1 });
    h.fsImpl.dirs.add('/run/systemd/system');
    h.fsImpl.files.set(USER_UNIT, Buffer.from('[Unit]'));

    const outcome = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(outcome).toBe('applied-ready-manual');
    expect(h.updater.state).toBe('ready-manual');
  });

  it('systemctl 不存在（无二进制）：探测直接判否', async () => {
    const h = createHarness({ hasSystemctl: false });

    expect(await h.updater.handleCommand({ ...UPDATE_CMD })).toBe('applied-ready-manual');
    expect(h.updater.state).toBe('ready-manual');
  });
});

describe('WorkerUpdater 自动回滚（计划决策②）', () => {
  /** 覆盖完成但从未注册成功（无 systemd → ready-manual），用于回滚场景。 */
  async function applyWithoutRegister(options: HarnessOptions = {}) {
    const h = createHarness(options);
    await h.updater.handleCommand({ ...UPDATE_CMD });
    expect(h.updater.state).toBe('ready-manual');
    expect(h.updater.debugState.registeredSinceUpdate).toBe(false);
    return h;
  }

  it('register 连续失败达阈值 → dist→dist.failed、dist.prev→dist、重启、rolledback', async () => {
    const h = await applyWithoutRegister();
    h.fsImpl.dirs.add('/run/systemd/system');
    h.fsImpl.files.set(USER_UNIT, Buffer.from('[Unit]'));
    for (let i = 0; i < 5; i += 1) {
      h.updater.noteRegisterFailure();
    }

    expect(await h.updater.maybeRollback()).toBe(true);

    expect(h.updater.state).toBe('rolledback');
    expect(h.updater.rolledBack).toBe(true);
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('old-code');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist.failed/index.js`)?.toString()).toBe('new-code');
    expect(await h.fsImpl.exists(`${INSTALL_DIR}/dist.prev`)).toBe(false);
    expect(
      h.calls.some((call) => call.command === 'systemctl' && call.args.includes('restart')),
    ).toBe(true);
  });

  it('时长阈值：注册确有失败但未达次数阈值，过 5 分钟也回滚', async () => {
    const h = await applyWithoutRegister();
    h.updater.noteRegisterFailure();

    h.clock.t += 5 * 60_000 + 1;
    expect(await h.updater.maybeRollback()).toBe(true);
    expect(h.updater.state).toBe('rolledback');
  });

  it('ready-manual 等人工重启期间注册一直正常：不回滚（否则会撤销刚下好的包）', async () => {
    const h = await applyWithoutRegister();
    h.clock.t += 30 * 60_000;

    expect(await h.updater.maybeRollback()).toBe(false);
    expect(h.updater.state).toBe('ready-manual');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('new-code');
  });

  it('register 成功过：新码已被认可，永不回滚', async () => {
    const h = await applyWithoutRegister();
    h.updater.noteRegisterSuccess();
    for (let i = 0; i < 9; i += 1) {
      h.updater.noteRegisterFailure();
    }
    h.updater.noteRegisterSuccess();

    expect(await h.updater.maybeRollback()).toBe(false);
    expect(h.updater.state).toBe('ready-manual');
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('new-code');
  });

  it('未更新过时：注册再失败也不回滚（没有 dist.prev 语义）', async () => {
    const h = createHarness();
    for (let i = 0; i < 9; i += 1) {
      h.updater.noteRegisterFailure();
    }
    h.clock.t += 60 * 60_000;

    expect(await h.updater.maybeRollback()).toBe(false);
    expect(h.updater.state).toBeUndefined();
    expect(h.updater.rolledBack).toBe(false);
  });

  it('无 dist.prev（首装）：达阈值也不自动回滚，只告警', async () => {
    const h = await applyWithoutRegister();
    await h.fsImpl.rm(`${INSTALL_DIR}/dist.prev`);
    for (let i = 0; i < 5; i += 1) {
      h.updater.noteRegisterFailure();
    }

    expect(await h.updater.maybeRollback()).toBe(false);
    expect(h.updater.state).toBe('ready-manual');
    expect(h.updater.debugState.rollbackAttempted).toBe(true);
  });

  it('防震荡：一次回滚之后不再自动动作（后续失败只忽略）', async () => {
    const h = await applyWithoutRegister();
    for (let i = 0; i < 5; i += 1) {
      h.updater.noteRegisterFailure();
    }
    expect(await h.updater.maybeRollback()).toBe(true);

    const opsAfterRollback = h.fsImpl.ops.length;
    h.updater.noteRegisterFailure();
    h.clock.t += 60 * 60_000;
    expect(await h.updater.maybeRollback()).toBe(false);
    expect(h.fsImpl.ops).toHaveLength(opsAfterRollback);
    expect(h.updater.state).toBe('rolledback');
  });

  it('无 systemd 时的回滚：文件换回 dist.prev，不假装重启成功', async () => {
    const h = await applyWithoutRegister();
    for (let i = 0; i < 5; i += 1) {
      h.updater.noteRegisterFailure();
    }

    expect(await h.updater.maybeRollback()).toBe(true);

    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('old-code');
    expect(h.updater.state).toBe('rolledback');
    expect(h.updater.rolledBack).toBe(true);
    expect(h.calls.some((call) => call.args.includes('restart'))).toBe(false);
  });

  it('npm ci 失败 → 立即恢复 dist.prev + 上报 rolledback + 后续不再自动动作', async () => {
    const h = createHarness({ remoteLock: LOCK_V2, npmCiExitCode: 1 });

    const outcome = await h.updater.handleCommand({ ...UPDATE_CMD });

    expect(outcome).toBe('aborted');
    expect(h.updater.state).toBe('rolledback');
    expect(h.updater.rolledBack).toBe(true);
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('old-code');
    expect(await h.fsImpl.exists(`${INSTALL_DIR}/dist.prev`)).toBe(false);
    // 依赖装不上是确定性失败 → 不会再去重试覆盖
    h.updater.noteRegisterFailure();
    expect(await h.updater.maybeRollback()).toBe(false);
    expect(h.fsImpl.files.get(`${INSTALL_DIR}/dist/index.js`)?.toString()).toBe('old-code');
  });
});

describe('WorkerUpdater 注册计数', () => {
  it('成功清零连续失败计数', () => {
    const h = createHarness();
    h.updater.noteRegisterFailure();
    h.updater.noteRegisterFailure();
    h.updater.noteRegisterSuccess();

    expect(h.updater.debugState.consecutiveRegisterFailures).toBe(0);
  });
});

/**
 * 两端共享契约守卫（worker ↔ server）。
 *
 * 存在理由：updateState/rolledBack 是跨进程的字面量契约，worker 是独立 npm 包、无法
 * import server 代码，两端各写一份。字段名或取值漂移不会让任何一侧编译失败，只会让
 * 更新状态静默丢失（server 的 @IsIn 把未知值判为「未上报」，UI 永远停在旧状态）。
 * 故照 memory-refcount.migration.spec.ts 的源码扫描守卫先例，把不变量钉死：
 * worker 上报的字段名与状态取值必须与 server DTO/常量**逐字一致**。
 */
describe('共享状态契约（worker 上报 ↔ server DTO 逐字一致）', () => {
  const SERVER_DIR = path.resolve(__dirname, '..', '..', '..', 'server', 'src', 'workers');
  const serverSource = (relative: string): string =>
    fs.readFileSync(path.join(SERVER_DIR, relative), 'utf8');

  it('worker 的 5 个状态取值与 server WORKER_UPDATE_STATES 完全一致（顺序与拼写）', () => {
    const serverEnum = serverSource('worker-update-state.ts');
    // 取出 server 侧 `KEY: 'value',` 形式的枚举项，逐字比对
    const serverEntries = [...serverEnum.matchAll(/^\s+[A-Z_]+:\s*'([^']+)',/gm)].map(
      (m) => m[1],
    );
    const workerEntries = Object.values(WORKER_UPDATE_STATES);

    expect(serverEntries.length).toBe(workerEntries.length);
    expect([...workerEntries].sort()).toEqual([...serverEntries].sort());
    expect(workerEntries).toContain('ready-manual');
    expect(workerEntries).toContain('rolledback');
  });

  it('register DTO 逐字接受 updateState + rolledBack（字段名漂移守卫）', () => {
    const dto = serverSource(path.join('dto', 'register-worker.dto.ts'));
    expect(dto).toMatch(/updateState\?:/);
    expect(dto).toMatch(/rolledBack\?:/);
    // 两者都必须是可选（缺席 = 未上报，旧 worker 兼容）
    expect(dto).toMatch(/@IsOptional\(\)[\s\S]{0,200}updateState\?:/);
  });

  it('heartbeat DTO 逐字接受 updateState + rolledBack（字段名漂移守卫）', () => {
    const dto = serverSource(path.join('dto', 'heartbeat-worker.dto.ts'));
    expect(dto).toMatch(/updateState\?:/);
    expect(dto).toMatch(/rolledBack\?:/);
  });

  it('server 收敛规则认得 rolledback/rolledBack（否则指令永不收敛死循环）', () => {
    const service = serverSource('workers.service.ts');
    expect(service).toMatch(/UPDATE_WORKER:\s*'update-worker'/);
    expect(service).toMatch(/dto\.rolledBack === true/);
  });
});
