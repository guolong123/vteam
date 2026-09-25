import { TRIGGER_KIND } from '../common/constants/trigger.constants';
import { TRIGGER_ID_PREFIX, TRIGGER_STATUS } from '../timers/trigger.service';
import {
  buildHookFireDedupKey,
  HOOK_KIND,
  HOOK_STATUS,
} from './hook.constants';
import {
  claimExpireHook,
  describeReconcileError,
  emitReconcile,
  isUniqueViolation,
  TRIGGER_RECONCILE_BATCH_LIMIT,
  type HookRowLike,
  type ReconcileCtx,
  type TriggerRowLike,
} from './trigger-reconciler.support';

/**
 * 方向 A：`pending` hook × 配套 fire 行（批量 dedupKey 回查，一次 IN 查询）。
 * hook 已过期 → claim-expire；fire 行 pending/firing → 健康；fired →
 * 方向 B 领地；failed/cancelled → 带 status 谓词 deleteMany 认领后重建；
 * 缺失 → 直接重建（P2002 即并发败者静默跳过）。
 */
export async function reconcileDirectionA(
  ctx: ReconcileCtx,
  now: Date,
): Promise<number> {
  let hooks: HookRowLike[];
  try {
    hooks = (await ctx.prisma.hook.findMany({
      where: { status: HOOK_STATUS.PENDING },
      orderBy: { createdAt: 'asc' },
      take: TRIGGER_RECONCILE_BATCH_LIMIT,
    })) as unknown as HookRowLike[];
  } catch (err) {
    ctx.logger.error(
      `[reconcile] 方向A hook 查询失败: ${describeReconcileError(err)}`,
    );
    return 0;
  }
  if (!hooks || hooks.length === 0) {
    return 0;
  }
  const dedupKeys = hooks.map((h) => buildHookFireDedupKey(h.id));
  let fireRows: TriggerRowLike[];
  try {
    fireRows = (await ctx.prisma.trigger.findMany({
      where: { dedupKey: { in: dedupKeys } },
    })) as unknown as TriggerRowLike[];
  } catch (err) {
    ctx.logger.error(
      `[reconcile] 方向A trigger 回查失败: ${describeReconcileError(err)}`,
    );
    return 0;
  }
  const byDedup = new Map((fireRows ?? []).map((r) => [r.dedupKey, r]));
  let repaired = 0;
  for (const hook of hooks) {
    try {
      if (
        await repairHookSide(
          ctx,
          hook,
          byDedup.get(buildHookFireDedupKey(hook.id)) ?? null,
          now,
        )
      ) {
        repaired += 1;
      }
    } catch (err) {
      ctx.logger.warn(
        `[reconcile] 方向A hook=${hook.id} 修复失败（下 pass 重试）: ${describeReconcileError(err)}`,
      );
    }
  }
  return repaired;
}

async function repairHookSide(
  ctx: ReconcileCtx,
  hook: HookRowLike,
  fireRow: TriggerRowLike | null,
  now: Date,
): Promise<boolean> {
  if (now.getTime() >= hook.expiresAt.getTime()) {
    return claimExpireHook(
      ctx,
      hook,
      'A',
      'hook 已过期（reconcile 结算，只标不删）',
    );
  }
  if (fireRow) {
    if (
      fireRow.status === TRIGGER_STATUS.PENDING ||
      fireRow.status === TRIGGER_STATUS.FIRING ||
      fireRow.status === TRIGGER_STATUS.FIRED
    ) {
      return false;
    }
    const claimed = await ctx.prisma.trigger.deleteMany({
      where: { dedupKey: fireRow.dedupKey, status: fireRow.status },
    });
    if (claimed.count !== 1) {
      return false;
    }
  }
  const due =
    hook.kind === HOOK_KIND.TIME
      ? (hook.dueAt ?? hook.expiresAt)
      : hook.expiresAt;
  const dedupKey = buildHookFireDedupKey(hook.id);
  const id = await ctx.idGen.nextId(TRIGGER_ID_PREFIX);
  try {
    await ctx.prisma.trigger.create({
      data: {
        id,
        kind: TRIGGER_KIND.HOOK_FIRE as string,
        status: TRIGGER_STATUS.PENDING,
        dueAt: due,
        payload: { hookId: hook.id },
        dedupKey,
        attempts: 0,
        fireCount: 0,
        scopeType: hook.scopeType,
        scopeId: hook.scopeId,
        ownerInstanceId: hook.ownerInstanceId,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return false;
    }
    throw err;
  }
  await emitReconcile(ctx, {
    direction: 'A',
    action: fireRow ? 're-armed' : 're-armed-missing',
    hookId: hook.id,
    triggerId: id,
    prevTriggerStatus: fireRow?.status ?? 'missing',
  });
  return true;
}
