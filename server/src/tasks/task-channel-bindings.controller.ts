import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ProjectMembershipGuard } from '../common/guards/project-membership.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { INTEGRATIONS_ERRORS as MSG_ERRORS } from '../message-channels/message-channel.constants';
import { INTEGRATIONS_ERRORS as NOTIF_ERRORS } from '../notifications/notification.constants';
import {
  BindMessageChannelsDto,
  BindNotificationChannelsDto,
} from './dto/bind-message-channels.dto';

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
@UseGuards(ProjectMembershipGuard)
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

  // ---------- notification channels binding ----------

  @Get('notification-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '获取任务绑定的通知渠道列表' })
  async listNotificationChannels(
    @Param('taskId') taskId: string,
  ): Promise<any[]> {
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
    const links = await (this.prisma as any).taskNotificationChannel.findMany({
      where: { taskId },
      select: { notificationChannelId: true },
    });
    const ids = links.map((l: any) => l.notificationChannelId);
    if (ids.length === 0) return [];
    const channels = await (this.prisma as any).notificationChannel.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'desc' },
    });
    return (channels as any[]).map(maskChannel);
  }

  @Post('notification-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '绑定通知渠道到任务（replace-all）' })
  async bindNotificationChannels(
    @Param('taskId') taskId: string,
    @Body() dto: BindNotificationChannelsDto,
  ): Promise<{ taskId: string; notificationChannelIds: string[] }> {
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
    const ids = dto.notificationChannelIds ?? [];
    if (!Array.isArray(ids)) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'notificationChannelIds must be array',
      });
    }
    if (ids.length > 0) {
      const unique = [...new Set(ids)];
      if (unique.length !== ids.length) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'duplicate channel ids',
        });
      }
      const existing = await (this.prisma as any).notificationChannel.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      const found = new Set((existing as any[]).map((r: any) => r.id));
      const missing = ids.filter((i: string) => !found.has(i));
      if (missing.length > 0) {
        throw new BadRequestException({
          code: NOTIF_ERRORS.CHANNEL_NOT_FOUND,
          message: `channels not found: ${missing.join(', ')}`,
        });
      }
    }

    await (this.prisma as any).taskNotificationChannel.deleteMany({
      where: { taskId },
    });
    if (ids.length > 0) {
      await (this.prisma as any).taskNotificationChannel.createMany({
        data: ids.map((nid: string) => ({
          taskId,
          notificationChannelId: nid,
        })),
        skipDuplicates: true,
      });
    }
    return { taskId, notificationChannelIds: ids };
  }
}
