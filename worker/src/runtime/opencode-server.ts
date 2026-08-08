/**
 * T3 V1Runtime：opencode serve 子进程管理。
 *
 * 职责（对齐计划 D2 铁律，Oracle 实测）：
 * 1. spawn `opencode serve --port <p> --hostname 127.0.0.1 --pure`
 *    —— --pure 必带（去插件/MEMORY 注入/默认 agent；非 --pure input tokens 高达 7601）；
 *    env 注入 OPENCODE_SERVER_PASSWORD（Basic Auth，username=opencode，空则不设）。
 * 2. 端口管理：start 前用 net.createServer 探测空闲端口，占用则 +1 重试（最多 5 次）；
 *    port=0 时由 OS 分配随机空闲端口（已实测 `opencode serve --help` 默认 --port 0 即随机）。
 * 3. 进程组清理：spawn `detached: true` + `process.kill(-pid)`（负 pid = 进程组组长），
 *    3s 未退出则 SIGKILL 兜底（实测无残留）。
 * 4. 健康检查：启动后轮询 `GET http://127.0.0.1:{port}/` 直到 2xx（带 Basic Auth），
 *    超时 30s；serve 提前退出（exitCode 非 null）即报错。
 * 5. stdout/stderr pipe 收集日志到环形缓冲（保留最近 N 行供 debug）。
 *
 * 本类不依赖 server 代码、不引入 nestjs（worker 独立进程铁律）。
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as http from 'http';
import * as net from 'net';

/** 最小日志接口（默认 console）。 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface OpencodeServerOptions {
  /** serve 端口；>0 从该端口开始探测（占用 +1 重试），0 = OS 随机空闲端口 */
  port: number;
  /** serve 认证密码（OPENCODE_SERVER_PASSWORD，Basic Auth username=opencode）；空 = 不设鉴权 */
  serverPassword?: string;
  /** opencode CLI 二进制路径；默认 'opencode'（测试可指向假 serve 脚本） */
  command?: string;
  /** serve 工作目录；默认 process.cwd() */
  cwd?: string;
  /** 健康检查总超时 ms；默认 30000 */
  healthCheckTimeoutMs?: number;
  /** 健康检查轮询间隔 ms；默认 500 */
  healthCheckIntervalMs?: number;
  /** 日志环形缓冲行数；默认 200 */
  logBufferSize?: number;
  /** 端口冲突重试次数；默认 5 */
  portRetryCount?: number;
  /** 日志输出；默认 console */
  logger?: Logger;
}

const DEFAULT_COMMAND = 'opencode';
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 500;
const DEFAULT_LOG_BUFFER_SIZE = 200;
const DEFAULT_PORT_RETRY_COUNT = 5;
/** D2 铁律：serve 必须只监听本机回环 */
const SERVE_HOSTNAME = '127.0.0.1';
/** serve 日志中实际监听地址的正则（`opencode server listening on http://...`） */
const LISTENING_RE = /listening on http:\/\/127\.0\.0\.1:(\d+)/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 用 net.createServer 探测端口是否空闲（bind 成功即空闲，随即关闭）。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, SERVE_HOSTNAME, () => {
      server.close(() => resolve(true));
    });
  });
}

/** 让 OS 分配一个随机空闲端口（bind 0，读回实际端口后关闭）。 */
function getRandomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, SERVE_HOSTNAME, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** GET 指定 URL，返回 statusCode；网络错/超时抛错。 */
function httpGetStatus(url: string, authHeader?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = authHeader ? { Authorization: authHeader } : {};
    const req = http.get(url, { headers, timeout: 2000 }, (res) => {
      // 必须消费响应体，否则 keep-alive 连接不释放
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('健康检查请求超时')));
    req.on('error', reject);
  });
}

export class OpencodeServer {
  readonly options: OpencodeServerOptions;
  /** 当前 spawn 的 serve 子进程（未启动/已停止为 null） */
  private process: ChildProcess | null = null;
  /** 实际监听端口（启动成功后有值；端口冲突重试后可能与 options.port 不同） */
  private actualPort: number | null = null;
  private baseUrlValue: string | null = null;
  private versionCache: string | null = null;
  private logs: string[] = [];
  /** F2 M3：spawn 异步失败（如 ENOENT）记录的错误；waitForHealthy 感知后立即失败不空转 */
  private spawnErrorValue: Error | null = null;

  constructor(options: OpencodeServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0) {
      throw new Error(`[opencode-server] port 必须是非负整数，收到: ${options.port}`);
    }
    this.options = {
      command: DEFAULT_COMMAND,
      cwd: process.cwd(),
      healthCheckTimeoutMs: DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      healthCheckIntervalMs: DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      logBufferSize: DEFAULT_LOG_BUFFER_SIZE,
      portRetryCount: DEFAULT_PORT_RETRY_COUNT,
      logger: console,
      ...options,
    };
  }

  get baseUrl(): string | null {
    return this.baseUrlValue;
  }

  get port(): number | null {
    return this.actualPort;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  get version(): string {
    return this.versionCache ?? 'unknown';
  }

  /** 最近日志（环形缓冲副本），供启动失败/调试查看。 */
  get recentLogs(): string[] {
    return [...this.logs];
  }

  /** F2 M3：spawn 异步失败错误（如 opencode 不在 PATH 时的 ENOENT）；无失败为 null。 */
  get spawnError(): Error | null {
    return this.spawnErrorValue;
  }

  /** 启动 serve 子进程，健康检查通过后返回 baseUrl。 */
  async start(): Promise<string> {
    if (this.isRunning && this.baseUrlValue) {
      return this.baseUrlValue;
    }
    this.versionCache = this.detectVersion();
    const port = await this.resolvePort();
    let proc: ChildProcess;
    try {
      proc = this.spawnServe(port);
    } catch (err) {
      throw new Error(
        `[opencode-server] 启动 opencode serve 失败: ${(err as Error).message}`,
      );
    }
    this.process = proc;
    this.actualPort = port;
    try {
      await this.waitForHealthy(port);
    } catch (err) {
      await this.stop();
      throw err;
    }
    this.baseUrlValue = `http://${SERVE_HOSTNAME}:${port}`;
    this.options.logger?.info(`[opencode-server] serve 就绪: ${this.baseUrlValue} (pid=${proc.pid})`);
    return this.baseUrlValue;
  }

  /** 停止 serve：kill(-pid) 进程组 + 3s 后 SIGKILL 兜底，await 退出。 */
  async stop(timeoutMs = 3000): Promise<void> {
    const proc = this.process;
    this.process = null;
    this.baseUrlValue = null;
    if (!proc || proc.pid === undefined) {
      return;
    }
    const pid = proc.pid;
    try {
      // D2 铁律：负 pid = 进程组组长，一次性清理 serve 及其子进程
      process.kill(-pid, 'SIGTERM');
    } catch {
      // ESRCH：进程组已不存在（提前退出/已在别处清理）
    }
    await this.waitForExit(proc, timeoutMs);
    if (proc.exitCode === null) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // 同上：已退出
      }
      await this.waitForExit(proc, timeoutMs);
    }
  }

  /** 探测 opencode CLI 版本（start 时调用，失败不阻断启动）。 */
  private detectVersion(): string {
    try {
      const result = spawnSync(this.options.command!, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      return (result.stdout ?? '').trim() || (result.stderr ?? '').trim() || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * 端口解析：>0 从 options.port 开始探测空闲（占用 +1 重试，最多 portRetryCount 次）；
   * 0 则 OS 随机空闲端口。返回最终可用端口。
   */
  private async resolvePort(): Promise<number> {
    const { port, portRetryCount } = this.options;
    if (port === 0) {
      const randomPort = await getRandomFreePort();
      this.options.logger?.info(`[opencode-server] 随机空闲端口: ${randomPort}`);
      return randomPort;
    }
    let candidate = port;
    for (let attempt = 0; attempt < portRetryCount!; attempt++) {
      if (await isPortFree(candidate)) {
        return candidate;
      }
      this.options.logger?.warn(`[opencode-server] 端口 ${candidate} 被占用，尝试 ${candidate + 1}`);
      candidate += 1;
    }
    throw new Error(
      `[opencode-server] 端口冲突：${port}-${port + portRetryCount! - 1} 均被占用，请释放端口或设置 OPENCODE_SERVE_PORT`,
    );
  }

  /** spawn serve 子进程；detached + stdio pipe；env 注入 OPENCODE_SERVER_PASSWORD。 */
  private spawnServe(port: number): ChildProcess {
    const args = [
      'serve',
      '--port',
      String(port),
      '--hostname',
      SERVE_HOSTNAME,
      // D2 铁律：--pure 必带（去插件/MEMORY 注入/默认 agent），缺失将导致 input tokens 高达 7601
      '--pure',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.options.serverPassword) {
      env.OPENCODE_SERVER_PASSWORD = this.options.serverPassword;
    }
    const proc = spawn(this.options.command!, args, {
      cwd: this.options.cwd,
      env,
      // D2 铁律：detached:true → 独立进程组，进程组组长即 proc.pid，可用 kill(-pid) 整体清理
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (chunk: Buffer) => this.pushLog(chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => this.pushLog(chunk.toString()));
    // F2 M3：spawn 异步失败（ENOENT 等，opencode 不在 PATH）记录字段——waitForHealthy
    // 循环检查该字段立即抛错，避免健康检查空转 30s 才失败
    proc.once('error', (err) => {
      this.spawnErrorValue = err;
      this.pushLog(`[spawn error] ${err.message}`);
    });
    return proc;
  }

  /** 轮询 GET / 直到 2xx；serve 提前退出或超时即抛错（附最近日志）。 */
  private async waitForHealthy(port: number): Promise<void> {
    const timeoutMs = this.options.healthCheckTimeoutMs!;
    const intervalMs = this.options.healthCheckIntervalMs!;
    const url = `http://${SERVE_HOSTNAME}:${port}/`;
    const authHeader = this.buildAuthHeader();
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;

    while (Date.now() < deadline) {
      // F2 M3：spawn 异步失败（ENOENT）优先于健康检查判错——立即抛，不空转至超时
      if (this.spawnErrorValue) {
        throw new Error(
          `[opencode-server] spawn 失败: ${this.spawnErrorValue.message}\n最近日志:\n${this.logs.join('\n')}`,
        );
      }
      const proc = this.process;
      if (proc && proc.exitCode !== null) {
        throw new Error(
          `[opencode-server] serve 提前退出（exitCode=${proc.exitCode}），最近日志:\n${this.logs.join('\n')}`,
        );
      }
      try {
        const status = await httpGetStatus(url, authHeader);
        if (status >= 200 && status < 300) {
          this.options.logger?.info(`[opencode-server] 健康检查通过 (HTTP ${status})`);
          return;
        }
        lastError = new Error(`HTTP ${status}`);
      } catch (err) {
        lastError = err;
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `[opencode-server] 健康检查超时（${timeoutMs}ms），最后一次: ${lastError ? String(lastError) : '无请求'}\n最近日志:\n${this.logs.join('\n')}`,
    );
  }

  private buildAuthHeader(): string | undefined {
    const password = this.options.serverPassword;
    if (!password) {
      return undefined;
    }
    // D2 铁律：Basic Auth username=opencode，密码即 OPENCODE_SERVER_PASSWORD
    return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  }

  /** 收集 serve 日志到环形缓冲；顺带解析实际监听端口做防御性校验。 */
  private pushLog(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.logs.push(trimmed);
      const match = LISTENING_RE.exec(trimmed);
      if (match && this.actualPort !== null && Number(match[1]) !== this.actualPort) {
        this.options.logger?.warn(
          `[opencode-server] serve 实际监听端口 ${match[1]} 与期望 ${this.actualPort} 不一致`,
        );
      }
    }
    const bufferSize = this.options.logBufferSize!;
    if (this.logs.length > bufferSize) {
      this.logs.splice(0, this.logs.length - bufferSize);
    }
  }

  private waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (proc.exitCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => resolve(), timeoutMs);
      timer.unref?.();
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
