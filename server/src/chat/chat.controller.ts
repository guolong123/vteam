import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../projects/current-user.decorator';
import { ChatService } from './chat.service';
import { CreateDmChannelDto } from './dto/create-dm-channel.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { QueryMessagesDto } from './dto/query-messages.dto';

/**
 * 群聊端点（09 篇 §3.5 Chat，全局前缀 /api/v1）。
 *
 * 权限在 ChatService 层校验（channel → taskId → projectId → project_members）：
 * 路由参数是 :id（频道 id）非 :pid，且 POST /dm-channels 无资源路径参数，
 * ProjectMembershipGuard 的 :id 反查仅面向任务路由，故不适用本模块。
 * 调用者身份经全局 JwtAuthGuard 挂载的 req.user（@CurrentUser()）获取。
 */
@ApiTags('chat')
@ApiBearerAuth()
@Controller()
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * 可访问频道列表（任务群聊自动创建 + 私聊）。
   * GET /api/v1/channels?type=task_group|private → {items, total}
   */
  @Get('channels')
  @ApiOperation({ summary: '可访问频道列表（task_group + private，type 过滤）' })
  @ApiQuery({
    name: 'type',
    required: false,
    description: '频道类型过滤：task_group | private',
  })
  findChannels(
    @CurrentUser() user: AuthenticatedUser,
    @Query('type') type?: string,
  ) {
    return this.chatService.findAccessibleChannels(user.id, type);
  }

  /**
   * 频道信息（类型/关联任务/成员 Agent）。
   * GET /api/v1/channels/:id
   */
  @Get('channels/:id')
  @ApiOperation({ summary: '频道详情（类型/关联任务/成员 Agent）' })
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.chatService.findOne(id, user.id);
  }

  /**
   * 历史消息游标分页。
   * GET /api/v1/channels/:id/messages?cursor=&limit= → {items, nextCursor}
   */
  @Get('channels/:id/messages')
  @ApiOperation({ summary: '历史消息游标分页（游标=消息主键 id，id 升序）' })
  findMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query() query: QueryMessagesDto,
  ) {
    return this.chatService.findMessages(id, user.id, query);
  }

  /**
   * @ 触发结果轮询（前端 SSE 兜底）。
   * GET /api/v1/channels/:id/trigger-results/:messageId → {triggers:[{agentId,status,replyMessageId?}]}
   */
  @Get('channels/:id/trigger-results/:messageId')
  @ApiOperation({ summary: '@ 触发结果轮询（被触发 Agent、dispatch 状态、回复消息 id）' })
  getTriggerResults(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ) {
    return this.chatService.getTriggerResults(id, user.id, messageId);
  }

  /**
   * 发消息（8 步流程：权限→@解析→落库→广播→分派→上下文→Loading→收敛）。
   * POST /api/v1/channels/:id/messages → 201 + {message, triggers[]}
   */
  @Post('channels/:id/messages')
  @HttpCode(201)
  @ApiOperation({ summary: '发消息 + @ 触发（8 步流程，返回 {message, triggers}）' })
  createMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
  ) {
    return this.chatService.createMessage(id, user.id, dto);
  }

  /**
   * 创建 private 私聊频道（FR-14，与群聊共用该 Agent 会话）。
   * POST /api/v1/dm-channels → 201 + 频道对象（重复创建幂等返回已有）
   */
  @Post('dm-channels')
  @HttpCode(201)
  @ApiOperation({ summary: '创建私聊频道（type=private，重复创建幂等返回已有）' })
  createDmChannel(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDmChannelDto,
  ) {
    return this.chatService.createDmChannel(user.id, dto);
  }
}
