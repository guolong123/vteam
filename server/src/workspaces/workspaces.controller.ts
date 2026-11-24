import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PLATFORM_PERMISSIONS } from '../common/constants/platform-permissions.constants';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto';
import { RelocateResourceDto } from './dto/relocate-resource.dto';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspacesService } from './workspaces.service';

/**
 * 工作空间管理端点（M1）。
 *
 * - GET    /workspaces                     我的空间列表（含隐式可读的系统空间）
 * - POST   /workspaces                     创建空间（调用者为 owner）
 * - GET    /workspaces/:id/members         成员列表（需可访问）
 * - POST   /workspaces/:id/members         邀请成员（owner/admin）
 * - DELETE /workspaces/:id/members/:userId 移除成员（owner/admin，owner 受保护）
 *
 * 「当前空间」由 JWT 的 wid + 请求头 x-workspace-id 决定（WorkspaceGuard 解析），
 * 切换空间走 `POST /auth/workspace` 重签 token。
 */
@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @ApiOperation({ summary: '我的工作空间列表（含系统空间，标记 isSystem）' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.workspaces.listForUser(user.id);
  }

  @Post()
  @ApiOperation({ summary: '创建工作空间（调用者为 owner）' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.workspaces.createForUser(user.id, dto.name);
  }

  @Post('relocations')
  @UseGuards(PermissionGuard)
  @RequirePermission(PLATFORM_PERMISSIONS.RELOCATE_RESOURCE)
  @ApiOperation({
    summary:
      '资源空间迁移（管理员）：移动到其它空间或系统空间（发布共享/回收），写审计',
  })
  relocate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RelocateResourceDto,
  ) {
    return this.workspaces.relocate(user.id, dto);
  }

  @Get('relocations')
  @UseGuards(PermissionGuard)
  @RequirePermission(PLATFORM_PERMISSIONS.RELOCATE_RESOURCE)
  @ApiOperation({ summary: '资源空间迁移审计列表（管理员，最近优先）' })
  listRelocations(@Query('limit') limit?: string) {
    return this.workspaces.listRelocations(
      limit ? Number.parseInt(limit, 10) || 50 : 50,
    );
  }

  @Get('all')
  @UseGuards(PermissionGuard)
  @RequirePermission(PLATFORM_PERMISSIONS.CROSS_SPACE_READ)
  @ApiOperation({ summary: '全部工作空间列表（管理员：跨空间只读查看/运维）' })
  listAll() {
    return this.workspaces.listAll();
  }

  @Post(':id/worker-token')
  @ApiOperation({
    summary:
      '签发 worker 加入码（owner/admin 或平台管理员）：非默认空间的 worker 注册必须携带',
  })
  issueWorkerToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.workspaces.issueWorkerJoinToken(user.id, id);
  }

  @Get(':id/members')
  @ApiOperation({ summary: '空间成员列表' })
  listMembers(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.workspaces.listMembers(user.id, id);
  }

  @Post(':id/members')
  @ApiOperation({ summary: '邀请成员（owner/admin）' })
  addMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddWorkspaceMemberDto,
  ) {
    return this.workspaces.addMember(user.id, id, dto.userId, dto.role);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({ summary: '移除成员（owner/admin，owner 受保护）' })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.workspaces.removeMember(user.id, id, userId);
  }
}
