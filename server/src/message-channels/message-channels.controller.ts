import {
  All,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MessageRegistryService } from './message-registry.service';
import { MessageDeliveryService } from './message-delivery.service';
import { MessageInboundService } from './message-inbound.service';
import {
  INTEGRATIONS_ERRORS,
  MESSAGE_CHANNEL_TYPES,
} from './message-channel.constants';
import { CreateMessageChannelDto } from './dto/create-message-channel.dto';
import { UpdateMessageChannelDto } from './dto/update-message-channel.dto';

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

function extractWecomBotId(
  secrets: Record<string, any> | null | undefined,
): string | undefined {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    return undefined;
  }
  const raw = secrets.botId ?? secrets.botID ?? secrets.bot_id;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
}

@ApiTags('message-channels')
@ApiBearerAuth()
@Controller('message-channels')
export class MessageChannelsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    private readonly registry: MessageRegistryService,
    private readonly deliveries: MessageDeliveryService,
    private readonly inboundService: MessageInboundService,
  ) {}

  /** GET /message-channels — 列表（已登录可见，secrets 掩码） */
  @Get()
  @ApiOperation({ summary: '消息渠道列表（secrets 掩码）' })
  async list(): Promise<any[]> {
    const rows = await (this.prisma as any).messageChannel.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return (rows as any[]).map(maskChannel);
  }

  /** GET /message-channels/:id — 详情（掩码） */
  @Get(':id')
  @ApiOperation({ summary: '消息渠道详情（secrets 掩码）' })
  async findOne(@Param('id') id: string): Promise<any> {
    const row = await (this.prisma as any).messageChannel.findUnique({
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

  /**
   * wecom_aibot 独占校验：一个企微机器人只能有一条长连接，WeCom 服务端会把后连的那条
   * 直接踢下线（SDK 收 disconnected_event 后不再重连），表现为渠道永远停在 connecting，
   * 且旧 `clients.has()` skip 判据让它再也拉不起来 —— 生产 mc_2/mc_6 同 botId 事故。
   *
   * 仅当冲突方**已启用**时拒绝：冲突方处于停用态即放行，这正是「先停旧、再启新」的迁移路径。
   * 目标渠道自身将停用（enabled=false）时也放行 —— 停用永远不该被拦。
   *
   * 入参统一是「变更落库**之后**的那一帧状态」（type/secrets/enabled）+ 可选的自身
   * channelId（自身天然不构成冲突，且要传进 where 的 id:not 让查询也排掉它）。
   * create / update / enable 三条入口共用这一个 helper，故「保存态」与「启用态」
   * 不可能漂移：save 侧放行的「目标已启用 + 冲突方停用」这一对，只能靠 disable→enable
   * 迁移成「两条都启用」，而唯一的收敛点就是 enable 这道校验。
   */
  private async assertWecomBotIdAvailable(params: {
    channelId?: string;
    type?: string;
    secrets?: Record<string, any> | null;
    enabled: boolean;
  }): Promise<void> {
    if (!params.enabled) return;
    if (params.type !== MESSAGE_CHANNEL_TYPES.wecom_aibot) return;
    const botId = extractWecomBotId(params.secrets);
    if (!botId) return;
    const rows: any[] =
      (await (this.prisma as any).messageChannel.findMany({
        where: {
          type: MESSAGE_CHANNEL_TYPES.wecom_aibot,
          enabled: true,
          ...(params.channelId ? { id: { not: params.channelId } } : {}),
        },
        select: { id: true, name: true, enabled: true, secrets: true },
      })) ?? [];
    // enabled 与「排除自身」已在 where 里收窄，这里再判一次：规则本身不依赖查询是否忠实
    const conflict = rows.find(
      (r) =>
        r?.id !== params.channelId &&
        r?.enabled !== false &&
        extractWecomBotId(r?.secrets) === botId,
    );
    if (!conflict) return;
    throw new ConflictException({
      code: INTEGRATIONS_ERRORS.CHANNEL_BOTID_DUPLICATE,
      message:
        `botId ${botId} 已被消息渠道「${conflict.name ?? ''}」(${conflict.id}) 占用：` +
        `一个企微机器人只能有一条长连接，请先停用该渠道再启用新的`,
      conflictingChannelId: conflict.id,
      conflictingChannelName: conflict.name ?? null,
    });
  }

  /** POST /message-channels — 创建（channels.manage，无 taskId） — auto-connect if enabled */
  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '创建消息渠道（channels.manage，无 taskId）' })
  async create(@Body() dto: CreateMessageChannelDto): Promise<any> {
    await this.assertWecomBotIdAvailable({
      type: dto.type,
      secrets: (dto.secrets ?? {}) as Record<string, any>,
      // create 恒定 enabled: true
      enabled: true,
    });
    const id = await this.idGen.nextId('mc');
    const row = await (this.prisma as any).messageChannel.create({
      data: {
        id,
        name: dto.name,
        type: dto.type,
        config: (dto.config ?? {}) as any,
        secrets: (dto.secrets ?? {}) as any,
        enabled: true,
      },
    });
    // auto-start adapter for newly created channel (enabled=true by default)
    // mirrors POST :id/enable logic: try adapter.start + startEnabled, never throw to client
    try {
      const adapter: any = this.registry.get(row.type);
      if (adapter && typeof adapter.start === 'function') {
        await adapter.start(this.registry as any).catch(() => {});
      }
    } catch {}
    try {
      await this.registry.startEnabled().catch(() => {});
    } catch {}
    // re-fetch to surface lastStatus/lastError populated by adapter/host
    let fresh: any = row;
    try {
      const found = await (this.prisma as any).messageChannel.findUnique({
        where: { id },
      });
      if (found) fresh = found;
    } catch {}
    return maskChannel(fresh);
  }

  /** PATCH /message-channels/:id — 更新（合并） */
  @Patch(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({
    summary: '更新消息渠道（channels.manage，config/secrets 浅合并）',
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateMessageChannelDto,
  ): Promise<any> {
    const existing = await (this.prisma as any).messageChannel.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }

    const newConfig =
      dto.config !== undefined
        ? {
            ...((existing.config as Record<string, any>) ?? {}),
            ...(dto.config as Record<string, any>),
          }
        : undefined;

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

    // 校验放在空改动早退之前：任何 update 都不得成为绕过 botId 独占校验的后门。
    // dto.secrets 缺省时用库里的旧值参与校验（浅合并语义与 newSecrets 一致）。
    await this.assertWecomBotIdAvailable({
      channelId: id,
      type: (dto.type ?? (existing.type as string)) as string,
      secrets:
        (newSecrets as Record<string, any> | undefined) ??
        (existing.secrets as Record<string, any> | null) ??
        {},
      enabled: existing.enabled !== false,
    });

    const updated = await (this.prisma as any).messageChannel.update({
      where: { id },
      data,
    });
    return maskChannel(updated);
  }

  /** DELETE /message-channels/:id — 删除（先 requestStop） */
  @Delete(':id')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '删除消息渠道（channels.manage，先 requestStop）' })
  async remove(
    @Param('id') id: string,
  ): Promise<{ deleted: boolean; id: string }> {
    const existing = await (this.prisma as any).messageChannel.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    try {
      await this.registry.requestStop(id);
    } catch {}
    await (this.prisma as any).messageChannel.delete({ where: { id } });
    return { deleted: true, id };
  }

  /** POST /message-channels/:id/enable — 启用 */
  @Post(':id/enable')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '启用消息渠道（channels.manage）' })
  async enable(@Param('id') id: string): Promise<any> {
    const existing = await (this.prisma as any).messageChannel.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    // enable 是 save 侧放行的「冲突方已停用」那一对唯一可能双双启用的收敛点，
    // 故此处复用同一 helper、传落库后的那一帧状态（恒 enabled:true）。
    await this.assertWecomBotIdAvailable({
      channelId: id,
      type: (existing.type as string) ?? undefined,
      secrets:
        (existing.secrets as Record<string, any> | null | undefined) ?? {},
      enabled: true,
    });
    const updated = await (this.prisma as any).messageChannel.update({
      where: { id },
      data: { enabled: true },
    });
    try {
      const adapter: any = this.registry.get(updated.type);
      if (adapter && typeof adapter.start === 'function') {
        await adapter.start(this.registry as any).catch(() => {});
      }
    } catch {}
    try {
      await this.registry.startEnabled().catch(() => {});
    } catch {}
    return maskChannel(updated);
  }

  /** POST /message-channels/:id/disable — 停用 */
  @Post(':id/disable')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({ summary: '停用消息渠道（channels.manage）' })
  async disable(@Param('id') id: string): Promise<any> {
    const existing = await (this.prisma as any).messageChannel.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    const updated = await (this.prisma as any).messageChannel.update({
      where: { id },
      data: { enabled: false },
    });
    try {
      await this.registry.requestStop(id);
    } catch {}
    return maskChannel(updated);
  }

  /** GET /message-channels/:id/deliveries — 投递日志游标分页 */
  @Get(':id/deliveries')
  @ApiOperation({ summary: '消息渠道投递日志（游标分页）' })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listDeliveries(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: any[]; nextCursor: string | null }> {
    const channel = await (this.prisma as any).messageChannel.findUnique({
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

  /** POST /message-channels/:id/test-send — 测试（channels.manage） */
  @Post(':id/test-send')
  @UseGuards(PermissionGuard)
  @RequirePermission('channels.manage')
  @ApiOperation({
    summary: '测试消息渠道（channels.manage）',
  })
  async testSend(@Param('id') id: string): Promise<{ ok: boolean }> {
    const channel = await (this.prisma as any).messageChannel.findUnique({
      where: { id },
    });
    if (!channel) {
      throw new NotFoundException({
        code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
        message: `channel ${id} not found`,
      });
    }
    // message channels are inbound-only; test-send is no-op but return ok for compatibility
    return { ok: true };
  }

  /**
   * 入站 webhook（Public）
   * POST /message-channels/:id/inbound — 验签→归一→submitInbound（fan-out via TaskMessageChannel）
   * GET → 405
   */
  @Public()
  @All(':id/inbound')
  async inbound(
    @Param('id') id: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ): Promise<void> {
    if (req.method === 'GET') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    try {
      const channel = await this.registry.getChannel(id);
      if (!channel) {
        throw new NotFoundException({
          code: INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
          message: `channel ${id} not found`,
        });
      }

      if (!channel.enabled) {
        throw new NotFoundException({
          code: INTEGRATIONS_ERRORS.CHANNEL_DISABLED,
          message: 'channel disabled',
        });
      }

      const adapter = this.registry.get(channel.type);
      if (!adapter) {
        throw new NotFoundException({
          code: INTEGRATIONS_ERRORS.CHANNEL_TYPE_INVALID,
          message: `adapter not found for type ${channel.type}`,
        });
      }

      if (typeof adapter.verifyInbound === 'function') {
        await adapter.verifyInbound(req as any, channel);
      }

      // handshake support if adapter implements it
      if (typeof (adapter as any).handleHandshake === 'function') {
        const handled = await (adapter as any).handleHandshake(
          req as any,
          res as any,
          channel,
        );
        if (handled) return;
      }

      const commands = await adapter.normalizeInbound(req as any, channel);

      if (!commands || commands.length === 0) {
        throw new BadRequestException({
          code: 'BAD_REQUEST',
          message: 'empty commands after normalize',
        });
      }

      const { results } = await this.registry.submitInbound(
        channel.id,
        commands,
      );

      res.json({ ok: true, results });
      return;
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        const body: any = (e.getResponse() as any) ?? {};
        res.status(401).json({
          code: body.code ?? INTEGRATIONS_ERRORS.SIGNATURE_INVALID,
          message: body.message ?? 'signature invalid',
        });
        return;
      }
      if (e instanceof NotFoundException) {
        const body: any = (e.getResponse() as any) ?? {};
        const status = e.getStatus();
        res.status(status).json({
          code: body.code ?? INTEGRATIONS_ERRORS.CHANNEL_NOT_FOUND,
          message: body.message ?? 'not found',
        });
        return;
      }
      if (e instanceof BadRequestException) {
        const body: any = (e.getResponse() as any) ?? {};
        res.status(400).json({
          code: body.code ?? 'BAD_REQUEST',
          message: body.message ?? 'bad request',
        });
        return;
      }
      const msg = (e as Error)?.message ?? String(e);
      const anyErr: any = e as any;
      const response: any = anyErr?.response ?? anyErr?.getResponse?.();
      if (response && typeof response === 'object' && response.code) {
        const status =
          typeof anyErr.getStatus === 'function' ? anyErr.getStatus() : 400;
        res.status(status).json(response);
        return;
      }
      res.status(400).json({ code: 'BAD_REQUEST', message: msg.slice(0, 512) });
      return;
    }
  }
}
