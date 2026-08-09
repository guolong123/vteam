import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UseGuards } from '@nestjs/common';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ArtifactsService } from './artifacts.service';
import { CreateArtifactDto, QueryArtifactsDto } from './dto/artifact.dto';

/**
 * 产出物端点（09 篇 §3.6 Artifacts / 12 篇 §6 文档库）。
 *
 * 全局前缀 /api/v1（main.ts 已设置），实际路由为 /api/v1/tasks/:id/artifacts。
 * 产出物自动归档主路径走事件驱动（artifact.submitted → onArtifactSubmitted），
 * POST /tasks/:id/artifacts 仅为成员/主 Agent 手动补充提交的旁路（P1，12 篇 §5.3）。
 * 叠加 PermissionGuard（CONF-02 方案②补齐矩阵守卫）：读端点 artifacts.view，
 * 旁路补充提交 artifacts.create——任务成员可见性由 TasksService 路由反查 + 09 §3.6
 * service 层校验，矩阵权限点在成员之上生效。
 */
@ApiTags('artifacts')
@ApiBearerAuth()
@Controller()
export class ArtifactsController {
  constructor(private readonly artifactsService: ArtifactsService) {}

  /**
   * 任务文档库列表（12 篇 §6.1 FR-44）。
   * GET /api/v1/tasks/:id/artifacts?type=&accepted=&page=&pageSize=
   *   → 200 {items: [{id, taskId, type, title, currentVersion, acceptedFlag,
   *                   authorAgentId, createdAt, updatedAt}], total, page, pageSize}
   */
  @Get('tasks/:id/artifacts')
  @UseGuards(PermissionGuard)
  @RequirePermission('artifacts.view')
  @ApiOperation({ summary: '任务产出物列表（分页 + type/accepted 筛选）' })
  findByTask(@Param('id') id: string, @Query() query: QueryArtifactsDto) {
    return this.artifactsService.findByTask(id, query);
  }

  /**
   * 产出物详情 + 全版本列表（12 篇 §6.2 FR-45）。
   * GET /api/v1/artifacts/:id → 200 详情；不存在 → 404 `ARTIFACT_NOT_FOUND`
   */
  @Get('artifacts/:id')
  @UseGuards(PermissionGuard)
  @RequirePermission('artifacts.view')
  @ApiOperation({ summary: '产出物详情 + 版本列表' })
  findOne(@Param('id') id: string) {
    return this.artifactsService.findOne(id);
  }

  /**
   * 指定版本内容（12 篇 §6.2 FR-45）。
   * GET /api/v1/artifacts/:id/versions/:version → 200 ArtifactVersionDto；
   * 不存在 → 404 `ARTIFACT_VERSION_NOT_FOUND`；version 非整数 → 400
   */
  @Get('artifacts/:id/versions/:version')
  @UseGuards(PermissionGuard)
  @RequirePermission('artifacts.view')
  @ApiOperation({ summary: '产出物指定版本详情' })
  findVersion(
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.artifactsService.findVersion(id, version);
  }

  /**
   * 旁路手动补充提交（09 篇 §3.6 P1，12 篇 §5.3）。
   * POST /api/v1/tasks/:id/artifacts body {type,title,content?,fileRef?}
   *   → 201 {status: 'archived'|'duplicate', artifact}；非法声明 → 400
   *   `ARTIFACT_INVALID_DECLARATION`（回退普通消息语义）
   */
  @Post('tasks/:id/artifacts')
  @UseGuards(PermissionGuard)
  @RequirePermission('artifacts.create')
  @ApiOperation({ summary: '手动补充提交产出物（旁路，append 新版本）' })
  append(@Param('id') id: string, @Body() dto: CreateArtifactDto) {
    return this.artifactsService.append(id, {
      taskId: id,
      type: dto.type,
      title: dto.title,
      content: dto.content ?? '',
      fileRef: dto.fileRef,
    });
  }
}
