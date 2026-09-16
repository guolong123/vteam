import { Injectable, Logger } from '@nestjs/common';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { CHANNEL_TYPE } from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

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
 * 派发回执记账/清账与回执·轮次·计划事件发射
 *（plan-review-execution-gates Todo 5，31 篇 §3.2-§3.4）。
 *
 * 事件一律走 team:/channel: 双订阅发射：team 帧必发（会话页 team: + 看板页
 * team: 段接收）；channel 帧在频道可解析时加发（会话页 channel: 段接收）。
 * 订阅者清单见 realtime/realtime-subscriptions.ts。
 */
@Injectable()
export class MessageReceiptsService {
  private readonly logger = new Logger(MessageReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * 清账：pending→acked（幂等：非 pending 直接返回，不写库不广播），
   * 随后广播 receipt.acked。
   */
  async ack(receiptId: string) {
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
      data: { status: 'acked', ackedAt },
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
      } satisfies ReceiptEventPayload,
    });
    return updated;
  }

  /** 超时清账：全部已到期 pending→expired，每条广播 receipt.expired。 */
  async expireDue(now: Date = new Date()) {
    const due = (await this.prisma.messageReceipt.findMany({
      where: { status: 'pending', expiresAt: { lte: now } },
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
