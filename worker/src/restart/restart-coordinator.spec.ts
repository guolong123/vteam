/**
 * T4c RestartCoordinator 单元测试：
 * - 无活跃会话 → 立即重启 + 重新注册
 * - 有活跃会话 → pending，不执行；会话归零后 checkPending 自动执行
 * - pending 期间新请求不重复执行 / checkPending 无 pending 不动作
 * - restart 失败记录日志不抛错（serve 不可用时心跳上报 degraded，可再触发修复）
 */
import {
  RestartCoordinator,
  RestartDecision,
  RestartLogger,
} from './restart-coordinator';

function makeLogger(): RestartLogger & {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
} {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** flush 微任务队列（void performRestart 内部两次 await）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('RestartCoordinator（T4c：无活跃会话才重启）', () => {
  it('无活跃会话 → 立即重启 + 重新注册', async () => {
    const restart = jest.fn().mockResolvedValue('http://127.0.0.1:53001');
    const reRegister = jest.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator({
      activeSessionCount: () => 0,
      restart,
      reRegister,
    });

    const decision = await coordinator.requestRestart('reload-config');

    expect(decision).toBe('executed');
    expect(restart).toHaveBeenCalledTimes(1);
    expect(reRegister).toHaveBeenCalledTimes(1);
    expect(coordinator.isPending).toBe(false);
  });

  it('有活跃会话 → pending 不重启；会话归零后 checkPending 自动执行', async () => {
    let count = 2;
    const restart = jest.fn().mockResolvedValue('http://127.0.0.1:53002');
    const reRegister = jest.fn().mockResolvedValue(undefined);
    const coordinator = new RestartCoordinator({
      activeSessionCount: () => count,
      restart,
      reRegister,
    });

    const decision: RestartDecision = await coordinator.requestRestart('reload-config');
    expect(decision).toBe('pending');
    expect(coordinator.isPending).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    expect(reRegister).not.toHaveBeenCalled();

    // 会话减少但未归零：不执行
    count = 1;
    coordinator.checkPending();
    expect(restart).not.toHaveBeenCalled();

    // 归零：checkPending 触发执行（一次即清 pending）
    count = 0;
    coordinator.checkPending();
    await flushMicrotasks();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(reRegister).toHaveBeenCalledTimes(1);
    expect(coordinator.isPending).toBe(false);
  });

  it('pending 期间再次请求不重复标记/执行', async () => {
    let count = 1;
    const restart = jest.fn().mockResolvedValue('http://127.0.0.1:53003');
    const coordinator = new RestartCoordinator({
      activeSessionCount: () => count,
      restart,
    });

    await coordinator.requestRestart('reload-config');
    await coordinator.requestRestart('reload-config');
    expect(coordinator.isPending).toBe(true);
    expect(restart).not.toHaveBeenCalled();

    count = 0;
    coordinator.checkPending();
    await flushMicrotasks();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('checkPending 无 pending 时不动作', async () => {
    const restart = jest.fn().mockResolvedValue('http://127.0.0.1:53004');
    const coordinator = new RestartCoordinator({ restart });

    coordinator.checkPending();
    expect(restart).not.toHaveBeenCalled();
  });

  it('restart 失败记录 error 日志，requestRestart 不抛错', async () => {
    const restart = jest.fn().mockRejectedValue(new Error('spawn opencode ENOENT'));
    const logger = makeLogger();
    const coordinator = new RestartCoordinator({ restart, logger });

    await expect(coordinator.requestRestart('reload-config')).resolves.toBe('executed');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('重启失败: spawn opencode ENOENT'));
    expect(coordinator.isPending).toBe(false);
  });

  it('未配置 reRegister 时重启后仅重启不重注册', async () => {
    const restart = jest.fn().mockResolvedValue('http://127.0.0.1:53005');
    const coordinator = new RestartCoordinator({ restart });

    await coordinator.requestRestart('reload-config');
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
