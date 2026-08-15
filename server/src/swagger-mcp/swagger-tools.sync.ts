import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { SwaggerDocsProvider } from './swagger-docs.provider';
import { generateSwaggerTools, SwaggerMcpTool } from './swagger-tools';

/**
 * tools 表同步服务（Swagger-MCP / vteam-api，阶段 2 任务 15）。
 *
 * 职责：server 启动时把 Swagger 生成的 MCP 工具（generateSwaggerTools 产物）
 * 逐条 upsert 进 tools 表（source=mcp、execution=mcp、mcpServer=vteam-api），
 * 使 agents 页工具配置区可见可配（GET /tools?enabled=true 自动返回）。
 *
 * 权限模型（对齐 seed 的 vteam 工具与 swagger-mcp.auth.ts）：tools.action @unique
 * 即权限点键，运行时校验（agentToolEffect.toolAction）直接按 Swagger 工具名匹配——
 * 故 action = tool.name（工具名即权限点 FR-48）。tools 表仅管理面展示/配置入口，
 * 运行时授权不依赖 tools 表行（swagger-mcp.auth.ts 直读 AgentToolEffect）。
 *
 * 幂等：upsert by action（@unique），重复执行只更新不产生重复行。
 * 同步失败 warn 不阻断启动（文档未 initialize 时 getDocument 返回 null，跳过）。
 */
@Injectable()
export class SwaggerToolSyncService {
  private readonly logger = new Logger(SwaggerToolSyncService.name);

  /** Tool 域主键前缀（对齐 tools.service 的 TOOL_ID_PREFIX='tl'）。 */
  private readonly TOOL_ID_PREFIX = 'tl';

  /** vteam-api 工具注册的 mcpServer 名（seed 已注册 ms_vteam_api）。 */
  private readonly MCP_SERVER = 'vteam-api';

  constructor(
    private readonly docs: SwaggerDocsProvider,
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /**
   * 同步 Swagger 工具到 tools 表，返回同步条数。
   * - 文档未就绪（getDocument 为 null）→ warn 跳过，返回 0（不阻断启动）；
   * - 已存在 action → update（schema/source/execution/mcpServer/enabled 跟随最新文档）；
   * - 不存在 → create（id=tl_<seq>，name/action=Swagger 工具名）；
   * - 单个工具 upsert 失败 → warn 并继续其余工具（不因单条失败中断整体）。
   */
  async syncToToolsTable(): Promise<number> {
    const document = this.docs.getDocument();
    if (!document) {
      this.logger.warn(
        'Swagger 文档未就绪（setSwaggerRawDocument 未调用或尚未 initialize），跳过 tools 表同步',
      );
      return 0;
    }
    const tools = generateSwaggerTools(document);
    if (tools.length === 0) {
      this.logger.log('Swagger 文档未生成任何工具，跳过 tools 表同步');
      return 0;
    }

    let synced = 0;
    for (const tool of tools) {
      try {
        await this.upsertTool(tool);
        synced += 1;
      } catch (err) {
        this.logger.warn(
          `Swagger 工具 ${tool.name} 同步 tools 表失败（继续其余工具）：${this.toMessage(err)}`,
        );
      }
    }

    this.logger.log(
      `tools 表已同步 ${synced}/${tools.length} 个 vteam-api 工具（source=mcp，mcpServer=${this.MCP_SERVER}）`,
    );
    return synced;
  }

  /** 单条 upsert：where={action}（权限点键），update 跟随最新文档，create 生成新 id。 */
  private async upsertTool(tool: SwaggerMcpTool): Promise<void> {
    // Tool model 无独立 description 列——描述并入 schema JSON（description 为 JSON
    // Schema 合法关键字，不破坏 inputSchema 结构；运行时 ajv 校验用的是内存中的
    // SwaggerMcpTool.inputSchema，tools 表 schema 仅管理面展示用途）。
    const schema: Prisma.InputJsonValue = {
      ...tool.inputSchema,
      description: tool.description,
    } as Prisma.InputJsonValue;

    const base = {
      name: tool.name,
      source: 'mcp',
      execution: 'mcp',
      mcpServer: this.MCP_SERVER,
      schema,
      enabled: true,
    } as const;

    await this.prisma.tool.upsert({
      where: { action: tool.name },
      update: base,
      create: {
        id: await this.idGen.nextId(this.TOOL_ID_PREFIX),
        action: tool.name,
        ...base,
      },
    });
  }

  private toMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
