import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ProjectMembershipGuard } from '../common/guards/project-membership.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { TaskProgressionScheduler } from './task-progression.scheduler';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * 任务模块（09 篇 §3.4 Tasks；13 篇 §4.1 创建）。
 *
 * - PrismaService 由全局 PrismaModule 提供；
 * - RealtimeService + IdGeneratorService 由 RealtimeModule 导出（共享同一 id 生成器实例，
 *   保证 't'/'c'/'ta'/'te' 前缀跨模块计数一致，重启由 TasksService.onModuleInit 续号）；
 * - WorkersModule（T12）：SessionLifecycleService——TaskGroupInstance 查询委托（getInstancesByTask /
 *   getInstanceBySession），WorkersModule 不依赖 TasksModule，无循环依赖；
 * - ProjectMembershipGuard 本模块注册（依赖全局 PrismaService 与 Reflector）；
 * - PermissionGuard（CONF-02 方案②补齐矩阵守卫）：端点叠加 tasks.view/create/edit/review
 *   权限点，成员过滤之上再按矩阵判定（admin all:true 全放行 / member all:false 写拒）。
 * - ChatModule（功能 1）：TaskProgressionScheduler 注入 WorkerDispatcher（dispatchAgentMention
 *   定向主 Agent 巡检/托管确认）；ChatModule imports Workers/Realtime/Artifacts，不反向依赖本模块，无环。
 * - TaskProgressionScheduler（本模块 provider）：主 Agent 定期巡检调度 + 托管确认路由。
 */
@Module({
  imports: [RealtimeModule, WorkersModule, ChatModule],
  controllers: [TasksController],
  providers: [TasksService, TaskProgressionScheduler, ProjectMembershipGuard, PermissionGuard],
  exports: [TasksService],
})
export class TasksModule {}
