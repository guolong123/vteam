import { Module } from '@nestjs/common';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { AgentRolesController } from './agent-roles.controller';
import { AgentRolesService } from './agent-roles.service';
import { OpencodeAgentNameValidator } from './opencode-agent-name.validator';

/**
 * AgentRole 模块（agent-role-entity todo 6）：全局可复用角色的列表/详情 + CRUD。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （共享同一 id 生成器实例，角色域前缀 `ar`）。
 * WorkersModule（todo 2，只读用途）：写入 `defaultOpencodeAgentName` 前经
 * `OpencodeAgentNameValidator` 做弱校验（worker 离线时静默放行，不阻断写入）。
 * PermissionGuard（权限矩阵）：方法级 @UseGuards(PermissionGuard) 依赖全局
 * PrismaService + Reflector，本模块注册供编译期解析。权限点复用 agents 域，不新增。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [AgentRolesController],
  providers: [AgentRolesService, OpencodeAgentNameValidator, PermissionGuard],
})
export class AgentRolesModule {}
