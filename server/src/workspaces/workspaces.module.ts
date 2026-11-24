import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { PermissionGuard } from '../common/guards/permission.guard';
import { TenantContextInterceptor } from '../common/tenant/tenant-context.interceptor';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

/**
 * 工作空间模块（M1）。
 *
 * - WorkspacesService：空间解析（请求上下文）/ 成员关系 / 空间 CRUD / 默认空间自愈
 * - WorkspacesController：/workspaces 管理端点
 * - 全局注册 WorkspaceGuard（JwtAuthGuard 之后解析当前空间）
 * - 全局注册 TenantContextInterceptor（AsyncLocalStorage 包裹请求处理链）
 *
 * IdGeneratorService 由 RealtimeModule 导出（与其它模块共享同一实例，避免 id 序号分叉）。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacesService,
    PermissionGuard,
    { provide: APP_GUARD, useClass: WorkspaceGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
