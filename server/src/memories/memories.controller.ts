import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminGuard } from '../users/admin.guard';
import { QueryMemoriesDto, UpdateMemoryDto } from './dto/query-memories.dto';
import { MemoriesService } from './memories.service';

/**
 * 记忆管理端点（memory-management Todo 5，Metis m6；session-unification Todo 9 起
 * 仅 team/global，任务级记忆已删除）。
 * - GET /api/v1/memories：level/teamId 过滤 + keyword 搜索 + 分页
 * - PATCH /api/v1/memories/:id：部分更新（T4 记忆演进，content/description/tags）
 * - DELETE /api/v1/memories/:id：软删（deletedAt=now）
 * 鉴权：全局 JwtAuthGuard（APP_GUARD）兜底认证；三个端点均加 AdminGuard
 * （复用 users/admin.guard.ts）——记忆管理仅管理员可见，比 tools 的 GET 成员只读
 * 更严格，不扩展权限矩阵（roles.constants.ts 8 资源不动）。
 * PATCH 另叠加团队归属校验（service 内按行 teamId 查 team_user_members，
 * 非成员 403，AdminGuard 保留不移除）。
 */
@ApiTags('memories')
@ApiBearerAuth()
@Controller('memories')
export class MemoriesController {
  constructor(private readonly memoriesService: MemoriesService) {}

  /**
   * 记忆列表（level/teamId 过滤 + keyword 内容搜索 + 分页）。
   * GET /api/v1/memories?level=team&teamId=tm_1&keyword=xxx&page=1&pageSize=20
   *   → 200 {items, total, page, pageSize}；仅管理员（AdminGuard）。
   */
  @Get()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: '记忆列表（level/teamId 过滤 + keyword 搜索 + 分页，仅管理员）',
  })
  findAll(@Query() query: QueryMemoriesDto) {
    return this.memoriesService.findAll(query);
  }

  /**
   * 部分更新记忆（content/description/tags，至少传一个）。
   * PATCH /api/v1/memories/:id → 200 更新后的条目；不存在（含已软删）→ 404
   * MEMORY_NOT_FOUND；team 级行调用者非该团队成员 → 403（AdminGuard 保留）。
   */
  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '部分更新记忆（仅管理员 + 团队归属校验）' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMemoryDto,
    @Req() req: Request,
  ) {
    const viewer = req.user as { id?: string } | undefined;
    return this.memoriesService.update(
      id,
      dto,
      viewer?.id ? { id: viewer.id } : undefined,
    );
  }

  /**
   * 软删记忆（deletedAt=now，GET 列表不可见）。
   * DELETE /api/v1/memories/:id → 200 软删后的条目；不存在 → 404 MEMORY_NOT_FOUND；
   * team 级行调用者非该团队成员 → 403（AdminGuard 保留，与 PATCH 对齐）。
   */
  @Delete(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '软删记忆（仅管理员 + 团队归属校验）' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const viewer = req.user as { id?: string } | undefined;
    return this.memoriesService.remove(
      id,
      viewer?.id ? { id: viewer.id } : undefined,
    );
  }
}
