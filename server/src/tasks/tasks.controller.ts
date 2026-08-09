import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectId } from '../common/decorators/project-id.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ProjectMembershipGuard } from '../common/guards/project-membership.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../projects/current-user.decorator';
import { CreateTaskDto } from './dto/create-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { RejectTaskDto } from './dto/reject-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { TasksService } from './tasks.service';

/**
 * 任务端点（09 篇 §3.4 Tasks 部分）。
 *
 * 全部端点挂 ProjectMembershipGuard（T2）：
 *  - /projects/:pid/tasks 由路由 pid 解析项目；
 *  - /tasks/:id 由守卫从任务反查 projectId（任务不存在 404）。
 * 叠加 PermissionGuard（CONF-02 方案②补齐矩阵守卫）：读端点 tasks.view，
 * 写端点按语义 tasks.create / tasks.edit / tasks.review——成员过滤保留，
 * 矩阵权限点在成员之上生效（admin all:true 全放行 / member all:false 写拒）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/projects/:pid/tasks 等。
 */
@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(ProjectMembershipGuard)
@Controller()
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  /**
   * 看板列表：五态筛选 + 分页。
   * GET /api/v1/projects/:pid/tasks → {items, total, page, pageSize}
   */
  @Get('projects/:pid/tasks')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.view')
  @ApiOperation({ summary: '项目任务看板列表（五态/优先级筛选 + 分页）' })
  findAll(@ProjectId() pid: string, @Query() query: QueryTasksDto) {
    return this.tasksService.findAll(pid, query);
  }

  /**
   * 创建任务（三件套同事务：任务 + 群聊频道 + 虚拟团队 + 状态事件）。
   * POST /api/v1/projects/:pid/tasks → 201 + 任务对象
   */
  @Post('projects/:pid/tasks')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.create')
  @ApiOperation({ summary: '创建任务（三件套同事务：任务+群聊+团队+事件，并广播状态变更）' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @ProjectId() pid: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.tasksService.create(pid, user.id, dto);
  }

  /**
   * 任务详情（含 teamAgentIds、backgroundDocs）。
   * GET /api/v1/tasks/:id
   */
  @Get('tasks/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.view')
  @ApiOperation({ summary: '任务详情' })
  findOne(@Param('id') id: string) {
    return this.tasksService.findOne(id);
  }

  /**
   * 编辑任务（标题/描述/优先级/主 Agent）。
   * PATCH /api/v1/tasks/:id
   */
  @Patch('tasks/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '编辑任务（标题/描述/优先级/主 Agent）' })
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto) {
    return this.tasksService.update(id, dto);
  }

  /**
   * 团队调整（FR-02，14 篇 §5.3）：`{addAgentIds[], removeAgentIds[]}`。
   * 仅 pending/in_progress 合法；移除后会话冻结、产出物保留、群聊发系统消息。
   * POST /api/v1/tasks/:id/team
   */
  @Post('tasks/:id/team')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '团队调整（添加/移除 Agent，FR-02）' })
  updateTeam(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.tasksService.updateTeam(id, dto, user.id);
  }

  /**
   * 启动任务（pending → in_progress，13 篇 §4.2）。
   * POST /api/v1/tasks/:id/start
   */
  @Post('tasks/:id/start')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '启动任务（pending → in_progress，校验团队与主 Agent）' })
  start(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tasksService.start(id, user.id);
  }

  /**
   * 标记待验收（in_progress → pending_review，13 篇 §4.3）。
   * POST /api/v1/tasks/:id/mark-pending-review
   */
  @Post('tasks/:id/mark-pending-review')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '标记待验收（in_progress → pending_review）' })
  markPendingReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.tasksService.markPendingReview(id, user.id);
  }

  /**
   * 验收通过（pending_review → completed，13 篇 §4.4）。
   * POST /api/v1/tasks/:id/accept
   */
  @Post('tasks/:id/accept')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.review')
  @ApiOperation({ summary: '验收通过（pending_review → completed）' })
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tasksService.accept(id, user.id);
  }

  /**
   * 验收驳回（pending_review → in_progress，13 篇 §4.4，可带驳回原因）。
   * POST /api/v1/tasks/:id/reject
   */
  @Post('tasks/:id/reject')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.review')
  @ApiOperation({ summary: '验收驳回（pending_review → in_progress，可带原因）' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectTaskDto,
  ) {
    return this.tasksService.reject(id, user.id, dto);
  }

  /**
   * 归档任务（completed → archived，终态，13 篇 §4.5）。
   * POST /api/v1/tasks/:id/archive
   */
  @Post('tasks/:id/archive')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '归档任务（completed → archived，终态）' })
  archive(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tasksService.archive(id, user.id);
  }
}
