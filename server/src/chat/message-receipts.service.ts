import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { CHANNEL_TYPE } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  MESSAGE_RECEIPT_SETTLED_REASONS,
  MESSAGE_RECEIPT_STATUSES,
  MessageReceiptSettledReason,
} from './message-receipt.constants';

/** 回执主键前缀（mr_；resyncIdPrefix 续号用，防重启后主键冲突）。 */
const MESSAGE_RECEIPT_ID_PREFIX = 'mr';

/**
 * 被引用的消息 id token（精确匹配用，批次 A4）。
 *
 * 形状 = `<前缀><字母数字>_<数字>`（主键生成器口径：`<prefix>_<零填充序号>`），
 * 前后都不得紧邻字母/数字/下划线 ⇒ 「m_0000000100」不会命中「m_00000001001」，
 * 「m_0000000100x」也不是一次引用。
 *
 * 为什么必须这么严（me_0000000237 的平台化）：引用即销账是**减法**，销错一条比漏销
 * 一条更糟——漏销只是多催一次，销错会让真正没回执的派发凭空消失。
 */
const MESSAGE_ID_TOKEN_RE =
  /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9]*_\d+)(?![A-Za-z0-9_])/g;

/**
 * 从正文里抽取「被引用的消息 id 候选」集合（精确 token 匹配）。
 *
 * 只做**字面精确**匹配：候选 token 与账本里的 messageId 逐字相等才算引用。
 * 不做子串包含、不做去零填充、不做大小写折叠——宁可漏销不可错销。
 */
export function extractReferencedMessageIds(content: string): string[] {
  if (!content) return [];
  const out = new Set<string>();
  for (const m of content.matchAll(MESSAGE_ID_TOKEN_RE)) {
    out.add(m[1]);
  }
  return [...out];
}

/**
 * 到期清账扫描周期（ms）缺省 1 分钟：足够把僵死 pending 及时清为 expired
 * （fan-out drain 不再永久搁置主 Agent），又不会对 message_receipts 造成压力。
 * env `RECEIPT_EXPIRY_SWEEP_INTERVAL_MS` 覆盖；0/负值=停周期（不启动 setInterval）。
 */
export const RECEIPT_EXPIRY_SWEEP_INTERVAL_MS_DEFAULT = 60_000;
export const RECEIPT_EXPIRY_SWEEP_INTERVAL_MS_ENV =
  'RECEIPT_EXPIRY_SWEEP_INTERVAL_MS';

/**
 * 到期清账**宽限窗**（ms）：回执过了 expiresAt 之后**再多活一会儿**才允许清成 expired。
 *
 * 为什么必须有（催办与清账赛跑 ⇒ 催办被静默吞掉）：
 *   派发时 `expiresAt = now + receiptTimeoutMin`，而催办触发器的 `dueAt` 直接取
 *   `created.expiresAt`（platform-mcp.service.ts · scheduleReceiptNudge）⇒ 两者是
 *   **同一瞬间**。两个互相独立的 ticker 各自醒来抢这同一瞬间：
 *     · 催办 ticker：TIMER_SCAN_INTERVAL_MS 缺省 30_000ms（timers/trigger.service.ts）
 *     · 到期清账 ticker：RECEIPT_EXPIRY_SWEEP_INTERVAL_MS 缺省 60_000ms（本文件上方）
 *   清账若先赢 ⇒ 回执行已是 expired ⇒ 催办 handler 重读发现 status≠pending ⇒ 直接
 *   `{done:true}` ⇒ **这次催办永远发不出去**，而平台毫无察觉（回执"已处理"了）。
 *   （当年 e2e 正是靠"把 expires_at 挪到 due_at 之后 90s"才稳定观测到催办——那个
 *     从外面打的绕行本身就是平台有病的 tell，见 scripts/e2e-pm-coordination.sh D 段。）
 *
 * 取值口径：宽限窗必须 **≥ 一个催办 ticker 周期**（否则清账照样可能抢先），
 * 又要扛得住一次漏 tick ⇒ 取 60_000ms = 2 × 30_000ms（催办 ticker 缺省周期）。
 *
 * 语义边界（**不改动**任何已承诺的口径）：
 *   · 回执超时语义不变：expiresAt 仍是 now + receiptTimeoutMin；
 *   · 催办时刻不变：触发器 dueAt 仍是 expiresAt，催办仍在那一刻起、最迟一个
 *     ticker 周期（30s）内发出；
 *   · 只有"硬过期"被推迟到 expiresAt + 宽限窗 ⇒ 催办**必然**先于清账拿到机会。
 * 不变式：宽限窗 ≥ 催办 ticker 周期。若日后调大 TIMER_SCAN_INTERVAL_MS，必须同步
 * 调大本宽限窗。
 */
export const RECEIPT_EXPIRY_GRACE_MS = 60_000;

export interface ReceiptEventPayload {
  receiptId: string;
  messageId: string | null;
  taskId: string | null;
  teamId: string;
  channelId?: string | null;
  fromInstanceId: string;
  toInstanceId: string;
  status: 'acked' | 'expired';
  ackedAt?: string | null;
  nudgeCount?: number;
  /** 自动催办耗尽后的升级提示（expireAfterAutoNudge 填充，dispatcher 见 expired + notice 即升级处理）。 */
  notice?: string;
  /** 结账依据（批次 A4）：answered|quoted|question-answered|superseded；过期行无此字段。 */
  settledReason?: string;
}

export interface RoundEventPayload {
  issueId: string;
  taskId: string | null;
  teamId: string;
  channelId?: string | null;
  round: number;
  version: number;
  received: string[];
  expected: string[];
  reason?: string;
}

export interface PlanStatusChangedPayload {
  taskId: string;
  teamId: string;
  channelId?: string | null;
  from: string | null;
  to: string;
}

export interface PendingReceiptCounts {
  pending: number;
  total: number;
}

/**
 * 回执离开 pending 状态后的回调（ack / expireDue / expireAfterAutoNudge 均调用）。
 * 用于 reply-join fan-out drain：settledHook 仅对 fan-out 派发行有意义——回执方向
 * 固定为主 Agent→子 Agent（from = 团队主 Agent 成员 id），回调按 row.fromInstanceId
 * 作为 drain 轴（= 主 Agent）重查其剩余 pending 是否收敛为 0，收敛即唤醒主 Agent。
 * 过期（而非 ack）同样触发：若只认 ack，一条过期回执会使主 Agent 被 strand。
 * 完成/失败链的批量清账（ackPendingFor）逐行触发本 hook。
 */
export type ReceiptSettledHook = (row: {
  fromInstanceId: string;
  teamId: string;
}) => Promise<void> | void;

/**
 * 派发回执记账/清账与回执·轮次·计划事件发射
 *（plan-review-execution-gates Todo 5，31 篇 §3.2-§3.4）。
 *
 * 事件一律走 team:/channel: 双订阅发射：team 帧必发（会话页 team: + 看板页
 * team: 段接收）；channel 帧在频道可解析时加发（会话页 channel: 段接收）。
 * 订阅者清单见 realtime/realtime-subscriptions.ts。
 */
@Injectable()
export class MessageReceiptsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageReceiptsService.name);

  /** reply-join drain hook：回执离开 pending 后由订阅方注册（PlatformMcpService）。 */
  private settledHook: ReceiptSettledHook | null = null;

  /** 到期清账周期句柄（workers.service/trigger-reconciler 同款：原生 setInterval + unref）。 */
  private sweepTimer: NodeJS.Timeout | null = null;

  /** 重入护栏：上一轮扫描未结束则跳过本轮（防重叠 tick 双清账 / 双广播）。 */
  private sweepInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /** 注册回执结算 hook（reply-join fan-out drain）；置空=关闭。 */
  registerSettledHook(hook: ReceiptSettledHook | null): void {
    this.settledHook = hook;
  }

  /** 触发并行执行 settled hook（fire-and-forget，never throw into caller）。 */
  private fireSettledHook(row: {
    fromInstanceId: string;
    teamId: string;
  }): void {
    if (!this.settledHook) return;
    void Promise.resolve(this.settledHook(row)).catch((err: unknown) => {
      this.logger.warn(
        `[receipts] settled hook 失败 from=${row.fromInstanceId} team=${row.teamId}（不阻断）: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * 进程启动：按库内 mr_ 前缀纯数字序号最大值对齐 id 生成器。
   *
   * 缺此 resync 时重启后计数器归零 → nextId('mr') 撞既有主键 P2002，
   * 而 `scheduleReceiptNudge` 的 P2002 分支按「dedupKey 冲突」回查会落空，
   * 最终静默跳过排期（催办消失）。与 t/m/s/pl 等前缀同款防冲突对齐。
   */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.messageReceipt,
      MESSAGE_RECEIPT_ID_PREFIX,
      this.idGen,
    );
    this.ensureExpirySweepTicker();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * 到期清账周期任务（幂等，重入护栏）。
   *
   * 关键接线：`expireDue()` 每条 pending→expired 后经 `fireSettledHook` →
   * PlatformMcpService 的 `checkAndDrainFanOut`，重新检查该主 Agent 剩余待回执
   * 是否收敛为 0。故过期一条僵死回执同样能解除 fan-out 阻塞、唤醒被永久搁置的
   * 主 Agent——这是「单条 stale pending 堵死 drain」事故的补偿环。
   */
  async sweepExpiredReceipts(now: Date = new Date()): Promise<number> {
    if (this.sweepInFlight) {
      this.logger.debug('[receipts] 到期扫描仍在进行，跳过本轮');
      return 0;
    }
    this.sweepInFlight = true;
    try {
      // 批次 A4：先结「主 Agent 已应答」的 question/help 回执，再做到期清账。
      // 顺序很重要：已应答的回执是**被回答了**，不该被记成过期（me_0000000061
      // 的误报催办正是过期+催办两条路一起把主 Agent 追成了噪音）。
      const settled = await this.settleAnsweredQuestionReceipts();
      if (settled > 0) {
        this.logger.log(
          `[receipts] 到期扫描：主 Agent 已应答，${settled} 条 question/help 回执行结账`,
        );
      }
      const rows = await this.expireDue(now);
      const expired = rows?.length ?? 0;
      if (expired > 0) {
        this.logger.log(`[receipts] 到期清账：${expired} 条 pending→expired`);
      } else {
        this.logger.debug('[receipts] 到期清账：本轮无到期回执');
      }
      return expired;
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * 启动到期清账周期（onModuleInit eager；`RECEIPT_EXPIRY_SWEEP_INTERVAL_MS=0` 禁用）。
   * 原生 setInterval + unref（@nestjs/schedule 未安装；同 workers.service healthTimer）。
   */
  private ensureExpirySweepTicker(): void {
    const intervalMs = this.sweepIntervalMs();
    if (intervalMs <= 0) {
      return;
    }
    if (this.sweepTimer) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredReceipts().catch((err: unknown) =>
        this.logger.error(
          `[receipts] 到期扫描失败: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  private sweepIntervalMs(): number {
    const raw = process.env[RECEIPT_EXPIRY_SWEEP_INTERVAL_MS_ENV];
    if (raw === undefined || raw === '') {
      return RECEIPT_EXPIRY_SWEEP_INTERVAL_MS_DEFAULT;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : RECEIPT_EXPIRY_SWEEP_INTERVAL_MS_DEFAULT;
  }

  /**
   * 清账：pending→acked（幂等：非 pending 直接返回，不写库不广播），
   * 随后广播 receipt.acked。
   *
   * `reason` = 结账依据（批次 A4 落的 settled_reason 列）：默认 answered=目标回了执。
   * 账本**只减不增**：本方法只 UPDATE 既有行，绝不新建回执行。
   */
  async ack(
    receiptId: string,
    reason: MessageReceiptSettledReason = MESSAGE_RECEIPT_SETTLED_REASONS.answered,
  ) {
    const row = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
    });
    if (!row || (row as { status?: string }).status !== 'pending') {
      return row;
    }
    const ackedAt = new Date();
    const found = row as unknown as {
      messageId: string | null;
      taskId: string | null;
      teamId: string;
      fromInstanceId: string;
      toInstanceId: string;
    };
    const updated = await this.prisma.messageReceipt.update({
      where: { id: receiptId },
      data: { status: 'acked', ackedAt, settledReason: reason },
    });
    this.fireSettledHook({
      fromInstanceId: found.fromInstanceId,
      teamId: found.teamId,
    });
    await this.emitTeamChannel({
      teamId: found.teamId,
      taskId: found.taskId,
      type: EVENT_TYPES.RECEIPT_ACKED,
      payload: {
        receiptId,
        messageId: found.messageId,
        taskId: found.taskId,
        teamId: found.teamId,
        fromInstanceId: found.fromInstanceId,
        toInstanceId: found.toInstanceId,
        status: 'acked',
        ackedAt: ackedAt.toISOString(),
        settledReason: reason,
      } satisfies ReceiptEventPayload,
    });
    return updated;
  }

  /**
   * 原子销账（批次 A4 的结算底座）：条件更新 pending→acked，**只放行一个赢家**。
   *
   * 为什么不用 findUnique+update（ack() 的旧形状）：两个结算并发时，两个赢家都会
   * 先读到 pending、再各自写一次并各广播一次 receipt.acked ⇒ 同一条回执被结两遍
   * （账本行数不变，但事件/计数口径会双计）。条件更新把「读到 pending」与「写成
   * acked」合成一个原子步骤：count===1 才是赢家，count===0 说明被别人抢先 ⇒ 幂等 no-op。
   *
   * 账本基数：**每条回执行至多被结账一次**；本操作**不新增任何回执行**
   * （me_0000000030：销账必须是减法，绝不能靠再发一次派发来"清"）。
   */
  private async settlePending(
    receiptId: string,
    reason: MessageReceiptSettledReason,
  ): Promise<boolean> {
    const ackedAt = new Date();
    const claimed = await this.prisma.messageReceipt.updateMany({
      where: { id: receiptId, status: MESSAGE_RECEIPT_STATUSES.pending },
      data: {
        status: MESSAGE_RECEIPT_STATUSES.acked,
        ackedAt,
        settledReason: reason,
      },
    });
    if (claimed.count !== 1) {
      return false;
    }
    const row = (await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
    })) as unknown as {
      messageId: string | null;
      taskId: string | null;
      teamId: string;
      fromInstanceId: string;
      toInstanceId: string;
    } | null;
    if (!row) {
      return true;
    }
    this.fireSettledHook({
      fromInstanceId: row.fromInstanceId,
      teamId: row.teamId,
    });
    await this.emitTeamChannel({
      teamId: row.teamId,
      taskId: row.taskId,
      type: EVENT_TYPES.RECEIPT_ACKED,
      payload: {
        receiptId,
        messageId: row.messageId,
        taskId: row.taskId,
        teamId: row.teamId,
        fromInstanceId: row.fromInstanceId,
        toInstanceId: row.toInstanceId,
        status: 'acked',
        ackedAt: ackedAt.toISOString(),
        settledReason: reason,
      } satisfies ReceiptEventPayload,
    });
    return true;
  }

  /**
   * A4-1 引用即销账（quote-to-settle，me_0000000237 的平台化）。
   *
   * 场景：agent 手工约定的协议是「先带 messageId 引用 X 重发一条绑定回执」——
   * 平台把它变成机制：正文里**精确**引用了派发的 messageId ⇒ 该派发的 pending
   * 回执行结账（群聊答复也算数了，治 me_0000000016 / me_0000000115 / me_0000000169
   * 「群聊答复不算回执」导致的误报催办，pendingReceipts 曾堆到 36）。
   *
   * 三条硬约束：
   * ① **精确匹配**：只认逐字相等的 messageId token（见 extractReferencedMessageIds），
   *    模糊/部分匹配一律不销——销错比漏销更糟；
   * ② **幂等**：重复结算只生效一次，且**不新增任何回执行**（me_0000000030）；
   * ③ **只认当事人**：引用方必须是这条派发的两方之一（派发方或被指派人），
   *    第三方引用不销账（否则别人转述一句就把别人的活销了）。
   *
   * @returns 本次结掉的回执行条数（0 = 没有可结的）。
   */
  async settleByReference(input: {
    /** 团队归属（可空=不限团队；给出时只结该团队的回执行）。 */
    teamId?: string | null;
    /** 引用发起方实例 id（发消息/提交产出物的那个 agent）。 */
    actorInstanceId?: string | null;
    /** 被引用的正文（群聊正文 / 产出物标题+正文+变更说明）。 */
    content: string;
  }): Promise<number> {
    const referenced = extractReferencedMessageIds(input.content ?? '');
    if (referenced.length === 0) {
      return 0;
    }
    let rows: Array<{
      id: string;
      messageId: string | null;
      fromInstanceId: string;
      toInstanceId: string;
    }>;
    try {
      rows = (await this.prisma.messageReceipt.findMany({
        where: {
          messageId: { in: referenced },
          status: MESSAGE_RECEIPT_STATUSES.pending,
          ...(input.teamId ? { teamId: input.teamId } : {}),
        },
        select: {
          id: true,
          messageId: true,
          fromInstanceId: true,
          toInstanceId: true,
        },
      })) as unknown as typeof rows;
    } catch (err) {
      this.logger.warn(
        `[receipts] 引用销账查账本失败（不阻断）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    let settled = 0;
    for (const row of rows ?? []) {
      if (
        input.actorInstanceId &&
        input.actorInstanceId !== row.fromInstanceId &&
        input.actorInstanceId !== row.toInstanceId
      ) {
        this.logger.warn(
          `[receipts] 引用销账跳过：引用方 ${input.actorInstanceId} 不是该派发的当事人（from=${row.fromInstanceId} to=${row.toInstanceId}）receipt=${row.id}`,
        );
        continue;
      }
      if (
        await this.settlePending(row.id, MESSAGE_RECEIPT_SETTLED_REASONS.quoted)
      ) {
        settled += 1;
        this.logger.log(
          `[receipts] 引用即销账：receipt=${row.id} message=${row.messageId} 被 ${input.actorInstanceId ?? '(未知)'} 精确引用（me_0000000237）`,
        );
      }
    }
    return settled;
  }

  /**
   * A4-4 被 supersede 替换的旧派发销账。
   *
   * 批次 A 的 supersede 把在途派发**替换**掉（新消息引用原 messageId），但旧派发的
   * 回执行一直 pending——它永远不会有人回（那条派发已作废），于是必然被催办，
   * 于是必然升级 ⇒ 必须销账。
   *
   * 走既有机制（status=acked + settled_reason=superseded）：不新增 status 取值
   * （前端的 status 白名单不能被打穿），审计靠 settled_reason 留痕。
   *
   * 幂等：只结 pending 行；重复调用第二次 count===0 ⇒ no-op；**不新增回执行**。
   */
  async settleSupersededDispatch(input: {
    /** 被替换掉的旧派发消息 id。 */
    messageId: string;
    /** 团队归属（可空=不限）。 */
    teamId?: string | null;
  }): Promise<number> {
    if (!input.messageId) {
      return 0;
    }
    let rows: Array<{ id: string }>;
    try {
      rows = (await this.prisma.messageReceipt.findMany({
        where: {
          messageId: input.messageId,
          status: MESSAGE_RECEIPT_STATUSES.pending,
          ...(input.teamId ? { teamId: input.teamId } : {}),
        },
        select: { id: true },
      })) as unknown as typeof rows;
    } catch (err) {
      this.logger.warn(
        `[receipts] supersede 销账查账本失败（不阻断派发）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    let settled = 0;
    for (const row of rows ?? []) {
      if (
        await this.settlePending(
          row.id,
          MESSAGE_RECEIPT_SETTLED_REASONS.superseded,
        )
      ) {
        settled += 1;
        this.logger.log(
          `[receipts] 旧派发被 supersede 替换，回执行销账：receipt=${row.id} message=${input.messageId}`,
        );
      }
    }
    return settled;
  }

  /**
   * A4-2 主 Agent 应答后结 question/help 回执（me_0000000061 的误报催办治本）。
   *
   * 病灶：`notify_agent(type=question|help)` 是**子 Agent 向主 Agent 提问**，平台却
   * 照样给它记了一条 pending 回执行（收件人=主 Agent）⇒ 主 Agent 明明已经答了，
   * 账本却永远 pending ⇒ 平台反过去催主 Agent（误报）。
   *
   * 判据（平台**能**确证的）：主 Agent 在**提问之后**、在**提问所在的频道**里
   * 说过话 ⇒ 该提问回执结账（reason=question-answered）。
   *
   * 诚实的边界（平台**不能**确证的，报告里也这么写）：平台没有「这条消息回答了那条
   * 提问」的强关系，只能用「同频道 + 时序在提问之后」近似 ⇒ 主 Agent 在提问之后的
   * 任何一条同频道发言都会结掉这条提问回执（包括与提问无关的进度播报）。
   * 有界：只结**仍然 pending** 的行 ⇒ 窗口 = 该回执行自己的到期时刻
   * （receiptTimeoutMin，缺省 30min），超时语义未改。
   */
  async settleQuestionReceiptsAfterMainPost(input: {
    teamId: string;
    channelId: string;
    /** 发言者实例 id；必须是该团队的主 Agent，否则不结（只有主 Agent 能应答）。 */
    actorInstanceId: string;
    /** 发言时刻（用于与提问消息的时序比较）。 */
    postedAt?: Date;
  }): Promise<number> {
    if (!input.teamId || !input.channelId || !input.actorInstanceId) {
      return 0;
    }
    const mainMemberId = await this.mainMemberIdOfTeam(input.teamId);
    if (!mainMemberId || mainMemberId !== input.actorInstanceId) {
      return 0;
    }
    return this.settleQuestionReceiptsInChannel({
      teamId: input.teamId,
      channelId: input.channelId,
      mainMemberId,
      answeredAt: input.postedAt,
    });
  }

  /**
   * A4-2 拉取式兜底：扫描全部 pending 的「收件人是团队主 Agent」的回执行，
   * 检查主 Agent 是否已在提问所在频道答过话 ⇒ 结账。
   *
   * 为什么要有拉取式兜底（推送式 hook 只覆盖 MCP 工具路径）：主 Agent 的答复
   * 可能来自任何落消息的地方（group_post 工具、notify_agent 工具、任务维度私聊
   * 的终态消息……）。推送式 hook 覆盖不全 ⇒ 周期扫描兜底（由到期清账周期驱动，
   * 与 settlePending 的原子语义一致：至多结一次、不新增行）。
   */
  async settleAnsweredQuestionReceipts(): Promise<number> {
    let mainIds: string[];
    try {
      const teams = (await this.prisma.team.findMany({
        where: { mainAgentMemberId: { not: null } },
        select: { mainAgentMemberId: true },
      })) as unknown as Array<{ mainAgentMemberId: string | null }>;
      mainIds = (teams ?? [])
        .map((t) => t.mainAgentMemberId)
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
    } catch (err) {
      this.logger.warn(
        `[receipts] question 应答结账：读团队主成员失败（跳过）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    if (mainIds.length === 0) {
      return 0;
    }
    let pending: Array<{
      id: string;
      messageId: string | null;
      teamId: string;
      toInstanceId: string;
    }>;
    try {
      pending = (await this.prisma.messageReceipt.findMany({
        where: {
          status: MESSAGE_RECEIPT_STATUSES.pending,
          toInstanceId: { in: mainIds },
        },
        select: {
          id: true,
          messageId: true,
          teamId: true,
          toInstanceId: true,
        },
      })) as unknown as typeof pending;
    } catch (err) {
      this.logger.warn(
        `[receipts] question 应答结账：查 pending 回执行失败（跳过）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    if (!pending || pending.length === 0) {
      return 0;
    }
    // 取提问消息（频道 + 时刻），再一次性捞主 Agent 在这些频道里、提问之后的发言。
    const questionIds = pending
      .map((r) => r.messageId)
      .filter((x): x is string => typeof x === 'string' && x.length > 0);
    let questions: Array<{
      id: string;
      channelId: string;
      createdAt: Date;
    }>;
    try {
      questions = (await this.prisma.message.findMany({
        where: { id: { in: questionIds } },
        select: { id: true, channelId: true, createdAt: true },
      })) as unknown as typeof questions;
    } catch (err) {
      this.logger.warn(
        `[receipts] question 应答结账：读提问消息失败（跳过）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    const questionById = new Map(questions.map((q) => [q.id, q]));
    let settled = 0;
    for (const row of pending) {
      const q = row.messageId ? questionById.get(row.messageId) : undefined;
      if (!q) {
        continue;
      }
      const answered = await this.findMainAnswerAfter({
        channelId: q.channelId,
        mainMemberId: row.toInstanceId,
        after: q.createdAt,
      });
      if (!answered) {
        continue;
      }
      if (
        await this.settlePending(
          row.id,
          MESSAGE_RECEIPT_SETTLED_REASONS.questionAnswered,
        )
      ) {
        settled += 1;
        this.logger.log(
          `[receipts] 主 Agent 已应答，question/help 回执行结账：receipt=${row.id} answer=${answered}`,
        );
      }
    }
    return settled;
  }

  /**
   * A4-2 内部：某频道里主 Agent 在 `after` 之后是否说过话（返回那条发言的 id）。
   */
  private async findMainAnswerAfter(input: {
    channelId: string;
    mainMemberId: string;
    after: Date;
  }): Promise<string | null> {
    try {
      const row = (await this.prisma.message.findFirst({
        where: {
          channelId: input.channelId,
          senderInstanceId: input.mainMemberId,
          createdAt: { gt: input.after },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })) as unknown as { id: string } | null;
      return row?.id ?? null;
    } catch (err) {
      this.logger.warn(
        `[receipts] question 应答结账：查主 Agent 发言失败（按未应答）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * A4-2 内部：结掉某团队里「收件人是主 Agent、在指定频道」的 pending 回执行。
   */
  private async settleQuestionReceiptsInChannel(input: {
    teamId: string;
    channelId: string;
    mainMemberId: string;
    answeredAt?: Date;
  }): Promise<number> {
    let pending: Array<{ id: string; messageId: string | null }>;
    try {
      pending = (await this.prisma.messageReceipt.findMany({
        where: {
          teamId: input.teamId,
          toInstanceId: input.mainMemberId,
          status: MESSAGE_RECEIPT_STATUSES.pending,
        },
        select: { id: true, messageId: true },
      })) as unknown as typeof pending;
    } catch (err) {
      this.logger.warn(
        `[receipts] question 应答结账：查 pending 回执行失败（不阻断）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
    let settled = 0;
    for (const row of pending ?? []) {
      if (!row.messageId) {
        continue;
      }
      let q: { channelId: string; createdAt: Date } | null;
      try {
        q = (await this.prisma.message.findUnique({
          where: { id: row.messageId },
          select: { channelId: true, createdAt: true },
        })) as unknown as { channelId: string; createdAt: Date } | null;
      } catch (err) {
        this.logger.warn(
          `[receipts] question 应答结账：读提问消息失败（跳过 receipt=${row.id}）: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!q || q.channelId !== input.channelId) {
        continue;
      }
      if (
        input.answeredAt &&
        q.createdAt &&
        input.answeredAt.getTime() <= q.createdAt.getTime()
      ) {
        continue;
      }
      if (
        await this.settlePending(
          row.id,
          MESSAGE_RECEIPT_SETTLED_REASONS.questionAnswered,
        )
      ) {
        settled += 1;
        this.logger.log(
          `[receipts] 主 Agent 已应答，question/help 回执行结账：receipt=${row.id}（me_0000000061）`,
        );
      }
    }
    return settled;
  }

  /** 团队主成员 id（team.mainAgentMemberId；读错 fail-open 回 null）。 */
  private async mainMemberIdOfTeam(teamId: string): Promise<string | null> {
    try {
      const team = (await this.prisma.team.findUnique({
        where: { id: teamId },
        select: { mainAgentMemberId: true },
      })) as unknown as { mainAgentMemberId?: string | null } | null;
      return team?.mainAgentMemberId ?? null;
    } catch (err) {
      this.logger.warn(
        `[receipts] 读团队主成员失败 team=${teamId}（fail-open 回 null）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 超时清账：全部「过了 expiresAt **且**又过了宽限窗」的 pending→expired，每条广播 receipt.expired。
   *
   * 判定线从 `expiresAt <= now` 挪到 `expiresAt <= now - 宽限窗`：催办（expiresAt
   * 那一刻起、最迟一个 ticker 周期内发出）**必然**先于清账发生，催办不会再被清账
   * 静默吞掉（赛跑分析与取值口径见 RECEIPT_EXPIRY_GRACE_MS 的注释）。
   */
  async expireDue(now: Date = new Date()) {
    const cutoff = new Date(now.getTime() - RECEIPT_EXPIRY_GRACE_MS);
    const due = (await this.prisma.messageReceipt.findMany({
      where: { status: 'pending', expiresAt: { lte: cutoff } },
    })) as unknown as Array<{
      id: string;
      messageId: string | null;
      taskId: string | null;
      teamId: string;
      fromInstanceId: string;
      toInstanceId: string;
      nudgeCount: number;
    }>;
    const out = [];
    for (const row of due ?? []) {
      const updated = await this.prisma.messageReceipt.update({
        where: { id: row.id },
        data: { status: 'expired' },
      });
      this.fireSettledHook({
        fromInstanceId: row.fromInstanceId,
        teamId: row.teamId,
      });
      await this.emitTeamChannel({
        teamId: row.teamId,
        taskId: row.taskId,
        type: EVENT_TYPES.RECEIPT_EXPIRED,
        payload: {
          receiptId: row.id,
          messageId: row.messageId,
          taskId: row.taskId,
          teamId: row.teamId,
          fromInstanceId: row.fromInstanceId,
          toInstanceId: row.toInstanceId,
          status: 'expired',
          nudgeCount: row.nudgeCount,
        } satisfies ReceiptEventPayload,
      });
      out.push(updated);
    }
    return out;
  }

  async recordAutoNudge(receiptId: string) {
    return this.prisma.messageReceipt.update({
      where: { id: receiptId },
      data: { nudgeCount: { increment: 1 }, lastNudgedAt: new Date() },
    });
  }

  async expireAfterAutoNudge(
    row: {
      id: string;
      messageId: string | null;
      taskId: string | null;
      teamId: string;
      fromInstanceId: string;
      toInstanceId: string;
      nudgeCount: number;
    },
    notice: string,
  ) {
    const updated = await this.prisma.messageReceipt.update({
      where: { id: row.id },
      data: { status: 'expired' },
    });
    this.fireSettledHook({
      fromInstanceId: row.fromInstanceId,
      teamId: row.teamId,
    });
    await this.emitTeamChannel({
      teamId: row.teamId,
      taskId: row.taskId,
      type: EVENT_TYPES.RECEIPT_EXPIRED,
      payload: {
        receiptId: row.id,
        messageId: row.messageId,
        taskId: row.taskId,
        teamId: row.teamId,
        fromInstanceId: row.fromInstanceId,
        toInstanceId: row.toInstanceId,
        status: 'expired',
        nudgeCount: row.nudgeCount,
        notice,
      } satisfies ReceiptEventPayload,
    });
    return updated;
  }

  /** n/N 计数（31 篇 §3.4 待回执看板口径：仅计数，不做分析页）。 */
  async countPending(filter: {
    taskId?: string;
    teamId?: string;
  }): Promise<PendingReceiptCounts> {
    const where: Record<string, string> = {};
    if (filter.taskId) where.taskId = filter.taskId;
    if (filter.teamId) where.teamId = filter.teamId;
    const [pending, total] = await Promise.all([
      this.prisma.messageReceipt.count({
        where: { ...where, status: 'pending' },
      }),
      this.prisma.messageReceipt.count({ where }),
    ]);
    return { pending, total };
  }

  /**
   * reply-join 口径：按 fromInstanceId + teamId 统计 pending 回执数
   * （fan-out drain 检查用。fromInstanceId 即主 Agent 成员 id，对应其派发给
   * 所有子 Agent 的待回执数）。覆盖索引 idx_message_receipts_from_status。
   *
   * 防御纵深：仅「未到期」pending 计入未决——`expiresAt <= now` 的僵死行
   * （到期清账周期缺席/滞后时残留）不再阻塞 drain，单条 stale 回执永不
   * 永久搁置主 Agent。expiresAt 为非空列，无 NULL 语义歧义。只读计数，不改行。
   */
  async countPendingFor(filter: {
    fromInstanceId: string;
    teamId: string;
  }): Promise<number> {
    return this.prisma.messageReceipt.count({
      where: {
        fromInstanceId: filter.fromInstanceId,
        teamId: filter.teamId,
        status: 'pending',
        expiresAt: { gt: new Date() },
      },
    });
  }

  /**
   * reply-jain 清账：ACK 所有 pending 回执（from→to, team），返回本次 ACK 行数。
   * 幂等：已被 ack/expired 的行跳过（ack() 内部保证）。
   */
  async ackPendingFor(filter: {
    fromInstanceId: string;
    toInstanceId: string;
    teamId: string;
  }): Promise<number> {
    const rows = (await this.prisma.messageReceipt.findMany({
      where: {
        fromInstanceId: filter.fromInstanceId,
        toInstanceId: filter.toInstanceId,
        teamId: filter.teamId,
        status: 'pending',
      },
      select: { id: true },
    })) as unknown as Array<{ id: string }>;
    let acked = 0;
    for (const row of rows) {
      const res = await this.ack(row.id);
      if (res) acked++;
    }
    return acked;
  }

  /**
   * 待回执查询（task 13：GET /messages/receipts 的行查询；计数复用 countPending
   * 同口径——pending/total 按 taskId/teamId 作用域统计，不跟随 status 过滤）。
   */
  async listReceipts(filter: {
    taskId?: string;
    teamId?: string;
    status?: string;
  }) {
    const where: Record<string, string> = {};
    if (filter.taskId) where.taskId = filter.taskId;
    if (filter.teamId) where.teamId = filter.teamId;
    if (filter.status) where.status = filter.status;
    const [items, counts] = await Promise.all([
      this.prisma.messageReceipt.findMany({
        where,
        orderBy: { createdAt: 'asc' },
      }),
      this.countPending({ taskId: filter.taskId, teamId: filter.teamId }),
    ]);
    return { items, pending: counts.pending, total: counts.total };
  }

  /** 轮次收敛：N/N → 广播 round.complete。 */
  async emitRoundComplete(input: RoundEventPayload): Promise<void> {
    await this.emitTeamChannel({
      teamId: input.teamId,
      taskId: input.taskId,
      type: EVENT_TYPES.ROUND_COMPLETE,
      payload: input,
    });
  }

  /** 轮次超时转人工：广播 round.stale（含 received/expected 缺席点名）。 */
  async emitRoundStale(input: RoundEventPayload): Promise<void> {
    await this.emitTeamChannel({
      teamId: input.teamId,
      taskId: input.taskId,
      type: EVENT_TYPES.ROUND_STALE,
      payload: input,
    });
  }

  /**
   * 计划翻转：广播 plan.status.<to>。teamId 缺省时经任务行回查；
   * 查不到则仅告警不抛错（事件缺席可由订阅者清单单测发现，不阻断翻转）。
   */
  async emitPlanStatusChanged(input: {
    taskId: string;
    teamId?: string | null;
    from: string | null;
    to: string;
  }): Promise<void> {
    let teamId = input.teamId ?? null;
    if (!teamId) {
      const task = (await this.prisma.task.findUnique({
        where: { id: input.taskId },
        select: { teamId: true },
      })) as unknown as { teamId?: string | null } | null;
      teamId = task?.teamId ?? null;
    }
    if (!teamId) {
      this.logger.warn(
        `[receipts] plan.status 事件无归属团队 task=${input.taskId} to=${input.to}（跳过广播）`,
      );
      return;
    }
    await this.emitTeamChannel({
      teamId,
      taskId: input.taskId,
      type: `plan.status.${input.to}`,
      payload: {
        taskId: input.taskId,
        teamId,
        from: input.from,
        to: input.to,
      } satisfies PlanStatusChangedPayload,
    });
  }

  private async emitTeamChannel(args: {
    teamId: string;
    taskId: string | null;
    type: string;
    payload: object;
  }): Promise<void> {
    const channelId = await this.resolveTeamGroupChannel(args.teamId);
    const payload = { ...args.payload, channelId };
    await this.realtime.broadcast(args.type, payload, {
      type: 'team',
      id: args.teamId,
    });
    if (channelId) {
      await this.realtime.broadcast(args.type, payload, {
        type: 'channel',
        id: channelId,
      });
    }
  }

  private async resolveTeamGroupChannel(
    teamId: string,
  ): Promise<string | null> {
    try {
      const channel = (await this.prisma.chatChannel.findFirst({
        where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
        select: { id: true },
      })) as unknown as { id: string } | null;
      return channel?.id ?? null;
    } catch {
      return null;
    }
  }
}
