import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TASK_ERRORS } from '../common/constants/task.constants';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import { QuestionsService } from './questions.service';

/**
 * 模型提问 / 工具权限确认端点（会话页弹窗 + 补拉数据源）。
 * - GET /questions?taskId=&status=pending：成员只读（chats.view，对齐群聊域权限矩阵），刷新/进入页面补拉弹窗；
 * - POST /questions/:id/reply：成员回复（chats.edit，member 矩阵已预置），question=answers / permission=response。
 * 全局 JwtAuthGuard（APP_GUARD）已鉴权，方法级挂 PermissionGuard + RequirePermission。
 * 任务归属校验与群聊同链：question/task → taskId → teamId → teamUserMember，
 * 非团队成员读/回任务提问 403 PERMISSION_TEAM_NOT_MEMBER。
 * 全局前缀 /api/v1（main.ts 已设置），实际路由 /api/v1/questions。
 */
@ApiTags('questions')
@ApiBearerAuth()
@Controller('questions')
export class QuestionsController {
  constructor(
    private readonly questionsService: QuestionsService,
    private readonly prisma: PrismaService,
  ) {}

  /** GET /api/v1/questions?taskId=&teamId=&status=pending → 200 + Array<AgentQuestionDto>（会话页补拉）。 */
  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission('chats.view')
  @ApiOperation({
    summary:
      'Agent 提问/权限确认列表（按 taskId/teamId/status 过滤，会话页补拉）',
  })
  async findAll(
    @Query('taskId') taskId?: string,
    @Query('teamId') teamId?: string,
    @Query('status') status?: string,
    @CurrentUser() user?: { id: string },
  ) {
    if (taskId && user?.id) {
      await this.assertTaskMember(taskId, user.id);
    }
    if (teamId && user?.id) {
      await this.assertTeamMember(teamId, user.id);
    }
    return this.questionsService.findAll({ taskId, teamId, status });
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
  async reply(
    @Param('id') id: string,
    @Body() dto: ReplyQuestionDto,
    @CurrentUser() user: { id: string },
  ) {
    if (user?.id) {
      const row = await (this.prisma as any).agentQuestion.findUnique({
        where: { id },
        select: { taskId: true },
      });
      if (row?.taskId) {
        await this.assertTaskMember(row.taskId, user.id);
      }
    }
    return this.questionsService.reply(id, dto, user?.id);
  }

  /** 任务归属团队成员校验：taskId → teamId → teamUserMember，否则 403。 */
  private async assertTaskMember(
    taskId: string,
    userId: string,
  ): Promise<void> {
    const task = await (this.prisma as any).task.findUnique({
      where: { id: taskId },
      select: { teamId: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: TASK_ERRORS.TASK_NOT_FOUND,
        message: '任务不存在',
      });
    }
    const member = await (this.prisma as any).teamUserMember.findUnique({
      where: { teamId_userId: { teamId: task.teamId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException({
        code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该团队成员',
      });
    }
  }

  /** 团队路径成员校验（GET /questions teamId 过滤用）：调用者是该团队成员（403 否则）。 */
  private async assertTeamMember(
    teamId: string,
    userId: string,
  ): Promise<void> {
    const member = await (this.prisma as any).teamUserMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException({
        code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该团队成员',
      });
    }
  }
}
