import { forwardRef, Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminGuard } from '../users/admin.guard';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { WorkersModule } from '../workers/workers.module';
import { McpServersController } from './mcp-servers.controller';
import { McpServersService } from './mcp-servers.service';

/**
 * MCP 服务器模块（T8a）：mcp_servers 实体 CRUD + local/remote 配置校验。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （共享同一 id 生成器实例，与 tasks/agents/tools 同源）；
 * AdminGuard 在本模块内注册（依赖全局 PrismaService，独立实例）；
 * WorkerOrJwtGuard 供 GET 端点双通道鉴权（worker X-Worker-Token / 用户 JWT，T4b/T8b）。
 * forwardRef(WorkersModule)：F1 MAJOR——服务器变更（POST/PATCH/DELETE）后广播 reload-config；
 * WorkersModule 亦 import 本模块（心跳 mcpStatus 处理），双向依赖用 forwardRef 解环。
 */
@Module({
  imports: [RealtimeModule, forwardRef(() => WorkersModule)],
  controllers: [McpServersController],
  providers: [McpServersService, AdminGuard, WorkerOrJwtGuard],
  // T8c：导出 McpServersService——WorkersService 心跳处理 mcpStatus 时注入调用
  // （applyHeartbeatStatus 写入内存状态，前端 GET /mcp-servers 合并展示）
  exports: [McpServersService],
})
export class McpServersModule {}
