import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { TASK_STATUS } from '../common/constants/task.constants';
import { ISSUE_STATUS } from '../issues/issues.constants';
import {
  TRIGGER_KIND,
  buildTriggerDedupKey,
} from '../common/constants/trigger.constants';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { RealtimeEvent, RealtimeService } from '../realtime/realtime.service';
import {
  TRIGGER_STATUS,
  TriggerService,
  type TriggerFireContext,
} from '../timers/trigger.service';

/**
 * 巡检间隔 ms（env PROGRESSION_INTERVAL_MS，缺省 10min）。
 *
 * 2026-09-16 由 5min 上调至 20min（巡检风暴教训）；2026-09-21 回调至 10min：
 * 看门狗只在"静默"时叫醒（活跃跳过不计轮次）+ 3 连静默自动置阻塞停嘴，
 * 噪音有界，不再是无差别 12 连发。
 */
export const DEFAULT_PROGRESSION_INTERVAL_MS = 10 * 60_000;
/** 巡检轮次上限（env PROGRESSION_MAX_ROUNDS，缺省 6；达到后注销 + 告警防空转）。 */
export const DEFAULT_PROGRESSION_MAX_ROUNDS = 6;
/** 连续静默巡检上限：达到即自动置阻塞（blocked）并群公告，停嘴等人工。 */
export const STALL_QUIET_STREAK_LIMIT = 3;
/**
 * 停滞在途 issue 状态：命中即视为"有人在干活"，递延停滞检查不置阻塞。
 * issue 状态机（issues.constants）只有 open/in_progress/resolved/closed/rejected
 * 五态，无 pending_review——在途唯一对应 in_progress；open=尚未开工、
 * resolved/closed/rejected=已完工，均不算在途（沿旧行为可置阻塞）。
 */
export const STALL_INFLIGHT_ISSUE_STATUSES = [
  ISSUE_STATUS.in_progress,
] as const;
/**
 * 停滞聊天活跃窗口 ms（env STALL_CHAT_ACTIVITY_WINDOW_MS，缺省 10min）：
 * 任务分区（messages.task_id）内有新消息即视为在途，递延停滞检查。
 */
export const DEFAULT_STALL_CHAT_ACTIVITY_WINDOW_MS = 10 * 60_000;
/** 巡检扫描周期 ms（旧 setInterval 驱动已退役，见类注释；保留导出防外部引用 churn）。 */
export const PROGRESSION_SCAN_INTERVAL_MS = 30_000;

/**
 * 巡检冷却 guard key（TriggerService condition 形态；todo-8 注册）。
 * guard=false → 留 pending 待下轮复核（不消耗轮次）；谓词内异常 → fail-open 放行。
 */
export const PROGRESSION_COOLDOWN_GUARD = 'progression_cooldown';

/**
 * 巡检触发器 dedupKey：`progression_patrol:task:<taskId>`（一任务一行，幂等排期）。
 */
export function buildProgressionDedupKey(taskId: string): string {
  return buildTriggerDedupKey(TRIGGER_KIND.PROGRESSION_PATROL, 'task', taskId);
}

/** 巡检触发器行 payload：taskId 归属任务；quietStreak 连续静默轮次（canonical 持久化，随行生灭，重启不丢）。 */
interface ProgressionPatrolPayload {
  taskId: string;
  quietStreak?: number;
}

/** 巡检消息 prompt（引导而非写死动作——主 Agent 经 MCP 工具自主决策）。 */
export function buildProgressionPrompt(title: string, status: string): string {
  return (
    `【任务巡检】任务 <${title}> 当前状态 <${status}>。请检查：` +
    '① 各 issue 完成度 ② 产出物是否齐全 ③ 团队进展；' +
    '若存在卡点（成员未响应/依赖缺失/issue 未解决），通过 notify_agent 或群聊 @ 定向通知对应成员推进；' +
    '若全部工作完成，调用 task_transition mark-pending-review 提交验收；如尚未完成请说明当前进展与下一步。'
  );
}

/**
 * 任务巡检调度器 + 托管确认路由（todo-8 起 interval 巡检走 TriggerService 持久化）。
 *
 * 功能 1（主 Agent 定期巡检）：TriggerService interval 行（kind=`progression_patrol`，
 * 一任务一行，dedupKey=`progression_patrol:task:<taskId>`）：
 * - register(taskId)：任务进入 in_progress（start/reject）时排期（intervalMs=巡检间隔、
 *   maxFires=轮次上限、guardKey=冷却否决）；幂等：pending 行已存在 → 直接保留
 *   （fireCount/quietStreak 不清零——重启安全核心）。
 * - unregister(taskId)：任务离开 in_progress 时 cancel 触发器（行留 cancelled 备查）。
 * - 轮次计数：rounds ≡ trigger.fireCount（基座每次触发后 +1 并落库，重启不丢）；
 *   maxRounds ≡ maxFires（基座 claim 前 + 触发后双重强制熄火，非内存计数）。
 * - 冷却否决：guard 谓词内仍查 `isSessionPending`/`getSessionLastActivityAt`
 *  （否决 → 留 pending 待 ticker 下轮复核，不消耗轮次；谓词异常 → fail-open 放行）。
 * - 触发器行即唯一状态源：isRegistered 查 pending 行是否存在；patrolNow/scan 均派生
 *   自触发器行；连续静默轮次 quietStreak 随行 payload 持久化（叫醒累加、观测活跃清零、
 *   达 STALL_QUIET_STREAK_LIMIT 自动置阻塞）。
 * - 自主 setInterval 扫描已退役（与 trigger ticker 双驱动会重复下发 wake 消息）；
 *   scan() 保留为按需例程（spec/手工巡检：遍历 pending 触发器行派生到期巡检），
 *   生产节拍唯一来自 trigger ticker。
 *
 * 功能 2（托管确认路由）：订阅 realtime bus 的 agent.question 事件，payload.managed=true 且
 * 未收敛（resolved≠true）→ dispatch 确认请求消息给主 Agent（question_confirm 决策指令）。
 */
@Injectable()
export class TaskProgressionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskProgressionScheduler.name);

  /**
   * 巡检触发器 delegate：直接使用 PrismaService 生成的真实类型。
   * 调用点保留可选链，兼容旧测试替身缺少 delegate 时的 fail-open 语义。
   */
  private patrolTriggerRows(): PrismaService['trigger'] {
    return this.prisma.trigger;
  }

  /** 巡检间隔 ms（env PROGRESSION_INTERVAL_MS，缺省 20min；公开便于测试覆盖）。 */
  public progressionIntervalMs: number;
  /** 巡检轮次上限（env PROGRESSION_MAX_ROUNDS，缺省 6；映射为触发器 maxFires 由基座强制）。 */
  public maxRounds: number;
  /** 停滞聊天活跃窗口 ms（env STALL_CHAT_ACTIVITY_WINDOW_MS，缺省 10min；公开便于测试覆盖）。 */
  public stallChatActivityWindowMs: number;

  /** realtime bus 订阅取消函数（托管确认请求路由）。 */
  private unsubscribe: (() => void) | null = null;

  /** 停滞回调（TasksService 注册：连续静默达上限 → systemBlock 置阻塞）。 */
  private readonly stallHandlers: Array<{
    (taskId: string, reason: string): void;
  }> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly workerDispatcher: WorkerDispatcher,
    config: ConfigService,
    @Optional()
    @Inject('MessageQuestionDispatcher')
    private readonly questionDispatcher?: {
      dispatchQuestionCard: (
        taskId: string,
        q: { id: string; requestId?: string; kind: string; content: any },
      ) => Promise<void>;
    },
    // todo-8：TriggerService 可选注入（缺席时仅内存循环工作，spec 旧用例零 provider 可编译）。
    @Optional()
    private readonly triggers?: TriggerService,
    // IdGeneratorService 可选注入（停滞群公告落库用；缺席时跳过公告，巡检照常）。
    @Optional()
    private readonly idGen?: IdGeneratorService,
  ) {
    // env 经 ConfigService 返回字符串，Number() 归一（非法/缺省 → 默认值）
    const interval = Number(config.get('PROGRESSION_INTERVAL_MS'));
    this.progressionIntervalMs =
      Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_PROGRESSION_INTERVAL_MS;
    const rounds = Number(config.get('PROGRESSION_MAX_ROUNDS'));
    this.maxRounds =
      Number.isFinite(rounds) && rounds > 0
        ? rounds
        : DEFAULT_PROGRESSION_MAX_ROUNDS;
    const chatWindow = Number(config.get('STALL_CHAT_ACTIVITY_WINDOW_MS'));
    this.stallChatActivityWindowMs =
      Number.isFinite(chatWindow) && chatWindow > 0
        ? chatWindow
        : DEFAULT_STALL_CHAT_ACTIVITY_WINDOW_MS;
  }

  async onModuleInit(): Promise<void> {
    // 巡检 handler + 冷却 guard 接线（TriggerService 缺席时 no-op，内存循环照常）。
    this.registerProgressionTrigger();
    // periodic patrol 已退役：清扫库内遗留的 pending progression_patrol 触发器行
    //（fan-out JOIN drain 接管唤醒职责，旧 interval 行会重复下发 wake 消息）。
    await this.cancelStalePatrolTriggers();
    // 数据修复：库内 in_progress 任务逐个 register（pending 触发器行保留 fireCount，
    // 终态/缺失行重建——重启不再清零 rounds）。
    await this.restoreInProgressTasks();
    // 托管模式确认请求路由：订阅 realtime bus 的 agent.question 事件（payload.managed=true）
    this.unsubscribe = this.realtime.subscribe((event) => {
      if (event.type !== EVENT_TYPES.AGENT_QUESTION) {
        return;
      }
      void this.routeManagedQuestion(event).catch((err: unknown) =>
        this.logger.error(`托管确认路由失败: ${this.describeError(err)}`),
      );
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * 巡检 handler + 冷却 guard 接线（幂等覆盖注册；TriggerService 缺席时 no-op）。
   *
   * NOTE: periodic patrol 巡检已退役——fan-out JOIN drain 取代了定期巡检的唤醒职责。
   * 这里仅注册 handler/guard 的接线（fail-open），不排任何 interval 行。
   */
  private registerProgressionTrigger(): void {
    if (!this.triggers) {
      return;
    }
    try {
      this.triggers.registerGuard(PROGRESSION_COOLDOWN_GUARD, (ctx) =>
        this.progressionCooldownGuard(ctx),
      );
      this.triggers.registerHandler(TRIGGER_KIND.PROGRESSION_PATROL, (ctx) =>
        this.handleProgressionFire(ctx),
      );
    } catch (err) {
      this.logger.warn(
        `[progression] 触发器接线失败（按需 scan 巡检继续）: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * 任务进入 in_progress 时注册（start/reject）。幂等：触发器侧 pending 行已存在 →
   * 直接保留（fireCount/quietStreak 不清零）。
   * 非 in_progress 或主 Agent 缺失 → 不排期（防脏行）。
   */
  async register(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, status: true, teamId: true },
    });
    if (!task || task.status !== TASK_STATUS.in_progress) {
      return;
    }
    const mainMemberId = await this.mainMemberOfTask(
      (task as any).teamId ?? null,
    );
    if (!mainMemberId) {
      return;
    }
    this.logger.log(
      `[progression] 注册巡检 taskId=${taskId}（interval=${this.progressionIntervalMs}ms, maxRounds=${this.maxRounds}）`,
    );
    await this.persistPatrolTrigger(taskId);
  }

  /**
   * 巡检触发器持久化：排 interval 行（intervalMs=巡检间隔、maxFires=轮次上限、
   * guardKey=冷却否决），一任务一行（dedupKey 幂等，pending 行保留 fireCount）。
   * 看门狗复活：静默任务靠 ticker 节拍叫醒；活跃任务被 guard/skip 放过不计轮次。
   */
  private async persistPatrolTrigger(taskId: string): Promise<void> {
    if (!this.triggers) {
      return;
    }
    // 一任务一行：pending 行保留（fireCount 不清零）；终态行先删后建，
    // 否则基座按 dedupKey 幂等回旧行、resume 后巡检永不恢复。
    const dedupKey = buildProgressionDedupKey(taskId);
    try {
      const existing = (await this.patrolTriggerRows()?.findUnique?.({
        where: { dedupKey },
      })) as { status?: string } | null | undefined;
      if (existing) {
        if (existing.status === TRIGGER_STATUS.PENDING) {
          return;
        }
        try {
          await this.patrolTriggerRows()?.delete?.({
            where: { dedupKey },
          });
        } catch {
          // fail-open：终态行删除失败仅跳过重建，下次 register 重试。
        }
      }
      await this.triggers.schedule(
        TRIGGER_KIND.PROGRESSION_PATROL,
        new Date(Date.now() + this.progressionIntervalMs),
        { taskId },
        dedupKey,
        {
          intervalMs: this.progressionIntervalMs,
          maxFires: this.maxRounds,
          guardKey: PROGRESSION_COOLDOWN_GUARD,
        },
      );
    } catch (err) {
      this.logger.warn(
        `[progression] 巡检触发器排期失败 taskId=${taskId}（下次 register 重试）: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * 注册停滞回调（TasksService：连续静默达上限 → systemBlock 置阻塞 + 群公告）。
   * 回调异常被吞（fire-and-forget，不阻断巡检主流程）。
   */
  onStallDetected(cb: (taskId: string, reason: string) => void): void {
    this.stallHandlers.push(cb);
  }

  /** 触发停滞回调（fire-and-forget，逐个 try/catch）。 */
  private fireStallDetected(taskId: string, reason: string): void {
    for (const cb of this.stallHandlers) {
      try {
        cb(taskId, reason);
      } catch (err) {
        this.logger.warn(
          `[progression] 停滞回调失败 taskId=${taskId}（忽略）: ${this.describeError(err)}`,
        );
      }
    }
  }

  /**
   * 任务离开 in_progress（pending_review/completed/archived/rejected）时注销
   * （触发器 cancel，行留 cancelled 备查）。
   */
  unregister(taskId: string): void {
    this.logger.log(`[progression] 注销巡检 taskId=${taskId}`);
    void this.cancelPatrolTrigger(taskId);
  }

  /** 触发器 cancel（fail-open：行缺失/失败仅 warn，内存注销已完成）。 */
  private async cancelPatrolTrigger(taskId: string): Promise<void> {
    if (!this.triggers) {
      return;
    }
    try {
      await this.triggers.cancel(buildProgressionDedupKey(taskId));
    } catch (err) {
      this.logger.warn(
        `[progression] 巡检触发器取消失败 taskId=${taskId}（忽略）: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * 是否在巡检中（canonical 派生：pending 巡检触发器行存在即在册；spec 断言用）。
   */
  async isRegistered(taskId: string): Promise<boolean> {
    try {
      const row = (await this.patrolTriggerRows()?.findUnique?.({
        where: { dedupKey: buildProgressionDedupKey(taskId) },
      })) as { status?: string } | null | undefined;
      return row?.status === TRIGGER_STATUS.PENDING;
    } catch (err) {
      this.logger.warn(
        `[progression] 巡检状态查询失败 taskId=${taskId}（按未注册处理）: ${this.describeError(err)}`,
      );
      return false;
    }
  }

  /**
   * 主动触发一次巡检（真实链路验证用）：无 pending 行 → no-op；
   * 否则跳过到期判定直接 dispatch（轮次/上限由基座 maxFires 强制）。
   */
  async patrolNow(taskId: string): Promise<void> {
    if (!(await this.isRegistered(taskId))) {
      return;
    }
    await this.runPatrol(taskId);
  }

  /**
   * 按需巡检扫描（canonical 派生：遍历 pending 巡检触发器行；生产节拍来自 trigger
   * ticker，见类注释）。语义与旧扫描一致：到期行 → 冷却否决（isSessionPending/
   * 近期活跃则跳过，不计轮次）→ dispatch；轮次计数与上限由基座 fireCount/maxFires
   * 强制，scan 不记账。
   */
  private async scan(now = Date.now()): Promise<void> {
    const rows = (await this.patrolTriggerRows()?.findMany?.({
      where: {
        kind: TRIGGER_KIND.PROGRESSION_PATROL,
        status: TRIGGER_STATUS.PENDING,
      },
      select: {
        dedupKey: true,
        payload: true,
        nextFireAt: true,
      },
    })) as
      | Array<{
          dedupKey: string;
          payload?: unknown;
          nextFireAt?: Date | string | null;
        }>
      | null
      | undefined;
    if (!Array.isArray(rows)) {
      return;
    }
    for (const row of rows) {
      const taskId = (
        row.payload as ProgressionPatrolPayload | null | undefined
      )?.taskId;
      if (!taskId) {
        continue;
      }
      const next = row.nextFireAt
        ? new Date(row.nextFireAt).getTime()
        : Number.NaN;
      if (Number.isFinite(next) && (next as number) > now) {
        continue;
      }
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { title: true, status: true, teamId: true },
      });
      if (!task || task.status !== TASK_STATUS.in_progress) {
        this.unregister(taskId);
        continue;
      }
      const mainMemberId = await this.mainMemberOfTask(
        (task as any).teamId ?? null,
      );
      if (!mainMemberId) {
        this.unregister(taskId);
        continue;
      }
      try {
        const mainSession = await (this.prisma as any).session?.findFirst?.({
          where: { teamMemberId: mainMemberId },
          select: { id: true },
        });
        if (mainSession) {
          if (this.workerDispatcher.isSessionPending(mainSession.id)) {
            continue;
          }
          const lastAt = await this.workerDispatcher.getSessionLastActivityAt(
            mainSession.id,
          );
          if (
            lastAt !== undefined &&
            now - lastAt < this.progressionIntervalMs
          ) {
            continue;
          }
        }
      } catch {
        // fail-open：否决链路异常不阻断巡检（与 guard fail-open 一致）。
      }
      await this.runPatrol(taskId, task.title);
    }
  }

  /**
   * 巡检冷却 guard（TriggerService condition 形态；否决不消耗轮次）。
   * 否决条件与旧 scan veto 逐字一致：主会话 pending 中，或主会话在
   * progressionIntervalMs 内有活跃 → false（留 pending 待 ticker 下轮复核）。
   * 任务已离场/主成员缺失/DB 异常 → true（fail-open，交 handler 收敛为 expire）。
   */
  private async progressionCooldownGuard(
    ctx: TriggerFireContext,
  ): Promise<boolean> {
    try {
      const taskId = (ctx.payload as any)?.taskId as string | undefined;
      if (!taskId) {
        return true;
      }
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { status: true, teamId: true },
      });
      if (!task || (task as any).status !== TASK_STATUS.in_progress) {
        return true;
      }
      const mainMemberId = await this.mainMemberOfTask(
        (task as any).teamId ?? null,
      );
      if (!mainMemberId) {
        return true;
      }
      const mainSession = await (this.prisma as any).session?.findFirst?.({
        where: { teamMemberId: mainMemberId },
        select: { id: true },
      });
      if (!mainSession) {
        return true;
      }
      if (this.workerDispatcher.isSessionPending(mainSession.id)) {
        return false;
      }
      const lastAt = await this.workerDispatcher.getSessionLastActivityAt(
        mainSession.id,
      );
      if (
        lastAt !== undefined &&
        Date.now() - lastAt < this.progressionIntervalMs
      ) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * 巡检触发 handler（interval 行每次到期执行；基座负责重排 + fireCount++）。
   * - 任务已离场/无主成员/payload 缺 taskId → `{expire:true}`（基座落 cancelled，
   *   重启后 stale 行自收敛）。
   * - race 窗口否决（guard 通过后到 handler 执行间主会话变忙/变活跃）→ 跳过本次
   *   dispatch 但返回 void（基座仍计一次 fireCount——保守偏向防空转；guard 为主否决，
   *   此分支罕见）。
   * - 正常 → runPatrol（与旧 scan 同一 prompt/同一 `kind:'wake'` 链路），静默计数
   *   quietStreak 随行 payload 持久化（canonical 以 DB 为准）。
   */
  async handleProgressionFire(
    ctx: TriggerFireContext,
  ): Promise<{ expire: true } | void> {
    const taskId = (ctx.payload as any)?.taskId as string | undefined;
    if (!taskId) {
      return { expire: true };
    }
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true, status: true, teamId: true },
    });
    if (!task || task.status !== TASK_STATUS.in_progress) {
      return { expire: true };
    }
    const mainMemberId = await this.mainMemberOfTask(
      (task as any).teamId ?? null,
    );
    if (!mainMemberId) {
      return { expire: true };
    }
    try {
      const mainSession = await (this.prisma as any).session?.findFirst?.({
        where: { teamMemberId: mainMemberId },
        select: { id: true },
      });
      if (mainSession) {
        if (this.workerDispatcher.isSessionPending(mainSession.id)) {
          this.logger.warn(
            `[progression] taskId=${taskId} 主会话忙，跳过本轮巡检`,
          );
          return;
        }
        const lastAt = await this.workerDispatcher.getSessionLastActivityAt(
          mainSession.id,
        );
        if (
          lastAt !== undefined &&
          Date.now() - lastAt < this.progressionIntervalMs
        ) {
          // 观测到进展：静默计数清零（本轮不叫醒、不计轮次，忙有活干是好事）。
          await this.writeQuietStreak(ctx.id, taskId, ctx.payload, 0);
          this.logger.warn(
            `[progression] taskId=${taskId} 主会话近期活跃，跳过本轮巡检`,
          );
          return;
        }
      }
    } catch {
      // fail-open：否决链路异常不阻断巡检（与旧 scan veto try{}catch{} 一致）。
    }
    await this.runPatrol(taskId, (task as any).title);
    // 叫醒后记一次静默：下次 fire 若仍无进展继续累加；达上限 → 停滞回调
    // （TasksService 置阻塞 + 群公告）并注销巡检，停嘴等人工。
    const quietStreak = this.readQuietStreak(ctx.payload) + 1;
    await this.writeQuietStreak(ctx.id, taskId, ctx.payload, quietStreak);
    if (quietStreak >= STALL_QUIET_STREAK_LIMIT) {
      // 在途守卫（看门狗误置阻塞修复）：quietStreak 只统计"主会话静默"，
      // 看不见 issue 粒度进展和其他成员会话。达上限前先查在途工作——
      // 有 issue 仍 in_progress，或任务分区近期有聊天，即视为有人在干活：
      // 不 fireStallDetected（不 systemBlock），记 deferred 日志，quietStreak
      // 清零（与"主会话活跃清零"同语义：本轮观测到进展就不算停滞），巡检继续
      // 不注销。 truly idle（无在途 issue 且无近期聊天）才沿旧行为置阻塞。
      const inflight = await this.hasInflightWork(taskId);
      if (inflight.inflight) {
        this.logger.warn(
          `[progression] taskId=${taskId} 停滞检查递延（${inflight.reason}），跳过自动置阻塞`,
        );
        await this.writeQuietStreak(ctx.id, taskId, ctx.payload, 0);
        return;
      }
      this.logger.warn(
        `[progression] taskId=${taskId} 连续 ${quietStreak} 轮无进展，触发停滞处理`,
      );
      this.fireStallDetected(
        taskId,
        `看门狗：任务连续 ${quietStreak} 轮巡检（约 ${Math.round((quietStreak * this.progressionIntervalMs) / 60000)} 分钟）无任何进展，自动置阻塞。请人工确认卡点后恢复执行。`,
      );
      this.unregister(taskId);
      return;
    }
  }

  /** 行 payload 中的连续静默轮次（缺失/非法 → 0）。 */
  private readQuietStreak(payload: unknown): number {
    const n = Number(
      (payload as ProgressionPatrolPayload | null | undefined)?.quietStreak,
    );
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /**
   * 连续静默轮次落库（canonical 随行 payload 持久化；行缺失/模型缺席/fail 时
   * warn 吞错，巡检主流程不受影响）。
   */
  private async writeQuietStreak(
    rowId: string,
    taskId: string,
    payload: unknown,
    quietStreak: number,
  ): Promise<void> {
    try {
      const base =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>)
          : {};
      await this.patrolTriggerRows()?.update?.({
        where: { id: rowId },
        data: { payload: { ...base, taskId, quietStreak } },
      });
    } catch (err) {
      this.logger.warn(
        `[progression] 静默计数持久化失败 taskId=${taskId}（忽略）: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * 在途工作检查（停滞置阻塞前置守卫）：返回 { inflight, reason }。
   * ① issue 粒度：在途 = status ∈ STALL_INFLIGHT_ISSUE_STATUSES（即 in_progress）
   *    且未软删；② 聊天粒度：messages.task_id 分区在 stallChatActivityWindowMs
   *    内有新消息（覆盖非主会话成员的进展，主会话活跃已由上游否决链处理）。
   * 直接经 prisma 查询（与 plan-lifecycle/tasks.service 的 prisma.issue 直查同模式，
   * 不注入 IssuesService/ChatService，无循环依赖）。任一命中即在途。
   * 查询异常或模型缺席 → 视为不在途（fail-closed 沿旧行为置阻塞：宁可误报，
   * 不可漏报空转；异常记 warn 不阻断）。
   */
  private async hasInflightWork(
    taskId: string,
    now = Date.now(),
  ): Promise<{ inflight: boolean; reason: string | null }> {
    try {
      const issueModel = (this.prisma as any).issue;
      if (issueModel?.findFirst) {
        const live = (await issueModel.findFirst({
          where: {
            taskId,
            status: { in: [...STALL_INFLIGHT_ISSUE_STATUSES] },
            deletedAt: null,
          },
          select: { id: true, status: true },
        })) as { id: string; status: string } | null;
        if (live) {
          return {
            inflight: true,
            reason: `issue ${live.id} 仍在 ${live.status}`,
          };
        }
      }
    } catch (err) {
      this.logger.warn(
        `[progression] 在途 issue 检查失败 taskId=${taskId}（按无在途继续）: ${this.describeError(err)}`,
      );
    }
    try {
      const messageModel = (this.prisma as any).message;
      if (messageModel?.findFirst) {
        const recent = (await messageModel.findFirst({
          where: {
            taskId,
            createdAt: {
              gte: new Date(now - this.stallChatActivityWindowMs),
            },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })) as { id: string } | null;
        if (recent) {
          return {
            inflight: true,
            reason: `任务频道近 ${Math.round(this.stallChatActivityWindowMs / 60000)} 分钟内有新消息`,
          };
        }
      }
    } catch (err) {
      this.logger.warn(
        `[progression] 在途聊天检查失败 taskId=${taskId}（按无在途继续）: ${this.describeError(err)}`,
      );
    }
    return { inflight: false, reason: null };
  }

  /** 单次巡检：构造巡检 prompt 并 dispatch 给主 Agent。 */
  private async runPatrol(taskId: string, title?: string): Promise<void> {
    const text = buildProgressionPrompt(
      title ?? taskId,
      TASK_STATUS.in_progress,
    );
    await this.dispatchToMainAgent(taskId, text);
    this.logger.log(`[progression] 巡检消息已下发主 Agent taskId=${taskId}`);
  }

  /**
   * 停滞群公告（TasksService.systemBlock 调用）：自动置阻塞后在团队群聊落 system 消息。
   * idGen 缺席时跳过落库只记日志；频道缺失/异常吞错（状态已置阻塞，不影响）。
   */
  async postStallNoticeToTeamGroup(
    teamId: string,
    taskId: string,
    taskTitle: string,
    reason: string,
  ): Promise<void> {
    try {
      const channel = await this.prisma.chatChannel.findFirst({
        where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
        select: { id: true },
      });
      if (!channel || !this.idGen) {
        this.logger.warn(
          `[progression] 停滞公告跳过 team=${teamId}（无群频道或无 idGen）`,
        );
        return;
      }
      const text =
        `【任务停滞】任务 <${taskTitle}>（${taskId}）${reason}` +
        `已自动置阻塞。请人工确认卡点，解决后恢复执行（task resume）。`;
      const row = await this.prisma.message.create({
        data: {
          id: await this.idGen.nextId('m'),
          channelId: (channel as { id: string }).id,
          taskId,
          senderType: SENDER_TYPE.system,
          senderId: null,
          content: { text, parts: [] },
          mentions: null,
          status: MESSAGE_STATUS.sent,
        } as any,
      });
      await this.realtime.broadcast(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: {
            id: (row as { id: string }).id,
            channelId: (channel as { id: string }).id,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text, parts: [] },
            mentions: [],
            status: MESSAGE_STATUS.sent,
            createdAt: new Date().toISOString(),
          },
        },
        { type: 'channel', id: (channel as { id: string }).id },
      );
    } catch (err) {
      this.logger.warn(
        `[progression] 停滞公告失败 taskId=${taskId}（忽略）: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * 记忆收集自动触发（mark-pending-review 时调用）：dispatch 一条 user 型触发消息给主 Agent，
   * 使其立即执行记忆收集（memory_search → memory_save），不等下次被 @。
   * dispatchAgentMention 走 user 消息链路 → chat.service 分派 → 主 Agent 收到触发。
   */
  async triggerMemoryHarvest(
    taskId: string,
    taskTitle?: string,
  ): Promise<void> {
    const text =
      `【记忆收集】任务 <${taskTitle ?? taskId}> 已提交验收。请沉淀**可复用经验**（不是会话总结）：\n` +
      '只记录对未来任务有指导价值的内容，例如：\n' +
      '- 怎么做：某类操作的有效路径/命令/API 用法/配置方法（下次可直接照做）\n' +
      '- 坑与规避：踩过的错误、失败原因、错误信号与规避方法（下次不再踩）\n' +
      '- 平台约束：工具限制、权限边界、容量上限等硬约束（下次主动绕开）\n' +
      '**不要保存**：任务流水账、时间线复盘、谁做了什么、当前状态描述、无普适性的一次性结论。\n' +
      '执行：① memory_search 查重避免重复；② 从执行过程提炼符合上述标准的经验条目（宁缺毋滥，0 条也可）；' +
      '③ 逐条 memory_save：content 写「场景 + 做法/坑 + 规避动作」，description 30 字内概括，' +
      'level: 跨任务复用写 "team"，平台通用写 "global"，tags 用 howto/pitfall/constraint 等类型词。\n' +
      '完成后无需回复本消息。';
    await this.dispatchToMainAgent(taskId, text);
    this.logger.log(
      `[progression] 记忆收集触发已下发主 Agent taskId=${taskId}`,
    );
  }

  /**
   * 定向 dispatch 给主 Agent（巡检/托管确认共用）：
   * 主 Agent 定位 = team.mainAgentMemberId → 会话；频道 private（按成员）优先，回退群聊。
   * 复用 WorkerDispatcher.dispatchAgentMention（assignWorker → createSession/bind → execute → 回复回流）。
   * 目标无会话 → dispatchAgentMention 抛错（调用方捕获记日志，不阻断扫描）。
   */
  private async dispatchToMainAgent(
    taskId: string,
    text: string,
  ): Promise<void> {
    // team:<id> 域：teamId 直传（dispatchAgentMention 内置 teamId 分支，跳过任务查表）
    const teamScopedId = taskId.startsWith('team:')
      ? taskId.slice('team:'.length)
      : null;
    const taskMeta = teamScopedId
      ? null
      : await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { teamId: true },
        });
    const teamId = teamScopedId ?? (taskMeta as any)?.teamId ?? null;
    const mainMemberId = await this.mainMemberOfTask(teamId);
    if (!mainMemberId) {
      throw new Error(`任务 ${taskId} 无主成员，无法定向 dispatch`);
    }
    let channel: { id: string } | null = null;
    if (teamId) {
      channel = await this.prisma.chatChannel.findFirst({
        where: { teamId, teamMemberId: mainMemberId, deletedAt: null },
        select: { id: true },
      });
      if (!channel) {
        channel = await this.prisma.chatChannel.findFirst({
          where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
          select: { id: true },
        });
      }
    }
    if (!channel) {
      throw new Error(`任务 ${taskId} 无可用频道，无法定向 dispatch`);
    }
    await this.workerDispatcher.dispatchAgentMention({
      taskId: teamScopedId ? null : taskId,
      ...(teamScopedId ? { teamId: teamScopedId } : {}),
      channelId: channel.id,
      text,
      targetInstanceId: mainMemberId,
      kind: 'wake',
    });
  }

  /** 任务归属团队的主成员 id（team.mainAgentMemberId；无归属/未设置 → null）。 */
  private async mainMemberOfTask(
    teamId: string | null,
  ): Promise<string | null> {
    if (!teamId) return null;
    const team = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { mainAgentMemberId: true },
    });
    return (team as any)?.mainAgentMemberId ?? null;
  }

  /** 托管模式确认请求路由（realtime bus 订阅回调）：agent.question 事件 payload.managed=true 且未收敛 → dispatch 给主 Agent。 */
  private async routeManagedQuestion(event: RealtimeEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      managed?: boolean;
      resolved?: boolean;
      question?: {
        taskId?: string | null;
        requestId?: string;
        kind?: string;
        content?: unknown;
      };
      taskId?: string | null;
    };
    if (payload.managed !== true || payload.resolved === true) {
      return;
    }
    const taskId = payload.question?.taskId ?? payload.taskId;
    if (!taskId) {
      return;
    }
    const row = await this.prisma.agentQuestion
      .findUnique({
        where: { requestId: payload.question?.requestId ?? '' },
        select: {
          id: true,
          requestId: true,
          kind: true,
          content: true,
          status: true,
          sessionId: true,
        },
      })
      .catch(() => null);
    if (!row || row.status !== 'pending') {
      return;
    }
    // team:<id> 域（团队会话无任务，ingress 补的形态）：跳过 task 查表，直接按团队解析
    // 主成员——自环检测与后续 dispatch 定向共用此 teamId。
    const teamScopedId = taskId.startsWith('team:')
      ? taskId.slice('team:'.length)
      : null;
    const task = teamScopedId
      ? null
      : await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { title: true, teamId: true },
        });
    const questionMainId = await this.mainMemberOfTask(
      teamScopedId ?? (task as any)?.teamId ?? null,
    );
    if (questionMainId && row.sessionId) {
      const reqSession = await this.prisma.session
        .findUnique({
          where: { id: row.sessionId },
          select: { teamMemberId: true },
        })
        .catch(() => null);
      if (
        reqSession?.teamMemberId &&
        reqSession.teamMemberId === questionMainId
      ) {
        this.logger.log(
          `[progression] 托管确认自环 taskId=${taskId} requestId=${row.requestId} 自身主实例权限请求不转发，改发企业微信卡片`,
        );
        if (this.questionDispatcher) {
          try {
            await this.questionDispatcher.dispatchQuestionCard(taskId, {
              id: row.id,
              requestId: row.requestId,
              kind: row.kind,
              content: row.content,
            });
            this.logger.log(
              `[progression] 自环卡片已委托 MessageQuestionDispatcher taskId=${taskId} requestId=${row.requestId}`,
            );
          } catch (err) {
            this.logger.error(
              `[progression] 自环卡片委托失败 taskId=${taskId}: ${this.describeError(err)}`,
            );
          }
        } else {
          try {
            await this.fallbackWecomCard(taskId, row);
          } catch (err) {
            this.logger.error(
              `[progression] 自环卡片回退失败 taskId=${taskId}: ${this.describeError(err)}`,
            );
          }
        }
        return;
      }
    }
    const contentText = this.describeQuestionContent(row.kind, row.content);
    const text =
      `【托管确认】任务 <${task?.title ?? taskId}> 托管模式下收到成员确认请求：` +
      `requestId=${row.requestId}，kind=${row.kind}，内容：${contentText}。` +
      '请调用 vteam MCP 的 question_confirm 工具决策：' +
      'question 传 {taskId, selfInstanceId, requestId, kind:"question", answers: 答案数组} 提交答案（answers=null 表示拒绝）；' +
      'permission 传 {taskId, selfInstanceId, requestId, kind:"permission", response:"once"|"always"|"reject"}。';
    await this.dispatchToMainAgent(taskId, text);
    this.logger.log(
      `[progression] 托管确认请求已下发主 Agent taskId=${taskId} requestId=${row.requestId}`,
    );
  }

  /** content Json → 可读摘要（确认请求消息内嵌问题详情）。 */
  private describeQuestionContent(kind: string, content: unknown): string {
    if (kind === 'permission') {
      const c = (content ?? {}) as { title?: string; pattern?: unknown };
      return c.title ?? '权限请求';
    }
    const c = (content ?? {}) as {
      questions?: Array<{ question?: string; header?: string }>;
    };
    const text = (c.questions ?? [])
      .map((q) => q.question ?? q.header ?? '')
      .filter(Boolean)
      .join('；');
    return text || '（无详细内容）';
  }

  /**
   * periodic patrol 退役清扫：取消库内所有 pending progression_patrol 触发器行。
   * fan-out JOIN drain 接管唤醒；旧 interval 行会重复下发 wake 消息。
   * fail-open：DB 操作失败仅 warn。
   */
  private async cancelStalePatrolTriggers(): Promise<void> {
    try {
      const stale = await this.patrolTriggerRows()?.findMany?.({
        where: {
          kind: TRIGGER_KIND.PROGRESSION_PATROL,
          status: TRIGGER_STATUS.PENDING,
        },
        select: { dedupKey: true },
      });
      if (Array.isArray(stale)) {
        for (const row of stale) {
          try {
            await this.patrolTriggerRows()?.update?.({
              where: { dedupKey: row.dedupKey },
              data: { status: TRIGGER_STATUS.CANCELLED },
            });
          } catch (err) {
            this.logger.warn(
              `[progression] 清扫 stale patrol ${row.dedupKey} 失败: ${this.describeError(err)}`,
            );
          }
        }
        if (stale.length > 0) {
          this.logger.log(
            `[progression] 清扫 stale patrol 触发器：${stale.length} 个 pending 行已取消`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `[progression] 清扫 stale patrol 失败（忽略）: ${this.describeError(err)}`,
      );
    }
  }

  /**
   * 进程启动数据修复：库内 in_progress 任务逐个 register。
   * register 触发器侧幂等——pending 行保留 fireCount/quietStreak（重启不丢），
   * 终态/缺失行重建。
   */
  private async restoreInProgressTasks(): Promise<void> {
    const rows = await this.prisma.task.findMany({
      where: { status: TASK_STATUS.in_progress },
      select: { id: true },
    });
    for (const row of rows) {
      await this.register(row.id);
    }
    if (rows.length > 0) {
      this.logger.log(
        `[progression] 重启重建巡检循环：${rows.length} 个 in_progress 任务`,
      );
    }
  }

  private async fallbackWecomCard(
    taskId: string,
    row: { id: string; requestId: string; kind: string; content: unknown },
  ): Promise<void> {
    let links: Array<{ messageChannelId: string }>;
    try {
      links = await (this.prisma as any).taskMessageChannel.findMany({
        where: { taskId },
        select: { messageChannelId: true },
      });
    } catch {
      return;
    }
    if (!links || links.length === 0) {
      this.logger.warn(`[progression] 自环无 wecom 渠道绑定 taskId=${taskId}`);
      return;
    }
    const ids = links.map((l) => l.messageChannelId).filter(Boolean);
    if (ids.length === 0) return;
    let channels: any[];
    try {
      channels = await (this.prisma as any).messageChannel.findMany({
        where: { id: { in: ids }, enabled: true, type: 'wecom_aibot' },
      });
    } catch {
      return;
    }
    if (!channels || channels.length === 0) {
      this.logger.warn(
        `[progression] 自环无启用 wecom_aibot 渠道 taskId=${taskId}`,
      );
      return;
    }
    this.logger.log(
      `[progression] 自环尝试直接发卡 taskId=${taskId} requestId=${row.requestId} channels=${channels.length}`,
    );
  }

  private describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
