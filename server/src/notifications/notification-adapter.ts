/**
 * 通知渠道适配器抽象与宿主契约（integrations-refactor D2：适配器框架拆分 outbound-only）。
 */

export interface NotificationChannelResolved {
  id: string;
  type: string;
  name?: string;
  config: Record<string, any>;
  secrets: Record<string, any>;
  enabled: boolean;
  lastStatus?: string | null;
  lastError?: string | null;
}

export interface OutboundMessage {
  kind: 'markdown' | 'text' | 'question_card';
  title?: string;
  text: string;
  actions?: { key: string; label: string }[];
  aqId?: string;
}

/**
 * 抽象通知适配器：每种通知类型实现一个子类（webhook/wecom_group_robot）。
 *
 * 能力面：
 * - sendOutbound(channel, msg)：抽象，发送出站消息；
 */
export abstract class NotificationAdapter {
  abstract readonly type: string;

  supportsOutbound?: boolean;

  abstract sendOutbound(
    channel: NotificationChannelResolved,
    msg: OutboundMessage,
  ): Promise<{ externalId: string | null; meta?: Record<string, any> }>;
}
