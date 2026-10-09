import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminGuard } from '../users/admin.guard';
import { QueryMemoriesDto, UpdateMemoryDto } from './dto/query-memories.dto';
import { MemoryMaintenanceService } from './memory-maintenance.service';
import { MemoriesService } from './memories.service';

/**
 * 记忆管理端点（memory-management Todo 5，Metis m6；session-unification Todo 9 起
 * 仅 team/global，任务级记忆已删除）。
 * - GET /api/v1/memories：level/teamId/archived 过滤 + keyword 搜索 + 分页
 * - PATCH /api/v1/memories/:id：部分更新（T4 记忆演进，content/description/tags）
 * - DELETE /api/v1/memories/:id：归档（软删 deletedAt=now）
 * - POST /api/v1/memories/:id/restore：恢复归档行
 * - POST /api/v1/memories/:id/purge：永久硬删（唯一不可逆入口，仅人工触发）
 * - POST /api/v1/memories/maintain：手动跑一轮记忆整理（AdminGuard，见下）
 *
 * 鉴权模型（memory-enhancement Todo 2，权限下沉 service，不扩展 roles.constants 权限矩阵）：
 * - 全局 JwtAuthGuard（APP_GUARD）兜底认证；
 * - **读**（GET）成员感知：管理员全量；非管理员只返回 `global ∪ 自己团队`（service 层强制
 *   OR 过滤，跨团队不可见）——GET 已移除 AdminGuard，故该过滤是安全红线；
 * - **团队行写**（归档/恢复/硬删）= 该团队 team_user_members 成员；**global 行写** = 平台管理员；
 *   两类均不满足 → 403 MEMORY_FORBIDDEN（service `assertRowWritable`）；
 * - **编辑**（PATCH）保留 AdminGuard（内容/标签编辑属管理动作），另叠加既有团队归属校验。
 * - **整理**（POST /maintain，memory-enhancement Todo 9）保留 AdminGuard：跨团队全局动作，
 *   成员触发会变更他人团队记忆。
 */
@ApiTags('memories')
@ApiBearerAuth()
@Controller('memories')
export class MemoriesController {
  constructor(
    private readonly memoriesService: MemoriesService,
    private readonly memoryMaintenanceService: MemoryMaintenanceService,
  ) {}

  /**
   * 记忆列表（level/teamId/archived 过滤 + keyword 内容搜索 + 分页）。
   * GET /api/v1/memories?level=team&teamId=tm_1&keyword=xxx&archived=true&page=1&pageSize=20
   *   → 200 {items, total, page, pageSize}。
   * 管理员全量；非管理员仅见 `global ∪ 自己团队`（成员感知过滤，service 层强制）。
   */
  @Get()
  @ApiOperation({
    summary:
      '记忆列表（level/teamId/archived 过滤 + keyword 搜索 + 分页；非管理员仅见全局与自己团队）',
  })
  findAll(@Query() query: QueryMemoriesDto, @Req() req: Request) {
    return this.memoriesService.findAll(query, this.viewerOf(req));
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
   * 归档记忆（软删 deletedAt=now，GET 活跃列表不可见；语义不变，硬删见 purge）。
   * DELETE /api/v1/memories/:id → 200 软删后的条目；不存在/已归档 → 404 MEMORY_NOT_FOUND；
   * 团队行非成员、global 行非管理员 → 403 MEMORY_FORBIDDEN。
   */
  @Delete(':id')
  @ApiOperation({
    summary: '归档记忆（软删；团队行=团队成员，全局行=管理员）',
  })
  remove(@Param('id') id: string, @Req() req: Request) {
    return this.memoriesService.remove(id, this.viewerOf(req));
  }

  /**
   * 手动触发一轮记忆整理（memory-enhancement Todo 9；与定时触发器同一 handler 入口）。
   * POST /api/v1/memories/maintain → 200 {teams, candidates: {duplicates, unused, untags}}。
   *
   * 服务端只收集候选 + 落 system 条 + 派 prompt，**合并/归档由 Agent 侧经 MCP 工具执行**；
   * 摘要为服务端统计值，不等待 Agent 回传。仅管理员（AdminGuard）：整理是跨团队
   * 全局动作，成员触发会让他人团队的记忆被动变更。
   */
  @Post('maintain')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: '手动触发一轮记忆整理（仅管理员；Agent 侧执行合并/归档）',
  })
  maintain() {
    return this.memoryMaintenanceService.runOnce();
  }

  /**
   * 恢复已归档记忆（清 deletedAt）。
   * POST /api/v1/memories/:id/restore → 200 恢复后的条目；不存在/本就活跃 → 404
   * MEMORY_NOT_FOUND；同 scope 撞活跃同内容行 → 409 MEMORY_RESTORE_DUPLICATE。
   */
  @Post(':id/restore')
  @ApiOperation({
    summary: '恢复已归档记忆（撞同内容活跃行 → 409）',
  })
  restore(@Param('id') id: string, @Req() req: Request) {
    return this.memoriesService.restore(id, this.viewerOf(req));
  }

  /**
   * 永久删除记忆（真硬删，不可恢复；仅记忆 tab / 管理页人工确认触发）。
   * POST /api/v1/memories/:id/purge → 200 已删除的条目；不存在 → 404 MEMORY_NOT_FOUND。
   */
  @Post(':id/purge')
  @ApiOperation({
    summary: '永久删除记忆（硬删，不可恢复；团队行=团队成员，全局行=管理员）',
  })
  purge(@Param('id') id: string, @Req() req: Request) {
    return this.memoriesService.purge(id, this.viewerOf(req));
  }

  /** 全局 JwtAuthGuard 填充的 request.user → service 调用方上下文（无 viewer 时按 fail closed 处理）。 */
  private viewerOf(req: Request) {
    const user = req.user as { id?: string } | undefined;
    return user?.id ? { id: user.id } : undefined;
  }
}
