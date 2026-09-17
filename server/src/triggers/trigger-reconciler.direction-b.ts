import { TRIGGER_KIND } from '../common/constants/trigger.constants';
import { TRIGGER_STATUS } from '../timers/trigger.service';
import { HOOK_KIND, HOOK_STATUS } from './hook.constants';
import {
  claimExpireHook,
  describeReconcileError,
  emitReconcile,
  TRIGGER_RECONCILE_BATCH_LIMIT,
  type HookRowLike,
  type ReconcileCtx,
  type TriggerRowLike,
} from './trigger-reconciler.support';

/**
 * 方向 B：`fired` 的 `hook_fire` 行 × 仍 `pending` 的 `time` hook
 * （`markFired` 写丢，对应 wake 已分派 → claim 落 `fired`；已过期则 `expired`）。
 * `all_idle` 跳过（fired+pending 系 poll 拥有唤醒权的正常态）。
 */
export async function reconcileDirectionB(
  ctx: ReconcileCtx,
  now: Date,
): Promise<number> {
  let rows: TriggerRowLike[];
  try {
    rows = (await ctx.prisma.trigger.findMany({
      where: { kind: TRIGGER_KIND.HOOK_FIRE as string, status: TRIGGER_STATUS.FIRED },
      orderBy: { dueAt: 'asc' },
      take: TRIGGER_RECONCILE_BATCH_LIMIT,
    })) as unknown as TriggerRowLike[];
  } catch (err) {
    ctx.logger.error(`[reconcile] 方向B trigger 查询失败: ${describeReconcileError(err)}`);
    return 0;
  }
  let repaired = 0;
  for (const row of rows ?? []) {
    try {
      if (await repairFiredSide(ctx, row, now)) {
        repaired += 1;
      }
    } catch (err) {
      ctx.logger.warn(
        `[reconcile] 方向B trigger=${row.id} 修复失败（下 pass 重试）: ${describeReconcileError(err)}`,
      );
    }
  }
  return repaired;
}

async function repairFiredSide(
  ctx: ReconcileCtx,
  row: TriggerRowLike,
  now: Date,
): Promise<boolean> {
  const hookId = (row.payload as { hookId?: unknown } | null)?.hookId;
  if (typeof hookId !== 'string' || !hookId) {
    return false;
  }
  const hook = (await ctx.prisma.hook.findUnique({
    where: { id: hookId },
  })) as unknown as HookRowLike | null;
  if (!hook || hook.status !== HOOK_STATUS.PENDING) {
    return false;
  }
  if (hook.kind !== HOOK_KIND.TIME) {
    return false;
  }
  const expired = now.getTime() >= hook.expiresAt.getTime();
  if (expired) {
    return claimExpireHook(ctx, hook, 'B', 'hook 已过期（reconcile 方向B 结算，只标不删）');
  }
  const claimed = await ctx.prisma.hook.updateMany({
    where: { id: hook.id, status: HOOK_STATUS.PENDING },
    data: {
      status: HOOK_STATUS.FIRED,
      lastError: `配套 fire 行已 fired 但 hook 仍 pending（reconcile 补结算，trigger=${row.id}）`.slice(
        0,
        191,
      ),
    },
  });
  if (claimed.count !== 1) {
    return false;
  }
  await emitReconcile(ctx, {
    direction: 'B',
    action: 'settled-fired',
    hookId: hook.id,
    triggerId: row.id,
    prevTriggerStatus: row.status,
  });
  return true;
}
