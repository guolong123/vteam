import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  ServiceUnavailableException,
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
import { CompleteTaskDto } from './dto/complete-task.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { PlanCompleteDto } from './dto/plan-complete.dto';
import { PlanConfirmDto } from './dto/plan-confirm.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { RejectTaskDto } from './dto/reject-task.dto';
import { BlockTaskDto } from './dto/block-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTaskTeamDto } from './dto/update-team.dto';
import { UpdateInstanceDto } from './dto/update-instance.dto';
import { TasksService } from './tasks.service';
import { PlanLifecycleService } from './plan-lifecycle.service';
import { PLAN_FILE_DISPLAY_ONLY_WARNING } from './plan-lifecycle.service';
import { PlanStepsService } from './plan-steps.service';
import { PlanDocsService } from './plan-docs.service';
import { UploadPlanDocDto } from './dto/upload-plan-doc.dto';

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
    private readonly planStepsService: PlanStepsService,
    private readonly planDocsService: PlanDocsService,
    private readonly planLifecycle: PlanLifecycleService,
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
   * 计划执行步骤（只读，计划 Tab 步骤区数据源）。
   * GET /api/v1/tasks/:id/plan-steps → {steps, workerId, degraded}
   *
   * 定位链：任务 → 团队主 Agent 成员 session（workerId + instanceRef）→
   * worker GET /todos → serve GET /session/{id}/todo。任一环节缺失 → degraded，
   * 不抛错（列表类端点不阻断页面）。步骤状态只由 agent 经 opencode todo 工具推进，
   * vteam 不写。
   */
  @Get('tasks/:id/plan-steps')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.view')
  @ApiOperation({ summary: '计划执行步骤（opencode todo 只读透传）' })
  listPlanSteps(@Param('id') id: string) {
    return this.planStepsService.listPlanSteps(id);
  }

  /**
   * 计划文档列表（只读，计划 Tab 列表区数据源）。
   * GET /api/v1/tasks/:id/plan-docs → {files, workerId, directory, degraded}
   *
   * 数据源是任务目录 `.opencode/plans/*.md` 的真实文件（agent 写的、或用户上传的），
   * 一并下发正文供 Modal 直接渲染（免二次请求）。vteam 不落库、不维护版本——文件即真相；
   * 目录为空是常态（degraded=false + files=[]），读不到才是 degraded=true。
   */
  @Get('tasks/:id/plan-docs')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.view')
  @ApiOperation({
    summary: '计划文档列表（任务目录 .opencode/plans 只读同步）',
  })
  listPlanDocs(@Param('id') id: string) {
    return this.planDocsService.listPlanDocs(id);
  }

  /**
   * 上传/覆盖计划文档（写路径）。
   * POST /api/v1/tasks/:id/plan-docs {name, content} → {name, updatedAt, directory}
   *
   * 文件写进任务目录 `.opencode/plans/<name>`——agent 侧同目录立即可读，页面下轮轮询可见。
   * 只做文件同步：不解析内容、不改 agent 行为（要不要采纳计划由 agent 自己决定）。
   * 权限点用 tasks.edit（与任务编辑同级：都会影响任务的执行输入）。
   */
  @Post('tasks/:id/plan-docs')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '上传计划文档（写入任务目录 .opencode/plans）' })
  async uploadPlanDoc(@Param('id') id: string, @Body() dto: UploadPlanDocDto) {
    try {
      return await this.planDocsService.writePlanDoc(id, {
        name: dto.name,
        content: dto.content,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 定位不到 worker（团队无主 Agent / 无会话 / 离线）是"暂时不可用"而非服务端 bug，
      // 用 503 + 可读原因回给前端（否则用户只看到 500，无法判断该找主 Agent 还是重试）。
      if (message.includes('未定位到可用的 worker')) {
        throw new ServiceUnavailableException(message);
      }
      throw err;
    }
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
    @Body() dto: UpdateTaskTeamDto,
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
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto?: CompleteTaskDto,
  ) {
    return this.tasksService.accept(id, user.id, {
      force: dto?.force === true,
      forceReason: dto?.reason,
    });
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
   * 阻塞挂起（in_progress → blocked，reason 必填写明卡点）。
   * POST /api/v1/tasks/:id/block
   */
  @Post('tasks/:id/block')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '阻塞挂起（in_progress → blocked，原因必填）' })
  block(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: BlockTaskDto,
  ) {
    return this.tasksService.block(id, user.id, dto?.reason);
  }

  /**
   * 阻塞恢复（blocked → in_progress）。
   * POST /api/v1/tasks/:id/resume
   */
  @Post('tasks/:id/resume')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '阻塞恢复（blocked → in_progress）' })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tasksService.resume(id, user.id);
  }

  /**
   * 归档任务（completed → archived，终态，13 篇 §4.5）。
   * POST /api/v1/tasks/:id/archive
   */
  @Post('tasks/:id/archive')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '归档任务（completed → archived，终态）' })
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto?: CompleteTaskDto,
  ) {
    return this.tasksService.archive(id, user.id, {
      force: dto?.force === true,
      forceReason: dto?.reason,
    });
  }

  /**
   * 删除任务（硬删）。DELETE /api/v1/tasks/:id
   * 与 archive 不同：archive 只把状态推到终态、任务行仍在；本端点物理删除任务行
   * 及其任务级子表数据。in_progress / pending_review 拒绝（409 TASK_DELETE_BLOCKED）。
   */
  @Delete('tasks/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({ summary: '删除任务（硬删；执行中/待验收拒绝）' })
  remove(@Param('id') id: string) {
    return this.tasksService.remove(id);
  }

  /**
   * 用户确认门（todo11：任一团队成员可点，主确认链仅作模式参照，不照搬主可点规则）。
   * POST /api/v1/tasks/:id/plan/confirm {action?, reason?}
   * finalize：pending_final→approved 定稿确认（用户显式定稿，幂等，已 approved 二次
   *   POST 同结果），记 finalizedBy/finalizedAt，落系统消息；
   * confirm（缺省）：approved→executing，幂等（已 executing 二次 POST 同结果），
   *   记 confirmedBy/confirmedAt，落系统消息，plan.status.executing 事件触发 PM 续推 W2；
   * reject：approved/rejected→draft 打回（reason 必填，版本号+1 轮次不变重走收敛）；
   * revise：executing/completed→draft 修订（reason 必填，版本号+1 轮次+1 重走完整 N/N 复评）。
   * 错态 409 精确码（details.current 携带 DB 真值状态）。
   */
  @Post('tasks/:id/plan/confirm')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.edit')
  @ApiOperation({
    summary:
      '用户确认门（定稿 finalize / 开始执行 confirm 幂等 / 打回 draft / 修订重评 revise）',
  })
  confirmPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PlanConfirmDto,
  ) {
    return this.planLifecycle.confirmPlan(id, {
      userId: user.id,
      userName: user.username,
      action: dto.action ?? 'confirm',
      reason: dto.reason ?? null,
      skipReview: dto.skipReview === true,
    });
  }

  /**
   * 完工标记（todo11：PM/主实例鉴权）。
   * PATCH /api/v1/tasks/:id/plan/complete {instanceId?}
   * executing→completed（已 completed 幂等同结果）；instanceId 须等于团队主成员，
   * 否则 403；用户路径由 tasks.review 权限守卫（PM 操作）。
   */
  @Patch('tasks/:id/plan/complete')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.review')
  @ApiOperation({ summary: '完工标记（executing→completed，PM/主实例）' })
  completePlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PlanCompleteDto,
  ) {
    return this.planLifecycle.completePlan(id, {
      userId: user.id,
      userName: user.username,
      instanceId: dto.instanceId ?? null,
    });
  }

  /**
   * 计划状态（todo11 真值源=DB plans.status，文件 plan-docs 仅展示）。
   * GET /api/v1/tasks/:id/plan → {plan, status, source:'db', fileDocs, warning?}
   * 徽标/按钮/checklist 一律读本端点 status；文件与 DB 不一致时以 DB 为准并附告警。
   */
  @Get('tasks/:id/plan')
  @UseGuards(PermissionGuard)
  @RequirePermission('tasks.view')
  @ApiOperation({ summary: '计划状态（DB 真值源，文件仅展示）' })
  async getPlan(@Param('id') id: string) {
    const plan = await this.planLifecycle.getPlan(id);
    let fileCount = 0;
    let fileDocsDegraded = false;
    try {
      const docs = await this.planDocsService.listPlanDocs(id);
      fileCount = docs?.files?.length ?? 0;
      fileDocsDegraded = docs?.degraded ?? false;
    } catch {
      fileDocsDegraded = true;
    }
    const diverged = fileCount > 0;
    return {
      plan,
      status: (plan as { status?: string } | null)?.status ?? null,
      source: 'db' as const,
      fileDocs: {
        displayOnly: true,
        count: fileCount,
        degraded: fileDocsDegraded,
      },
      ...(diverged ? { warning: PLAN_FILE_DISPLAY_ONLY_WARNING } : {}),
    };
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
