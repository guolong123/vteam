import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { TeamChannelBindingsController } from './team-channel-bindings.controller';

@Module({
  imports: [RealtimeModule],
  controllers: [TeamsController, TeamChannelBindingsController],
  providers: [TeamsService, PermissionGuard],
  exports: [TeamsService],
})
export class TeamsModule {}
