import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../projects/current-user.decorator';
import { AdminGuard } from '../users/admin.guard';
import { CreateGitRepoDto } from './dto/create-git-repo.dto';
import { UpdateGitRepoDto } from './dto/update-git-repo.dto';
import { GitReposService } from './git-repos.service';

/**
 * 仓库凭证管理端点（17 篇《仓库权限与凭证机制》B 方案，仿 models 模块权限模式）。
 * 全局 JwtAuthGuard（APP_GUARD）已鉴权：
 * - GET（成员只读，不挂守卫）——仓库列表/授权状态只读可见；
 * - POST/PATCH/DELETE（写操作）挂 AdminGuard——判定 permissions.all 或
 *   permissions.users.manage（仿 models.controller.ts 用法，不扩展 PermissionGuard 矩阵）。
 * 全局前缀 /api/v1（main.ts 已设置），实际路由 /api/v1/git-repos。
 */
@ApiTags('git-repos')
@ApiBearerAuth()
@Controller('git-repos')
export class GitReposController {
  constructor(private readonly gitReposService: GitReposService) {}

  /**
   * 仓库凭证列表（未吊销 + 授权 agents，成员只读）。
   * GET /api/v1/git-repos → 200 + Array<GitRepoView>（脱敏，无 key 明文）。
   */
  @Get()
  @ApiOperation({ summary: '仓库凭证列表（未吊销 + 授权 agents，成员只读）' })
  findAll() {
    return this.gitReposService.findAll();
  }

  /**
   * 创建仓库凭证 + 授权（AdminGuard）。
   * POST /api/v1/git-repos {repoUrl, authType, key, grantedAgents?} → 201 + 脱敏 View
   *   repoUrl+authType 撞未吊销唯一 → 409 REPO_EXISTS；authType 非法 → 400；
   *   授权 agent 不存在 → 400 GRANT_INVALID；保存后按 worker 活跃 agent 过滤下发。
   */
  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: '创建仓库凭证（AES-256-GCM 加密存储 + 授权，AdminGuard）',
  })
  create(
    @Body() dto: CreateGitRepoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.gitReposService.create(dto, user.id);
  }

  /**
   * 更新仓库凭证/授权（部分更新，AdminGuard）。
   * PATCH /api/v1/git-repos/:id {key?, grantedAgents?} → 200 + 脱敏 View
   *   key → 重加密覆盖；grantedAgents → 全量覆盖授权；不存在/已吊销 → 404。
   */
  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '更新仓库凭证/授权（部分更新，AdminGuard）' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateGitRepoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.gitReposService.update(id, dto, user.id);
  }

  /**
   * 软撤销仓库凭证 + 该仓库全部授权（AdminGuard）。
   * DELETE /api/v1/git-repos/:id → 200 + {id, revokedAt}；不存在/已吊销 → 404。
   */
  @Delete(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '软撤销仓库凭证（+ 该仓库全部授权，AdminGuard）' })
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.gitReposService.remove(id, user.id);
  }
}
