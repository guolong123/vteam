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
import { BindMemberMessageChannelsDto } from './dto/bind-member-message-channels.dto';

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

/**
 * 入站消息渠道 → **成员** 绑定（2026-11-13 用户需求）。
 *
 * 背景：此前渠道只能绑团队（`POST /teams/:teamId/message-channels`），企微消息
 * 统一进团队群聊。用户需要「消息直达某个成员」：绑定到**人**之后，入站消息
 * 投递到该成员的私聊（全局一条 DM，与团队无关）并触发其执行。
 *
 * 为什么按人而不是按席位：用户心智是「发给这个人」，不关心他在哪个团队；
 * 线上存在一个成员在 3 个团队都有席位的场景，按席位绑会产生选错团队的歧义。
 *
 * 渠道是**独占**资源：同一渠道只能绑定「一个团队」或「一个成员」之一，
 * 冲突缺省 409（前端弹确认），`replaceExisting=true` 时先解绑再绑。
 */
@ApiTags('teams')
@ApiBearerAuth()
@UseGuards(TeamMembershipGuard)
@Controller('members/:memberId')
export class MemberChannelBindingsController {
  constructor(private readonly prisma: PrismaService) {}

  /** 校验成员存在。 */
  private async requireMember(memberId: string): Promise<{ id: string }> {
    const member = await (this.prisma as any).member.findUnique({
      where: { id: memberId },
      select: { id: true },
    });
    if (!member) {
      throw new NotFoundException({
        code: 'MEMBER_NOT_FOUND',
        message: `成员 ${memberId} 不存在`,
      });
    }
    return { id: member.id };
  }

  @Get('message-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '获取成员绑定的消息渠道列表' })
  async listMessageChannels(
    @Param('memberId') memberId: string,
  ): Promise<any[]> {
    await this.requireMember(memberId);
    const links = await (this.prisma as any).memberMessageChannel.findMany({
      where: { memberId },
      select: { messageChannelId: true },
    });
    const ids = links.map((l: any) => l.messageChannelId);
    if (ids.length === 0) return [];
    const channels = await (this.prisma as any).messageChannel.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: 'desc' },
    });
    return (channels as any[]).map((c) => ({
      ...c,
      secrets: maskSecrets(c.secrets),
    }));
  }

  @Post('message-channels')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({
    summary: '绑定消息渠道到成员（replace-all；消息直达该成员私聊）',
  })
  async bindMessageChannels(
    @Param('memberId') memberId: string,
    @Body() dto: BindMemberMessageChannelsDto,
  ): Promise<{ memberId: string; messageChannelIds: string[] }> {
    await this.requireMember(memberId);
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

    // 独占校验：渠道不得同时绑定团队或其他成员
    const teamConflicts = await (
      this.prisma as any
    ).teamMessageChannel.findMany({
      where: { messageChannelId: { in: ids } },
      select: { messageChannelId: true, teamId: true },
    });
    const memberConflicts = await (
      this.prisma as any
    ).memberMessageChannel.findMany({
      where: { messageChannelId: { in: ids }, memberId: { not: memberId } },
      select: { messageChannelId: true, memberId: true },
    });
    const hasConflict = teamConflicts.length > 0 || memberConflicts.length > 0;
    if (hasConflict && dto.replaceExisting !== true) {
      throw new ConflictException({
        code: 'CHANNEL_ALREADY_BOUND',
        message:
          '渠道已被其他团队或成员绑定；重新绑定会解除原有绑定（该渠道的入站消息此后直达本成员）',
        details: {
          teamBindings: teamConflicts,
          memberBindings: memberConflicts,
        },
      });
    }
    if (dto.replaceExisting === true && hasConflict) {
      await (this.prisma as any).teamMessageChannel.deleteMany({
        where: { messageChannelId: { in: ids } },
      });
      await (this.prisma as any).memberMessageChannel.deleteMany({
        where: { messageChannelId: { in: ids }, memberId: { not: memberId } },
      });
    }

    await (this.prisma as any).memberMessageChannel.deleteMany({
      where: { memberId },
    });
    if (ids.length > 0) {
      await (this.prisma as any).memberMessageChannel.createMany({
        data: ids.map((mid: string) => ({
          memberId,
          messageChannelId: mid,
        })),
        skipDuplicates: true,
      });
    }
    return { memberId, messageChannelIds: ids };
  }
}
