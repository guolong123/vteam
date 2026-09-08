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
  CurrentUser,
  AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { CreateTeamDto } from './dto/create-team.dto';
import { EnqueueTaskDto } from './dto/enqueue-task.dto';
import { QueryTeamsDto } from './dto/query-teams.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { AddMemberDto, UpdateMemberDto } from './dto/add-member.dto';
import { TeamsService } from './teams.service';

@ApiTags('teams')
@ApiBearerAuth()
@UseGuards(PermissionGuard)
@Controller('teams')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.create')
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
    summary: '团队详情（含 members + reuseSession + currentTaskId + queue）',
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
  @ApiOperation({ summary: '删除团队（仅空闲且队列空）' })
  remove(@Param('id') id: string) {
    return this.teamsService.remove(id);
  }

  @Post(':id/members')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({
    summary: '添加团队成员（agentId 校验，seq FOR UPDATE 防并发重号）',
  })
  addMember(@Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.teamsService.addMember(id, dto);
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

  @Post(':id/queue')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({
    summary: '排队等待（pending 孤儿重入队，仅 pending 可排，FIFO 追加）',
  })
  enqueueQueue(@Param('id') id: string, @Body() dto: EnqueueTaskDto) {
    return this.teamsService.enqueueQueue(id, dto.taskId);
  }

  @Delete(':id/queue/:taskId')
  @UseGuards(PermissionGuard)
  @RequirePermission('teams.edit')
  @ApiOperation({
    summary: '取消排队（仅 queued 可取消，FIFO 重排，非 queued 409）',
  })
  cancelQueue(@Param('id') id: string, @Param('taskId') taskId: string) {
    return this.teamsService.cancelQueue(id, taskId);
  }
}
