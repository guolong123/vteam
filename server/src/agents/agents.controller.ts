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
import {
  AuthenticatedUser,
  CurrentUser,
} from '../projects/current-user.decorator';
import { AgentsService } from './agents.service';
import { CloneAgentDto } from './dto/clone-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

/**
 * Agent 端点。全局 JwtAuthGuard（APP_GUARD）已鉴权，无需项目成员校验。
 * 权限矩阵（8 资源 × 6 操作）：读取挂 agents.view，创建/克隆挂 agents.create，
 * 更新挂 agents.edit，删除挂 agents.delete（09 篇 §3.3 [project] + 08 篇 PermissionsModule）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/agents。
 */
@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  /**
   * Agent 列表（type 过滤 + 分页 + 扩展字段）。
   * GET /api/v1/agents?type=template&page=1&pageSize=20
   */
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.view')
  @ApiOperation({ summary: 'Agent 列表（type 过滤 + 分页 + 扩展字段）' })
  findAll(@Query() query: QueryAgentsDto) {
    return this.agentsService.findAll(query);
  }

  /**
   * 创建自定义 Agent（三表事务：Agent + agent_skills + agent_tool_effects）。
   * POST /api/v1/agents {name, type: 'custom', prompt?, role?, skillIds?, toolEffects?, permissionScope?, defaultModelId?}
   *   → 201 + Agent 对象（type=custom，baseAgentId=null）
   */
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.create')
  @ApiOperation({ summary: '创建自定义 Agent（custom，三表事务）' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateAgentDto) {
    return this.agentsService.create(user.id, dto);
  }

  /**
   * 克隆 Agent（baseAgentId 血缘 + 三表深拷贝，原 Agent 不受影响）。
   * POST /api/v1/agents/:id/clone {name?} → 201 + 克隆副本（type=clone）
   * 源不存在 → 404 `AGENT_NOT_FOUND`
   */
  @Post(':id/clone')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.create')
  @ApiOperation({ summary: '克隆 Agent（baseAgentId 血缘 + 三表深拷贝）' })
  clone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CloneAgentDto,
  ) {
    return this.agentsService.clone(user.id, id, dto);
  }

  /**
   * 更新 Agent（is_0000000030：template/内置也可修改设置字段，agentId/type 不可改）。
   * PATCH /api/v1/agents/:id {prompt?, role?, skillIds?, toolEffects?, permissionScope?, defaultModelId?}
   * skillIds/toolEffects 显式传入时重建关联。
   */
  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.edit')
  @ApiOperation({
    summary: '更新 Agent（内置/自定义均可修改设置，agentId/type 不可改）',
  })
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.agentsService.update(id, dto);
  }

  /**
   * 删除 Agent（type=template → 403；clone/custom 可删，含 agent_skills/agent_tool_effects 关联清理）。
   * DELETE /api/v1/agents/:id → 200
   */
  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.delete')
  @ApiOperation({ summary: '删除 Agent（template → 403；custom 含关联清理）' })
  remove(@Param('id') id: string) {
    return this.agentsService.remove(id);
  }

  /**
   * 可用模型列表（FR-47，T11 动态化）。经 WorkerClient.listModels 取 worker 真实模型
   * （id=`providerID/modelID`）；无可用 worker/失败降级静态列表并标记 source=fallback。
   * GET /api/v1/agents/:id/available-models → 200 [{id, name}] 或 {models, source}
   */
  @Get(':id/available-models')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.view')
  @ApiOperation({
    summary: '可用模型列表（T11 动态化：worker 实时模型，失败降级静态）',
  })
  getAvailableModels(@Param('id') id: string) {
    return this.agentsService.getAvailableModels(id);
  }

  /**
   * Agent 详情（含 skills/toolEffects 完整关联）。
   * GET /api/v1/agents/:id → 200 完整对象；不存在 → 404 `AGENT_NOT_FOUND`
   */
  @Get(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.view')
  @ApiOperation({ summary: 'Agent 详情（含 skills/toolEffects 关联）' })
  findOne(@Param('id') id: string) {
    return this.agentsService.findOne(id);
  }
}
