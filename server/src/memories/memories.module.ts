import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminGuard } from '../users/admin.guard';
import { MemoriesController } from './memories.controller';
import { MemoriesService } from './memories.service';

/**
 * 记忆模块（memory-management Todo 1 表结构 + Todo 5 REST 端点）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （共享同一 id 生成器实例，与 tasks/agents/chat 同源，对齐 tools/tools.module.ts 注释模式）。
 * AdminGuard 复用 users/admin.guard.ts（无状态：仅依赖全局 PrismaService），
 * 本模块单独注册为 provider 供 GET/DELETE 管理端点守卫使用。
 */
@Module({
  imports: [RealtimeModule],
  controllers: [MemoriesController],
  providers: [MemoriesService, AdminGuard],
})
export class MemoriesModule {}
