/**
 * DshRpcClient 子进程启动失败（spawn `'error'`）回归测试（P0-3）。
 *
 * 背景：`start()` 早先只挂了 `stderr`/`exit` 监听，**没有** `'error'` 监听 ⇒ Windows 上
 * `spawn('dsh')`（npm 全局只有 `dsh.cmd` shim）触发 ENOENT 时，Node 把无监听者的
 * `'error'` 当未捕获异常处理 ⇒ worker 进程直接崩（不是"启动失败退出"）。
 *
 * 本 spec 用 mock 的 `node:child_process.spawn` 复刻真机时序（Node 18–24 实测）：
 * - spawn 返回的 ChildProcess 里 `stdin`/`stdout`/`stderr` **都是可用管道**（不是 null）；
 * - 失败在下一次 tick 以 `'error'` 事件到达，此时 `exitCode` 已被置为 -2；
 * - **只发 `'close'`，不发 `'exit'`** ⇒ 挂在 `'exit'` 上的兜底 reject 不会执行。
 *
 * 断言三件事：① 不崩（监听者在 spawn 后同 tick 挂上）；② initialize 以明确错误失败
 * （不空等 30s 握手超时）；③ 后续 request 立即失败（不再往死进程 stdin 写帧）。
 * 另附一条正常握手用例，确认协议行为未被改动。
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

import { DshRpcClient } from './dsh-rpc-client';

const spawnMock = spawn as unknown as jest.Mock;

/** 静默 logger：断言全部落在错误对象上，不污染测试输出。 */
const silentLogger = { info: (): void => {}, warn: (): void => {}, error: (): void => {} };

/**
 * 假 ChildProcess：EventEmitter + 三条管道。
 *
 * `pid`/`exitCode` 与真 Node 行为对齐（spawn 失败时 pid 为 undefined、error 事件里
 * exitCode 已是 -2）；`kill` 只记录调用（spawn 失败路径不应再走 kill 阶梯）。
 */
class FakeChildProcess extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kill = jest.fn((): boolean => true);
}

/** 构造 ENOENT 形态的 spawn 错误（字段对齐 Node 的 libuv 错误对象）。 */
function enoentError(bin: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${bin} ENOENT`), {
    code: 'ENOENT',
    errno: -2,
    syscall: `spawn ${bin}`,
    path: bin,
  });
}

/**
 * 让本用例的 spawn 返回一个"稍后失败"的假子进程，并复刻真机时序
 * （返回 → 下一 tick 发 'error' 并置 exitCode=-2 → 再发 'close'，永不发 'exit'）。
 */
function armFailingSpawn(error: NodeJS.ErrnoException): FakeChildProcess {
  const child = new FakeChildProcess();
  spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
  process.nextTick(() => {
    child.exitCode = -2;
    child.emit('error', error);
    child.emit('close', -2, null);
  });
  return child;
}

afterEach(() => {
  spawnMock.mockReset();
});

describe('DshRpcClient spawn 失败（P0-3：缺 error 监听会崩进程）', () => {
  it('spawn 后同 tick 就挂上 error 监听（无监听者 = uncaughtException 崩进程）', async () => {
    const child = armFailingSpawn(enoentError('dsh'));
    const client = new DshRpcClient({ dshBin: 'dsh', logger: silentLogger });
    const started = client.start({ cwd: '/tmp', provider: 'p', model: 'm' });
    // start() 在返回 Promise 前已同步执行到 attach 监听；这里同步断言，防「等下一个 tick 才挂」的回归。
    expect(child.listenerCount('error')).toBeGreaterThan(0);
    await started.catch(() => undefined);
  });

  it('ENOENT：initialize 以明确错误失败（不空等握手超时），错误含 bin 与 errno', async () => {
    armFailingSpawn(enoentError('dsh'));
    const client = new DshRpcClient({
      dshBin: 'dsh',
      logger: silentLogger,
      // 故意给大超时：若回归成"等超时"，本用例会明显变慢且错误文案命中「超时」断言。
      initializeTimeoutMs: 30_000,
    });

    const error = (await client.start({ cwd: '/tmp', provider: 'p', model: 'm' }).catch(
      (err: Error) => err,
    )) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('[dsh-rpc] initialize 失败');
    expect(error.message).toContain('子进程启动失败');
    expect(error.message).toContain('bin=dsh');
    expect(error.message).toContain('ENOENT');
    expect(error.message).not.toContain('超时');
  });

  it('spawn 失败后 request 立即失败（不再写死进程 stdin / 不挂起到超时）', async () => {
    armFailingSpawn(enoentError('dsh'));
    const client = new DshRpcClient({ dshBin: 'dsh', logger: silentLogger });

    await client.start({ cwd: '/tmp', provider: 'p', model: 'm' }).catch(() => undefined);

    await expect(client.request('session/prompt', { sessionId: 's1' })).rejects.toThrow(
      /子进程启动失败/,
    );
    // 运行时已被标记为不可用：不能把"启动失败"伪装成"未启动"以外的成功状态。
    expect(client.isRunning).toBe(false);
  });

  it('POSIX 提示不混入 Windows 专有指引（错误文案按平台收敛）', async () => {
    armFailingSpawn(enoentError('dsh'));
    const client = new DshRpcClient({ dshBin: 'dsh', logger: silentLogger });

    const error = (await client.start({ cwd: '/tmp', provider: 'p', model: 'm' }).catch(
      (err: Error) => err,
    )) as Error;

    if (process.platform === 'win32') {
      // [需 Windows 真机复验] 这半句是给"dsh 直接 spawn 失败"现场的自助指引。
      expect(error.message).toContain('.cmd');
    } else {
      expect(error.message).not.toContain('.cmd');
    }
  });

  it('正常启动路径不受影响：收到 initialize 响应即就绪（不改既有协议行为）', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);
    const client = new DshRpcClient({
      dshBin: '/fake/dsh',
      logger: silentLogger,
      initializeTimeoutMs: 5_000,
    });

    const started = client.start({ cwd: '/tmp', provider: 'p', model: 'm' });
    await new Promise((resolve) => setImmediate(resolve));
    // 先收到 initialize 的写入，再回一帧响应（帧格式与协议一致：id=1）
    expect(child.stdin.readableLength).toBeGreaterThan(0);
    child.stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`);

    await expect(started).resolves.toBeUndefined();
    expect(client.isRunning).toBe(true);

    // 收尾：exitCode 置 0 → close() 不再走 kill 阶梯（不影响断言，避免测试等待 1s+）
    child.exitCode = 0;
    await client.close();
  });
});
