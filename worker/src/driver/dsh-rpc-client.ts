/**
 * DSH SDK 运行时客户端（P2）——stdio 上的 newline-delimited JSON-RPC 2.0。
 *
 * 对齐 P0 实测基线（`md-docs/dsh-worker-p0-poc-report.md`）：
 * - **已发布协议只有 7 个方法**：`initialize` / `session/prompt` / `session/resume` /
 *   `session/wait` / `session/working-directory/{get,set}` / `shutdown`
 *   （`session/query`、`session/cancel` 等只在 master，发布版没有 → 由 vendored 插件补，
 *   见 P0 报告约束 C2）。
 * - **server→client 有请求**（`approval/request` / `user-question/ask`），客户端**必须在等待
 *   其他请求期间持续读取并应答**，否则会挂住整轮（P0 第一次工具模式挂起就是这个原因）。
 * - 通知：`session.event`（每个事件一条）、`session.status`（running/idle）、
 *   `session.query.completed`（命令完成）、`user-question.cancelled`。
 *
 * 本模块只负责**传输与请求应答**，不解释事件语义（那是 `dsh-event-map.ts` 的事）。
 *
 * @module driver/dsh-rpc-client
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { EngineLogger } from '../engine/types';
import { DriverRequestError, type Logger } from './opencode-driver';
import type { DshSessionEvent } from './dsh-event-map';

/** 客户端构造参数。 */
export interface DshRpcClientOptions {
  /** `dsh` 可执行文件（缺省取 env DSH_BIN 或 PATH 上的 `dsh`）。 */
  dshBin?: string;
  /** profile 名（缺省 `sdk`）。 */
  profile?: string;
  /** `--patch` 覆盖文件列表（注入 provider/mcp 等）。 */
  patches?: string[];
  /** DSH home（隔离目录；缺省 `<workDir>/.dsh-home`）。 */
  dshHome?: string;
  /** 启动的工作目录（进程 cwd）。 */
  cwd?: string;
  /**
   * 额外环境变量（模型凭据、**角色 persona** 等；覆盖继承的 env）。
   *
   * 可以是对象或**求值函数**：函数形式在**每次 spawn 时**调用，
   * 使得上层（如 persona 切换）修改变量后，下一次重启能读到新值。
   * ⚠️ 对象形式只在构造时快照——切换 persona 那种"改完再重启"的场景必须用函数。
   */
  env?: Record<string, string> | (() => Record<string, string>);
  /** `initialize` 握手超时 ms（缺省 30s）。 */
  initializeTimeoutMs?: number;
  /** 单次请求超时 ms（缺省 120s——模型轮次可能很久）。 */
  requestTimeoutMs?: number;
  /** 关闭时等待退出 ms（缺省 6s，随后 SIGTERM → 3s → SIGKILL，对齐官方 SDK 客户端）。 */
  shutdownTimeoutMs?: number;
  logger?: Logger | EngineLogger;
}

/** `initialize` 参数（P0 实测有效形状）。 */
export interface DshInitializeParams {
  cwd: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  /** 启用 `approval/request` 回调（否则引擎内部走既有 answerer 链）。 */
  approvalRequests?: boolean;
  /** 原生问题应答能力（`user-question/ask`）。 */
  capabilities?: { userQuestions?: boolean };
  /** 协议允许扩展字段（DSH developer preview 常有新增参数；不认识的由服务端忽略）。 */
  [key: string]: unknown;
}

/** 服务端请求（`approval/request` / `user-question/ask`）的处理器。 */
export interface DshServerRequestHandler {
  /**
   * 处理服务端请求，返回 JSON-RPC result。
   * 抛错 → 客户端回错误响应（引擎侧按既有的失败闭合语义处理）。
   */
  handle(method: string, params: Record<string, unknown> | undefined): Promise<unknown>;
}

/** 事件订阅回调集合。 */
export interface DshRpcClientHandlers {
  /**
   * 收到一条 `session.event`。
   *
   * ⚠️ **第二个参数必须传**：`session.event` 通知的信封上带 `sessionId`
   * （`{sessionId, event}`），但 `event.data` 里**没有** sessionId。早先这里
   * 只传 `event`，导致驱动只能靠「本驱动只有一个会话 / 只有一个在途 turn」
   * 这类启发式反推归属 —— 池代理下一个驱动服务多会话时启发式必然失败，
   * 事件被当成「无归属」丢弃（实测 `plugin:vteam/stream-chunk` 丢了 9000+ 条，
   * 表现为「模型无任何输出」的首字超时误报）。信封上的 sessionId 是最可靠的来源。
   */
  onSessionEvent?: (event: DshSessionEvent, sessionId: string) => void;
  /** 收到 `session.status`（running/idle）。 */
  onSessionStatus?: (status: 'running' | 'idle', sessionId: string) => void;
}

/**
 * DSH SDK 运行时客户端。
 *
 * 一个实例 = 一个 `dsh --profile sdk` 子进程；可承载多个会话（`sessionId` 由调用方指定，
 * P0 实测服务端按 id 分派）。
 */
export class DshRpcClient {
  private readonly options: Required<
    Pick<DshRpcClientOptions, 'profile' | 'initializeTimeoutMs' | 'requestTimeoutMs' | 'shutdownTimeoutMs'>
  > &
    DshRpcClientOptions;
  private readonly logger: Logger | EngineLogger;

  private process: ChildProcess | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private handlers: DshRpcClientHandlers = {};
  private serverRequestHandler: DshServerRequestHandler | null = null;
  private initialized = false;
  /** 服务端主动通知的会话/轮次错误（`turn/end` 的 error），供上层区分"请求成功但轮次失败"。 */
  private readonly turnErrors = new Map<string, string>();
  /** stderr 尾部（诊断用；官方客户端同样保留 stderr tail 给握手失败诊断）。 */
  private stderrTail: string[] = [];
  /**
   * 子进程启动失败的错误（spawn `'error'` 事件，如 ENOENT/EACCES/`.cmd` 的 EINVAL）。
   *
   * 为什么单独存：spawn 失败后 `request()` 必须**立即**以这个错误失败，而不是写进
   * 已死的 stdin 后空等到超时（见 start() 里 'error' 监听的注释）。
   * 每次 start() 重置；成功后保持 null。
   */
  private spawnError: DriverRequestError | null = null;
  private closed = false;

  constructor(options: DshRpcClientOptions = {}) {
    this.options = {
      profile: options.profile ?? 'sdk',
      initializeTimeoutMs: options.initializeTimeoutMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 6_000,
      ...options,
    };
    this.logger = options.logger ?? console;
  }

  /** 子进程是否在跑。 */
  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null && !this.closed;
  }

  /** 子进程 pid（未启动为 null）。 */
  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  /** stderr 尾部（握手失败时随错误抛出，便于定位）。 */
  get recentStderr(): string[] {
    return [...this.stderrTail];
  }

  /**
   * 读当前的 spawn 失败错误（null = 没有发生过 spawn 失败）。
   *
   * 为什么用方法读而不是直接读字段：`start()` 里刚执行过 `this.spawnError = null`，
   * TS 的控制流分析会把该字段在后续代码里窄化成 `null`（它看不到 `'error'` 回调里的赋值），
   * 直接访问 `this.spawnError?.message` 会被推断成 `never`（编译报错 TS2339）。
   */
  private currentSpawnError(): DriverRequestError | null {
    return this.spawnError;
  }

  /** 注册事件回调（幂等覆盖）。 */
  setHandlers(handlers: DshRpcClientHandlers): void {
    this.handlers = handlers;
  }

  /** 注册服务端请求处理器（`approval/request` / `user-question/ask`）。 */
  setServerRequestHandler(handler: DshServerRequestHandler | null): void {
    this.serverRequestHandler = handler;
  }

  /**
   * 启动子进程并完成 `initialize` 握手。
   *
   * @param params - 握手参数（provider/model/cwd 由此固定，P0 实测服务端会在该路由上校验）。
   */
  async start(params: DshInitializeParams): Promise<void> {
    if (this.isRunning && this.initialized) return;

    const bin = this.options.dshBin ?? process.env.DSH_BIN ?? 'dsh';
    const args = ['--profile', this.options.profile];
    for (const patch of this.options.patches ?? []) {
      args.push('--patch', patch);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(this.options.dshHome === undefined ? {} : { DSH_HOME: this.options.dshHome }),
      ...(typeof this.options.env === 'function' ? this.options.env() : (this.options.env ?? {})),
    };

    const child = spawn(bin, args, {
      cwd: this.options.cwd ?? process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this.closed = false;
    this.spawnError = null;

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      }
    });

    /**
     * spawn 失败必须有人听 `'error'`（P0-3）。
     *
     * 为什么这条监听不可省：
     * ① `ChildProcess` 的 `'error'` 没有监听者时，Node 按**未捕获异常**处理 ⇒
     *    `uncaughtException` ⇒ worker 进程在任意时刻崩溃（不是"启动失败退出"，是崩）。
     *    典型的触发场景就是 Windows 上 `dsh` 只有 `.cmd` shim（`spawn('dsh')` → ENOENT）；
     *    即便命令解析修好，EACCES / 路径不存在仍会走这里。
     * ② spawn 失败时**只发 `'close'` 不发 `'exit'`**（Node 18–24 实测：ENOENT 时
     *    exitCode=-2、`'exit'` 不触发）⇒ 下面挂在 `'exit'` 上的兜底 reject 根本不执行，
     *    在途的 `initialize` 会一直等到 30s 超时，且错误信息里拿不到根因。
     * 因此这里必须同时做三件事：记 stderr/错误（供握手失败诊断）、把 pending 全部以
     * 明确错误 reject（initialize 立即失败而非超时）、把 spawnError 钉住让后续
     * `request()` 快速失败（不再往死进程的 stdin 写帧）。
     */
    child.once('error', (error: Error) => {
      const err = error as NodeJS.ErrnoException;
      const detail =
        err.code === undefined ? err.message : `${err.message}（code=${err.code}）`;
      this.spawnError = new DriverRequestError(
        `[dsh-rpc] 子进程启动失败（bin=${bin}）：${detail}` +
          (process.platform === 'win32'
            ? '；Windows 上 npm 全局安装只产出 .cmd shim（CreateProcess 不能直接执行 .cmd），' +
              '请把 DSH_BIN 指向 node.exe 的绝对路径（参数带 dsh 的 lib/bin.js），或经 cmd.exe /c 启动'
            : ''),
      );
      this.stderrTail.push(this.spawnError.message);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      // 通知上层：直接落日志（错误同时会随 initialize 的 reject 抛给驱动层）
      this.logger.error(this.spawnError.message);
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(this.spawnError);
      }
    });

    child.on('exit', (code, signal) => {
      const reason =
        `dsh 运行时已退出（code=${String(code)}, signal=${String(signal)}）` +
        (this.stderrTail.length > 0 ? `；stderr 尾部：${this.stderrTail.slice(-3).join(' | ')}` : '');
      // 失败所有在途请求（否则调用方会一直等到超时）
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new DriverRequestError(reason));
      }
    });

    // 握手：官方客户端把 initialize 当就绪边界，失败带上 stderr tail。
    // stdout 检查放进 try：spawn 失败时它是二道闸，错误要经同一条 close + 诊断链路抛出
    // （而不是裸抛一个"stdout 不可用"、把真正的 spawn 错误丢掉）。
    try {
      if (child.stdout === null) {
        // 用取值方法而非直接读字段：start() 里刚把 spawnError 赋成 null，TS 会把该字段
        // 控制流窄化成 null（回调里写回的值它看不见），直接读会让 ?.message 变成 never。
        throw new DriverRequestError(
          this.currentSpawnError()?.message ?? '[dsh-rpc] 子进程 stdout 不可用（spawn 失败？）',
        );
      }
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => this.handleLine(line));
      await this.request('initialize', params, this.options.initializeTimeoutMs);
      this.initialized = true;
    } catch (err) {
      await this.close();
      const tail = this.stderrTail.slice(-5).join(' | ');
      throw new DriverRequestError(
        `[dsh-rpc] initialize 失败：${(err as Error).message}` +
          (tail === '' ? '' : `；stderr 尾部：${tail}`),
      );
    }
  }

  /** 断开并收割子进程（对齐官方客户端 teardown ladder：EOF → SIGTERM → SIGKILL）。 */
  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.initialized = false;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new DriverRequestError('[dsh-rpc] 客户端已关闭'));
    }
    this.pending.clear();
    // spawn 失败过：子进程从未真正起来（无 pid、无句柄），再走 EOF→SIGTERM→SIGKILL 的
    // 阶梯只会白等 1s+3s+1s；直接返回（错误已经在上层抛出）。
    if (child === null || child.exitCode !== null || this.currentSpawnError() !== null) return;

    try {
      child.stdin?.end();
    } catch {
      // 忽略：stdin 可能已关闭
    }
    await waitExit(child, 1_000);
    if (child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // 已退出
      }
      await waitExit(child, 3_000);
    }
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
      await waitExit(child, 1_000);
    }
  }

  /** 发送通知（无响应）。 */
  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /**
   * 发送请求并等待响应。
   *
   * 失败一律抛 `DriverRequestError`（引擎侧方法缺失/业务错误 → 无 status；
   * HTTP 语义的 404/401 由上层按需注入，见 DshDriver）。
   */
  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<unknown> {
    // spawn 已失败：立即以启动错误失败，不再往死进程的 stdin 写帧、也不空等超时。
    const spawnError = this.currentSpawnError();
    if (spawnError !== null) {
      throw spawnError;
    }
    if (this.process === null || this.closed) {
      throw new DriverRequestError(`[dsh-rpc] 运行时未启动，无法发送 ${method}`);
    }
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DriverRequestError(`[dsh-rpc] ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      // 不阻止进程退出（unref）
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** 取某会话最近的轮次错误（`turn/end{kind:'error'}` 记录；无则 undefined）。 */
  takeTurnError(sessionId: string): string | undefined {
    const err = this.turnErrors.get(sessionId);
    this.turnErrors.delete(sessionId);
    return err;
  }

  /** 记录轮次错误（由事件处理路径调用）。 */
  recordTurnError(sessionId: string, message: string): void {
    this.turnErrors.set(sessionId, message);
  }

  // ── 内部：帧处理 ────────────────────────────────────────────────────────

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // 非协议行（插件误写 stdout 等）：记 stderr 尾部，继续读（不中断协议）
      this.stderrTail.push(`[non-protocol stdout] ${trimmed.slice(0, 200)}`);
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    const hasId = msg.id !== undefined && msg.id !== null;

    // 服务端 → 客户端请求（有 id 且有 method）
    if (hasId && method !== undefined) {
      void this.handleServerRequest(msg.id as number, method, msg.params as Record<string, unknown> | undefined);
      return;
    }
    // 响应（有 id 无 method）
    if (hasId && method === undefined) {
      const entry = this.pending.get(msg.id as number);
      if (entry === undefined) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id as number);
      if (msg.error !== undefined && msg.error !== null) {
        const err = msg.error as Record<string, unknown>;
        entry.reject(
          new DriverRequestError(
            `[dsh-rpc] ${String(err.message ?? '未知错误')}` +
              (err.code === undefined ? '' : `（code=${String(err.code)}）`),
          ),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    // 通知（有 method 无 id）
    if (method !== undefined) {
      this.handleNotification(method, msg.params as Record<string, unknown> | undefined);
    }
  }

  /** 处理服务端请求（必须应答，否则引擎会挂住整轮）。 */
  private async handleServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const handler = this.serverRequestHandler;
    if (handler === null) {
      // 无处理器 → 明确回错误（引擎侧按失败闭合处理，不会挂住）
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `未注册服务端请求处理器：${method}` },
      });
      return;
    }
    try {
      const result = await handler.handle(method, params);
      this.write({ jsonrpc: '2.0', id, result });
    } catch (err) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: (err as Error).message },
      });
    }
  }

  /** 处理通知（事件/状态）。 */
  private handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (method === 'session.event') {
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
      const event = params?.event as DshSessionEvent | undefined;
      if (event !== undefined && typeof event.type === 'string') {
        // 信封上的 sessionId 一并下发：event.data 里没有它，驱动单靠事件体无法归属
        // （见 DshRpcClientHandlers.onSessionEvent 的说明）。
        this.handlers.onSessionEvent?.(event, sessionId);
      }
      return;
    }
    if (method === 'session.status') {
      const status = params?.status;
      const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : '';
      if (status === 'running' || status === 'idle') {
        this.handlers.onSessionStatus?.(status, sessionId);
      }
      return;
    }
    // 其余通知（user-question.cancelled / subagent.* 等）暂不消费：不认识的协议扩展
    // 一律忽略而非报错——DSH 处于 developer preview，新增通知是常态。
  }

  /** 写一行 JSON-RPC 帧。 */
  private write(frame: Record<string, unknown>): void {
    const stdin = this.process?.stdin;
    if (stdin === null || stdin === undefined) {
      throw new DriverRequestError('[dsh-rpc] 子进程 stdin 不可用');
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  }
}

/** 等待子进程退出（最多 ms）。 */
function waitExit(child: ChildProcess, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, ms);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}
