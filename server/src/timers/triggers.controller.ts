import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { QueryTriggersDto } from './dto/query-triggers.dto';
import { TriggersService } from './triggers.service';

/**
 * 触发器 REST 端点（trigger-unification todo-22，/system/triggers 页面与
 * 团队会话触发 Tab 的底座；todo-16/18 只消费此处契约）。
 * - GET /api/v1/triggers：过滤 + 分页 {items, total, page, pageSize}，
 *   admin 看全局，成员必须带 teamId 且仅见归属团队行（服务端强制）
 * - DELETE /api/v1/triggers/:id：取消（owner 域成员或管理员；已终态幂等 200）
 * 鉴权：全局 JwtAuthGuard 兜底认证（request.user={id,…}）；细粒度 owner/admin
 * 复核在 TriggersService 内逐行执行，不靠守卫与 UI 隐藏。
 */
@ApiTags('triggers')
@ApiBearerAuth()
@Controller('triggers')
export class TriggersController {
  constructor(private readonly triggersService: TriggersService) {}

  /**
   * 触发器列表（scope/status/kind/team/task 过滤 + 分页，项含 source 派生）。
   * GET /api/v1/triggers?status=fired&page=1&pageSize=5
   *   → 200 {items, total, page, pageSize}。
   */
  @Get()
  @ApiOperation({
    summary: '触发器列表（过滤 + 分页，项含 source；成员需 teamId 归属域）',
  })
  async findAll(@Query() query: QueryTriggersDto, @Req() req: Request) {
    return this.triggersService.findAll(query, this.viewerOf(req));
  }

  /**
   * 取消触发器（status→cancelled）。
   * DELETE /api/v1/triggers/:id → 200 当前行；不存在 → 404；无权 → 403；
   * 已 cancelled/fired → 200 当前态（幂等，不 500/409）。
   */
  @Delete(':id')
  @ApiOperation({
    summary: '取消触发器（owner 域成员或管理员；已终态幂等 200）',
  })
  async remove(@Param('id') id: string, @Req() req: Request) {
    return this.triggersService.cancelForUser(id, this.viewerOf(req));
  }

  /** 全局 JwtAuthGuard 已保证认证；user 缺失即 401（防卫链变更后空指针越权）。 */
  private viewerOf(req: Request): { id: string } {
    const viewer = req.user as { id?: string } | undefined;
    if (!viewer?.id) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '未认证或 token 无效',
      });
    }
    return { id: viewer.id };
  }
}
