import { ExternalUsersService } from './external-users.service';

/**
 * ExternalUsersService 单元测试（external-users 契约 §2.1-§2.5 / §4）。
 *
 * Prisma/IdGenerator 全部 mock，覆盖：
 * - list：可见性（team_user_members → team_group 频道）、关键字、排序、内存分页；
 * - findOne：详情形状（name 回退 displayName、groups 群聊分布）、不可见 404；
 * - update：空串清空（null）、不存在/不可见 404；
 * - listMessages：可见频道 + externalUserId 过滤、游标分页与升序返回；
 * - resolveInboundIdentity：新建 / nameKey 吸收 / 升级 idKey / displayName 更新 / 竞态兜底；
 * - touchActivity / onModuleInit 续号。
 */
const USER_ID = 'u_0000000001';
const TEAM_ID = 'tm_0000000001';
const CHANNEL_ID = 'c_0000000001';

interface GroupRowOptions {
  externalUserId?: string;
  channelId?: string;
  count?: number;
  firstAt?: Date | null;
  lastAt?: Date | null;
}

function groupRow(options: GroupRowOptions = {}) {
  return {
    externalUserId: options.externalUserId ?? 'eu_0000000001',
    channelId: options.channelId ?? CHANNEL_ID,
    _count: { _all: options.count ?? 1 },
    _min: { createdAt: options.firstAt ?? null },
    _max: { createdAt: options.lastAt ?? null },
  };
}

/** 单用户×单频道的 groupBy 行（findOne 的 by: ['channelId'] 形状）。 */
function userChannelRow(
  channelId: string,
  count: number,
  firstAt: Date,
  lastAt: Date,
) {
  return {
    channelId,
    _count: { _all: count },
    _min: { createdAt: firstAt },
    _max: { createdAt: lastAt },
  };
}

function makeUser(overrides: Record<string, unknown> = {}) {
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

function createService() {
  const prisma: any = {
    teamUserMember: { findMany: jest.fn().mockResolvedValue([]) },
    chatChannel: { findMany: jest.fn().mockResolvedValue([]) },
    message: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    externalUser: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const idGen = {
    nextId: jest.fn().mockResolvedValue('eu_0000000001'),
    seed: jest.fn(),
  };
  const service = new ExternalUsersService(prisma as any, idGen as any);
  return { service, prisma, idGen };
}

/** 让 visibility 链路返回「一个团队 + 一个 team_group 频道」。 */
function allowVisibleChannel(prisma: any) {
  prisma.teamUserMember.findMany.mockResolvedValue([{ teamId: TEAM_ID }]);
  prisma.chatChannel.findMany.mockResolvedValue([
    { id: CHANNEL_ID, teamId: TEAM_ID, team: { name: 'vteam开发团队' } },
  ]);
}

describe('ExternalUsersService', () => {
  describe('list（可见性 + 关键字 + 排序 + 分页）', () => {
    it('只统计可见团队 team_group 频道里的 external 消息，并输出契约字段', async () => {
      const { service, prisma } = createService();
      allowVisibleChannel(prisma);
      const firstAt = new Date('2026-11-08T01:00:00.000Z');
      const lastAt = new Date('2026-11-10T07:42:00.000Z');
      prisma.message.groupBy.mockResolvedValue([
        // eu_1 在 c_1 / c_2 各发过消息 → messageCount=3、groupCount=2
        groupRow({
          channelId: CHANNEL_ID,
          count: 2,
          firstAt,
          lastAt: new Date('2026-11-09T01:00:00.000Z'),
        }),
        groupRow({
          channelId: 'c_0000000002',
          count: 1,
          firstAt,
          lastAt,
        }),
        // eu_2 较旧 → 排在后面
        groupRow({
          externalUserId: 'eu_0000000002',
          channelId: CHANNEL_ID,
          count: 1,
          firstAt,
          lastAt: new Date('2026-11-07T01:00:00.000Z'),
        }),
      ]);
      prisma.externalUser.findMany.mockResolvedValue([
        makeUser(),
        makeUser({
          id: 'eu_0000000002',
          externalId: 'name:老王',
          displayName: '老王',
          name: '王工',
        }),
      ]);
      // 当前页 lastMessageText：每用户一条 findFirst（id 倒序 limit 1，有界并发）
      prisma.message.findFirst
        .mockResolvedValueOnce({
          bodyText: '通过接口创建的告警默认是开启的',
          content: null,
        })
        .mockResolvedValueOnce({
          bodyText: null,
          content: { text: 'content 回退正文' },
        });

      const result = await service.list(USER_ID, {});

      // 可见性：team_user_members → team_group（未删除）频道
      expect(prisma.teamUserMember.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        select: { teamId: true },
      });
      expect(prisma.chatChannel.findMany).toHaveBeenCalledWith({
        where: {
          teamId: { in: [TEAM_ID] },
          type: 'team_group',
          deletedAt: null,
        },
        select: { id: true, teamId: true, team: { select: { name: true } } },
      });
      // 统计口径：只算 external 且 external_user_id 非空
      expect(prisma.message.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['externalUserId', 'channelId'],
          where: expect.objectContaining({
            channelId: { in: [CHANNEL_ID] },
            senderType: 'external',
            externalUserId: { not: null },
          }),
        }),
      );
      // lastMessageText 走每用户 findFirst（limit 1），不整包读回历史大 JSON
      expect(prisma.message.findFirst).toHaveBeenCalledTimes(2);
      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          externalUserId: 'eu_0000000001',
          channelId: { in: [CHANNEL_ID] },
          senderType: 'external',
        },
        orderBy: { id: 'desc' },
        select: { bodyText: true, content: true },
      });
      expect(prisma.message.findMany).not.toHaveBeenCalled();
      // 排序：最近发言倒序
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
      expect(result.items.map((item) => item.id)).toEqual([
        'eu_0000000001',
        'eu_0000000002',
      ]);
      expect(result.items[0]).toEqual({
        id: 'eu_0000000001',
        // name 未填 → 回退 displayName（后端已解析）
        name: '企微用户-Song',
        displayName: '企微用户-Song',
        position: null,
        company: null,
        contact: null,
        source: 'wecom_aibot',
        externalId: 'id:GuoLong',
        messageCount: 3,
        groupCount: 2,
        lastMessageAt: lastAt.toISOString(),
        lastMessageText: '通过接口创建的告警默认是开启的',
      });
      expect(result.items[1]).toMatchObject({
        name: '王工',
        messageCount: 1,
        groupCount: 1,
        lastMessageText: 'content 回退正文',
      });
    });

    it('无可见团队 → 直接空集，不查频道/消息', async () => {
      const { service, prisma } = createService();
      prisma.teamUserMember.findMany.mockResolvedValue([]);

      const result = await service.list(USER_ID, { page: 2, pageSize: 10 });

      expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 10 });
      expect(prisma.chatChannel.findMany).not.toHaveBeenCalled();
      expect(prisma.message.groupBy).not.toHaveBeenCalled();
    });

    it('关键字 trim 后匹配 name/displayName/company/position/contact/externalId', async () => {
      const { service, prisma } = createService();
      allowVisibleChannel(prisma);
      prisma.message.groupBy.mockResolvedValue([groupRow({ count: 1 })]);
      prisma.externalUser.findMany.mockResolvedValue([makeUser()]);

      await service.list(USER_ID, { keyword: '  宋工  ' });

      const where = prisma.externalUser.findMany.mock.calls[0][0].where;
      expect(where.id.in).toEqual(['eu_0000000001']);
      expect(where.OR).toEqual([
        { name: { contains: '宋工' } },
        { displayName: { contains: '宋工' } },
        { company: { contains: '宋工' } },
        { position: { contains: '宋工' } },
        { contact: { contains: '宋工' } },
        { externalId: { contains: '宋工' } },
      ]);
    });

    it('内存分页：total 为过滤后总数，超出页码返回空 items', async () => {
      const { service, prisma } = createService();
      allowVisibleChannel(prisma);
      prisma.message.groupBy.mockResolvedValue([
        groupRow({
          externalUserId: 'eu_1',
          count: 1,
          lastAt: new Date('2026-11-10T00:00:00.000Z'),
        }),
        groupRow({
          externalUserId: 'eu_2',
          count: 1,
          lastAt: new Date('2026-11-09T00:00:00.000Z'),
        }),
        groupRow({
          externalUserId: 'eu_3',
          count: 1,
          lastAt: new Date('2026-11-08T00:00:00.000Z'),
        }),
      ]);
      prisma.externalUser.findMany.mockResolvedValue([
        makeUser({ id: 'eu_1' }),
        makeUser({ id: 'eu_2' }),
        makeUser({ id: 'eu_3' }),
      ]);

      const page2 = await service.list(USER_ID, { page: 2, pageSize: 2 });
      expect(page2.total).toBe(3);
      expect(page2.items.map((item) => item.id)).toEqual(['eu_3']);

      const page9 = await service.list(USER_ID, { page: 9, pageSize: 2 });
      expect(page9.total).toBe(3);
      expect(page9.items).toEqual([]);
    });
  });

  describe('findOne（详情 + 404）', () => {
    it('返回详情字段与群聊分布（groups），firstMessageAt 列空时回退消息聚合', async () => {
      const { service, prisma } = createService();
      allowVisibleChannel(prisma);
      const firstAt = new Date('2026-11-05T03:00:00.000Z');
      const lastAt = new Date('2026-11-10T07:42:00.000Z');
      prisma.externalUser.findUnique.mockResolvedValue(makeUser());
      prisma.message.groupBy.mockResolvedValue([
        userChannelRow(CHANNEL_ID, 3, firstAt, lastAt),
      ]);
      prisma.message.findFirst.mockResolvedValue({
        bodyText: '通过接口创建的告警默认是开启的',
        content: null,
      });

      const detail = await service.findOne(USER_ID, 'eu_0000000001');

      expect(detail).toEqual({
        id: 'eu_0000000001',
        name: '企微用户-Song',
        displayName: '企微用户-Song',
        position: null,
        company: null,
        contact: null,
        source: 'wecom_aibot',
        externalId: 'id:GuoLong',
        messageCount: 3,
        groupCount: 1,
        lastMessageAt: lastAt.toISOString(),
        lastMessageText: '通过接口创建的告警默认是开启的',
        firstMessageAt: firstAt.toISOString(),
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
        groups: [
          {
            teamId: TEAM_ID,
            teamName: 'vteam开发团队',
            channelId: CHANNEL_ID,
            messageCount: 3,
            lastMessageAt: lastAt.toISOString(),
          },
        ],
      });
    });

    it('目录行不存在 → 404 EXTERNAL_USER_NOT_FOUND', async () => {
      const { service, prisma } = createService();
      prisma.externalUser.findUnique.mockResolvedValue(null);

      await expect(service.findOne(USER_ID, 'missing')).rejects.toMatchObject({
        response: { code: 'EXTERNAL_USER_NOT_FOUND' },
      });
      expect(prisma.teamUserMember.findMany).not.toHaveBeenCalled();
    });

    it('目录行存在但无可见消息（非调用者团队）→ 404（不暴露存在性）', async () => {
      const { service, prisma } = createService();
      prisma.externalUser.findUnique.mockResolvedValue(makeUser());
      allowVisibleChannel(prisma);
      prisma.message.groupBy.mockResolvedValue([]);

      await expect(
        service.findOne(USER_ID, 'eu_0000000001'),
      ).rejects.toMatchObject({
        response: { code: 'EXTERNAL_USER_NOT_FOUND' },
      });
    });
  });

  describe('update（空串清空 + 404）', () => {
    it('空串/null 存 null、只更新传入字段，返回更新后详情', async () => {
      const { service, prisma } = createService();
      allowVisibleChannel(prisma);
      const firstAt = new Date('2026-11-05T03:00:00.000Z');
      const lastAt = new Date('2026-11-10T07:42:00.000Z');
      prisma.message.groupBy.mockResolvedValue([
        userChannelRow(CHANNEL_ID, 1, firstAt, lastAt),
      ]);
      prisma.message.findFirst.mockResolvedValue({
        bodyText: 'hi',
        content: null,
      });
      // 第一次 findOne 读到旧资料，update 后再读一次（模拟 DB 已更新）
      prisma.externalUser.findUnique
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(
          makeUser({ name: null, position: null, company: '宁德时代' }),
        );
      prisma.externalUser.update.mockResolvedValue({});

      const detail = await service.update(USER_ID, 'eu_0000000001', {
        name: '',
        position: '   ',
        company: ' 宁德时代 ',
        // contact 未传 → 不改
      });

      expect(prisma.externalUser.update).toHaveBeenCalledWith({
        where: { id: 'eu_0000000001' },
        data: { name: null, position: null, company: '宁德时代' },
      });
      expect(detail.company).toBe('宁德时代');
      expect(detail.name).toBe('企微用户-Song'); // 数据库里 name=null → 回退展示名
    });

    it('不可见用户 → 404 且不写库（防越权改）', async () => {
      const { service, prisma } = createService();
      prisma.externalUser.findUnique.mockResolvedValue(makeUser());
      allowVisibleChannel(prisma);
      prisma.message.groupBy.mockResolvedValue([]);

      await expect(
        service.update(USER_ID, 'eu_0000000001', { name: '改名' }),
      ).rejects.toMatchObject({
        response: { code: 'EXTERNAL_USER_NOT_FOUND' },
      });
      expect(prisma.externalUser.update).not.toHaveBeenCalled();
    });
  });

  describe('listMessages（可见性 + 游标）', () => {
    it('过滤 externalUserId + 可见频道，取 limit+1 判 hasMore，items 升序、nextCursor=本页最早 id', async () => {
      const { service, prisma } = createService();
      allowVisibleChannel(prisma);
      prisma.externalUser.findUnique.mockResolvedValue(makeUser());
      // findOne gate 的统计：该用户有可见消息
      prisma.message.groupBy.mockResolvedValue([
        userChannelRow(
          CHANNEL_ID,
          3,
          new Date('2026-11-05T03:00:00.000Z'),
          new Date('2026-11-10T07:42:00.000Z'),
        ),
      ]);
      prisma.message.findFirst.mockResolvedValue({
        bodyText: 'hi',
        content: null,
      });
      // 第一次 findMany 只取 id（倒序、limit+1=3）；第二次按 id in 取整行
      const rowsById: Record<string, any> = {
        m_0000000003: {
          id: 'm_0000000003',
          channelId: CHANNEL_ID,
          bodyText: '第三条',
          content: null,
          attachments: [
            { url: '/uploads/a.png', name: 'a.png', size: 1, ext: 'png' },
          ],
          status: 'sent',
          createdAt: new Date('2026-11-10T03:00:00.000Z'),
        },
        m_0000000002: {
          id: 'm_0000000002',
          channelId: CHANNEL_ID,
          bodyText: '第二条',
          content: null,
          attachments: null,
          status: 'sent',
          createdAt: new Date('2026-11-09T03:00:00.000Z'),
        },
      };
      prisma.message.findMany
        .mockResolvedValueOnce([
          { id: 'm_0000000003' },
          { id: 'm_0000000002' },
          { id: 'm_0000000001' }, // 多出的第 3 条 → hasMore
        ])
        .mockResolvedValueOnce([rowsById.m_0000000003, rowsById.m_0000000002]);

      const result = await service.listMessages(USER_ID, 'eu_0000000001', {
        limit: 2,
      });

      const idQuery = prisma.message.findMany.mock.calls[0][0];
      expect(idQuery).toMatchObject({
        where: {
          externalUserId: 'eu_0000000001',
          channelId: { in: [CHANNEL_ID] },
          senderType: 'external',
        },
        orderBy: { id: 'desc' },
        take: 3,
        select: { id: true },
      });
      // items 为 id 升序（时间正序）
      expect(result.items.map((item) => item.id)).toEqual([
        'm_0000000002',
        'm_0000000003',
      ]);
      expect(result.nextCursor).toBe('m_0000000002');
      expect(result.items[1]).toEqual({
        id: 'm_0000000003',
        channelId: CHANNEL_ID,
        teamId: TEAM_ID,
        teamName: 'vteam开发团队',
        text: '第三条',
        attachments: [
          { url: '/uploads/a.png', name: 'a.png', size: 1, ext: 'png' },
        ],
        status: 'sent',
        createdAt: '2026-11-10T03:00:00.000Z',
      });
    });

    it('cursor 转成 id < cursor（下一页取更老）', async () => {
      const { service, prisma } = createService();
      allowVisibleChannel(prisma);
      prisma.externalUser.findUnique.mockResolvedValue(makeUser());
      prisma.message.groupBy.mockResolvedValue([
        userChannelRow(
          CHANNEL_ID,
          1,
          new Date('2026-11-05T03:00:00.000Z'),
          new Date('2026-11-10T07:42:00.000Z'),
        ),
      ]);
      prisma.message.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.listMessages(USER_ID, 'eu_0000000001', {
        cursor: 'm_0000000005',
        limit: 30,
      });

      expect(prisma.message.findMany.mock.calls[0][0].where.id).toEqual({
        lt: 'm_0000000005',
      });
      expect(result).toEqual({ items: [], nextCursor: null });
    });

    it('不可见用户 → 404 且不查消息', async () => {
      const { service, prisma } = createService();
      prisma.externalUser.findUnique.mockResolvedValue(makeUser());
      allowVisibleChannel(prisma);
      prisma.message.groupBy.mockResolvedValue([]);

      await expect(
        service.listMessages(USER_ID, 'eu_0000000001', {}),
      ).rejects.toMatchObject({
        response: { code: 'EXTERNAL_USER_NOT_FOUND' },
      });
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });
  });

  describe('resolveInboundIdentity（入站沉淀）', () => {
    it('都未命中且无 userid → 用 nameKey 新建（displayName 回退 externalId）', async () => {
      const { service, prisma, idGen } = createService();
      prisma.externalUser.findUnique.mockResolvedValue(null);
      prisma.externalUser.create.mockImplementation(({ data }: any) => ({
        ...data,
      }));

      const result = await service.resolveInboundIdentity({
        externalId: null,
        displayName: '宋工',
        source: 'generic_webhook',
      });

      // 无 idKey → 只按 nameKey 查一次
      expect(prisma.externalUser.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.externalUser.findUnique).toHaveBeenCalledWith({
        where: { externalId: 'name:宋工' },
      });
      expect(idGen.nextId).toHaveBeenCalledWith('eu');
      expect(prisma.externalUser.create).toHaveBeenCalledWith({
        data: {
          id: 'eu_0000000001',
          externalId: 'name:宋工',
          displayName: '宋工',
          source: 'generic_webhook',
        },
      });
      expect(result).toMatchObject({ externalId: 'name:宋工' });
    });

    it('有 userid → 优先 idKey 创建；两者都空 → 返回 null 不落库', async () => {
      const { service, prisma, idGen } = createService();
      prisma.externalUser.findUnique.mockResolvedValue(null);
      prisma.externalUser.create.mockImplementation(({ data }: any) => ({
        ...data,
      }));

      const created = await service.resolveInboundIdentity({
        externalId: 'GuoLong',
        displayName: '',
        source: 'wecom_aibot',
      });
      // displayName 空 → 回退 externalId
      expect(prisma.externalUser.create).toHaveBeenCalledWith({
        data: {
          id: 'eu_0000000001',
          externalId: 'id:GuoLong',
          displayName: 'GuoLong',
          source: 'wecom_aibot',
        },
      });
      expect(created).toMatchObject({ externalId: 'id:GuoLong' });

      prisma.externalUser.create.mockClear();
      idGen.nextId.mockClear();
      const none = await service.resolveInboundIdentity({});
      expect(none).toBeNull();
      expect(prisma.externalUser.create).not.toHaveBeenCalled();
      expect(idGen.nextId).not.toHaveBeenCalled();
    });

    it('nameKey 历史行命中 → 本次有 idKey 时升级 externalId 为 idKey', async () => {
      const { service, prisma } = createService();
      const legacy = makeUser({
        id: 'eu_bk_deadbeefdeadbeef',
        externalId: 'name:宋工',
        displayName: '宋工',
        source: 'legacy',
      });
      prisma.externalUser.findUnique
        .mockResolvedValueOnce(null) // idKey 未命中
        .mockResolvedValueOnce(legacy); // nameKey 命中
      prisma.externalUser.update.mockImplementation(({ data }: any) => ({
        ...legacy,
        ...data,
      }));

      const result = await service.resolveInboundIdentity({
        externalId: 'GuoLong',
        displayName: '宋工',
      });

      expect(prisma.externalUser.findUnique).toHaveBeenNthCalledWith(1, {
        where: { externalId: 'id:GuoLong' },
      });
      expect(prisma.externalUser.findUnique).toHaveBeenNthCalledWith(2, {
        where: { externalId: 'name:宋工' },
      });
      expect(prisma.externalUser.update).toHaveBeenCalledWith({
        where: { id: 'eu_bk_deadbeefdeadbeef' },
        data: { externalId: 'id:GuoLong' },
      });
      expect(result).toMatchObject({ externalId: 'id:GuoLong' });
    });

    it('idKey 已命中且 displayName 变化 → 只更新 displayName（管理字段 name 不被覆盖）', async () => {
      const { service, prisma } = createService();
      const row = makeUser({ displayName: '旧昵称', name: '宋工' });
      prisma.externalUser.findUnique.mockResolvedValueOnce(row);
      prisma.externalUser.update.mockImplementation(({ data }: any) => ({
        ...row,
        ...data,
      }));

      await service.resolveInboundIdentity({
        externalId: 'GuoLong',
        displayName: '新昵称',
      });

      expect(prisma.externalUser.update).toHaveBeenCalledWith({
        where: { id: 'eu_0000000001' },
        data: { displayName: '新昵称' },
      });
      // 管理字段 name 不出现在 patch 里
      const patch = prisma.externalUser.update.mock.calls[0][0].data;
      expect(patch).not.toHaveProperty('name');
    });

    it('idKey 命中且展示名未变 → 不写库，直接返回命中行', async () => {
      const { service, prisma } = createService();
      const row = makeUser();
      prisma.externalUser.findUnique.mockResolvedValueOnce(row);

      const result = await service.resolveInboundIdentity({
        externalId: 'GuoLong',
        displayName: '企微用户-Song',
      });

      expect(result).toBe(row);
      expect(prisma.externalUser.update).not.toHaveBeenCalled();
    });

    it('创建撞 P2002 竞态 → 重查一次已存在行并返回', async () => {
      const { service, prisma } = createService();
      const racedRow = makeUser();
      prisma.externalUser.findUnique
        .mockResolvedValueOnce(null) // idKey
        .mockResolvedValueOnce(null) // nameKey
        .mockResolvedValueOnce(racedRow); // 竞态重查
      prisma.externalUser.create.mockRejectedValue({ code: 'P2002' });

      const result = await service.resolveInboundIdentity({
        externalId: 'GuoLong',
        displayName: '企微用户-Song',
      });

      expect(prisma.externalUser.findUnique).toHaveBeenCalledTimes(3);
      expect(result).toBe(racedRow);
    });
  });

  describe('touchActivity（首条补 firstMessageAt，lastMessageAt 恒更新）', () => {
    it('firstMessageAt 为 null → 同时补首条与最近时间', async () => {
      const { service, prisma } = createService();
      prisma.externalUser.findUnique.mockResolvedValue({
        firstMessageAt: null,
      });
      prisma.externalUser.update.mockResolvedValue({});
      const at = new Date('2026-11-10T08:00:00.000Z');

      await service.touchActivity('eu_0000000001', at);

      expect(prisma.externalUser.update).toHaveBeenCalledWith({
        where: { id: 'eu_0000000001' },
        data: { lastMessageAt: at, firstMessageAt: at },
      });
    });

    it('firstMessageAt 已存在 → 只更新 lastMessageAt；行不存在 → 静默返回', async () => {
      const { service, prisma } = createService();
      prisma.externalUser.findUnique
        .mockResolvedValueOnce({
          firstMessageAt: new Date('2026-11-01T00:00:00.000Z'),
        })
        .mockResolvedValueOnce(null);
      prisma.externalUser.update.mockResolvedValue({});
      const at = new Date('2026-11-10T08:00:00.000Z');

      await service.touchActivity('eu_0000000001', at);
      expect(prisma.externalUser.update).toHaveBeenCalledWith({
        where: { id: 'eu_0000000001' },
        data: { lastMessageAt: at },
      });

      prisma.externalUser.update.mockClear();
      await service.touchActivity('eu_missing', at);
      expect(prisma.externalUser.update).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit（eu_ 前缀续号）', () => {
    it('按库内纯数字序号最大值 seed，跳过回填的 eu_bk_ 行', async () => {
      const { service, prisma, idGen } = createService();
      prisma.externalUser.findMany.mockResolvedValue([
        { id: 'eu_0000000003' },
        { id: 'eu_bk_deadbeefdeadbeef' },
        { id: 'eu_0000000001' },
      ]);

      await service.onModuleInit();

      expect(prisma.externalUser.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'eu_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('eu', 3);
    });
  });
});
