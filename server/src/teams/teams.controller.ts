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
import { TeamMembershipGuard } from '../common/guards/team-membership.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { CreateTeamDto } from './dto/create-team.dto';
import { QueryTeamsDto } from './dto/query-teams.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { AddMemberDto, UpdateMemberDto } from './dto/add-member.dto';
import { TeamsService } from './teams.service';

/**
 * 团队端点（M0 止血）：类级挂 `TeamMembershipGuard`。
 *
 * `:id` 先按团队 id 解释（团队存在即用）→ 校验调用者是该团队的用户成员
 * （team_user_members），非成员 403 `PERMISSION_TEAM_NOT_MEMBER`；因此
 * GET/PATCH/DELETE `/teams/:id`、成员/用户成员增删、reset-sessions 等按 :id 的端点
 * 全部受团队门保护。`POST /teams`、`GET /teams`（无 :id 参数）仅要求登录，
 * 创建/列表语义保持不变（建团队时 service 校验 agent，空间维度由后续 workspace 阶段收敛）。
 * 每个端点继续挂 PermissionGuard + 权限点：团队门在**归属**维度生效，矩阵守卫在
 * **功能权限**维度生效，两者叠加。
 */
@ApiTags('teams')
@ApiBearerAuth()
@UseGuards(TeamMembershipGuard)
@Controller('teams')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.create')
  // 注：TeamMembershipGuard 为类级守卫；无 :id 参数时仅要求登录（create 保持宽松）
  @ApiOperation({
    summary: '创建全局团队（name 全局唯一，members 校验 agent 存在）',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTeamDto) {
    return this.teamsService.create(user.id, dto);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.view')
  @ApiOperation({ summary: '团队列表（分页 + name 搜索）' })
  findAll(@Query() query: QueryTeamsDto) {
    return this.teamsService.findAll(query);
  }

  @Get(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.view')
  @ApiOperation({
    summary:
      '团队详情（含 members + reuseSession + currentTaskId + activeTaskCount）',
  })
  findOne(@Param('id') id: string) {
    return this.teamsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({
    summary:
      '更新团队（name/description/reuseSession/mainAgentMemberId，version 乐观锁）',
  })
  update(@Param('id') id: string, @Body() dto: UpdateTeamDto) {
    return this.teamsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.delete')
  @ApiOperation({
    summary:
      '删除团队（级联删除关联任务）。默认拦截执行中任务；force=true 强制连同执行中任务一起删',
  })
  remove(@Param('id') id: string, @Query('force') force?: string) {
    return this.teamsService.remove(id, {
      force: force === 'true' || force === '1',
    });
  }

  @Post(':id/members')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({
    summary: '添加团队成员（agentId 校验，seq FOR UPDATE 防并发重号）',
  })
  addMember(
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.teamsService.addMember(id, dto, user.id);
  }

  @Patch(':id/members/:memberId')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({ summary: '更新团队成员（alias/workDir）' })
  updateMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.teamsService.updateMember(id, memberId, dto);
  }

  @Delete(':id/members/:memberId')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({ summary: '移除团队成员（联动 updatedAt/version）' })
  removeMember(@Param('id') id: string, @Param('memberId') memberId: string) {
    return this.teamsService.removeMember(id, memberId);
  }

  @Post(':id/users')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({ summary: '添加团队用户成员（userId 校验，重复 409）' })
  addUserMember(
    @Param('id') id: string,
    @Body() dto: { userId: string; role?: string },
  ) {
    return this.teamsService.addUserMember(id, dto);
  }

  @Delete(':id/users/:userId')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({ summary: '移除团队用户成员（联动 updatedAt/version）' })
  removeUserMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.teamsService.removeUserMember(id, userId);
  }

  @Post(':id/reset-sessions')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({
    summary: '手动重置团队会话（幂等，Memory 不删，已为下一任务开新会话）',
  })
  resetSessions(@Param('id') id: string) {
    return this.teamsService.resetSessions(id);
  }

  @Post(':id/members/:memberId/reset-session')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({
    summary: '重置成员团队会话（新 s_ 行 + 旧失效，请求体空）',
  })
  resetMemberSession(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    return this.teamsService.resetMemberSession(id, memberId);
  }
}
