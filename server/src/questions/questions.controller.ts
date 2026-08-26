import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../projects/current-user.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import { QuestionsService } from './questions.service';

/**
 * 模型提问 / 工具权限确认端点（会话页弹窗 + 补拉数据源）。
 * - GET /questions?taskId=&status=pending：成员只读（chats.view，对齐群聊域权限矩阵），刷新/进入页面补拉弹窗；
 * - POST /questions/:id/reply：成员回复（chats.edit，member 矩阵已预置），question=answers / permission=response。
 * 全局 JwtAuthGuard（APP_GUARD）已鉴权，方法级挂 PermissionGuard + RequirePermission。
 * 全局前缀 /api/v1（main.ts 已设置），实际路由 /api/v1/questions。
 */
@ApiTags('questions')
@ApiBearerAuth()
@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  /** GET /api/v1/questions?taskId=&status=pending → 200 + Array<AgentQuestionDto>（会话页补拉）。 */
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('chats.view')
  @ApiOperation({
    summary: 'Agent 提问/权限确认列表（按 taskId/status 过滤，会话页补拉）',
  })
  findAll(@Query('taskId') taskId?: string, @Query('status') status?: string) {
    return this.questionsService.findAll({ taskId, status });
  }

  /**
   * POST /api/v1/questions/:id/reply → 200 + 更新后 DTO。
   * question：{answers: string[][] | null}（null=拒绝）；permission：{response: once|always|reject}。
   */
  @Post(':id/reply')
  @UseGuards(PermissionGuard)
  @RequirePermission('chats.edit')
  @ApiOperation({
    summary:
      '回复 Agent 提问/权限确认（question=answers / permission=response）',
  })
  reply(
    @Param('id') id: string,
    @Body() dto: ReplyQuestionDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.questionsService.reply(id, dto, user?.id);
  }
}
