import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { NotificationRegistryService } from './notification-registry.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationDispatcherService } from './notification-dispatcher.service';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_TYPES,
  INTEGRATIONS_ERRORS,
} from './notification.constants';
import { CreateNotificationChannelDto } from './dto/create-notification-channel.dto';
import { UpdateNotificationChannelDto } from './dto/update-notification-channel.dto';

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

function validateNotificationConfig(
  type: string,
  config: Record<string, any> | null | undefined,
  isCreate: boolean,
): void {
  if (isCreate && (!config || typeof config !== 'object')) {
    throw new BadRequestException({
      code: 'BAD_REQUEST',
      message: 'config is required',
    });
  }
  if (!config) return;

  // events required
  const events = (config as any).events;
  if (events !== undefined) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'config.events is required and must be non-empty array',
      });
    }
    const allowed = Object.values(NOTIFICATION_EVENTS) as string[];
    for (const ev of events) {
      if (!allowed.includes(ev)) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: `invalid event ${ev}, allowed: ${allowed.join(', ')}`,
        });
      }
    }
  } else if (isCreate) {
    throw new BadRequestException({
      code: 'BAD_REQUEST',
      message: 'config.events is required',
    });
  }

  // targetUrl required for webhook type
  if (type === NOTIFICATION_TYPES.webhook) {
    const targetUrl = (config as any).targetUrl;
    if (isCreate) {
      if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'config.targetUrl is required for webhook type',
        });
      }
    } else {
      if (targetUrl !== undefined) {
        if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
          throw new BadRequestException({
            code: 'BAD_REQUEST',
            message: 'config.targetUrl is required for webhook type',
          });
        }
      }
    }
  }
}

@ApiTags('notification-channels')
@ApiBearerAuth()
@Controller('notification-channels')
export class NotificationChannelsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly registry: NotificationRegistryService,
    private readonly deliveries: NotificationDeliveryService,
    private readonly dispatcher: NotificationDispatcherService,
  ) {}

  /** GET /notification-channels — 列表（已登录可见，secrets 掩码） */
  @Get()
  @ApiOperation({ summary: '通知渠道列表（secrets 掩码）' })
  async list(): Promise<any[]> {
    const rows = await (this.prisma as any).notificationChannel.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return (rows as any[]).map(maskChannel);
  }

  /** GET /notification-channels/:id — 详情（掩码） */
  @Get(':id')
  @ApiOperation({ summary: '通知渠道详情（secrets 掩码）' })
  async findOne(@Param('id') id: string): Promise<any> {
    const row = await (this.prisma as any).notificationChannel.findUnique({
      where: { id },
    });
    if (!row) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    return maskChannel(row);
  }

  /** POST /notification-channels — 创建（channels.manage） */
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '创建通知渠道（channels.manage）' })
  async create(@Body() dto: CreateNotificationChannelDto): Promise<any> {
    validateNotificationConfig(dto.type, dto.config as any, true);
    const id = await this.idGen.nextId('nc');
    const row = await (this.prisma as any).notificationChannel.create({
      data: {
        id,
        name: dto.name,
        type: dto.type,
        config: (dto.config ?? {}) as any,
        secrets: (dto.secrets ?? {}) as any,
        enabled: true,
      },
    });
    return maskChannel(row);
  }

  /** PATCH /notification-channels/:id — 更新（合并） */
  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({
    summary: '更新通知渠道（channels.manage，config/secrets 浅合并）',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateNotificationChannelDto,
  ): Promise<any> {
    const existing = await (this.prisma as any).notificationChannel.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }

    const newType = dto.type ?? existing.type;

    const newConfig =
      dto.config !== undefined
        ? {
            ...((existing.config as Record<string, any>) ?? {}),
            ...(dto.config as Record<string, any>),
          }
        : undefined;

    // Validate merged config if type or config changed
    const configToValidate =
      newConfig !== undefined
        ? newConfig
        : (existing.config as Record<string, any>);
    if (dto.type !== undefined || dto.config !== undefined) {
      // For update, if config already exists and no new config, still validate?
      // We validate merged result only if either changed, and require events if present.
      // Use isCreate=false but enforce targetUrl if webhook and events if provided.
      // If create-time required fields missing in merged, also error.
      // So we treat merged as new config and validate webhook requirement.
      const mergedType = newType;
      const mergedConfig =
        newConfig !== undefined ? newConfig : configToValidate;
      // If existing already had events, and we're not changing config, it's okay.
      // But if merged lacks events, we should error only if existing was webhook and events missing.
      // Simpler: if dto.type changed to webhook and existing config lacks targetUrl, require it.
      // We'll validate merged config with isCreate flag false but still check webhook targetUrl if type is webhook.
      if (mergedType === NOTIFICATION_TYPES.webhook) {
        const targetUrl = (mergedConfig as any)?.targetUrl;
        if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
          throw new BadRequestException({
            code: 'BAD_REQUEST',
            message: 'config.targetUrl is required for webhook type',
          });
        }
      }
      if (dto.config !== undefined) {
        validateNotificationConfig(mergedType, mergedConfig as any, false);
        // If events not provided in update but existing had events, allow.
        // But if existing had no events, and update didn't provide, still need events?
        // We'll ensure merged has events array.
        const events = (mergedConfig as any)?.events;
        if (!events || !Array.isArray(events) || events.length === 0) {
          // Only error if we are explicitly trying to leave webhook without events?
          // For strict compliance, require events in merged.
          throw new BadRequestException({
            code: 'BAD_REQUEST',
            message: 'config.events is required and must be non-empty array',
          });
        }
      }
    }

    const newSecrets =
      dto.secrets !== undefined
        ? {
            ...((existing.secrets as Record<string, any>) ?? {}),
            ...(dto.secrets as Record<string, any>),
          }
        : undefined;

    const data: Record<string, any> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.type !== undefined) data.type = dto.type;
    if (newConfig !== undefined) data.config = newConfig;
    if (newSecrets !== undefined) data.secrets = newSecrets;

    if (Object.keys(data).length === 0) {
      return maskChannel(existing);
    }

    const updated = await (this.prisma as any).notificationChannel.update({
      where: { id },
      data,
    });
    return maskChannel(updated);
  }

  /** DELETE /notification-channels/:id — 删除 */
  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '删除通知渠道（channels.manage）' })
  async remove(
    @Param('id') id: string,
  ): Promise<{ deleted: boolean; id: string }> {
    const existing = await (this.prisma as any).notificationChannel.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    await (this.prisma as any).notificationChannel.delete({ where: { id } });
    return { deleted: true, id };
  }

  /** POST /notification-channels/:id/enable — 启用 */
  @Post(':id/enable')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '启用通知渠道（channels.manage）' })
  async enable(@Param('id') id: string): Promise<any> {
    const existing = await (this.prisma as any).notificationChannel.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    const updated = await (this.prisma as any).notificationChannel.update({
      where: { id },
      data: { enabled: true },
    });
    return maskChannel(updated);
  }

  /** POST /notification-channels/:id/disable — 停用 */
  @Post(':id/disable')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '停用通知渠道（channels.manage）' })
  async disable(@Param('id') id: string): Promise<any> {
    const existing = await (this.prisma as any).notificationChannel.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    const updated = await (this.prisma as any).notificationChannel.update({
      where: { id },
      data: { enabled: false },
    });
    return maskChannel(updated);
  }

  /** GET /notification-channels/:id/deliveries — 投递日志游标分页 */
  @Get(':id/deliveries')
  @ApiOperation({ summary: '通知渠道投递日志（游标分页）' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listDeliveries(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: any[]; nextCursor: string | null }> {
    const channel = await (this.prisma as any).notificationChannel.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!channel) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    return this.deliveries.listByChannel(id, {
      cursor: cursor ?? null,
      limit: parsedLimit,
    });
  }

  /** POST /notification-channels/:id/test-send — 测试推送（channels.manage） */
  @Post(':id/test-send')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({
    summary: '测试推送（channels.manage，经 dispatcher）',
  })
  async testSend(@Param('id') id: string): Promise<{ ok: boolean }> {
    const channel = await (this.prisma as any).notificationChannel.findUnique({
      where: { id },
    });
    if (!channel) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    const adapter = this.registry.get(channel.type);
    if (!adapter) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_TYPE_INVALID,
        message: `adapter not found for type ${channel.type}`,
      });
    }
    const resolved = {
      id: channel.id,
      type: channel.type,
      name: channel.name,
      config: (channel.config as Record<string, any>) ?? {},
      secrets: (channel.secrets as Record<string, any>) ?? {},
      enabled: channel.enabled,
      lastStatus: channel.lastStatus ?? null,
      lastError: channel.lastError ?? null,
    };
    // Use adapter directly, log via delivery service similar to dispatcher
    const msg = {
      kind: 'markdown' as const,
      text: '[test] notification channel test',
    };
    try {
      // create pending delivery
      await this.dispatcher.dispatchToChannel(channel, msg);
    } catch (e) {
      // Fallback to direct adapter if dispatcher fails
      try {
        await (adapter as any).sendOutbound(resolved, msg);
      } catch (err) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: (err as Error).message ?? 'test-send failed',
        });
      }
    }
    return { ok: true };
  }
}
