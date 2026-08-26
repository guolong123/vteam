import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../users/admin.guard';
import { QueryMemoriesDto } from './dto/query-memories.dto';
import { MemoriesService } from './memories.service';

/**
 * 记忆管理端点（memory-management Todo 5，Metis m6）。
 * - GET /api/v1/memories：level/projectId/taskId 过滤 + keyword 搜索 + 分页
 * - DELETE /api/v1/memories/:id：软删（deletedAt=now）
 * 鉴权：全局 JwtAuthGuard（APP_GUARD）兜底认证；两个端点均加 AdminGuard
 * （复用 users/admin.guard.ts）——记忆管理仅管理员可见，比 tools 的 GET 成员只读
 * 更严格，不扩展权限矩阵（roles.constants.ts 8 资源不动）。
 */
@ApiTags('memories')
@ApiBearerAuth()
@Controller('memories')
export class MemoriesController {
  constructor(private readonly memoriesService: MemoriesService) {}

  /**
   * 记忆列表（level/projectId/taskId 过滤 + keyword 内容搜索 + 分页）。
   * GET /api/v1/memories?level=task&taskId=t_1&keyword=xxx&page=1&pageSize=20
   *   → 200 {items, total, page, pageSize}；仅管理员（AdminGuard）。
   */
  @Get()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary:
      '记忆列表（level/projectId/taskId 过滤 + keyword 搜索 + 分页，仅管理员）',
  })
  findAll(@Query() query: QueryMemoriesDto) {
    return this.memoriesService.findAll(query);
  }

  /**
   * 软删记忆（deletedAt=now，GET 列表不可见）。
   * DELETE /api/v1/memories/:id → 200 软删后的条目；不存在 → 404 MEMORY_NOT_FOUND。
   */
  @Delete(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '软删记忆（deletedAt=now，仅管理员）' })
  remove(@Param('id') id: string) {
    return this.memoriesService.remove(id);
  }
}
