/**
 * OpencodeServer 单元测试（T3）。
 *
 * mock child_process.spawn / http.get / net.createServer，覆盖：
 * - spawn 参数（--port / --hostname / detached:true / env 注入；**不含 --pure**：v2 无此 flag）
 * - start 成功 + 健康检查通过 → baseUrl
 * - 端口冲突重试（占用 → +1）、随机端口（port=0）
 * - stop 进程组 kill(-pid) + SIGKILL 兜底
 * - 健康检查超时 / serve 提前退出 / spawn 抛错
 * - 日志环形缓冲 / listening 端口不一致告警
 * - v2 适配（T1/T2/T3）：版本规范化、--pure 移除、banner 密码解析、恒开鉴权 fail-fast
 * 真实 spawn 集成见 opencode-server.integration.spec.ts。
 */

import { spawn, spawnSync } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));
jest.mock('http', () => ({ get: jest.fn() }));
jest.mock('net', () => ({ createServer: jest.fn() }));

import {
  LISTENING_RE,
  OpencodeServer,
  Logger,
  SERVER_PASSWORD_RE,
  buildIsolatedServeEnv,
} from './opencode-server';
import { resolveIsolationScope } from '../config';

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
  // OPENCODE_PURE 默认不设 → spawn 不带 --pure（v2 已无此 flag，见 T2）。
  // 显式清空避免宿主环境变量泄漏进用例断言（case 里按需临时设置）。
  // OPENCODE_SERVER_PASSWORD 同理：spawn 继承整个 process.env，宿主导出该变量时
  // （连真实 serve 是常规操作）会污染「为空时不注入」这条断言。
  // OPENCODE_ALLOW_GENERATED_PASSWORD：v2 恒开鉴权的逃生开关，默认关闭。
  delete process.env.OPENCODE_PURE;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_ALLOW_GENERATED_PASSWORD;
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
  allowGeneratedPassword?: boolean;
  command?: string;
  healthCheckTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  logBufferSize?: number;
  portRetryCount?: number;
  serveHostname?: string;
  serveLogFilePath?: string;
  isolationScope?: ReturnType<typeof resolveIsolationScope>;
  logger?: Logger;
}

function newServer(opts: NewServerOpts): OpencodeServer {
  return new OpencodeServer({
    port: opts.port,
    // v2 恒开鉴权：默认给一个密码（不配密码时 worker 会 fail-fast，见 T3 用例）
    serverPassword: opts.serverPassword ?? 'test-pw',
    allowGeneratedPassword: opts.allowGeneratedPassword,
    command: opts.command ?? 'opencode',
    healthCheckTimeoutMs: opts.healthCheckTimeoutMs ?? 1000,
    healthCheckIntervalMs: opts.healthCheckIntervalMs ?? 20,
    logBufferSize: opts.logBufferSize ?? 200,
    portRetryCount: opts.portRetryCount ?? 5,
    serveHostname: opts.serveHostname,
    // 测试默认指向不存在路径：文件次级源必须静默降级，绝不读真实开发机日志（隔离）
    serveLogFilePath: opts.serveLogFilePath ?? path.join(os.tmpdir(), `absent-opencode-log-${process.pid}`),
    isolationScope: opts.isolationScope ?? resolveIsolationScope({ HOME: '/tmp/vteam-test-home' }),
    logger: opts.logger,
  });
}

describe('OpencodeServer', () => {
  it('构造：port 非负整数校验', () => {
    expect(() => new OpencodeServer({ port: -1 })).toThrow(/非负整数/);
    expect(() => new OpencodeServer({ port: 1.5 })).toThrow(/非负整数/);
    expect(() => new OpencodeServer({ port: 0 })).not.toThrow();
  });

  it('start 成功：spawn 参数含 --port/--hostname，detached:true，健康检查通过后返回 baseUrl', async () => {
    const logger = makeLogger();
    const server = newServer({ port: 4199, logger });
    const baseUrl = await server.start();

    expect(baseUrl).toBe('http://127.0.0.1:4199');
    expect(server.baseUrl).toBe('http://127.0.0.1:4199');
    expect(server.port).toBe(4199);
    expect(server.pid).toBe(4242);
    expect(server.isRunning).toBe(true);
    expect(server.version).toBe('1.18.15');

    // 默认非 --pure：内置插件（omo）需非 pure 才会加载
    expect(mockedSpawn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--port', '4199', '--hostname', '127.0.0.1', '--print-logs'],
      expect.objectContaining({ detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
    const args = mockedSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--pure');
    // T17 修复：诊断日志默认写文件而非 stderr → 必须带 --print-logs 才会进 this.logs
    expect(args).toContain('--print-logs');
    // 健康检查使用带鉴权的 GET
    expect(mockedHttpGet).toHaveBeenCalled();
  });

  it('T2：OPENCODE_PURE=1 → **不再**拼 --pure（v2 传该 flag 会 exit 1），只记一条失效告警', async () => {
    for (const truthy of ['1', 'true', 'yes', 'on', 'y', 'TRUE', ' Yes ']) {
      jest.clearAllMocks();
      process.env.OPENCODE_PURE = truthy;
      await newServer({ port: 4199 }).start();
      expect(mockedSpawn.mock.calls[0][1]).not.toContain('--pure');
    }
  });

  it('T2：OPENCODE_PURE=1 → 告警说明该开关在 v2 已失效（插件抑制机制待落地）', async () => {
    const logger = makeLogger();
    process.env.OPENCODE_PURE = '1';
    await newServer({ port: 4199, logger }).start();
    expect(mockedSpawn.mock.calls[0][1]).not.toContain('--pure');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('OPENCODE_PURE / OmO 开关在 v2 上已失效'),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('不再拼 --pure'));

    jest.clearAllMocks();
    delete process.env.OPENCODE_PURE;
    const logger2 = makeLogger();
    await newServer({ port: 4199, logger: logger2 }).start();
    expect(mockedSpawn.mock.calls[0][1]).not.toContain('--pure');
    expect(logger2.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('OPENCODE_PURE / OmO 开关在 v2 上已失效'),
    );
  });

  it('T2：OmO 开关关闭（omoEnabled=false）同样不再拼 --pure，只告警', async () => {
    const logger = makeLogger();
    const server = new OpencodeServer({
      port: 4199,
      serverPassword: 'test-pw',
      command: 'opencode',
      healthCheckTimeoutMs: 1000,
      healthCheckIntervalMs: 20,
      serveLogFilePath: path.join(os.tmpdir(), `absent-opencode-log-${process.pid}`),
      logger,
      omoEnabled: () => false,
    });
    await server.start();
    expect(mockedSpawn.mock.calls[0][1]).not.toContain('--pure');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('OPENCODE_PURE / OmO 开关在 v2 上已失效'),
    );
  });

  it('OPENCODE_PURE 为 0/false/no/未设 → 不带 --pure（只有显式真值才切纯净）', async () => {
    for (const falsy of ['0', 'false', 'no', 'off', 'n']) {
      jest.clearAllMocks();
      process.env.OPENCODE_PURE = falsy;
      await newServer({ port: 4199 }).start();
      expect(mockedSpawn.mock.calls[0][1]).not.toContain('--pure');
    }
  });

  it('OPENCODE_PURE 为空串/纯空白 → 删除该变量，绝不把空串透传给 serve', async () => {
    // 回归：opencode 自己解析 OPENCODE_PURE，空串会让它 SchemaError 直接启动失败
    //（compose 里写过 ${OPENCODE_PURE:-} 导致线上 worker 起不来）。
    for (const blank of ['', '   ', '\t']) {
      jest.clearAllMocks();
      process.env.OPENCODE_PURE = blank;
      await newServer({ port: 4199 }).start();
      expect(mockedSpawn.mock.calls[0][1]).not.toContain('--pure');
      const env = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect(env.OPENCODE_PURE).toBeUndefined();
    }
  });

  it('serverPassword 注入 env 的 OPENCODE_SERVER_PASSWORD；显式空密码时不注入', async () => {
    await newServer({ port: 4199, serverPassword: 's3cret' }).start();
    const env = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('s3cret');

    jest.clearAllMocks();
    // 显式空密码 + 逃生开关 → 走「捕获 v2 自动生成密码」路径（不注入 env）
    await newServer({ port: 4199, serverPassword: '', allowGeneratedPassword: true }).start();
    const env2 = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env2.OPENCODE_SERVER_PASSWORD).toBeUndefined();
  });

  it('T1：version 原始串与规范化 semver 同时可得（上报用 semver）', async () => {
    mockedSpawnSync.mockImplementation(() => ({ stdout: 'opencode v2.0.28\n', stderr: '' }));
    const server = newServer({ port: 4199 });
    await server.start();
    expect(server.version).toBe('opencode v2.0.28');
    expect(server.versionSemver).toBe('2.0.28');
  });

  it('T2：v2 banner `server listening on http://127.0.0.1:4199` → LISTENING_RE 仍匹配并取到端口', () => {
    const match = LISTENING_RE.exec('server listening on http://127.0.0.1:4199');
    expect(match).not.toBeNull();
    expect(match![1]).toBe('4199');
  });

  it('T2：v2 banner `server password AbC123` → SERVER_PASSWORD_RE 取到密码', () => {
    const match = SERVER_PASSWORD_RE.exec('server password AbC123');
    expect(match).not.toBeNull();
    expect(match![1]).toBe('AbC123');
  });

  it('T3：密码为空且未开逃生开关 → 启动 fail-fast（可操作错误，指出该设哪个 env）', async () => {
    const server = newServer({ port: 4199, serverPassword: '', allowGeneratedPassword: false });
    await expect(server.start()).rejects.toThrow(/v2 恒开鉴权/);
    await expect(server.start()).rejects.toThrow(/OPENCODE_SERVER_PASSWORD/);
    await expect(server.start()).rejects.toThrow(/OPENCODE_ALLOW_GENERATED_PASSWORD/);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('T3：逃生开关开启 → 从 serve stdout 捕获自动生成密码并用于鉴权（明文不落日志）', async () => {
    const logger = makeLogger();
    const server = newServer({ port: 4199, serverPassword: '', allowGeneratedPassword: true, logger });
    await server.start();
    fakeProc.stdout.emit('data', Buffer.from('server password AbC123xyz\n'));
    expect(server.effectiveServerPassword).toBe('AbC123xyz');
    // 明文密码绝不进日志（环形缓冲会经 recentLogTail() 外泄到错误信息）
    expect(server.recentLogs.join('\n')).not.toContain('AbC123xyz');
    expect(server.recentLogs.join('\n')).toContain('server password ***');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('已从 stdout 捕获自动生成密码（明文不落日志）'),
    );
  });

  it('T3：健康检查打 /api/info（v2 的 GET / 未鉴权也返回 200，探不到鉴权状态）', async () => {
    await newServer({ port: 4199, serverPassword: 'pw' }).start();
    const [url] = mockedHttpGet.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:4199/api/info');
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

  it('recentErrors：过滤模型错误关键词日志行，保留最近 limit 条（正常日志不返回）', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    fakeProc.stderr.emit(
      'data',
      Buffer.from(
        'message="stream error" error.error="AI_APICallError: Rate limit exceeded."\n' +
          'message="session created"\n' +
          'message="stream error" error.error="AI_APICallError: Free usage exceeded."\n',
      ),
    );
    const errors = server.recentErrors();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Rate limit exceeded');
    expect(errors[1]).toContain('Free usage exceeded');
  });

  it('recentErrors：limit 截断保留最近 N 条；无错误日志返回空数组', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    fakeProc.stderr.emit(
      'data',
      Buffer.from(
        'message="stream error" error.error="AI_APICallError: Rate limit exceeded."\n' +
          'message="stream error" error.error="AI_APICallError: quota exceeded"\n' +
          'message="stream error" error.error="AI_APICallError: 429 Too Many Requests"\n',
      ),
    );
    expect(server.recentErrors(2)).toHaveLength(2);
    expect(server.recentErrors(2)[1]).toContain('429');
    // 正常日志（无错误关键词）→ 空
    const clean = newServer({ port: 4199 });
    await clean.start();
    fakeProc.stdout.emit('data', Buffer.from('opencode server ready\n'));
    expect(clean.recentErrors()).toHaveLength(0);
  });

  it('recentErrors：裸关键词的 INFO 行不入选（结构化错误门防误报：messageID 中的 429 不得触发提前 abort）', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    fakeProc.stderr.emit(
      'data',
      Buffer.from(
        'timestamp=2026-09-15T08:23:25.825Z level=INFO run=57ba8b84 message=process session.id=ses_other messageID=msg_0a429eb46001rGylqWhDPAJKL6\n',
      ),
    );
    expect(server.recentErrors()).toHaveLength(0);
    expect(server.recentErrors(5, 'ses_other')).toHaveLength(0);
  });

  it('recentErrors：按会话过滤——其它会话的错误行不返回给本会话（stale 隔离）', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    fakeProc.stderr.emit(
      'data',
      Buffer.from(
        'timestamp=t level=ERROR message="stream error" session.id=ses_old error.error="AI_APICallError: Rate limit exceeded."\n' +
          'timestamp=t level=ERROR message="stream error" session.id=ses_mine error.error="AI_APICallError: Free usage exceeded."\n',
      ),
    );
    const mine = server.recentErrors(5, 'ses_mine');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('Free usage exceeded');
    expect(server.recentErrors(5, 'ses_mine').join('\n')).not.toContain('ses_old');
  });

  it('recentErrors：无归属行不通配指定会话（子 agent share subscriber 失败不秒杀其它会话主 agent）', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    fakeProc.stderr.emit(
      'data',
      Buffer.from(
        'timestamp=2026-09-21T08:18:15.258Z level=ERROR run=1879706f message="share subscriber failed" type=message.updated cause="Cause([Fail(ProviderModelNotFoundError: Model not found: opencode/gpt-5-nano.)])"\n',
      ),
    );
    // 指定会话查询 → 无归属行不得返回（线上 08:18 一行双杀 PM+architect 根因）
    expect(server.recentErrors(5, 'ses_f3d6e26efffeyh8fJ5IcXav64f')).toHaveLength(0);
    expect(server.recentErrors(5, 'ses_other')).toHaveLength(0);
    // 无会话参数（全局尸检）→ 仍返回
    expect(server.recentErrors()).toHaveLength(1);
  });

  it('recentErrors：sessionID=（无点形态，prompt_async 失败行）正确归属会话', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    fakeProc.stderr.emit(
      'data',
      Buffer.from(
        'timestamp=t level=ERROR run=x message="prompt_async failed" sessionID=ses_mine error.error="AI_APICallError: Rate limit exceeded."\n',
      ),
    );
    expect(server.recentErrors(5, 'ses_mine')).toHaveLength(1);
    expect(server.recentErrors(5, 'ses_other')).toHaveLength(0);
  });

  it('recentLogTail：无会话过滤时返回原始尾部行（含非错误行，供失败原因附证据）', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    fakeProc.stderr.emit('data', Buffer.from('level=INFO message=loading path=/x\nlevel=INFO message=loop\n'));
    const tail = server.recentLogTail(5, 'ses_mine');
    expect(tail).toHaveLength(2);
    expect(tail[1]).toContain('message=loop');
  });

  it('start 清空上一进程日志（serve 重启后旧会话错误不泄漏进新会话原因）', async () => {
    const server = newServer({ port: 4199 });
    await server.start();
    fakeProc.stderr.emit(
      'data',
      Buffer.from('timestamp=t level=ERROR message="stream error" session.id=ses_old error.error="AI_APICallError: Rate limit exceeded."\n'),
    );
    expect(server.recentErrors()).toHaveLength(1);
    await server.stop();
    const restarted = new FakeChild(5252);
    fakeProc = restarted;
    mockedSpawn.mockImplementation(() => restarted);
    await server.start();
    expect(server.recentLogs).toHaveLength(0);
    expect(server.recentErrors()).toHaveLength(0);
  });

  it('缓冲区不驱逐错误行：缓冲上限内，错误行存活到下一次 500ms poll', async () => {
    const server = newServer({ port: 4199, logBufferSize: 500 });
    await server.start();
    // 实测 500ms poll 窗口最多 31 行；注入 31 行噪声后错误行，再补 31 行 → 错误行必须存活
    const noise = Array.from({ length: 15 }, (_, i) => `level=INFO message=loop n=${i}`).join('\n');
    const errorLine =
      'timestamp=t level=ERROR message="stream error" session.id=ses_mine error.error="AI_APICallError: Rate limit exceeded."';
    fakeProc.stderr.emit('data', Buffer.from(`${noise}\n${errorLine}\n${noise}\n`));
    const errors = server.recentErrors(5, 'ses_mine');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Rate limit exceeded');
  });

  it('缓冲区容量校验：500 行上限下，31 行/500ms 的密度在 16 个 poll 周期内不会驱逐错误行', async () => {
    const server = newServer({ port: 4199, logBufferSize: 500 });
    await server.start();
    for (let round = 0; round < 16; round++) {
      for (let i = 0; i < 31; i++) {
        fakeProc.stdout.emit('data', Buffer.from(`level=INFO message=noise r=${round} i=${i}\n`));
      }
    }
    const err =
      'timestamp=t level=ERROR message="stream error" session.id=ses_x error.error="AI_APICallError: Rate limit exceeded."';
    fakeProc.stdout.emit('data', Buffer.from(`${err}\n`));
    for (let i = 0; i < 31; i++) {
      fakeProc.stdout.emit('data', Buffer.from(`level=INFO message=after i=${i}\n`));
    }
    expect(server.recentErrors(5)).toHaveLength(1);
    expect(server.recentErrors(5)[0]).toContain('Rate limit exceeded');
  });

  it('日志文件次级源：环形缓冲无匹配时回退读文件尾部；文件缺失静默降级', async () => {
    const logFile = path.join(os.tmpdir(), `opencode-log-${process.pid}-${Date.now()}.log`);
    fs.writeFileSync(
      logFile,
      'level=INFO message=startup\n' +
        'timestamp=t level=ERROR message="stream error" session.id=ses_f error.error="AI_APICallError: Rate limit exceeded."\n',
    );
    try {
      const server = newServer({ port: 4199, serveLogFilePath: logFile });
      await server.start();
      // 环形缓冲（stderr 管道）为空 → 回退文件
      const errors = server.recentErrors(5, 'ses_f');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Rate limit exceeded');

      const absent = newServer({ port: 4199, serveLogFilePath: path.join(os.tmpdir(), `absent-${Date.now()}.log`) });
      await absent.start();
      expect(absent.recentErrors()).toHaveLength(0);
      expect(absent.recentLogTail()).toHaveLength(0);
    } finally {
      fs.unlinkSync(logFile);
    }
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
      '--print-logs',
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

describe('T16b：隔离配置域（spawn env 不继承宿主 HOME / XDG_*）', () => {
  const SCOPE = resolveIsolationScope({ HOME: '/tmp/vteam-iso-home' });

  it('子进程 env：HOME / XDG_* 全部指向隔离域，且**不是**宿主的 HOME', async () => {
    const prevHome = process.env.HOME;
    process.env.HOME = '/host/home';
    try {
      await newServer({ port: 4199, isolationScope: SCOPE }).start();
      const env = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect(env.HOME).toBe(SCOPE.home);
      expect(env.XDG_CONFIG_HOME).toBe(SCOPE.configHome);
      expect(env.XDG_DATA_HOME).toBe(SCOPE.dataHome);
      expect(env.XDG_STATE_HOME).toBe(SCOPE.stateHome);
      expect(env.XDG_CACHE_HOME).toBe(SCOPE.cacheHome);
      expect(env.HOME).not.toBe('/host/home');
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  it('子进程 env：宿主残留的配置发现入口被清掉（否则全局配置会被追加回来）', async () => {
    const prev = {
      config: process.env.OPENCODE_CONFIG,
      content: process.env.OPENCODE_CONFIG_CONTENT,
      disable: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    };
    process.env.OPENCODE_CONFIG = '/host/global.json';
    process.env.OPENCODE_CONFIG_CONTENT = '{"plugin":["host-plugin"]}';
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
    try {
      await newServer({ port: 4199, isolationScope: SCOPE }).start();
      const env = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
      expect(env.OPENCODE_CONFIG).toBeUndefined();
      expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBeUndefined();
    } finally {
      for (const [key, value] of [
        ['OPENCODE_CONFIG', prev.config],
        ['OPENCODE_CONFIG_CONTENT', prev.content],
        ['OPENCODE_DISABLE_PROJECT_CONFIG', prev.disable],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('密码注入不受隔离影响（OPENCODE_SERVER_PASSWORD 照旧进 env）', async () => {
    await newServer({ port: 4199, serverPassword: 's3cret', isolationScope: SCOPE }).start();
    const env = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.OPENCODE_SERVER_PASSWORD).toBe('s3cret');
  });

  it('启动日志打印隔离根目录（不含任何密文）', async () => {
    const logger = makeLogger();
    await newServer({ port: 4199, isolationScope: SCOPE, logger }).start();
    const logged = logger.info.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(SCOPE.root);
    expect(logged).toContain('隔离配置域');
    expect(logged).not.toContain('test-pw');
  });

  it('未显式传隔离域时也用默认隔离域（不会退回继承宿主 HOME）', async () => {
    const server = new OpencodeServer({
      port: 4199,
      serverPassword: 'pw',
      command: 'opencode',
      healthCheckTimeoutMs: 1000,
      healthCheckIntervalMs: 20,
      serveLogFilePath: path.join(os.tmpdir(), `absent-${process.pid}`),
    });
    await server.start();
    const env = mockedSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.HOME).toBe(resolveIsolationScope().home);
    expect(env.HOME).not.toBe(process.env.HOME);
  });

  it('buildIsolatedServeEnv：纯函数——只改 HOME/XDG_*，其余 env 原样保留', () => {
    const env = buildIsolatedServeEnv(SCOPE, {
      PATH: '/usr/bin',
      MY_CUSTOM: 'keep-me',
      HOME: '/host/home',
      XDG_CONFIG_HOME: '/host/.config',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.MY_CUSTOM).toBe('keep-me');
    expect(env.HOME).toBe(SCOPE.home);
    expect(env.XDG_CONFIG_HOME).toBe(SCOPE.configHome);
  });
});
