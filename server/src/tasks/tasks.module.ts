import { Module } from '@nestjs/common';
import { ProjectMembershipGuard } from '../common/guards/project-membership.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
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
 * - ProjectMembershipGuard 本模块注册（依赖全局 PrismaService 与 Reflector）。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [TasksController],
  providers: [TasksService, ProjectMembershipGuard],
  exports: [TasksService],
})
export class TasksModule {}
