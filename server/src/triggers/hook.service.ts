import { Injectable, Logger, OnModuleInit, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import {
  TRIGGER_KIND,
} from '../common/constants/trigger.constants';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import {
  TriggerFireContext,
  TriggerOutcome,
  TriggerService,
  TRIGGER_ID_PREFIX,
  TRIGGER_STATUS,
} from '../timers/trigger.service';
import { toExecutionScope, WorkerDispatcher } from '../chat/worker-dispatcher';
import { RealtimeService } from '../realtime/realtime.service';
import type { RealtimeScope } from '../realtime/realtime.service';
import {
  buildHookFireDedupKey,
  buildHookWakeText,
  HOOK_ALL_IDLE_GRACE_MS_DEFAULT,
  HOOK_ALL_IDLE_GRACE_MS_ENV,
  HOOK_BUSY_MAX_RETRIES_DEFAULT,
  HOOK_BUSY_MAX_RETRIES_ENV,
  HOOK_BUSY_RETRY_MS_DEFAULT,
  HOOK_ID_PREFIX,
  HOOK_KIND,
  HOOK_LINEAGE_WALK_LIMIT,
  HOOK_MAX_TTL_MS_DEFAULT,
  HOOK_MAX_TTL_MS_ENV,
  HOOK_MIN_DELAY_MS_DEFAULT,
  HOOK_MIN_DELAY_MS_ENV,
  HOOK_MIN_DELAY_SKEW_MS,
  HOOK_POLL_BATCH_LIMIT,
  HOOK_POLL_DEDUP_KEY,
  HOOK_POLL_INTERVAL_MS_DEFAULT,
  HOOK_POLL_INTERVAL_MS_ENV,
  HOOK_POLL_WAKES_PER_TICK,
  HOOK_SCOPE_PENDING_CAP_DEFAULT,
  HOOK_SCOPE_PENDING_CAP_ENV,
  HOOK_STATUS,
  HOOK_TASK_WAKE_BUDGET_DEFAULT,
  HOOK_TASK_WAKE_BUDGET_ENV,
  HOOK_WAKE_SIMILAR_MIN_LEN,
  HOOK_WAKE_TEXT_MAX,
  TRIGGER_WAKE_FAILED_EVENT_TYPE,
  isHookKind,
  resolveHookCount,
  resolveHookMs,
} from './hook.constants';

/**
 * agent-hook 域服务（trigger-unification todo-11，本计划存在的理由）。
 *
 * // allow: SIZE_OK — 单一内聚域（agent-hook 注册 + fire/poll 唤醒共用同一
 * tryWake 核心）；拆分会把 fire/poll 共享的目标解析·否决·分派链打散到第三个
 * 模块，内聚更差。先例：TriggerService（614 行）/ task-progression（758 行）。
 *
 * agent 注册"wake me in 4 hours"（`time`）或"wake me when the team goes
 * quiet"（`all_idle`），结束本轮（会话 idle 但保持绑定），平台稍后经
 * `dispatchAgentMention({ kind: 'wake' })` 在**同会话**内唤醒。
 *
 * 落库：
 * - 每次 `registerHook` 都在同一 Prisma `$transaction` 内落 **1 hook 行 +
 *   1 hook_fire 触发器行**（无半写）：time 行 dueAt=到期时刻；all_idle 行
 *   dueAt=expiresAt（纯到期兜底，唤醒走全局 poll）。
 * - `hook_fire` 行不设基座 `expiresAt`（基座 claim 前取消会绕过 handler，
 *   hook 行将被 stranded pending）——过期一律由 handler  own
 *   `now >= hook.expiresAt → expired` 结算。
 * - 全局 `hook_poll` interval 行（一域一行，daemon：无 maxFires/expiresAt）
 *   在 `onModuleInit` 幂等确保，N 个 hook 共用一次 tick（非 N×M 轮询）。
 *
 * 唤醒（`tryWake`，fire/poll 共用）：
 * - 目标在触发时重解析：任务终态/删除、成员删除、会话重置缺失 → `expired`
 *   + `lastError`（永不抛，永不静默消失）；
 * - 内存否决（in-memory veto）：目标 mid-turn（pending 看门狗 / session
 *   running / `isAgentExecuting` 命中）→ 写 `skipReason` 留 pending，
 *   fire 路径重排 `now + 60s`（越过 expiresAt 则改判 expired），poll 路径
 *   继续扫下一个（同 tick 至多唤醒 ONE 个）；
 * - 成功 → `dispatchAgentMention({ kind: 'wake' })` + hook 落 `fired`。
 *
 * 血缘：被唤醒轮内注册的新 hook 带 `parentHookId`，`rootTaskId` 继承不重置；
 * `expireTaskHooks(taskId)` 只标 `expired`（`resetAfterComplete` 语义），永不
 * DELETE（跨任务环检测链不断；调用方归 todo-3，本服务只留方法 + 单元锁定）。
 *
 * 本文件不做的（留缝）：MCP `hook_register`/`hook_cancel`（todo-12 薄封装本
 * 服务）、seed/policy allowlist（todo-13）、guardrails 预算（todo-19）、
 * event-kind hooks（plan 已 defer）。
 *
 * 可观测（trigger-unification todo-20）：终态/否决路径经 RealtimeService
 * 落 `trigger.fired`/`trigger.expired`/`trigger.skipped`（EVENT_TYPES），
 * payload 含 hookId/kind/scope/ownerInstanceId + 原因；skipReason 在
 * veto/skip、timeout/expiry、target-invalid 三路径必写（settleHook 统一写）。
 *
 * 部署前提（plan decision 14，v1：单 `server` 副本）：`all_idle` 正确性依赖
 * 本进程内存否决（`dispatcher.isSessionPending` / `isAgentExecuting` 等
 * process-local 状态只看见本进程的进行中 turn）；多副本下他副本的 turn
 * 看不见 → `all_idle` 可能误醒。多副本需 leader 选举（升级触发条件，
 * 本次范围外）。
 */

export interface HookTarget {
  taskId?: string | null;
  teamId?: string | null;
  channelId: string;
  targetInstanceId: string;
  /**
   * 本次唤醒分派落入的会话主键（fire/poll 成功分派后回写；wake 失败记录
   * 据此把 `agent.error`/`session.updated(failed)` 关联回本 hook）。
   * 存量行无此键（parseHookTarget 缺省 null，向后兼容）。
   */
  wakeSessionId?: string | null;
}

/**
 * registerHook 入参（todo-12 `hook_register` 直接透传本结构 + caller 身份）。
 * - `dedupKey` 调用方显式传入（建议 `buildHookDedupKey` 组装），重复注册幂等直返；
 * - `parentHookId` 仅被唤醒轮内续注册时传（血缘链）；
 * - `graceMs` 仅 `all_idle` 有效（缺省走 `HOOK_ALL_IDLE_GRACE_MS_DEFAULT`）。
 */
export interface RegisterHookInput {
  scopeType: string;
  scopeId: string;
  ownerInstanceId: string;
  kind: string;
  wakeText: string;
  target: HookTarget;
  dueAt?: Date | null;
  graceMs?: number | null;
  expiresAt: Date;
  dedupKey: string;
  parentHookId?: string | null;
}

interface HookRow {
  id: string;
  scopeType: string;
  scopeId: string;
  ownerInstanceId: string;
  kind: string;
  wakeText: string;
  target: unknown;
  status: string;
  dueAt: Date | null;
  graceMs: number | null;
  expiresAt: Date;
  dedupKey: string;
  fireCount: number;
  busyRetries: number;
  parentHookId: string | null;
  rootTaskId: string | null;
  lastError: string | null;
  skipReason: string | null;
  createdAt: Date;
}

type WakeResolution =
  | {
      ok: true;
      taskId: string | null;
      teamId: string;
      channelId: string;
      targetInstanceId: string;
    }
  | { ok: false; reason: string };

@Injectable()
export class HookService implements OnModuleInit {
  private readonly logger = new Logger(HookService.name);

  /** `all_idle` 静默宽限（ms；公开字段便于单测覆盖，生产经 env 注入）。 */
  public allIdleGraceMs: number;
  /** 全局 poll 间隔（ms；公开字段便于单测覆盖）。 */
  public pollIntervalMs: number;
  /** `time` hook 最小延迟（ms；防自唤 busy-loop，公开字段便于单测覆盖）。 */
  public minDelayMs: number;
  /** hook 生命周期上界（ms；`expiresAt - now` 超此即拒绝）。 */
  public maxTtlMs: number;
  /** 每 scope pending hook 上限（超限注册 loud 拒绝）。 */
  public scopePendingCap: number;
  /** 每 task wake 预算（同一 rootTaskId 下 fired+pending 血缘行上限）。 */
  public taskWakeBudget: number;
  /** busy/分派失败重试上限（满此次数改判 expired）。 */
  public busyMaxRetries: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly triggers: TriggerService,
    private readonly dispatcher: WorkerDispatcher,
    config: ConfigService,
    @Optional() @Inject(RealtimeService)
    private readonly realtime?: RealtimeService,
  ) {
    // env 经 ConfigService 返回字符串，Number() 归一（非法/缺省 → 默认值；
    // todo-7 教训：compose 数字 env 不 coerce，此处显式 Number()）。
    this.allIdleGraceMs = resolveHookMs(
      config.get(HOOK_ALL_IDLE_GRACE_MS_ENV),
      HOOK_ALL_IDLE_GRACE_MS_DEFAULT,
    );
    this.pollIntervalMs = resolveHookMs(
      config.get(HOOK_POLL_INTERVAL_MS_ENV),
      HOOK_POLL_INTERVAL_MS_DEFAULT,
    );
    this.minDelayMs = resolveHookMs(
      config.get(HOOK_MIN_DELAY_MS_ENV),
      HOOK_MIN_DELAY_MS_DEFAULT,
    );
    this.maxTtlMs = resolveHookMs(
      config.get(HOOK_MAX_TTL_MS_ENV),
      HOOK_MAX_TTL_MS_DEFAULT,
    );
    this.scopePendingCap = resolveHookCount(
      config.get(HOOK_SCOPE_PENDING_CAP_ENV),
      HOOK_SCOPE_PENDING_CAP_DEFAULT,
    );
    this.taskWakeBudget = resolveHookCount(
      config.get(HOOK_TASK_WAKE_BUDGET_ENV),
      HOOK_TASK_WAKE_BUDGET_DEFAULT,
    );
    this.busyMaxRetries = resolveHookCount(
      config.get(HOOK_BUSY_MAX_RETRIES_ENV),
      HOOK_BUSY_MAX_RETRIES_DEFAULT,
    );
  }

  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.hook, HOOK_ID_PREFIX, this.idGen);
    // tmr_ 续号防御（live 抓到）：Nest 跨模块 onModuleInit 无序，
    // TriggerService 侧的续号可能尚未执行；本服务经 schedule() 取 tmr_ id，
    // 先自助对齐（seed 只升不降，与 TriggerService 侧重复调用安全）。
    await resyncIdPrefix(this.prisma.trigger, TRIGGER_ID_PREFIX, this.idGen);
    try {
      this.triggers.registerHandler(
        TRIGGER_KIND.HOOK_FIRE,
        (ctx) => this.handleHookFire(ctx),
      );
      this.triggers.registerHandler(TRIGGER_KIND.HOOK_POLL, () =>
        this.handleHookPoll(),
      );
    } catch (err) {
      this.logger.warn(
        `hook handler 注册失败（本进程唤醒失效）: ${describeHookError(err)}`,
      );
    }
    await this.ensureGlobalPoll();
  }

  /**
   * 注册 hook（todo-12 `hook_register` 的薄封装目标）。
   *
   * 同一 `$transaction` 内落 hook 行 + hook_fire 行（无半写；并发撞 dedup
   * 唯一键 → 回读胜者行幂等直返，mirror TriggerService.schedule）。
   */
  async registerHook(input: RegisterHookInput) {
    const nowMs = Date.now();
    if (!isHookKind(input.kind)) {
      throw new Error(
        `unknown hook kind ${input.kind} (v1 whitelist: ${Object.values(HOOK_KIND).join(',')})`,
      );
    }
    const wakeText = (input.wakeText ?? '').slice(0, HOOK_WAKE_TEXT_MAX);
    if (!wakeText) {
      throw new Error('wakeText 必填（空唤醒词无意义，拒绝落库）');
    }
    if (!input.expiresAt || !(input.expiresAt instanceof Date)) {
      throw new Error('expiresAt 必填（hook 生命周期上界，无无限 hook）');
    }
    if (input.kind === HOOK_KIND.TIME) {
      if (!input.dueAt || !(input.dueAt instanceof Date)) {
        throw new Error('time hook 必须带 dueAt（到期唤醒时刻）');
      }
      if (input.dueAt.getTime() >= input.expiresAt.getTime()) {
        throw new Error(
          'time hook 的 dueAt 必须早于 expiresAt（否则到期即过期，永不唤醒）',
        );
      }
      // guardrail #1（最小延迟 60s）：更短即自唤 busy-loop，loud 拒绝。
      // 容差 HOOK_MIN_DELAY_SKEW_MS 覆盖调用链路耗时（见常量注释）。
      const delayMs = input.dueAt.getTime() - nowMs;
      if (delayMs + HOOK_MIN_DELAY_SKEW_MS < this.minDelayMs) {
        throw new Error(
          `time hook 延迟过短（delay=${delayMs}ms < 最小 ${this.minDelayMs}ms，防自唤 busy-loop）`,
        );
      }
    } else if (input.dueAt) {
      throw new Error('all_idle hook 不接受 dueAt（静默由全局 poll 评估）');
    }
    if (!input.dedupKey) {
      throw new Error('dedupKey 必填（幂等注册键，调用方显式传入）');
    }
    // guardrail #2（TTL 上界）：expiresAt 已过去 → 拒绝；ttl 超 7d → 拒绝。
    // 缺省 24h 由调用方（todo-12 hook_register expiresInMs 未传）承担，本处只卡上界。
    const ttlMs = input.expiresAt.getTime() - nowMs;
    if (ttlMs <= 0) {
      throw new Error('expiresAt 已过去（拒绝注册已过期 hook）');
    }
    if (ttlMs > this.maxTtlMs) {
      throw new Error(
        `hook 生命周期超上界（ttl=${ttlMs}ms > 最大 ${this.maxTtlMs}ms=7d，无超长 hook）`,
      );
    }
    const existing = await this.prisma.hook.findUnique({
      where: { dedupKey: input.dedupKey },
    });
    if (existing) {
      return existing;
    }
    let parent: HookRow | null = null;
    if (input.parentHookId) {
      parent = (await this.prisma.hook.findUnique({
        where: { id: input.parentHookId },
      })) as unknown as HookRow | null;
      if (!parent) {
        throw new Error(
          `parentHookId ${input.parentHookId} 无对应 hook 行（拒绝悬空血缘）`,
        );
      }
    }
    // 血缘：rootTaskId 继承不重置（parent 链首 → parent 任务 → 本次 target 任务）。
    const rootTaskId =
      parent?.rootTaskId ??
      targetTaskId(parent?.target) ??
      targetTaskId(input.target) ??
      null;
    // guardrail #3（per-scope pending 上限 20）：超限 loud 拒绝，非静默丢弃。
    // findMany + take(cap+1) 代替 count—— hooks 表 (status,scope) 有复合索引，
    // 只读 cap+1 行即够判定（length >= cap 即满）。
    const scopePeers = (await this.prisma.hook.findMany({
      where: {
        status: HOOK_STATUS.PENDING,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      },
      select: { id: true },
      take: this.scopePendingCap + 1,
    })) as unknown as Array<{ id: string }>;
    if ((scopePeers ?? []).length >= this.scopePendingCap) {
      throw new Error(
        `scope ${input.scopeType}:${input.scopeId} pending hook 已满（cap=${this.scopePendingCap}，拒绝新注册）`,
      );
    }
    // guardrail #5（环检测，图感知非计数器）：沿 parentHookId 回溯整条链，
    // 同任务自环/A↔B 对穿/跨任务相似复读一律拒绝（算法见 detectHookCycle）。
    if (parent) {
      const cycle = await this.detectHookCycle(parent, input, rootTaskId);
      if (cycle) {
        throw new Error(cycle);
      }
    }
    // guardrail #4（per-task wake 预算 N=5）：同一 rootTaskId 下 fired+pending
    // 血缘行（含本次）至多 N 个——注册时超限拒绝，fire 时超限改判 expired，
    // 双重熄火。rootTaskId 为空（无任务归属）时不适用本预算。
    // cancelled/expired 终态行不计（已结算，不再消耗唤醒）。
    if (rootTaskId) {
      const lineage = (await this.prisma.hook.findMany({
        where: {
          rootTaskId,
          status: { in: [HOOK_STATUS.PENDING, HOOK_STATUS.FIRED] },
        },
        select: { id: true },
        take: this.taskWakeBudget + 1,
      })) as unknown as Array<{ id: string }>;
      if ((lineage ?? []).length >= this.taskWakeBudget) {
        throw new Error(
          `任务 ${rootTaskId} wake 预算耗尽（fired+pending=${lineage.length} >= 预算 ${this.taskWakeBudget}，防无界唤醒环）`,
        );
      }
    }
    const graceMs =
      input.kind === HOOK_KIND.ALL_IDLE
        ? typeof input.graceMs === 'number' &&
          Number.isFinite(input.graceMs) &&
          input.graceMs > 0
          ? Math.floor(input.graceMs)
          : this.allIdleGraceMs
        : null;
    const hookId = await this.idGen.nextId(HOOK_ID_PREFIX);
    const fireId = await this.idGen.nextId(TRIGGER_ID_PREFIX);
    // time：fire 行 dueAt=到期时刻；all_idle：fire 行 dueAt=expiresAt（纯到期
    // 兜底——handler 内 kind 分流，poll 拥有唤醒权，见 handleHookFire）。
    const fireDue =
      input.kind === HOOK_KIND.TIME
        ? (input.dueAt as Date)
        : input.expiresAt;
    const fireDedup = buildHookFireDedupKey(hookId);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const hook = await tx.hook.create({
          data: {
            id: hookId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            ownerInstanceId: input.ownerInstanceId,
            kind: input.kind,
            wakeText,
            target: input.target as unknown as object,
            status: HOOK_STATUS.PENDING,
            dueAt:
              input.kind === HOOK_KIND.TIME
                ? (input.dueAt as Date)
                : null,
            graceMs,
            expiresAt: input.expiresAt,
            dedupKey: input.dedupKey,
            fireCount: 0,
            busyRetries: 0,
            parentHookId: parent?.id ?? null,
            rootTaskId,
          },
        });
        // 触发器行归属：scope/owner 原样透传，todo-22 REST 按 agent 派生 source。
        await tx.trigger.create({
          data: {
            id: fireId,
            kind: TRIGGER_KIND.HOOK_FIRE as string,
            status: TRIGGER_STATUS.PENDING,
            fireAt: fireDue,
            dueAt: fireDue,
            payload: { hookId },
            dedupKey: fireDedup,
            attempts: 0,
            fireCount: 0,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            ownerInstanceId: input.ownerInstanceId,
          },
        });
        return hook;
      });
      return created;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const winner = await this.prisma.hook.findUnique({
        where: { dedupKey: input.dedupKey },
      });
      if (!winner) {
        throw err;
      }
      return winner;
    }
  }

  /**
   * 取消 hook（todo-12 `hook_cancel` 的薄封装目标；todo-22 REST 侧做 team 归属复核，
   * MCP 侧做 caller=tmm_ 逐字复核——本方法只做状态机）。
   *
   * hook 落 `cancelled` + 配套 fire 行 best-effort cancel；已终态行幂等直返。
   * cancelled hook 永不触发（fire/poll handler 首行校验 status）。
   */
  async cancelHook(idOrDedupKey: string) {
    let hook = (await this.prisma.hook.findUnique({
      where: { id: idOrDedupKey },
    })) as unknown as HookRow | null;
    if (!hook) {
      hook = (await this.prisma.hook.findUnique({
        where: { dedupKey: idOrDedupKey },
      })) as unknown as HookRow | null;
    }
    if (!hook) {
      throw new Error(`hook ${idOrDedupKey} 不存在（HOOK_NOT_FOUND 位见 todo-12）`);
    }
    if (hook.status !== HOOK_STATUS.PENDING) {
      return hook;
    }
    const cancelled = await this.prisma.hook.update({
      where: { id: hook.id },
      data: { status: HOOK_STATUS.CANCELLED },
    });
    try {
      await this.triggers.cancel(buildHookFireDedupKey(hook.id));
    } catch (err) {
      this.logger.warn(
        `hook ${hook.id} 配套 fire 行取消失败（handler 侧 status 校验兜底，永不误唤醒）: ${describeHookError(err)}`,
      );
    }
    return cancelled;
  }

  /**
   * 任务完成链结算（`resetAfterComplete` 语义的执行点）。
   *
   * 该任务链（`rootTaskId`）下所有 pending hook 标 `expired`——只标不删，
   * 跨任务环检测链不断。调用方归 todo-3（任务 accept/archive 迁移处）；
   * 本方法只提供原子 updateMany + 单元锁定。
   */
  async expireTaskHooks(taskId: string): Promise<number> {
    const reason =
      '任务已完成归档（resetAfterComplete 链结算，只标不删）'.slice(0, 191);
    const res = await this.prisma.hook.updateMany({
      where: { rootTaskId: taskId, status: HOOK_STATUS.PENDING },
      data: {
        status: HOOK_STATUS.EXPIRED,
        lastError: reason,
        skipReason: reason,
      },
    });
    return res.count;
  }

  /**
   * `hook_fire` handler（1 hook : 1 fire 行）。
   *
   * - 无 hookId / 行缺失 / 非 pending → `{done:true}`（cancel/fired/expired no-op）；
   * - `now >= expiresAt` → `expired` + `{done:true}`；
   * - `all_idle` 行（dueAt=expiresAt 的到期兜底）→ 唤醒权在 poll，此处纯 no-op；
   * - `time` 行 → 目标重解析（失效即 `expired`）→ 内存否决（`skipReason` +
   *   重排 `now + 60s`，越过 expiresAt 则改判 `expired`）→ wake 分派。
   */
  async handleHookFire(ctx: TriggerFireContext): Promise<TriggerOutcome> {
    const payload = (ctx?.payload ?? {}) as { hookId?: unknown };
    if (typeof payload.hookId !== 'string' || !payload.hookId) {
      this.logger.warn(
        `[hook] fire ${ctx?.id} 缺 hookId（跳过，不重排）`,
      );
      return { done: true };
    }
    const hook = (await this.prisma.hook.findUnique({
      where: { id: payload.hookId },
    })) as unknown as HookRow | null;
    if (!hook || hook.status !== HOOK_STATUS.PENDING) {
      return { done: true };
    }
    const now = new Date();
    if (now.getTime() >= hook.expiresAt.getTime()) {
      await this.settleHook(hook.id, HOOK_STATUS.EXPIRED, 'hook 已过期（fire 时结算）');
      return { done: true };
    }
    if (hook.kind === HOOK_KIND.ALL_IDLE) {
      // 到期兜底行提前触发（时钟/重排漂移）：唤醒权在全局 poll，此处不动。
      return { done: true };
    }
    if (hook.dueAt && now.getTime() < hook.dueAt.getTime()) {
      return { rescheduleAt: hook.dueAt };
    }
    const target = await this.resolveWakeTarget(hook);
    if (target.ok === false) {
      await this.settleHook(hook.id, HOOK_STATUS.EXPIRED, target.reason);
      return { done: true };
    }
    // guardrail #4 双重熄火（fire 侧）：注册后并发竞态超预算、或预算收紧前
    // 落库的旧行，fire 时复核——血缘行（含本行 pending）超预算即改判 expired。
    if (hook.rootTaskId) {
      const lineageCount = await this.countTaskLineage(hook.rootTaskId);
      if (lineageCount > this.taskWakeBudget) {
        await this.settleHook(
          hook.id,
          HOOK_STATUS.EXPIRED,
          `per-task wake 预算耗尽（任务 ${hook.rootTaskId} fired+pending=${lineageCount} > 预算 ${this.taskWakeBudget}），放弃唤醒`,
        );
        return { done: true };
      }
    }
    const busy = await this.isTargetBusy(target);
    if (busy) {
      // guardrail #6：每次 busy 否决 busyRetries +1（skipReason 照写不缺席）；
      // 满 HOOK_BUSY_MAX_RETRIES 次改判 expired（防无界重排烧模型成本）。
      const retries = await this.noteBusyRetry(
        hook.id,
        { skipReason: busy },
        hook.busyRetries,
        hook,
      );
      if (retries >= this.busyMaxRetries) {
        await this.settleHook(
          hook.id,
          HOOK_STATUS.EXPIRED,
          `目标持续 busy（${busy}），重试满 ${this.busyMaxRetries} 次，放弃唤醒`,
        );
        return { done: true };
      }
      if (now.getTime() + HOOK_BUSY_RETRY_MS_DEFAULT >= hook.expiresAt.getTime()) {
        await this.settleHook(
          hook.id,
          HOOK_STATUS.EXPIRED,
          `过期前仍 busy（${busy}），放弃唤醒`,
        );
        return { done: true };
      }
      return { rescheduleAt: new Date(now.getTime() + HOOK_BUSY_RETRY_MS_DEFAULT) };
    }
    let wakeSessionId: string | undefined;
    try {
      wakeSessionId = await this.dispatchWake(hook, target);
    } catch (err) {
      const reason = `wake 分派失败（留 pending 待下轮）：${describeHookError(err)}`;
      // 分派失败走同一重试梯（busyRetries 共用计数，满 N 次同样改判 expired）。
      const retries = await this.noteBusyRetry(
        hook.id,
        { lastError: reason },
        hook.busyRetries,
        hook,
      );
      if (retries >= this.busyMaxRetries) {
        await this.settleHook(hook.id, HOOK_STATUS.EXPIRED, `${reason}（重试满 ${this.busyMaxRetries} 次）`);
        return { done: true };
      }
      if (now.getTime() + HOOK_BUSY_RETRY_MS_DEFAULT >= hook.expiresAt.getTime()) {
        await this.settleHook(hook.id, HOOK_STATUS.EXPIRED, reason);
        return { done: true };
      }
      return { rescheduleAt: new Date(now.getTime() + HOOK_BUSY_RETRY_MS_DEFAULT) };
    }
    await this.markFired(hook.id, wakeSessionId);
    return { done: true };
  }

  /**
   * 全局 `hook_poll` handler（N 个 hook 共用一次 tick，非 per-hook 轮询）。
   *
   * pending `all_idle` 按 createdAt 取至多 100 行逐个评估：
   * - 过期 → `expired`，继续；
   * - DB 谓词（scope 内无 `running` 会话 **且** `now - max(lastActivityAt) >=
   *   graceMs`）不满足 → 继续（非否决，不写 `skipReason`）；
   * - 目标失效 → `expired`，继续；
   * - 内存否决（本进程 mid-turn）→ 写 `skipReason`，继续；
   * - 首个成功唤醒 → 落 `fired` + 配套 fire 行 cancel，本 tick 结束
   *  （`HOOK_POLL_WAKES_PER_TICK = 1`，其余命中排队等下轮）。
   */
  async handleHookPoll(): Promise<TriggerOutcome> {
    const now = new Date();
    const hooks = (await this.prisma.hook.findMany({
      where: { status: HOOK_STATUS.PENDING, kind: HOOK_KIND.ALL_IDLE },
      orderBy: { createdAt: 'asc' },
      take: HOOK_POLL_BATCH_LIMIT,
    })) as unknown as HookRow[];
    let wakes = 0;
    for (const hook of hooks ?? []) {
      if (wakes >= HOOK_POLL_WAKES_PER_TICK) {
        break;
      }
      if (now.getTime() >= hook.expiresAt.getTime()) {
        await this.settleHook(hook.id, HOOK_STATUS.EXPIRED, 'hook 已过期（poll 时结算）');
        continue;
      }
      let quiet: boolean;
      try {
        quiet = await this.isScopeQuiet(
          hook.scopeType,
          hook.scopeId,
          hook.graceMs ?? this.allIdleGraceMs,
          now,
        );
      } catch (err) {
        this.logger.warn(
          `[hook] poll 静默评估失败 hook=${hook.id}（fail-open，本 tick 跳过）: ${describeHookError(err)}`,
        );
        continue;
      }
      if (!quiet) {
        continue;
      }
      const target = await this.resolveWakeTarget(hook);
      if (target.ok === false) {
        await this.settleHook(hook.id, HOOK_STATUS.EXPIRED, target.reason);
        continue;
      }
      // guardrail #4 双重熄火（poll 侧）：同 fire 侧复核逻辑。
      if (hook.rootTaskId) {
        const lineageCount = await this.countTaskLineage(hook.rootTaskId);
        if (lineageCount > this.taskWakeBudget) {
          await this.settleHook(
            hook.id,
            HOOK_STATUS.EXPIRED,
            `per-task wake 预算耗尽（任务 ${hook.rootTaskId} fired+pending=${lineageCount} > 预算 ${this.taskWakeBudget}），放弃唤醒`,
          );
          continue;
        }
      }
      const busy = await this.isTargetBusy(target);
      if (busy) {
        // 否决必写 skipReason（plan 硬性要求）+ busyRetries 共用梯；
        // 满 HOOK_BUSY_MAX_RETRIES 次改判 expired（poll 无重排动作，
        // 梯满即终态，否则留 pending 待下轮复核）。
        const retries = await this.noteBusyRetry(
          hook.id,
          { skipReason: busy },
          hook.busyRetries,
          hook,
        );
        if (retries >= this.busyMaxRetries) {
          await this.settleHook(
            hook.id,
            HOOK_STATUS.EXPIRED,
            `目标持续 busy（${busy}），重试满 ${this.busyMaxRetries} 次，放弃唤醒`,
          );
        }
        continue;
      }
      let wakeSessionId: string | undefined;
      try {
        wakeSessionId = await this.dispatchWake(hook, target);
      } catch (err) {
        await this.prisma.hook.update({
          where: { id: hook.id },
          data: {
            lastError: `wake 分派失败（留 pending 待下轮）：${describeHookError(err)}`.slice(
              0,
              191,
            ),
          },
        });
        continue;
      }
      await this.markFired(hook.id, wakeSessionId);
      wakes += 1;
    }
    return { done: true };
  }

  // ------------------------------------------------------------------
  // 内部：静默评估 / 目标解析 / 否决 / 分派
  // ------------------------------------------------------------------

  /**
   * DB 静默谓词：scope 内无 `status='running'` 会话 **且**
   * `now - max(lastActivityAt) >= graceMs`。
   *
   * - `running` 行（`lastActivityAt` NULL 的迁移前存量也一样）→ 直接非静默
   *  （fail-closed：跑没跑不知道时按"在跑"处理）；
   * - 终态（archived/failed）会话不参与 max 计算；
   * - scope 内零候选会话 → 静默（从未活跃即安静）。
   */
  private async isScopeQuiet(
    scopeType: string,
    scopeId: string,
    graceMs: number,
    now: Date,
  ): Promise<boolean> {
    const where =
      scopeType === 'task' ? { taskId: scopeId } : { teamId: scopeId };
    const sessions = (await this.prisma.session.findMany({
      where,
      select: { status: true, lastActivityAt: true },
      take: 500,
    })) as unknown as Array<{
      status: string;
      lastActivityAt: Date | null;
    }>;
    let maxActivity = 0;
    for (const s of sessions ?? []) {
      if (s.status === 'running') {
        return false;
      }
      if (s.status === 'archived' || s.status === 'failed') {
        continue;
      }
      const at = s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0;
      if (Number.isFinite(at) && at > maxActivity) {
        maxActivity = at;
      }
    }
    return now.getTime() - maxActivity >= graceMs;
  }

  /**
   * 唤醒目标在触发时重解析（fire/poll 共用）。
   *
   * 任务删除/终态（completed/archived）、成员删除、会话缺失（reset 后新会话
   * 未建 = 同会话唤醒契约破裂）/终态 → `{ ok: false }`（调用方标 `expired`，
   * 永不抛，永不静默消失）。
   */
  private async resolveWakeTarget(hook: HookRow): Promise<WakeResolution> {
    const target = parseHookTarget(hook.target);
    if (!target) {
      return { ok: false, reason: 'target 非法（缺 channelId/targetInstanceId）' };
    }
    let taskTeamId: string | null = null;
    if (target.taskId) {
      const task = (await this.prisma.task.findUnique({
        where: { id: target.taskId },
        select: { status: true, teamId: true },
      })) as unknown as { status: string; teamId: string | null } | null;
      if (!task) {
        return { ok: false, reason: `任务 ${target.taskId} 已删除` };
      }
      if (task.status === 'completed' || task.status === 'archived') {
        return {
          ok: false,
          reason: `任务 ${target.taskId} 已终态（status=${task.status}）`,
        };
      }
      taskTeamId = task.teamId;
    }
    const member = (await this.prisma.teamMember.findUnique({
      where: { id: target.targetInstanceId },
      select: { id: true, teamId: true },
    })) as unknown as { id: string; teamId: string } | null;
    if (!member) {
      return {
        ok: false,
        reason: `成员 ${target.targetInstanceId} 已删除（实例不在团队）`,
      };
    }
    const teamId = target.teamId ?? taskTeamId ?? member.teamId ?? null;
    if (!teamId) {
      return { ok: false, reason: '目标无团队归属（无法定位会话）' };
    }
    const session = (await this.prisma.session.findFirst({
      where: { teamId, teamMemberId: target.targetInstanceId },
      select: { id: true, status: true },
    })) as unknown as { id: string; status: string } | null;
    if (!session) {
      return {
        ok: false,
        reason: `会话已重置/缺失（团队 ${teamId} 成员 ${target.targetInstanceId} 无绑定会话，同会话唤醒契约破裂）`,
      };
    }
    if (session.status === 'archived' || session.status === 'failed') {
      return {
        ok: false,
        reason: `会话 ${session.id} 已终态（status=${session.status}）`,
      };
    }
    return {
      ok: true,
      taskId: target.taskId ?? null,
      teamId,
      channelId: target.channelId,
      targetInstanceId: target.targetInstanceId,
    };
  }

  /**
   * 内存否决（in-memory veto，本进程 mid-turn 保护；plan decision 14：
   * v1 单 `server` 副本前提——以下检查只看见本进程，多副本需 leader 选举）：
   * - 目标会话在首字看门狗中（刚分派，DB 侧尚未 `running`）→ 否决；
   * - 目标会话 DB 侧 `running`（别进程分派）→ 否决；
   * - `isAgentExecuting` 命中目标实例 → 否决。
   *
   * 返回否决原因（调用方必写 `skipReason`），不否决返回 null。
   * 只读 dispatcher 内存表，语义零改动（todo-7 `markSessionIdleDead` 同款复用）。
   */
  private async isTargetBusy(
    target: Extract<WakeResolution, { ok: true }>,
  ): Promise<string | null> {
    const session = (await this.prisma.session.findFirst({
      where: { teamId: target.teamId, teamMemberId: target.targetInstanceId },
      select: { id: true, status: true, workerId: true },
    })) as unknown as { id: string; status: string; workerId: string | null } | null;
    if (!session) {
      return null;
    }
    if (this.dispatcher.isSessionPending(session.id)) {
      return `veto: 会话 ${session.id} 首字等待中（本进程刚分派，DB 侧尚未 running）`;
    }
    if (session.status === 'running') {
      return `veto: 会话 ${session.id} 仍 running（mid-turn，不唤醒）`;
    }
    if (session.workerId) {
      const active = this.dispatcher.isAgentExecuting(
        session.workerId,
        toExecutionScope(null, target.teamId),
      );
      if (active !== null && active.has(target.targetInstanceId)) {
        return `veto: 成员 ${target.targetInstanceId} 本进程活跃执行中（mid-turn，不唤醒）`;
      }
    }
    return null;
  }

  /**
   * 唤醒分派（`kind: 'wake'` 豁免计划门禁/节流/回执台账，见 worker-dispatcher）。
   * 返回被唤醒的目标会话主键（调用方回写 `target.wakeSessionId`，供后续失败记录关联）。
   */
  private async dispatchWake(
    hook: HookRow,
    target: Extract<WakeResolution, { ok: true }>,
  ): Promise<string> {
    const text = buildHookWakeText(hook.kind, hook.id, hook.wakeText);
    if (target.taskId) {
      return await this.dispatcher.dispatchAgentMention({
        taskId: target.taskId,
        channelId: target.channelId,
        text,
        targetInstanceId: target.targetInstanceId,
        kind: 'wake',
      });
    }
    return await this.dispatcher.dispatchAgentMention({
      teamId: target.teamId,
      channelId: target.channelId,
      text,
      targetInstanceId: target.targetInstanceId,
      kind: 'wake',
    });
  }

  /** 全局 poll 行幂等确保（一域一行；pending 留，终态删后重建，mirror progression）。 */
  private async ensureGlobalPoll(): Promise<void> {
    try {
      const existing = await this.prisma.trigger.findUnique({
        where: { dedupKey: HOOK_POLL_DEDUP_KEY },
      });
      if (existing) {
        if (existing.status === TRIGGER_STATUS.PENDING) {
          return;
        }
        await this.prisma.trigger
          .delete({ where: { dedupKey: HOOK_POLL_DEDUP_KEY } })
          .catch(() => null);
      }
      await this.triggers.schedule(
        TRIGGER_KIND.HOOK_POLL as string,
        new Date(Date.now() + this.pollIntervalMs),
        { scope: 'global', purpose: 'all_idle 统一扫描（非 per-hook 轮询）' },
        HOOK_POLL_DEDUP_KEY,
        { intervalMs: this.pollIntervalMs },
      );
    } catch (err) {
      this.logger.warn(
        `全局 hook_poll 行确保失败（本进程 poll 不跑，fire 路径不受影响）: ${describeHookError(err)}`,
      );
    }
  }

  private async markFired(
    hookId: string,
    wakeSessionId?: string,
  ): Promise<void> {
    const hook = (await this.prisma.hook.update({
      where: { id: hookId },
      data: { status: HOOK_STATUS.FIRED, fireCount: { increment: 1 } },
    })) as unknown as HookRow | null;
    // wakeSessionId 回写 target Json（无新列/无迁移；parseHookTarget 容忍额外键）：
    // 供 wake 失败记录按 target.wakeSessionId 关联回本 hook。失败仅 warn——
    // 分派已接受，hook 照落 fired，不因回写失败回滚。
    if (wakeSessionId && hook) {
      try {
        await this.prisma.hook.update({
          where: { id: hookId },
          data: { target: withWakeSessionId(hook.target, wakeSessionId) },
        });
      } catch (err) {
        this.logger.warn(
          `hook ${hookId} wakeSessionId=${wakeSessionId} 回写 target 失败（fired 状态不受影响，失败记录可能缺关联）: ${describeHookError(err)}`,
        );
      }
    }
    // poll 唤醒的 all_idle 行：配套 fire 兜底行已无用，cancel 掉（best-effort；
    // 即便残留，fire handler 见 fired 也 no-op，永不误唤醒）。
    try {
      await this.triggers.cancel(buildHookFireDedupKey(hookId));
    } catch (err) {
      this.logger.warn(
        `hook ${hookId} 配套 fire 行清理失败（已 fired，残留无害）: ${describeHookError(err)}`,
      );
    }
    if (hook) {
      await this.emitTriggerLifecycle(EVENT_TYPES.TRIGGER_FIRED, hook, {
        status: HOOK_STATUS.FIRED,
        fireCount: hook.fireCount,
      });
    }
  }

  /**
   * 记录一次 wake 执行失败（trigger-unification 失败记录缝）。
   *
   * 背景：`markFired` 语义是「分派被接受」，不是「agent 跑成功」；被唤醒会话
   * 随后 `agent.error` / `session.updated(failed)` 时，hook 仍是 `fired` 且
   * lastError/skipReason 为 NULL——真失败与成功在库里不可分辨。本方法把真实
   * 下游原因**记录**到 hook + 配对 `hook_fire` 触发器行 + 一条 realtime 事件，
   * **不改 `fired` 状态**（其余分支依赖该语义）。
   *
   * 幂等（认领式）：hook 行以 `lastError: null` 为认领谓词 `updateMany`——
   * 同一会话多次失败事件只有首个（`count === 1`）落库，重复事件零副作用、
   * 不刷屏。会话已轮转（hook 已易主/wakeSessionId 已更新）或非 fired → no-op。
   *
   * 永不抛（调用方为 realtime 订阅者）：失败仅 warn。
   */
  async recordWakeFailure(input: {
    sessionId: string;
    reason: string;
  }): Promise<boolean> {
    const sessionId = input.sessionId;
    if (!sessionId) {
      return false;
    }
    try {
      const hook = (await this.prisma.hook.findFirst({
        where: {
          status: HOOK_STATUS.FIRED,
          target: { path: '$.wakeSessionId', equals: sessionId },
        },
      })) as unknown as HookRow | null;
      if (!hook) {
        return false;
      }
      const text = (input.reason || 'wake 执行失败（未携带原因）').slice(0, 191);
      // 认领：lastError 仍为 NULL 才写（并发/重复事件败者静默）。
      const claimed = await this.prisma.hook.updateMany({
        where: { id: hook.id, status: HOOK_STATUS.FIRED, lastError: null },
        data: { lastError: text, skipReason: text },
      });
      if (claimed.count !== 1) {
        return false;
      }
      await this.prisma.trigger.updateMany({
        where: { dedupKey: buildHookFireDedupKey(hook.id) },
        data: { lastError: text, skipReason: text },
      });
      await this.emitTriggerLifecycle(
        TRIGGER_WAKE_FAILED_EVENT_TYPE,
        hook,
        {
          status: HOOK_STATUS.FIRED,
          wakeSessionId: sessionId,
          lastError: text,
          skipReason: text,
        },
      );
      return true;
    } catch (err) {
      this.logger.warn(
        `hook wake 失败记录失败 session=${sessionId}（仅观测缺口，不回滚 fired）: ${describeHookError(err)}`,
      );
      return false;
    }
  }

  private async settleHook(
    hookId: string,
    status: string,
    reason: string,
  ): Promise<void> {
    const text = reason.slice(0, 191);
    await this.prisma.hook.update({
      where: { id: hookId },
      data: { status, lastError: text, skipReason: text },
    });
    if (status === HOOK_STATUS.EXPIRED) {
      const hook = (await this.prisma.hook.findUnique({
        where: { id: hookId },
      })) as unknown as HookRow | null;
      if (hook) {
        await this.emitTriggerLifecycle(EVENT_TYPES.TRIGGER_EXPIRED, hook, {
          status: HOOK_STATUS.EXPIRED,
          skipReason: text,
          reason: text,
        });
      }
    }
  }

  /**
   * 同一 rootTaskId 下 fired+pending 血缘行计数（guardrail #4 注册/fire 双侧共用）。
   *
   * 只读预算+1 行即够判定；cancelled/expired 终态行不计（已结算不消耗唤醒）；
   * 走 `(root_task_id, status)` 索引（todo-19 迁移新增），不全表扫。
   */
  private async countTaskLineage(rootTaskId: string): Promise<number> {
    const rows = (await this.prisma.hook.findMany({
      where: {
        rootTaskId,
        status: { in: [HOOK_STATUS.PENDING, HOOK_STATUS.FIRED] },
      },
      select: { id: true },
      take: this.taskWakeBudget + 1,
    })) as unknown as Array<{ id: string }>;
    return (rows ?? []).length;
  }

  /**
   * busy/分派失败重试梯（guardrail #6）：skipReason/lastError 照写 + busyRetries
   * 原子 +1，返回递增后次数（调用方满 HOOK_BUSY_MAX_RETRIES 即改判 expired）。
   *
   * 次数取行快照 +1（同一 hook 同一时刻只有一个 fire 行被 claim，串行递增无竞态）。
   * 否决事件有界：`trigger.skipped` 仅首轮否决（current 为 0）发射一次——
   * 后续同因重排只写列不发事件（poll 每 30s 一 tick，无界否决会刷屏
   * realtime_events）；列值永远最新，终态 expired 事件带最终原因。
   */
  private async noteBusyRetry(
    hookId: string,
    patch: { skipReason?: string; lastError?: string },
    current: number | null | undefined,
    hook: HookRow,
  ): Promise<number> {
    const next = (current ?? 0) + 1;
    const data: Record<string, unknown> = {
      busyRetries: { increment: 1 },
    };
    if (typeof patch.skipReason === 'string') {
      data['skipReason'] = patch.skipReason.slice(0, 191);
    }
    if (typeof patch.lastError === 'string') {
      data['lastError'] = patch.lastError.slice(0, 191);
    }
    await this.prisma.hook.update({ where: { id: hookId }, data });
    if (typeof patch.skipReason === 'string' && (current ?? 0) === 0) {
      await this.emitTriggerLifecycle(EVENT_TYPES.TRIGGER_SKIPPED, hook, {
        status: HOOK_STATUS.PENDING,
        skipReason: patch.skipReason.slice(0, 191),
        busyRetries: next,
      });
    }
    return next;
  }

  /**
   * trigger 生命周期事件（todo-20）：best-effort 落 realtime_events + 广播，
   * 失败仅 warn（事件丢了行终态照结算，可观测永不阻断唤醒）。
   * scope 沿 hook 归属（team/task/global），payload 含调试五件套。
   */
  private async emitTriggerLifecycle(
    type: string,
    hook: HookRow,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (!this.realtime) {
      return;
    }
    const scope = hookScopeOf(hook);
    try {
      await this.realtime.emit(
        type,
        {
          hookId: hook.id,
          kind: hook.kind,
          scopeType: hook.scopeType,
          scopeId: hook.scopeId,
          ownerInstanceId: hook.ownerInstanceId,
          ...extra,
        },
        scope,
      );
    } catch (err) {
      this.logger.warn(
        `hook ${hook.id} 生命周期事件 ${type} 落库失败（行终态不受影响）: ${describeHookError(err)}`,
      );
    }
  }

  /**
   * 环检测（guardrail #5，图感知——替代被 Oracle 否决的 session-depth 计数器）。
   *
   * 为什么不能只用计数器：
   * - `reuseSession=true` 跨任务复用同一 session，没有 per-turn 挂载点可挂 depth；
   * - A↔B ping-pong 里单个 owner 的注册次数永远是 1（A 注册一次、B 注册一次
   *   交替），任何按 owner/scope 的计数器都看不见环。
   * 故沿 `parentHookId` 回溯整条血缘链（hook 行永不 DELETE，链不断），三层判据：
   *  1) 链深：祖先数 >= taskWakeBudget（新 hook 将是第 N+1 代）→ 拒绝；
   *  2) 同任务对穿：祖先与本次同 rootTaskId（非空）且满足其一 → 拒绝：
   *     a. 自环——同 owner + 同 target + 同归一化 wakeText（自己唤醒自己）；
   *     b. 对穿——祖先 owner == 本次 target 且祖先 target == 本次 owner
   *        （A 唤 B、B 唤 A 的 ping-pong，不依赖计数）；
   *  3) 跨任务回退：rootTaskId 不同（无任务归属的 team 域链）但 owner/target
   *     对穿回显、且 wakeText 归一化相似（相等或长文本包含）→ 拒绝。
   *     同对复现（同 agent 在新任务立同类提醒）不拦——合法复用；相似另设最小长度
   *     （HOOK_WAKE_SIMILAR_MIN_LEN），短词（"ok"/"wake"）不判，
   *     防合法新任务被误伤——per-task 隔离：无 parent 链的新任务注册
   *     根本无祖先可比，永不拦截。
   *
   * 返回拒绝原因（调用方 loud throw），无环返回 null。
   */
  private async detectHookCycle(
    parent: HookRow,
    input: RegisterHookInput,
    rootTaskId: string | null,
  ): Promise<string | null> {
    const ancestors: HookRow[] = [];
    let cursor: HookRow | null = parent;
    const seen = new Set<string>();
    while (cursor && ancestors.length < HOOK_LINEAGE_WALK_LIMIT) {
      if (seen.has(cursor.id)) {
        return `检测到 hook 唤醒环（血缘链在 ${cursor.id} 处成环，拒绝注册）`;
      }
      seen.add(cursor.id);
      ancestors.push(cursor);
      if (!cursor.parentHookId) {
        break;
      }
      const next = (await this.prisma.hook.findUnique({
        where: { id: cursor.parentHookId },
      })) as unknown as HookRow | null;
      if (!next) {
        break;
      }
      cursor = next;
    }
    if (ancestors.length >= this.taskWakeBudget) {
      return `hook 血缘链过深（祖先 ${ancestors.length} 个 >= 预算 ${this.taskWakeBudget}，疑似唤醒环，拒绝注册）`;
    }
    const inputTarget = parseHookTarget(input.target);
    const inputWake = normalizeWakeText(input.wakeText);
    for (const anc of ancestors) {
      const ancTarget = parseHookTarget(anc.target);
      const sameTask =
        !!rootTaskId && !!anc.rootTaskId && anc.rootTaskId === rootTaskId;
      if (sameTask && inputTarget && ancTarget) {
        const sameOwner = anc.ownerInstanceId === input.ownerInstanceId;
        const sameAim =
          ancTarget.targetInstanceId === inputTarget.targetInstanceId &&
          (ancTarget.taskId ?? null) === (inputTarget.taskId ?? null) &&
          ancTarget.channelId === inputTarget.channelId;
        if (sameOwner && sameAim && anc.wakeText === input.wakeText) {
          return `检测到 hook 自环（祖先 ${anc.id} 同 owner 同目标同唤醒词，拒绝注册）`;
        }
        // 对穿要求真交替（A≠B）：自指 hook（owner==target，常见自唤）续注册
        // 不是 ping-pong——无此条件 todo-11 的合法续注册会被误杀。
        const crossDirected =
          anc.ownerInstanceId !== ancTarget.targetInstanceId;
        const swapped =
          crossDirected &&
          anc.ownerInstanceId === inputTarget.targetInstanceId &&
          ancTarget.targetInstanceId === input.ownerInstanceId;
        if (swapped) {
          return `检测到 hook A↔B 对穿环（祖先 ${anc.id} 与本次 owner/target 互换，任务 ${rootTaskId}，拒绝注册）`;
        }
      }
      if (!sameTask && inputTarget && ancTarget) {
        // 跨任务回退只认"对穿回显"（owner/target 互换 + 唤醒词相似）：
        // 无 parent 链的新任务注册根本走不到这里（无祖先可比），
        // 同对复现（同 agent 在新任务立同类提醒）不拦——那是合法复用，
        // 且真失控时链深规则（1）照样在第 N 代切断。
        const echoSwap =
          anc.ownerInstanceId !== ancTarget.targetInstanceId &&
          anc.ownerInstanceId === inputTarget.targetInstanceId &&
          ancTarget.targetInstanceId === input.ownerInstanceId;
        if (
          echoSwap &&
          wakeTextsSimilar(anc.wakeText, inputWake) &&
          anc.status !== HOOK_STATUS.CANCELLED
        ) {
          return `检测到跨任务 hook 复读环（祖先 ${anc.id} 任务 ${anc.rootTaskId ?? '?'} owner/target 回显 + 唤醒词相似，拒绝注册）`;
        }
      }
    }
    return null;
  }
}

/** hook 归属 → realtime scope（team/task 直标，其余 global；SSE 订阅与 DB 行同口径）。 */
function hookScopeOf(hook: { scopeType: string; scopeId: string }): RealtimeScope {
  if (hook.scopeType === 'team' || hook.scopeType === 'task') {
    return { type: hook.scopeType, id: hook.scopeId };
  }
  return { type: 'global' };
}

  /** `tmr_` 前缀常量复用（fire 行 id 经同一 IdGeneratorService 生成）。 */
const TRIGGER_ID_PREFIX_VALUE = 'tmr';

/** hook.target JSON 窄化（非法 → null，调用方标 expired）。 */
export function parseHookTarget(target: unknown): HookTarget | null {
  if (typeof target !== 'object' || target === null) {
    return null;
  }
  const t = target as Record<string, unknown>;
  if (typeof t['channelId'] !== 'string' || !t['channelId']) {
    return null;
  }
  if (typeof t['targetInstanceId'] !== 'string' || !t['targetInstanceId']) {
    return null;
  }
  return {
    taskId:
      typeof t['taskId'] === 'string' && t['taskId'] ? t['taskId'] : null,
    teamId:
      typeof t['teamId'] === 'string' && t['teamId'] ? t['teamId'] : null,
    channelId: t['channelId'],
    targetInstanceId: t['targetInstanceId'],
    wakeSessionId:
      typeof t['wakeSessionId'] === 'string' && t['wakeSessionId']
        ? t['wakeSessionId']
        : null,
  };
}

/** 在既有 target Json 上叠加 wakeSessionId（保留其余键，存量行零影响）。 */
function withWakeSessionId(
  target: unknown,
  wakeSessionId: string,
): Prisma.InputJsonValue {
  const base =
    typeof target === 'object' && target !== null
      ? (target as Record<string, unknown>)
      : {};
  return { ...base, wakeSessionId } as Prisma.InputJsonValue;
}

/** 血缘回溯：从 hook.target 取 taskId（parent 链首任务兜底）。 */
function targetTaskId(target: unknown): string | null {
  return parseHookTarget(target)?.taskId ?? null;
}

/** 唤醒词归一（跨任务复读判据用：小写 + 空白坍缩 + 去首尾）。 */
function normalizeWakeText(text: string): string {
  return (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 唤醒词相似（跨任务 ping-pong 回退判据）：归一化后相等，或长文本包含。
 * 短文本（< HOOK_WAKE_SIMILAR_MIN_LEN）永不判相似——"ok"/"wake" 类短词
 * 在合法新任务里太常见，判了即误伤。
 */
function wakeTextsSimilar(ancestorText: string, inputNormalized: string): boolean {
  const a = normalizeWakeText(ancestorText);
  const b = inputNormalized;
  if (a.length < HOOK_WAKE_SIMILAR_MIN_LEN || b.length < HOOK_WAKE_SIMILAR_MIN_LEN) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

function describeHookError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
