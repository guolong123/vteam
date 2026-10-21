/**
 * 重启协调器：**只用于真正需要换进程的场景**（运维重启 / 二进制升级 / 崩溃恢复 /
 * 热重载兜底）。
 *
 * ⚠️ **配置类变更不走这里**（opencode v2 原生支持热重载，无需重启 serve）：
 * skills / tools / MCP servers / agent 策略 / 模型凭据的变更一律走
 * `reload/config-reloader.ts`（`POST /api/location/reload` + 文件监听）——
 * 重启的代价有三条：① 随机端口场景端口漂移 ⇒ 必须重新注册
 * `capabilities.baseUrl/port`（失败 = 静默断线）；② 有活跃会话时必须**等会话排空**
 * （无上界延迟）；③ 重启窗口内 serve 不可用。
 *
 * 这里的「挂起等会话归零」语义**只对真重启有意义**：热重载不需要等（它不动进程，
 * 且有待答复项时会自动退让到文件监听路径——见 config-reloader.ts 的 pending 闸门）。
 *
 * 用法（index.ts）：
 *   1. 运维 `RESTART` 命令 / `/config/restart` 端点：coordinator.requestRestart()
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
   * 请求**真重启**：无活跃会话 → 立即执行；有活跃会话 → 标记 pending（返回 'pending'），
   * 会话归零后由 checkPending() 执行。重启失败打日志不抛错（serve 不可用时心跳
   * 上报 degraded，后续可再次触发修复）。
   *
   * ⚠️ **配置类变更不要用这里**——用 `reload/config-reloader.ts` 的热重载路径
   * （不重启进程 ⇒ 无端口漂移、无会话排空、无不可用窗口）。
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
