/**
 * 消息渠道适配器抽象与宿主契约（integrations-refactor D2：适配器框架拆分 inbound-only）。
 */

export interface MessageChannelResolved {
  id: string;
  type: string;
  name?: string;
  config: Record<string, any>;
  secrets: Record<string, any>;
  enabled: boolean;
  lastStatus?: string | null;
  lastError?: string | null;
}

export type InboundCommand =
  | {
      kind: 'post_message';
      text: string;
      senderExternalId?: string;
      senderName?: string;
      dedupKey?: string;
      /** WeCom directed: chattype single|group */
      chattype?: string;
      wecomUserId?: string;
      wecomUserName?: string;
    }
  | {
      kind: 'card_action';
      aqId: string;
      action: string;
      operatorExternalId?: string;
      operatorExternalName?: string;
      operatorName?: string;
      chattype?: string;
      chatId?: string;
      channelId?: string;
    };

export interface OutboundMessage {
  kind: 'markdown' | 'text' | 'question_card';
  title?: string;
  text: string;
  actions?: { key: string; label: string }[];
  aqId?: string;
}

export interface MessageHost {
  submitInbound(
    channelId: string,
    commands: InboundCommand[],
  ): Promise<{ results: Array<{ ok: boolean; internalMessageId?: string }> }>;
  getChannel(id: string): Promise<MessageChannelResolved | null>;
  updateChannelRuntime(
    id: string,
    patch: {
      lastStatus?: string;
      lastError?: string;
      configMerge?: Record<string, any>;
    },
  ): Promise<void>;
  requestStop(channelId: string): Promise<void>;
  registerStreamCorrelation?(
    internalMessageId: string,
    ref: { channelId: string; frameHeaders: unknown; streamId: string },
  ): void;
}

/**
 * 抽象消息适配器：每种消息渠道类型实现一个子类（generic_webhook/wecom_aibot/github_webhook/gitee_webhook）。
 *
 * 能力面：
 * - verifyInbound(req, channel)：可选，验签 / 鉴权失败抛异常；
 * - normalizeInbound(req, channel)：抽象，将原始请求归一化为统一 InboundCommand 数组；
 * - start(ctx: MessageHost) / stop()：可选，长连接型适配器生命周期；
 * - registerStreamCorrelation?(...): 可选，wecom 用于占位→终态关联；
 * - attach(host): 可选，注册表在 OnModuleInit 注入宿主。
 */
export abstract class MessageAdapter {
  abstract readonly type: string;

  supportsInbound?: boolean;

  attach?(host: MessageHost): void;

  verifyInbound?(req: any, channel: MessageChannelResolved): Promise<void>;

  handleHandshake?(
    req: any,
    res: any,
    channel: MessageChannelResolved,
  ): Promise<boolean>;

  abstract normalizeInbound(
    req: any,
    channel: MessageChannelResolved,
  ): Promise<InboundCommand[]>;

  start?(ctx: MessageHost): Promise<void>;

  stop?(): Promise<void>;

  registerStreamCorrelation?(
    internalMessageId: string,
    ref: { channelId: string; frameHeaders: unknown; streamId: string },
  ): void;
}
