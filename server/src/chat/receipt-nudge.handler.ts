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

export function buildAutoNudgeText(input: {
  messageId: string;
  receiptId: string;
  attempt: number;
  elapsedMin: number;
  fromLabel: string;
  toLabel: string;
}): string {
  return (
    `【平台自动催办·第${input.attempt}次】${input.fromLabel} → ${input.toLabel}：` +
    `原派发消息 ${input.messageId} 已发出约 ${input.elapsedMin} 分钟仍无回执` +
    `（receiptId=${input.receiptId}），请尽快确认并处理。`
  );
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
      const text = `@${toLabel} ${buildAutoNudgeText({
        messageId: row.messageId ?? '(未知)',
        receiptId: row.id,
        attempt: nudged + 1,
        elapsedMin,
        fromLabel,
        toLabel,
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
