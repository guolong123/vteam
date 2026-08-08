import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { AdminGuard } from '../users/admin.guard';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { CreateToolDto } from './dto/create-tool.dto';
import { QueryToolsDto } from './dto/query-tools.dto';
import { UpdateToolDto } from './dto/update-tool.dto';
import { ToolsService } from './tools.service';

/**
 * Tool 端点（T2 重构对齐 09 篇 §3.8）。
 * - GET /api/v1/tools：source? 过滤 + 分页 + 来源徽章（builtin/custom/mcp），成员只读可见
 * - POST /api/v1/tools：{name, execution, schema?, initCommand?, mcpServer?}（无独立 source，
 *   service 推导），注册后自动进入权限命名空间（action=工具名 FR-48）
 * - PATCH /api/v1/tools/:id：仅 {schema?, initCommand?, enabled?}（工具定义注册后不可改）
 * - 无 DELETE（09 §3.8 不提供；停用 enabled=false 替代，FR-35 启用开关）
 * 鉴权：全局 JwtAuthGuard（APP_GUARD）兜底认证；POST/PATCH 管理端点加 AdminGuard
 * （复用 users/admin.guard.ts）；GET 挂 @Public() + WorkerOrJwtGuard——T4b worker 用
 * X-Worker-Token 拉取工具列表注入，用户侧继续走 JWT（守卫委托 passport 'jwt' 策略）。
 */
@ApiTags('tools')
@ApiBearerAuth()
@Controller('tools')
export class ToolsController {
  constructor(private readonly toolsService: ToolsService) {}

  /**
   * 工具列表（source/execution/enabled 过滤 + name 搜索 + 分页，含来源徽章）。
   * GET /api/v1/tools?source=mcp&enabled=true&page=1&pageSize=20
   *   → 200 {items, total, page, pageSize}；成员只读可见（不挂守卫）。
   * 成员只读：service 内强制 enabled=true（仅可见已启用工具，agent 配置页工具区数据源）；
   * admin 遵循 query.enabled（缺省全量）。worker（X-Worker-Token）viewer 为空不强制过滤，
   * 显式带 enabled=true 即只取启用工具。
   */
  @Public()
  @UseGuards(WorkerOrJwtGuard)
  @Get()
  @ApiOperation({ summary: '工具列表（source 过滤 + 分页，含来源徽章，成员只读）' })
  findAll(@Query() query: QueryToolsDto, @Req() req: Request) {
    const viewer = req.user as { id?: string } | undefined;
    return this.toolsService.findAll(
      query,
      viewer?.id ? { id: viewer.id } : undefined,
    );
  }

  /**
   * 注册工具（tool-register 表单，09 §3.8 去独立 source 入参）。
   * POST /api/v1/tools {name, execution, mcpServer?, schema?, initCommand?, enabled?}
   *   → 201 + Tool 对象；action 冲突 → 409 `TOOL_ACTION_EXISTS`。
   */
  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '注册工具（无 source 入参，execution=mcp→mcp 其余→custom）' })
  create(@Body() dto: CreateToolDto) {
    return this.toolsService.create(dto);
  }

  /**
   * 更新工具定义（仅 schema/initCommand/enabled，09 §3.8 收敛契约）。
   * PATCH /api/v1/tools/:id {enabled: false, schema?, initCommand?} → 200 + Tool 对象
   * 不存在 → 404 `TOOL_NOT_FOUND`。
   */
  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '更新工具（仅 schema/initCommand/enabled；停用替代删除）' })
  update(@Param('id') id: string, @Body() dto: UpdateToolDto) {
    return this.toolsService.update(id, dto);
  }
}
