import { listTeamExternalUsers } from './external-users.directory';

/**
 * 外部用户目录聚合纯函数单测（task-4）：
 * 覆盖消息聚合口径/排序/关键字过滤/limit 上限/空频道短路，
 * 保证 team_view 与复用方的 externalUsers 数据形状一致。
 */
function createPrisma() {
  const prisma: any = {
    chatChannel: { findMany: jest.fn().mockResolvedValue([]) },
    message: { groupBy: jest.fn().mockResolvedValue([]) },
    externalUser: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return prisma;
}

const TEAM_ID = 'tm_0000000001';
const CHANNEL_A = 'c_0000000001';
const CHANNEL_B = 'c_0000000002';

function statRow(externalUserId: string, count: number, lastAt: Date | null) {
  return {
    externalUserId,
    _count: { _all: count },
    _max: { createdAt: lastAt },
  };
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'eu_0000000001',
    externalId: 'id:GuoLong',
    displayName: '企微用户-Song',
    name: null,
    position: null,
    company: null,
    contact: null,
    source: 'wecom_aibot',
    firstMessageAt: null,
    lastMessageAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('listTeamExternalUsers', () => {
  it('按团队 team_group 频道聚合 external 消息，最近发言倒序，name 回退 displayName', async () => {
    const prisma = createPrisma();
    prisma.chatChannel.findMany.mockResolvedValue([
      { id: CHANNEL_A },
      { id: CHANNEL_B },
    ]);
    prisma.message.groupBy.mockResolvedValue([
      statRow('eu_0000000002', 1, new Date('2026-11-09T03:00:00.000Z')),
      statRow('eu_0000000001', 3, new Date('2026-11-10T07:42:00.000Z')),
    ]);
    prisma.externalUser.findMany.mockResolvedValue([
      userRow({
        id: 'eu_0000000001',
        name: '宋工',
        position: '前端负责人',
        company: '宁德时代',
        contact: 'song@example.com',
      }),
      userRow({
        id: 'eu_0000000002',
        externalId: 'name:老王',
        displayName: '老王',
        source: 'generic_webhook',
      }),
    ]);

    const items = await listTeamExternalUsers(prisma, TEAM_ID, {});

    expect(prisma.chatChannel.findMany).toHaveBeenCalledWith({
      where: { teamId: TEAM_ID, type: 'team_group', deletedAt: null },
      select: { id: true },
    });
    expect(prisma.message.groupBy).toHaveBeenCalledWith({
      by: ['externalUserId'],
      where: {
        channelId: { in: [CHANNEL_A, CHANNEL_B] },
        senderType: 'external',
        externalUserId: { not: null },
      },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    // 最近发言倒序
    expect(items.map((item) => item.id)).toEqual([
      'eu_0000000001',
      'eu_0000000002',
    ]);
    expect(items[0]).toEqual({
      id: 'eu_0000000001',
      name: '宋工',
      displayName: '企微用户-Song',
      position: '前端负责人',
      company: '宁德时代',
      contact: 'song@example.com',
      source: 'wecom_aibot',
      externalId: 'id:GuoLong',
      messageCount: 3,
      lastMessageAt: '2026-11-10T07:42:00.000Z',
    });
    // name 为 null → 回退 displayName
    expect(items[1]).toMatchObject({
      name: '老王',
      displayName: '老王',
      messageCount: 1,
      lastMessageAt: '2026-11-09T03:00:00.000Z',
    });
    // 无关键字 → 不带 OR
    expect(prisma.externalUser.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['eu_0000000001', 'eu_0000000002'] },
    });
  });

  it('keyword 对 name/displayName 模糊过滤，只返回命中用户', async () => {
    const prisma = createPrisma();
    prisma.chatChannel.findMany.mockResolvedValue([{ id: CHANNEL_A }]);
    prisma.message.groupBy.mockResolvedValue([
      statRow('eu_0000000001', 2, new Date('2026-11-10T07:42:00.000Z')),
      statRow('eu_0000000002', 1, new Date('2026-11-09T03:00:00.000Z')),
    ]);
    // 模拟 DB：只有 eu_0000000001 命中关键字
    prisma.externalUser.findMany.mockResolvedValue([
      userRow({ id: 'eu_0000000001', name: '宋工' }),
    ]);

    const items = await listTeamExternalUsers(prisma, TEAM_ID, {
      keyword: '  宋工  ',
    });

    expect(prisma.externalUser.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['eu_0000000001', 'eu_0000000002'] },
        OR: [
          { name: { contains: '宋工' } },
          { displayName: { contains: '宋工' } },
        ],
      },
    });
    expect(items.map((item) => item.id)).toEqual(['eu_0000000001']);
  });

  it('limit 限制返回条数（默认/上限 50，小于上限时按入参）', async () => {
    const prisma = createPrisma();
    prisma.chatChannel.findMany.mockResolvedValue([{ id: CHANNEL_A }]);
    const stats = Array.from({ length: 60 }, (_, index) =>
      statRow(
        `eu_${String(index + 1).padStart(10, '0')}`,
        1,
        new Date(2026, 10, 10, 0, 59 - index),
      ),
    );
    prisma.message.groupBy.mockResolvedValue(stats);
    prisma.externalUser.findMany.mockImplementation(({ where }: any) =>
      where.id.in.map((id: string) => userRow({ id })),
    );

    const capped = await listTeamExternalUsers(prisma, TEAM_ID, {});
    expect(capped).toHaveLength(50);
    // 最近发言在前（第 1 条时间最晚）
    expect(capped[0].id).toBe('eu_0000000001');
    expect(capped[49].id).toBe('eu_0000000050');

    const small = await listTeamExternalUsers(prisma, TEAM_ID, { limit: 3 });
    expect(small.map((item) => item.id)).toEqual([
      'eu_0000000001',
      'eu_0000000002',
      'eu_0000000003',
    ]);

    const over = await listTeamExternalUsers(prisma, TEAM_ID, { limit: 999 });
    expect(over).toHaveLength(50);
  });

  it('团队无 team_group 频道 → 直接空集，不查消息/实体', async () => {
    const prisma = createPrisma();
    prisma.chatChannel.findMany.mockResolvedValue([]);

    const items = await listTeamExternalUsers(prisma, TEAM_ID, {});

    expect(items).toEqual([]);
    expect(prisma.message.groupBy).not.toHaveBeenCalled();
    expect(prisma.externalUser.findMany).not.toHaveBeenCalled();
  });

  it('无 external 消息统计 → 空集且不查实体', async () => {
    const prisma = createPrisma();
    prisma.chatChannel.findMany.mockResolvedValue([{ id: CHANNEL_A }]);
    prisma.message.groupBy.mockResolvedValue([]);

    const items = await listTeamExternalUsers(prisma, TEAM_ID, {});

    expect(items).toEqual([]);
    expect(prisma.externalUser.findMany).not.toHaveBeenCalled();
  });

  it('统计行存在但实体缺失（脏数据）→ 跳过该用户', async () => {
    const prisma = createPrisma();
    prisma.chatChannel.findMany.mockResolvedValue([{ id: CHANNEL_A }]);
    prisma.message.groupBy.mockResolvedValue([
      statRow('eu_missing', 1, new Date('2026-11-10T00:00:00.000Z')),
    ]);
    prisma.externalUser.findMany.mockResolvedValue([]);

    const items = await listTeamExternalUsers(prisma, TEAM_ID, {});
    expect(items).toEqual([]);
  });

  it('teamId 空 → 直接空集（防御调用方未解析上下文）', async () => {
    const prisma = createPrisma();
    const items = await listTeamExternalUsers(prisma, '', {});
    expect(items).toEqual([]);
    expect(prisma.chatChannel.findMany).not.toHaveBeenCalled();
  });
});
