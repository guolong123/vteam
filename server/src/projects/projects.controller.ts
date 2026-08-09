import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { CurrentUser } from './current-user.decorator';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';

/**
 * 项目端点（FR-25 项目生命周期，基础版）。
 * 全局前缀 /api/v1（main.ts 已设置），故实际路由为 /api/v1/projects。
 * 认证依赖全局 JwtAuthGuard（req.user 来自 JWT），不再使用 x-user-id 占位守卫。
 * 权限矩阵（09 篇 §2.5 POST /projects [admin]（获授权成员可创建））：创建挂
 * projects.create——8 资源矩阵无 projects 域（roles.constants.ts 固定 8 域），
 * 故 admin（all:true）/矩阵显式授权者放行，内置 member（all:false）写操作拒绝。
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
  @UseGuards(PermissionGuard)
  @RequirePermission('projects.create')
  @ApiOperation({ summary: '创建项目（创建者为主人 owner）' })
  create(@CurrentUser() user: { id: string }, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(user.id, dto);
  }
}
