import {
  BadRequestException,
  Body,
  Controller,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionGuard } from '../common/guards/permission.guard';
import { TeamMembershipGuard } from '../common/guards/team-membership.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { INTEGRATIONS_ERRORS as MSG_ERRORS } from '../message-channels/message-channel.constants';
import { BindMessageChannelsDto } from './dto/bind-message-channels.dto';

function maskSecrets(
  secrets: Record<string, any> | null | undefined,
): Record<string, string> {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    return {};
  }
  return Object.keys(secrets as Record<string, unknown>).reduce(
    (acc, k) => ({ ...acc, [k]: '***' }),
    {} as Record<string, string>,
  );
}

function maskChannel(row: any): any {
  return {
    ...row,
    secrets: maskSecrets(row.secrets as Record<string, any> | null),
  };
}

@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(TeamMembershipGuard)
@Controller('tasks/:taskId')
export class TaskChannelBindingsController {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- message channels binding ----------

  @Get('message-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '获取任务绑定的消息渠道列表' })
  async listMessageChannels(@Param('taskId') taskId: string): Promise<any[]> {
    const task = await (this.prisma as any).task.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: `task ${taskId} not found`,
      });
    }
    const links = await (this.prisma as any).taskMessageChannel.findMany({
      where: { taskId },
      select: { messageChannelId: true },
    });
    const ids = links.map((l: any) => l.messageChannelId);
    if (ids.length === 0) return [];
    const channels = await (this.prisma as any).messageChannel.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'desc' },
    });
    return (channels as any[]).map(maskChannel);
  }

  @Post('message-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '绑定消息渠道到任务（replace-all）' })
  async bindMessageChannels(
    @Param('taskId') taskId: string,
    @Body() dto: BindMessageChannelsDto,
  ): Promise<{ taskId: string; messageChannelIds: string[] }> {
    const task = await (this.prisma as any).task.findUnique({
      where: { id: taskId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: `task ${taskId} not found`,
      });
    }
    const ids = dto.messageChannelIds ?? [];
    if (!Array.isArray(ids)) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'messageChannelIds must be array',
      });
    }
    // Validate existence if non-empty
    if (ids.length > 0) {
      const unique = [...new Set(ids)];
      if (unique.length !== ids.length) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'duplicate channel ids',
        });
      }
      const existing = await (this.prisma as any).messageChannel.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      const found = new Set((existing as any[]).map((r: any) => r.id));
      const missing = ids.filter((i: string) => !found.has(i));
      if (missing.length > 0) {
        throw new BadRequestException({
          code: MSG_ERRORS.CHANNEL_NOT_FOUND,
          message: `channels not found: ${missing.join(', ')}`,
        });
      }
    }

    // replace-all: delete existing for taskId then create many
    await (this.prisma as any).taskMessageChannel.deleteMany({
      where: { taskId },
    });
    if (ids.length > 0) {
      await (this.prisma as any).taskMessageChannel.createMany({
        data: ids.map((mid: string) => ({
          taskId,
          messageChannelId: mid,
        })),
        skipDuplicates: true,
      });
    }
    return { taskId, messageChannelIds: ids };
  }

  // ---------- notification channels binding（M8 已下线） ----------

  @Get('notification-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '任务级通知绑定已下线（通知渠道改绑团队/成员）' })
  listNotificationChannels(@Param('taskId') taskId: string): never {
    void taskId;
    throw new GoneException({
      code: 'TASK_NOTIFICATION_BINDING_REMOVED',
      message:
        '任务级通知渠道绑定已下线：通知渠道现在只能绑定到团队或成员（成员库/团队详情）',
    });
  }

  @Post('notification-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '任务级通知绑定已下线（通知渠道改绑团队/成员）' })
  bindNotificationChannels(@Param('taskId') taskId: string): never {
    void taskId;
    throw new GoneException({
      code: 'TASK_NOTIFICATION_BINDING_REMOVED',
      message:
        '任务级通知渠道绑定已下线：通知渠道现在只能绑定到团队或成员（成员库/团队详情）',
    });
  }
}
