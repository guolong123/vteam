import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../users/admin.guard';
import {
  CoordinationMetricsResponse,
  CoordinationMetricsService,
} from './coordination-metrics.service';
import { QueryCoordinationMetricsDto } from './dto/query-coordination-metrics.dto';

/**
 * 团队协调度指标端点（批次 E · pm-coordination-hardening「协调度指标」）。
 *
 * 路由形态：`@Controller()` 裸挂载 + 完整路径 `teams/:teamId/coordination-metrics`
 * （对齐 usage 模块的 scoped 只读端点写法）。
 *
 * 鉴权模型（**AdminGuard，不是 PermissionGuard**）：
 * - 本端点是**跨团队的全量经营数据**（每个岗位说了多少话、谁在产出、PM 亲做了多少），
 *   属于平台管理视角的体检数据 ⇒ 只给平台管理员（users:manage / permissions.all）。
 * - **不新造权限点**：本轮硬约束「不收窄任何权限、也不发明能力键」，
 *   故复用仓库既有 admin 端点的唯一护栏（memories.controller.ts 同款 AdminGuard）。
 * - 也**不挂** PermissionGuard：`teams.view` 是「能看团队」的权限，语义上不含
 *   「能看全团队经营数据」；两者混用会让权限矩阵多出一个说不上来的组合。
 * - 全局 JwtAuthGuard（APP_GUARD）仍是兜底：未带 token ⇒ 401，AdminGuard 再判角色。
 *
 * 本控制器**只暴露一个 GET**：观测面零写操作（无 mutation 路径、无新表、无定时任务）。
 */
@ApiTags('coordination-metrics')
@ApiBearerAuth()
@Controller()
export class CoordinationMetricsController {
  constructor(
    private readonly coordinationMetricsService: CoordinationMetricsService,
  ) {}

  /**
   * 团队协调度指标（一次算完四条：PM 产出物数 / PM 消息占比 / 派发 vs 亲做 / 群私双报）。
   * GET /api/v1/teams/:teamId/coordination-metrics[?windowHours=168&to=2026-10-22T00:00:00Z]
   *   → 200 {teamId, teamName, generatedAt, window, totalAgentMessages, roles[], metrics[]}。
   * 窗口缺省 7 天、上限 30 天（超限 400，不静默截断）；团队不存在 → 404。
   * 窗口内无任何消息 ⇒ 全 0 指标（不是错误）。
   */
  @Get('teams/:teamId/coordination-metrics')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary:
      '团队协调度指标（PM 产出物数/消息占比/派发 vs 亲做/群私双报；仅管理员；只读）',
  })
  getCoordinationMetrics(
    @Param('teamId') teamId: string,
    @Query() query: QueryCoordinationMetricsDto,
  ): Promise<CoordinationMetricsResponse> {
    return this.coordinationMetricsService.getCoordinationMetrics(
      teamId,
      query,
    );
  }
}
