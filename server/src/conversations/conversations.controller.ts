import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ConversationsService } from './conversations.service';
import { QueryConversationsDto } from './dto/query-conversations.dto';

/**
 * 会话聚合端点（P2）：微信式左列表的唯一数据源。
 * 可见性 = 调用者 team_user_members 的团队；不返回无权团队的存在性。
 */
@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('chats.view')
  @ApiOperation({ summary: '会话列表（群聊 + 成员私聊，含摘要/未读/置顶）' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: QueryConversationsDto,
  ) {
    return this.conversationsService.list(user.id, query);
  }
}
