import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NOTIFICATION_ADAPTERS } from './notification.constants';
import { NotificationAdapter } from './notification-adapter';

/**
 * 通知渠道适配器注册表（integrations-refactor D2）。
 *
 * 职责：
 * - 经 DI token NOTIFICATION_ADAPTERS 收集全部通知适配器实例；
 * - OnModuleInit 按 type 建 Map，type 冲突抛错；
 * - 暴露 get(type) / all() / startEnabled() / onModuleDestroy()；
 * - startEnabled 查询 notificationChannel where enabled=true，按去重 type 调用 start（若适配器有 start）
 */
@Injectable()
export class NotificationRegistryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationRegistryService.name);
  private readonly map = new Map<string, NotificationAdapter>();

  constructor(
    @Inject(NOTIFICATION_ADAPTERS)
    private readonly adapters: NotificationAdapter[],
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const adapter of this.adapters) {
      if (this.map.has(adapter.type)) {
        throw new Error(`Duplicate notification adapter type: ${adapter.type}`);
      }
      this.map.set(adapter.type, adapter);
      // Notifications are outbound-only, no attach/host needed, but support optional attach for symmetry
      if (typeof (adapter as any).attach === 'function') {
        try {
          (adapter as any).attach(this);
        } catch (e) {
          this.logger.error(
            `adapter ${adapter.type} attach failed: ${(e as Error).message}`,
          );
        }
      }
    }
    await this.startEnabled();
  }

  get(type: string): NotificationAdapter | undefined {
    return this.map.get(type);
  }

  all(): NotificationAdapter[] {
    return [...this.map.values()];
  }

  async startEnabled(): Promise<void> {
    let channels: Array<{ type: string }> = [];
    try {
      channels = await (this.prisma as any).notificationChannel.findMany({
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
      if (typeof (adapter as any).start !== 'function') continue;
      try {
        await (adapter as any).start(this);
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
      if (typeof (adapter as any).stop !== 'function') continue;
      try {
        await (adapter as any).stop();
        this.logger.log(`adapter ${adapter.type} stopped`);
      } catch (e) {
        this.logger.error(
          `adapter ${adapter.type} stop failed: ${(e as Error).message}`,
          (e as Error).stack,
        );
      }
    }
  }
}
