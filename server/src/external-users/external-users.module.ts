import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { ExternalUsersController } from './external-users.controller';
import { ExternalUsersService } from './external-users.service';

/**
 * 外部渠道用户目录模块（external-users）。
 *
 * - PrismaService 由全局 PrismaModule 提供；
 * - IdGeneratorService（eu_ 主键）由 RealtimeModule 导出——与 members/chat/tasks
 *   共享同一实例，保证进程内序号单源；
 * - PermissionGuard 在本模块 providers 注册供编译期解析（chats.view/chats.edit）；
 * - 导出 ExternalUsersService：MessageChannelsModule 的入站沉淀需要注入它。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [ExternalUsersController],
  providers: [ExternalUsersService, PermissionGuard],
  exports: [ExternalUsersService],
})
export class ExternalUsersModule {}
