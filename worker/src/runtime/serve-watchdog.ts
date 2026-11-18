/**
 * serve 健康看门狗（2026-11-18）
 * =================================
 * 解决的真实故障：**worker 心跳正常、平台显示在线，但发消息 502**。
 *
 * 根因链：
 * 1. `serveServer.isRunning` 只看 `process.exitCode === null`——serve 进程**僵死**
 *    （端口不再监听 / 内部崩溃但进程未退出）时它仍返回 true；
 * 2. 心跳的 `health` 直接用 `isRunning ? 'ok' : 'degraded'` ⇒ 报 ok ⇒ 平台照常派单；
 * 3. 平台把任务派下来 → `POST /api/session` 打不通 → 用户看到 502；
 * 4. MCP 探针同时报 `fetch failed`，但探针失败**只保留上次结果**、不触发任何修复；
 * 5. 没有任何机制会重启僵死的 serve ⇒ **故障永久持续**，只能人工重启 worker。
 *
 * 本模块补上闭环：定期探测 serve 的 HTTP 可用性；连续失败达阈值 → 重启 serve
 * （重启后端口/密码可能变化，交给调用方的 reRegister 收敛），并把真实健康态上报。
 *
 * 设计取舍：
 * - **连续失败才重启**：单次抖动（GC/瞬时拥塞）不该重启 serve（会打断活跃会话）；
 * - **有活跃会话时不重启**：交给 RestartCoordinator 排队，会话归零后执行
 *   （重启会杀掉在跑的 agent，比 502 更糟）；
 * - 探测失败期间 `health` 立即报 `degraded`（平台停止派单），避免继续放大 502。
 */

/** 一次探测的结局。 */
export type ServeProbeOutcome = 'ok' | 'unreachable';

/** 看门狗判定结果（供日志与测试断言）。 */
export type ServeWatchdogDecision =
  /** 探测成功：正常 */
  | 'healthy'
  /** 探测失败但未达阈值：只降级、不重启 */
  | 'degraded'
  /** 探测连续失败达阈值，已请求重启（无活跃会话 ⇒ 已执行） */
  | 'restarting'
  /** 探测连续失败达阈值，但存在活跃会话 ⇒ 重启挂起 */
  | 'restart-pending';

export interface ServeWatchdogLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * 默认阈值：3 次。
 *
 * 心跳 10s 一轮 ⇒ 连续 3 次失败 ≈ 30s 内确认故障。再短会把瞬时抖动当故障
 * （重启 serve 会打断在跑的会话，代价高）；再长则用户已经连吃好几个 502。
 */
export const DEFAULT_SERVE_FAILURE_THRESHOLD = 3;

export interface ServeWatchdogOptions {
  /**
   * 探测 serve 是否真的可用（HTTP 级，不是"进程还在不在"）。
   * 抛错或返回 'unreachable' 都算失败。
   */
  probe: () => Promise<ServeProbeOutcome>;
  /** 请求重启（内部应走 RestartCoordinator，尊重活跃会话）。 */
  requestRestart: (reason: string) => Promise<'executed' | 'pending'>;
  /** 连续失败阈值（缺省 {@link DEFAULT_SERVE_FAILURE_THRESHOLD}）。 */
  threshold?: number;
  logger?: ServeWatchdogLogger;
}

/**
 * serve 可用性看门狗。
 *
 * 每轮心跳前调用 {@link check}：返回的 decision 决定 `health` 怎么上报
 * （非 healthy 一律 degraded ⇒ 平台停止派单，用户不会再撞 502）。
 */
export class ServeWatchdog {
  private readonly probe: () => Promise<ServeProbeOutcome>;
  private readonly requestRestart: (
    reason: string,
  ) => Promise<'executed' | 'pending'>;
  private readonly threshold: number;
  private readonly logger: ServeWatchdogLogger;

  /** 连续失败次数（成功即清零）。 */
  private consecutiveFailures = 0;
  /** 本轮是否已触发过重启（避免每轮都打 restart，也避免日志刷屏）。 */
  private restartRequested = false;

  constructor(options: ServeWatchdogOptions) {
    this.probe = options.probe;
    this.requestRestart = options.requestRestart;
    this.threshold = Math.max(
      1,
      options.threshold ?? DEFAULT_SERVE_FAILURE_THRESHOLD,
    );
    this.logger = options.logger ?? console;
  }

  /** 当前连续失败次数（测试/诊断用）。 */
  get failures(): number {
    return this.consecutiveFailures;
  }

  /** serve 当前是否被判定为不健康（供 heartbeat 决定 health）。 */
  get isUnhealthy(): boolean {
    return this.consecutiveFailures > 0;
  }

  /**
   * 探一次并给出决策。
   *
   * 不抛错（探测自身异常也算失败）：看门狗必须能在任意环境下跑完，
   * 否则心跳会被它拖垮 —— 那是"修复故障的代码造成更大故障"。
   */
  async check(): Promise<ServeWatchdogDecision> {
    let outcome: ServeProbeOutcome = 'unreachable';
    try {
      outcome = await this.probe();
    } catch {
      outcome = 'unreachable';
    }

    if (outcome === 'ok') {
      const recovered = this.consecutiveFailures > 0;
      this.consecutiveFailures = 0;
      if (recovered) {
        this.restartRequested = false;
        this.logger.info(
          '[serve-watchdog] serve 已恢复可用（此前的探测失败计数已清零）',
        );
      }
      return 'healthy';
    }

    this.consecutiveFailures += 1;
    // 未达阈值：只降级不重启（瞬时抖动不该打断活跃会话）
    if (this.consecutiveFailures < this.threshold) {
      this.logger.warn(
        `[serve-watchdog] serve 探测失败（连续 ${this.consecutiveFailures}/${this.threshold} 次）` +
          '——health 上报 degraded，平台暂停派单',
      );
      return 'degraded';
    }

    // 达阈值：请求重启（只在首次触发，之后保持同一轮故障内不重复刷）
    if (!this.restartRequested) {
      this.restartRequested = true;
      this.logger.warn(
        `[serve-watchdog] serve 连续 ${this.consecutiveFailures} 次不可用，判定僵死 → 请求重启 serve`,
      );
      try {
        const decision = await this.requestRestart(
          `serve 连续 ${this.consecutiveFailures} 次探测失败（心跳正常但 HTTP 不可达）`,
        );
        if (decision === 'pending') {
          this.logger.warn(
            '[serve-watchdog] 存在活跃会话，serve 重启已挂起（会话归零后自动执行）',
          );
          return 'restart-pending';
        }
        this.logger.info(
          '[serve-watchdog] serve 重启已执行，等待下一轮探测确认恢复',
        );
        return 'restarting';
      } catch (err) {
        // 重启失败不抛：保持 degraded，下一轮继续探测/重试
        this.logger.warn(
          `[serve-watchdog] serve 重启失败（将下一轮重试）: ${(err as Error).message}`,
        );
        this.restartRequested = false;
        return 'degraded';
      }
    }
    // 本轮故障已请求过重启，仍在失败 → 保持 degraded，等待恢复
    return 'degraded';
  }
}
