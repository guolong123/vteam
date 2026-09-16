import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 通用定时器基础设施（generic-timer）。
 *
 * 任何功能无需自持时钟即可安排未来触发：`schedule(kind, fireAt, payload,
 * dedupKey)` 落 pending 行；轻量 ticker 到期 claim 后按 kind 分发到注册
 * handler。首个消费者：receipt-timeout auto-nudge（`receipt_nudge` kind，
 * 后续任务由 chat 域 `registerHandler` 接入）；第二个计划消费者：
 * 定时/cron 型任务（`task_trigger` kind，由 tasks 域拥有）。
 *
 * 状态机（String 列 + 本文件常量，双库兼容——不声明 Prisma enum）：
 *   pending → firing → fired（handler 成功）
 *                    → failed（handler 抛错 / 无 handler，大声记 lastError）
 *   pending → cancelled（`cancel` 显式取消；cancelled 行永不触发）
 *
 * 扩展合同（cron/repeat 后续任务）：本版 one-shot `fireAt` 先行；重复触发
 * 后续经新 nullable 列（如 cronExpr / repeatIntervalMs / nextFireAt）+
 * tasks 域拥有的 `task_trigger` kind handler 实现——本表与本服务零改动，
 * 后续任务只需 `registerHandler('task_trigger', …)`。
 */

/** Timer.status 应用层常量（对齐 schema.prisma Timer 模型注释）。 */
export const TIMER_STATUS = {
  PENDING: 'pending',
  FIRING: 'firing',
  FIRED: 'fired',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;

/** Timer 主键域前缀（15 篇 §2.2 主键策略，经共享 IdGeneratorService 生成）。 */
export const TIMER_ID_PREFIX = 'tmr';

/** ticker 间隔 env 键；未设置时默认值（ms）。 */
export const TIMER_SCAN_INTERVAL_MS_DEFAULT = 30_000;

/** dedupKey 格式：`kind:scope:id`（如 `receipt_nudge:team_1:mr_2`），调用方显式传入。 */
export type TimerDedupKey = string;

/** handler 最小签名：plain JSON payload，不透 Prisma 行（WorkerEndpointRef 式能力透传此处不适用）。 */
export interface TimerFireContext {
  id: string;
  kind: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export type TimerHandler = (timer: TimerFireContext) => Promise<void>;

@Injectable()
export class TimerService implements OnModuleDestroy {
  private readonly logger = new Logger(TimerService.name);
  private readonly handlers = new Map<string, TimerHandler>();
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /**
   * 注册 kind→handler（后续消费者任务调此 API，如
   * `registerHandler('receipt_nudge', …)`；测试用 handler 同理）。
   * 同 kind 重复注册以后者覆盖。
   */
  registerHandler(kind: string, fn: TimerHandler): void {
    this.handlers.set(kind, fn);
  }

  /**
   * 幂等排期：同 dedupKey 已有行 → 直接返回既有行（不再 create）；
   * 否则生成 `tmr_` id 落 pending 行，并惰性启动 ticker。
   */
  async schedule(
    kind: string,
    fireAt: Date,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: any,
    dedupKey: TimerDedupKey,
  ) {
    const existing = await this.prisma.timer.findUnique({
      where: { dedupKey },
    });
    if (existing) {
      return existing;
    }
    const id = await this.idGen.nextId(TIMER_ID_PREFIX);
    let created;
    try {
      created = await this.prisma.timer.create({
        data: {
          id,
          kind,
          status: TIMER_STATUS.PENDING,
          fireAt,
          payload,
          dedupKey,
          attempts: 0,
        },
      });
    } catch (err) {
      // 并发竞态：两 schedule 同 dedupKey 同时通过上面的 findUnique 检查，
      // 后落库者撞唯一约束（P2002）→ 回读胜者行返回，仍满足幂等承诺；
      // 回读仍为空（行被并发删除等极端情况）→ 重抛原错，不吞错。
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const winner = await this.prisma.timer.findUnique({
        where: { dedupKey },
      });
      if (!winner) {
        throw err;
      }
      return winner;
    }
    this.ensureTicker();
    return created;
  }

  /**
   * 取消：按 id 优先，id 未命中（P2025）则按 dedupKey 取消；
   * 命中行 status→cancelled（幂等：重复 cancel 仍为 cancelled）。
   */
  async cancel(idOrDedupKey: string) {
    try {
      return await this.prisma.timer.update({
        where: { id: idOrDedupKey },
        data: { status: TIMER_STATUS.CANCELLED },
      });
    } catch (err) {
      if (!isRecordNotFound(err)) {
        throw err;
      }
      return await this.prisma.timer.update({
        where: { dedupKey: idOrDedupKey },
        data: { status: TIMER_STATUS.CANCELLED },
      });
    }
  }

  /**
   * 到期扫描（repo 时钟约定：wall-clock 以参数注入便于测试；
   * ticker 传 `new Date()`，单测传固定值）。
   * 仅取 `status=pending AND fireAt<=now` 行并按 fireAt 升序触发；
   * 单个坏 timer 只记日志，永不阻断本轮其余行；本方法本身不抛错
   * （查询失败记 error 后返回空数组，tick 循环永不 reject）。
   */
  async fireDue(now: Date = new Date()) {
    let due;
    try {
      due = await this.prisma.timer.findMany({
        where: { status: TIMER_STATUS.PENDING, fireAt: { lte: now } },
        orderBy: { fireAt: 'asc' },
      });
    } catch (err) {
      this.logger.error(`timer 到期查询失败: ${describeError(err)}`);
      return [];
    }
    const out = [];
    for (const row of due ?? []) {
      try {
        const done = await this.fireOne(row, now);
        if (done) {
          out.push(done);
        }
      } catch (err) {
        // best-effort + warn：单行失败记日志，循环继续（loud row 优于吞错）。
        this.logger.error(
          `timer ${row.id} 触发失败（已尽力落库，继续本轮）: ${describeError(err)}`,
        );
      }
    }
    return out;
  }

  /**
   * 单行触发：原子 claim（`updateMany where {id, pending, fireAt<=now}
   * set firing`，仅 `count===1` 继续——重叠 tick 双触发安全）；
   * 无 handler → `failed` + lastError（大声暴露缺失消费者，非静默跳过）；
   * handler 成功 → `fired`，抛错 → `failed` + lastError。
   */
  private async fireOne(
    row: { id: string; kind: string; payload: unknown; fireAt: Date },
    now: Date,
  ) {
    const claimed = await this.prisma.timer.updateMany({
      where: {
        id: row.id,
        status: TIMER_STATUS.PENDING,
        fireAt: { lte: now },
      },
      data: { status: TIMER_STATUS.FIRING },
    });
    if (claimed.count !== 1) {
      // claim 失败：重叠 tick 已认领（或行已被 cancel），本轮跳过。
      return null;
    }
    const handler = this.handlers.get(row.kind);
    if (!handler) {
      return await this.prisma.timer.update({
        where: { id: row.id },
        data: {
          status: TIMER_STATUS.FAILED,
          lastError: `no handler for kind ${row.kind}`.slice(0, 191),
          attempts: { increment: 1 },
        },
      });
    }
    try {
      await handler({
        id: row.id,
        kind: row.kind,
        payload: row.payload,
      });
      return await this.prisma.timer.update({
        where: { id: row.id },
        data: { status: TIMER_STATUS.FIRED, attempts: { increment: 1 } },
      });
    } catch (err) {
      return await this.prisma.timer.update({
        where: { id: row.id },
        data: {
          status: TIMER_STATUS.FAILED,
          lastError: describeError(err).slice(0, 191),
          attempts: { increment: 1 },
        },
      });
    }
  }

  /**
   * 惰性 ticker（worker-dispatcher startIdleScan 同款约定）：
   * 首次 `schedule()` 时启动；`TIMER_SCAN_INTERVAL_MS=0` 禁用；
   * `setInterval` + `.unref()`；每 tick 错误捕获记日志。
   */
  private ensureTicker(): void {
    if (this.scanIntervalMs() <= 0) {
      return;
    }
    if (this.scanTimer) {
      return;
    }
    this.scanTimer = setInterval(() => {
      void this.fireDue(new Date()).catch((err: unknown) =>
        this.logger.error(`timer 扫描失败: ${describeError(err)}`),
      );
    }, this.scanIntervalMs());
    this.scanTimer.unref?.();
  }

  private scanIntervalMs(): number {
    const raw = process.env.TIMER_SCAN_INTERVAL_MS;
    if (raw === undefined || raw === '') {
      return TIMER_SCAN_INTERVAL_MS_DEFAULT;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : TIMER_SCAN_INTERVAL_MS_DEFAULT;
  }

  onModuleDestroy() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }
}

/** Prisma P2025（record not found）判定：cancel 的 id→dedupKey 回退依据。 */
function isRecordNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2025'
  );
}

/** Prisma P2002（唯一约束冲突）判定：schedule 并发竞态回读胜者行依据。 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
