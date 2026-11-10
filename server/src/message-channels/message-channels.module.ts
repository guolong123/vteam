import { Module, forwardRef } from '@nestjs/common';
import { MESSAGE_ADAPTERS } from './message-channel.constants';
import { MessageRegistryService } from './message-registry.service';
import { MessageDeliveryService } from './message-delivery.service';
import { MessageInboundService } from './message-inbound.service';
import { MessageQuestionDispatcher } from './message-question.dispatcher';
import { GenericWebhookInboundAdapter } from './adapters/generic-webhook-inbound.adapter';
import { WecomAibotAdapter } from './adapters/wecom-aibot.adapter';
import { GithubWebhookAdapter } from './adapters/github-webhook.adapter';
import { GiteeWebhookAdapter } from './adapters/gitee-webhook.adapter';
import { MessageChannelsController } from './message-channels.controller';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { ChatModule } from '../chat/chat.module';
import { ExternalUsersModule } from '../external-users/external-users.module';
import { QuestionsModule } from '../questions/questions.module';

@Module({
  imports: [
    RealtimeModule,
    forwardRef(() => ChatModule),
    QuestionsModule,
    // 入站沉淀外部用户目录（MessageInboundService @Optional 注入 ExternalUsersService）
    ExternalUsersModule,
  ],
  controllers: [MessageChannelsController],
  providers: [
    PermissionGuard,
    GenericWebhookInboundAdapter,
    WecomAibotAdapter,
    GithubWebhookAdapter,
    GiteeWebhookAdapter,
    {
      provide: MESSAGE_ADAPTERS,
      useFactory: (
        gw: GenericWebhookInboundAdapter,
        wa: WecomAibotAdapter,
        gh: GithubWebhookAdapter,
        gi: GiteeWebhookAdapter,
      ) => [gw, wa, gh, gi],
      inject: [
        GenericWebhookInboundAdapter,
        WecomAibotAdapter,
        GithubWebhookAdapter,
        GiteeWebhookAdapter,
      ],
    },
    MessageRegistryService,
    MessageDeliveryService,
    MessageInboundService,
    MessageQuestionDispatcher,
    {
      provide: 'MessageQuestionDispatcher',
      useExisting: MessageQuestionDispatcher,
    },
  ],
  exports: [
    MessageRegistryService,
    MessageDeliveryService,
    MessageInboundService,
    MessageQuestionDispatcher,
    'MessageQuestionDispatcher',
    WecomAibotAdapter,
    MESSAGE_ADAPTERS,
  ],
})
export class MessageChannelsModule {}
