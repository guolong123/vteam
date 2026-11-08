import { Injectable } from '@nestjs/common';
import { CHANNEL_TYPE } from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { QueryConversationsDto } from './dto/query-conversations.dto';

/** 会话项（GET /conversations，37 篇 §5.3）。 */
export interface ConversationItem {
  id: string; // group:<teamId> | dm:<memberId>
  type: 'group' | 'dm';
  title: string;
  badge: '群' | '成员';
  channelId: string | null;
  contextTeamId: string | null;
  memberCount?: number;
  unreadCount: number;
  pinned: boolean;
  processing?: boolean;
  lastMessage: {
    id: string;
    text: string;
    senderType: string;
    senderName: string | null;
    createdAt: string;
  } | null;
}

const EMPTY_TIME = new Date(0);
const SUMMARY_MAX = 120;

/**
 * 会话聚合（P2）：左侧微信式列表的唯一数据源。
 *
 * - 群聊：调用者 team_user_members 可见团队的 team_group 频道；
 * - 成员私聊：可见团队下的 private 频道，按成员聚合（P4 合并前的过渡口径）；
 * - 消息摘要/未读按频道批量计算；`channelId` 随条目返回，前端直接用
 *   `/channels/:id/messages` 拉历史，避免复制消息查询逻辑。
 */
@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: QueryConversationsDto = {}) {
    const memberships = await (this.prisma as any).teamUserMember.findMany({
      where: { userId },
      select: { teamId: true },
    });
    const teamIds = [
      ...new Set((memberships ?? []).map((m: any) => m.teamId).filter(Boolean)),
    ] as string[];
    if (teamIds.length === 0) return { items: [], total: 0 };

    const teams = await (this.prisma as any).team.findMany({
      where: { id: { in: teamIds } },
      select: { id: true, name: true },
    });

    const [groups, dms] = await Promise.all([
      this.groupConversations(teamIds, teams),
      this.dmConversations(teamIds),
    ]);

    let items = [...groups, ...dms];
    if (query.type) items = items.filter((i) => i.type === query.type);
    if (query.keyword?.trim()) {
      const keyword = query.keyword.trim().toLowerCase();
      items = items.filter((i) => i.title.toLowerCase().includes(keyword));
    }
    if (query.unreadOnly === true)
      items = items.filter((i) => i.unreadCount > 0);

    items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const at = a.lastMessage ? Date.parse(a.lastMessage.createdAt) : 0;
      const bt = b.lastMessage ? Date.parse(b.lastMessage.createdAt) : 0;
      if (at !== bt) return bt - at;
      return a.title.localeCompare(b.title);
    });

    return { items, total: items.length };
  }

  private async groupConversations(
    teamIds: string[],
    teams: Array<{ id: string; name: string }>,
  ): Promise<ConversationItem[]> {
    const channels = await (this.prisma as any).chatChannel.findMany({
      where: {
        teamId: { in: teamIds },
        type: CHANNEL_TYPE.team_group,
        deletedAt: null,
      },
      select: { id: true, teamId: true, pinned: true, lastReadAt: true },
    });
    if (!channels || channels.length === 0) return [];

    const channelIds = channels.map((c: any) => c.id);
    const [latest, unread, counts] = await Promise.all([
      this.latestMessages(channelIds),
      this.unreadCounts(channels),
      (this.prisma as any).teamMember.groupBy({
        by: ['teamId'],
        where: { teamId: { in: teamIds } },
        _count: { _all: true },
      }),
    ]);
    const countByTeam = new Map<string, number>(
      (counts ?? []).map((c: any) => [c.teamId, c._count._all]),
    );
    const teamName = new Map(teams.map((t) => [t.id, t.name]));

    return channels.map((ch: any) => ({
      id: `group:${ch.teamId}`,
      type: 'group' as const,
      title: teamName.get(ch.teamId) ?? ch.teamId,
      badge: '群' as const,
      channelId: ch.id,
      contextTeamId: ch.teamId,
      memberCount: countByTeam.get(ch.teamId) ?? 0,
      unreadCount: unread.get(ch.id) ?? 0,
      pinned: ch.pinned === true,
      lastMessage: latest.get(ch.id) ?? null,
    }));
  }

  private async dmConversations(
    teamIds: string[],
  ): Promise<ConversationItem[]> {
    const channels = await (this.prisma as any).chatChannel.findMany({
      where: {
        teamId: { in: teamIds },
        type: CHANNEL_TYPE.private,
        deletedAt: null,
      },
      select: {
        id: true,
        teamId: true,
        pinned: true,
        lastReadAt: true,
        teamMember: {
          select: {
            memberId: true,
            alias: true,
            member: { select: { id: true, name: true, status: true } },
          },
        },
      },
    });
    // 过渡期私聊频道仍是「团队 × 成员」多条：按 memberId 聚合为一条会话；
    // 未回填（memberId 为空）的老频道暂不进入成员会话（P4 合并时统一处理）。
    const byMember = new Map<string, any[]>();
    for (const ch of channels ?? []) {
      const memberId = ch.teamMember?.memberId;
      if (!memberId) continue;
      if (!byMember.has(memberId)) byMember.set(memberId, []);
      byMember.get(memberId)!.push(ch);
    }
    const allChannels = [...byMember.values()].flat();
    const channelIds = allChannels.map((c) => c.id);
    const [latest, unread] = await Promise.all([
      this.latestMessages(channelIds),
      this.unreadCounts(allChannels),
    ]);

    const items: ConversationItem[] = [];
    for (const [memberId, list] of byMember) {
      const member = list[0]?.teamMember?.member;
      const title = member?.name ?? list[0]?.teamMember?.alias ?? memberId;
      // 上下文频道 = 最近有消息的那条；无消息取第一条。
      const context = [...list].sort((a, b) => {
        const am = latest.get(a.id)?.createdAt ?? '';
        const bm = latest.get(b.id)?.createdAt ?? '';
        return bm.localeCompare(am);
      })[0];
      const newest = list
        .map((c) => latest.get(c.id))
        .filter(Boolean)
        .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))[0];
      const totalUnread = list.reduce(
        (sum, c) => sum + (unread.get(c.id) ?? 0),
        0,
      );
      items.push({
        id: `dm:${memberId}`,
        type: 'dm',
        title,
        badge: '成员',
        channelId: context?.id ?? null,
        contextTeamId: context?.teamId ?? null,
        unreadCount: totalUnread,
        pinned: list.some((c) => c.pinned === true),
        processing: await this.hasProcessingMany(list.map((c) => c.id)),
        lastMessage: newest ?? null,
      });
    }

    // 还没有私聊频道的成员也要出现在左栏（原型：成员会话与群聊平铺）——
    // 否则「在群成员里看得到、会话列表里找不到」。channelId=null，前端首次打开
    // 时走 POST /dm-channels 即建（成员维度复用唯一频道）。
    const seats = await (this.prisma as any).teamMember.findMany({
      where: { teamId: { in: teamIds }, memberId: { not: null } },
      select: {
        teamId: true,
        memberId: true,
        member: { select: { id: true, name: true, status: true } },
      },
    });
    const seen = new Set(items.map((i) => i.id));
    const contextTeamByMember = new Map<string, string>();
    for (const seat of seats ?? []) {
      const memberId = seat.memberId as string | null;
      if (!memberId || seen.has(`dm:${memberId}`)) continue;
      if (!contextTeamByMember.has(memberId)) {
        contextTeamByMember.set(memberId, seat.teamId);
      }
    }
    for (const [memberId, contextTeamId] of contextTeamByMember) {
      const seat = (seats as any[]).find((x) => x.memberId === memberId);
      items.push({
        id: `dm:${memberId}`,
        type: 'dm',
        title: seat?.member?.name ?? memberId,
        badge: '成员',
        channelId: null,
        contextTeamId,
        unreadCount: 0,
        pinned: false,
        processing: false,
        lastMessage: null,
      });
    }
    return items;
  }

  /** 频道内是否有正在生成的 agent 消息（status=processing）。 */
  private async hasProcessing(channelId: string): Promise<boolean> {
    const n = await (this.prisma as any).message.count({
      where: { channelId, senderType: 'agent', status: 'processing' },
    });
    return n > 0;
  }

  private async hasProcessingMany(channelIds: string[]): Promise<boolean> {
    if (channelIds.length === 0) return false;
    const n = await (this.prisma as any).message.count({
      where: {
        channelId: { in: channelIds },
        senderType: 'agent',
        status: 'processing',
      },
    });
    return n > 0;
  }

  /** 每频道最新一条消息（groupBy max(id) + 主键回查，避免全量拉取）。 */
  private async latestMessages(channelIds: string[]): Promise<
    Map<
      string,
      {
        id: string;
        text: string;
        senderType: string;
        senderName: string | null;
        status: string | null;
        createdAt: string;
      }
    >
  > {
    const result = new Map<string, any>();
    if (channelIds.length === 0) return result;
    const grouped = await (this.prisma as any).message.groupBy({
      by: ['channelId'],
      where: { channelId: { in: channelIds } },
      _max: { id: true },
    });
    const ids = (grouped ?? [])
      .map((g: any) => g._max?.id)
      .filter((id: unknown): id is string => typeof id === 'string');
    if (ids.length === 0) return result;
    const rows = await (this.prisma as any).message.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        channelId: true,
        senderType: true,
        senderId: true,
        status: true,
        content: true,
        createdAt: true,
      },
    });
    const agentSenderIds = (rows ?? [])
      .filter((r: any) => r.senderType === 'agent' && r.senderId)
      .map((r: any) => r.senderId);
    const aliases = new Map<string, string>();
    if (agentSenderIds.length > 0) {
      const seats = await (this.prisma as any).teamMember.findMany({
        where: { id: { in: agentSenderIds } },
        select: { id: true, alias: true },
      });
      for (const s of seats ?? []) {
        if (s.alias) aliases.set(s.id, s.alias);
      }
    }
    for (const row of rows ?? []) {
      result.set(row.channelId, {
        id: row.id,
        text: this.summarize(row.content),
        senderType: row.senderType,
        senderName: this.senderName(row, aliases),
        status: row.status ?? null,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
      });
    }
    // 正文兜底：最新一条可能是只有思考/工具片段的 agent 占位消息（正文为空），
    // 预览不能空着——往前找该频道最近一条有正文的消息。
    for (const [channelId, entry] of result) {
      if (entry.text && entry.text.trim()) continue;
      const candidates = await (this.prisma as any).message.findMany({
        where: { channelId, status: { not: 'processing' } },
        orderBy: { id: 'desc' },
        take: 20,
        select: { id: true, senderType: true, content: true, status: true, createdAt: true },
      });
      const hit = (candidates ?? []).find((r: any) => {
        const t = this.summarize(r.content);
        return t && t.trim().length > 0;
      });
      if (!hit) {
        result.delete(channelId);
        continue;
      }
      result.set(channelId, {
        ...entry,
        id: hit.id,
        text: this.summarize(hit.content),
        status: hit.status ?? null,
      });
    }
    return result;
  }

  /** 每频道未读数（channel 级 lastReadAt，与现有已读口径一致）。 */
  private async unreadCounts(
    channels: Array<{ id: string; lastReadAt: Date | null }>,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    await Promise.all(
      channels.map(async (ch) => {
        const rows = await (this.prisma as any).message.findMany({
          where: {
            channelId: ch.id,
            createdAt: { gt: ch.lastReadAt ?? EMPTY_TIME },
            senderType: { not: 'user' },
            status: { not: 'processing' },
          },
          select: { content: true },
        });
        // 思考/工具消息没有正文 → 不计未读、不点亮红点。
        const count = (rows ?? []).filter(
          (r: any) => this.summarize(r.content).trim().length > 0,
        ).length;
        result.set(ch.id, count);
      }),
    );
    return result;
  }

  private summarize(content: unknown): string {
    let text = '';
    if (typeof content === 'string') text = content;
    else if (content && typeof content === 'object') {
      const c = content as { text?: unknown; parts?: unknown };
      if (typeof c.text === 'string') text = c.text;
      else if (Array.isArray(c.parts)) {
        // 只认正文 text part：思考(reasoning/thinking)/工具(tool) 的 text 不进预览，
        // 否则左栏会显示模型的过程文本甚至空白。
        const textPart = c.parts.find(
          (p: any) =>
            p &&
            p.type === 'text' &&
            p.synthetic !== true &&
            typeof p.text === 'string',
        );
        if (textPart) text = textPart.text as string;
      }
    }
    return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
  }

  private senderName(
    row: { senderType: string; senderId: string | null },
    aliases: Map<string, string>,
  ): string | null {
    if (row.senderType === 'agent') {
      return (row.senderId && aliases.get(row.senderId)) || 'Agent';
    }
    if (row.senderType === 'system') return '系统';
    return null;
  }
}
