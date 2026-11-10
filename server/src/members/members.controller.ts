import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
import { BindMemberNotificationChannelsDto } from './dto/bind-member-notification-channels.dto';
import { CreateMemberDto } from './dto/create-member.dto';
import { QueryMembersDto } from './dto/query-members.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MembersService } from './members.service';

/**
 * 成员库端点（37 篇 §5.1，P0 范围：成员 CRUD + 所在群聊 + 克隆）。
 *
 * 权限：读取 members.view，创建/克隆 members.create，更新 members.edit，
 * 删除 members.delete。成员是平台级资源，不做 TeamMembershipGuard。
 */
@ApiTags('members')
@ApiBearerAuth()
@Controller('members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('members.view')
  @ApiOperation({ summary: '成员库列表（关键字/岗位/状态 + 分页）' })
  findAll(@Query() query: QueryMembersDto) {
    return this.membersService.findAll(query);
  }

  @Get(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('members.view')
  @ApiOperation({ summary: '成员详情（含所在群聊与通知渠道绑定）' })
  findOne(@Param('id') id: string) {
    return this.membersService.findOne(id);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('members.create')
  @ApiOperation({ summary: '创建成员（agentId 缺省取岗位默认 Agent）' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMemberDto) {
    return this.membersService.create(user.id, dto);
  }

  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('members.edit')
  @ApiOperation({ summary: '更新成员（部分字段）' })
  update(@Param('id') id: string, @Body() dto: UpdateMemberDto) {
    return this.membersService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('members.delete')
  @ApiOperation({
    summary:
      '删除成员。默认仍有席位 → 409 MEMBER_IN_USE；cascadeSeats=true 时先移出全部群聊再删除',
  })
  remove(
    @Param('id') id: string,
    @Query('cascadeSeats') cascadeSeats?: string,
  ) {
    return this.membersService.remove(id, {
      cascadeSeats: cascadeSeats === 'true' || cascadeSeats === '1',
    });
  }

  @Get(':id/teams')
  @UseGuards(PermissionGuard)
  @RequirePermission('members.view')
  @ApiOperation({ summary: '成员所在群聊（席位）列表' })
  listTeams(@Param('id') id: string) {
    return this.membersService.listTeams(id);
  }

  @Post(':id/reset-session')
  @UseGuards(PermissionGuard)
  @RequirePermission('members.edit')
  @ApiOperation({ summary: '重置成员全局会话（不动消息/记忆）' })
  resetSession(@Param('id') id: string) {
    return this.membersService.resetSession(id);
  }

  @Get(':id/notification-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '成员已绑定的通知渠道（脱敏）' })
  listNotificationChannels(@Param('id') id: string) {
    return this.membersService.listNotificationChannels(id);
  }

  @Put(':id/notification-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '绑定成员通知渠道（replace-all；默认独占校验）' })
  bindNotificationChannels(
    @Param('id') id: string,
    @Body() dto: BindMemberNotificationChannelsDto,
  ) {
    return this.membersService.bindNotificationChannels(
      id,
      dto.notificationChannelIds ?? [],
      dto.replaceExisting ?? false,
    );
  }

  @Post(':id/clone')
  @UseGuards(PermissionGuard)
  @RequirePermission('members.create')
  @ApiOperation({ summary: '克隆成员（名称自动加 -副本 后缀）' })
  clone(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.membersService.clone(user.id, id);
  }
}
