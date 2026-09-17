import type { Logger } from '@nestjs/common';
import type { IdGeneratorService } from '../common/id-generator';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { HOOK_STATUS } from './hook.constants';

/**
 * reconciler 共享底座（trigger-unification todo-3）。
 * 常量 + 行类型 + ctx + 认领/事件 helpers；方向 A/B 与 service 皆由此组装。
 * 方向 A/B 模块皆经 `ReconcileCtx` 拿依赖（单对象传参，不散装 4+ 形参）。
 */

/** 自愈事件类型（realtime_events 落库 + 广播；刻意不进 EVENT_TYPES 白名单，零 churn）。 */
export const TRIGGER_RECONCILE_EVENT_TYPE = 'trigger.reconcile';

/** 单向单 pass 上限（DB 侧 take N，防大 backlog stall 启动）。 */
export const TRIGGER_RECONCILE_BATCH_LIMIT = 500;

/** 周期缺省 15min（Oracle：boot-only 会漏 boot 间孤儿）；env 覆盖，0=停周期但启动 pass 照跑。 */
export const TRIGGER_RECONCILE_INTERVAL_MS_DEFAULT = 15 * 60_000;
export const TRIGGER_RECONCILE_INTERVAL_MS_ENV = 'TRIGGER_RECONCILE_INTERVAL_MS';

export interface HookRowLike {
  id: string;
  kind: string;
  status: string;
  dueAt: Date | null;
  expiresAt: Date;
  scopeType: string;
  scopeId: string;
  ownerInstanceId: string;
}

export interface TriggerRowLike {
  id: string;
  kind: string;
  status: string;
  dedupKey: string;
  payload: unknown;
}

export interface ReconcileCtx {
  prisma: PrismaService;
  idGen: IdGeneratorService;
  realtime: RealtimeService;
  logger: Logger;
}

/** 过期 hook 认领（原子 updateMany；胜者 emit，败者静默 false）。 */
export async function claimExpireHook(
  ctx: ReconcileCtx,
  hook: HookRowLike,
  direction: string,
  reason: string,
): Promise<boolean> {
  const claimed = await ctx.prisma.hook.updateMany({
    where: { id: hook.id, status: HOOK_STATUS.PENDING },
    data: { status: HOOK_STATUS.EXPIRED, lastError: reason.slice(0, 191) },
  });
  if (claimed.count !== 1) {
    return false;
  }
  await emitReconcile(ctx, {
    direction,
    action: 'expired',
    hookId: hook.id,
    prevTriggerStatus: 'n/a',
  });
  return true;
}

/** 自愈事件 best-effort（失败仅 warn；修复已落库不回滚，下 pass 幂等不再补发）。 */
export async function emitReconcile(
  ctx: ReconcileCtx,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.realtime.emit(TRIGGER_RECONCILE_EVENT_TYPE, payload);
  } catch (err) {
    ctx.logger.warn(
      `[reconcile] 事件落库失败 hook=${String(payload['hookId'] ?? '?')}（修复已生效，不重试）: ${describeReconcileError(err)}`,
    );
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

export function describeReconcileError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
