/**
 * T4c 重启协调器：无活跃会话才重启 + 有活跃会话则挂起等归零。
 *
 * 单 serve 实例（Metis 必改点 2：无 TaskGroupRegistry），任务组隔离重启无法兑现，
 * 故重启前必须确认无活跃会话——否则重启会中断进行中的 Agent 会话。
 *
 * 用法（index.ts）：
 *   1. onCommands reload-config 回调：注入落盘后调用 coordinator.requestRestart()
 *   2. 会话归零通知：instance-tracker.onActiveSessionsIdle(() => coordinator.checkPending())
 *
 * worker 独立进程铁律：restart/reRegister 由调用方注入（依赖倒置），本模块不 import server 代码。
 */

/** 最小日志接口（对齐 OpencodeServer.Logger，duck typing）。 */
export interface RestartLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RestartCoordinatorOptions {
  /** 活跃会话数（index.ts 注入 getLoad().instances；默认恒 0） */
  activeSessionCount?: () => number;
  /** 实际重启（OpencodeServer.restart()，stop+start 组合） */
  restart: () => Promise<string>;
  /** 重启后重新注册（registerWorkerWithRetry，更新 capabilities.baseUrl/port） */
  reRegister?: () => Promise<void>;
  /** 日志输出；默认 console */
  logger?: RestartLogger;
}

/** requestRestart 结果：已执行重启 / 已挂起等会话归零。 */
export type RestartDecision = 'executed' | 'pending';

export class RestartCoordinator {
  private readonly activeSessionCount: () => number;
  private readonly restart: () => Promise<string>;
  private readonly reRegister?: () => Promise<void>;
  private readonly logger: RestartLogger;
  /** 有活跃会话时挂起的重启请求（单次，会话归零后执行一次即清） */
  private pendingRestart = false;
  /** 防并发：performRestart 执行期间跳过新的重启请求 */
  private running = false;

  constructor(options: RestartCoordinatorOptions) {
    this.activeSessionCount = options.activeSessionCount ?? (() => 0);
    this.restart = options.restart;
    this.reRegister = options.reRegister;
    this.logger = options.logger ?? console;
  }

  get isPending(): boolean {
    return this.pendingRestart;
  }

  /**
   * 请求重启：无活跃会话 → 立即执行；有活跃会话 → 标记 pending（返回 'pending'），
   * 会话归零后由 checkPending() 执行。重启失败打日志不抛错（serve 不可用时心跳
   * 上报 degraded，后续 reload-config 可再次触发修复）。
   */
  async requestRestart(reason: string): Promise<RestartDecision> {
    const count = this.activeSessionCount();
    if (count > 0) {
      this.pendingRestart = true;
      this.logger.warn(
        `[restart] ${reason}：${count} 个活跃会话，重启挂起（等会话归零后自动执行）`,
      );
      return 'pending';
    }
    await this.performRestart(reason);
    return 'executed';
  }

  /** 活跃会话归零时调用：若挂起中则执行重启。 */
  checkPending(): void {
    if (this.pendingRestart && this.activeSessionCount() === 0) {
      this.pendingRestart = false;
      this.logger.info('[restart] 活跃会话已归零，执行挂起的重启');
      void this.performRestart('挂起重启（会话归零）');
    }
  }

  private async performRestart(reason: string): Promise<void> {
    if (this.running) {
      this.logger.warn('[restart] 已有重启执行中，跳过本次请求');
      return;
    }
    this.running = true;
    try {
      this.logger.info(`[restart] 执行重启（${reason}）`);
      const baseUrl = await this.restart();
      this.logger.info(`[restart] serve 重启完成: ${baseUrl}`);
      if (this.reRegister) {
        await this.reRegister();
        this.logger.info('[restart] 重新注册完成（capabilities.baseUrl/port 已更新）');
      }
    } catch (err) {
      this.logger.error(`[restart] 重启失败: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
