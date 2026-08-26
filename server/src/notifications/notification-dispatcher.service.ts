import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService, RealtimeEvent } from '../realtime/realtime.service';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
} from '../common/constants/event.constants';
import { NotificationRegistryService } from './notification-registry.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import {
  NotificationChannelResolved,
  OutboundMessage,
} from './notification-adapter';
import {
  DELIVERY_DIRECTIONS,
  DELIVERY_STATUS,
  NOTIFICATION_EVENTS,
} from './notification.constants';

export function formatTaskStatusMarkdown(
  payload: {
    taskId?: string;
    from?: string | null;
    to?: string | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    actorType?: string;
    actorId?: string;
  },
  title?: string,
): string {
  const from = payload.from ?? payload.fromStatus ?? null;
  const to = payload.to ?? payload.toStatus ?? null;
  const taskLabel = title
    ? `《${title}》`
    : `任务 ${payload.taskId ?? 'unknown'}`;
  const transition =
    from && to
      ? `状态从 \`${from}\` 变更为 \`${to}\``
      : to
        ? `状态变更为 \`${to}\``
        : from
          ? `状态从 \`${from}\` 变更`
          : '状态已变更';
  const actor = payload.actorType
    ? `（操作者：${payload.actorType}${payload.actorId ? `/${payload.actorId}` : ''}）`
    : '';
  return `【任务状态变更】${taskLabel} ${transition}${actor}`;
}

function formatQuestionText(question: Record<string, unknown>): string {
  const kind = question.kind as string | undefined;
  const content: any = (question as any).content ?? question;
  if (kind === 'permission') {
    const title =
      typeof content.title === 'string' ? content.title : '权限确认';
    const pattern =
      typeof content.pattern === 'string'
        ? content.pattern
        : typeof content.type === 'string'
          ? content.type
          : '';
    return `【权限请求】${title}${pattern ? ` - ${pattern}` : ''}（请前往Web处理）`;
  }
  if (kind === 'question' && Array.isArray(content.questions)) {
    const qs: any[] = content.questions;
    if (qs.length === 1) {
      const q0 = qs[0] ?? {};
      const qText =
        typeof q0.question === 'string'
          ? q0.question
          : typeof q0.header === 'string'
            ? q0.header
            : JSON.stringify(q0);
      const opts: any[] = Array.isArray(q0.options) ? q0.options : [];
      if (opts.length > 0) {
        const labels = opts
          .slice(0, 6)
          .map((o: any) =>
            typeof o === 'string'
              ? o
              : typeof o?.label === 'string'
                ? o.label
                : String(o ?? ''),
          )
          .join(' / ');
        return `【待确认】${qText}（选项：${labels}）`;
      }
      return `【待确认】${qText}`;
    }
    if (qs.length > 1) {
      return `【待确认】${qs.length}个问题待处理，请前往Web处理`;
    }
  }
  // fallback: try to extract human-readable text
  const maybeText =
    (question as any).text ??
    content.text ??
    content.header ??
    content.title ??
    null;
  if (typeof maybeText === 'string' && maybeText.trim().length > 0) {
    return `【待确认】${maybeText.trim()}`;
  }
  try {
    const json = JSON.stringify(question);
    return `【待确认】${json.slice(0, 500)}`;
  } catch {
    return '【待确认】请前往Web处理';
  }
}

/**
 * Notifications are agent-decided via MCP, not auto-pushed.
 *
 * Inbound webhooks (generic/github/gitee/wecom) still post to task group via
 * MessageInboundService. Outbound webhook notification is NO LONGER auto-triggered
 * on task status change / agent reply / agent question. The agent must explicitly
 * call the MCP tool `channel_send` (which routes to `sendToChannelByIdOrName` /
 * `dispatchToChannel`) to push to a notification channel.
 *
 * WeCom (enterprise WeChat) inbound/outbound remains independent: private/group
 * replies go via WS direct reply (MessageAdapter.replyStream), not via this dispatcher.
 */
@Injectable()
export class NotificationDispatcherService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationDispatcherService.name);

  private readonly queues = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  /**
   * Auto-push disabled by default. Notifications are agent-decided via MCP only.
   * Set NOTIFICATION_AUTO_PUSH=true to re-enable legacy auto-dispatch (not recommended).
   */
  private readonly autoPushEnabled: boolean =
    process.env.NOTIFICATION_AUTO_PUSH === 'true';

  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
    private readonly registry: NotificationRegistryService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.autoPushEnabled) {
      this.logger.log(
        'Notification auto-push disabled: outbound webhook notifications are agent-decided via MCP channel_send only',
      );
      return;
    }
    this.unsubscribe = this.realtime.subscribe((event) => {
      void this.handle(event).catch((err: unknown) =>
        this.logger.error(
          `handle event ${event.type} failed: ${(err as Error).message}`,
        ),
      );
    });
  }

  onModuleDestroy(): void {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {}
      this.unsubscribe = null;
    }
    this.queues.clear();
  }

  async handle(event: RealtimeEvent): Promise<void> {
    // Decoupled: auto-push disabled by default. Agent must call channel_send MCP tool.
    if (!this.autoPushEnabled) {
      return;
    }
    switch (event.type) {
      case EVENT_TYPES.TASK_STATUS_CHANGED:
      case NOTIFICATION_EVENTS.TASK_STATUS_CHANGED:
      case 'task.status.changed':
      case 'task.status_changed':
        await this.handleTaskStatusChanged(event);
        break;
      case EVENT_TYPES.AGENT_QUESTION:
      case NOTIFICATION_EVENTS.AGENT_QUESTION:
      case 'agent.question':
        await this.handleAgentQuestion(event);
        break;
      case EVENT_TYPES.CHAT_MESSAGE_NEW:
      case 'chat.message.new':
      case 'message_created':
      case NOTIFICATION_EVENTS.AGENT_REPLY:
      case 'agent.reply':
        await this.handleAgentReply(event);
        break;
      default:
        if (
          event.type === 'chat.message.new' ||
          event.type === 'message_created' ||
          event.type === NOTIFICATION_EVENTS.AGENT_REPLY
        ) {
          await this.handleAgentReply(event);
        }
        break;
    }
  }

  private async handleTaskStatusChanged(event: RealtimeEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      taskId?: string;
      from?: string | null;
      to?: string | null;
      fromStatus?: string | null;
      toStatus?: string | null;
      actorType?: string;
      actorId?: string;
    };
    const taskId = payload.taskId;
    if (!taskId) return;

    const channels = await this.resolveChannelsForTask(
      taskId,
      NOTIFICATION_EVENTS.TASK_STATUS_CHANGED,
    );
    if (channels.length === 0) return;

    const taskTitle = await this.resolveTaskTitle(taskId);
    const text = formatTaskStatusMarkdown(payload, taskTitle ?? undefined);
    const msg: OutboundMessage = { kind: 'markdown', text };

    for (const ch of channels) {
      void this.dispatchToChannel(ch, msg).catch(() => {});
    }
  }

  private async handleAgentQuestion(event: RealtimeEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      question?: {
        managedMode?: boolean;
        managed?: boolean;
        status?: string;
        taskId?: string | null;
      } & Record<string, unknown>;
      managed?: boolean;
      managedMode?: boolean;
    };
    const question = (payload as any).question;
    const isManaged =
      question?.managedMode === true ||
      question?.managed === true ||
      (payload as any).managed === true ||
      (payload as any).managedMode === true;

    if (!question) return;
    if (isManaged) return;
    if (question.status !== undefined && question.status !== 'pending') return;

    const taskId: string | null =
      (question.taskId as string | null) ??
      (question as any).taskId ??
      (payload as any).taskId ??
      null;
    if (!taskId) return;

    const channels = await this.resolveChannelsForTask(
      taskId,
      NOTIFICATION_EVENTS.AGENT_QUESTION,
    );
    if (channels.length === 0) return;

    const text = formatQuestionText(question as Record<string, unknown>);

    for (const ch of channels) {
      // wecom_group_robot text fallback if no card support: always use text/markdown via sendOutbound
      // For wecom_group_robot we force text fallback (no card)
      const msg: OutboundMessage = { kind: 'text', text };
      // If adapter supports question_card and channel is wecom_group_robot, we still fallback to text as required
      // (wecom_group_robot has no card support in notification adapter)
      void this.dispatchToChannel(ch, msg).catch(() => {});
    }
  }

  private async handleAgentReply(event: RealtimeEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      message?: {
        senderType?: string;
        status?: string;
        content?: { text?: string; parts?: unknown[] } | string;
        text?: string;
        channelId?: string;
        taskId?: string;
      };
    };
    const payloadRaw = payload as Record<string, any>;
    // Private chat (wecom_aibot single / DM) must never trigger notification webhook.
    // Robust guard: check payload-level markers for private/single before any DB lookup.
    const isPrivatePayloadMarker = (() => {
      if (
        payloadRaw.channelType === 'private' ||
        payloadRaw.channelType === 'single'
      )
        return true;
      if (payloadRaw.chattype === 'single' || payloadRaw.chattype === 'private')
        return true;
      if (payloadRaw.chatType === 'single' || payloadRaw.chatType === 'private')
        return true;
      const ch = payloadRaw.channel as Record<string, any> | undefined;
      if (ch) {
        if (ch.type === 'private' || ch.type === 'single') return true;
        if (ch.channelType === 'private' || ch.channelType === 'single')
          return true;
        if (ch.chattype === 'single' || ch.chattype === 'private') return true;
      }
      const msg = payloadRaw.message as Record<string, any> | undefined;
      if (msg) {
        if (msg.channelType === 'private' || msg.channelType === 'single')
          return true;
        if (msg.chattype === 'single' || msg.chattype === 'private') return true;
        if (msg.chatType === 'single' || msg.chatType === 'private') return true;
        const msgCh = msg.channel as Record<string, any> | undefined;
        if (msgCh && (msgCh.type === 'private' || msgCh.type === 'single'))
          return true;
      }
      return false;
    })();
    if (isPrivatePayloadMarker) return;

    const message: any = payload.message ?? (payload as any);
    if (!message || typeof message !== 'object') return;

    // Also check message-level private markers (payload shape variants)
    if (
      message.channelType === 'private' ||
      message.channelType === 'single' ||
      message.chattype === 'single' ||
      message.chattype === 'private' ||
      message.chatType === 'single' ||
      message.chatType === 'private' ||
      message.channel?.type === 'private' ||
      message.channel?.type === 'single'
    ) {
      return;
    }

    const senderType = message.senderType;
    if (senderType !== 'agent') return;

    const status = message.status;
    if (
      status &&
      status !== 'sent' &&
      status !== 'final' &&
      status !== 'completed' &&
      status !== 'ok'
    ) {
      return;
    }

    // Private channel DB guard: if the message's channel is a private DM, skip notification entirely.
    // This is the authoritative check — vteam ChatChannel.type is 'private' vs 'task_group'.
    const channelIdCandidate: string | null =
      (typeof message.channelId === 'string' ? message.channelId : null) ??
      (typeof payloadRaw.channelId === 'string' ? payloadRaw.channelId : null) ??
      (typeof payloadRaw.channel?.id === 'string'
        ? payloadRaw.channel.id
        : null) ??
      (event.scopeType === 'channel' && typeof event.scopeId === 'string'
        ? event.scopeId
        : null);
    if (channelIdCandidate) {
      try {
        const ch = await (this.prisma as any).chatChannel.findUnique({
          where: { id: channelIdCandidate },
          select: { type: true },
        });
        if (
          ch?.type === CHANNEL_TYPE.private ||
          ch?.type === 'private' ||
          ch?.type === 'single'
        ) {
          return;
        }
      } catch {}
    }

    let text: string | undefined;
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (message.content && typeof message.content === 'object') {
      text = (message.content as { text?: string }).text;
      if (!text && (message.content as any).parts) {
        const parts = (message.content as any).parts as Array<{
          type?: string;
          text?: string;
        }>;
        if (Array.isArray(parts)) {
          text = parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('');
        }
      }
    }
    if (!text) {
      text = message.text;
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) return;

    let taskId: string | null =
      message.taskId ?? (payload as any).taskId ?? null;
    if (!taskId && message.channelId) {
      try {
        const ch = await (this.prisma as any).chatChannel.findUnique({
          where: { id: message.channelId },
          select: { taskId: true },
        });
        taskId = ch?.taskId ?? null;
      } catch {
        taskId = null;
      }
    }
    if (!taskId && event.scopeType === 'channel' && event.scopeId) {
      try {
        const ch = await (this.prisma as any).chatChannel.findUnique({
          where: { id: event.scopeId },
          select: { taskId: true },
        });
        taskId = ch?.taskId ?? null;
      } catch {}
    }
    if (!taskId && event.scopeType === 'task' && event.scopeId) {
      taskId = event.scopeId;
    }
    if (!taskId) return;

    const channels = await this.resolveChannelsForTask(
      taskId,
      NOTIFICATION_EVENTS.AGENT_REPLY,
    );
    if (channels.length === 0) return;

    const msg: OutboundMessage = { kind: 'markdown', text };

    for (const ch of channels) {
      void this.dispatchToChannel(ch, msg).catch(() => {});
    }
  }

  /**
   * Core join-table routing:
   * 1) TaskNotificationChannel.findMany where taskId
   * 2) notificationChannel where id IN ids && enabled && config.events includes eventType
   */
  private async resolveChannelsForTask(
    taskId: string,
    eventType: string,
  ): Promise<any[]> {
    let links: Array<{ notificationChannelId: string }>;
    try {
      links = await (this.prisma as any).taskNotificationChannel.findMany({
        where: { taskId },
        select: { notificationChannelId: true },
      });
    } catch {
      return [];
    }
    if (!links || links.length === 0) return [];
    const ids = links.map((l) => l.notificationChannelId).filter(Boolean);
    if (ids.length === 0) return [];

    let channels: any[];
    try {
      channels = await (this.prisma as any).notificationChannel.findMany({
        where: { id: { in: ids }, enabled: true },
      });
    } catch {
      return [];
    }

    return channels.filter((ch) => {
      if (!ch.enabled) return false;
      if (!this.hasEvent(ch.config, eventType)) return false;
      return true;
    });
  }

  private hasEvent(config: unknown, event: string): boolean {
    const events = (config as Record<string, unknown> | null)?.['events'];
    if (!Array.isArray(events)) return false;
    return events.includes(event);
  }

  private async resolveTaskTitle(taskId: string): Promise<string | null> {
    try {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { title: true },
      });
      return task?.title ?? null;
    } catch {
      return null;
    }
  }

  /**
   * MCP channel_send 兼容：按任务绑定的通知渠道 id/name 定向发送（供 PlatformMcpService 调用）。
   * 在任务的 TaskNotificationChannel 绑定范围内查找匹配 id 或 name 的可用渠道，命中后经 dispatchToChannel 发送。
   */
  async sendToChannelByIdOrName(
    taskId: string,
    target: string,
    text: string,
  ): Promise<void> {
    const links: Array<{ notificationChannelId: string }> = await (
      this.prisma as any
    ).taskNotificationChannel.findMany({
      where: { taskId },
      select: { notificationChannelId: true },
    });
    const ids = (links ?? [])
      .map((l) => l.notificationChannelId)
      .filter(Boolean);
    if (ids.length === 0) throw new Error(`任务 ${taskId} 未绑定任何通知渠道`);
    const channels: any[] = await (
      this.prisma as any
    ).notificationChannel.findMany({
      where: { id: { in: ids }, enabled: true },
    });
    const ch = channels.find((c) => c.id === target || c.name === target);
    if (!ch) throw new Error(`渠道 ${target} 不存在或未绑定到任务 ${taskId}`);
    if (!ch.enabled) throw new Error(`渠道 ${target} 已停用`);
    await this.dispatchToChannel(ch, { kind: 'markdown', text });
  }

  /**
   * per-channel 串行队列：同一渠道内消息按提交顺序串行发送，避免乱序。
   * 每次发送单条 delivery 记录（pending → ok/failed），异常仅记日志不抛出阻断队列。
   */
  async dispatchToChannel(channel: any, msg: OutboundMessage): Promise<void> {
    const prev = this.queues.get(channel.id) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        let deliveryId: string | null = null;
        try {
          const logRes = await this.delivery.log(
            DELIVERY_DIRECTIONS.outbound,
            msg.kind,
            'pending',
            { channelId: channel.id, payload: msg as unknown },
          );
          deliveryId = (logRes as { id: string })?.id ?? null;

          const adapter = this.registry.get(channel.type);
          if (!adapter) {
            throw new Error(`adapter not found for type ${channel.type}`);
          }
          const resolved: NotificationChannelResolved = {
            id: channel.id,
            type: channel.type,
            config: (channel.config as Record<string, any>) ?? {},
            secrets: (channel.secrets as Record<string, any>) ?? {},
            enabled: channel.enabled ?? true,
          };
          const res = await adapter.sendOutbound(resolved, msg);
          if (deliveryId) {
            try {
              await this.delivery.finish(
                deliveryId,
                DELIVERY_STATUS.ok,
                null,
                msg as unknown,
                res as unknown,
              );
            } catch {}
          }
        } catch (e) {
          const errMsg = (e as Error).message ?? String(e);
          this.logger.error(
            `dispatchToChannel failed channel=${channel.id}: ${errMsg}`,
          );
          try {
            if (deliveryId) {
              await this.delivery.finish(
                deliveryId,
                DELIVERY_STATUS.failed,
                errMsg,
                msg as unknown,
                null,
              );
            } else {
              await this.delivery.log(
                DELIVERY_DIRECTIONS.outbound,
                msg.kind,
                DELIVERY_STATUS.failed,
                {
                  channelId: channel.id,
                  error: errMsg,
                  payload: msg as unknown,
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
