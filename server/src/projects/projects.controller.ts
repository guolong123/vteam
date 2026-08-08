import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './current-user.decorator';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';

/**
 * 项目端点（FR-25 项目生命周期，基础版）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/projects。
 * 认证依赖全局 JwtAuthGuard（req.user 来自 JWT），不再使用 x-user-id 占位守卫。
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  /**
   * 调用者所属项目列表（成员仅见已加入），分页。
   * GET /api/v1/projects
   */
  @Get()
  @ApiOperation({ summary: '调用者所属项目列表（分页，成员仅见已加入）' })
  findAll(
    @CurrentUser() user: { id: string },
    @Query() query: QueryProjectsDto,
  ) {
    return this.projectsService.findAll(user.id, query);
  }

  /**
   * 创建项目：创建者即 owner，并落 project_members owner 记录。
   * POST /api/v1/projects → 201 + 项目对象（status=active）
   */
  @Post()
  @ApiOperation({ summary: '创建项目（创建者为主人 owner）' })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(user.id, dto);
  }
}
