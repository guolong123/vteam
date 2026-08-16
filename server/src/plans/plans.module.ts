import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';

/**
 * 协作计划模块（vteam-team-collaboration Todo 1 表结构 + Todo 5 业务方法/controller）。
 * - PrismaService 由全局 PrismaModule 提供；RealtimeService + IdGeneratorService 由
 *   RealtimeModule 导出（共享同一 id 生成器实例，与 tasks/agents/chat 同源）。
 * - 权限：不挂 AdminGuard / ProjectMembershipGuard——项目成员校验在 PlansService 内完成
 *   （对齐 issues.controller），鉴权依赖全局 JwtAuthGuard（APP_GUARD）。
 * - exports PlansService：PlatformMcpModule 的 plan_assign_reviewer 工具经其指派评审者
 *   （复用 assignReviewer 落库 + 系统消息，避免双实现）。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
