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
import { CreateExecutionPolicyDto } from './dto/create-execution-policy.dto';
import { QueryExecutionPoliciesDto } from './dto/query-execution-policies.dto';
import { UpdateExecutionPolicyDto } from './dto/update-execution-policy.dto';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * ExecutionPolicy 端点（vteam-role-behavior-enforcement Todo 11）。
 * 全局 JwtAuthGuard（APP_GUARD）已鉴权；权限复用 agents 域权限点：
 * 读取挂 `agents.view`，创建/更新/删除挂 `agents.edit`（09 篇 §3.3 权限矩阵语义）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/execution-policies。
 *
 * - GET /execution-policies：type 过滤 + 分页（含 template 只读策略）
 * - GET /execution-policies/:id：详情（不存在 → 404 POLICY_NOT_FOUND）
 * - POST /execution-policies：仅 type=custom（template → 403；非法 config → 400）
 * - PATCH /execution-policies/:id：template 目标 → 403；非法 config → 400；type 不可改
 * - DELETE /execution-policies/:id：template 目标 → 403
 */
@ApiTags('execution-policies')
@ApiBearerAuth()
@Controller('execution-policies')
export class ExecutionPoliciesController {
  constructor(private readonly policies: ExecutionPolicyService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.view')
  @ApiOperation({
    summary: '策略列表（type 过滤 + 分页，含 template 只读策略）',
  })
  findAll(@Query() query: QueryExecutionPoliciesDto) {
    return this.policies.findAll(query);
  }

  @Get(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.view')
  @ApiOperation({ summary: '策略详情（不存在 → 404 POLICY_NOT_FOUND）' })
  findOne(@Param('id') id: string) {
    return this.policies.findOne(id);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.edit')
  @ApiOperation({ summary: '创建策略（仅 custom；非法 config → 400）' })
  create(@Body() dto: CreateExecutionPolicyDto) {
    return this.policies.create(dto);
  }

  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.edit')
  @ApiOperation({ summary: '更新策略（template → 403；非法 config → 400）' })
  update(@Param('id') id: string, @Body() dto: UpdateExecutionPolicyDto) {
    return this.policies.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('agents.edit')
  @ApiOperation({ summary: '删除策略（template → 403）' })
  remove(@Param('id') id: string) {
    return this.policies.remove(id);
  }
}
