/**
 * OpencodeServer 单元测试（T3）。
 *
 * mock child_process.spawn / http.get / net.createServer，覆盖：
 * - spawn 参数（--pure 必带 / --port / --hostname / detached:true / env 注入）
 * - start 成功 + 健康检查通过 → baseUrl
 * - 端口冲突重试（占用 → +1）、随机端口（port=0）
 * - stop 进程组 kill(-pid) + SIGKILL 兜底
 * - 健康检查超时 / serve 提前退出 / spawn 抛错
 * - 日志环形缓冲 / listening 端口不一致告警
 * 真实 spawn 集成见 opencode-server.integration.spec.ts。
 */

import { spawn, spawnSync } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));
jest.mock('http', () => ({ get: jest.fn() }));
jest.mock('net', () => ({ createServer: jest.fn() }));

import { OpencodeServer, Logger } from './opencode-server';

const mockedSpawn = spawn as unknown as jest.Mock;
const mockedSpawnSync = spawnSync as unknown as jest.Mock;
const mockedHttpGet = http.get as unknown as jest.Mock;
const mockedCreateServer = net.createServer as unknown as jest.Mock;

function makeLogger(): Logger & { info: jest.Mock; warn: jest.Mock; error: jest.Mock } {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** 假 ChildProcess：默认 SIGTERM 即触发 exit；_ignoreSigterm 时仅 SIGKILL 触发。 */
class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn((signal?: string) => {
    if (!this._ignoreSigterm || signal === 'SIGKILL') {
      this.exitCode = 0;
      process.nextTick(() => this.emit('exit', this.exitCode, null));
    }
    return true;
  });
  _ignoreSigterm = false;

  constructor(pid = 4242, exitCode: number | null = null) {
    super();
    this.pid = pid;
    this.exitCode = exitCode;
  }
}

interface NetBehavior {
  occupied?: boolean;
  assignedPort?: number;
}

/** 可控 net.createServer 行为队列：每次调用按序消费一个 behavior。 */
let netBehaviors: NetBehavior[] = [];
function mockNetOnce(behaviors: NetBehavior[]): void {
  netBehaviors = [...behaviors];
}

/** http.get 行为开关：'ok' 同步回调 200；'error' 异步抛 ECONNREFUSED。 */
let httpBehavior: 'ok' | 'error' = 'ok';

let killSpy: jest.SpyInstance;
let fakeProc: FakeChild;

beforeEach(() => {
  jest.clearAllMocks();
  netBehaviors = [];
  httpBehavior = 'ok';
  killSpy = jest
    .spyOn(process, 'kill')
    .mockImplementation((pid: number, signal?: string | number) => {
      // 模拟真实 kill(-pid)：进程已退出时抛 ESRCH，否则把信号转发给 fake 子进程
      if (fakeProc.exitCode !== null) {
        const err = new Error('kill ESRCH: no such process') as Error & { code: string };
        err.code = 'ESRCH';
        throw err;
      }
      if (pid === -fakeProc.pid) {
        fakeProc.kill(String(signal ?? 'SIGTERM'));
      }
      return true;
    });

  fakeProc = new FakeChild();
  mockedSpawn.mockImplementation(() => fakeProc);
  mockedSpawnSync.mockImplementation(() => ({ stdout: '1.18.15\n', stderr: '' }));

  mockedCreateServer.mockImplementation(() => {
    const behavior = netBehaviors.shift() ?? {};
    const server = new EventEmitter() as EventEmitter & {
      _port: number;
      listen: jest.Mock;
      close: jest.Mock;
      address: jest.Mock;
      once: jest.Mock;
    };
    server.listen = jest.fn((port: number, _host: string, cb?: () => void) => {
      if (behavior.occupied) {
        process.nextTick(() =>
          server.emit('error', Object.assign(new Error('EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })),
        );
      } else {
        server._port = behavior.assignedPort ?? port;
        if (cb) {
          cb();
        }
      }
      return server;
    });
    server.close = jest.fn((cb?: () => void) => {
      if (cb) {
        cb();
      }
    });
    server.address = jest.fn(() => ({ address: '127.0.0.1', port: server._port }));
    server.once = jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      server.on(event, cb as (...args: any[]) => void);
      return server;
    });
    return server;
  });

  mockedHttpGet.mockImplementation(
    (_url: string, _opts: unknown, cb: (res: { statusCode: number; resume: () => void }) => void) => {
      const req = new EventEmitter() as EventEmitter & { destroy: jest.Mock };
      req.destroy = jest.fn();
      if (httpBehavior === 'ok') {
        cb({ statusCode: 200, resume: jest.fn() });
      } else {
        // 复用 EventEmitter 的 on：让 httpGetStatus 的 req.on('error', reject) 真正生效
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
      }
      return req;
    },
  );
});

afterEach(() => {
  killSpy.mockRestore();
});

interface NewServerOpts {
  port: number;
  serverPassword?: string;
  command?: string;
  healthCheckTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  logBufferSize?: number;
  portRetryCount?: number;
  serveHostname?: string;
  logger?: Logger;
}

function newServer(opts: NewServerOpts): OpencodeServer {
  return new OpencodeServer({
    port: opts.port,
    serverPassword: opts.serverPassword,
    command: opts.command ?? 'opencode',
    healthCheckTimeoutMs: opts.healthCheckTimeoutMs ?? 1000,
    healthCheckIntervalMs: opts.healthCheckIntervalMs ?? 20,
    logBufferSize: opts.logBufferSize ?? 200,
    portRetryCount: opts.portRetryCount ?? 5,
    serveHostname: opts.serveHostname,
    logger: opts.logger,
  });
}

describe('OpencodeServer', () => {
  it('构造：port 非负整数校验', () => {
    expect(() => new OpencodeServer({ port: -1 })).toThrow(/非负整数/);
    expect(() => new OpencodeServer({ port: 1.5 })).toThrow(/非负整数/);
    expect(() => new OpencodeServer({ port: 0 })).not.toThrow();
  });

  it('start 成功：spawn 参数含 --pure/--port/--hostname，detached:true，健康检查通过后返回 baseUrl', async () => {
    const logger = makeLogger();
    const server = newServer({ port: 4199, logger });
    const baseUrl = await server.start();

    expect(baseUrl).toBe('http://127.0.0.1:4199');
    expect(server.baseUrl).toBe('http://127.0.0.1:4199');
    expect(server.port).toBe(4199);
    expect(server.pid).toBe(4242);
    expect(server.isRunning).toBe(true);
    expect(server.version).toBe('1.18.15');

    // D2 铁律：--pure 必带
    expect(mockedSpawn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--port', '4199', '--hostname', '127.0.0.1', '--pure'],
      expect.objectContaining({ detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--pure');
    // 健康检查使用带鉴权的 GET
    expect(mockedHttpGet).toHaveBeenCalled();
  });

  it('serverPassword 注入 env 的 OPENCODE_SERVER_PASSWORD；为空时不注入', async () => {
    await newServer({ port: 4199, serverPassword: 's3cret' }).start();
    const env = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('s3cret');

    jest.clearAllMocks();
    await newServer({ port: 4199 }).start();
    const env2 = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env2.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  });

  it('健康检查带 Basic Auth header（username=opencode）', async () => {
    await newServer({ port: 4199, serverPassword: 'pw' }).start();
    const [, opts] = mockedHttpGet.mock.calls[0];
    const headers = (opts as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`);
  });

  it('端口冲突重试：4199 占用则使用 4200', async () => {
    mockNetOnce([{ occupied: true }, { occupied: false }]);
    const server = newServer({ port: 4199 });
    const baseUrl = await server.start();
    expect(baseUrl).toBe('http://127.0.0.1:4200');
    expect(server.port).toBe(4200);
    expect(mockedSpawn.mock.calls[0][1]).toContain('4200');
  });

  it('端口冲突超出重试次数抛错', async () => {
    mockNetOnce([{ occupied: true }, { occupied: true }, { occupied: true }]);
    const server = newServer({ port: 4199, portRetryCount: 3 });
    await expect(server.start()).rejects.toThrow(/端口冲突/);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('port=0 使用 OS 随机空闲端口', async () => {
    mockNetOnce([{ assignedPort: 53001 }]);
    const server = newServer({ port: 0 });
    const baseUrl = await server.start();
    expect(baseUrl).toBe('http://127.0.0.1:53001');
    expect(mockedSpawn.mock.calls[0][1]).toContain('53001');
  });

  it('健康检查超时抛错并清理（stop 被调用，进程组 kill）', async () => {
    httpBehavior = 'error';
    const logger = makeLogger();
    const server = newServer({ port: 4199, healthCheckTimeoutMs: 80, healthCheckIntervalMs: 10, logger });
    await expect(server.start()).rejects.toThrow(/健康检查超时/);
    expect(server.isRunning).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('serve 提前退出（exitCode 非 null）抛错并附日志', async () => {
    fakeProc.exitCode = 1;
    const server = newServer({ port: 4199 });
    await expect(server.start()).rejects.toThrow(/提前退出/);
    // 已退出无需清理：kill(-pid) 抛 ESRCH 被 stop 吞掉，不触发 fake 进程
    expect(fakeProc.kill).not.toHaveBeenCalled();
    expect(server.isRunning).toBe(false);
  });

  it('spawn 抛错（命令不存在）→ start 拒绝', async () => {
    mockedSpawn.mockImplementation(() => {
      throw new Error('spawn opencode ENOENT');
    });
    const server = newServer({ port: 4199 });
    await expect(server.start()).rejects.toThrow(/启动 opencode serve 失败/);
  });

  it('F2 M3：spawn 异步 error（ENOENT）→ start 立即拒绝，不空转等健康检查超时', async () => {
    // 健康检查一直失败（模拟 serve 未起来），但 spawn 异步 error 应优先于超时判错
    httpBehavior = 'error';
    mockedSpawn.mockImplementation(() => {
      // 真实 Node：命令不在 PATH 时 spawn 返回子进程后异步 emit 'error'（ENOENT）
      process.nextTick(() => fakeProc.emit('error', new Error('spawn opencode ENOENT')));
      return fakeProc;
    });
    const server = newServer({ port: 4199, healthCheckTimeoutMs: 5000, healthCheckIntervalMs: 10 });
    await expect(server.start()).rejects.toThrow(/spawn 失败: spawn opencode ENOENT/);
    expect(server.spawnError?.message).toContain('ENOENT');
    expect(server.isRunning).toBe(false);
  });

  it('stop：kill(-pid) 进程组清理后 isRunning=false、baseUrl 清空', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    await server.stop();
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(server.isRunning).toBe(false);
    expect(server.baseUrl).toBeNull();
  });

  it('stop：SIGTERM 未退出 → SIGKILL 兜底', async () => {
    fakeProc._ignoreSigterm = true;
    const server = newServer({ port: 4199 });
    await server.start();
    await server.stop(50);
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('stop：进程组不存在（ESRCH）不抛错', async () => {
    // 模拟进程已死：kill(-pid) 抛 ESRCH 且进程随即 exit
    killSpy.mockImplementation(() => {
      fakeProc.exitCode = 0;
      process.nextTick(() => fakeProc.emit('exit', 0, null));
      const err = new Error('kill ESRCH') as Error & { code: string };
      err.code = 'ESRCH';
      throw err;
    });
    const server = newServer({ port: 4199 });
    await server.start();
    await expect(server.stop()).resolves.toBeUndefined();
    expect(server.isRunning).toBe(false);
  });

  it('未启动时 stop 直接返回', async () => {
    const server = newServer({ port: 4199 });
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('日志环形缓冲：超过 bufferSize 截断，保留最近行', async () => {
    const server = newServer({ port: 4199, logBufferSize: 3 });
    await server.start();
    // 通过 stdout/stderr emit 超过缓冲上限的日志
    for (let i = 1; i <= 6; i++) {
      fakeProc.stdout.emit('data', Buffer.from(`line-${i}\n`));
    }
    const logs = server.recentLogs;
    expect(logs).toHaveLength(3);
    expect(logs[0]).toBe('line-4');
    expect(logs[logs.length - 1]).toBe('line-6');
  });

  it('listening 端口与期望不一致时告警', async () => {
    const logger = makeLogger();
    const server = newServer({ port: 4199, logger });
    await server.start();
    fakeProc.stderr.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:9999\n'));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('实际监听端口 9999 与期望 4199 不一致'),
    );
  });

  it('D2：serveHostname 选项控制 --hostname 绑定地址，内部 baseUrl 仍恒回环', async () => {
    const server = newServer({ port: 4199, serveHostname: '0.0.0.0' });
    const baseUrl = await server.start();
    expect(baseUrl).toBe('http://127.0.0.1:4199');
    expect(mockedSpawn.mock.calls[0][1]).toEqual([
      'serve',
      '--port',
      '4199',
      '--hostname',
      '0.0.0.0',
      '--pure',
    ]);
  });

  it('D2：serveHostname 缺省读 env OPENCODE_SERVE_HOSTNAME（容器内 0.0.0.0 覆盖本地默认）', async () => {
    const prev = process.env.OPENCODE_SERVE_HOSTNAME;
    process.env.OPENCODE_SERVE_HOSTNAME = '0.0.0.0';
    try {
      const server = newServer({ port: 4199 });
      await server.start();
      expect(mockedSpawn.mock.calls[0][1]).toContain('0.0.0.0');
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCODE_SERVE_HOSTNAME;
      } else {
        process.env.OPENCODE_SERVE_HOSTNAME = prev;
      }
    }
  });

  /** T4c restart：每次 spawn 返回新 FakeChild；kill(-pid) 按 pid 路由到对应 child。 */
  function setupMultiChildSpawn(): FakeChild[] {
    const children: FakeChild[] = [];
    mockedSpawn.mockImplementation(() => {
      const child = new FakeChild(6000 + children.length);
      children.push(child);
      return child;
    });
    killSpy.mockImplementation((pid: number, signal?: string | number) => {
      const child = children.find((c) => -c.pid === pid);
      if (!child || child.exitCode !== null) {
        const err = new Error('kill ESRCH: no such process') as Error & { code: string };
        err.code = 'ESRCH';
        throw err;
      }
      child.kill(String(signal ?? 'SIGTERM'));
      return true;
    });
    return children;
  }

  it('restart：运行中先 stop（SIGTERM 进程组）再 start，随机端口变化', async () => {
    mockNetOnce([{ assignedPort: 53001 }, { assignedPort: 53002 }]);
    const children = setupMultiChildSpawn();
    const server = newServer({ port: 0 });

    await server.start();
    expect(server.port).toBe(53001);
    expect(children).toHaveLength(1);

    const newBaseUrl = await server.restart();
    expect(newBaseUrl).toBe('http://127.0.0.1:53002');
    expect(server.port).toBe(53002);
    expect(server.isRunning).toBe(true);
    // 两次 spawn（stop 后重新 start）+ 第一次进程组 SIGTERM 清理
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    expect(killSpy).toHaveBeenCalledWith(-6000, 'SIGTERM');
  });

  it('restart：已停止（未运行）时直接 start，不抛错', async () => {
    mockNetOnce([{ assignedPort: 53011 }, { assignedPort: 53012 }]);
    setupMultiChildSpawn();
    const server = newServer({ port: 0 });

    await server.start();
    await server.stop();
    expect(server.isRunning).toBe(false);

    const baseUrl = await server.restart();
    expect(server.isRunning).toBe(true);
    expect(baseUrl).toBe('http://127.0.0.1:53012');
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  });

  it('restart：从未启动时直接 start（幂等入口，无 stop 副作用）', async () => {
    mockNetOnce([{ assignedPort: 53021 }]);
    const server = newServer({ port: 0 });
    const baseUrl = await server.restart();
    expect(baseUrl).toBe('http://127.0.0.1:53021');
    expect(server.isRunning).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
  });
});
