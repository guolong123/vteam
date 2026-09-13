import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { TeamChannelBindingsController } from './team-channel-bindings.controller';

/**
 * TeamsModule：团队/成员/队列。
 * WorkersModule（只读用途）：updateMember 写入 opencodeAgentName 前经 WorkerClient.listAgents
 * 做弱校验（worker 离线时静默放行，不阻断写入）。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [TeamsController, TeamChannelBindingsController],
  providers: [TeamsService, PermissionGuard],
  exports: [TeamsService],
})
export class TeamsModule {}
