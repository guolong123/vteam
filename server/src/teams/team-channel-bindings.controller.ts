import {
  BadRequestException,
  Body,
  ConflictException,
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

/** 渠道→团队的绑定独占性检查结果（供 message / notification 两条绑定路径复用）。 */
interface ExclusiveBindingConflict {
  channelId: string;
  teamIds: string[];
  teamNames: string[];
}

/**
 * 找出「已被其他团队绑定」的渠道。
 *
 * 渠道是**独占**资源：入站时 `message-inbound.service.ts` 对该渠道绑定的每个 teamId
 * 循环写一次群消息 + 派发一次会话。同一渠道绑两个团队 ⇒ 同一条外部消息在两个群各触发
 * 一次，两个团队的 PM 各回一次（生产实测：企微通道同时绑开发团队与运维群，每条消息
 * 产生成对消息 id、两个 project_manager 会话同时回复）。
 *
 * 缺省不静默抢占：抛 409 让前端弹确认框，用户确认后带 `replaceExisting=true` 重提。
 */
async function findExclusiveBindingConflicts(
  prisma: PrismaService,
  teamId: string,
  linkTable: 'teamMessageChannel' | 'teamNotificationChannel',
  channelIds: string[],
): Promise<ExclusiveBindingConflict[]> {
  if (channelIds.length === 0) return [];
  const model = (prisma as any)[linkTable];
  const links = await model.findMany({
    where: { messageChannelId: { in: channelIds }, teamId: { not: teamId } },
    select: { messageChannelId: true, teamId: true },
  });
  const byChannel = new Map<string, Set<string>>();
  for (const l of links as Array<{
    messageChannelId: string;
    teamId: string;
  }>) {
    if (!byChannel.has(l.messageChannelId))
      byChannel.set(l.messageChannelId, new Set());
    byChannel.get(l.messageChannelId)!.add(l.teamId);
  }
  if (byChannel.size === 0) return [];

  const allTeamIds = [
    ...new Set([...byChannel.values()].flatMap((s) => [...s])),
  ];
  const teams = await (prisma as any).team.findMany({
    where: { id: { in: allTeamIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(
    (teams as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]),
  );

  return [...byChannel.entries()]
    .map(([channelId, teamIds]) => {
      const ids = [...teamIds];
      return {
        channelId,
        teamIds: ids,
        teamNames: ids.map((id) => nameById.get(id) ?? id),
      };
    })
    .sort((a, b) => a.channelId.localeCompare(b.channelId));
}

/** 抢占：先解除这些渠道在其他团队上的绑定（独占语义）。 */
async function releaseConflictingBindings(
  prisma: PrismaService,
  linkTable: 'teamMessageChannel' | 'teamNotificationChannel',
  channelIdField: 'messageChannelId' | 'notificationChannelId',
  conflicts: ExclusiveBindingConflict[],
  keepTeamId: string,
): Promise<void> {
  if (conflicts.length === 0) return;
  await (prisma as any)[linkTable].deleteMany({
    where: {
      [channelIdField]: { in: conflicts.map((c) => c.channelId) },
      teamId: { not: keepTeamId },
    },
  });
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

    const conflicts = await findExclusiveBindingConflicts(
      this.prisma,
      teamId,
      'teamMessageChannel',
      ids,
    );
    if (conflicts.length > 0 && dto.replaceExisting !== true) {
      throw new ConflictException({
        code: 'CHANNEL_ALREADY_BOUND',
        message:
          '渠道已被其他团队绑定，重新绑定将取消原有群聊绑定（同一条外部消息会在每个绑定团队各触发一次会话）',
        details: { conflicts },
      });
    }
    await releaseConflictingBindings(
      this.prisma,
      'teamMessageChannel',
      'messageChannelId',
      conflicts,
      teamId,
    );

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

    const conflicts = await findExclusiveBindingConflicts(
      this.prisma,
      teamId,
      'teamNotificationChannel',
      ids,
    );
    if (conflicts.length > 0 && dto.replaceExisting !== true) {
      throw new ConflictException({
        code: 'CHANNEL_ALREADY_BOUND',
        message: '通知渠道已被其他团队绑定，重新绑定将取消原有绑定',
        details: { conflicts },
      });
    }
    await releaseConflictingBindings(
      this.prisma,
      'teamNotificationChannel',
      'notificationChannelId',
      conflicts,
      teamId,
    );

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
