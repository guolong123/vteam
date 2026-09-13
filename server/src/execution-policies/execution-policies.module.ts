import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { ExecutionPoliciesController } from './execution-policies.controller';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * ExecutionPolicy 模块（vteam-role-behavior-enforcement Todo 11 唯一来源）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （共享同一 id 生成器实例，与 tasks/agents/chat 同源，无循环依赖）。
 * PermissionGuard 注册供方法级 @UseGuards 解析（与 AgentsModule 同模式）。
 * ExecutionPolicyService export 供 ChatModule（dispatcher boundary 注入）与
 * 后续 `/agent-policies`（Todo 12）复用。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [ExecutionPoliciesController],
  providers: [ExecutionPolicyService, PermissionGuard],
  exports: [ExecutionPolicyService],
})
export class ExecutionPoliciesModule {}
