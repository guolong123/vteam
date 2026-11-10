import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import {
  QueryExternalUserMessagesDto,
  QueryExternalUsersDto,
} from './dto/query-external-users.dto';
import { UpdateExternalUserDto } from './dto/update-external-user.dto';
import { ExternalUsersService } from './external-users.service';

/**
 * 外部渠道用户目录端点（契约 §2，全局前缀 /api/v1）。
 *
 * 权限复用聊天域矩阵（不新增权限资源，契约 §0）：
 * - 读（列表/详情/消息回看）：chats.view；
 * - 维护资料：chats.edit。
 *
 * 可见性在 service 内按调用者 team_user_members 团队过滤；不可见一律 404
 * EXTERNAL_USER_NOT_FOUND（不暴露存在性）。
 */
@ApiTags('external-users')
@ApiBearerAuth()
@Controller('external-users')
export class ExternalUsersController {
  constructor(private readonly externalUsersService: ExternalUsersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('chats.view')
  @ApiOperation({ summary: '外部用户列表（关键字 + 分页，按最近发言倒序）' })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryExternalUsersDto,
  ) {
    return this.externalUsersService.list(user.id, query);
  }

  @Get(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('chats.view')
  @ApiOperation({ summary: '外部用户详情（含群聊分布）' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.externalUsersService.findOne(user.id, id);
  }

  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('chats.edit')
  @ApiOperation({ summary: '更新外部用户资料（姓名/岗位/公司/联系方式）' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateExternalUserDto,
  ) {
    return this.externalUsersService.update(user.id, id, dto);
  }

  @Get(':id/messages')
  @UseGuards(PermissionGuard)
  @RequirePermission('chats.view')
  @ApiOperation({ summary: '外部用户消息回看（游标分页，时间正序）' })
  findMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: QueryExternalUserMessagesDto,
  ) {
    return this.externalUsersService.listMessages(user.id, id, query);
  }
}
