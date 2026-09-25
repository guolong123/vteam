import {
  TRIGGER_KIND,
  buildTriggerDedupKey,
} from '../common/constants/trigger.constants';

/**
 * agent-hook 域常量（trigger-unification todo-11）。
 *
 * v1 只支持两种 hook（plan 明确 defer event-kind hooks）：
 * - `time`：定时唤醒（"wake me in 4 hours"），注册时同事务落 `hook_fire`
 *   触发器行，`dueAt` 到期唤醒；
 * - `all_idle`：全域静默唤醒（"wake me when the team goes quiet"），不做
 *   per-hook 轮询，由全局 `hook_poll` interval 行统一扫描评估。
 */

/** Hook.status 应用层常量（对齐 schema.prisma Hook 模型注释）。 */
export const HOOK_STATUS = {
  PENDING: 'pending',
  FIRED: 'fired',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const;

export type HookStatus = (typeof HOOK_STATUS)[keyof typeof HOOK_STATUS];

/** Hook 主键域前缀（冻结 hks_，经共享 IdGeneratorService 生成；`tmr_` 不动）。 */
export const HOOK_ID_PREFIX = 'hks';

/** v1 hook kind 白名单（未知 kind 在 registerHook 入口 loud throw）。 */
export const HOOK_KIND = {
  TIME: 'time',
  ALL_IDLE: 'all_idle',
} as const;

export type HookKind = (typeof HOOK_KIND)[keyof typeof HOOK_KIND];

const HOOK_KIND_SET: ReadonlySet<string> = new Set<string>(
  Object.values(HOOK_KIND),
);

/** kind 是否在 v1 白名单内（registerHook 入口强制门）。 */
export function isHookKind(kind: string): kind is HookKind {
  return HOOK_KIND_SET.has(kind);
}

/** 唤醒词上限（字符数；超限截断，见 registerHook）。 */
export const HOOK_WAKE_TEXT_MAX = 2000;

/**
 * `all_idle` 静默宽限缺省值（ms）：scope 内无 running 会话 **且**
 * `now - max(lastActivityAt) >= graceMs` 才算静默。
 *
 * 保守默认 4 分钟（plan 区间 3–5min 内取值）——todo-10 的 PoC 正在测量
 * 真实 dispatch→`running` 落库 lag 分布，终值由该测量结果设定；调参只改
 * 这一处常量（或同名 env），调用方一律走 `resolveGraceMs`。
 */
export const HOOK_ALL_IDLE_GRACE_MS_DEFAULT = 4 * 60 * 1000;

/** 静默宽限 env 键（字符串数字；非法/缺省回默认值，见 resolveGraceMs）。 */
export const HOOK_ALL_IDLE_GRACE_MS_ENV = 'HOOK_ALL_IDLE_GRACE_MS';

/**
 * 全局 `hook_poll` 轮询间隔缺省值（ms）。
 *
 * 单个 interval 触发器行（dedupKey `hook_poll:global:all_idle`）驱动全域
 * 扫描——N 个 hook 共用一次 tick，不是 N×M 轮询；间隔远小于宽限即可。
 */
export const HOOK_POLL_INTERVAL_MS_DEFAULT = 30_000;

/** 全局 poll 间隔 env 键（字符串数字；非法/缺省回默认值）。 */
export const HOOK_POLL_INTERVAL_MS_ENV = 'HOOK_POLL_INTERVAL_MS';

/**
 * busy/分派失败重试间隔（ms）：veto 命中或 wake 分派抛错时，hook 留 pending，
 * `hook_fire` 行重排到 `now + 该值`（`expiresAt` 前；越过即改判 expired，
 * 触发器基座永不先于 handler 取消本行，见 hook.service.ts）。
 */
export const HOOK_BUSY_RETRY_MS_DEFAULT = 60_000;

/** 单轮 poll 评估上限（DB 侧 ORDER BY createdAt LIMIT N，防大 backlog 爆内存）。 */
export const HOOK_POLL_BATCH_LIMIT = 100;

/** 单轮 poll 唤醒上限：同一 tick 至多唤醒 ONE 个 hook（多个命中排队等下轮）。 */
export const HOOK_POLL_WAKES_PER_TICK = 1;

/**
 * anti-runaway guardrails（trigger-unification todo-19）。
 *
 * 背景：agent 可注册"稍后唤醒我"的 hook，被唤醒轮内又可注册新 hook——
 * 无硬上限即无界模型成本环。Oracle 否决了 session-depth 计数器方案：
 * `reuseSession=true` 跨任务复用同一 session（无 per-turn 挂载点），且
 * A↔B ping-pong 可绕过简单计数。故本计划用 hook-row lineage + per-task
 * 预算，而非 depth 计数。
 *
 * 6 道 rail（常量集中此处，服务层强制，全部 loud 拒绝/显式结算）：
 * 1) `HOOK_MIN_DELAY_MS`：time hook 最小延迟 60s（更短即自唤 busy-loop）。
 * 2) `HOOK_DEFAULT_TTL_MS`/`HOOK_MAX_TTL_MS`：缺省 24h（调用方默认，
 *    todo-12 `hook_register` 侧 `expiresInMs` 未传即此值），上界 7d。
 * 3) `HOOK_SCOPE_PENDING_CAP`：每 scope 至多 20 个 pending hook。
 * 4) `HOOK_TASK_WAKE_BUDGET`：每 task 至多 5 次唤醒（fired+pending 血缘行计数）。
 * 5) 环检测：`parentHookId` 链 + `rootTaskId`（见 hook.service.ts
 *    `detectHookCycle` 的算法注释）。
 * 6) `HOOK_BUSY_MAX_RETRIES`：busy 重排 60s 一跳，满 10 次改判 expired。
 */
export const HOOK_MIN_DELAY_MS_DEFAULT = 60_000;

/** 最小延迟 env 键（字符串数字；非法/缺省回默认值，见 resolveHookMs）。 */
export const HOOK_MIN_DELAY_MS_ENV = 'HOOK_MIN_DELAY_MS';

/**
 * 最小延迟判定容差（ms）：调用方（todo-12 `hook_register`）先算 `dueAt` 再调
 * 服务，期间时钟自然流逝——恰卡 60s 边界的合法注册不应被这几 ms 误杀。
 * 真正短延迟（秒级自唤）仍被拒绝，容差只覆盖调用链路耗时。
 */
export const HOOK_MIN_DELAY_SKEW_MS = 1000;

/**
 * hook 缺省生命周期 24h（调用方 `expiresInMs` 未传时的默认值；
 * todo-12 `hook_register` 侧已有同值本地常量，本处为跨调用方 canonical 值）。
 */
export const HOOK_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** hook 生命周期上界 7d（`expiresAt - now` 超此即 loud 拒绝）。 */
export const HOOK_MAX_TTL_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;

/** 生命周期上界 env 键（字符串数字；非法/缺省回默认值）。 */
export const HOOK_MAX_TTL_MS_ENV = 'HOOK_MAX_TTL_MS';

/** 每 scope pending hook 上限（超限注册 loud 拒绝，非静默丢弃）。 */
export const HOOK_SCOPE_PENDING_CAP_DEFAULT = 20;

/** scope 上限 env 键（正整数；非法/缺省回默认值，见 resolveHookCount）。 */
export const HOOK_SCOPE_PENDING_CAP_ENV = 'HOOK_SCOPE_PENDING_CAP';

/**
 * 每 task wake 预算（同一 `rootTaskId` 下 fired+pending 血缘行至多 N 个；
 * 注册时超限 loud 拒绝，fire 时超限改判 expired——双重熄火）。
 */
export const HOOK_TASK_WAKE_BUDGET_DEFAULT = 5;

/** task 预算 env 键（正整数；非法/缺省回默认值）。 */
export const HOOK_TASK_WAKE_BUDGET_ENV = 'HOOK_TASK_WAKE_BUDGET';

/** busy/分派失败重试上限（满此次数改判 expired；重试间隔沿用 60s）。 */
export const HOOK_BUSY_MAX_RETRIES_DEFAULT = 10;

/** 重试上限 env 键（正整数；非法/缺省回默认值）。 */
export const HOOK_BUSY_MAX_RETRIES_ENV = 'HOOK_BUSY_MAX_RETRIES';

/**
 * 血缘链回溯上限（`parentHookId` 逐跳 findUnique 至多 N 跳；链深超预算
 * （5）本已拒绝，此上限只防恶意长链拖 DB——取预算 2 倍 + 余量）。
 */
export const HOOK_LINEAGE_WALK_LIMIT = 12;

/**
 * 跨任务 ping-pong 回退判据的唤醒词最小长度（normalize 后短于此的
 * 文本不做相似判定，防 "ok"/"wake" 类短词误伤合法新任务）。
 */
export const HOOK_WAKE_SIMILAR_MIN_LEN = 16;

/** 全局 poll 行 dedupKey（幂等确保，一域一行）。 */
export const HOOK_POLL_DEDUP_KEY = buildTriggerDedupKey(
  TRIGGER_KIND.HOOK_POLL,
  'global',
  'all_idle',
);

/**
 * wake 执行失败事件类型（realtime_events 落库 + 广播）。
 *
 * 刻意不进 EVENT_TYPES 白名单（与 `trigger.reconcile` 同款：新事件不 churn
 * 事件表契约与既有长度断言）。语义：hook 已 `fired`（分派被接受）但被唤醒的
 * 会话随后 `agent.error` —— 记录真实下游原因，不回滚 `fired` 状态。
 */
export const TRIGGER_WAKE_FAILED_EVENT_TYPE = 'trigger.wake.failed';

/**
 * 组装 hook 注册幂等键：`hook:<scope>:<id>`（如 `hook:team:tm_1:wake-x`）。
 * 调用方（todo-12 `hook_register`）显式传入，重复注册幂等直返既有行。
 */
export function buildHookDedupKey(scope: string, id: string): string {
  return `hook:${scope}:${id}`;
}

/**
 * hook 配套 `hook_fire` 行的 dedupKey：`hook_fire:hook:<hookId>`。
 * 1 hook : 1 fire 行，todo-3 reconciler 可从两表互相回查
 * （fire 行 `payload.hookId` 正向，dedupKey 反向）。
 */
export function buildHookFireDedupKey(hookId: string): string {
  return buildTriggerDedupKey(TRIGGER_KIND.HOOK_FIRE, 'hook', hookId);
}

/** 唤醒词组装：`[hook:<kind> <id>] <wakeText>`（下一轮知道为何而醒）。 */
export function buildHookWakeText(
  kind: string,
  hookId: string,
  wakeText: string,
): string {
  return `[hook:${kind} ${hookId}] ${wakeText}`;
}

/** env 字符串数字归一（非法/非正/缺省 → 默认值；ConfigService 不做 coerce，见 todo-7 教训）。 */
export function resolveHookMs(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number(raw) : (raw as number);
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** env 计数归一（正整数；非法/小数/缺省 → 默认值；与 resolveHookMs 同因）。 */
export function resolveHookCount(raw: unknown, fallback: number): number {
  const n = typeof raw === 'string' ? Number(raw) : (raw as number);
  return typeof n === 'number' && Number.isFinite(n) && Math.floor(n) > 0
    ? Math.floor(n)
    : fallback;
}
