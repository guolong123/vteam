import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { TeamUsageResponse, UsageService, UsageViewer } from './usage.service';

/**
 * 团队 Token 用量聚合端点（token-usage-stats Todo 4）。
 *
 * 路由形态：`@Controller()` 裸挂载 + 完整路径 `teams/:teamId/usage`
 * （对齐 chat.controller.ts 的 scoped 端点写法——如 `channels/:id/messages`；
 *  亦与 docs-site 的 TeamPrototypesController 同形）。
 *
 * 鉴权模型（**与 memories 同链，权限下沉 service**）：
 * - 全局 JwtAuthGuard（APP_GUARD）兜底认证，`@CurrentUser()` 取 userId；
 * - 团队成员检查在 service：`team_user_members` 无行且非平台管理员 → 403
 *   PERMISSION_TEAM_NOT_MEMBER（管理员判定复用 users/admin-permission.ts 单一事实来源）；
 * - **全员可见、无 admin 门、无行级过滤**：纯只读累计统计，团队成员看全团队用量
 *   （对齐计划「统计 tab 无 admin 门 / 全员可见」）。
 *
 * 本控制器**只暴露一个 GET**：统计接口零写操作（数据写入仅由 worker 事件落库链路承担）。
 */
@ApiTags('usage')
@ApiBearerAuth()
@Controller()
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  /**
   * 团队用量聚合（成员 × 模型 + 团队合计，一次算好三层）。
   * GET /api/v1/teams/:teamId/usage[?model=providerID/modelID]
   *   → 200 {members: [{teamMemberId, agentName, roleName, totalTokens, inputTokens,
   *      outputTokens, cacheReadTokens, cacheWriteTokens, cost, models: [{model, …同 6 字段}]}],
   *      teamTotal: {totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost}}。
   * `?model=` 精确匹配（缺省/空串 = 不过滤）；空团队返回 `{members: [], teamTotal: 全 0}`。
   * 非团队成员且非平台管理员 → 403 PERMISSION_TEAM_NOT_MEMBER。
   */
  @Get('teams/:teamId/usage')
  @ApiOperation({
    summary:
      '团队 Token 用量与费用聚合（成员 × 模型 + 团队合计；全员可见；可选 ?model= 精确过滤）',
  })
  @ApiQuery({
    name: 'model',
    required: false,
    description: '模型精确过滤（providerID/modelID；缺省/空串 = 不过滤）',
  })
  getTeamUsage(
    @Param('teamId') teamId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('model') model?: string,
  ): Promise<TeamUsageResponse> {
    const viewer: UsageViewer = { id: user.id };
    return this.usageService.getTeamUsage(teamId, viewer, model);
  }
}
