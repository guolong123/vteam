/**
 * 外部渠道用户目录的**纯函数聚合**（可复用，无 Nest 依赖）。
 *
 * 为什么单独抽模块：team_view（platform-mcp）与外部用户管理接口需要同一份
 * 「某团队的外部用户档案」口径——只统计该团队 team_group 未删除频道里
 * sender_type='external' 的消息、按 external_user_id 聚合 messageCount/lastMessageAt、
 * 只返回**有消息**的用户、最近发言倒序。复制两份查询逻辑必然漂移（字段名/排序/
 * 过滤规则），故收敛到这里，由调用方注入 PrismaService。
 *
 * 与 ExternalUsersService.list 的差异：本函数面向**单个团队**（dispatch/工具场景
 * 只在一个团队内），不处理调用者多团队可见性与分页，只取前 limit 条（默认/上限 50）。
 */
import { CHANNEL_TYPE, SENDER_TYPE } from '../common/constants/event.constants';
import type { PrismaService } from '../prisma/prisma.service';
import { EXTERNAL_USERS_MAX_CANDIDATES } from './constants';

/** 目录默认返回条数（工具场景：外部用户量级小，50 足够覆盖活跃对话）。 */
export const EXTERNAL_USER_DIRECTORY_DEFAULT_LIMIT = 50;

/** 目录硬上限（防止把整个团队历史的外部用户一次性返回给模型）。 */
export const EXTERNAL_USER_DIRECTORY_MAX_LIMIT = 50;

/** 外部用户档案摘要（team_view externalUsers 元素 / 复用方 DTO 基底）。 */
export interface ExternalUserDirectoryItem {
  id: string;
  /** 展示名（人工填写的姓名优先，未填写回退渠道展示名） */
  name: string;
  /** 渠道展示名（企微用户名/昵称，入站自动维护） */
  displayName: string;
  position: string | null;
  company: string | null;
  contact: string | null;
  /** 来源渠道类型：wecom_aibot / generic_webhook / legacy */
  source: string;
  /** 外部平台稳定标识：`id:<企微 userid>` / `name:<展示名>` */
  externalId: string;
  /** 该团队可见频道内该用户的消息数 */
  messageCount: number;
  /** 最近一条消息时间（ISO8601；无值 null） */
  lastMessageAt: string | null;
}

/** 目录过滤参数。 */
export interface ExternalUserDirectoryOptions {
  /** 姓名/展示名模糊过滤（trim 后 contains；空/缺省不过滤）。 */
  keyword?: string | null;
  /** 返回条数（默认 50，上限 50）。 */
  limit?: number | null;
}

/** groupBy 行（userId → 消息数/最近时间）的内存投影。 */
interface ExternalUserMessageStat {
  externalUserId: string;
  messageCount: number;
  lastMessageAt: Date | null;
}

/**
 * 查询某团队的外部渠道用户档案摘要。
 *
 * 口径（与外部用户管理接口一致）：
 * 1. 团队下 `type='team_group'` 且 `deletedAt=null` 的频道 → 消息集合；
 * 2. 只统计 `sender_type='external'` 且 `external_user_id` 非空的行，按用户
 *    groupBy 聚合 messageCount / MAX(created_at)；
 * 3. 只返回有消息的用户（目录行存在但无消息的不出现）；
 * 4. keyword 对 name/displayName 模糊匹配；
 * 5. 最近发言倒序，取前 limit 条（默认/上限 50）。
 *
 * 外部用户量级小，但消息 groupBy 结果随历史增长——候选先按最近发言截断到
 * EXTERNAL_USERS_MAX_CANDIDATES（1000）再查实体，避免一次读全表。
 */
export async function listTeamExternalUsers(
  prisma: PrismaService,
  teamId: string,
  options: ExternalUserDirectoryOptions = {},
): Promise<ExternalUserDirectoryItem[]> {
  if (!teamId) {
    return [];
  }
  const channels = await prisma.chatChannel.findMany({
    where: {
      teamId,
      type: CHANNEL_TYPE.team_group,
      deletedAt: null,
    },
    select: { id: true },
  });
  const channelIds = channels.map((channel) => channel.id);
  if (channelIds.length === 0) {
    return [];
  }

  const grouped = await prisma.message.groupBy({
    by: ['externalUserId'],
    where: {
      channelId: { in: channelIds },
      senderType: SENDER_TYPE.external,
      externalUserId: { not: null },
    },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const stats: ExternalUserMessageStat[] = grouped
    .filter((row) => !!row.externalUserId)
    .map((row) => ({
      externalUserId: row.externalUserId as string,
      messageCount: (row._count as { _all: number })._all,
      lastMessageAt: (row._max as { createdAt: Date | null }).createdAt,
    }))
    // 最近发言倒序（无时间的排最后；仅内存排序，候选量级可控）
    .sort(
      (a, b) =>
        (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
    );
  if (stats.length === 0) {
    return [];
  }
  const candidateIds = stats
    .slice(0, EXTERNAL_USERS_MAX_CANDIDATES)
    .map((stat) => stat.externalUserId);

  const keyword = (options.keyword ?? '').trim();
  const users = await prisma.externalUser.findMany({
    where: {
      id: { in: candidateIds },
      ...(keyword
        ? {
            OR: [
              { name: { contains: keyword } },
              { displayName: { contains: keyword } },
            ],
          }
        : {}),
    },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  const limit = normalizeDirectoryLimit(options.limit);
  const items: ExternalUserDirectoryItem[] = [];
  // 按统计时间倒序遍历（候选已排序），命中实体且有关键字过滤通过才产出；
  // 关键字过滤在内存中做（实体已按 id in 取回），保证「先过滤后 limit」语义。
  for (const stat of stats) {
    if (items.length >= limit) {
      break;
    }
    const user = userById.get(stat.externalUserId);
    if (!user) {
      continue; // FK 保证不会发生；防御历史脏数据
    }
    items.push({
      id: user.id,
      // name 已解析：人工填写的姓名优先，未填回退渠道展示名（与列表接口一致）
      name: user.name ?? user.displayName,
      displayName: user.displayName,
      position: user.position,
      company: user.company,
      contact: user.contact,
      source: user.source,
      externalId: user.externalId,
      messageCount: stat.messageCount,
      lastMessageAt: stat.lastMessageAt
        ? stat.lastMessageAt.toISOString()
        : null,
    });
  }
  return items;
}

/** 返回条数归一化：默认 50，范围 [1, 50]。 */
function normalizeDirectoryLimit(limit?: number | null): number {
  const value = Number(limit ?? EXTERNAL_USER_DIRECTORY_DEFAULT_LIMIT);
  if (!Number.isFinite(value)) {
    return EXTERNAL_USER_DIRECTORY_DEFAULT_LIMIT;
  }
  return Math.min(
    Math.max(Math.floor(value), 1),
    EXTERNAL_USER_DIRECTORY_MAX_LIMIT,
  );
}
