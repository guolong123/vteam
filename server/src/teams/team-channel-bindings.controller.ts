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
import { TeamMembershipGuard } from '../common/guards/team-membership.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { INTEGRATIONS_ERRORS as MSG_ERRORS } from '../message-channels/message-channel.constants';
import { INTEGRATIONS_ERRORS as NOTIF_ERRORS } from '../notifications/notification.constants';
import {
  BindTeamMessageChannelsDto,
  BindTeamNotificationChannelsDto,
} from './dto/bind-team-channels.dto';

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

@ApiTags('teams')
@ApiBearerAuth()
@UseGuards(TeamMembershipGuard)
@Controller('teams/:teamId')
export class TeamChannelBindingsController {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- message channels binding ----------

  @Get('message-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '获取团队绑定的消息渠道列表' })
  async listMessageChannels(@Param('teamId') teamId: string): Promise<any[]> {
    const team = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw new NotFoundException({
        code: 'TEAM_NOT_FOUND',
        message: `team ${teamId} not found`,
      });
    }
    const links = await (this.prisma as any).teamMessageChannel.findMany({
      where: { teamId },
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
  @ApiOperation({ summary: '绑定消息渠道到团队（replace-all）' })
  async bindMessageChannels(
    @Param('teamId') teamId: string,
    @Body() dto: BindTeamMessageChannelsDto,
  ): Promise<{ teamId: string; messageChannelIds: string[] }> {
    const team = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw new NotFoundException({
        code: 'TEAM_NOT_FOUND',
        message: `team ${teamId} not found`,
      });
    }
    const ids = dto.messageChannelIds ?? [];
    if (!Array.isArray(ids)) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'messageChannelIds must be array',
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

    await (this.prisma as any).teamMessageChannel.deleteMany({
      where: { teamId },
    });
    if (ids.length > 0) {
      await (this.prisma as any).teamMessageChannel.createMany({
        data: ids.map((mid: string) => ({
          teamId,
          messageChannelId: mid,
        })),
        skipDuplicates: true,
      });
    }
    return { teamId, messageChannelIds: ids };
  }

  // ---------- notification channels binding ----------

  @Get('notification-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '获取团队绑定的通知渠道列表' })
  async listNotificationChannels(
    @Param('teamId') teamId: string,
  ): Promise<any[]> {
    const team = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw new NotFoundException({
        code: 'TEAM_NOT_FOUND',
        message: `team ${teamId} not found`,
      });
    }
    const links = await (this.prisma as any).teamNotificationChannel.findMany({
      where: { teamId },
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
  @ApiOperation({ summary: '绑定通知渠道到团队（replace-all）' })
  async bindNotificationChannels(
    @Param('teamId') teamId: string,
    @Body() dto: BindTeamNotificationChannelsDto,
  ): Promise<{ teamId: string; notificationChannelIds: string[] }> {
    const team = await (this.prisma as any).team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw new NotFoundException({
        code: 'TEAM_NOT_FOUND',
        message: `team ${teamId} not found`,
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

    await (this.prisma as any).teamNotificationChannel.deleteMany({
      where: { teamId },
    });
    if (ids.length > 0) {
      await (this.prisma as any).teamNotificationChannel.createMany({
        data: ids.map((nid: string) => ({
          teamId,
          notificationChannelId: nid,
        })),
        skipDuplicates: true,
      });
    }
    return { teamId, notificationChannelIds: ids };
  }
}
