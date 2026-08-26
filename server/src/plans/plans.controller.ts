import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../projects/current-user.decorator';
import { QueryPlansDto } from './dto/query-plans.dto';
import { ReviewPlanDto } from './dto/review-plan.dto';
import { PlanReviewVerdict, PlansService } from './plans.service';

/**
 * 协作计划 REST 端点（vteam-team-collaboration tc-review）。
 *
 * 权限模型（对齐 issues.controller）：**不挂** AdminGuard（项目成员即可查/评审自己
 * 任务的计划）、**不挂** ProjectMembershipGuard（其 :id 路由反查会把 /plans/:id
 * 的 :id 误解析为 taskId → 404 TASK_NOT_FOUND）。鉴权依赖全局 JwtAuthGuard
 * （APP_GUARD），项目成员校验全部在 PlansService 内经 taskId → projectId 完成。
 *
 * 全局前缀 /api/v1（main.ts 已设置），实际路由 /api/v1/plans。
 */
@ApiTags('plans')
@ApiBearerAuth()
@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  /**
   * 查询任务执行计划（项目成员，一任务一计划）。
   * GET /api/v1/plans?taskId= → 200 计划头（含 reviewerInstanceId）+ 子任务清单全文
   */
  @Get()
  @ApiOperation({
    summary: '查询任务执行计划（项目成员，按 taskId 查计划头 + 子任务清单）',
  })
  findByTask(
    @Query() query: QueryPlansDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.plansService.findByTask(query.taskId, user.id);
  }

  /**
   * 评审执行计划（项目成员可评审——FR-04 验收判定权在成员）。
   * PATCH /api/v1/plans/:id/review {verdict: approved|rejected, reason?} → 200
   *   {id, taskId, status, reviewerInstanceId}；rejected 必填 reason（400）；
   *   非 reviewing 状态 → 400 PLAN_INVALID_STATUS；评审后 reviewerInstanceId 置 null
   */
  @Patch(':id/review')
  @ApiOperation({
    summary:
      '评审执行计划（项目成员，verdict=approved/rejected，rejected 必填 reason）',
  })
  review(
    @Param('id') id: string,
    @Body() dto: ReviewPlanDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.plansService.review(
      id,
      user.id,
      dto.verdict as PlanReviewVerdict,
      dto.reason,
    );
  }

  /**
   * 计划子任务清单（项目成员，含 assignee 概览）。
   * GET /api/v1/plans/:id/tasks → 200 PlanTaskDto[]
   */
  @Get(':id/tasks')
  @ApiOperation({ summary: '计划子任务清单（项目成员，含指派概览）' })
  findTasks(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plansService.findTasks(id, user.id);
  }
}
