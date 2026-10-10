/**
 * worker 自更新执行器 + 自动回滚（worker-self-update Todo 4）。
 *
 * 触发链：管理员点【更新】→ server `POST /workers/:id/update` 把 `{type:'update-worker',
 * resourceVersion: <期望版本>}` 入队既有 pendingCommands → 心跳响应带回 → index.ts
 * dispatchCommands 分派到本模块。**没有第二个指令通道**，也没有 env 开关（按钮是唯一入口）。
 *
 * 执行步骤与**每步失败策略**（计划 Todo 4 严格顺序；失败策略是本文件的主要注释内容）：
 *   a) 空闲判定   有活跃会话 → 停在 `pending` + debug 日志，**绝不打断进行中的会话**，
 *                 等下轮心跳（server 侧指令未收敛时会再次下发）重试。
 *   b) 下载      取 tarball + 同目录 `worker-src.version.json`。version.json 缺失 /
 *                 字段不合法 → **放弃本轮** + warn + 停在 pending；指令**携带**版本号时
 *                 还要求与 version.json 一致，不符即放弃（换包或改 env 后自然会被下一轮
 *                 心跳捡起来，绝不猜版本硬更）。指令**没带**版本号则降级：跳过一致性比对，
 *                 只要求 version.json 存在（sha256 校验一步都不省）。
 *   c) sha256    用 node crypto 校验下载字节（零新依赖）。不符 → 删临时目录 + warn +
 *                 停在 pending；**dist 一个字节都不动**（铁律：校验不过绝不覆盖）。
 *   d) lock 比对 下载包 package-lock.json 与本地不同 → 覆盖后执行
 *                 `npm ci --omit=dev`；失败 → **立即回滚**（恢复 dist.prev）+ rolledBack
 *                 上报 + warn（依赖装不上是确定性失败，重试无意义，报给人不吞）。
 *   e) 备份覆盖  `rm -rf dist.prev && mv dist dist.prev`（保留既有 dist.failed 留证），
 *                 再把 tarball 的 dist/ + package.json + package-lock.json + scripts/ +
 *                 .env.example 覆盖进安装目录。`.env` 不在发布包内（pack-worker.sh 的 tar
 *                 清单不含它），故运行时配置天然安全。
 *   f) systemd   探测口径与 install-worker.sh 完全一致（systemctl 存在 + /run/systemd/system
 *                 是目录 + 用户级 unit 存在，否则系统级 unit 存在）→ `systemctl [--user]
 *                 restart aiagents-worker`。**无 systemd → 不重启、不 process.exit**，
 *                 落 `ready-manual` + 明确日志「已下载待手动重启」（决策⑤）。
 *
 * 自动回滚（计划决策②）：进程内 `registeredSinceUpdate`——执行完 e) 置 false，下一次
 * register 成功置 true。达到阈值且 `dist.prev` 存在 → `dist → dist.failed`（留证）、
 * `dist.prev → dist` → 重启 → 落 `rolledback` + `rolledBack=true`。**只做一次**，之后
 * 只告警，杜绝「更新→回滚→再更新」震荡（server 侧也会在看到 rolledback 后清 pending）。
 *
 * 边界（计划 Must-NOT）：进程起不来的**硬崩溃**不做自动回滚——那种情况进程内状态已经
 * 随进程一起没了，自动回滚无从谈起；dist.prev 就是给人工恢复用的一行命令：
 *   `cd <installDir> && rm -rf dist.failed && mv dist dist.failed && mv dist.prev dist && systemctl --user restart aiagents-worker`
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WORKER_UPDATE_STATES,
  WorkerCommand,
  WorkerUpdateState,
  UpdateWorkerCommandPayload,
} from '../protocol/worker-protocol';

/** systemd unit 名（与 install-worker.sh 写入的 unit 文件名逐字一致）。 */
export const WORKER_SYSTEMD_UNIT = 'aiagents-worker';
/** systemd 运行时标记目录（install-worker.sh 的 `[ -d /run/systemd/system ]`）。 */
export const SYSTEMD_RUNTIME_DIR = '/run/systemd/system';
/** 发布包文件名（install-worker.sh / pack-worker.sh 的 tarball 名）。 */
export const WORKER_SOURCE_TARBALL = 'worker-src.tar.gz';
/** 发布包版本元数据文件名（pack-worker.sh 与 tarball 同目录写出）。 */
export const WORKER_SOURCE_VERSION_FILE = 'worker-src.version.json';

/** tarball 内要求存在的成员（缺任一即视为坏包，**在备份 dist 之前**就中止）。 */
const REQUIRED_PACKAGE_ENTRIES = [
  'dist',
  'package.json',
  'package-lock.json',
  'scripts',
] as const;
/** tarball 内可选成员（缺了不阻断更新；.env.example 覆盖无害，仅作模板刷新）。 */
const OPTIONAL_PACKAGE_ENTRIES = ['.env.example'] as const;

/**
 * 失败重试退避下限（ms）。失败后不立即重下一轮心跳，而是至少隔这么久再试一次——
 * 心跳本身仍是唯一驱动源（退避只是给它加个下限），避免坏包场景下每 10s 重下一次 tarball。
 */
export const UPDATE_RETRY_BACKOFF_MS = 60_000;
/** 触发回滚的「register 连续失败」阈值（次）。 */
export const ROLLBACK_MAX_REGISTER_FAILURES = 5;
/** 触发回滚的「更新后未注册成功」时长阈值（ms）。 */
export const ROLLBACK_MAX_UPDATE_AGE_MS = 5 * 60_000;

/** 本模块日志接口（对齐仓库既有 Logger 风格，index.ts 注入 console 包装）。 */
export interface UpdateLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** 子进程执行结果（code=null = 被信号杀死或未启动成功）。 */
export interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * 子进程执行器。**必须异步**：`systemctl restart aiagents-worker` 会给我们自己发 SIGTERM，
 * 若用 spawnSync 阻塞事件循环，SIGTERM 无法被处理 → 优雅退出不执行 → systemctl 等不到
 * 进程退出 → 双方互等（死锁）。故默认实现走 spawn + Promise。
 */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<CommandOutcome>;

/** 文件系统操作面（测试注入假实现，生产走 fs.promises）。 */
export interface UpdateFs {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(filePath: string, data: Buffer): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  exists(target: string): Promise<boolean>;
  isDirectory(target: string): Promise<boolean>;
  rm(target: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  cp(from: string, to: string): Promise<void>;
}

/** 发布包 URL 推导结果。 */
export interface WorkerSourceUrls {
  tarball: string;
  versionJson: string;
}

/**
 * 发布包地址推导 —— 与 install-worker.sh 的缺省推导**同源**：
 *   `WORKER_SRC_URL="${WORKER_SRC_URL:-${SERVER_URL%/}/worker-src.tar.gz}"`。
 * env `WORKER_SRC_URL` 优先（机器上可能是用 `--src-url` 从镜像站装的，从 serverUrl
 * 重新推导会下错地方）；version.json 与 tarball **同目录**（pack-worker.sh 两者都写进
 * web/public），故由 tarball URL 派生而非独立拼 serverUrl。
 */
export function resolveWorkerSourceUrls(
  serverUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkerSourceUrls {
  const override = (env.WORKER_SRC_URL ?? '').trim();
  const tarball = override || `${serverUrl.replace(/\/+$/, '')}/${WORKER_SOURCE_TARBALL}`;
  return {
    tarball,
    versionJson: `${tarball.slice(0, tarball.lastIndexOf('/') + 1)}${WORKER_SOURCE_VERSION_FILE}`,
  };
}

/** 从 update-worker 命令里取目标版本：payload.version 优先，回落 resourceVersion。 */
export function readUpdateCommandVersion(
  command: WorkerCommand,
): string | undefined {
  const payload = command.payload as UpdateWorkerCommandPayload | undefined;
  const raw = payload?.version ?? command.resourceVersion;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 执行结果分类（供调用方决定是否立刻补一次心跳；测试断言用）。 */
export type UpdateRunOutcome =
  | 'applied-restarting'
  | 'applied-ready-manual'
  | 'deferred-idle'
  | 'deferred-inflight'
  | 'deferred-backoff'
  | 'skipped-already-applied'
  | 'aborted';

export interface WorkerUpdaterThresholds {
  retryBackoffMs: number;
  maxRegisterFailures: number;
  maxUpdateAgeMs: number;
}

export interface WorkerUpdaterOptions {
  /** server 基址（config.serverUrl），发布包地址由它推导。 */
  serverUrl: string;
  /**
   * worker 安装目录（dist/ 与 package.json 的父目录）。**必填**：本模块编译产物位于
   * dist/update/ 下，靠 __dirname 反推安装目录要数「..」的层数，入口一改就错；
   * 唯一构造方 index.ts 就在 dist/index.js 同级，用 `path.resolve(__dirname, '..')`
   * 一行给出正确答案（dev 走 tsx src/index.ts 时同样正确）。
   */
  installDir: string;
  /** 活跃会话数（index.ts 注入 getLoad().instances）——空闲判定的唯一事实源。 */
  activeSessionCount: () => number;
  fetchImpl?: typeof fetch;
  fsImpl?: UpdateFs;
  run?: CommandRunner;
  /** sha256 十六进制摘要（默认 node crypto，零新依赖）。 */
  sha256Hex?: (data: Buffer) => string;
  now?: () => number;
  logger?: UpdateLogger;
  env?: NodeJS.ProcessEnv;
  /** uid 视图（用户级 systemctl 的 XDG_RUNTIME_DIR 推导用；默认 os.userInfo().uid）。 */
  uid?: number;
  thresholds?: Partial<WorkerUpdaterThresholds>;
}

const defaultFs: UpdateFs = {
  mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
  writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
  readFile: (filePath) => fs.promises.readFile(filePath),
  exists: (target) =>
    fs.promises
      .stat(target)
      .then(() => true)
      .catch(() => false),
  isDirectory: (target) =>
    fs.promises
      .stat(target)
      .then((stat) => stat.isDirectory())
      .catch(() => false),
  rm: (target) => fs.promises.rm(target, { recursive: true, force: true }),
  rename: (from, to) => fs.promises.rename(from, to),
  cp: (from, to) => fs.promises.cp(from, to, { recursive: true }),
};

/** spawn 版命令执行器（异步，见 CommandRunner 注释里的死锁说明）。 */
export const spawnCommandRunner: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandOutcome>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : null;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

/** systemctl 调用上下文（用户级 / 系统级）。 */
export interface SystemdTarget {
  scope: 'user' | 'system';
  /** systemctl 可执行参数前缀（用户级为 ['--user']）。 */
  ctlArgs: string[];
  unitPath: string;
}

export class WorkerUpdater {
  private readonly serverUrl: string;
  private readonly installDir: string;
  private readonly activeSessionCount: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly fsImpl: UpdateFs;
  private readonly run: CommandRunner;
  private readonly sha256Hex: (data: Buffer) => string;
  private readonly now: () => number;
  private readonly logger: UpdateLogger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly uid: number;
  private readonly thresholds: WorkerUpdaterThresholds;

  private currentState: WorkerUpdateState | undefined;
  private rolledBackFlag = false;
  /** 单飞锁：执行期间再来指令只 debug 记一笔就返回（心跳 10s 一轮，执行可能更久）。 */
  private inFlight = false;
  /** 已完成覆盖的目标版本（同版本重复指令不再重复下载/覆盖，指令未收敛时的护栏）。 */
  private appliedVersion: string | undefined;
  /** 失败退避闸门（0 = 可立即尝试）。 */
  private nextAttemptAt = 0;
  /** 本进程内已覆盖新码的时刻（回滚时长阈值的起点；未更新过 = undefined）。 */
  private updatedAt: number | undefined;
  /** 更新覆盖之后是否成功注册过一次（true = 新码已获认可，永不回滚）。 */
  private registeredSinceUpdate = true;
  private consecutiveRegisterFailures = 0;
  /** 已尝试过自动回滚——只做一次，之后只告警（防震荡）。 */
  private rollbackAttempted = false;

  constructor(options: WorkerUpdaterOptions) {
    this.serverUrl = options.serverUrl;
    this.installDir = options.installDir;
    this.activeSessionCount = options.activeSessionCount;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.fsImpl = options.fsImpl ?? defaultFs;
    this.run = options.run ?? spawnCommandRunner;
    this.sha256Hex =
      options.sha256Hex ?? ((data: Buffer) => createHash('sha256').update(data).digest('hex'));
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? console;
    this.env = options.env ?? process.env;
    this.uid = options.uid ?? os.userInfo().uid;
    this.thresholds = {
      retryBackoffMs: options.thresholds?.retryBackoffMs ?? UPDATE_RETRY_BACKOFF_MS,
      maxRegisterFailures:
        options.thresholds?.maxRegisterFailures ?? ROLLBACK_MAX_REGISTER_FAILURES,
      maxUpdateAgeMs: options.thresholds?.maxUpdateAgeMs ?? ROLLBACK_MAX_UPDATE_AGE_MS,
    };
  }

  /** 心跳/register 上报用的当前状态（undefined = 从未进入更新流程，不携带该键）。 */
  get state(): WorkerUpdateState | undefined {
    return this.currentState;
  }

  /** 一次性结果标志「最近一次自更新被自动回滚」（粘性，供 UI 展示最近结果）。 */
  get rolledBack(): boolean {
    return this.rolledBackFlag;
  }

  /** register 成功计数（与 index.ts 既有注册/退避逻辑并行，只读不改其行为）。 */
  noteRegisterSuccess(): void {
    this.consecutiveRegisterFailures = 0;
    this.registeredSinceUpdate = true;
  }

  /** register 失败计数（一次「重试耗尽仍失败」记 1 次，内部 8 次重试不拆分计数）。 */
  noteRegisterFailure(): void {
    this.consecutiveRegisterFailures += 1;
  }

  /** 测试/调试用只读视图。 */
  get debugState(): {
    registeredSinceUpdate: boolean;
    consecutiveRegisterFailures: number;
    updatedAt: number | undefined;
    appliedVersion: string | undefined;
    rollbackAttempted: boolean;
    inFlight: boolean;
  } {
    return {
      registeredSinceUpdate: this.registeredSinceUpdate,
      consecutiveRegisterFailures: this.consecutiveRegisterFailures,
      updatedAt: this.updatedAt,
      appliedVersion: this.appliedVersion,
      rollbackAttempted: this.rollbackAttempted,
      inFlight: this.inFlight,
    };
  }

  /**
   * 执行一条 update-worker 指令。**永不抛出**：所有失败路径都落到 warn + 停在 pending
   * （或 rolledback），让 worker 继续心跳——自更新失败不该把 worker 带下线。
   */
  async handleCommand(command: WorkerCommand): Promise<UpdateRunOutcome> {
    const version = readUpdateCommandVersion(command);
    if (version === undefined) {
      // 空版本**降级执行而非硬失败**（wire 契约）：指令不带目标版本时无法比对，
      // 但 sha256 校验 + 备份覆盖 + 重启全都照做——只把「版本必须一致」这一条
      // 降级为「version.json 必须存在」。硬失败会让 server 漏传版本时更新永远推不动。
      this.logger.warn(
        '[worker-update] update-worker 指令未携带目标版本（payload.version 与 resourceVersion 皆空），' +
          '降级执行：仅要求 version.json 存在且 sha256 校验通过，跳过版本一致性比对',
      );
    }
    return this.handleVersion(version);
  }

  /**
   * 实际执行入口（handleCommand 的实现，便于直接单测）。
   * `version` 为 undefined = 降级执行（只要求 version.json 存在，不比对版本号）。
   */
  async handleVersion(version: string | undefined): Promise<UpdateRunOutcome> {
    const label = version ?? '（无版本号的降级执行）';
    if (this.inFlight) {
      this.logger.debug(
        `[worker-update] 上一轮更新仍在执行中，忽略本轮 ${label} 指令（单飞锁）`,
      );
      return 'deferred-inflight';
    }
    // 降级指令没有可比对的版本号 → 只要本进程已覆盖完成（终态）就不重复下载。
    const alreadyApplied =
      this.isAppliedState() && (version === undefined || this.appliedVersion === version);
    if (alreadyApplied) {
      this.logger.debug(
        `[worker-update] 版本 ${this.appliedVersion ?? '未知'} 本进程已覆盖完成（${this.currentState}），忽略重复指令`,
      );
      return 'skipped-already-applied';
    }
    if (this.now() < this.nextAttemptAt) {
      const waitMs = this.nextAttemptAt - this.now();
      this.logger.debug(
        `[worker-update] 上一轮失败，退避中（剩余 ${Math.ceil(waitMs / 1000)}s），本轮跳过 ${label}`,
      );
      return 'deferred-backoff';
    }

    this.inFlight = true;
    try {
      return await this.runUpdate(version);
    } catch (err) {
      // 兜底：执行链内部已各自处理失败并 warn，走到这里说明有未预期的异常
      // （例如 fs 端口行为异常）。仍必须停回 pending 而不是让 worker 崩掉。
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[worker-update] 更新 ${version} 执行异常，停在 pending 待下轮重试: ${message}`);
      this.setState(WORKER_UPDATE_STATES.PENDING);
      this.scheduleRetry();
      return 'aborted';
    } finally {
      this.inFlight = false;
    }
  }

  /** 已覆盖完成的终态（据此判断「同版本重复指令」是否可以忽略）。 */
  private isAppliedState(): boolean {
    return (
      this.currentState === WORKER_UPDATE_STATES.RESTARTING ||
      this.currentState === WORKER_UPDATE_STATES.READY_MANUAL
    );
  }

  private async runUpdate(version: string | undefined): Promise<UpdateRunOutcome> {
    // a) 空闲判定：绝不打断进行中的会话（本计划决策④）。
    this.setState(WORKER_UPDATE_STATES.PENDING);
    const sessions = this.activeSessionCount();
    if (sessions > 0) {
      this.logger.debug(
        `[worker-update] 存在 ${sessions} 个活跃会话，本轮跳过（保持 pending，空闲后下轮心跳重试）`,
      );
      return 'deferred-idle';
    }

    const urls = resolveWorkerSourceUrls(this.serverUrl, this.env);
    this.setState(WORKER_UPDATE_STATES.DOWNLOADING);

    // b) 版本元数据：缺失/字段不合法 → 放弃本轮（绝不猜版本硬更）。
    // 版本比对只在指令**携带**了版本号时做——空版本是降级执行（见 handleCommand）。
    const meta = await this.fetchVersionMeta(urls.versionJson);
    if (meta === undefined) {
      this.abort(`版本元数据不可用（${urls.versionJson}），保持旧码待下轮重试`);
      return 'aborted';
    }
    if (version !== undefined && meta.version !== version) {
      this.abort(
        `发布包版本 ${meta.version} 与指令目标版本 ${version} 不一致，放弃本轮（等发布物更新后自然重试）`,
      );
      return 'aborted';
    }

    // b/c) 下载 + sha256 校验。校验不过 → 只删临时目录，**dist 一个字节都不动**。
    const stagingDir = await this.fsImpl.mkdtemp(path.join(os.tmpdir(), 'worker-update-'));
    try {
      const downloaded = await this.downloadTarball(urls.tarball);
      if (downloaded === undefined) {
        this.abort(`发布包下载失败（${urls.tarball}），保持旧码待下轮重试`);
        return 'aborted';
      }
      const digest = this.sha256Hex(downloaded);
      if (digest.toLowerCase() !== meta.sha256.toLowerCase()) {
        this.abort(
          `sha256 校验不通过（期望 ${meta.sha256}，实际 ${digest}），已放弃本轮，绝不覆盖 dist`,
        );
        return 'aborted';
      }
      const tarballPath = path.join(stagingDir, WORKER_SOURCE_TARBALL);
      await this.fsImpl.writeFile(tarballPath, downloaded);

      // 解压到临时目录：先在这里验包，坏包永远走不到安装目录。
      // `tar -xzf <包> -C <dir>` 与 install-worker.sh 同形 → 成员落在 stagingDir/dist 等。
      const extracted = await this.run('tar', ['-xzf', tarballPath, '-C', stagingDir], {
        timeoutMs: 120_000,
      });
      if (extracted.code !== 0) {
        this.abort(
          `发布包解压失败（tar 退出码 ${extracted.code}）：${(extracted.stderr || extracted.stdout).trim()}`,
        );
        return 'aborted';
      }
      // tar 直接解到 stagingDir（与 install-worker.sh 的 `tar -xzf -C <dir>` 同形），
      // 故成员路径是 stagingDir/dist 等；上面的 mkdir 只是 stagingDir 已存在的显式保证。

      const missing = await this.findMissingEntries(stagingDir, REQUIRED_PACKAGE_ENTRIES);
      if (missing.length > 0) {
        this.abort(`发布包缺少必需成员 ${missing.join(', ')}，放弃本轮（dist 未动）`);
        return 'aborted';
      }

      // d) lock 比对（内容差异即视为变化，含本地缺失的情形）。
      const lockChanged = await this.hasLockChanged(stagingDir);

      // e) 备份 + 覆盖。dist.prev 是回滚源，也是人工恢复用的一行命令里那个目录。
      const distDir = path.join(this.installDir, 'dist');
      const distPrevDir = path.join(this.installDir, 'dist.prev');
      if (await this.fsImpl.exists(distDir)) {
        await this.fsImpl.rm(distPrevDir);
        await this.fsImpl.rename(distDir, distPrevDir);
      }
      await this.fsImpl.cp(path.join(stagingDir, 'dist'), distDir);
      for (const entry of [...REQUIRED_PACKAGE_ENTRIES, ...OPTIONAL_PACKAGE_ENTRIES]) {
        if (entry === 'dist') continue;
        const from = path.join(stagingDir, entry);
        if (await this.fsImpl.exists(from)) {
          await this.fsImpl.cp(from, path.join(this.installDir, entry));
        }
      }

      // 覆盖完成即刻进入「待证明」状态：新码要靠一次成功注册来自证，否则回滚。
      this.appliedVersion = version ?? meta.version;
      this.updatedAt = this.now();
      this.registeredSinceUpdate = false;
      this.consecutiveRegisterFailures = 0;
      this.nextAttemptAt = 0;

      // d) lock 变化 → 装生产依赖；失败即回滚（依赖装不上，重试没有意义）。
      if (lockChanged) {
        const install = await this.run('npm', ['ci', '--omit=dev'], {
          cwd: this.installDir,
          timeoutMs: 600_000,
        });
        if (install.code !== 0) {
          const detail = (install.stderr || install.stdout).trim();
          this.logger.warn(
            `[worker-update] npm ci --omit=dev 失败（退出码 ${install.code}）：${detail}，立即回滚 dist.prev`,
          );
          const restored = await this.restoreDistFromBackup();
          // 进程仍在跑回滚后的旧码，注册链路本就正常 → 置 true，杜绝随后再触发一次回滚。
          this.registeredSinceUpdate = true;
          this.rollbackAttempted = true;
          this.rolledBackFlag = true;
          this.setState(WORKER_UPDATE_STATES.ROLLEDBACK);
          this.logger.warn(
            restored
              ? `[worker-update] 已恢复 dist.prev（dist 现状存于 dist.failed），上报 rolledback`
              : `[worker-update] 回滚失败：未找到 dist.prev，请人工恢复（${this.manualRecoveryHint()}）`,
          );
          return 'aborted';
        }
        this.logger.info('[worker-update] package-lock.json 已变化，npm ci --omit=dev 完成');
      } else {
        this.logger.debug('[worker-update] package-lock.json 未变化，跳过依赖安装');
      }

      // f) systemd 探测 + 重启（探测口径与 install-worker.sh 一致）。
      const systemd = await this.detectSystemd();
      if (systemd === null) {
        this.setState(WORKER_UPDATE_STATES.READY_MANUAL);
        this.logger.warn(
          `[worker-update] 未检测到可用的 systemd（${WORKER_SYSTEMD_UNIT} unit 不存在）——已下载待手动重启：` +
            `cd ${this.installDir} && ./scripts/start.sh`,
        );
        return 'applied-ready-manual';
      }

      // 覆盖与重启之间可能刚好起了一个会话：此时不重启（绝不打断会话），落 ready-manual。
      const sessionsBeforeRestart = this.activeSessionCount();
      if (sessionsBeforeRestart > 0) {
        this.setState(WORKER_UPDATE_STATES.READY_MANUAL);
        this.logger.warn(
          `[worker-update] 覆盖完成但此刻有 ${sessionsBeforeRestart} 个活跃会话，跳过重启——已下载待手动重启：` +
            `${systemd.ctlArgs.join(' ')} restart ${WORKER_SYSTEMD_UNIT}`,
        );
        return 'applied-ready-manual';
      }

      const restart = await this.run('systemctl', [...systemd.ctlArgs, 'restart', WORKER_SYSTEMD_UNIT], {
        env: this.systemctlEnv(systemd.scope),
        timeoutMs: 120_000,
      });
      if (restart.code !== 0) {
        this.setState(WORKER_UPDATE_STATES.READY_MANUAL);
        this.logger.warn(
          `systemctl restart ${WORKER_SYSTEMD_UNIT} 失败（退出码 ${restart.code}）：${(restart.stderr || restart.stdout).trim()}——已下载待手动重启`,
        );
        return 'applied-ready-manual';
      }
      this.setState(WORKER_UPDATE_STATES.RESTARTING);
      this.logger.info(
        `[worker-update] 新码已覆盖（dist.prev 已备份），systemctl ${systemd.ctlArgs.join(' ')} restart ${WORKER_SYSTEMD_UNIT} 已下发`,
      );
      return 'applied-restarting';
    } finally {
      // 临时目录（含未通过校验的 tarball）无论成败都清掉，不留垃圾占盘。
      await this.fsImpl.rm(stagingDir).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[worker-update] 清理临时目录 ${stagingDir} 失败: ${message}`);
      });
    }
  }

  /**
   * 回滚判定与执行。由 index.ts 在每次心跳前调用（不 await 也可，内部自带幂等）。
   *
   * 触发条件（两者先到者为准，且必须「更新后从未注册成功」+「dist.prev 存在」）：
   *   1. register 连续失败数 ≥ {@link ROLLBACK_MAX_REGISTER_FAILURES}；
   *   2. 距覆盖新码 ≥ {@link ROLLBACK_MAX_UPDATE_AGE_MS}。
   *
   * 第 2 条**额外要求注册确实在失败**（consecutiveRegisterFailures > 0）：无 systemd 时
   * 新码落 `ready-manual` 等人工重启（计划要求「一直等到手动重启」），此期间进程一直活着、
   * 心跳正常、register 也不会再发生——若只看「5 分钟未注册」就会把一份刚下好的、正在
   * 等人重启的好包悄悄回滚掉，与 ready-manual 的语义直接冲突。加上「注册确有失败」后，
   * 两条触发条件统一为「新码没被 server 认可」。
   */
  async maybeRollback(): Promise<boolean> {
    try {
      return await this.performRollback();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[worker-update] 回滚判定执行异常（本轮放弃，不影响心跳）: ${message}`);
      return false;
    }
  }

  private async performRollback(): Promise<boolean> {
    if (this.rollbackAttempted) {
      this.logger.debug('[worker-update] 已执行过一次自动回滚，后续不再自动动作（只告警）');
      return false;
    }
    if (this.registeredSinceUpdate || this.updatedAt === undefined) {
      return false;
    }
    const failures = this.consecutiveRegisterFailures;
    const ageMs = this.now() - this.updatedAt;
    const byFailures =
      failures >= this.thresholds.maxRegisterFailures && failures > 0;
    const byAge =
      failures > 0 && ageMs >= this.thresholds.maxUpdateAgeMs;
    if (!byFailures && !byAge) {
      return false;
    }

    const distDir = path.join(this.installDir, 'dist');
    const distPrevDir = path.join(this.installDir, 'dist.prev');
    const distFailedDir = path.join(this.installDir, 'dist.failed');
    if (!(await this.fsImpl.exists(distPrevDir))) {
      this.rollbackAttempted = true;
      this.logger.warn(
        `[worker-update] 达到回滚阈值（失败 ${failures} 次 / 已过 ${Math.round(ageMs / 1000)}s）但没有 dist.prev（首装或已被消费），不做自动回滚`,
      );
      return false;
    }

    this.rollbackAttempted = true;
    this.logger.warn(
      `[worker-update] 达到回滚阈值（register 连续失败 ${failures} 次${byFailures ? '' : `、更新后 ${Math.round(ageMs / 1000)}s 未注册成功`}），恢复 dist.prev`,
    );

    // dist → dist.failed 留证（保留上一次回滚现场），dist.prev → dist。
    try {
      if (await this.fsImpl.exists(distDir)) {
        await this.fsImpl.rm(distFailedDir);
        await this.fsImpl.rename(distDir, distFailedDir);
      }
      await this.fsImpl.rename(distPrevDir, distDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[worker-update] 回滚文件交换失败: ${message}；请人工恢复：${this.manualRecoveryHint()}`,
      );
      return false;
    }

    // 恢复后必须让进程真正跑回旧码：不重启的回滚没有意义。
    const systemd = await this.detectSystemd();
    let restarted = false;
    if (systemd !== null) {
      const restart = await this.run(
        'systemctl',
        [...systemd.ctlArgs, 'restart', WORKER_SYSTEMD_UNIT],
        { env: this.systemctlEnv(systemd.scope), timeoutMs: 120_000 },
      );
      restarted = restart.code === 0;
      if (!restarted) {
        this.logger.warn(
          `systemctl restart ${WORKER_SYSTEMD_UNIT} 失败（退出码 ${restart.code}）：${(restart.stderr || restart.stdout).trim()}`,
        );
      }
    } else {
      this.logger.warn(
        `[worker-update] 无可用 systemd，回滚后不会自动重启——请人工执行：${this.manualRecoveryHint()}`,
      );
    }

    this.rolledBackFlag = true;
    // 回到的是注册一直正常的旧码 → 置 true：注册一旦成功就证明新码有问题，绝不再自动动作。
    this.registeredSinceUpdate = true;
    this.consecutiveRegisterFailures = 0;
    this.setState(WORKER_UPDATE_STATES.ROLLEDBACK);
    this.logger.warn(
      restarted
        ? '[worker-update] 已回滚到 dist.prev 并重启（失败的新码留证于 dist.failed），上报 rolledback'
        : '[worker-update] 已把 dist 换回 dist.prev（未重启），上报 rolledback 并等待人工重启',
    );
    return true;
  }

  /** 放弃本轮的统一出口：warn + 停在 pending + 记退避（dist 未被动过）。 */
  private abort(reason: string): void {
    this.logger.warn(`[worker-update] ${reason}`);
    this.setState(WORKER_UPDATE_STATES.PENDING);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.nextAttemptAt = this.now() + this.thresholds.retryBackoffMs;
  }

  private setState(next: WorkerUpdateState): void {
    this.currentState = next;
  }

  /** 拉取并解析 worker-src.version.json；缺失/非 JSON/字段不全 → undefined（放弃本轮）。 */
  private async fetchVersionMeta(
    url: string,
  ): Promise<{ version: string; sha256: string } | undefined> {
    let raw: string;
    try {
      const response = await this.fetchImpl(url);
      if (!response.ok) {
        this.logger.warn(
          `[worker-update] 版本元数据拉取失败: HTTP ${response.status} ${response.statusText}（${url}）`,
        );
        return undefined;
      }
      raw = await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[worker-update] 版本元数据请求异常（${url}）: ${message}`);
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[worker-update] 版本元数据不是合法 JSON: ${message}`);
      return undefined;
    }
    const record = parsed as { version?: unknown; sha256?: unknown };
    const version = typeof record.version === 'string' ? record.version.trim() : '';
    const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim() : '';
    if (version === '' || !/^[0-9a-f]{64}$/i.test(sha256)) {
      this.logger.warn(
        `[worker-update] 版本元数据字段不合法（version=${version || '空'}, sha256=${sha256 || '空'}），放弃本轮`,
      );
      return undefined;
    }
    return { version, sha256 };
  }

  /** 下载 tarball 字节；HTTP/网络失败 → undefined（不抛，交给调用方 warn）。 */
  private async downloadTarball(url: string): Promise<Buffer | undefined> {
    try {
      const response = await this.fetchImpl(url);
      if (!response.ok) {
        this.logger.warn(
          `[worker-update] 发布包下载失败: HTTP ${response.status} ${response.statusText}（${url}）`,
        );
        return undefined;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[worker-update] 发布包下载异常（${url}）: ${message}`);
      return undefined;
    }
  }

  /** 必需成员缺失清单（空数组 = 齐备）。 */
  private async findMissingEntries(root: string, entries: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const entry of entries) {
      if (!(await this.fsImpl.exists(path.join(root, entry)))) {
        missing.push(entry);
      }
    }
    return missing;
  }

  /** package-lock.json 内容是否与本地不同（本地缺失也算变化 → 需要装依赖）。 */
  private async hasLockChanged(stagingDir: string): Promise<boolean> {
    const remotePath = path.join(stagingDir, 'package-lock.json');
    const localPath = path.join(this.installDir, 'package-lock.json');
    let remote: Buffer;
    try {
      remote = await this.fsImpl.readFile(remotePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[worker-update] 读取发布包 package-lock.json 失败: ${message}`);
      return false;
    }
    let local: Buffer | undefined;
    try {
      local = await this.fsImpl.readFile(localPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 本地读不到不是致命错误（首装/权限异常），按「无本地 lock」处理 → 视为变化。
      this.logger.debug(`[worker-update] 读取本地 package-lock.json 失败（按变化处理）: ${message}`);
      return true;
    }
    return !remote.equals(local);
  }

  /** dist.prev → dist 恢复（npm ci 失败时的即时回滚路径）。 */
  private async restoreDistFromBackup(): Promise<boolean> {
    const distDir = path.join(this.installDir, 'dist');
    const distPrevDir = path.join(this.installDir, 'dist.prev');
    if (!(await this.fsImpl.exists(distPrevDir))) {
      return false;
    }
    try {
      await this.fsImpl.rm(distDir);
      await this.fsImpl.rename(distPrevDir, distDir);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[worker-update] 恢复 dist.prev 失败: ${message}`);
      return false;
    }
  }

  /**
   * systemd 探测——逐条对齐 install-worker.sh：
   *   ① `command -v systemctl`（本实现等价物：`systemctl --version` 能正常执行）；
   *   ② `[ -d /run/systemd/system ]`（systemd 必须是 PID 1，容器内通常不满足）；
   *   ③ unit 存在：先用户级 `~/.config/systemd/user/<unit>`（安装脚本默认作用域），
   *      再系统级 `/etc/systemd/system/<unit>`（--system-service）。
   * 三条任一不满足 → null（调用方据此走 ready-manual，绝不 process.exit）。
   */
  private async detectSystemd(): Promise<SystemdTarget | null> {
    const probe = await this.run('systemctl', ['--version'], { timeoutMs: 10_000 });
    if (probe.code !== 0) {
      return null;
    }
    if (!(await this.fsImpl.isDirectory(SYSTEMD_RUNTIME_DIR))) {
      return null;
    }
    const userUnitPath = path.join(
      this.env.HOME ?? os.homedir(),
      '.config',
      'systemd',
      'user',
      `${WORKER_SYSTEMD_UNIT}.service`,
    );
    if (await this.fsImpl.exists(userUnitPath)) {
      return { scope: 'user', ctlArgs: ['--user'], unitPath: userUnitPath };
    }
    const systemUnitPath = path.join(
      '/etc/systemd/system',
      `${WORKER_SYSTEMD_UNIT}.service`,
    );
    if (await this.fsImpl.exists(systemUnitPath)) {
      return { scope: 'system', ctlArgs: [], unitPath: systemUnitPath };
    }
    return null;
  }

  /**
   * 用户级 systemctl 的运行环境（对齐 install-worker.sh 的会话总线兜底）：
   * 非交互式 SSH / 无桌面环境下 XDG_RUNTIME_DIR、DBUS_SESSION_BUS_ADDRESS 通常未就位，
   * 不补齐则 `systemctl --user` 直接报 "Failed to connect to bus"。系统级不需要。
   */
  private systemctlEnv(scope: 'user' | 'system'): NodeJS.ProcessEnv {
    if (scope !== 'user') {
      return this.env;
    }
    const xdgRuntimeDir = this.env.XDG_RUNTIME_DIR ?? `/run/user/${this.uid}`;
    return {
      ...this.env,
      XDG_RUNTIME_DIR: xdgRuntimeDir,
      DBUS_SESSION_BUS_ADDRESS:
        this.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${xdgRuntimeDir}/bus`,
    };
  }

  /** 人工恢复一行命令（硬崩溃等进程内状态已失的场景靠它兜底）。 */
  private manualRecoveryHint(): string {
    return (
      `cd ${this.installDir} && rm -rf dist.failed && mv dist dist.failed && ` +
      `mv dist.prev dist && systemctl --user restart ${WORKER_SYSTEMD_UNIT}`
    );
  }
}
