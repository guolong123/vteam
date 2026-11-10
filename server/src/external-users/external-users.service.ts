import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CHANNEL_TYPE, SENDER_TYPE } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { resyncIdPrefix } from '../common/id-resync';
import { normalizeMessageAttachments } from '../chat/message-attachments';
import { PrismaService } from '../prisma/prisma.service';
import {
  EXTERNAL_USER_DEFAULT_SOURCE,
  EXTERNAL_USER_EDITABLE_FIELDS,
  EXTERNAL_USER_ID_PREFIX,
  EXTERNAL_USERS_DEFAULT_MESSAGE_LIMIT,
  EXTERNAL_USERS_DEFAULT_PAGE_SIZE,
  EXTERNAL_USERS_ERRORS,
  EXTERNAL_USERS_MAX_CANDIDATES,
} from './constants';
import {
  QueryExternalUserMessagesDto,
  QueryExternalUsersDto,
} from './dto/query-external-users.dto';
import { UpdateExternalUserDto } from './dto/update-external-user.dto';

/** 调用者可见频道投影（team_group + 调用者 team_user_members 团队）。 */
interface VisibleChannel {
  id: string;
  teamId: string;
  teamName: string | null;
}

/** 入库消息行的读取子集（Prisma Message 行结构兼容）。 */
interface ExternalMessageRow {
  id: string;
  channelId: string;
  bodyText?: string | null;
  content?: unknown;
  attachments?: Prisma.JsonValue | null;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentType?: string | null;
  status: string;
  createdAt: Date;
}

/** 用户×频道维度的消息统计（groupBy 结果的内存投影）。 */
interface ChannelActivity {
  externalUserId: string;
  channelId: string;
  messageCount: number;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
}

/** 单个外部用户的聚合统计（列表/详情共用）。 */
interface ExternalUserActivity {
  externalUserId: string;
  messageCount: number;
  groupCount: number;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
}

/** 入站身份解析入参（MessageInboundService 传入渠道原始身份）。 */
export interface ResolveInboundIdentityInput {
  /** 外部平台稳定 userid（企微 userid / 通用 webhook senderExternalId），可空。 */
  externalId?: string | null;
  /** 渠道展示名（企微用户名等），可空。 */
  displayName?: string | null;
  /** 来源渠道类型（message_channels.type：wecom_aibot / generic_webhook…）。 */
  source?: string | null;
}

/** 外部平台稳定标识的最大长度（external_id 列 varchar(191)）。 */
const EXTERNAL_ID_MAX_LENGTH = 191;
/** 展示名最大长度（display_name 列 varchar(191)）。 */
const DISPLAY_NAME_MAX_LENGTH = 191;
/** 来源渠道类型最大长度（source 列 varchar(32)）。 */
const SOURCE_MAX_LENGTH = 32;

/**
 * 外部渠道用户目录服务（契约 §2.1-§2.5）。
 *
 * 设计要点（why）：
 * - **可见性 = 调用者团队的 team_group 频道**：外部用户是团队消息的副产品，
 *   没有全局可见性；没有可见消息的用户一律 404（不暴露存在性，与成员/频道
 *   域的「非成员看不到」口径一致）。
 * - **统计走消息 groupBy，不存冗余计数**：messageCount/groupCount/lastMessageAt
 *   都由 messages 聚合得到，避免写路径双写计数器带来的漂移（目录是只读视图 +
 *   人工资料维护，读多写少，聚合成本可接受；外部用户量级小）。
 * - **两张查询口径**：list 需要「按人 + 按频道」二维聚合（同时得到 messageCount
 *   与 groupCount）；findOne 只关心单人的频道分布。
 * - **主键 eu_ 前缀进程内序号**：启动时 resyncIdPrefix 续号；迁移回填的
 *   `eu_bk_<hash>` 非数字尾段会被跳过，不会把计数器顶高。
 */
@Injectable()
export class ExternalUsersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
  ) {}

  /** 进程启动：按库内 `eu_` 前缀纯数字序号最大值对齐 id 生成器（防主键冲突）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(
      this.prisma.externalUser,
      EXTERNAL_USER_ID_PREFIX,
      this.idGen,
    );
  }

  /**
   * GET /external-users（契约 §2.1）。
   *
   * 步骤：可见 teamIds → 可见 team_group channelIds → 消息按 (externalUserId,
   * channelId) groupBy（一次拿到 messageCount 与 groupCount）→ 关键字过滤 →
   * 最近发言倒序 → 内存分页 → 当前页补 lastMessageText。
   */
  async list(userId: string, query: QueryExternalUsersDto = {}) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(query.pageSize) || EXTERNAL_USERS_DEFAULT_PAGE_SIZE),
    );
    const channels = await this.resolveVisibleChannels(userId);
    if (channels.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }
    const channelIds = channels.map((channel) => channel.id);
    const activities = this.aggregateByUser(
      await this.loadChannelActivities(channelIds),
    );
    if (activities.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }
    // 候选上限防御：先按最近发言时间截断，再做关键字/分页（外部用户量级小，
    // 这样即使 messages 历史极大也不会把全表 external_users 读进内存）。
    activities.sort((a, b) => this.activityTime(b) - this.activityTime(a));
    const candidateIds = activities
      .slice(0, EXTERNAL_USERS_MAX_CANDIDATES)
      .map((activity) => activity.externalUserId);

    const keyword = query.keyword?.trim();
    const users = await this.prisma.externalUser.findMany({
      where: {
        id: { in: candidateIds },
        ...(keyword
          ? {
              OR: [
                { name: { contains: keyword } },
                { displayName: { contains: keyword } },
                { company: { contains: keyword } },
                { position: { contains: keyword } },
                { contact: { contains: keyword } },
                { externalId: { contains: keyword } },
              ],
            }
          : {}),
      },
    });

    const activityById = new Map(
      activities.map((activity) => [activity.externalUserId, activity]),
    );
    const rows = users
      .map((user) => ({
        user,
        activity: activityById.get(user.id) ?? null,
      }))
      // 理论 groupBy 里的 id 都能查到实体（FK 保证），仍防御脏数据（SetNull
      // 只影响消息行，不会出现无主统计；保留过滤避免非空断言炸运行时）。
      .filter(
        (
          row,
        ): row is {
          user: (typeof users)[number];
          activity: ExternalUserActivity;
        } => row.activity !== null,
      )
      .sort((a, b) => this.rowActivityTime(b) - this.rowActivityTime(a));

    const total = rows.length;
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
    const lastTextById = await this.loadLastMessageTexts(
      pageRows.map((row) => row.user.id),
      channelIds,
    );
    return {
      items: pageRows.map((row) =>
        this.toListItem(
          row.user,
          row.activity,
          lastTextById.get(row.user.id) ?? null,
        ),
      ),
      total,
      page,
      pageSize,
    };
  }

  /**
   * GET /external-users/:id（契约 §2.2）。
   *
   * 不可见（没有可见消息）→ 404 EXTERNAL_USER_NOT_FOUND，不暴露存在性。
   */
  async findOne(userId: string, id: string) {
    const user = await this.prisma.externalUser.findUnique({ where: { id } });
    if (!user) {
      throw this.notFound();
    }
    const channels = await this.resolveVisibleChannels(userId);
    const channelById = new Map(
      channels.map((channel) => [channel.id, channel]),
    );
    const channelRows =
      channels.length > 0
        ? await this.loadUserChannelActivities(
            id,
            channels.map((channel) => channel.id),
          )
        : [];
    if (channelRows.length === 0) {
      throw this.notFound();
    }
    const activity = this.aggregateByUser(channelRows)[0];
    if (!activity) {
      // 防御：channelRows 非空却聚合不出用户（不可达）→ 与「不可见」同口径 404，
      // 避免 tsc strict/运行时拿到 undefined 后在 toListItem 里抛 TypeError。
      throw this.notFound();
    }
    const channelIds = channels.map((channel) => channel.id);
    const lastMessageText = await this.loadLastMessageText(id, channelIds);
    const groups = channelRows
      .map((row) => {
        const channel = channelById.get(row.channelId);
        return {
          teamId: channel?.teamId ?? null,
          teamName: channel?.teamName ?? null,
          channelId: row.channelId,
          messageCount: row.messageCount,
          lastMessageAt: this.toIso(row.lastMessageAt),
        };
      })
      // 群聊分布按最近发言倒序（前端直接渲染，不再二次排序）
      .sort((a, b) =>
        (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''),
      );
    return {
      ...this.toListItem(user, activity, lastMessageText),
      // firstMessageAt 以目录列为准（入站维护）；历史脏数据（列为 NULL）回退消息聚合
      firstMessageAt: this.toIso(
        user.firstMessageAt ?? activity.firstMessageAt,
      ),
      createdAt: this.toIso(user.createdAt),
      updatedAt: this.toIso(user.updatedAt),
      groups,
    };
  }

  /**
   * PATCH /external-users/:id（契约 §2.3）。
   *
   * 先走 findOne 做存在性/可见性 gate（不可见用户不允许改，防越权探测/篡改），
   * 再只更新传入字段；空串/null 一律存 null（清空语义），返回更新后的详情。
   */
  async update(userId: string, id: string, dto: UpdateExternalUserDto) {
    await this.findOne(userId, id);
    const data: Record<string, string | null> = {};
    for (const field of EXTERNAL_USER_EDITABLE_FIELDS) {
      const value = dto[field];
      if (value === undefined) {
        continue;
      }
      const trimmed = typeof value === 'string' ? value.trim() : '';
      data[field] = trimmed.length > 0 ? trimmed : null;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.externalUser.update({ where: { id }, data });
    }
    return this.findOne(userId, id);
  }

  /**
   * GET /external-users/:id/messages（契约 §2.4）。
   *
   * 口径对齐 `/channels/:id/messages`：`id < cursor ORDER BY id DESC LIMIT limit+1`
   * 取 id（避免大 content JSON 参与排序），再按主键 in 取整行，最后反转成升序。
   * 过滤条件固定 sender_type='external' AND external_user_id=:id + 可见频道。
   */
  async listMessages(
    userId: string,
    id: string,
    query: QueryExternalUserMessagesDto = {},
  ) {
    // 404 gate：不可见用户不返回任何消息（同时保证 user 行存在）
    await this.findOne(userId, id);
    const limit = this.normalizeMessageLimit(query.limit);
    const channels = await this.resolveVisibleChannels(userId);
    if (channels.length === 0) {
      throw this.notFound();
    }
    const channelById = new Map(
      channels.map((channel) => [channel.id, channel]),
    );
    const idRows = await this.prisma.message.findMany({
      where: {
        externalUserId: id,
        channelId: { in: channels.map((channel) => channel.id) },
        senderType: SENDER_TYPE.external,
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: { id: true },
    });
    const hasMore = idRows.length > limit;
    const ids = (hasMore ? idRows.slice(0, limit) : idRows).map(
      (row) => row.id,
    );
    const rows =
      ids.length > 0
        ? ((await this.prisma.message.findMany({
            where: { id: { in: ids } },
          })) as unknown as ExternalMessageRow[])
        : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids
      .map((messageId) => byId.get(messageId))
      .filter((row): row is ExternalMessageRow => row !== undefined);
    return {
      // ids 为 id 降序（最新优先），反转回升序供前端时间正序渲染
      items: [...ordered]
        .reverse()
        .map((row) =>
          this.toExternalMessageDto(row, channelById.get(row.channelId)),
        ),
      nextCursor: hasMore ? ids[ids.length - 1] : null,
    };
  }

  /**
   * 入站身份解析（契约 §2.5）：post_message 落库前把渠道发送者映射到目录实体。
   *
   * 语义：
   * 1. displayName 空时回退 externalId（两者都空 → null，无身份不落库）；
   * 2. 身份键 `id:<userid>` 优先，回退 `name:<展示名>`（吸收 legacy/仅展示名行）；
   * 3. 名字行命中且本次有稳定 userid → **升级** externalId 为 id:（下次直接命中）；
   * 4. 展示名变化时更新 displayName（管理字段 name 不被覆盖）；
   * 5. 都未命中 → 用 IdGeneratorService 生成 eu_ 主键创建；
   *    P2002 竞态（多实例同时入站）→ 重查一次已存在的行。
   */
  async resolveInboundIdentity(
    input: ResolveInboundIdentityInput,
  ): Promise<{ id: string; externalId: string } | null> {
    const rawExternalId = (input.externalId ?? '').trim();
    const rawDisplayName = (input.displayName ?? '').trim();
    const displayName = this.clip(
      rawDisplayName || rawExternalId,
      DISPLAY_NAME_MAX_LENGTH,
    );
    if (!displayName) {
      // 无展示名也无 userid：渠道没给任何身份，消息仍可落库（external_user_id=NULL）
      return null;
    }
    const idKey = rawExternalId
      ? this.clip(`id:${rawExternalId}`, EXTERNAL_ID_MAX_LENGTH)
      : null;
    const nameKey = this.clip(`name:${displayName}`, EXTERNAL_ID_MAX_LENGTH);

    // 先稳定 id：只有没命中时才回退名字键（避免同名合并后再升级时丢稳定身份）
    const hitById = idKey
      ? await this.prisma.externalUser.findUnique({
          where: { externalId: idKey },
        })
      : null;
    const hit =
      hitById ??
      (await this.prisma.externalUser.findUnique({
        where: { externalId: nameKey },
      }));

    if (hit) {
      const patch: { externalId?: string; displayName?: string } = {};
      if (idKey && hit.externalId === nameKey) {
        // 名字键历史行 + 本次拿到稳定 userid → 升级（外部平台 userid 变更/补全）
        patch.externalId = idKey;
      }
      if (hit.displayName !== displayName) {
        patch.displayName = displayName;
      }
      if (Object.keys(patch).length === 0) {
        return hit;
      }
      try {
        return await this.prisma.externalUser.update({
          where: { id: hit.id },
          data: patch,
        });
      } catch (err) {
        if ((err as { code?: string })?.code !== 'P2002') {
          throw err;
        }
        // 并发升级竞态：另一实例已把同一 externalId 写到别的行 → 重查命中即用
        const raced = await this.prisma.externalUser.findUnique({
          where: { externalId: patch.externalId ?? hit.externalId },
        });
        if (raced) {
          return raced;
        }
        throw err;
      }
    }

    // 都未命中 → 新建（externalId 优先稳定 id；同名不同人无 id 时会合并，契约 §5 已接受）
    const externalId = idKey ?? nameKey;
    const source = this.clip(
      (input.source ?? '').trim() || EXTERNAL_USER_DEFAULT_SOURCE,
      SOURCE_MAX_LENGTH,
    );
    try {
      return await this.prisma.externalUser.create({
        data: {
          id: await this.idGen.nextId(EXTERNAL_USER_ID_PREFIX),
          externalId,
          displayName,
          source,
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002') {
        throw err;
      }
      // 多实例并发创建同一 externalId：唯一键兜底，重查一次即可
      const raced = await this.prisma.externalUser.findUnique({
        where: { externalId },
      });
      if (raced) {
        return raced;
      }
      throw err;
    }
  }

  /**
   * 入站消息落库成功后刷新目录活跃时间（契约 §2.5 第 6 条）：
   * firstMessageAt 只在为 NULL 时补（首条），lastMessageAt 恒更新。
   *
   * 目录行不存在（例如并发删除/历史异常）时静默返回——目录刷新不能反向
   * 影响消息已成功的入站结果。
   */
  async touchActivity(id: string, at: Date = new Date()): Promise<void> {
    if (!id) {
      return;
    }
    const row = await this.prisma.externalUser.findUnique({
      where: { id },
      select: { firstMessageAt: true },
    });
    if (!row) {
      return;
    }
    await this.prisma.externalUser.update({
      where: { id },
      data: {
        lastMessageAt: at,
        ...(row.firstMessageAt ? {} : { firstMessageAt: at }),
      },
    });
  }

  // ------------------------------------------------------------------
  // 可见性
  // ------------------------------------------------------------------

  /** 调用者所属团队（team_user_members）→ 团队 ids（去重）。 */
  private async resolveVisibleTeamIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.teamUserMember.findMany({
      where: { userId },
      select: { teamId: true },
    });
    return [
      ...new Set(
        memberships
          .map((membership) => membership.teamId)
          .filter((teamId): teamId is string => !!teamId),
      ),
    ];
  }

  /**
   * 可见频道 = 调用者团队下未删除的 team_group 频道（契约 §2.1 可见性定义）。
   * 私聊频道不参与：外部用户消息只落在群聊频道（入站链路写 team_group）。
   */
  private async resolveVisibleChannels(
    userId: string,
  ): Promise<VisibleChannel[]> {
    const teamIds = await this.resolveVisibleTeamIds(userId);
    if (teamIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.chatChannel.findMany({
      where: {
        teamId: { in: teamIds },
        type: CHANNEL_TYPE.team_group,
        deletedAt: null,
      },
      select: {
        id: true,
        teamId: true,
        team: { select: { name: true } },
      },
    });
    return rows
      .filter(
        (row): row is typeof row & { teamId: string } => row.teamId !== null,
      )
      .map((row) => ({
        id: row.id,
        teamId: row.teamId,
        teamName: row.team?.name ?? null,
      }));
  }

  // ------------------------------------------------------------------
  // 消息统计
  // ------------------------------------------------------------------

  /**
   * 按 (externalUserId, channelId) 二维 groupBy：一次聚合同时得到
   * messageCount（用户总消息数）与 groupCount（有消息的频道数）。
   */
  private async loadChannelActivities(
    channelIds: string[],
  ): Promise<ChannelActivity[]> {
    if (channelIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.message.groupBy({
      by: ['externalUserId', 'channelId'],
      where: {
        channelId: { in: channelIds },
        senderType: SENDER_TYPE.external,
        externalUserId: { not: null },
      },
      _count: { _all: true },
      _max: { createdAt: true },
      _min: { createdAt: true },
    });
    return rows
      .filter((row) => !!row.externalUserId)
      .map((row) => ({
        externalUserId: row.externalUserId as string,
        channelId: row.channelId,
        messageCount: (row._count as { _all: number })._all,
        firstMessageAt: (row._min as { createdAt: Date | null }).createdAt,
        lastMessageAt: (row._max as { createdAt: Date | null }).createdAt,
      }));
  }

  /** 单个外部用户在可见频道内的分布（findOne 的 groups 来源）。 */
  private async loadUserChannelActivities(
    externalUserId: string,
    channelIds: string[],
  ): Promise<ChannelActivity[]> {
    if (channelIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.message.groupBy({
      by: ['channelId'],
      where: {
        externalUserId,
        channelId: { in: channelIds },
        senderType: SENDER_TYPE.external,
      },
      _count: { _all: true },
      _max: { createdAt: true },
      _min: { createdAt: true },
    });
    return rows.map((row) => ({
      externalUserId,
      channelId: row.channelId,
      messageCount: (row._count as { _all: number })._all,
      firstMessageAt: (row._min as { createdAt: Date | null }).createdAt,
      lastMessageAt: (row._max as { createdAt: Date | null }).createdAt,
    }));
  }

  /** 二维统计 → 按用户聚合（sum 消息数、count 频道数、min/max 时间）。 */
  private aggregateByUser(rows: ChannelActivity[]): ExternalUserActivity[] {
    const byUser = new Map<string, ExternalUserActivity>();
    for (const row of rows) {
      const existing = byUser.get(row.externalUserId);
      if (!existing) {
        byUser.set(row.externalUserId, {
          externalUserId: row.externalUserId,
          messageCount: row.messageCount,
          groupCount: 1,
          firstMessageAt: row.firstMessageAt,
          lastMessageAt: row.lastMessageAt,
        });
        continue;
      }
      existing.messageCount += row.messageCount;
      existing.groupCount += 1;
      if (
        row.firstMessageAt &&
        (!existing.firstMessageAt ||
          row.firstMessageAt < existing.firstMessageAt)
      ) {
        existing.firstMessageAt = row.firstMessageAt;
      }
      if (
        row.lastMessageAt &&
        (!existing.lastMessageAt || row.lastMessageAt > existing.lastMessageAt)
      ) {
        existing.lastMessageAt = row.lastMessageAt;
      }
    }
    return [...byUser.values()];
  }

  /**
   * 当前页用户的「最近一条消息正文」：每用户一条 findFirst（主键 id 倒序 + limit 1），
   * Promise.all 并发（页大小 ≤ 100，请求数有界）。
   *
   * 为什么不是「一次 findMany 全历史再取首条」：后者没有 take，读取量随单用户
   * 历史线性增长，且会把每行 content 大 JSON（工具输出可达数百 KB）全读回内存——
   * 外部用户消息多了以后列表页会又慢又占内存。findFirst 走
   * idx_messages_external_user_id (external_user_id, id) 的主键倒序单行读取，
   * 每用户只回一条，总量恒等于当前页用户数。
   */
  private async loadLastMessageTexts(
    externalUserIds: string[],
    channelIds: string[],
  ): Promise<Map<string, string | null>> {
    if (externalUserIds.length === 0 || channelIds.length === 0) {
      return new Map<string, string | null>();
    }
    const entries = await Promise.all(
      externalUserIds.map(
        async (externalUserId) =>
          [
            externalUserId,
            await this.loadLastMessageText(externalUserId, channelIds),
          ] as const,
      ),
    );
    return new Map(entries);
  }

  /** 单个用户最近一条可见消息正文（findOne 详情用）。 */
  private async loadLastMessageText(
    externalUserId: string,
    channelIds: string[],
  ): Promise<string | null> {
    if (channelIds.length === 0) {
      return null;
    }
    const row = await this.prisma.message.findFirst({
      where: {
        externalUserId,
        channelId: { in: channelIds },
        senderType: SENDER_TYPE.external,
      },
      orderBy: { id: 'desc' },
      select: { bodyText: true, content: true },
    });
    return row ? this.textOf(row) : null;
  }

  // ------------------------------------------------------------------
  // DTO 映射
  // ------------------------------------------------------------------

  private toListItem(
    user: {
      id: string;
      name: string | null;
      displayName: string;
      position: string | null;
      company: string | null;
      contact: string | null;
      source: string;
      externalId: string;
      lastMessageAt: Date | null;
    },
    activity: ExternalUserActivity,
    lastMessageText: string | null,
  ) {
    return {
      id: user.id,
      // 展示名已解析：人工填的姓名优先，未填回退渠道展示名（契约 §2.1）
      name: user.name ?? user.displayName,
      displayName: user.displayName,
      position: user.position,
      company: user.company,
      contact: user.contact,
      source: user.source,
      externalId: user.externalId,
      messageCount: activity.messageCount,
      groupCount: activity.groupCount,
      lastMessageAt: this.toIso(activity.lastMessageAt ?? user.lastMessageAt),
      lastMessageText,
    };
  }

  /** 消息回看 DTO（契约 §2.4；text 取 body_text 生成列，缺失回退 content.text）。 */
  private toExternalMessageDto(
    row: ExternalMessageRow,
    channel: VisibleChannel | undefined,
  ) {
    return {
      id: row.id,
      channelId: row.channelId,
      teamId: channel?.teamId ?? null,
      teamName: channel?.teamName ?? null,
      text: this.textOf(row),
      attachments: normalizeMessageAttachments(row),
      status: row.status,
      createdAt: this.toIso(row.createdAt),
    };
  }

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------

  /** 正文读取：body_text 生成列优先（避免解析大 content JSON），缺失回退 content.text。 */
  private textOf(row: {
    bodyText?: string | null;
    content?: unknown;
  }): string | null {
    if (typeof row.bodyText === 'string') {
      return row.bodyText;
    }
    const content = row.content as { text?: unknown } | null | undefined;
    return typeof content?.text === 'string' ? content.text : null;
  }

  private activityTime(activity: ExternalUserActivity): number {
    return activity.lastMessageAt ? activity.lastMessageAt.getTime() : 0;
  }

  private rowActivityTime(row: {
    user: { lastMessageAt: Date | null; updatedAt: Date };
    activity: ExternalUserActivity;
  }): number {
    const time =
      row.activity.lastMessageAt ??
      row.user.lastMessageAt ??
      row.user.updatedAt;
    return time ? time.getTime() : 0;
  }

  private normalizeMessageLimit(limit?: number): number {
    const value = Number(limit ?? EXTERNAL_USERS_DEFAULT_MESSAGE_LIMIT);
    if (!Number.isFinite(value)) {
      return EXTERNAL_USERS_DEFAULT_MESSAGE_LIMIT;
    }
    return Math.min(Math.max(Math.floor(value), 1), 100);
  }

  private clip(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private toIso(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: EXTERNAL_USERS_ERRORS.EXTERNAL_USER_NOT_FOUND,
      message: '外部用户不存在',
    });
  }
}
