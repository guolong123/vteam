/**
 * 会话僵尸态收敛（2026-11-20）
 * =================================
 * 解决的真实故障：**聊天页永久显示「XXX 会话运行中」，实际早已结束**。
 *
 * 根因链：
 * 1. `Session.status` 由 worker 单向回传 `session.updated(idle|failed)` 驱动，
 *    **服务端没有任何兜底**——那一次回传丢了（worker 崩溃/进程被杀/网络中断/
 *    事件未送达），status 就永久停在 `running`；
 * 2. 而「谁在运行」的权威信号恰恰是 `status`：团队直聊（team-mode，无 task）
 *    **不写 `busy_state`**（只有轮次台账路径 session_turns.claimNext 才写），
 *    所以 `busy_state` 恒 idle，前端只能靠 `status === 'running'` 判断「执行中」；
 * 3. 现成的收敛器 `WorkerDispatcher.scanIdleSessions` 由 `AGENT_IDLE_TIMEOUT_MS`
 *    控制，而该 env **缺省 0 = 整个扫描直接 return**（设计如此：当年无真实 hang
 *    证据，怕误杀长脚本）⇒ 线上僵尸会话**永远收不回来**；
 * 4. 前端把僵尸 `running` 一次性 seed 进 `sessionByAgent`（sessionSeedRef 只跑一次），
 *    于是「会话运行中」永久不消失。
 *
 * 线上实证（vteam.ketaops.cc，2026-11-20）：
 * `s_0000000058`（win-worker-01）`status=running` 但 `busy_state=idle`、
 * `last_activity_at` 停在 11-19 03:01，而该席位最后一条 agent 消息时间是
 * 11-19 03:01:31 —— 执行早结束，状态没收。
 *
 * ── 为什么不用「打开 scanIdleSessions」来修 ─────────────────────────
 * 那条路径会把僵尸会话判**死**（status=failed + 发「会话异常终止」公告 +
 * 可能触发自动拉起）。对「已经正常答完、只是回传丢了」的会话来说，这是错误结论：
 * 会平白给群里刷一条异常通知，还会误导主 Agent 复核。
 *
 * 本模块只做**温和收敛**：长时间无任何活动的 `running` → 直接改回 `idle`
 * （等价于补上那条丢失的回传），**不判死、不通知、不拉起**。
 */

/** 判定「僵尸 running」的默认无活动时长：30 分钟。 */
export const DEFAULT_STALE_SESSION_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * 扫描批量上限。
 *
 * 一次最多收敛这么多条：僵尸积累可能很多（线上一次就查到 3 条，历史更多），
 * 但收敛是后台清理，不该让单次事务过大。
 */
export const STALE_SCAN_BATCH_LIMIT = 200;

/** 一条被收敛的会话（供日志/测试断言）。 */
export interface ConvergedSession {
  id: string;
  teamMemberId: string | null;
  /** 判定所依据的最后活动时间（ISO）。 */
  lastActivityAt: string;
}

export interface StaleSessionConvergerOptions {
  /** 会话仓储（只用到 findMany + updateMany，便于测试注入）。 */
  prisma: {
    session: {
      findMany(args: unknown): Promise<
        Array<{
          id: string;
          teamMemberId: string | null;
          lastActivityAt: Date | null;
          updatedAt: Date;
        }>
      >;
      updateMany(args: unknown): Promise<{ count: number }>;
    };
  };
  /** 无活动阈值（ms），缺省 {@link DEFAULT_STALE_SESSION_THRESHOLD_MS}。 */
  thresholdMs?: number;
  logger?: { log(message: string): void; warn(message: string): void };
  now?: () => number;
}

/**
 * 把「长时间无活动的 running 会话」收敛回 idle。
 *
 * 判定口径（保守，宁可少收不可错收）：
 * - 只看 `status === 'running'`；
 * - 活动时间取 `last_activity_at`，为 NULL 时回退 `updatedAt`（与
 *   `scanIdleSessions` 同一口径，避免新建会话因 NULL 永久逃逸）；
 * - 超阈值才收敛；
 * - **不碰** `busy_state === 'running'` 的会话（那说明轮次台账正在跑，
 *   是真在执行的强信号，交给 `scanIdleSessions` 判死，本模块不越权）。
 */
export class StaleSessionConverger {
  private readonly prisma: StaleSessionConvergerOptions['prisma'];
  private readonly thresholdMs: number;
  private readonly logger: NonNullable<StaleSessionConvergerOptions['logger']>;
  private readonly now: () => number;

  constructor(options: StaleSessionConvergerOptions) {
    this.prisma = options.prisma;
    this.thresholdMs = Math.max(
      1,
      options.thresholdMs ?? DEFAULT_STALE_SESSION_THRESHOLD_MS,
    );
    this.logger = options.logger ?? {
      log: () => undefined,
      warn: () => undefined,
    };
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 扫描并收敛一轮，返回被收敛的会话。
   *
   * 不抛错：这是后台清理，失败只 warn（下次再收），绝不能因为清理失败影响主流程。
   */
  async converge(): Promise<ConvergedSession[]> {
    const cutoff = new Date(this.now() - this.thresholdMs);
    let rows: Array<{
      id: string;
      teamMemberId: string | null;
      lastActivityAt: Date | null;
      updatedAt: Date;
    }>;
    try {
      rows = await this.prisma.session.findMany({
        where: {
          status: 'running',
          // 真在跑（轮次台账）的会话不归本模块管——那是 scanIdleSessions 的职责，
          // 且它会判死+通知，语义更重，不能被这里"温和改 idle"抢先抹掉。
          busyState: { not: 'running' },
          OR: [
            { lastActivityAt: { lt: cutoff } },
            { lastActivityAt: null, updatedAt: { lt: cutoff } },
          ],
        },
        select: {
          id: true,
          teamMemberId: true,
          lastActivityAt: true,
          updatedAt: true,
        },
        take: STALE_SCAN_BATCH_LIMIT,
      });
    } catch (err) {
      this.logger.warn(
        `[stale-session] 扫描失败（下次重试）: ${(err as Error).message}`,
      );
      return [];
    }
    if (rows.length === 0) return [];

    const converged: ConvergedSession[] = [];
    for (const row of rows) {
      try {
        // 条件更新：把 status 从 running 改 idle，其余字段一律不动
        // （尤其不写 busy_since / last_turn_outcome：那不是我们的事实）。
        // where 里再带一次 status='running' 做 CAS，避免与并发的真实回传打架。
        const res = await this.prisma.session.updateMany({
          where: { id: row.id, status: 'running' },
          data: { status: 'idle' },
        });
        if (res.count > 0) {
          converged.push({
            id: row.id,
            teamMemberId: row.teamMemberId,
            lastActivityAt: (row.lastActivityAt ?? row.updatedAt).toISOString(),
          });
        }
      } catch (err) {
        this.logger.warn(
          `[stale-session] 收敛 ${row.id} 失败（跳过）: ${(err as Error).message}`,
        );
      }
    }

    if (converged.length > 0) {
      const minutes = Math.round(this.thresholdMs / 60000);
      this.logger.log(
        `[stale-session] 收敛 ${converged.length} 条僵尸 running 会话 → idle（无活动超过 ${minutes}min）：` +
          converged.map((c) => `${c.id}@${c.lastActivityAt}`).join(', '),
      );
    }
    return converged;
  }
}
