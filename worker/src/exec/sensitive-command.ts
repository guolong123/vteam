/**
 * 敏感命令执行（sensitive-command-tool todo 3）。
 *
 * 三条硬约束：
 * 1. 只用异步 `spawn`（detached 自成进程组），超时/取消对进程组 `kill(-pid, SIGKILL)`；
 *    绝不用同步的子进程执行——同步等待会阻塞 worker 事件循环与心跳。
 * 2. 渲染后命令 / argv / cwd / secret 明文不得出现在日志、返回值或错误 message：
 *    本模块零日志，所有对外 message 都是固定字面量（唯一动态片段是白名单正则
 *    校验过的 errno 码），输出统一走 scrubSecrets。
 * 3. 每个流：精确值替换（降序长度、纯字符串）→ 残留 `{{NAME}}` 掩码 → 32KB 截断。
 *
 * 残余风险（有意接受）：resolveSafeCwd 在 spawn 前做一次 realpath 校验，
 * 校验与 spawn 之间目录被替换成符号链接的 TOCTOU 窗口无法在无沙箱前提下消除。
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  SensitiveCommandInput,
  SensitiveCommandOutput,
} from '../protocol/worker-protocol';

export type { SensitiveCommandInput, SensitiveCommandOutput };

/** 单流输出上限（bytes，脱敏后按字节截断）。 */
export const MAX_SENSITIVE_OUTPUT_BYTES = 32768;
/** 未传 timeoutMs 时的默认超时。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60000;
/** 超时硬上限（调用方传更大值只按此值执行）。 */
export const MAX_COMMAND_TIMEOUT_MS = 600000;
/** 命令模板字节上限（畸形输入防护）。 */
const MAX_TEMPLATE_BYTES = 64 * 1024;
/**
 * 单流原始输出采集上限：超过后停止累积（继续 drain 防子进程管道阻塞）。
 * 截断目标只有 32KB，1MB 采集额度远高于脱敏后仍需的量；命中上限即置 truncated。
 */
const MAX_RAW_CAPTURE_BYTES = 1024 * 1024;
/** 占位符形状（模板替换与残留掩码共用同一字符集）。 */
const SUBSTITUTE_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;
const PLACEHOLDER_RE = /\{\{[A-Za-z0-9_]+\}\}/g;
const REDACT_MASK = '{{REDACTED}}';
const SHELL_FILE = '/bin/sh';
/** errno 白名单正则：只有匹配的码才允许进错误 message（杜绝把任意字符串拼进去）。 */
const ERRNO_RE = /^[A-Z][A-Z0-9_]*$/;
/** 杀进程组后的兜底宽限：'close' 迟迟不来时最多再等这么久就返回已采集的输出。 */
const KILL_GRACE_MS = 3000;

export type SensitiveCommandErrorCode =
  | 'invalid_input'
  | 'invalid_workdir'
  | 'invalid_template'
  | 'invalid_secrets'
  | 'invalid_cwd'
  | 'invalid_timeout';

/**
 * 敏感命令校验/启动失败。message 一律为调用点的固定字面量，
 * 不携带模板、渲染结果、argv、cwd 或 secret。
 */
export class SensitiveCommandError extends Error {
  readonly code: SensitiveCommandErrorCode;

  constructor(code: SensitiveCommandErrorCode, message: string) {
    super(message);
    this.name = 'SensitiveCommandError';
    this.code = code;
  }
}

export interface SensitiveCommandOptions {
  /** worker workDir：cwd 与符号链接解析的唯一合法根。 */
  workDir: string;
  /** 外部取消信号（触发后与超时同路径：进程组 SIGKILL）。 */
  signal?: AbortSignal;
}

function normalizeSecrets(secrets: unknown): Record<string, string> {
  if (secrets === null || typeof secrets !== 'object' || Array.isArray(secrets)) {
    throw new SensitiveCommandError('invalid_secrets', 'secrets must be an object of string values');
  }
  const record = secrets as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (typeof record[key] !== 'string') {
      throw new SensitiveCommandError('invalid_secrets', 'secrets must be an object of string values');
    }
  }
  return record as Record<string, string>;
}

function validateTemplate(template: unknown): string {
  if (typeof template !== 'string' || template.length === 0) {
    throw new SensitiveCommandError('invalid_template', 'command template must be a non-empty string');
  }
  if (template.includes('\0')) {
    throw new SensitiveCommandError('invalid_template', 'command template contains an illegal character');
  }
  if (Buffer.byteLength(template, 'utf8') > MAX_TEMPLATE_BYTES) {
    throw new SensitiveCommandError('invalid_template', 'command template exceeds the size limit');
  }
  return template;
}

/**
 * 模板占位符替换：`{{NAME}}` → secrets[NAME]（精确、单遍，插入值不再被二次扫描）；
 * 未声明的占位符原样保留，由 scrubSecrets 在输出侧掩码。
 */
export function substituteTemplate(
  template: string,
  secrets: Record<string, string>,
): string {
  const validatedTemplate = validateTemplate(template);
  const validatedSecrets = normalizeSecrets(secrets);
  return validatedTemplate.replace(SUBSTITUTE_RE, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(validatedSecrets, name)) {
      return match;
    }
    return validatedSecrets[name];
  });
}

/**
 * 精确值脱敏：按长度降序对 secret 明文做纯字符串替换（split/join，
 * 不经过正则，规避元字符转义 bug），随后掩码输出中残留的 `{{NAME}}` 占位符。
 */
export function scrubSecrets(
  text: string,
  secrets: Record<string, string>,
): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }
  const record =
    secrets !== null && typeof secrets === 'object' && !Array.isArray(secrets)
      ? (secrets as Record<string, unknown>)
      : {};
  const values = Object.keys(record)
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);

  let out = text;
  for (const value of values) {
    out = out.split(value).join(REDACT_MASK);
  }
  return out.replace(PLACEHOLDER_RE, REDACT_MASK);
}

/**
 * 解析并约束 cwd：相对路径、无 `..`、无 NUL，解析后的真实路径必须仍在
 * workDir 真实路径之内（符号链接逃逸拒绝）。返回 realpath 供 spawn 使用。
 * 错误 message 不回显传入路径。
 */
export function resolveSafeCwd(workDir: string, cwd?: string): string {
  if (typeof workDir !== 'string' || workDir.length === 0) {
    throw new SensitiveCommandError('invalid_workdir', 'worker work directory is not configured');
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workDir);
  } catch {
    throw new SensitiveCommandError('invalid_workdir', 'worker work directory cannot be resolved');
  }

  if (cwd === undefined || cwd === '') {
    return realRoot;
  }
  if (typeof cwd !== 'string') {
    throw new SensitiveCommandError('invalid_cwd', 'cwd must be a relative path inside the work directory');
  }
  if (cwd.includes('\0')) {
    throw new SensitiveCommandError('invalid_cwd', 'cwd contains an illegal character');
  }
  if (path.isAbsolute(cwd)) {
    throw new SensitiveCommandError('invalid_cwd', 'cwd must be a relative path inside the work directory');
  }
  if (cwd.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw new SensitiveCommandError('invalid_cwd', 'cwd must stay inside the work directory');
  }

  const candidate = path.resolve(realRoot, cwd);
  if (candidate !== realRoot && !candidate.startsWith(realRoot + path.sep)) {
    throw new SensitiveCommandError('invalid_cwd', 'cwd must stay inside the work directory');
  }

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch {
    throw new SensitiveCommandError('invalid_cwd', 'cwd does not exist or cannot be resolved');
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new SensitiveCommandError('invalid_cwd', 'cwd resolves outside the work directory');
  }
  if (!fs.statSync(realTarget).isDirectory()) {
    throw new SensitiveCommandError('invalid_cwd', 'cwd is not a directory');
  }
  return realTarget;
}

function normalizeTimeout(timeoutMs: unknown): number {
  if (timeoutMs === undefined || timeoutMs === null) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new SensitiveCommandError('invalid_timeout', 'timeoutMs must be a positive finite number');
  }
  return Math.min(timeoutMs, MAX_COMMAND_TIMEOUT_MS);
}

/** 对进程组发 SIGKILL（detached 子进程自成组，pgid = pid）；组已消失则静默忽略。 */
function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return;
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // 进程已退出：忽略
    }
  }
}

/** 截断到 max 字节并回退到完整 UTF-8 字符边界（避免切断多字节序列）。 */
function cutBytes(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) {
    return buf;
  }
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end);
}

interface StreamCapture {
  chunks: Buffer[];
  bytes: number;
  capped: boolean;
}

function makeCollector(state: StreamCapture) {
  return (chunk: Buffer): void => {
    if (state.bytes >= MAX_RAW_CAPTURE_BYTES) {
      state.capped = true;
      return;
    }
    const room = MAX_RAW_CAPTURE_BYTES - state.bytes;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (slice.length > 0) {
      state.chunks.push(slice);
      state.bytes += slice.length;
    }
    if (slice.length < chunk.length) {
      state.capped = true;
    }
  };
}

interface StreamResult {
  text: string;
  truncated: boolean;
}

function finalizeStream(
  capture: StreamCapture,
  secrets: Record<string, string>,
): StreamResult {
  const raw = Buffer.concat(capture.chunks);
  const scrubbed = scrubSecrets(raw.toString('utf8'), secrets);
  const scrubbedBuf = Buffer.from(scrubbed, 'utf8');
  const truncated = capture.capped || scrubbedBuf.length > MAX_SENSITIVE_OUTPUT_BYTES;
  return {
    text: cutBytes(scrubbedBuf, MAX_SENSITIVE_OUTPUT_BYTES).toString('utf8'),
    truncated,
  };
}

function makeOutput(overrides: Partial<SensitiveCommandOutput>): SensitiveCommandOutput {
  return {
    status: 'failed',
    exitCode: null,
    durationMs: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

/**
 * 执行敏感命令：渲染 → 约束 cwd → 异步 spawn（进程组）→ 超时/取消杀组 →
 * 双流脱敏 + 截断 → 结构化结果。校验失败抛 SensitiveCommandError（路由映射 400）；
 * 命令本身的成功/失败/超时以返回值表达。
 */
export async function runSensitiveCommand(
  input: SensitiveCommandInput,
  options: SensitiveCommandOptions,
): Promise<SensitiveCommandOutput> {
  if (input === null || typeof input !== 'object') {
    throw new SensitiveCommandError('invalid_input', 'request body must be an object');
  }
  const secrets = normalizeSecrets(input.secrets);
  const rendered = substituteTemplate(input.commandTemplate, secrets);
  const cwd = resolveSafeCwd(options?.workDir, input.cwd);
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const started = Date.now();

  if (options?.signal?.aborted) {
    return makeOutput({ status: 'timeout', durationMs: Date.now() - started });
  }

  let child: ChildProcess;
  try {
    child = spawn(SHELL_FILE, ['-c', rendered], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch {
    return makeOutput({
      durationMs: Date.now() - started,
      error: scrubSecrets('failed to start the command process', secrets),
    });
  }

  const stdout: StreamCapture = { chunks: [], bytes: 0, capped: false };
  const stderr: StreamCapture = { chunks: [], bytes: 0, capped: false };
  child.stdout?.on('data', makeCollector(stdout));
  child.stderr?.on('data', makeCollector(stderr));

  const state: {
    timedOut: boolean;
    cancelled: boolean;
    spawnError: Error | null;
    exitCode: number | null;
  } = { timedOut: false, cancelled: false, spawnError: null, exitCode: null };

  let settled = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let settle!: () => void;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const done = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
    }
    settle();
  };
  // 杀组后进程已退出但管道被逃逸孙进程持有（setsid 后台任务）时 'close' 可能永不
  // 触发：宽限期兜底保证调用方一定拿到结果而不是挂死 worker 路由。
  const killChild = (): void => {
    killProcessGroup(child);
    if (graceTimer === undefined) {
      graceTimer = setTimeout(done, KILL_GRACE_MS);
    }
  };

  child.once('error', (err: Error) => {
    state.spawnError = err;
    done();
  });
  child.once('close', (code: number | null) => {
    state.exitCode = code;
    done();
  });

  const onAbort = (): void => {
    state.cancelled = true;
    killChild();
  };
  options?.signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => {
    state.timedOut = true;
    killChild();
  }, timeoutMs);

  await closed;
  clearTimeout(timer);
  options?.signal?.removeEventListener('abort', onAbort);

  const stderrResult = finalizeStream(stderr, secrets);
  const stdoutResult = finalizeStream(stdout, secrets);

  let status: SensitiveCommandOutput['status'];
  if (state.timedOut || state.cancelled) {
    status = 'timeout';
  } else if (state.spawnError !== null) {
    status = 'failed';
  } else if (state.exitCode === 0) {
    status = 'succeeded';
  } else {
    status = 'failed';
  }

  let error: string | undefined;
  if (state.spawnError !== null) {
    const code = (state.spawnError as NodeJS.ErrnoException).code;
    const errno = typeof code === 'string' && ERRNO_RE.test(code) ? ` (${code})` : '';
    error = scrubSecrets(`failed to start the command process${errno}`, secrets);
  }

  return makeOutput({
    status,
    exitCode: state.exitCode,
    durationMs: Date.now() - started,
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
    error,
  });
}
