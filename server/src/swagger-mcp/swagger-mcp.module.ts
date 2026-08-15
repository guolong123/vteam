import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AgentsService } from '../agents/agents.service';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { ModelsModule } from '../models/models.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SkillsService } from '../skills/skills.service';
import { TasksModule } from '../tasks/tasks.module';
import { ToolsService } from '../tools/tools.service';
import { RolesService } from '../users/roles.service';
import { UsersService } from '../users/users.service';
import { WorkersModule } from '../workers/workers.module';
import { WorkerTokenGuard } from '../workers/worker-token.guard';
import { SwaggerMcpAuthService } from './swagger-mcp.auth';
import { SwaggerMcpController } from './swagger-mcp.controller';
import { SwaggerDocsProvider } from './swagger-docs.provider';
import { SwaggerMcpHandlers } from './swagger-mcp.handlers';
import { SwaggerToolSyncService } from './swagger-tools.sync';

/**
 * Swagger-MCP（vteam-api）模块（阶段 2 任务 13）。
 *
 * - `POST /api/v1/vteam-api/mcp`（SwaggerMcpController）：@Public() + WorkerTokenGuard，
 *   从 Swagger 文档（SwaggerDocsProvider）动态生成全量业务 API 工具（70+），
 *   JSON-RPC initialize/tools/list/call + ajv 校验 + 权限点校验（SwaggerMcpAuthService）
 *   + handler 绑定（SwaggerMcpHandlers → 各业务 service）。
 * - SwaggerDocsProvider 为模块级 store（main.ts setSwaggerRawDocument + initialize），
 *   构造无参可 DI。
 * - 业务 service：TasksModule/ArtifactsModule/McpServersModule/ModelsModule/WorkersModule
 *   已导出对应 service 直接注入；AgentsService/SkillsService/ToolsService/UsersService/
 *   RolesService 所在模块未导出——本模块 imports 其依赖模块（RealtimeModule 导出
 *   IdGeneratorService、WorkersModule 导出 WorkersService/WorkerClient、ModelsModule
 *   导出 ModelsService）后重新注册为 provider（无状态数据库服务，重复实例行为一致）。
 * - WorkerTokenGuard 在 WorkersModule 中未导出，本模块自行注册（依赖全局 ConfigModule）。
 * - PrismaService 由全局 PrismaModule 提供；HealthCheckService 由 TerminusModule 提供。
 * - onModuleInit 调 SwaggerToolSyncService.syncToToolsTable()：把 Swagger 生成的 70 个
 *   MCP 工具注册进 tools 表（source=mcp，任务 15）。main.ts 在 app.listen 前已完成
 *   setSwaggerRawDocument + initialize（模块级 store），onModuleInit 时文档已就绪；
 *   同步失败仅 warn，不阻断启动。
 */
@Module({
  imports: [
    RealtimeModule,
    WorkersModule,
    ModelsModule,
    McpServersModule,
    TasksModule,
    ArtifactsModule,
    TerminusModule,
  ],
  controllers: [SwaggerMcpController],
  providers: [
    SwaggerMcpController,
    SwaggerMcpAuthService,
    SwaggerMcpHandlers,
    SwaggerDocsProvider,
    SwaggerToolSyncService,
    WorkerTokenGuard,
    AgentsService,
    SkillsService,
    ToolsService,
    UsersService,
    RolesService,
  ],
})
export class SwaggerMcpModule implements OnModuleInit {
  private readonly logger = new Logger(SwaggerMcpModule.name);

  constructor(private readonly toolSync: SwaggerToolSyncService) {}

  /** 启动时把 Swagger 生成的 MCP 工具同步进 tools 表（source=mcp，失败 warn 不阻断）。 */
  async onModuleInit(): Promise<void> {
    try {
      await this.toolSync.syncToToolsTable();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`tools 表同步失败（不阻断启动）：${message}`);
    }
  }
}
