import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimerFireContext, TimerService } from '../timers/timer.service';
import { MessageReceiptsService } from './message-receipts.service';
import { WorkerDispatcher } from './worker-dispatcher';

export const RECEIPT_NUDGE_KIND = 'receipt_nudge';
export const RECEIPT_TIMEOUT_DEFAULT_MIN = 10;
export const RECEIPT_TIMEOUT_CLAMP_MIN = 1;
export const RECEIPT_TIMEOUT_CLAMP_MAX = 1440;
export const MAX_AUTO_NUDGES = 1;

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
  return `${RECEIPT_NUDGE_KIND}:${teamId}:${receiptId}`;
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
}): string {
  return (
    `【平台自动催办·第${input.attempt}次】原派发消息 ${input.messageId} ` +
    `已发出约 ${input.elapsedMin} 分钟仍无回执（receiptId=${input.receiptId}），请尽快确认并处理。`
  );
}

export function buildEscalationNotice(nudgeCount: number): string {
  return `【自动催办】已自动催办${nudgeCount}次仍无回执，请升级处理`;
}

@Injectable()
export class ReceiptNudgeHandler implements OnModuleInit {
  private readonly logger = new Logger(ReceiptNudgeHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly timers: TimerService,
    private readonly receipts: MessageReceiptsService,
    private readonly workerDispatcher: WorkerDispatcher,
  ) {}

  onModuleInit() {
    this.timers.registerHandler(RECEIPT_NUDGE_KIND, (timer) =>
      this.handle(timer),
    );
  }

  async handle(timer: TimerFireContext): Promise<void> {
    const payload = (timer?.payload ?? {}) as Partial<ReceiptNudgePayload>;
    const receiptId = payload.receiptId;
    if (!receiptId) {
      this.logger.warn(
        `[receipt-nudge] timer ${timer?.id} 缺 receiptId（跳过，不重排）`,
      );
      return;
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
      return;
    }
    const nudged = typeof row.nudgeCount === 'number' ? row.nudgeCount : 0;
    if (nudged < MAX_AUTO_NUDGES) {
      const createdAt = row.createdAt ? new Date(row.createdAt).getTime() : NaN;
      const elapsedMin = Number.isFinite(createdAt)
        ? Math.max(1, Math.round((Date.now() - createdAt) / 60000))
        : RECEIPT_TIMEOUT_DEFAULT_MIN;
      const text = `@${payload.assigneeName ?? row.toInstanceId} ${buildAutoNudgeText(
        {
          messageId: row.messageId ?? '(未知)',
          receiptId: row.id,
          attempt: nudged + 1,
          elapsedMin,
        },
      )}`;
      await this.workerDispatcher.dispatchAgentMention({
        taskId: row.taskId ?? null,
        teamId: row.teamId,
        channelId: payload.channelId as string,
        text,
        targetInstanceId: row.toInstanceId,
        kind: 'nudge',
      });
      await this.receipts.recordAutoNudge(row.id);
      return;
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
      buildEscalationNotice(nudged),
    );
  }
}
