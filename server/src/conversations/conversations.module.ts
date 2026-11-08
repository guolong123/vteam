import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

/** 会话聚合模块（P2）。PrismaService 由全局 PrismaModule 提供。 */
@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService, PermissionGuard],
})
export class ConversationsModule {}
