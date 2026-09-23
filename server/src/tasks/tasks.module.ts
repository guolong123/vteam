import { Module, forwardRef } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { ChatModule } from '../chat/chat.module';
import { IssuesModule } from '../issues/issues.module';
import { MessageChannelsModule } from '../message-channels/message-channels.module';
import { TimersModule } from '../timers/timers.module';
import { PermissionGuard } from '../common/guards/permission.guard';
import { TeamMembershipGuard } from '../common/guards/team-membership.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { TaskProgressionScheduler } from './task-progression.scheduler';
import { TasksController } from './tasks.controller';
import { MigrateController } from './migrate.controller';
import { TaskChannelBindingsController } from './task-channel-bindings.controller';
import { TasksService } from './tasks.service';
import { PlanArchiveService } from './plan-archive.service';
import { PlanLifecycleService } from './plan-lifecycle.service';
import { PlanStepsService } from './plan-steps.service';
import { PlanDocsService } from './plan-docs.service';
import { PlanReviewWiring } from './plan-review-wiring';

/**
 * 任务模块（09 篇 §3.4 Tasks；13 篇 §4.1 创建）。
 *
 * - PrismaService 由全局 PrismaModule 提供；
 * - RealtimeService + IdGeneratorService 由 RealtimeModule 导出（共享同一 id 生成器实例，
 *   保证 't'/'c'/'ta'/'te' 前缀跨模块计数一致，重启由 TasksService.onModuleInit 续号）；
 * - WorkersModule（T12）：SessionLifecycleService——TaskGroupInstance 查询委托（getInstancesByTeamMember /
 *   getInstanceBySession），WorkersModule 不依赖 TasksModule，无循环依赖；
 * - TeamMembershipGuard 本模块注册（依赖全局 PrismaService 与 Reflector）；
 * - PermissionGuard（CONF-02 方案②补齐矩阵守卫）：端点叠加 tasks.view/create/edit/review
 *   权限点，成员过滤之上再按矩阵判定（admin all:true 全放行 / member all:false 写拒）。
 * - ChatModule（功能 1）：TaskProgressionScheduler 注入 WorkerDispatcher（dispatchAgentMention
 *   定向主 Agent 巡检/托管确认）；ChatModule imports Workers/Realtime/Artifacts，不反向依赖本模块，无环。
 * - IssuesModule（todo 2 哈希钩）：PlanDocsService 注入 ReviewRoundService 做
 *   writePlanDoc→applyRoundUpdate 回填；IssuesModule 仅依赖 RealtimeModule，不反向依赖本模块，无环。
 * - TaskProgressionScheduler（本模块 provider）：主 Agent 定期巡检调度 + 托管确认路由。
 */
@Module({
  imports: [
    RealtimeModule,
    WorkersModule,
    ChatModule,
    IssuesModule,
    TimersModule,
    ArtifactsModule,
    forwardRef(() => MessageChannelsModule),
  ],
  controllers: [
    TasksController,
    MigrateController,
    TaskChannelBindingsController,
  ],
  providers: [
    TasksService,
    PlanArchiveService,
    PlanLifecycleService,
    PlanStepsService,
    PlanDocsService,
    PlanReviewWiring,
    TaskProgressionScheduler,
    TeamMembershipGuard,
    PermissionGuard,
  ],
  exports: [TasksService, PlanLifecycleService, PlanStepsService],
})
export class TasksModule {}
