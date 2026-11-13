/**
 * runtime/process-tree 单测（Windows 原生支持 · M0）。
 *
 * win32 分支用注入的 taskkill runner 断言参数/回退逻辑；POSIX 分支用真实子进程
 * （detached → 进程组）验证 SIGTERM/SIGKILL 与「立即强杀」。
 */

import { spawn, type ChildProcess } from 'node:child_process';

import {
  buildTaskkillArgs,
  killProcessTreeImmediate,
  terminateProcessTree,
  waitForChildExit,
} from './process-tree';

/** 构造一个可观测的假子进程（仅用于 win32 分支，不真的 spawn）。 */
function fakeChild(pid: number, exitCode: number | null = null): ChildProcess {
  const child = {
    pid,
    exitCode,
    // 真实 ChildProcess 的 signalCode 初始为 null；假对象补齐该字段，
    // 避免 isChildExited 把 undefined 误判成「已结束」。
    signalCode: null as NodeJS.Signals | null,
    kill: jest.fn(() => {
      child.exitCode = 0;
      return true;
    }),
  };
  return child as unknown as ChildProcess;
}

describe('buildTaskkillArgs', () => {
  it('按父子树 + 强制结束', () => {
    expect(buildTaskkillArgs(4242)).toEqual(['/PID', '4242', '/T', '/F']);
  });
});

describe('terminateProcessTree · win32', () => {
  it('走 taskkill /T /F（不是 process.kill 负 pid）', async () => {
    const runner = jest.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => ({ ok: true }));
    const child = fakeChild(4242);
    const finished = await terminateProcessTree(child, {
      platform: 'win32',
      wait: false,
      taskkillRunner: runner,
    });
    expect(runner.mock.calls[0][0]).toEqual(['/PID', '4242', '/T', '/F']);
    expect(finished).toBe(false); // wait:false 未等待退出
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('taskkill 失败 → 打 warn 并回退 child.kill(SIGKILL)', async () => {
    const runner = jest.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => ({ ok: false, detail: 'Access is denied.' }));
    const warn = jest.fn();
    const child = fakeChild(4242);
    await terminateProcessTree(child, {
      platform: 'win32',
      wait: false,
      taskkillRunner: runner,
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('taskkill /T /F 未成功'));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('已退出的子进程不再执行 taskkill', async () => {
    const runner = jest.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => ({ ok: true }));
    const child = fakeChild(4242, 0);
    const finished = await terminateProcessTree(child, {
      platform: 'win32',
      wait: false,
      taskkillRunner: runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(finished).toBe(true);
  });
});

// POSIX 专有用例（进程组 SIGTERM/SIGKILL 语义）：Windows 上跑必然失败（没有进程组），
// 由 win32 的 fake-process 用例覆盖对应分支。
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('terminateProcessTree · POSIX（真实子进程）', () => {
  it('detached 子进程被整组清理并确认退出', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    expect(child.pid).toBeDefined();
    const finished = await terminateProcessTree(child, { platform: 'linux', graceMs: 300 });
    expect(finished).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('waitForChildExit 对已退出进程立即返回', async () => {
    const child = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await expect(waitForChildExit(child, 5000)).resolves.toBeUndefined();
  });

  it('killProcessTreeImmediate 立即强杀进程组', async () => {
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
    const finished = await killProcessTreeImmediate(child, { platform: 'linux', wait: true });
    expect(finished).toBe(true);
  });
});

describe('killProcessTreeImmediate', () => {
  it('win32 走 taskkill /T /F', async () => {
    const runner = jest.fn(async (_args: string[], _env: NodeJS.ProcessEnv) => ({ ok: true }));
    const child = fakeChild(777);
    await killProcessTreeImmediate(child, {
      platform: 'win32',
      wait: false,
      taskkillRunner: runner,
    });
    expect(runner.mock.calls[0][0]).toEqual(['/PID', '777', '/T', '/F']);
  });
});
