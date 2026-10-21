/**
 * T3 V1Runtime：opencode serve 子进程管理。
 *
 * 职责（对齐计划 D2 铁律，Oracle 实测）：
 * 1. spawn `opencode serve --port <p> --hostname 127.0.0.1 [--print-logs]`
 *    env 注入 OPENCODE_SERVER_PASSWORD（Basic Auth，username=opencode）。
 * 2. 端口管理：start 前用 net.createServer 探测空闲端口，占用则 +1 重试（最多 5 次）；
 *    port=0 时由 OS 分配随机空闲端口（已实测 `opencode serve --help` 默认 --port 0 即随机）。
 * 3. 进程组清理：spawn `detached: true` + `process.kill(-pid)`（负 pid = 进程组组长），
 *    3s 未退出则 SIGKILL 兜底（实测无残留）。
 * 4. 健康检查：启动后轮询 `GET http://127.0.0.1:{port}/api/info` 直到 2xx（带 Basic Auth），
 *    超时 30s；serve 提前退出（exitCode 非 null）即报错。
 * 5. stdout/stderr pipe 收集日志到环形缓冲（保留最近 N 行供 debug）。
 *
 * ── OpenCode v2 适配（计划 T1/T2/T3 / D2 / D9 / D10）────────────────────────
 * 实测基线：`opencode v2.0.28`（`/Users/mac/.opencode/bin/opencode`）。
 *
 * a) **不再传 `--pure`**：v2 删掉了这个 flag，`opencode serve --pure` 直接 **exit 1**
 *    （`ERROR Unrecognized flag: --pure in command opencode serve`）——照旧传会让
 *    **每个 worker 启动即失败**。v1 的 `--pure` 语义（不加载外部插件）由 **T16b 的隔离
 *    配置域**承接（见下 e）；`OPENCODE_PURE` / OmO 开关降级为**只做告警**。
 * b) **banner 形态变化**：v2 打印 `server listening on http://HOST:PORT`，未配置密码时
 *    追加一行 `server password <PASSWORD>`（`LISTENING_RE` 非锚定，仍然匹配 ✅）。
 * c) **恒开鉴权**（D10）：v2 serve **总是**要求鉴权。密码为空时 v2 自动生成随机密码并
 *    打到 stdout——若不解析，worker 自己的所有请求都会 401 且错误信息不会告诉运维
 *    密码在哪。故：**密码为空 → 启动 fail-fast**（可操作错误）；显式逃生开关
 *    `OPENCODE_ALLOW_GENERATED_PASSWORD=1` 时改为从 serve stdout 捕获该密码
 *    （**明文密码绝不进日志**，日志只记「已从 stdout 捕获自动生成密码」）。
 *    Basic 用户名仍是 `opencode`（实测不变）。
 * d) **健康检查改打 `/api/info`**：v2 的 `GET /` 返回 **web SPA 的 200**（未鉴权也能过），
 *    探不到鉴权状态；`GET /api/info` 未鉴权 401 / 鉴权 200 —— 用它才能在启动期就发现
 *    「密码不对」（否则表现为运行期一串 401，排查成本高）。
 *
 * e) **隔离配置域（T16b / T6 结论落地）**：spawn 时**不继承宿主的 `HOME`**，改为注入
 *    自己的 `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` /
 *    `XDG_CACHE_HOME`（全部指向隔离根，见 `config.ts` 的 `resolveIsolationScope`）。
 *    实测（opencode v2.0.28）：v2 **没有 `--pure` 的等价物**——`plugins: []` /
 *    `instructions: []` / `experimental` / `OPENCODE_CONFIG*` 全部 no-op（`plugins` 是
 *    **跨配置合并**语义、`instructions` 只能**追加**），`OPENCODE_DISABLE_PROJECT_CONFIG=1`
 *    会连**项目 `opencode.json`** 一起杀掉（vteam 不能用），`plugins: ["-*"]` 会把内置
 *    agent/provider 一起关掉（`Agent not found: "build"`）⇒ **隔离配置发现路径是唯一
 *    可靠手段**：宿主的全局配置、全局插件、全局 `AGENTS.md` 全部不在作用域内。
 *    同时清掉 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` /
 *    `OPENCODE_DISABLE_PROJECT_CONFIG`（宿主残留会把全局配置重新拉回作用域）。
 *    ⚠️ **残留**：受管/系统配置目录（macOS `/Library/Application Support/opencode`、
 *    Linux `/etc/opencode`）**不受 XDG 控制**，v2 serve 会 watch 它——被 MDM 托管的机器上
 *    机器级插件仍可能进作用域，只有 `policies` 能压（计划 §10 U9，**本任务无法修复**）。
 *
 * **`--print-logs`（T17 修复，2026-09-17 实测；v2.0.28 复验仍有效）**：opencode serve 默认
 * 把诊断日志写 `$HOME/.local/share/opencode/log/opencode.log`（**文件，不是 stderr**），
 * stdout/stderr 只有启动 banner。因此原实现 `this.logs` 几乎收不到 serve 诊断行 →
 * `recentErrors()` 恒空 → 模型 API 错误（Rate limit/Free usage）无法被感知，只能空等
 * 首字超时 120s 并记成笼统「模型无任何输出」。修复 = spawn 加 `--print-logs`
 * （v2 仍接受该全局 flag，实测 server 的 logfmt 行照旧进 stderr、banner 仍在 stdout）。
 * 同时保留日志文件作为**次级**数据源（`serveLogFilePath`，可配；缺失静默降级），
 * 使捕获不依赖单一传输通道。
 *
 * 本类不依赖 server 代码、不引入 nestjs（worker 独立进程铁律）。
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import {
  isAnyLine,
  isServeErrorLine,
  lineBelongsToSession,
  lineBelongsToSessionStrict,
  readFileTailLines,
} from './serve-log';
import { getRandomFreePort, httpGetStatus, isPortFree } from './port-probe';
import { formatOpencodeVersion, parseOpencodeVersion, OpencodeVersionInfo } from './opencode-version';
import { OpencodeIsolationScope, resolveIsolationScope } from '../config';
export { defaultServeLogFilePath, readFileTailLines } from './serve-log';
export { parseOpencodeVersion, formatOpencodeVersion, normalizeOpencodeVersion } from './opencode-version';
export type { OpencodeVersionInfo } from './opencode-version';

/** 最小日志接口（默认 console）。 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface OpencodeServerOptions {
  /** serve 端口；>0 从该端口开始探测（占用 +1 重试），0 = OS 随机空闲端口 */
  port: number;
  /**
   * serve 认证密码（OPENCODE_SERVER_PASSWORD，Basic Auth username=opencode）。
   * v2 **恒开鉴权**：为空即启动 fail-fast（除非开 `allowGeneratedPassword` 逃生开关）。
   */
  serverPassword?: string;
  /**
   * 逃生开关：允许在**未配置**密码时，从 serve stdout 的 `server password <pw>` 行
   * 捕获 v2 自动生成的随机密码并采用（v2 恒开鉴权，密码为空必然 401）。
   * 缺省读 env `OPENCODE_ALLOW_GENERATED_PASSWORD`（真值词表同 opencode 布尔解析）。
   * 明文密码绝不进日志。
   */
  allowGeneratedPassword?: boolean;
  /** opencode CLI 二进制路径；默认 'opencode'（测试可指向假 serve 脚本） */
  command?: string;
  /** serve 工作目录；默认 process.cwd() */
  cwd?: string;
  /** 健康检查总超时 ms；默认 30000 */
  healthCheckTimeoutMs?: number;
  /** 健康检查轮询间隔 ms；默认 500 */
  healthCheckIntervalMs?: number;
  /** 日志环形缓冲行数；默认 500（实测 500ms 窗口最多 31 行，见 DEFAULT_LOG_BUFFER_SIZE） */
  logBufferSize?: number;
  /**
   * serve 日志文件路径（次级错误源；默认 opencode 固定落点
   * `$XDG_DATA_HOME/opencode/log/opencode.log`）。文件缺失/不可读 → 静默降级（空数组）。
   */
  serveLogFilePath?: string;
  /** 端口冲突重试次数；默认 5 */
  portRetryCount?: number;
  /** serve 绑定地址（D2：默认 env OPENCODE_SERVE_HOSTNAME ?? '127.0.0.1' 保住本地铁律；容器内设 0.0.0.0） */
  serveHostname?: string;
  /**
   * 隔离配置域（T16b）：serve 子进程的 `HOME` / `XDG_*` 全部指向它，
   * 宿主机的全局配置/插件/`AGENTS.md` 不在作用域内。
   * 缺省 = `resolveIsolationScope()`（= `<HOME>/.opencode-iso`）——**始终隔离**，
   * 调用方漏传也不会退回"继承宿主机 HOME"。
   */
  isolationScope?: OpencodeIsolationScope;
  /** 日志输出；默认 console */
  logger?: Logger;
  /**
   * OmO 启用开关的读取回调（index.ts 注入 readOmoEnabled(workDir)）。
   * ⚠️ v2 已无 `--pure` flag → 该开关**不再影响启动参数**，仅用于告警
   * （插件抑制由 T16b 的隔离配置域承接）。
   * 缺省不注入 = 恒为启用（保持既有行为）。
   */
  omoEnabled?: () => boolean;
}

/**
 * 构造 serve 子进程的环境变量（**隔离配置域**，T16b）。
 *
 * 做的事：
 * 1. `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME`
 *    全部指向隔离域 → 宿主的全局配置、全局插件、全局 `AGENTS.md`、会话库、凭据
 *    **一律不在作用域内**（实测：v2.0.28 认这 5 个变量，见 `opencode debug paths`）。
 * 2. 删掉 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_DISABLE_PROJECT_CONFIG`
 *    ——它们是"额外的配置发现入口"：前两者能把宿主配置**追加**进来（不是替换），
 *    第三者会连**项目 `opencode.json`** 一起禁掉（vteam 自己的 agents/mcp/plugins 就没了）。
 *
 * 纯函数（不读全局 env，除 `baseEnv` 缺省外），单测直接断言。
 */
export function buildIsolatedServeEnv(
  scope: OpencodeIsolationScope,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  env.HOME = scope.home;
  env.XDG_CONFIG_HOME = scope.configHome;
  env.XDG_DATA_HOME = scope.dataHome;
  env.XDG_STATE_HOME = scope.stateHome;
  env.XDG_CACHE_HOME = scope.cacheHome;
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_DISABLE_PROJECT_CONFIG;
  return env;
}

const DEFAULT_COMMAND = 'opencode';
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 500;
/**
 * 日志环形缓冲行数。2026-09-17 实测（容器内 opencode.log 34,139 行）：
 * 任意 500ms 滑动窗口最多 31 行（1s 最多 32，10s 最多 101）——轮询间隔即 500ms，
 * 一条 ERROR 行必须存活到下一次 poll。200 行仅 6.4x 余量，50-poll 长思考下累积
 * 亦可能逼近；常量 500 提供 ~16x 余量，代价可忽略（纯内存字符串）。
 */
const DEFAULT_LOG_BUFFER_SIZE = 500;
const DEFAULT_PORT_RETRY_COUNT = 5;
/** D2 铁律：serve 默认只监听本机回环（容器内经 OPENCODE_SERVE_HOSTNAME=0.0.0.0 覆盖） */
const DEFAULT_SERVE_HOSTNAME = '127.0.0.1';
/** worker 内部访问 serve 的稳定地址：恒回环（serve 绑定 0.0.0.0 时同容器回环仍可达） */
const LOOPBACK_HOSTNAME = '127.0.0.1';
/**
 * serve 实际监听地址的正则。v1 banner `listening on http://<host>:<port>`；
 * v2 banner `server listening on http://<host>:<port>`（多 `server ` 前缀）。
 * 正则**非锚定** → 两种形态都匹配（勿加锚点，否则 v2 失配）。
 */
export const LISTENING_RE = /listening on http:\/\/[^:\s/]+:(\d+)/;
/**
 * v2 banner 中自动生成密码所在行：`server password <PASSWORD>`（仅未配置
 * OPENCODE_SERVER_PASSWORD 时出现）。捕获到的明文密码**绝不进日志**（入缓冲前脱敏）。
 */
export const SERVER_PASSWORD_RE = /server password (\S+)/;
/** 逃生开关 env 名（vteam 侧开关，**不是** opencode CLI flag）。 */
export const ALLOW_GENERATED_PASSWORD_ENV = 'OPENCODE_ALLOW_GENERATED_PASSWORD';
/** 真值词表（与 opencode 自己的布尔解析保持一致）。 */
const TRUTHY_ENV_VALUES = ['1', 'true', 'yes', 'on', 'y'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpencodeServer {
  readonly options: OpencodeServerOptions;
  /** 隔离配置域（spawn env 的 HOME / XDG_* 全部指向它） */
  private readonly isolationScope: OpencodeIsolationScope;
  /** 当前 spawn 的 serve 子进程（未启动/已停止为 null） */
  private process: ChildProcess | null = null;
  /** 实际监听端口（启动成功后有值；端口冲突重试后可能与 options.port 不同） */
  private actualPort: number | null = null;
  private baseUrlValue: string | null = null;
  private versionCache: string | null = null;
  private versionInfoCache: OpencodeVersionInfo | null = null;
  private logs: string[] = [];
  /** F2 M3：spawn 异步失败（如 ENOENT）记录的错误；waitForHealthy 感知后立即失败不空转 */
  private spawnErrorValue: Error | null = null;
  /** 从 serve stdout 捕获的 v2 自动生成密码（逃生开关路径）；null = 未捕获 */
  private generatedPassword: string | null = null;

  constructor(options: OpencodeServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0) {
      throw new Error(`[opencode-server] port 必须是非负整数，收到: ${options.port}`);
    }
    this.isolationScope = options.isolationScope ?? resolveIsolationScope();
    this.options = {
      command: DEFAULT_COMMAND,
      cwd: process.cwd(),
      healthCheckTimeoutMs: DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
      healthCheckIntervalMs: DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      logBufferSize: DEFAULT_LOG_BUFFER_SIZE,
      portRetryCount: DEFAULT_PORT_RETRY_COUNT,
      logger: console,
      ...options,
      // 隔离域内的 serve 日志文件（次级错误源）：不再指向宿主的
      // `$HOME/.local/share/opencode/log/opencode.log`（隔离后 serve 根本不再写那儿）。
      serveLogFilePath: options.serveLogFilePath ?? this.isolationScope.logFile,
      serveHostname: options.serveHostname ?? process.env.OPENCODE_SERVE_HOSTNAME ?? DEFAULT_SERVE_HOSTNAME,
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

  /**
   * 规范化 semver 版本串（`2.0.28`）——上报给控制面的**唯一**形态
   * （调度器按精确串相等过滤 worker，见 `workers.service.ts` 的 opencodeVersion 比较）。
   * 解析失败返回 `'unknown'`。
   */
  get versionSemver(): string {
    return this.versionInfoCache ? formatOpencodeVersion(this.versionInfoCache) : 'unknown';
  }

  /**
   * 实际用于 Basic Auth 的密码：优先用配置的 OPENCODE_SERVER_PASSWORD；
   * 未配置且开了逃生开关时，用从 serve stdout 捕获的 v2 自动生成密码。
   */
  get effectiveServerPassword(): string | null {
    return this.options.serverPassword || this.generatedPassword;
  }

  /** 最近日志（环形缓冲副本），供启动失败/调试查看。 */
  get recentLogs(): string[] {
    return [...this.logs];
  }

  /**
   * 最近原始 serve 日志尾部（环形缓冲副本，可按会话过滤）——失败原因兜底证据用：
   * 模型错误不可提取时，把原始行附进原因，避免只留一句笼统「模型无任何输出」。
   * 环形缓冲为空时回退读取日志文件尾部（次级源）。
   */
  recentLogTail(limit = 20, sessionID?: string): string[] {
    const ring = this.logs
      .filter((line) => lineBelongsToSession(line, sessionID))
      .slice(-limit);
    if (ring.length > 0) {
      return ring;
    }
    return this.readLogFileErrors(sessionID, isAnyLine, false).slice(-limit);
  }

  /**
   * 最近模型错误日志（环形缓冲副本 + 日志文件次级源；按会话过滤，保留最近 limit 条）。
   * serve 对部分 APIError（Rate limit exceeded / Free usage exceeded 等）不透传
   * message.info.error——awaitCompletion 经 serveErrorReader 读取本方法结果，匹配时提前
   * abort + 抛错（错误文本透传前端），不再空等首字超时（120s+）。
   *
   * 过滤 = 关键词粗筛 + 结构化错误门（level=ERROR / error.* 字段）——正常 INFO 行不入选。
   * 会话归属用严格版（无 session.id/sessionID 的行不通配）：子 agent 域失败行
   * （如 share subscriber）不得触发其它（或本）会话主 agent 的 abort，主循环自恢复
   * 优先。环形缓冲有匹配即返回；无匹配才回退日志文件（次级源，缺失静默降级）。
   */
  recentErrors(limit = 5, sessionID?: string): string[] {
    const ring = this.logs
      .filter((line) => isServeErrorLine(line) && lineBelongsToSessionStrict(line, sessionID))
      .slice(-limit);
    if (ring.length > 0) {
      return ring;
    }
    return this.readLogFileErrors(sessionID, isServeErrorLine).slice(-limit);
  }

  /** 读日志文件尾部（次级错误源；仅匹配行 + 会话过滤）。文件缺失/不可读 → []。 */
  private readLogFileErrors(
    sessionID: string | undefined,
    accept: (line: string) => boolean,
    strictSessionMatch = true,
  ): string[] {
    const filePath = this.options.serveLogFilePath;
    if (!filePath) {
      return [];
    }
    const belongs = strictSessionMatch ? lineBelongsToSessionStrict : lineBelongsToSession;
    return readFileTailLines(filePath).filter(
      (line) => accept(line) && belongs(line, sessionID),
    );
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
    // stale 隔离：新 serve 进程 = 新日志时代——清空上一进程残留（含上个会话的模型错误），
    // 否则新会话失败原因会引用到旧会话的日志行。
    this.logs = [];
    this.spawnErrorValue = null;
    this.generatedPassword = null;
    this.versionCache = this.detectVersion();
    this.versionInfoCache = parseOpencodeVersion(this.versionCache);
    this.assertServerPasswordConfigured();
    // 隔离配置域（启动即打印）：worker 行为异常时，第一眼就能确认"serve 看到的配置域是哪一块"。
    // 路径里**不含任何密文**（凭据在 <data>/opencode/auth.json，不在路径里）。
    this.options.logger?.info(
      `[opencode-server] 隔离配置域: root=${this.isolationScope.root} ` +
        `HOME=${this.isolationScope.home} ` +
        `XDG_CONFIG_HOME=${this.isolationScope.configHome} ` +
        `XDG_DATA_HOME=${this.isolationScope.dataHome}（宿主机的全局配置/插件/AGENTS.md 不在作用域内）`,
    );
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
    this.baseUrlValue = `http://${LOOPBACK_HOSTNAME}:${port}`;
    this.options.logger?.info(`[opencode-server] serve 就绪: ${this.baseUrlValue} (pid=${proc.pid})`);
    return this.baseUrlValue;
  }

  /**
   * T4c：重启 serve = stop + start 组合。
   * 幂等语义：未运行（从未启动或已停止）时直接 start；运行中先 stop（进程组清理）
   * 再 start（重新探测端口 + spawn + 健康检查）。
   * ⚠️ 随机端口（port=0）场景重启后端口可能变化——调用方须据 serveServer.port
   * 重新注册 capabilities.baseUrl/port（T4c index.ts reRegister 接线）。
   */
  async restart(timeoutMs = 3000): Promise<string> {
    if (this.isRunning) {
      await this.stop(timeoutMs);
    }
    return this.start();
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

  /** 探测 opencode CLI 版本（start 时调用，失败不阻断启动）；返回**原始**输出。 */
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
   * 逃生开关是否开启：显式选项优先，否则读 env `OPENCODE_ALLOW_GENERATED_PASSWORD`。
   */
  private isAllowGeneratedPassword(): boolean {
    if (this.options.allowGeneratedPassword !== undefined) {
      return this.options.allowGeneratedPassword;
    }
    const raw = process.env[ALLOW_GENERATED_PASSWORD_ENV];
    if (raw === undefined || raw.trim() === '') {
      return false;
    }
    return TRUTHY_ENV_VALUES.includes(raw.trim().toLowerCase());
  }

  /**
   * v2 恒开鉴权（D10）→ 密码为空即 fail-fast。
   *
   * 为什么必须 fail-fast：v2 未配置 OPENCODE_SERVER_PASSWORD 时会**自动生成**随机密码
   * 并打到 stdout。若 worker 不解析它，worker 自己的每个请求都会 401，而错误信息
   * 不会告诉运维密码在哪——排查成本极高（计划 D10）。
   *
   * 逃生开关：显式设 `OPENCODE_ALLOW_GENERATED_PASSWORD=1` 时改为从 stdout 捕获该密码。
   */
  private assertServerPasswordConfigured(): void {
    if (this.options.serverPassword) {
      return;
    }
    if (this.isAllowGeneratedPassword()) {
      this.options.logger?.warn(
        `[opencode-server] 未配置 OPENCODE_SERVER_PASSWORD：已开启 ${ALLOW_GENERATED_PASSWORD_ENV}，` +
          '将从 serve stdout 捕获 v2 自动生成的密码（明文不落日志）',
      );
      return;
    }
    throw new Error(
      '[opencode-server] v2 恒开鉴权：请设置环境变量 OPENCODE_SERVER_PASSWORD（Basic Auth，用户名固定为 opencode）；' +
        `若坚持让 opencode 自动生成密码，请显式设置 ${ALLOW_GENERATED_PASSWORD_ENV}=1（worker 将从 serve stdout 捕获）`,
    );
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

  /**
   * 是否请求了「纯净基线」（v1 语义：不加载外部插件）。
   *
   * 两个来源，任一为「关」即请求纯净基线：
   *   1. `OPENCODE_PURE` 环境变量为真值 —— 运维级一刀切（对照 token 开销/排障用）；
   *   2. `omoEnabledProvider()` 返回 false —— 用户在 worker 详情页关掉了 OmO 开关。
   *
   * ⚠️ **v2 已无 `--pure` flag**（`opencode serve --pure` 直接 exit 1）→ 本方法**不再拼
   * flag**，只用于告警：等价的「抑制第三方插件 / AGENTS.md 注入」语义由 **T16b 的隔离
   * 配置域**承接（子进程拿不到宿主的 HOME/XDG_CONFIG_HOME → 宿主全局插件/AGENTS.md
   * 不在作用域内；T6 已关闭：没有配置层的等价物，隔离是唯一可靠手段）。
   *
   * ⚠️ OPENCODE_PURE 同时是 **opencode 自己**解析的布尔环境变量，且它不接受空串
   * （SchemaError: Expected "true"|...|"false"..., got ""）→ serve 直接启动失败。
   * 所以这里对空串/纯空白一律**删除该变量**，绝不把空值透传给子进程。
   * 真值词表与 opencode 的布尔解析保持一致（true/yes/on/1/y）。
   */
  private isPureMode(): boolean {
    const raw = process.env.OPENCODE_PURE;
    if (raw !== undefined && raw.trim() === '') {
      delete process.env.OPENCODE_PURE;
    } else {
      const normalized = (raw ?? '').trim().toLowerCase();
      if (TRUTHY_ENV_VALUES.includes(normalized)) {
        return true;
      }
    }
    // 用户开关（缺省注入时视为开启，保持既有行为）
    return this.options.omoEnabled ? !this.options.omoEnabled() : false;
  }

  /** spawn serve 子进程；detached + stdio pipe；env 注入 OPENCODE_SERVER_PASSWORD + 隔离配置域。 */
  private spawnServe(port: number): ChildProcess {
    const args = [
      'serve',
      '--port',
      String(port),
      '--hostname',
      this.options.serveHostname!,
      // T17 修复（2026-09-17 实测；v2.0.28 复验仍有效）：诊断日志默认写
      // ~/.local/share/opencode/log/opencode.log（文件，不是 stderr）→ this.logs 收不到 →
      // recentErrors() 恒空。该参数令其同时写 stderr，启动 banner（listening on …）仍在 stdout。
      '--print-logs',
    ];
    // ⚠️ v2 删掉了 `--pure`：`opencode serve --pure` 直接 exit 1（Unrecognized flag），
    // 照旧拼会让**每个 worker 启动即失败**。v1 的「不加载外部插件」语义由 **T16b 的隔离
    // 配置域**承接（子进程拿不到宿主的 HOME/XDG_CONFIG_HOME → 全局插件不在作用域内）。
    if (this.isPureMode()) {
      this.options.logger?.warn(
        '[opencode-server] OPENCODE_PURE / OmO 开关在 v2 上已失效（v2 无 --pure flag，传入会 exit 1）：' +
          '本 worker 不再拼 --pure；插件抑制由隔离配置域（spawn env 的 HOME/XDG_*）承接',
      );
    }
    // 隔离配置域：子进程不继承宿主的 HOME / XDG_*（T16b）。
    const env = buildIsolatedServeEnv(this.isolationScope, process.env);
    if (this.options.serverPassword) {
      env.OPENCODE_SERVER_PASSWORD = this.options.serverPassword;
    } else {
      // 未配置密码 → 显式清掉，避免宿主环境的残留值让 v2 误以为「已配置」（那会让
      // 逃生开关捕获不到 banner 里的自动生成密码）。
      delete env.OPENCODE_SERVER_PASSWORD;
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

  /**
   * 轮询 `GET /api/info` 直到 2xx；serve 提前退出或超时即抛错（附最近日志）。
   *
   * 为什么打 `/api/info` 而不是 `/`：v2 的 `GET /` 返回 web SPA 的 200（**未鉴权也过**），
   * 探不到鉴权状态；`/api/info` 未鉴权 401 / 鉴权 200 —— 用它才能在启动期发现密码不对。
   */
  private async waitForHealthy(port: number): Promise<void> {
    const timeoutMs = this.options.healthCheckTimeoutMs!;
    const intervalMs = this.options.healthCheckIntervalMs!;
    const url = `http://${LOOPBACK_HOSTNAME}:${port}/api/info`;
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
      let status: number;
      try {
        status = await httpGetStatus(url, this.buildAuthHeader());
      } catch (err) {
        lastError = err;
        await sleep(intervalMs);
        continue;
      }
      if (status >= 200 && status < 300) {
        this.options.logger?.info(`[opencode-server] 健康检查通过 (HTTP ${status})`);
        return;
      }
      if (status === 401 && this.effectiveServerPassword) {
        throw new Error(
          '[opencode-server] 健康检查鉴权失败（HTTP 401）：serve 恒开鉴权，但当前密码不匹配；' +
            '请核对 OPENCODE_SERVER_PASSWORD 与 serve 实际使用的密码是否一致\n' +
            `最近日志:\n${this.logs.join('\n')}`,
        );
      }
      lastError = new Error(`HTTP ${status}`);
      await sleep(intervalMs);
    }
    throw new Error(
      `[opencode-server] 健康检查超时（${timeoutMs}ms），最后一次: ${lastError ? String(lastError) : '无请求'}` +
        `${this.options.serverPassword ? '' : '；未配置 OPENCODE_SERVER_PASSWORD 且未捕获到 v2 自动生成密码'}` +
        `\n最近日志:\n${this.logs.join('\n')}`,
    );
  }

  private buildAuthHeader(): string | undefined {
    const password = this.effectiveServerPassword;
    if (!password) {
      return undefined;
    }
    // D2 铁律：Basic Auth username=opencode（v2 实测不变），密码即 OPENCODE_SERVER_PASSWORD
    return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  }

  /** 收集 serve 日志到环形缓冲；顺带解析实际监听端口与（v2）自动生成密码。 */
  private pushLog(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const passwordMatch = SERVER_PASSWORD_RE.exec(trimmed);
      if (passwordMatch && !this.options.serverPassword) {
        this.generatedPassword = passwordMatch[1];
        this.options.logger?.info('[opencode-server] 已从 stdout 捕获自动生成密码（明文不落日志）');
      }
      // 明文密码绝不进环形缓冲（环形缓冲会经 recentLogTail() 附进错误信息外泄）
      this.logs.push(passwordMatch ? trimmed.replace(SERVER_PASSWORD_RE, 'server password ***') : trimmed);
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
