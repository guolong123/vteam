import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { PrismaService } from '../prisma/prisma.service';
import {
  MESSAGE_CHANNEL_ID_PREFIX,
  MESSAGE_DELIVERY_ID_PREFIX,
  DELIVERY_DIRECTIONS,
} from './message-channel.constants';

/**
 * 投递日志服务（message-channels，md_ 前缀）。
 *
 * 职责：
 * - tryBeginIngest：幂等去重占位（channelId + externalId 唯一键，P2002 捕获→duplicate:true）
 * - finish：更新占位行状态/错误/载荷
 * - log：一次性投递记录（rejected / skipped 等）
 * - listByChannel：id 游标倒序分页（复用 ChatService 模式，零填充前缀→字典序==数值序）
 * - OnModuleInit：对齐 mc_/md_ 前缀最大序号（resyncIdPrefix，命名 id 跳过）
 */
@Injectable()
export class MessageDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(MessageDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      (this.prisma as any).messageChannel as any,
      MESSAGE_CHANNEL_ID_PREFIX.replace(/_$/, ''),
      this.idGen,
    );
    await resyncIdPrefix(
      (this.prisma as any).messageDelivery as any,
      MESSAGE_DELIVERY_ID_PREFIX.replace(/_$/, ''),
      this.idGen,
    );
  }

  /**
   * 幂等去重占位：externalId 非空时尝试插入一条 pending 行。
   * 成功→{duplicate:false, id}；P2002 唯一冲突→{duplicate:true}。
   * externalId 为空/NULL 时 MySQL 唯一键不去重，直接放行（属预期）。
   */
  async tryBeginIngest(
    channelId: string,
    externalId?: string | null,
  ): Promise<{ duplicate: boolean; id?: string }> {
    if (!externalId) {
      return { duplicate: false };
    }
    const id = await this.idGen.nextId(
      MESSAGE_DELIVERY_ID_PREFIX.replace(/_$/, ''),
    );
    try {
      await (this.prisma as any).messageDelivery.create({
        data: {
          id,
          channelId,
          externalId,
          direction: DELIVERY_DIRECTIONS.inbound,
          status: 'pending',
        },
      });
      return { duplicate: false, id };
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        this.logger.debug(
          `duplicate ingest suppressed channel=${channelId} externalId=${externalId}`,
        );
        return { duplicate: true };
      }
      throw err;
    }
  }

  /** 更新占位行状态（终态写入）。 */
  async finish(
    id: string,
    status: string,
    error?: string | null,
    payload?: unknown,
    meta?: unknown,
  ): Promise<void> {
    const data: Record<string, unknown> = { status };
    if (error !== undefined) data.error = error;
    if (payload !== undefined) data.payload = payload as Prisma.InputJsonValue;
    if (meta !== undefined) data.meta = meta as Prisma.InputJsonValue;
    await (this.prisma as any).messageDelivery.update({
      where: { id },
      data,
    });
  }

  /**
   * 一次性投递记录（rejected / skipped 等无需先占位的场景）。
   * 返回新建行。
   */
  async log(
    direction: string,
    kind: string | null,
    status: string,
    opts: {
      channelId: string;
      externalId?: string | null;
      error?: string | null;
      payload?: unknown;
      meta?: unknown;
    },
  ): Promise<{ id: string }> {
    const id = await this.idGen.nextId(
      MESSAGE_DELIVERY_ID_PREFIX.replace(/_$/, ''),
    );
    try {
      const row = await (this.prisma as any).messageDelivery.create({
        data: {
          id,
          channelId: opts.channelId,
          externalId: opts.externalId ?? null,
          direction,
          kind: kind ?? null,
          status,
          error: opts.error ?? null,
          payload: (opts.payload as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          meta: (opts.meta as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        },
      });
      return { id: row.id as string };
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        const existing = await (this.prisma as any).messageDelivery.findFirst({
          where: {
            channelId: opts.channelId,
            externalId: opts.externalId ?? null,
          },
          select: { id: true },
        });
        if (existing) return { id: existing.id as string };
      }
      throw err;
    }
  }

  /**
   * 按渠道分页查询投递日志（id 游标倒序，复用 ChatService.findMessages 模式）。
   * cursor 缺省取最新 limit 条；cursor = 上页最早一条 id，下一页取更老；
   * 返回 items 为 id 升序（时间正序，前端可直接渲染），nextCursor 为下一页游标或 null。
   */
  async listByChannel(
    channelId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<{ items: any[]; nextCursor: string | null }> {
    const limit = this.normalizeLimit(opts.limit);
    const where: Record<string, unknown> = {
      channelId,
      ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
    };
    const rows = await (this.prisma as any).messageDelivery.findMany({
      where,
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: [...page].reverse(),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as { code?: string; meta?: { target?: string[] } };
    if (anyErr.code !== 'P2002') return false;
    const target = anyErr.meta?.target ?? [];
    if (target.length === 0) return true;
    return (
      target.includes('external_id') ||
      target.includes('externalId') ||
      target.includes('channel_id')
    );
  }

  private normalizeLimit(limit?: number): number {
    const l = Number(limit ?? 50);
    if (!Number.isFinite(l)) return 50;
    return Math.min(Math.max(Math.floor(l), 1), 100);
  }
}
