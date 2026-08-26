import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../projects/current-user.decorator';
import { CreateIssueDto } from './dto/create-issue.dto';
import { QueryIssuesDto } from './dto/query-issues.dto';
import { TransitionIssueDto } from './dto/transition-issue.dto';
import { UpdateIssueDto } from './dto/update-issue.dto';
import { IssuesService } from './issues.service';

/**
 * Issue 端点（issue-management plan todo 2）。
 *
 * 权限模型（Metis M2/M3）：**不挂** AdminGuard（任务成员即可管理自己的任务 issue）、
 * **不挂** ProjectMembershipGuard（其 :id 路由反查会把 /issues/:id 的 :id 误解析为
 * taskId → 404 TASK_NOT_FOUND）。鉴权依赖全局 JwtAuthGuard（APP_GUARD），
 * 任务成员校验全部在 IssuesService 内经 issue.taskId → projectId 完成。
 *
 * 全局前缀 /api/v1（main.ts 已设置），实际路由 /api/v1/issues。
 */
@ApiTags('issues')
@ApiBearerAuth()
@Controller('issues')
export class IssuesController {
  constructor(private readonly issuesService: IssuesService) {}

  /**
   * 任务 issue 列表（成员只读，按任务过滤 + 状态/指派筛选 + 分页）。
   * GET /api/v1/issues?taskId=&status=&assigneeAgentId=&page=&pageSize=
   *   → 200 {items: [IssueDto], total, page, pageSize}
   */
  @Get()
  @ApiOperation({
    summary: '任务 issue 列表（按任务过滤 + 状态/指派筛选 + 分页）',
  })
  findAll(
    @Query() query: QueryIssuesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.issuesService.findAll(query, user.id);
  }

  /**
   * issue 详情（含 task 标题/指派/创建者名）。
   * GET /api/v1/issues/:id → 200 IssueDto；不存在或已软删 → 404 ISSUE_NOT_FOUND
   */
  @Get(':id')
  @ApiOperation({ summary: 'issue 详情（含任务标题/指派/创建者名）' })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.issuesService.findOne(id, user.id);
  }

  /**
   * 创建 issue（任务成员，createdBy=当前用户）。
   * POST /api/v1/issues {taskId, title, description?, tags?, assigneeAgentId?, assigneeUserId?}
   *   → 201 IssueDto；任务不存在 404 / 非成员 403 / 任务归档 409 / 指派不在团队 400
   */
  @Post()
  @ApiOperation({ summary: '创建 issue（任务成员，指派 Agent 须在任务团队）' })
  create(@Body() dto: CreateIssueDto, @CurrentUser() user: AuthenticatedUser) {
    return this.issuesService.create(user.id, dto);
  }

  /**
   * 编辑 issue（title/description/tags/assignee，assigneeAgentId 变更重新团队校验）。
   * PATCH /api/v1/issues/:id → 200 IssueDto
   */
  @Patch(':id')
  @ApiOperation({
    summary: '编辑 issue（标题/描述/标签/指派，assignee 变更重新校验）',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIssueDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.issuesService.update(id, user.id, dto);
  }

  /**
   * 状态流转（start/resolve/close/reopen/reject）。
   * POST /api/v1/issues/:id/transition {action} → 200 IssueDto；
   *   from 不匹配 → 409 ISSUE_INVALID_TRANSITION；action 非法 → 400
   */
  @Post(':id/transition')
  @ApiOperation({
    summary: 'issue 状态流转（start/resolve/close/reopen/reject）',
  })
  transition(
    @Param('id') id: string,
    @Body() dto: TransitionIssueDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.issuesService.transition(id, user.id, dto);
  }

  /**
   * 软删 issue（deletedAt=now，GET 列表/详情不可见）。
   * DELETE /api/v1/issues/:id → 200 {id, deleted: true}
   */
  @Delete(':id')
  @ApiOperation({ summary: '软删 issue（deletedAt 软删）' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.issuesService.remove(id, user.id);
  }
}
