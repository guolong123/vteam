/**
 * 子进程树清理（Windows 原生支持 · M0）。
 *
 * 背景（真机实测 + 静态审计）：worker 原来用 `detached: true` + `process.kill(-pid)` 清理
 * serve 与超时命令——「负 pid = 进程组」是 POSIX 语义，Windows 上实测返回 `ESRCH`，
 * 而两个调用点的 `catch {}` 把它静默吞掉 ⇒ serve 停不掉、重启/退出后残留 `opencode.exe`。
 *
 * Windows 正确做法：`taskkill /PID <pid> /T /F`（/T 按父子关系遍历整棵树，/F 强制结束）。
 * 实测能一次清掉 `cmd.exe` → `opencode serve` 整条链；上游 opencode 自身在 win32 上也走
 * taskkill（cross-spawn-spawner）。
 *
 * POSIX 保持原语义：先对进程组 SIGTERM，宽限期后 SIGKILL，并等待退出。
 *
 * @module runtime/process-tree
 */

import { ChildProcess, spawn } from 'child_process';

export interface TerminateTreeOptions {
  /** 平台（默认 process.platform；单测注入）。 */
  platform?: NodeJS.Platform;
  /** POSIX：SIGTERM 到 SIGKILL 的宽限期（ms，默认 3000）。win32 不用。 */
  graceMs?: number;
  /** 是否等待退出（默认 true）。 */
  wait?: boolean;
  /** 注入的 taskkill 执行器（单测用；默认 spawn('taskkill')）。 */
  taskkillRunner?: (args: string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; detail?: string }>;
  env?: NodeJS.ProcessEnv;
  logger?: { warn(message: string): void };
}

/** `taskkill` 参数（单独导出便于单测断言）。 */
export function buildTaskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

/** 等待子进程退出；已退出立即返回；超时后返回（不抛错）。 */
/** 子进程是否已结束（信号终止时 exitCode 为 null、signalCode 有值——两者都要看）。 */
export function isChildExited(child: ChildProcess): boolean {
  const code = child.exitCode;
  const signal = child.signalCode;
  return (code !== null && code !== undefined) || (signal !== null && signal !== undefined);
}

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (isChildExited(child)) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 默认 taskkill 实现：spawn('taskkill', ['/PID', pid, '/T', '/F']) 并等退出。 */
function defaultTaskkill(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('taskkill', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
    } catch (err) {
      resolve({ ok: false, detail: (err as Error).message });
      return;
    }
    let detail = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      detail += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      detail += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ ok: false, detail: err.message }));
    child.on('close', (code) =>
      resolve({ ok: code === 0, detail: detail.trim() || `exit=${code}` }),
    );
  });
}

/**
 * 立即强杀整棵进程树（不等优雅退出）。
 *
 * 用于超时/取消的命令执行（原实现直接 `kill(-pid, 'SIGKILL')`）：
 * POSIX 保持 SIGKILL 进程组；win32 走 `taskkill /T /F`。
 *
 * @returns 结束时是否已确认子进程退出
 */
export async function killProcessTreeImmediate(
  child: ChildProcess,
  options: Omit<TerminateTreeOptions, 'graceMs'> = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  if (pid === undefined || isChildExited(child)) {
    return isChildExited(child);
  }
  const env = options.env ?? process.env;
  const wait = options.wait ?? false;

  if (platform === 'win32') {
    const runner = options.taskkillRunner ?? defaultTaskkill;
    let result: { ok: boolean; detail?: string };
    try {
      result = await runner(buildTaskkillArgs(pid), env);
    } catch (err) {
      result = { ok: false, detail: (err as Error).message };
    }
    if (!result.ok) {
      options.logger?.warn(
        `[process-tree] taskkill /T /F 未成功（pid=${pid}）：${result.detail ?? 'unknown'}` +
          '——回退为直接结束子进程（孙进程可能残留）',
      );
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        options.logger?.warn(`[process-tree] kill(-${pid}, SIGKILL) 失败：${code ?? String(err)}`);
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }
  }
  if (wait) {
    await waitForChildExit(child, 3000);
  }
  return isChildExited(child);
}

/**
 * 终止一个子进程及其整棵进程树。
 *
 * win32：`taskkill /T /F`；失败则回退 `child.kill('SIGKILL')`（TerminateProcess，只杀直接子进程）。
 * POSIX：`kill(-pid, SIGTERM)` → 等 graceMs → `kill(-pid, SIGKILL)`。
 *
 * @returns 结束时是否已确认子进程退出（`exitCode !== null`）
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: TerminateTreeOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  if (pid === undefined || isChildExited(child)) {
    return isChildExited(child);
  }
  const env = options.env ?? process.env;
  const wait = options.wait ?? true;

  if (platform === 'win32') {
    const args = buildTaskkillArgs(pid);
    const runner = options.taskkillRunner ?? defaultTaskkill;
    const result = await runner(args, env);
    if (!result.ok) {
      options.logger?.warn(
        `[process-tree] taskkill /T /F 未成功（pid=${pid}）：${result.detail ?? 'unknown'}` +
          '——回退为直接结束子进程（孙进程可能残留）',
      );
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
    }
    if (wait) {
      await waitForChildExit(child, 3000);
    }
    return isChildExited(child);
  }

  // POSIX：进程组（detached:true 时 pgid = pid）
  const graceMs = options.graceMs ?? 3000;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      options.logger?.warn(`[process-tree] kill(-${pid}, SIGTERM) 失败：${code ?? String(err)}`);
    }
  }
  if (wait) {
    await waitForChildExit(child, graceMs);
  }
  if (!isChildExited(child)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        options.logger?.warn(`[process-tree] kill(-${pid}, SIGKILL) 失败：${code ?? String(err)}`);
      }
    }
    if (wait) {
      await waitForChildExit(child, 1000);
    }
  }
  return isChildExited(child);
}
