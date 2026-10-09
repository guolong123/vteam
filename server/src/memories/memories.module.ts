import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TimersModule } from '../timers/timers.module';
import { AdminGuard } from '../users/admin.guard';
import { MemoriesController } from './memories.controller';
import { MemoryMaintenanceService } from './memory-maintenance.service';
import { MemoriesService } from './memories.service';

/**
 * 记忆模块（memory-management Todo 1 表结构 + Todo 5 REST 端点）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 与 RealtimeService 由
 * RealtimeModule 导出（共享同一 id 生成器实例，与 tasks/agents/chat 同源，对齐
 * tools/tools.module.ts 注释模式）。
 * AdminGuard 复用 users/admin.guard.ts（无状态：仅依赖全局 PrismaService），
 * 本模块单独注册为 provider 供 GET/DELETE 管理端点守卫使用。
 *
 * memory-enhancement Todo 9 新增两条模块边：
 * - `TimersModule`（导出 TriggerService）：MemoryMaintenanceService 注册
 *   `memory_maintenance` handler/guard 并排全局单行 interval 触发器；
 * - `ChatModule`（导出 WorkerDispatcher）：handler 按团队派 prompt 给主 Agent。
 *
 * **无环核验**：ChatModule 的依赖闭包（Realtime/Workers/Artifacts/Timers/
 * ExecutionPolicies）均不 import MemoriesModule——worker-dispatcher 只 import
 * `memories/memory-importance`（纯函数模块，非 Nest provider）。本仓此前也只有
 * app.module 引用 MemoriesModule，故 `MemoriesModule → ChatModule` 是单向新边。
 */
@Module({
  imports: [RealtimeModule, TimersModule, ChatModule],
  controllers: [MemoriesController],
  providers: [MemoriesService, MemoryMaintenanceService, AdminGuard],
})
export class MemoriesModule {}
