import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TRIGGER_ID_PREFIX } from '../timers/trigger.service';
import { reconcileDirectionA } from './trigger-reconciler.direction-a';
import { reconcileDirectionB } from './trigger-reconciler.direction-b';
import {
  describeReconcileError,
  TRIGGER_RECONCILE_INTERVAL_MS_DEFAULT,
  TRIGGER_RECONCILE_INTERVAL_MS_ENV,
  type ReconcileCtx,
} from './trigger-reconciler.support';

/**
 * hook↔trigger 自愈 reconciler（trigger-unification todo-3，TimersModule 装配）。
 * 编排薄层：启动即自愈（eager，不等首个 15min）+ 15min 周期兜底；
 * 修复逻辑在 direction-a/b 模块，认领/事件在 support。
 * 仅依赖 Prisma/IdGen/Realtime，不依赖 HookService（todo-19 并发 lane，无循环依赖）。
 */

export {
  TRIGGER_RECONCILE_BATCH_LIMIT,
  TRIGGER_RECONCILE_EVENT_TYPE,
  TRIGGER_RECONCILE_INTERVAL_MS_DEFAULT,
  TRIGGER_RECONCILE_INTERVAL_MS_ENV,
} from './trigger-reconciler.support';

export interface ReconcileCounts {
  directionA: number;
  directionB: number;
}

@Injectable()
export class TriggerReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TriggerReconcilerService.name);
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly realtime: RealtimeService,
  ) {}

  /** 启动即自愈（await 但有界 + 非致命，不阻断 boot）后起 15min 周期。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.trigger, TRIGGER_ID_PREFIX, this.idGen);
    const started = Date.now();
    try {
      const counts = await this.reconcileOnce();
      this.logger.log(
        `[reconcile] 启动自愈完成方向A=${counts.directionA} 方向B=${counts.directionB} 耗时=${Date.now() - started}ms`,
      );
    } catch (err) {
      this.logger.error(
        `[reconcile] 启动自愈失败（周期继续，不阻断启动）: ${describeReconcileError(err)}`,
      );
    }
    this.ensureInterval();
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /** 单 pass 两方向（永不抛；行级失败下 pass 重试）。 */
  async reconcileOnce(now: Date = new Date()): Promise<ReconcileCounts> {
    const ctx: ReconcileCtx = {
      prisma: this.prisma,
      idGen: this.idGen,
      realtime: this.realtime,
      logger: this.logger,
    };
    const directionA = await reconcileDirectionA(ctx, now);
    const directionB = await reconcileDirectionB(ctx, now);
    return { directionA, directionB };
  }

  /** 15min 周期（workers.service markStaleWorkersOffline 同款：setInterval + unref + tick 吞错）。 */
  private ensureInterval(): void {
    if (this.reconcileIntervalMs() <= 0) {
      return;
    }
    if (this.reconcileTimer) {
      return;
    }
    this.reconcileTimer = setInterval(() => {
      void this.reconcileOnce(new Date()).catch((err: unknown) =>
        this.logger.error(
          `[reconcile] 周期自愈失败: ${describeReconcileError(err)}`,
        ),
      );
    }, this.reconcileIntervalMs());
    this.reconcileTimer.unref?.();
  }

  private reconcileIntervalMs(): number {
    const raw = process.env[TRIGGER_RECONCILE_INTERVAL_MS_ENV];
    if (raw === undefined || raw === '') {
      return TRIGGER_RECONCILE_INTERVAL_MS_DEFAULT;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : TRIGGER_RECONCILE_INTERVAL_MS_DEFAULT;
  }
}
