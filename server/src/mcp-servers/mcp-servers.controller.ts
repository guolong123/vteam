import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { AdminGuard } from '../users/admin.guard';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { QueryMcpServersDto } from './dto/query-mcp-servers.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { McpServersService } from './mcp-servers.service';

/**
 * MCP 服务器管理端点（T8a，11 篇 §5.8 平台 MCP 配置管理）。
 * 全局 JwtAuthGuard（APP_GUARD）已鉴权；管理端点（POST/PATCH/DELETE）挂 AdminGuard，
 * GET 成员只读可见（对齐 09 篇 §3.8 `[admin]（成员只读可见）` 语义）。
 * GET 端点挂 @Public() + WorkerOrJwtGuard：T4b/T8b worker 用 X-Worker-Token 拉取
 * mcp-servers 生成 opencode.json mcp 节，用户侧继续走 JWT。
 * 全局前缀 /api/v1（main.ts 已设置），实际路由 /api/v1/mcp-servers。
 */
@ApiTags('mcp-servers')
@ApiBearerAuth()
@Controller('mcp-servers')
export class McpServersController {
  constructor(private readonly mcpServersService: McpServersService) {}

  /**
   * 服务器列表（type/enabled 过滤 + name 搜索 + 分页，成员只读）。
   * GET /api/v1/mcp-servers?type=remote&enabled=true&name=gitee&page=1&pageSize=20
   *   → 200 {items, total, page, pageSize}
   */
  @Public()
  @UseGuards(WorkerOrJwtGuard)
  @Get()
  @ApiOperation({ summary: 'MCP 服务器列表（type/enabled 过滤 + 分页）' })
  findAll(@Query() query: QueryMcpServersDto) {
    return this.mcpServersService.findAll(query);
  }

  /** GET /api/v1/mcp-servers/:id → 200 + McpServer；不存在 → 404。 */
  @Public()
  @UseGuards(WorkerOrJwtGuard)
  @Get(':id')
  @ApiOperation({ summary: 'MCP 服务器详情' })
  findOne(@Param('id') id: string) {
    return this.mcpServersService.findOne(id);
  }

  /**
   * 创建服务器（local/remote 配置校验）。
   * POST /api/v1/mcp-servers {name, type, command?/url?, headers?, oauth?, enabled?}
   *   → 201 + McpServer；name 冲突 → 409；配置非法 → 400
   */
  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '创建 MCP 服务器（local/remote 配置校验）' })
  create(@Body() dto: CreateMcpServerDto) {
    return this.mcpServersService.create(dto);
  }

  /**
   * 编辑/启停服务器（部分更新）。
   * PATCH /api/v1/mcp-servers/:id {enabled: false, url?/command?, ...} → 200 + McpServer
   * 不存在 → 404；改 name 撞唯一 → 409；配置非法 → 400
   */
  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '更新 MCP 服务器（编辑/启停，部分更新）' })
  update(@Param('id') id: string, @Body() dto: UpdateMcpServerDto) {
    return this.mcpServersService.update(id, dto);
  }

  /**
   * 删除服务器（物理删除）。
   * DELETE /api/v1/mcp-servers/:id → 200；不存在 → 404 MCP_SERVER_NOT_FOUND
   */
  @Delete(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '删除 MCP 服务器（物理删除）' })
  remove(@Param('id') id: string) {
    return this.mcpServersService.remove(id);
  }
}
