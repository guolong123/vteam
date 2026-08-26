import { Module } from '@nestjs/common';
import { NOTIFICATION_ADAPTERS } from './notification.constants';
import { NotificationRegistryService } from './notification-registry.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import { WebhookNotificationAdapter } from './adapters/webhook-notification.adapter';
import { WecomGroupRobotAdapter } from './adapters/wecom-group-robot.adapter';
import { NotificationChannelsController } from './notification-channels.controller';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  controllers: [NotificationChannelsController],
  providers: [
    PermissionGuard,
    WebhookNotificationAdapter,
    WecomGroupRobotAdapter,
    {
      provide: NOTIFICATION_ADAPTERS,
      useFactory: (
        wh: WebhookNotificationAdapter,
        wg: WecomGroupRobotAdapter,
      ) => [wh, wg],
      inject: [WebhookNotificationAdapter, WecomGroupRobotAdapter],
    },
    NotificationRegistryService,
    NotificationDeliveryService,
    NotificationDispatcherService,
  ],
  exports: [
    NotificationRegistryService,
    NotificationDeliveryService,
    NotificationDispatcherService,
    NOTIFICATION_ADAPTERS,
  ],
})
export class NotificationChannelsModule {}
