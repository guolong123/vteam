import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { AdminGuard } from '../users/admin.guard';
import { CoordinationMetricsController } from './coordination-metrics.controller';
import { CoordinationMetricsService } from './coordination-metrics.service';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { TeamChannelBindingsController } from './team-channel-bindings.controller';

/**
 * TeamsModule：团队/成员/队列 + 团队维度只读观测面（批次 E 协调度指标）。
 * WorkersModule（只读用途）：updateMember 写入 opencodeAgentName 前经 WorkerClient.listAgents
 * 做弱校验（worker 离线时静默放行，不阻断写入）。
 *
 * 批次 E：协调度指标挂在**本模块**而不是新开模块——团队维度的读（本模块已有
 * team-channel-bindings 这类第二个 scoped 控制器）天然属于团队域；
 * 新开模块只会多一次 app.module 接线，且把「团队」这个聚合根切碎。
 * AdminGuard 在本模块单独注册（与 memories.module.ts 同款：AdminGuard 无状态，
 * 只依赖全局 PrismaService）。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [
    TeamsController,
    TeamChannelBindingsController,
    CoordinationMetricsController,
  ],
  providers: [
    TeamsService,
    PermissionGuard,
    CoordinationMetricsService,
    AdminGuard,
  ],
  exports: [TeamsService],
})
export class TeamsModule {}
