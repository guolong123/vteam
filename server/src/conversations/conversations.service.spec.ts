import { ConversationsService } from './conversations.service';

/**
 * 会话聚合（P2）单元测试：群聊 + 成员私聊聚合、摘要/未读/排序、可见性为空。
 * Prisma 全部 mock（与 teams/chat 单测同风格，不连库）。
 */
describe('ConversationsService', () => {
  let service: ConversationsService;
  let prisma: any;

  const now = (iso: string) => new Date(iso);
  const messages = [
    {
      id: 'm_0000000003',
      channelId: 'c_group1',
      senderType: 'agent',
      senderId: 'tmm_0000000001',
      content: { text: '需求清单已更新，请评审' },
      createdAt: now('2026-11-06T10:00:00Z'),
    },
    {
      id: 'm_0000000001',
      channelId: 'c_dm_a',
      senderType: 'agent',
      senderId: 'tmm_0000000002',
      content: { text: '存储方案我倾向 B' },
      createdAt: now('2026-11-06T09:00:00Z'),
    },
    {
      id: 'm_0000000002',
      channelId: 'c_dm_b',
      senderType: 'agent',
      senderId: 'tmm_0000000002',
      content: { text: '继续昨天的评审' },
      createdAt: now('2026-11-06T11:00:00Z'),
    },
  ];

  beforeEach(() => {
    prisma = {
      teamUserMember: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ teamId: 'tm_1' }, { teamId: 'tm_2' }]),
      },
      team: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'tm_1', name: '通知中心迭代' },
          { id: 'tm_2', name: '增长实验' },
        ]),
      },
      chatChannel: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          if (where.type === 'team_group') {
            return Promise.resolve([
              {
                id: 'c_group1',
                teamId: 'tm_1',
                pinned: true,
                lastReadAt: now('2026-11-06T09:30:00Z'),
              },
            ]);
          }
          return Promise.resolve([
            {
              id: 'c_dm_a',
              teamId: 'tm_1',
              pinned: false,
              lastReadAt: now('2026-11-06T08:00:00Z'),
              teamMember: {
                memberId: 'mbr_1',
                alias: '架构师-老周',
                member: { id: 'mbr_1', name: '架构师-老周', status: 'active' },
              },
            },
            {
              id: 'c_dm_b',
              teamId: 'tm_2',
              pinned: false,
              lastReadAt: now('2026-11-06T10:00:00Z'),
              teamMember: {
                memberId: 'mbr_1',
                alias: '架构师-老周',
                member: { id: 'mbr_1', name: '架构师-老周', status: 'active' },
              },
            },
            {
              id: 'c_dm_legacy',
              teamId: 'tm_1',
              pinned: false,
              lastReadAt: null,
              teamMember: {
                memberId: null,
                alias: '旧席位',
                member: null,
              },
            },
          ]);
        }),
      },
      message: {
        groupBy: jest.fn().mockImplementation(({ where }: any) => {
          const ids = where.channelId.in as string[];
          return Promise.resolve(
            ids.map((channelId) => ({
              channelId,
              _max: {
                id:
                  [...messages]
                    .filter((m) => m.channelId === channelId)
                    .sort((a, b) => b.id.localeCompare(a.id))[0]?.id ?? null,
              },
            })),
          );
        }),
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          const ids = where.id.in as string[];
          return Promise.resolve(messages.filter((m) => ids.includes(m.id)));
        }),
        count: jest.fn().mockImplementation(({ where }: any) => {
          const gt = where.createdAt.gt as Date;
          return Promise.resolve(
            messages.filter(
              (m) => m.channelId === where.channelId && m.createdAt > gt,
            ).length,
          );
        }),
      },
      teamMember: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'tmm_0000000001', alias: '产品-小美' }]),
        groupBy: jest
          .fn()
          .mockResolvedValue([{ teamId: 'tm_1', _count: { _all: 3 } }]),
      },
    };
    service = new ConversationsService(prisma);
  });

  it('群聊 + 成员私聊聚合；私聊按成员合并为一条（含跨群未读求和）', async () => {
    const result: any = await service.list('u_1');

    expect(result.total).toBe(2);
    const group = result.items.find((i: any) => i.type === 'group');
    expect(group).toMatchObject({
      id: 'group:tm_1',
      title: '通知中心迭代',
      badge: '群',
      channelId: 'c_group1',
      memberCount: 3,
      pinned: true,
    });
    expect(group.lastMessage).toMatchObject({
      text: '需求清单已更新，请评审',
      senderName: '产品-小美',
    });
    // lastReadAt=09:30，唯一消息 10:00 → 未读 1
    expect(group.unreadCount).toBe(1);

    const dm = result.items.find((i: any) => i.type === 'dm');
    expect(dm).toMatchObject({
      id: 'dm:mbr_1',
      title: '架构师-老周',
      badge: '成员',
    });
    // 两条私聊频道（tm_1/tm_2）合并：未读 = 1 + 1；上下文频道取最新消息所在 c_dm_b
    expect(dm.unreadCount).toBe(2);
    expect(dm.channelId).toBe('c_dm_b');
    expect(dm.contextTeamId).toBe('tm_2');
    expect(dm.lastMessage.text).toBe('继续昨天的评审');
  });

  it('未回填的旧私聊（memberId 为空）不进入成员会话', async () => {
    const result: any = await service.list('u_1');
    const ids = result.items.map((i: any) => i.id);
    expect(ids).not.toContain('dm:c_dm_legacy');
    expect(ids.filter((id: string) => id.startsWith('dm:'))).toHaveLength(1);
  });

  it('type/keyword/unreadOnly 过滤', async () => {
    const onlyDm: any = await service.list('u_1', { type: 'dm' });
    expect(onlyDm.items).toHaveLength(1);
    expect(onlyDm.items[0].type).toBe('dm');

    const byKeyword: any = await service.list('u_1', { keyword: '架构' });
    expect(byKeyword.items).toHaveLength(1);
    expect(byKeyword.items[0].type).toBe('dm');

    const unreadOnly: any = await service.list('u_1', { unreadOnly: true });
    expect(unreadOnly.items.length).toBeGreaterThan(0);
  });

  it('无可见团队 → 空列表（不泄漏团队存在性）', async () => {
    prisma.teamUserMember.findMany.mockResolvedValue([]);
    const result: any = await service.list('u_2');
    expect(result).toEqual({ items: [], total: 0 });
    expect(prisma.chatChannel.findMany).not.toHaveBeenCalled();
  });
});
