import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import {
  TEAM_MEMBERSHIP_ERRORS,
  TeamMembershipGuard,
} from '../common/guards/team-membership.guard';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { RejectTaskDto } from './dto/reject-task.dto';
import { UpdateExecutionModeDto } from './dto/update-execution-mode.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { UpdateInstanceDto } from './dto/update-instance.dto';
import { TasksService } from './tasks.service';

/**
 * 任务端点（09 篇 §3.4 Tasks 部分）。
 *
 * 全部端点挂 TeamMembershipGuard（团队成员门）：
 *  - POST /tasks 由请求体 teamId 经 service 层 teamUserMember 校验；
 *  - GET /tasks?teamId= 传入 teamId 时走成员校验，无 teamId 时仅要求登录，
 *    可见范围下沉到本控制器（按 teamUserMember 反查 teamIds 聚合）；
 *  - /tasks/:id 由守卫从任务反查 teamId（任务不存在 404）。
 * 叠加 PermissionGuard（CONF-02 方案②补齐矩阵守卫）：读端点 tasks.view，
 * 写端点按语义 tasks.create / tasks.edit / tasks.review——成员过滤保留，
 * 矩阵权限点在成员之上生效（admin all:true 全放行 / member all:false 写拒）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/tasks 等。
 */
@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(TeamMembershipGuard)
@Controller()
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 看板列表：团队作用域 + 五态筛选 + 分页。
   * GET /api/v1/tasks?teamId=&status=&priority= → {items, total, page, pageSize}
   * teamId 缺省时返回调用者所有可见团队任务（teamUserMember 反查 teamIds 聚合，
   * createdAt desc 合并分页；page 默认 1、pageSize 默认 20 上限 100）。
   */
  @Get('tasks')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.view')
  @ApiOperation({
    summary: '任务看板列表（团队作用域 + 五态/优先级筛选 + 分页）',
  })
  @ApiQuery({
    name: 'teamId',
    required: false,
    description: '团队 id（缺省返回调用者所有可见团队任务）',
  })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryTasksDto,
    @Query('teamId') teamId?: string,
  ) {
    if (typeof teamId === 'string' && teamId.length > 0) {
      const member = await (this.prisma as any).teamUserMember.findUnique({
        where: { teamId_userId: { teamId, userId: user.id } },
      });
      if (!member) {
        throw new ForbiddenException({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
          message: '您不是该团队成员',
        });
      }
      return this.tasksService.findAll({ ...query, teamId });
    }
    const memberships = await (this.prisma as any).teamUserMember.findMany({
      where: { userId: user.id },
      select: { teamId: true },
    });
    const teamIds = [
      ...new Set(
        ((memberships as { teamId?: unknown }[]) ?? [])
          .map((m) => m.teamId)
          .filter((t): t is string => typeof t === 'string' && t.length > 0),
      ),
    ];
    const page = this.normalizePage(query.page);
    const pageSize = this.normalizePageSize(query.pageSize);
    if (teamIds.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }
    const perTeam = await Promise.all(
      teamIds.map((tid) =>
        this.tasksService.findAll({
          ...query,
          teamId: tid,
          page: 1,
          pageSize: 100,
        }),
      ),
    );
    const merged = perTeam
      .flatMap((r) => r.items ?? [])
      .sort(
        (a: { createdAt: string | Date }, b: { createdAt: string | Date }) =>
          +new Date(b.createdAt) - +new Date(a.createdAt),
      );
    return {
      items: merged.slice((page - 1) * pageSize, page * pageSize),
      total: merged.length,
      page,
      pageSize,
    };
  }

  /**
   * 创建任务（三件套同事务：任务 + 群聊频道 + 虚拟团队 + 状态事件）。
   * POST /api/v1/tasks → 201 + 任务对象（团队必填 teamId，service 层校验成员）。
   */
  @Post('tasks')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.create')
  @ApiOperation({
    summary: '创建任务（三件套同事务：任务+群聊+团队+事件，并广播状态变更）',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(user.id, dto);
  }

  /**
   * 任务详情（含 teamAgentIds、instances、backgroundDocs）。
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
   * 团队调整（FR-02，14 篇 §5.3；角色/实例分离 T2）：`{addInstances[], removeInstanceIds[]}`。
   * addInstances 新增实例（agentId 可重复，服务端生成 seq）；removeInstanceIds 按实例 id 移除。
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
   * 实例启用/禁用（按实例粒度）。
   * PATCH /api/v1/tasks/:id/instances/:instanceId
   */
  @Patch('tasks/:id/instances/:instanceId')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '更新任务实例（启用/禁用）' })
  updateInstance(
    @Param('id') id: string,
    @Param('instanceId') instanceId: string,
    @Body() dto: UpdateInstanceDto,
  ) {
    return this.tasksService.updateInstance(id, instanceId, dto);
  }

  /**
   * 切换任务执行模式（tc-flow）：direct ↔ plan。
   * PATCH /api/v1/tasks/:id/execution-mode
   */
  @Patch('tasks/:id/execution-mode')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '切换任务执行模式（direct/plan）' })
  updateExecutionMode(
    @Param('id') id: string,
    @Body() dto: UpdateExecutionModeDto,
  ) {
    return this.tasksService.updateExecutionMode(id, dto.mode);
  }

  /**
   * 启动任务（pending → in_progress，13 篇 §4.2）。
   * POST /api/v1/tasks/:id/start
   */
  @Post('tasks/:id/start')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({
    summary: '启动任务（pending → in_progress，校验团队与主 Agent）',
  })
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
  @ApiOperation({
    summary: '验收驳回（pending_review → in_progress，可带原因）',
  })
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

  /** 无 teamId 聚合路径的分页归一化（与 service 侧看板语义一致：page 默认 1）。 */
  private normalizePage(page?: number): number {
    const p = Number(page ?? 1);
    return Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
  }

  /** 无 teamId 聚合路径的分页归一化（pageSize 默认 20 上限 100，防无 teamId 全量分页爆炸）。 */
  private normalizePageSize(pageSize?: number): number {
    const ps = Number(pageSize ?? 20);
    if (!Number.isFinite(ps)) return 20;
    return Math.min(Math.max(Math.floor(ps), 1), 100);
  }
}
