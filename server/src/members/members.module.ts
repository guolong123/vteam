import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

/**
 * 成员库模块（vteam-member-decouple P0）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （与 tasks/chat/agents 共享同一实例）。PermissionGuard 在本模块注册供编译期解析。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [MembersController],
  providers: [MembersService, PermissionGuard],
})
export class MembersModule {}
