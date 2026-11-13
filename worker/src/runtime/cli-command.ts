/**
 * 跨平台 CLI 命令解析（Windows 原生支持 · M0）。
 *
 * 背景（真机实测，GitHub Actions windows-latest + Node 22）：
 * - `spawn('opencode', args)` 在 Windows 上直接 `ENOENT`：npm 全局安装只会生成
 *   `opencode`（无扩展名 sh shim）、`opencode.cmd`、`opencode.ps1` 三个壳，
 *   `CreateProcess` 不认 `.cmd`，libuv 的 PATH 查找也只补 `.com/.exe`。
 * - `spawn('opencode.cmd', args)`（不带 shell）在 Node ≥ 18.20 / 20.12 上抛 `EINVAL`
 *   （CVE-2024-27980 的修复：禁止直接 spawn `.cmd/.bat`）。
 * - `spawn(cmd, args, { shell: true })` 与 `spawn(comspec, ['/d','/s','/c', commandLine])`
 *   都能跑通（实测 `opencode v2.0.32`）。
 * - `where.exe opencode` 的**第一条**是那个无扩展名 shim（`C:\npm\prefix\opencode`）——
 *   直接 spawn 它是 ENOENT，必须先按扩展名过滤，优先 `.exe`、其次 `.cmd/.bat`。
 *
 * 因此 worker 里所有「裸命令名 + 无 shell」的 spawn/spawnSync 都改走本模块：
 *   POSIX  ：原样返回（行为与改造前完全一致，避免回归）。
 *   win32  ：显式 `.exe` → 直接 spawn（无 shell 注入面）；
 *            其余（`.cmd/.bat` / 裸名 / PATH 解析结果）→ `cmd.exe /d /s /c "<命令行>"`
 *            + `windowsVerbatimArguments: true`（引号按 cmd 语义自己拼，Node 不再二次加引号）。
 *
 * 为什么优先直接 spawn `.exe`：不走 shell = 没有 cmd 元字符/引号解析问题；
 * `opencode` 的 npm 包实际落盘了一个 213MB 的 `@opencode/cli/bin/opencode.exe`，
 * 由安装器把绝对路径写进 `OPENCODE_BIN` 即可，连 `where` 探测都省了。
 *
 * ⚠️ 已知限制（有意接受，写死给排障用）：
 * - 经 cmd 包装时，参数里若出现 `"` 直接抛错（我们的调用点只有 `serve --port N`、
 *   `--version` 这类常量参数，不含自由文本）；`%`/`!` 在 cmd 里会做变量展开，
 *   同样不在当前参数集里出现。
 * - 只解析 `.exe/.com/.cmd/.bat`；`.ps1` 不在 PATHEXT 里，也不支持（worker 不依赖它）。
 *
 * @module runtime/cli-command
 */

import { spawnSync } from 'child_process';
import * as fs from 'node:fs';

/** 解析结果：直接喂给 child_process.spawn / spawnSync 的 file+args 与需合并的选项。 */
export interface ResolvedCli {
  /** spawn 的 file（win32 经 cmd 包装时为 ComSpec）。 */
  file: string;
  /** spawn 的 args（win32 经 cmd 包装时是 ['/d','/s','/c', '<命令行>']）。 */
  args: string[];
  /** true = 经 shell（cmd.exe）包装；日志/排障用。 */
  viaShell: boolean;
  /** 最终解析到的可执行文件（裸名解析失败时为原始逻辑名）。 */
  resolvedPath: string;
  /** 需要透传给 spawn 的 Windows 专用选项（非 win32 为 undefined）。 */
  windowsVerbatimArguments?: boolean;
}

export interface CliCommandSpec {
  /** 逻辑命令名（`opencode`）或显式路径（`C:\...\opencode.exe`、`opencode.cmd`）。 */
  command: string;
  args: string[];
  /** 平台（默认 process.platform；单测可注入，避免在 POSIX 上无法覆盖 win32 分支）。 */
  platform?: NodeJS.Platform;
  /** 环境变量视图（默认 process.env；解析 ComSpec/PATH 用）。 */
  env?: NodeJS.ProcessEnv;
  /**
   * win32 下是否尝试用 `where.exe` 把裸名解析成绝对路径（默认 true）。
   * 关闭后走「cmd /c + 裸名」兜底（cmd 自己会按 PATHEXT 找到 `.cmd`）。
   */
  lookup?: boolean;
  /** 注入的 where 实现（单测用；默认 spawnSync('where.exe')）。 */
  whereRunner?: (command: string, env: NodeJS.ProcessEnv) => string[];
  /** 注入的 ComSpec（单测用；默认 env.ComSpec/COMSPEC/'cmd.exe'）。 */
  comspec?: string;
}

/** 可执行扩展名（win32）。`.exe` 可直连，`.cmd/.bat` 必须经 cmd。 */
const WINDOWS_EXE_RE = /\.(exe|com)$/i;
const WINDOWS_SCRIPT_RE = /\.(cmd|bat)$/i;

/** `where.exe` 解析缓存（key = `${command}\u0000${PATH}`；null = 已确认未命中，避免重复 spawn）。 */
const whereCache = new Map<string, string | null>();

/** 清空解析缓存（单测用；生产进程不需要）。 */
export function resetCliResolutionCache(): void {
  whereCache.clear();
}

/** 是否 Windows 平台（默认读取 process.platform）。 */
export function isWindowsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

/** 是否 Windows 绝对路径（`C:\…` / `C:/…` / UNC `\\server\share`）。 */
export function isWindowsAbsolutePath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\');
}

/**
 * 候选可执行文件的优先级：`.exe/.com` 最高、`.cmd/.bat` 次之、其余（含 npm 的无扩展名
 * sh shim）视为不可直接执行。数值越小越优先。
 */
function candidateRank(candidate: string): number {
  if (WINDOWS_EXE_RE.test(candidate)) return 0;
  if (WINDOWS_SCRIPT_RE.test(candidate)) return 1;
  return 2;
}

/** 默认 where 实现：`where.exe <command>` → 逐行路径。失败/超时返回空数组（不抛错）。 */
function defaultWhere(command: string, env: NodeJS.ProcessEnv): string[] {
  try {
    const result = spawnSync('where.exe', [command], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      env,
    });
    if (result.status !== 0) {
      return [];
    }
    return (result.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * win32 解析命令目标：
 * - 含路径分隔符（显式路径）：必须存在，且不能是无扩展名 shim（明确报错，避免又变成 ENOENT）；
 * - 裸名：`where` 结果按 `candidateRank` 取最优（跳过无扩展名 shim）；未命中返回 null。
 */
function resolveWindowsTarget(spec: CliCommandSpec, env: NodeJS.ProcessEnv): string | null {
  const command = spec.command;
  if (hasPathSeparator(command)) {
    if (!fs.existsSync(command)) {
      throw new Error(
        `[cli-command] 可执行文件不存在：${command}` +
          '（检查 OPENCODE_BIN / DSH_BIN 或安装路径是否被移动；Windows 安装器应写入绝对路径）',
      );
    }
    if (!WINDOWS_EXE_RE.test(command) && !WINDOWS_SCRIPT_RE.test(command)) {
      throw new Error(
        `[cli-command] 指向无扩展名的 shim（${command}）：Windows 无法直接执行，` +
          '请指向真实的 .exe 或 .cmd（例如 @opencode/cli 的 bin\\opencode.exe，或 npm 全局 bin\\opencode.cmd）',
      );
    }
    return command;
  }

  if (spec.lookup === false) {
    return null;
  }

  const cacheKey = `${command}\u0000${env.PATH ?? env.Path ?? ''}`;
  const cached = whereCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const runner = spec.whereRunner ?? defaultWhere;
  let best: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const hit of runner(command, env)) {
    const rank = candidateRank(hit);
    if (rank < bestRank) {
      best = hit;
      bestRank = rank;
    }
  }
  // 只保留 exe/cmd/bat；全是无扩展名 shim 时视为「未解析到」（交给 cmd 兜底）
  if (best !== null && bestRank >= 2) {
    best = null;
  }
  whereCache.set(cacheKey, best);
  return best;
}

/**
 * 按 cmd.exe 语义拼一条命令行（含文件本身）。
 *
 * 需要引号的情形：空白、以及 cmd 的元字符 `& | < > ^ ( )`。参数里出现双引号直接抛错
 * （见模块头「已知限制」——当前调用点都是常量参数，不做通用转义以免引入静默错误）。
 *
 * @param file 可执行文件（可含空格）
 * @param args 参数数组
 */
export function buildWindowsCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args]
    .map((raw) => {
      if (raw === '') {
        return '""';
      }
      if (raw.includes('"')) {
        throw new Error(`[cli-command] 不支持的参数（含双引号）：${raw}`);
      }
      return /[\s&|<>^()%!]/.test(raw) ? `"${raw}"` : raw;
    })
    .join(' ');
}

/**
 * 解析一条 CLI 命令为「file + args + 平台选项」，调用方直接 spawn。
 *
 * 例（win32，npm 全局装的 opencode，未设 OPENCODE_BIN）：
 *   resolveCliCommand({ command: 'opencode', args: ['serve', '--port', '4199'] })
 *   → { file: 'C:\\Windows\\system32\\cmd.exe',
 *       args: ['/d','/s','/c','"C:\\npm\\prefix\\opencode.cmd" serve --port 4199"'],
 *       viaShell: true, windowsVerbatimArguments: true }
 */
export function resolveCliCommand(spec: CliCommandSpec): ResolvedCli {
  const platform = spec.platform ?? process.platform;
  const env = spec.env ?? process.env;
  const args = [...spec.args];

  // POSIX：保持改造前的原样（直接 spawn 裸名/路径），不引入任何行为变化。
  if (platform !== 'win32') {
    return { file: spec.command, args, viaShell: false, resolvedPath: spec.command };
  }

  const target = resolveWindowsTarget(spec, env) ?? spec.command;
  if (WINDOWS_EXE_RE.test(target)) {
    return { file: target, args, viaShell: false, resolvedPath: target };
  }

  const comspec = spec.comspec ?? env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  const commandLine = buildWindowsCommandLine(target, args);
  return {
    file: comspec,
    // /d 跳过 AutoRun；/s 让 cmd 按「剥掉首尾引号」的规则处理后续整条命令行；
    // 外层再包一层引号是 /s 的配套写法：""C:\...\opencode.cmd" --version"
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    viaShell: true,
    resolvedPath: target,
    windowsVerbatimArguments: true,
  };
}

export interface SpawnCliSyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface SpawnCliSyncOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  lookup?: boolean;
  whereRunner?: (command: string, env: NodeJS.ProcessEnv) => string[];
  comspec?: string;
  timeoutMs?: number;
}

/**
 * 解析 + `spawnSync`（版本探测等同步场景）。
 *
 * 与直接 `spawnSync('opencode', ['--version'])` 的区别：win32 上会经 cmd 包装/解析真实
 * 可执行文件，因此不会再返回 ENOENT；解析失败（显式路径不存在）会走 `error` 字段。
 */
export function spawnCliSync(
  command: string,
  args: string[],
  options: SpawnCliSyncOptions = {},
): SpawnCliSyncResult {
  let resolved: ResolvedCli;
  try {
    resolved = resolveCliCommand({
      command,
      args,
      platform: options.platform,
      env: options.env,
      lookup: options.lookup,
      whereRunner: options.whereRunner,
      comspec: options.comspec,
    });
  } catch (err) {
    return { status: null, stdout: '', stderr: '', error: err as Error };
  }
  try {
    const result = spawnSync(resolved.file, resolved.args, {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 5000,
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      env: options.env ?? process.env,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error ?? undefined,
    };
  } catch (err) {
    return { status: null, stdout: '', stderr: '', error: err as Error };
  }
}
