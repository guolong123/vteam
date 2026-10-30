import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { AdminGuard } from '../users/admin.guard';
import { QueryStatsDto, QueryStatsOverviewDto } from './dto/query-stats.dto';
import { StatsService, type StatsViewer } from './stats.service';
import type {
  StatsOverviewResponse,
  StatsTeamDetailResponse,
} from './stats.types';

/**
 * 团队统计看板端点（stats-dashboard，对齐 docs/agent-platform/35-团队统计看板设计.md §6）。
 *
 * 路由形态：`@Controller('stats')` 前缀挂载，对齐仓库既有 REST 风格
 * （与 `usage` 的裸挂载 + 完整路径写法等价，但本模块两个端点共享 `stats` 前缀，用前缀更清晰）。
 *
 * ## 鉴权模型（**两个端点门禁不同，这是刻意的**）
 *
 * - `GET /stats/overview`：**平台管理员**（AdminGuard）。
 *   理由：跨团队全量经营数据（每个团队烧了多少钱、产出多少），属管理视角体检数据，
 *   与 `coordination-metrics` 同口径，不对普通成员开放。
 * - `GET /stats/teams/:teamId`：**团队成员可见**（权限下沉 service，复用
 *   `team_user_members` + 平台管理员回落，与 `usage.service` 同链）。
 *   理由：团队自己的数据不是经营机密，成员看自己的产出天经地义。
 *
 * 全局 JwtAuthGuard（APP_GUARD）始终兜底：未带 token ⇒ 401。
 *
 * ## 只读保证
 *
 * 本控制器**只暴露两个 GET**，零写操作；数据写入链路全部由各域既有事件落库承担。
 */
@ApiTags('stats')
@ApiBearerAuth()
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  /**
   * 全局统计看板（跨团队汇总 + 团队对比 + 时间趋势）。
   * GET /api/v1/stats/overview?days=30&granularity=day&to=2026-10-30&teamIds=a,b
   *   → 200 {window, totals, buckets, teams[], avgCycleHours, firstPassRate, reworkCount}
   * 仅平台管理员；窗口上限 90 天（超限 400，不静默截断）。
   */
  @Get('overview')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary:
      '全局统计看板（跨团队任务/产出物/token/成本 + 时间趋势；仅管理员；只读）',
  })
  overview(
    @Query() query: QueryStatsOverviewDto,
  ): Promise<StatsOverviewResponse> {
    return this.statsService.overview({
      days: query.days,
      granularity: query.granularity,
      to: query.to,
      teamIds: query.teamIds,
    });
  }

  /**
   * 单团队统计详情（含周期/质量指标、成员产能、产出物构成、状态快照）。
   * GET /api/v1/stats/teams/:teamId?days=30&granularity=day&to=2026-10-30
   *   → 200 {teamId, teamName, window, totals, buckets[], avgCycleHours, cycleHoursP90,
   *      avgQueueWaitHours, queueWaitSource, firstPassRate, reviewRounds, reworkCount,
   *      artifactMix[], members[], statusMix}
   * 团队成员可见（非成员且非平台管理员 → 403 PERMISSION_TEAM_NOT_MEMBER）；
   * 团队不存在 → 404 TEAM_NOT_FOUND。
   */
  @Get('teams/:teamId')
  @ApiOperation({
    summary:
      '单团队统计详情（任务/产出物/token/成本 + 周期/质量/成员产能；团队成员可见；只读）',
  })
  teamDetail(
    @Param('teamId') teamId: string,
    @Query() query: QueryStatsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StatsTeamDetailResponse> {
    const viewer: StatsViewer = { id: user.id };
    return this.statsService.teamDetail(
      teamId,
      {
        days: query.days,
        granularity: query.granularity,
        to: query.to,
      },
      viewer,
    );
  }
}
