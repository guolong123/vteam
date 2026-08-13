import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { ChatModule } from '../chat/chat.module';
import { IssuesModule } from '../issues/issues.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkersModule } from '../workers/workers.module';
import { WorkerTokenGuard } from '../workers/worker-token.guard';
import { PlatformMcpController } from './platform-mcp.controller';
import { PlatformMcpService } from './platform-mcp.service';

/**
 * 平台 MCP 模块（阶段 1：server 平台 MCP 端点，SDK + StreamableHTTP）。
 *
 * - `POST /api/v1/platform-mcp`（PlatformMcpController）：`@Public()` + WorkerTokenGuard，
 *   暴露 12 个 MCP 工具（chat_history/doclib/task_context/group_post/read_file/notify_agent/
 *   submit_artifact + issue_create/issue_list/issue_get/issue_update/issue_transition）。
 * - PrismaService 由全局 PrismaModule 提供；
 *   RealtimeService + IdGeneratorService 由 RealtimeModule 导出（'m' 前缀与 chat 域同源）。
 * - WorkersModule 导出 WorkerClient（FR-41：group_post fileRef 未命中归档时经其从
 *   worker 工作区拉取文件内容）；WorkersModule 内部与 McpServersModule/ModelsModule
 *   的 forwardRef 环已自解，本模块单向依赖无新环。
 * - WorkerTokenGuard 在 WorkersModule 中未导出，本模块自行注册（依赖 ConfigService，
 *   全局 ConfigModule 提供），不改动 WorkersModule。
 * - ChatModule 导出 WorkerDispatcher（FR-13：notify_agent 工具经其触发目标 agent
 *   dispatch）；ChatModule imports Realtime/Workers/Artifacts，不反向依赖本模块，无环。
 * - ArtifactsModule 导出 ArtifactsService（submit_artifact text 类型直接落库归档）；
 *   ArtifactsModule 仅依赖 RealtimeModule，无环。
 * - IssuesModule 导出 IssuesService（issue_* 工具经其做 agent 团队校验与 issue CRUD/状态机）；
 *   IssuesModule 仅依赖 RealtimeModule，无环。
 */
@Module({
  imports: [RealtimeModule, WorkersModule, ChatModule, ArtifactsModule, IssuesModule],
  controllers: [PlatformMcpController],
  providers: [PlatformMcpService, WorkerTokenGuard],
})
export class PlatformMcpModule {}
