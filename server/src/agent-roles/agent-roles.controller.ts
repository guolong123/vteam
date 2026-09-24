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
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { AgentRolesService } from './agent-roles.service';
import { CreateAgentRoleDto } from './dto/create-agent-role.dto';
import { QueryAgentRolesDto } from './dto/query-agent-roles.dto';
import { UpdateAgentRoleDto } from './dto/update-agent-role.dto';

/**
 * AgentRole 端点（agent-role-entity todo 6）。全局 JwtAuthGuard（APP_GUARD）已鉴权，
 * 无需项目成员校验。权限点**复用 agents 域现有矩阵**（不新造权限点）：
 * 读取挂 `agents.view`，创建挂 `agents.create`，更新挂 `agents.edit`，删除挂 `agents.delete`
 * （镜像 agents / execution-policies 模块；09 篇 §3.3）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/agent-roles。
 *
 * - GET /agent-roles：type 过滤 + 分页（type/sortOrder 排序，builtin 在前）
 * - GET /agent-roles/:id：详情（不存在 → 404 AGENT_ROLE_NOT_FOUND）
 * - POST /agent-roles：仅 type=custom（key 唯一 → 409；defaultAgentId 须存在 → 400）
 * - PATCH /agent-roles/:id：内置角色可编辑 name/description/rolePrompt/defaultAgentId，改 key → 403
 * - DELETE /agent-roles/:id：内置角色 → 403（行保留）；被成员引用 → 409
 */
@ApiTags('agent-roles')
@ApiBearerAuth()
@Controller('agent-roles')
export class AgentRolesController {
  constructor(private readonly agentRolesService: AgentRolesService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.view')
  @ApiOperation({ summary: 'AgentRole 列表（type 过滤 + 分页，内置优先）' })
  findAll(@Query() query: QueryAgentRolesDto) {
    return this.agentRolesService.findAll(query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.create')
  @ApiOperation({ summary: '创建自定义 AgentRole（仅 custom；key 唯一）' })
  create(@Body() dto: CreateAgentRoleDto) {
    return this.agentRolesService.create(dto);
  }

  @Get(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.view')
  @ApiOperation({
    summary: 'AgentRole 详情（不存在 → 404 AGENT_ROLE_NOT_FOUND）',
  })
  findOne(@Param('id') id: string) {
    return this.agentRolesService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.edit')
  @ApiOperation({
    summary: '更新 AgentRole（内置角色改 key → 403）',
  })
  update(@Param('id') id: string, @Body() dto: UpdateAgentRoleDto) {
    return this.agentRolesService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.delete')
  @ApiOperation({ summary: '删除 AgentRole（内置 → 403；被成员引用 → 409）' })
  remove(@Param('id') id: string) {
    return this.agentRolesService.remove(id);
  }
}
