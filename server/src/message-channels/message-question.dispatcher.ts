import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService, RealtimeEvent } from '../realtime/realtime.service';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { MessageRegistryService } from './message-registry.service';
import { MessageDeliveryService } from './message-delivery.service';
import { WecomAibotAdapter } from './adapters/wecom-aibot.adapter';
import { MESSAGE_CHANNEL_TYPES, DELIVERY_DIRECTIONS, DELIVERY_STATUS } from './message-channel.constants';

@Injectable()
export class MessageQuestionDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageQuestionDispatcher.name);
  private unsubscribe: (() => void) | null = null;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
    private readonly registry: MessageRegistryService,
    private readonly delivery: MessageDeliveryService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribe = this.realtime.subscribe((event) => {
      if (event.type !== EVENT_TYPES.AGENT_QUESTION) return;
      void this.handle(event).catch((err: unknown) =>
        this.logger.error(`handle AGENT_QUESTION failed: ${(err as Error).message}`),
      );
    });
    this.logger.log('MessageQuestionDispatcher subscribed to AGENT_QUESTION');
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.queues.clear();
  }

  async handle(event: RealtimeEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      managed?: boolean;
      resolved?: boolean;
      taskId?: string | null;
      question?: {
        id?: string;
        requestId?: string;
        taskId?: string | null;
        kind?: string;
        content?: unknown;
        status?: string;
        managedMode?: boolean;
        managed?: boolean;
      } & Record<string, unknown>;
    };
    if (payload.resolved === true) return;
    const question = payload.question;
    if (!question) return;
    const status = question.status as string | undefined;
    if (status !== undefined && status !== 'pending') return;

    const taskId: string | null =
      (question.taskId as string | null) ??
      (payload as any).taskId ??
      null;
    if (!taskId) return;

    const isManaged =
      question.managedMode === true ||
      question.managed === true ||
      payload.managed === true;

    if (isManaged) {
      const shouldSendForManaged = await this.isSelfLoopTask(taskId, question as any);
      if (!shouldSendForManaged) return;
      this.logger.log(`managed self-loop question will still send WeCom card taskId=${taskId} requestId=${question.requestId ?? question.id}`);
    }

    const channels = await this.resolveWecomChannelsForTask(taskId);
    if (channels.length === 0) return;

    const aqId = (question.id as string) ?? (question.requestId as string) ?? '';
    const kind = (question.kind as string) ?? 'question';
    const content = (question as any).content ?? question;

    const prismaRow = aqId
      ? await (this.prisma as any).agentQuestion.findUnique({
          where: { id: aqId },
          select: { id: true, requestId: true, kind: true, content: true, status: true },
        }).catch(() => null)
      : null;

    const dispatchQuestion = prismaRow
      ? { id: prismaRow.id, requestId: prismaRow.requestId, kind: prismaRow.kind, content: prismaRow.content }
      : { id: aqId, requestId: question.requestId as string | undefined, kind, content };

    if (prismaRow && prismaRow.status !== 'pending') return;

    for (const ch of channels) {
      void this.dispatchToChannel(ch, dispatchQuestion).catch(() => {});
    }
  }

  async dispatchQuestionCard(
    taskId: string,
    questionRow: { id: string; requestId?: string; kind: string; content: any },
  ): Promise<void> {
    const channels = await this.resolveWecomChannelsForTask(taskId);
    if (channels.length === 0) {
      this.logger.warn(`dispatchQuestionCard no wecom channels bound taskId=${taskId} aqId=${questionRow.id}`);
      return;
    }
    for (const ch of channels) {
      await this.dispatchToChannel(ch, questionRow);
    }
  }

  private async isSelfLoopTask(taskId: string, question: { sessionId?: string }): Promise<boolean> {
    try {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { mainAgentInstanceId: true },
      });
      if (!task?.mainAgentInstanceId || !question.sessionId) return false;
      const sess = await (this.prisma as any).session.findUnique({
        where: { id: question.sessionId },
        select: { taskAgentId: true },
      }).catch(() => null);
      return sess?.taskAgentId === task.mainAgentInstanceId;
    } catch {
      return false;
    }
  }

  private async resolveWecomChannelsForTask(taskId: string): Promise<any[]> {
    let links: Array<{ messageChannelId: string }>;
    try {
      links = await (this.prisma as any).taskMessageChannel.findMany({
        where: { taskId },
        select: { messageChannelId: true },
      });
    } catch {
      return [];
    }
    if (!links || links.length === 0) return [];
    const ids = links.map((l) => l.messageChannelId).filter(Boolean);
    if (ids.length === 0) return [];
    let channels: any[];
    try {
      channels = await (this.prisma as any).messageChannel.findMany({
        where: { id: { in: ids }, enabled: true, type: MESSAGE_CHANNEL_TYPES.wecom_aibot },
      });
    } catch {
      return [];
    }
    return channels;
  }

  private async dispatchToChannel(channel: any, question: { id: string; kind: string; content: any }): Promise<void> {
    const prev = this.queues.get(channel.id) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        let deliveryId: string | null = null;
        try {
          const logRes = await this.delivery.log(
            DELIVERY_DIRECTIONS.outbound,
            'question_card',
            'pending',
            { channelId: channel.id, payload: question as unknown },
          );
          deliveryId = (logRes as { id: string })?.id ?? null;

          const adapter = this.registry.get(MESSAGE_CHANNEL_TYPES.wecom_aibot) as WecomAibotAdapter | undefined;
          if (!adapter || typeof (adapter as any).sendQuestionCard !== 'function') {
            throw new Error(`adapter not found for type ${MESSAGE_CHANNEL_TYPES.wecom_aibot}`);
          }
          const resolved = {
            id: channel.id,
            type: channel.type,
            config: (channel.config as Record<string, any>) ?? {},
            secrets: (channel.secrets as Record<string, any>) ?? {},
            enabled: channel.enabled ?? true,
          };
          const res = await (adapter as any).sendQuestionCard(resolved, question);
          if (deliveryId) {
            try {
              await this.delivery.finish(
                deliveryId,
                DELIVERY_STATUS.ok,
                null,
                question as unknown,
                res as unknown,
              );
            } catch {}
          }
          this.logger.log(`wecom question card sent channel=${channel.id} aqId=${question.id} kind=${question.kind}`);
        } catch (e) {
          const errMsg = (e as Error).message ?? String(e);
          this.logger.error(`dispatchToChannel failed channel=${channel.id} aqId=${question.id}: ${errMsg}`);
          try {
            if (deliveryId) {
              await this.delivery.finish(
                deliveryId,
                DELIVERY_STATUS.failed,
                errMsg,
                question as unknown,
                null,
              );
            } else {
              await this.delivery.log(
                DELIVERY_DIRECTIONS.outbound,
                'question_card',
                DELIVERY_STATUS.failed,
                {
                  channelId: channel.id,
                  error: errMsg,
                  payload: question as unknown,
                },
              );
            }
          } catch {}
        }
      })
      .catch(() => {});

    this.queues.set(channel.id, next);
    return next;
  }
}
