import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { IdGeneratorService } from '../common/id-generator';
import {
  TRIGGER_KIND,
  isTriggerKind,
  type TriggerKind,
} from '../common/constants/trigger.constants';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 通用触发器基础设施（generic-trigger，前身 generic-timer）。
 *
 * 任何功能无需自持时钟即可安排未来触发：`schedule(kind, dueAt, payload,
 * dedupKey, opts?)` 落 pending 行；轻量 ticker 到期 claim 后按 kind 分发到
 * 注册 handler。消费者：receipt-timeout auto-nudge（`receipt_nudge` kind，
 * chat 域 `registerHandler` 接入）；评审轮次超时（`review_round_timeout`）。
 *
 * 三形态（trigger-unification todo-2）：
 * - one-shot：`dueAt` 到期触发一次（`fireAt` 双写保留，后续清理任务再 drop）；
 * - interval：`opts.intervalMs` 周期重排，`nextFireAt = now + intervalMs + jitter`
 *   按 now 重算（不追补 missed 周期；overdue 重排钳制到 `now + jitter(0..30s)`）；
 * - condition：`opts.guardKey` 仅接受已注册谓词（`registerGuard` 白名单，
 *   非任意字符串；谓词 false → 记 `skipReason` 留 pending 待下轮复核）。
 *
 * 状态机（String 列 + 本文件常量，双库兼容——不声明 Prisma enum）：
 *   pending → firing → fired（handler 成功；interval 未达上限则回 pending 重排）
 *                    → failed（handler 抛错 / 无 handler / 无 guard，大声记 lastError）
 *                    → cancelled（`cancel` 显式取消 / handler 返回 expire /
 *                       基座强制 maxFires|expiresAt；cancelled 行永不触发）
 *   pending → cancelled（`cancel` 显式取消）
 *
 * 基座强制（handler 不可绕过）：`maxFires`（`fireCount >= maxFires` 熄火）、
 * `expiresAt`（`now >= expiresAt` 熄火）均在 claim 前判定，直接落 cancelled。
 */

/** Trigger.status 应用层常量（对齐 schema.prisma Trigger 模型注释）。 */
export const TRIGGER_STATUS = {
  PENDING: 'pending',
  FIRING: 'firing',
  FIRED: 'fired',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const;

/** Trigger 主键域前缀（冻结 tmr_，不引入 trg_，经共享 IdGeneratorService 生成）。 */
export const TRIGGER_ID_PREFIX = 'tmr';

/** ticker 间隔 env 键；未设置时默认值（ms）。 */
export const TRIGGER_SCAN_INTERVAL_MS_DEFAULT = 30_000;

/** 单轮 claim 上限（DB 侧 ORDER BY dueAt LIMIT 100，防大 backlog 爆内存）。 */
export const TRIGGER_FIRE_BATCH_LIMIT = 100;

/** overdue 重排抖动窗（ms）：钳制到 now + [0, 30s)，不追补 missed 周期。 */
export const TRIGGER_RESCHEDULE_JITTER_MS = 30_000;

/** dedupKey 格式：`kind:scope:id`（如 `receipt_nudge:team_1:mr_2`），调用方显式传入。 */
export type TriggerDedupKey = string;

/** handler 最小签名：plain JSON payload，不透 Prisma 行。 */
export interface TriggerFireContext {
  id: string;
  kind: string;
  // dueAt/fireCount 可选：todo-5/6 前的旧消费者仍以 { id, kind, payload }
  // 字面量直调 handle（见 receipt-nudge/review-round-timeout spec），
  // 基座 fireDue 永远填充两者；消费者迁移时再收紧为必填。
  dueAt?: Date | null;
  fireCount?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export type TriggerOutcome =
  | { done: true }
  | { rescheduleAt: Date }
  | { expire: true };

export type TriggerHandler = (
  trigger: TriggerFireContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<void | TriggerOutcome>;

/** condition 谓词：true=放行触发，false=记 skipReason 留待下轮。 */
export type TriggerGuard = (
  trigger: TriggerFireContext,
) => boolean | Promise<boolean>;

/** schedule 可选项（三形态扩展；全可选，老四参调用逐字节兼容）。 */
export interface TriggerScheduleOptions {
  intervalMs?: number;
  maxFires?: number;
  expiresAt?: Date;
  scopeType?: string;
  scopeId?: string;
  ownerInstanceId?: string;
  guardKey?: string;
}

interface TriggerRow {
  id: string;
  kind: string;
  status: string;
  fireAt: Date;
  dueAt: Date | null;
  intervalMs: number | null;
  nextFireAt: Date | null;
  guardKey: string | null;
  fireCount: number;
  maxFires: number | null;
  expiresAt: Date | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

/**
 * DB 原生行（`selectDueDbNow` 的 `$queryRawUnsafe` 投影形状）：
 * 日期列按驱动返回的 `Date|string` 归一，整数列按 `number` 归一。
 */
interface DbTriggerRow {
  id: string;
  kind: string;
  status: string;
  fireAt: Date | string;
  dueAt: Date | string | null;
  intervalMs: number | null;
  nextFireAt: Date | string | null;
  guardKey: string | null;
  fireCount: number;
  maxFires: number | null;
  expiresAt: Date | string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

/** DB 原生行 → `TriggerRow`（日期/整数归一，`payload` 原样透传）。 */
function mapDbTriggerRow(r: DbTriggerRow): TriggerRow {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    fireAt: toDate(r.fireAt),
    dueAt: r.dueAt === null || r.dueAt === undefined ? null : toDate(r.dueAt),
    intervalMs:
      r.intervalMs === null || r.intervalMs === undefined
        ? null
        : Number(r.intervalMs),
    nextFireAt:
      r.nextFireAt === null || r.nextFireAt === undefined
        ? null
        : toDate(r.nextFireAt),
    guardKey: r.guardKey ?? null,
    fireCount: Number(r.fireCount),
    maxFires:
      r.maxFires === null || r.maxFires === undefined
        ? null
        : Number(r.maxFires),
    expiresAt:
      r.expiresAt === null || r.expiresAt === undefined
        ? null
        : toDate(r.expiresAt),
    payload: r.payload,
  };
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

@Injectable()
export class TriggerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggerService.name);
  private readonly handlers = new Map<string, TriggerHandler>();
  private readonly guards = new Map<string, TriggerGuard>();
  private scanTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /**
   * 进程启动：按库内 tmr_ 前缀纯数字序号最大值对齐 id 生成器，并**立即启动**
   * 扫描 ticker（不再等首个 schedule）。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.trigger, TRIGGER_ID_PREFIX, this.idGen);
    this.ensureTicker();
  }

  /**
   * 注册 kind→handler。同 kind 重复注册以后者覆盖。
   * kind 名义白名单见 TRIGGER_KIND；此处不强制（运行期未知 kind 在
   * fireOne 落 failed 大声暴露，见 stale/缺失消费者约定）。
   */
  registerHandler(kind: string, fn: TriggerHandler): void {
    this.handlers.set(kind, fn);
  }

  /** 注册 condition 谓词（guardKey 白名单唯一入口；非任意字符串）。 */
  registerGuard(key: string, fn: TriggerGuard): void {
    this.guards.set(key, fn);
  }

  /**
   * 幂等排期：同 dedupKey 已有行 → 直接返回既有行（不再 create）；
   * 否则生成 `tmr_` id 落 pending 行（`fireAt` + `dueAt` 双写，迁移窗口
   * 读路径 `due_at IS NOT NULL` 可见），并兜底确保 ticker 在跑。
   *
   * kind 白名单强制：未知 kind 直接抛错（loud，禁止静默落库后 feature-detect）；
   * guardKey 未注册同样直接抛错。
   */
  async schedule(
    kind: string,
    dueAt: Date,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: any,
    dedupKey: TriggerDedupKey,
    opts?: TriggerScheduleOptions,
  ) {
    if (!isTriggerKind(kind)) {
      throw new Error(
        `unknown trigger kind ${kind} (not in TRIGGER_KIND whitelist: ${Object.values(TRIGGER_KIND).join(',')})`,
      );
    }
    const guardKey = opts?.guardKey ?? null;
    if (guardKey !== null && !this.guards.has(guardKey)) {
      throw new Error(`unknown guard key ${guardKey} (registerGuard first)`);
    }
    const existing = await this.prisma.trigger.findUnique({
      where: { dedupKey },
    });
    if (existing) {
      return existing;
    }
    const id = await this.idGen.nextId(TRIGGER_ID_PREFIX);
    let created;
    try {
      created = await this.prisma.trigger.create({
        data: {
          id,
          kind: kind as TriggerKind as string,
          status: TRIGGER_STATUS.PENDING,
          fireAt: dueAt,
          dueAt,
          payload,
          dedupKey,
          attempts: 0,
          fireCount: 0,
          intervalMs: opts?.intervalMs ?? null,
          nextFireAt: opts?.intervalMs !== undefined ? dueAt : null,
          maxFires: opts?.maxFires ?? null,
          expiresAt: opts?.expiresAt ?? null,
          scopeType: opts?.scopeType ?? null,
          scopeId: opts?.scopeId ?? null,
          ownerInstanceId: opts?.ownerInstanceId ?? null,
          guardKey,
        },
      });
    } catch (err) {
      // 并发竞态：两 schedule 同 dedupKey 同时通过上面的 findUnique 检查，
      // 后落库者撞唯一约束（P2002）→ 回读胜者行返回，仍满足幂等承诺；
      // 回读仍为空（行被并发删除等极端情况）→ 重抛原错，不吞错。
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const winner = await this.prisma.trigger.findUnique({
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
      return await this.prisma.trigger.update({
        where: { id: idOrDedupKey },
        data: { status: TRIGGER_STATUS.CANCELLED },
      });
    } catch (err) {
      if (!isRecordNotFound(err)) {
        throw err;
      }
      return await this.prisma.trigger.update({
        where: { dedupKey: idOrDedupKey },
        data: { status: TRIGGER_STATUS.CANCELLED },
      });
    }
  }

  /**
   * 到期扫描入口（D12-1：plan decision 12 要求到期比较用 DB `NOW()`）。
   *
   * 双路径设计（刻意保留测试缝，而非删掉可注入时钟）：
   * - 生产路径（无参调用；ticker 唯一入口）：select 与原子 claim 均以
   *   `due_at <= NOW(3)` 在 DB 侧求值；`maxFires`/`expiresAt`/钳制/interval
   *   重算所用的 `now` 取自同一 `SELECT NOW(3)`——应用/DB 时钟漂移不再影响
   *   触发时点（decision 12），且 `ORDER BY due_at LIMIT 100` + jitter 的
   *   惊群防护保持不变。
   * - 测试缝（显式传 `now`）：沿用 Prisma `dueAt <= now` 比较。计划
   *   Verification strategy 要求"用固定时钟单测锁死"迁移等价性，mock 层
   *   没有 `$queryRaw*` 时也不会误入 DB 路径；全部既有固定时钟用例逐毫秒
   *   可 pin 的语义不变。
   * 两条路径共享 `fireOne` 下游语义；原子 claim 保证等价：DB 路径判定 raw
   * `UPDATE` 影响行数 `=== 1`，等价于 `updateMany` 的 `count === 1`（重叠
   * tick 双触发安全不回归）；NULL 安全等价：两处 WHERE 均带
   * `due_at IS NOT NULL`（decision 15），NULL 行永不入选。
   */
  async fireDue(now?: Date) {
    if (now !== undefined) {
      return this.fireDueAt(now);
    }
    let dbNow: Date;
    try {
      dbNow = await this.fetchDbNow();
    } catch (err) {
      this.logger.error(`trigger DB 时钟读取失败: ${describeError(err)}`);
      return [];
    }
    let due: TriggerRow[];
    try {
      due = await this.selectDueDbNow();
    } catch (err) {
      this.logger.error(`trigger 到期查询失败: ${describeError(err)}`);
      return [];
    }
    const out = [];
    for (const row of due ?? []) {
      try {
        const done = await this.fireOne(row, dbNow, true);
        if (done) {
          out.push(done);
        }
      } catch (err) {
        // best-effort + warn：单行失败记日志，循环继续（loud row 优于吞错）。
        this.logger.error(
          `trigger ${row.id} 触发失败（已尽力落库，继续本轮）: ${describeError(err)}`,
        );
      }
    }
    return out;
  }

  /**
   * DB 时钟（`SELECT NOW(3)`，ms 精度）：生产路径 `fireDue()` 的 `now` 来源。
   * 下游比较（claim 除外，claim 直接用 `NOW(3)` 表达式）统一用此时钟，
   * 使"interval 逾期后 nextFireAt 从 now 重算"重算的是 DB 时间。
   */
  private async fetchDbNow(): Promise<Date> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ now: Date }>>(
      'SELECT NOW(3) AS `now`',
    );
    const raw = rows?.[0]?.now;
    return raw instanceof Date ? raw : new Date(raw);
  }

  /**
   * 生产路径到期 select：`status=pending AND due_at IS NOT NULL AND
   * due_at <= NOW(3)`，`ORDER BY due_at ASC LIMIT 100`。
   * 列按 `TriggerRow` 驼峰别名投影（含 `fireAt` 回退与 `payload` 透传）。
   */
  private async selectDueDbNow(): Promise<TriggerRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<DbTriggerRow>>(
      'SELECT `id`, `kind`, `status`, `fire_at` AS `fireAt`, `due_at` AS `dueAt`,' +
        ' `interval_ms` AS `intervalMs`, `next_fire_at` AS `nextFireAt`,' +
        ' `guard_key` AS `guardKey`, `fire_count` AS `fireCount`,' +
        ' `max_fires` AS `maxFires`, `expires_at` AS `expiresAt`, `payload`' +
        ' FROM `triggers`' +
        " WHERE `status` = 'pending' AND `due_at` IS NOT NULL AND `due_at` <= NOW(3)" +
        ' ORDER BY `due_at` ASC LIMIT 100',
    );
    return (rows ?? []).map(mapDbTriggerRow);
  }

  /**
   * 生产路径原子 claim：`UPDATE … WHERE id=? AND pending AND
   * due_at IS NOT NULL AND due_at <= NOW(3)`，返回影响行数。
   * 调用方仅 `=== 1` 时继续——与 app 时钟路径的 `updateMany.count === 1`
   * 同一重叠-tick 互斥语义。`id` 走 `?` 占位绑定，不拼串。
   */
  private async claimRowDbNow(id: string): Promise<number> {
    const n = await this.prisma.$executeRawUnsafe(
      'UPDATE `triggers` SET `status` = \'firing\'' +
        ' WHERE `id` = ? AND `status` = \'pending\'' +
        ' AND `due_at` IS NOT NULL AND `due_at` <= NOW(3)',
      id,
    );
    return typeof n === 'number' ? n : Number(n);
  }

  /**
   * 测试缝：固定时钟到期扫描（repo 时钟约定：wall-clock 以参数注入便于测试；
   * ticker 不再走这里，单测传固定值）。
   *
   * 口径（Oracle 安全项）：`status=pending AND due_at IS NOT NULL AND
   * due_at<=now`——裸 `due_at<=now` 在 MySQL 下静默跳过 NULL 行导致丢触发，
   * 故 IS NOT NULL 必须显式写出；`ORDER BY dueAt LIMIT 100`。
   * 单个坏行只记日志，永不阻断本轮其余行；本方法本身不抛错
   * （查询失败记 error 后返回空数组，tick 循环永不 reject）。
   */
  async fireDueAt(now: Date) {
    let due;
    try {
      due = await this.prisma.trigger.findMany({
        where: {
          status: TRIGGER_STATUS.PENDING,
          dueAt: { not: null, lte: now },
        },
        orderBy: { dueAt: 'asc' },
        take: TRIGGER_FIRE_BATCH_LIMIT,
      });
    } catch (err) {
      this.logger.error(`trigger 到期查询失败: ${describeError(err)}`);
      return [];
    }
    const out = [];
    for (const row of (due ?? []) as TriggerRow[]) {
      try {
        const done = await this.fireOne(row, now);
        if (done) {
          out.push(done);
        }
      } catch (err) {
        // best-effort + warn：单行失败记日志，循环继续（loud row 优于吞错）。
        this.logger.error(
          `trigger ${row.id} 触发失败（已尽力落库，继续本轮）: ${describeError(err)}`,
        );
      }
    }
    return out;
  }

  /**
   * 单行触发：
   * 1. 基座强制（handler 不可绕过）：`fireCount>=maxFires` / `now>=expiresAt`
   *    → 直接 cancelled + lastError（claim 前判定）；
   * 2. 原子 claim（app 时钟路径：`updateMany where {id, pending, dueAt<=now}
   *    set firing`；DB 时钟路径：`UPDATE … due_at <= NOW(3)`），仅
   *    `count===1`（影响行数 `=== 1`）继续——重叠 tick 双触发安全；
   *    claim 失败记 busyRetries）；
   * 3. guard 谓词：未注册 → failed（loud）；false → skipReason 留 pending 待下轮；
   * 4. 无 handler → `failed` + lastError（大声暴露缺失消费者，非静默跳过）；
   * 5. handler 成功/one-shot done → `fired`；`{expire:true}` → cancelled；
   *    `{rescheduleAt}` → overdue 钳制到 now+jitter 后回 pending；
   *    interval 行 done → `nextFireAt = now + intervalMs + jitter` 回 pending；
   *    handler 抛错 → `failed` + lastError。
   *
   * `now` 的来源决定时钟域：测试缝传注入时钟，生产路径传 `fetchDbNow()` 的
   * DB 时钟；claim 表达式本身在 `useDbClock` 时直接用 `NOW(3)`。
   */
  private async fireOne(row: TriggerRow, now: Date, useDbClock = false) {
    const effectiveDue = row.dueAt ?? row.fireAt ?? null;
    if (
      row.maxFires !== null &&
      row.maxFires !== undefined &&
      row.fireCount >= row.maxFires
    ) {
      return await this.prisma.trigger.update({
        where: { id: row.id },
        data: {
          status: TRIGGER_STATUS.CANCELLED,
          lastError: `maxFires reached (${row.fireCount}/${row.maxFires})`.slice(
            0,
            191,
          ),
        },
      });
    }
    if (row.expiresAt !== null && row.expiresAt !== undefined && now >= row.expiresAt) {
      return await this.prisma.trigger.update({
        where: { id: row.id },
        data: {
          status: TRIGGER_STATUS.CANCELLED,
          lastError: 'expired'.slice(0, 191),
        },
      });
    }
    const claimedCount = useDbClock
      ? await this.claimRowDbNow(row.id)
      : (
          await this.prisma.trigger.updateMany({
            where: {
              id: row.id,
              status: TRIGGER_STATUS.PENDING,
              dueAt: { not: null, lte: now },
            },
            data: { status: TRIGGER_STATUS.FIRING },
          })
        ).count;
    if (claimedCount !== 1) {
      // claim 失败：重叠 tick 已认领（或行已被 cancel），记 busy 后本轮跳过。
      void this.prisma.trigger
        .updateMany({
          where: { id: row.id },
          data: { busyRetries: { increment: 1 } },
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `trigger ${row.id} busy 计数失败（忽略）: ${describeError(err)}`,
          ),
        );
      return null;
    }
    const ctx: TriggerFireContext = {
      id: row.id,
      kind: row.kind,
      dueAt: effectiveDue,
      fireCount: row.fireCount,
      payload: row.payload,
    };
    if (row.guardKey !== null && row.guardKey !== undefined) {
      const guard = this.guards.get(row.guardKey);
      if (!guard) {
        return await this.prisma.trigger.update({
          where: { id: row.id },
          data: {
            status: TRIGGER_STATUS.FAILED,
            lastError: `no guard for key ${row.guardKey}`.slice(0, 191),
            attempts: { increment: 1 },
          },
        });
      }
      let pass: boolean;
      try {
        pass = await guard(ctx);
      } catch (err) {
        return await this.prisma.trigger.update({
          where: { id: row.id },
          data: {
            status: TRIGGER_STATUS.FAILED,
            lastError: describeError(err).slice(0, 191),
            attempts: { increment: 1 },
          },
        });
      }
      if (!pass) {
        return await this.prisma.trigger.update({
          where: { id: row.id },
          data: {
            status: TRIGGER_STATUS.PENDING,
            skipReason: `guard ${row.guardKey} not satisfied`.slice(0, 191),
          },
        });
      }
    }
    const handler = this.handlers.get(row.kind);
    if (!handler) {
      return await this.prisma.trigger.update({
        where: { id: row.id },
        data: {
          status: TRIGGER_STATUS.FAILED,
          lastError: `no handler for kind ${row.kind}`.slice(0, 191),
          attempts: { increment: 1 },
        },
      });
    }
    let outcome: void | TriggerOutcome;
    try {
      outcome = await handler(ctx);
    } catch (err) {
      return await this.prisma.trigger.update({
        where: { id: row.id },
        data: {
          status: TRIGGER_STATUS.FAILED,
          lastError: describeError(err).slice(0, 191),
          attempts: { increment: 1 },
        },
      });
    }
    if (isExpireOutcome(outcome)) {
      return await this.prisma.trigger.update({
        where: { id: row.id },
        data: {
          status: TRIGGER_STATUS.CANCELLED,
          lastError: 'expired by handler'.slice(0, 191),
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
        },
      });
    }
    if (isRescheduleOutcome(outcome)) {
      const next = clampOverdue(outcome.rescheduleAt, now);
      return await this.prisma.trigger.update({
        where: { id: row.id },
        data: {
          status: TRIGGER_STATUS.PENDING,
          fireAt: next,
          dueAt: next,
          nextFireAt: next,
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
          skipReason: null,
        },
      });
    }
    if (row.intervalMs !== null && row.intervalMs !== undefined) {
      const next = new Date(now.getTime() + row.intervalMs + jitterMs());
      const hitsMax =
        row.maxFires !== null &&
        row.maxFires !== undefined &&
        row.fireCount + 1 >= row.maxFires;
      const hitsExpiry =
        row.expiresAt !== null &&
        row.expiresAt !== undefined &&
        next >= row.expiresAt;
      if (hitsMax || hitsExpiry) {
        return await this.prisma.trigger.update({
          where: { id: row.id },
          data: {
            status: TRIGGER_STATUS.CANCELLED,
            lastError: (hitsMax
              ? `maxFires reached (${row.fireCount + 1}/${row.maxFires})`
              : 'expired'
            ).slice(0, 191),
            fireCount: { increment: 1 },
            attempts: { increment: 1 },
          },
        });
      }
      return await this.prisma.trigger.update({
        where: { id: row.id },
        data: {
          status: TRIGGER_STATUS.PENDING,
          fireAt: next,
          dueAt: next,
          nextFireAt: next,
          fireCount: { increment: 1 },
          attempts: { increment: 1 },
          skipReason: null,
        },
      });
    }
    return await this.prisma.trigger.update({
      where: { id: row.id },
      data: {
        status: TRIGGER_STATUS.FIRED,
        fireCount: { increment: 1 },
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * ticker 启动（worker-dispatcher startIdleScan 同款约定）：
   * `onModuleInit()` 时启动（eager，重启后库存 due 行能被扫描）；
   * `TIMER_SCAN_INTERVAL_MS=0` 禁用；
   * `setInterval` + `.unref()`；每 tick 错误捕获记日志。
   *
   * tick 调无参 `fireDue()`（D12-1 生产路径：DB `NOW(3)` 求值到期，
   * 非 app `new Date()` 比较）。
   */
  private ensureTicker(): void {
    if (this.scanIntervalMs() <= 0) {
      return;
    }
    if (this.scanTimer) {
      return;
    }
    this.scanTimer = setInterval(() => {
      void this.fireDue().catch((err: unknown) =>
        this.logger.error(`trigger 扫描失败: ${describeError(err)}`),
      );
    }, this.scanIntervalMs());
    this.scanTimer.unref?.();
  }

  private scanIntervalMs(): number {
    const raw = process.env.TIMER_SCAN_INTERVAL_MS;
    if (raw === undefined || raw === '') {
      return TRIGGER_SCAN_INTERVAL_MS_DEFAULT;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : TRIGGER_SCAN_INTERVAL_MS_DEFAULT;
  }

  onModuleDestroy() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }
}

/** overdue 重排钳制：已过期的目标时刻不追补，直接 now + jitter(0..30s)。 */
function clampOverdue(target: Date, now: Date): Date {
  if (target.getTime() > now.getTime()) {
    return target;
  }
  return new Date(now.getTime() + jitterMs());
}

/** 抖动：[0, TRIGGER_RESCHEDULE_JITTER_MS)。 */
function jitterMs(): number {
  return Math.floor(Math.random() * TRIGGER_RESCHEDULE_JITTER_MS);
}

/** TriggerOutcome 判别（`in` 需 object，先 typeof 收窄 void）。 */
function isExpireOutcome(
  outcome: void | TriggerOutcome,
): outcome is { expire: true } {
  return (
    typeof outcome === 'object' &&
    outcome !== null &&
    'expire' in outcome &&
    outcome.expire === true
  );
}

/** TriggerOutcome 判别（`in` 需 object，先 typeof 收窄 void）。 */
function isRescheduleOutcome(
  outcome: void | TriggerOutcome,
): outcome is { rescheduleAt: Date } {
  return (
    typeof outcome === 'object' &&
    outcome !== null &&
    'rescheduleAt' in outcome &&
    outcome.rescheduleAt instanceof Date
  );
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

// ==================================================================
// 兼容别名（todo-2 改名过渡；消费者迁移归 todo-5/6，届时再移除）。
// TimerService 与 TriggerService 是同一引用，DI token 一致，零模块改动。
// ==================================================================

/** @deprecated 用 TriggerService（同引用，DI token 一致）。 */
export type TimerService = TriggerService;
/** @deprecated 用 TriggerService（同引用，DI token 一致）。 */
export const TimerService = TriggerService;
/** @deprecated 用 TRIGGER_STATUS。 */
export const TIMER_STATUS = TRIGGER_STATUS;
/** @deprecated 用 TRIGGER_ID_PREFIX（tmr_ 冻结）。 */
export const TIMER_ID_PREFIX = TRIGGER_ID_PREFIX;
/** @deprecated 用 TRIGGER_SCAN_INTERVAL_MS_DEFAULT。 */
export const TIMER_SCAN_INTERVAL_MS_DEFAULT = TRIGGER_SCAN_INTERVAL_MS_DEFAULT;
/** @deprecated 用 TriggerFireContext。 */
export type TimerFireContext = TriggerFireContext;
/** @deprecated 用 TriggerHandler。 */
export type TimerHandler = TriggerHandler;
/** @deprecated 用 TriggerDedupKey。 */
export type TimerDedupKey = TriggerDedupKey;
