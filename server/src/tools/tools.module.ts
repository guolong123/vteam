import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminGuard } from '../users/admin.guard';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { WorkersModule } from '../workers/workers.module';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';

/**
 * Tool 模块（T2 重构对齐 09 篇 §3.8：去 source 入参 + PATCH 收敛 + AdminGuard + 无 DELETE）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （共享同一 id 生成器实例，与 tasks/agents/chat 同源）。
 * AdminGuard 复用 users/admin.guard.ts（无状态：仅依赖全局 PrismaService），
 * 本模块单独注册为 provider 供 POST/PATCH 管理端点守卫使用；
 * WorkerOrJwtGuard 供 GET 端点双通道鉴权（worker X-Worker-Token / 用户 JWT，T4b）。
 * WorkersModule：F1 MAJOR——工具变更（POST/PATCH）后经 WorkersService 广播 reload-config。
 */
@Module({
  imports: [RealtimeModule, WorkersModule],
  controllers: [ToolsController],
  providers: [ToolsService, AdminGuard, WorkerOrJwtGuard],
})
export class ToolsModule {}
