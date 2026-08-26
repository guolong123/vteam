import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MESSAGE_ADAPTERS } from './message-channel.constants';
import {
  MessageAdapter,
  MessageChannelResolved,
  MessageHost,
  InboundCommand,
} from './message-adapter';

/**
 * 消息渠道适配器注册表（integrations-refactor D2）。
 *
 * 职责：
 * - 经 DI token MESSAGE_ADAPTERS 收集全部消息适配器实例；
 * - OnModuleInit 按 type 建 Map，type 冲突抛错，逐个调用 adapter.attach(host) 注入宿主；
 * - 暴露 get(type) / all() / startEnabled() / onModuleDestroy()；
 * - 自身实现 MessageHost，供适配器回调。
 */
@Injectable()
export class MessageRegistryService
  implements OnModuleInit, OnModuleDestroy, MessageHost
{
  private readonly logger = new Logger(MessageRegistryService.name);
  private readonly map = new Map<string, MessageAdapter>();

  private inboundDelegate?: (
    channelId: string,
    commands: InboundCommand[],
  ) => Promise<{ results: Array<{ ok: boolean; internalMessageId?: string }> }>;

  constructor(
    @Inject(MESSAGE_ADAPTERS) private readonly adapters: MessageAdapter[],
    private readonly prisma: PrismaService,
  ) {}

  bindInboundDelegate(
    delegate: (
      channelId: string,
      commands: InboundCommand[],
    ) => Promise<{
      results: Array<{ ok: boolean; internalMessageId?: string }>;
    }>,
  ): void {
    this.inboundDelegate = delegate;
  }

  async onModuleInit(): Promise<void> {
    for (const adapter of this.adapters) {
      if (this.map.has(adapter.type)) {
        throw new Error(`Duplicate message adapter type: ${adapter.type}`);
      }
      this.map.set(adapter.type, adapter);
      if (typeof (adapter as any).attach === 'function') {
        try {
          (adapter as any).attach(this as MessageHost);
        } catch (e) {
          this.logger.error(
            `adapter ${adapter.type} attach failed: ${(e as Error).message}`,
          );
        }
      }
    }
    await this.startEnabled();
  }

  get(type: string): MessageAdapter | undefined {
    return this.map.get(type);
  }

  all(): MessageAdapter[] {
    return [...this.map.values()];
  }

  async startEnabled(): Promise<void> {
    let channels: Array<{ type: string }> = [];
    try {
      channels = await (this.prisma as any).messageChannel.findMany({
        where: { enabled: true },
        select: { type: true },
      });
    } catch (e) {
      this.logger.error(`startEnabled query failed: ${(e as Error).message}`);
      return;
    }
    const enabledTypes = new Set(channels.map((c) => c.type));
    for (const adapter of this.map.values()) {
      if (!enabledTypes.has(adapter.type)) continue;
      if (typeof adapter.start !== 'function') continue;
      try {
        await adapter.start(this as MessageHost);
        this.logger.log(`adapter ${adapter.type} started`);
      } catch (e) {
        this.logger.error(
          `adapter ${adapter.type} start failed: ${(e as Error).message}`,
          (e as Error).stack,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    const adapters = [...this.map.values()].reverse();
    for (const adapter of adapters) {
      if (typeof adapter.stop !== 'function') continue;
      try {
        await adapter.stop();
        this.logger.log(`adapter ${adapter.type} stopped`);
      } catch (e) {
        this.logger.error(
          `adapter ${adapter.type} stop failed: ${(e as Error).message}`,
          (e as Error).stack,
        );
      }
    }
  }

  async submitInbound(
    channelId: string,
    commands: InboundCommand[],
  ): Promise<{ results: Array<{ ok: boolean; internalMessageId?: string }> }> {
    if (this.inboundDelegate) {
      return this.inboundDelegate(channelId, commands);
    }
    this.logger.warn(
      `submitInbound called before MessageInboundService wired (channel ${channelId}, ${commands.length} commands) — returning empty results placeholder`,
    );
    return { results: commands.map(() => ({ ok: true })) };
  }

  async getChannel(id: string): Promise<MessageChannelResolved | null> {
    const row: any = await (this.prisma as any).messageChannel.findUnique({
      where: { id },
    });
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      config: (row.config as Record<string, any>) ?? {},
      secrets: (row.secrets as Record<string, any>) ?? {},
      enabled: row.enabled,
      lastStatus: row.lastStatus ?? null,
      lastError: row.lastError ?? null,
    };
  }

  async updateChannelRuntime(
    id: string,
    patch: {
      lastStatus?: string;
      lastError?: string;
      configMerge?: Record<string, any>;
    },
  ): Promise<void> {
    const data: Record<string, any> = {};
    if (patch.lastStatus !== undefined) data.lastStatus = patch.lastStatus;
    if (patch.lastError !== undefined) data.lastError = patch.lastError;
    if (patch.configMerge !== undefined) {
      const existing = await (this.prisma as any).messageChannel.findUnique({
        where: { id },
        select: { config: true },
      });
      const base = (existing?.config as Record<string, any>) ?? {};
      data.config = { ...base, ...patch.configMerge };
    }
    if (Object.keys(data).length === 0) return;
    await (this.prisma as any).messageChannel.update({
      where: { id },
      data,
    });
  }

  async requestStop(channelId: string): Promise<void> {
    const channel = await this.getChannel(channelId);
    if (!channel) return;
    const adapter = this.map.get(channel.type);
    if (!adapter || typeof adapter.stop !== 'function') return;
    try {
      await adapter.stop();
    } catch (e) {
      this.logger.error(
        `requestStop ${channelId} adapter ${channel.type} stop failed: ${(e as Error).message}`,
      );
    }
  }

  registerStreamCorrelation?(
    _internalMessageId: string,
    _ref: { channelId: string; frameHeaders: unknown; streamId: string },
  ): void {
    // no-op: stream correlation is now handled directly by each adapter's own Map
    // (e.g. WecomAibotAdapter.streams keyed by internalMessageId). Previously this
    // method tried registry.get(ref.channelId) where map is keyed by type, so always
    // missed. Keep as no-op to avoid duplicate bad entries; adapters store real
    // frameHeaders/streamId themselves via bindListeners → registerStreamCorrelation.
  }
}
