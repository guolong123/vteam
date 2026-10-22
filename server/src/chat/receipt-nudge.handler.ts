import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  TRIGGER_KIND,
  buildTriggerDedupKey,
} from '../common/constants/trigger.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  TriggerFireContext,
  TriggerOutcome,
  TriggerService,
} from '../timers/trigger.service';
import { MessageReceiptsService } from './message-receipts.service';
import { WorkerDispatcher } from './worker-dispatcher';

export const RECEIPT_NUDGE_KIND = 'receipt_nudge';
/**
 * 回执超时缺省值（分钟）。2026-09-16 由 10 上调至 30：实测 10min 内 agent 常仍在正常
 * 干活（模型思考 + 工具执行），此时催办属噪音；30min 未回执才更可能是真的遗漏。
 */
export const RECEIPT_TIMEOUT_DEFAULT_MIN = 30;
export const RECEIPT_TIMEOUT_CLAMP_MIN = 1;
export const RECEIPT_TIMEOUT_CLAMP_MAX = 1440;
export const MAX_AUTO_NUDGES = 1;

/**
 * 按被指派人催办冷却窗（防同一人连环 call）：窗口内任一回执（含已 fired 的
 * lastNudgedAt）已被催办过 → 本轮静默跳过，使同批多条派发只催一次。
 * 2026-09-16 独立于超时并上调至 60min：催办是「兜底提醒」而非「催促开工」，
 * 与收据超时（30min）解耦后，同一人最快 1 小时才会再次被催。
 */
export const NUDGE_COOLDOWN_MS = 60 * 60 * 1000;

export function normalizeReceiptTimeoutMin(input: unknown): number {
  const n = typeof input === 'string' ? Number(input) : (input as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return RECEIPT_TIMEOUT_DEFAULT_MIN;
  }
  const floored = Math.floor(n);
  if (floored < RECEIPT_TIMEOUT_CLAMP_MIN) {
    return RECEIPT_TIMEOUT_DEFAULT_MIN;
  }
  if (floored > RECEIPT_TIMEOUT_CLAMP_MAX) {
    return RECEIPT_TIMEOUT_CLAMP_MAX;
  }
  return floored;
}

export function buildReceiptNudgeDedupKey(
  teamId: string,
  receiptId: string,
): string {
  // trigger-unification todo-5/6：经 buildTriggerDedupKey 组装，
  // 与历史 `receipt_nudge:{teamId}:{receiptId}` 逐字节一致（spec 锁定）。
  return buildTriggerDedupKey(TRIGGER_KIND.RECEIPT_NUDGE, teamId, receiptId);
}

export interface ReceiptNudgePayload {
  receiptId: string;
  teamId: string;
  taskId: string | null;
  channelId: string;
  messageId: string;
  fromInstanceId: string;
  toInstanceId: string;
  assigneeName?: string | null;
  /** 发起人显示名（原派发方；缺省回退 fromInstanceId），用于催办文案标明来源。 */
  fromName?: string | null;
}

/**
 * A4-3：催办文案分级——平台**能确证**的态势只有三种，外加一种「证不出来」。
 *
 * - not-started（未开工）：目标既没有回执、也没有任何交付痕迹（无回信消息、无产出物）。
 * - delivered-unsettled（已交付未销账）：账本里**查得到**该目标的回执/交付记录
 *   （他确实回过执、平台也记了），但这条派发的完工回执仍未销 ⇒ 是平台没结账，不是他没干。
 * - receipt-not-landed（回执未送达）：有交付痕迹，但账本里**查不到**他的回执记录
 *   ⇒ 那次回执没落账（me_0000000069），或他压根没走回执登记、只在群里答复了
 *   （me_0000000016「群聊答复不算回执」）。
 * - unknown：探针读错或证据不足 ⇒ 走通用文案（**不假装知道**）。
 *
 * 诚实的边界：平台**分不清**「回执调用发生了但没落账」与「压根没调用回执、只在群里
 * 答了」——两者在账本上都表现为「查不到回执记录」。故文案只陈述平台看到的事实
 * （「账本里查不到你的回执记录」），不指控成员。
 */
export type ReceiptNudgeCase =
  'not-started' | 'delivered-unsettled' | 'receipt-not-landed' | 'unknown';

export interface AutoNudgeTextInput {
  messageId: string;
  receiptId: string;
  attempt: number;
  elapsedMin: number;
  fromLabel: string;
  toLabel: string;
  /**
   * 平台确证的态势；缺省 = unknown（通用文案）。
   * 缺省必须存在：既有调用方（与既有 spec）不带这个字段也能拿到可用文案。
   */
  nudgeCase?: ReceiptNudgeCase;
}

/**
 * A4-3 催办文案：分级 + **销账动作**。
 *
 * 为什么要改口径：旧文案只说「已发出约 N 分钟仍无回执」——这句话在多数真实场景里
 * 是**假的**（人已经干完了，只是账本没记上，me_0000000016 / me_0000000069），
 * 于是催办变成了对正确行为的惩罚，agent 被逼回「自己干」模式。
 * 新文案先说平台**确证**的态势，再给**可执行的销账动作**（引用派发消息 id 发一条
 * 即自动销账，批次 A4 的引用即销账）——顺带劝退「用 notify 清账」这个会越清越多的
 * 动作（me_0000000030）。
 */
export function buildAutoNudgeText(input: AutoNudgeTextInput): string {
  const diagnosis = buildNudgeDiagnosis(input);
  const action = buildNudgeAction(input);
  return (
    `【平台自动催办·第${input.attempt}次】${input.fromLabel} → ${input.toLabel}：` +
    `${diagnosis}（原派发消息 ${input.messageId}，receiptId=${input.receiptId}）。` +
    `${action}`
  );
}

/** A4-3：态势描述句（平台确证的部分）。 */
function buildNudgeDiagnosis(input: AutoNudgeTextInput): string {
  switch (input.nudgeCase ?? 'unknown') {
    case 'not-started':
      return (
        `平台没有看到你的任何回复或产出物，这条派发已发出约 ${input.elapsedMin} 分钟` +
        `（既没有回执、也没有交付痕迹）`
      );
    case 'delivered-unsettled':
      return (
        `平台账本里已经记到你的交付（看起来活儿是干完了），但这条派发的完工回执还没销掉` +
        `——是平台没结账，不是你没干`
      );
    case 'receipt-not-landed':
      return (
        `平台账本里查不到你的回执记录，这条派发已发出约 ${input.elapsedMin} 分钟` +
        `（那次回执没落账，或你只在群里答复了、没走回执登记）`
      );
    default:
      return (
        `原派发消息已发出约 ${input.elapsedMin} 分钟仍无回执` +
        `（平台未能确证当前态势）`
      );
  }
}

/** A4-3：收件人该做什么（销账动作）。 */
function buildNudgeAction(input: AutoNudgeTextInput): string {
  const quote = `带原派发消息 id（${input.messageId}）发一条回复即可自动销账`;
  switch (input.nudgeCase ?? 'unknown') {
    case 'not-started':
      return '请先开工；做完后用 vteam_notify_agent 回执（type=answer、stage=end）。';
    case 'delivered-unsettled':
      return `销账动作：${quote}；或让主 Agent 手工核销。你不用重做。`;
    case 'receipt-not-landed':
      return (
        `销账动作：${quote}。不要用 notify_agent 去"清"账——每调一次 notify_agent ` +
        `就多一行账（只会越清越多，me_0000000030）。`
      );
    default:
      return `销账动作：${quote}；若还没做完，请回执说明进度。`;
  }
}

export function buildEscalationNotice(
  nudgeCount: number,
  fromLabel?: string,
  toLabel?: string,
): string {
  const pair = fromLabel && toLabel ? `${fromLabel} → ${toLabel}：` : '';
  return `【自动催办】${pair}已自动催办${nudgeCount}次仍无回执，请升级处理`;
}

@Injectable()
export class ReceiptNudgeHandler implements OnModuleInit {
  private readonly logger = new Logger(ReceiptNudgeHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly timers: TriggerService,
    private readonly receipts: MessageReceiptsService,
    private readonly workerDispatcher: WorkerDispatcher,
  ) {}

  onModuleInit() {
    this.timers.registerHandler(RECEIPT_NUDGE_KIND, (timer) =>
      this.handle(timer),
    );
  }

  /**
   * trigger-unification todo-5：显式 TriggerOutcome 迁移。
   * 全部路径返回 {done:true}（无 {expire:true}）：基座 void≡{done:true}≡fired，
   * 任一 no-op 都是"本次无需动作"，绝非"取消该 trigger"——expire 会落
   * cancelled，与原语义（one-shot fired）不等价，故禁用。
   */
  async handle(timer: TriggerFireContext): Promise<TriggerOutcome> {
    const payload = (timer?.payload ?? {}) as Partial<ReceiptNudgePayload>;
    const receiptId = payload.receiptId;
    if (!receiptId) {
      this.logger.warn(
        `[receipt-nudge] timer ${timer?.id} 缺 receiptId（跳过，不重排）`,
      );
      return { done: true };
    }
    const receipt = await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
    });
    const row = receipt as unknown as {
      id: string;
      messageId: string | null;
      taskId: string | null;
      teamId: string;
      fromInstanceId: string;
      toInstanceId: string;
      status?: string;
      nudgeCount?: number;
      createdAt?: Date | string;
    } | null;
    if (!row || row.status !== 'pending') {
      return { done: true };
    }
    // 批次 A4（me_0000000061）：催办前先问一句「这条回执是不是已经被主 Agent 的
    // 应答结掉了」——主 Agent 明明答了，平台不该再反过来催它。
    // 结账扫描失败一律放行（不因探针失败而漏催）。
    await this.settleAnsweredQuestionReceiptsQuietly();
    const afterSettle = (await this.prisma.messageReceipt.findUnique({
      where: { id: receiptId },
    })) as unknown as { status?: string } | null;
    if (!afterSettle || afterSettle.status !== 'pending') {
      this.logger.log(
        `[receipt-nudge] receipt=${receiptId} 已被应答结账，不再催办（me_0000000061）`,
      );
      return { done: true };
    }
    const nudged = typeof row.nudgeCount === 'number' ? row.nudgeCount : 0;
    if (nudged < MAX_AUTO_NUDGES) {
      if (await this.isMessageAlreadyNudged(row.messageId, row.id)) {
        this.logger.log(
          `[receipt-nudge] 原派发消息 ${row.messageId ?? '(未知)'} 已催办过（其他回执行），跳过 receipt=${row.id}`,
        );
        return { done: true };
      }
      if (await this.isAssigneeMuted(row.toInstanceId, row.id)) {
        this.logger.log(
          `[receipt-nudge] 被指派人 ${row.toInstanceId} 冷却期内已催办过，跳过 receipt=${row.id}（防连环 call）`,
        );
        return { done: true };
      }
      const createdAt = row.createdAt ? new Date(row.createdAt).getTime() : NaN;
      const elapsedMin = Number.isFinite(createdAt)
        ? Math.max(1, Math.round((Date.now() - createdAt) / 60000))
        : RECEIPT_TIMEOUT_DEFAULT_MIN;
      const fromLabel = payload.fromName ?? row.fromInstanceId;
      const toLabel = payload.assigneeName ?? row.toInstanceId;
      const nudgeCase = await this.classifyNudgeCase(row);
      const text = `@${toLabel} ${buildAutoNudgeText({
        messageId: row.messageId ?? '(未知)',
        receiptId: row.id,
        attempt: nudged + 1,
        elapsedMin,
        fromLabel,
        toLabel,
        nudgeCase,
      })}`;
      await this.workerDispatcher.dispatchAgentMention({
        taskId: row.taskId ?? null,
        teamId: row.teamId,
        channelId: payload.channelId as string,
        text,
        targetInstanceId: row.toInstanceId,
        kind: 'nudge',
      });
      await this.receipts.recordAutoNudge(row.id);
      // 到期补排：trigger one-shot 语义下本次 fire 后永无第二次 fire，
      // expireAfterAutoNudge 不可达 → 僵尸 pending 堆积（drain 永不到）。
      // 补排同 receipt 的到期 trigger：到期再 fire 一次时 nudgeCount 已耗尽，
      // 走过期分支清账 + settled hook 重查 drain。
      await this.scheduleExpiryFollowUp({
        teamId: row.teamId,
        receiptId: row.id,
        payload: payload as ReceiptNudgePayload,
      });
      return { done: true };
    }
    await this.receipts.expireAfterAutoNudge(
      {
        id: row.id,
        messageId: row.messageId,
        taskId: row.taskId,
        teamId: row.teamId,
        fromInstanceId: row.fromInstanceId,
        toInstanceId: row.toInstanceId,
        nudgeCount: nudged,
      },
      buildEscalationNotice(
        nudged,
        payload.fromName ?? row.fromInstanceId,
        payload.assigneeName ?? row.toInstanceId,
      ),
    );
    return { done: true };
  }

  /**
   * 到期补排：催办后为同 receipt 再排一次到期 trigger（dedupKey 后缀 :expiry，
   * 与首排键不冲突——schedule 按 key 幂等，已 fired 行也会挡同键重排）。
   * 到期 fire 时 nudgeCount 已耗尽 → 走 expireAfterAutoNudge 清账并经 settled
   * hook 重查 drain。排期失败只记 warn（不阻断本次催办已完成的主流程）。
   */
  private async scheduleExpiryFollowUp(input: {
    teamId: string;
    receiptId: string;
    payload: ReceiptNudgePayload;
  }): Promise<void> {
    try {
      await this.timers.schedule(
        RECEIPT_NUDGE_KIND,
        new Date(Date.now() + RECEIPT_TIMEOUT_DEFAULT_MIN * 60 * 1000),
        input.payload,
        buildTriggerDedupKey(
          TRIGGER_KIND.RECEIPT_NUDGE,
          input.teamId,
          `${input.receiptId}:expiry`,
        ),
      );
    } catch (err) {
      this.logger.warn(
        `[receipt-nudge] 到期补排失败 receipt=${input.receiptId}（僵尸过期缺席）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  /**
   * A4-3：判出平台**能确证**的态势（只读探针，不改任何行）。
   *
   * 判据（全部来自账本/消息/产出物，只读）：
   *   ① 目标在派发之后**有没有**在该频道回过话、有没有**产出物** ⇒ 有无交付痕迹；
   *   ② 账本里**查不查得到**这些回信对应的回执行 ⇒ 回执有没有落账。
   * 三者组合出四档：见 ReceiptNudgeCase 的注释。
   *
   * 探针读错 ⇒ 回落 unknown（通用文案），**不假装知道**（brief 要求）。
   */
  private async classifyNudgeCase(row: {
    messageId: string | null;
    taskId: string | null;
    teamId: string;
    toInstanceId: string;
  }): Promise<ReceiptNudgeCase> {
    try {
      if (!row.messageId) {
        return 'unknown';
      }
      const dispatch = (await this.prisma.message.findUnique({
        where: { id: row.messageId },
        select: { channelId: true, createdAt: true },
      })) as unknown as { channelId: string; createdAt: Date } | null;
      if (!dispatch) {
        return 'unknown';
      }
      const replies = (await this.prisma.message.findMany({
        where: {
          channelId: dispatch.channelId,
          senderInstanceId: row.toInstanceId,
          createdAt: { gt: dispatch.createdAt },
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true },
      })) as unknown as Array<{ id: string }>;
      const hasDeliverable = await this.hasDeliverableFromTarget(
        row.toInstanceId,
        row.taskId,
        dispatch.createdAt,
      );
      if (!replies || replies.length === 0) {
        if (!hasDeliverable) {
          return 'not-started';
        }
        return 'receipt-not-landed';
      }
      const registered = await this.prisma.messageReceipt.count({
        where: { messageId: { in: replies.map((r) => r.id) } },
      });
      return registered > 0 ? 'delivered-unsettled' : 'receipt-not-landed';
    } catch (err) {
      this.logger.warn(
        `[receipt-nudge] 态势判据探针读错（按 unknown 通用文案）receipt=${row.messageId}：${err instanceof Error ? err.message : String(err)}`,
      );
      return 'unknown';
    }
  }

  /**
   * A4-3：目标成员在该任务上有没有产出物（产出物作者是 agent id，故先解析成员→agent）。
   * 读错按「无产出物」处理（fail-safe：宁可说未开工，也不误报已交付）。
   */
  private async hasDeliverableFromTarget(
    toInstanceId: string,
    taskId: string | null,
    after: Date,
  ): Promise<boolean> {
    try {
      const member = (await this.prisma.teamMember.findUnique({
        where: { id: toInstanceId },
        select: { agentId: true },
      })) as unknown as { agentId?: string | null } | null;
      if (!member?.agentId) {
        return false;
      }
      const version = (await this.prisma.artifactVersion.findFirst({
        where: {
          authorAgentId: member.agentId,
          createdAt: { gt: after },
          ...(taskId ? { artifact: { taskId } } : {}),
        },
        select: { id: true },
      })) as unknown as { id: string } | null;
      return version !== null;
    } catch (err) {
      this.logger.warn(
        `[receipt-nudge] 产出物探针读错（按无产出物）member=${toInstanceId}：${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * A4-2：催办前静默尝试「主 Agent 已应答 ⇒ 结掉 question/help 回执」。
   * 失败只 warn：结账是补偿动作，绝不能因它把正常催办搞挂。
   */
  private async settleAnsweredQuestionReceiptsQuietly(): Promise<void> {
    try {
      const settled = await this.receipts.settleAnsweredQuestionReceipts();
      if (settled > 0) {
        this.logger.log(
          `[receipt-nudge] 主 Agent 已应答，${settled} 条 question/help 回执行结账（me_0000000061）`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[receipt-nudge] 应答结账扫描失败（不阻断催办）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 原派发消息是否已催办过（同 messageId 硬幂等）。
   *
   * 一条消息可能对应**多条**回执行（常规派发行 + force 审计行，dedupKey 不同），
   * 故必须按 messageId 跨行判重，而非只看本行 nudgeCount：
   * 任一兄弟行 nudgeCount>0 → 本行不再催办，同消息永不二次推送。
   * 查询失败按未催办处理（fail-open：宁可多催一次，不漏催）。
   */
  private async isMessageAlreadyNudged(
    messageId: string | null,
    currentReceiptId: string,
  ): Promise<boolean> {
    if (!messageId) return false;
    try {
      const hit = (await this.prisma.messageReceipt.findFirst({
        where: {
          messageId,
          nudgeCount: { gt: 0 },
          id: { not: currentReceiptId },
        },
        select: { id: true },
      })) as unknown as { id: string } | null;
      return hit !== null;
    } catch (err) {
      this.logger.warn(
        `[receipt-nudge] 同消息催办查询失败 message=${messageId}（按未催办继续）：${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 被指派人是否处于催办冷却期（按人聚合，防连环 call）。
   *
   * 查该人**全部**回执中最近的 lastNudgedAt（含已 fired 的历史行）：
   * 窗口内已催过 → true（本次静默跳过，不写库不重排）。
   * 这是"按人"而非"按消息"去重的落点——同一批派发 N 条消息给同一人只催一次。
   * 查询失败按未冷却处理（fail-open：宁可多催一次，不漏催）。
   */
  private async isAssigneeMuted(
    toInstanceId: string,
    currentReceiptId: string,
  ): Promise<boolean> {
    try {
      const last = (await this.prisma.messageReceipt.findFirst({
        where: {
          toInstanceId,
          lastNudgedAt: { gte: new Date(Date.now() - NUDGE_COOLDOWN_MS) },
          id: { not: currentReceiptId },
        },
        orderBy: { lastNudgedAt: 'desc' },
        select: { id: true },
      })) as unknown as { id: string } | null;
      return last !== null;
    } catch (err) {
      this.logger.warn(
        `[receipt-nudge] 冷却查询失败 to=${toInstanceId}（按未冷却继续）：${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
