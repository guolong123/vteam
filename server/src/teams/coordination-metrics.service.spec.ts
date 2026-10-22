import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import {
  CoordinationMetricsResponse,
  CoordinationMetricsService,
} from './coordination-metrics.service';
import { COORDINATION_METRICS_ERRORS } from './coordination-metrics.constants';

/**
 * CoordinationMetricsService 单测（批次 E · 协调度指标）。
 *
 * 覆盖计划要求的四类：
 * 1. **窗口校验**：越界/非整数/不可解析的右端点 ⇒ 400（不静默截断，不扫全表）；
 * 2. **聚合查询**：PM 产出物数 / PM 消息占比 / 派发 vs 亲做 / 群私双报四条口径；
 * 3. **无数据**：窗口内无消息 ⇒ 全 0（不是错误，不出现 NaN）；
 * 4. **有界性**：消息只走 groupBy 聚合，`message.findMany` 永不被调用
 *    （原始消息行不进 node 内存）。
 *
 * 另有一组「查询语义」用例：**过滤器感知**的 mock（按 service 传下来的 where 真过滤）
 * ⇒ 「查询条件被删掉/写错」这类变异会真的把用例打红（变异证据见证据文件）。
 */
describe('CoordinationMetricsService', () => {
  let service: CoordinationMetricsService;
  let prisma: {
    team: { findUnique: jest.Mock };
    teamMember: { findMany: jest.Mock };
    chatChannel: { findMany: jest.Mock };
    message: { groupBy: jest.Mock; findMany: jest.Mock };
    artifact: { count: jest.Mock };
    artifactVersion: { groupBy: jest.Mock; count: jest.Mock };
    messageReceipt: { groupBy: jest.Mock };
    $queryRawUnsafe: jest.Mock;
  };

  const TEAM = 'tm_0000000001';
  const TO = '2026-10-22T00:00:00.000Z';
  const FROM = '2026-10-15T00:00:00.000Z';

  /** 团队成员（PM + 开发者 + 一个未绑岗位的成员）。 */
  const members = [
    {
      id: 'tmm_pm',
      agentId: 'a_pm',
      role: { key: 'project_manager', name: '项目经理', sortOrder: 2 },
    },
    {
      id: 'tmm_dev',
      agentId: 'a_dev',
      role: { key: 'developer', name: '开发者', sortOrder: 4 },
    },
    {
      id: 'tmm_free',
      agentId: 'a_free',
      role: null,
    },
  ];

  const channels = [
    { id: 'c_group', type: 'team_group' },
    { id: 'c_private', type: 'private' },
  ];

  beforeEach(async () => {
    prisma = {
      team: {
        findUnique: jest.fn().mockResolvedValue({ id: TEAM, name: '种子团队' }),
      },
      teamMember: { findMany: jest.fn().mockResolvedValue(members) },
      chatChannel: { findMany: jest.fn().mockResolvedValue(channels) },
      message: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn(),
      },
      artifact: { count: jest.fn().mockResolvedValue(7) },
      artifactVersion: {
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      messageReceipt: { groupBy: jest.fn().mockResolvedValue([]) },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ overlapCount: 0 }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoordinationMetricsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CoordinationMetricsService>(
      CoordinationMetricsService,
    );
  });

  /** 取指标（按 key）。 */
  function metric(res: CoordinationMetricsResponse, key: string) {
    const found = res.metrics.find((m) => m.key === key);
    if (!found) throw new Error(`metric ${key} missing`);
    return found;
  }

  describe('窗口校验', () => {
    it('窗口上限 720h：超限抛 400 COORDINATION_METRICS_WINDOW_INVALID（不静默截断）', async () => {
      await expect(
        service.getCoordinationMetrics(TEAM, { windowHours: 721 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.getCoordinationMetrics(TEAM, { windowHours: 721 }),
      ).rejects.toMatchObject({
        response: { code: COORDINATION_METRICS_ERRORS.WINDOW_INVALID },
      });
      expect(prisma.message.groupBy).not.toHaveBeenCalled();
    });

    it('窗口下界 1h：0 / 负数 / 非整数一律 400', async () => {
      for (const hours of [0, -1, 1.5, Number.NaN]) {
        await expect(
          service.getCoordinationMetrics(TEAM, { windowHours: hours }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('to 不是可解析时间 ⇒ 400（不做「当成现在」的静默兜底）', async () => {
      await expect(
        service.getCoordinationMetrics(TEAM, { to: 'not-a-date' }),
      ).rejects.toMatchObject({
        response: { code: COORDINATION_METRICS_ERRORS.WINDOW_INVALID },
      });
    });

    it('缺省窗口 = 168h（7 天），并把窗口下界写进查询条件', async () => {
      await service.getCoordinationMetrics(TEAM, {});

      const where = prisma.message.groupBy.mock.calls[0][0].where;
      const spanMs =
        where.createdAt.lte.getTime() - where.createdAt.gte.getTime();
      expect(spanMs).toBe(168 * 3_600_000);
    });

    it('显式 to + windowHours ⇒ 窗口 = [to - windowHours, to]（可复现历史窗口）', async () => {
      const res = await service.getCoordinationMetrics(TEAM, {
        to: TO,
        windowHours: 24,
      });

      expect(res.window.from).toBe('2026-10-21T00:00:00.000Z');
      expect(res.window.to).toBe(TO);
      expect(res.window.hours).toBe(24);
      expect(res.window.maxHours).toBe(720);
    });

    it('每条指标都自带覆盖窗口（自描述）', async () => {
      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      for (const m of res.metrics) {
        expect(m.window.from).toBe(FROM);
        expect(m.window.to).toBe(TO);
        expect(typeof m.name).toBe('string');
        expect(typeof m.value).toBe('number');
      }
    });

    it('响应可无损 JSON 序列化（detail 里没有漏 await 的 Promise）', async () => {
      prisma.artifactVersion.count.mockResolvedValue(0);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      // Promise 会被 JSON 序列化成 {} ⇒ 这条断言能抓住「漏 await」。
      expect(JSON.parse(JSON.stringify(res))).toEqual(res);
      expect(
        typeof metric(res, 'pm_artifact_count').detail.pmArtifactVersions,
      ).toBe('number');
    });
  });

  describe('团队与只读边界', () => {
    it('团队不存在 ⇒ 404 TEAM_NOT_FOUND', async () => {
      prisma.team.findUnique.mockResolvedValue(null);

      await expect(
        service.getCoordinationMetrics('tm_nope', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.getCoordinationMetrics('tm_nope', {}),
      ).rejects.toMatchObject({
        response: { code: COORDINATION_METRICS_ERRORS.TEAM_NOT_FOUND },
      });
    });

    it('只读：不写库（全程无 create/update/delete 调用面）', async () => {
      await service.getCoordinationMetrics(TEAM, { to: TO });

      const prismaKeys = Object.keys(prisma);
      for (const key of prismaKeys) {
        const model = prisma[key as keyof typeof prisma] as Record<
          string,
          unknown
        >;
        for (const method of ['create', 'update', 'delete', 'upsert']) {
          expect(model[method]).toBeUndefined();
        }
      }
    });
  });

  describe('指标 ①：PM 产出物数（目标恒 0）', () => {
    it('PM 未产出任何交付物 ⇒ 0 且 ok=true', async () => {
      prisma.artifactVersion.groupBy.mockResolvedValue([
        { artifactId: 'art_1', authorAgentId: null },
        { artifactId: 'art_2', authorAgentId: 'a_dev' },
      ]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_artifact_count');

      expect(m.value).toBe(0);
      expect(m.unit).toBe('count');
      expect(m.target).toEqual({ operator: '=', value: 0 });
      expect(m.ok).toBe(true);
    });

    it('PM 产出过交付物 ⇒ 计数 > 0 且 ok=false（越界可见）', async () => {
      prisma.artifactVersion.groupBy.mockResolvedValue([
        { artifactId: 'art_9', authorAgentId: 'a_pm' },
        { artifactId: 'art_9', authorAgentId: 'a_pm' },
        { artifactId: 'art_10', authorAgentId: 'a_dev' },
      ]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_artifact_count');

      expect(m.value).toBe(1); // 同一产出物多版本只算 1 个
      expect(m.ok).toBe(false);
      expect(m.detail.teamArtifacts).toBe(7);
    });
  });

  describe('指标 ②：PM 消息占比 + 岗位分解', () => {
    beforeEach(() => {
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_pm', channelId: 'c_group', _count: { _all: 106 } },
        { senderId: 'a_pm', channelId: 'c_private', _count: { _all: 0 } },
        { senderId: 'a_dev', channelId: 'c_group', _count: { _all: 5 } },
      ]);
    });

    it('PM 占比 = PM 消息 / 全团队 agent 消息（基线 106/111）', async () => {
      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_message_share');

      expect(res.totalAgentMessages).toBe(111);
      expect(m.value).toBeCloseTo(106 / 111, 6);
      expect(m.unit).toBe('ratio');
      expect(m.detail.pmMessages).toBe(106);
      expect(m.detail.totalAgentMessages).toBe(111);
    });

    it('岗位分解之和 == 全团队 agent 消息数（不重复计数、不丢消息）', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_pm', channelId: 'c_group', _count: { _all: 106 } },
        { senderId: 'a_dev', channelId: 'c_group', _count: { _all: 5 } },
        { senderId: 'a_free', channelId: 'c_group', _count: { _all: 4 } },
      ]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const sum = res.roles.reduce((s, r) => s + r.messages, 0);

      expect(sum).toBe(res.totalAgentMessages);
      expect(res.roles.find((r) => r.roleKey === 'unassigned')?.messages).toBe(
        4,
      );
    });

    it('一个 Agent 被多岗位复用 ⇒ 归岗位序最靠前者（不重复计数）', async () => {
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_1',
          agentId: 'a_shared',
          role: { key: 'developer', name: '开发者', sortOrder: 4 },
        },
        {
          id: 'tmm_2',
          agentId: 'a_shared',
          role: { key: 'plan', name: '计划员', sortOrder: 6 },
        },
      ]);
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_shared', channelId: 'c_group', _count: { _all: 5 } },
      ]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      expect(res.totalAgentMessages).toBe(5);
      expect(res.roles.find((r) => r.roleKey === 'developer')?.messages).toBe(
        5,
      );
      expect(res.roles.find((r) => r.roleKey === 'plan')?.messages).toBe(0);
    });

    it('消息只走聚合：message.findMany 永不被调用（原始行不进内存）', async () => {
      await service.getCoordinationMetrics(TEAM, { to: TO });

      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(prisma.message.groupBy).toHaveBeenCalled();
    });

    it('聚合查询带窗口与团队频道范围（不扫全表）', async () => {
      await service.getCoordinationMetrics(TEAM, { to: TO });

      const call = prisma.message.groupBy.mock.calls[0][0];
      expect(call.by).toEqual(['senderId', 'channelId']);
      expect(call.where.channelId).toEqual({ in: ['c_group', 'c_private'] });
      expect(call.where.senderType).toBe('agent');
      expect(call.where.createdAt.gte.toISOString()).toBe(FROM);
      expect(call.where.createdAt.lte.toISOString()).toBe(TO);
    });
  });

  describe('指标 ③：派发 vs 亲做', () => {
    it('派发数 = message_receipts 的 dispatch 行数；亲做 = PM 消息 − 派发通告', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_pm', channelId: 'c_group', _count: { _all: 106 } },
      ]);
      prisma.messageReceipt.groupBy.mockResolvedValue([
        { messageId: 'm_1', _count: { _all: 1 } },
        { messageId: 'm_2', _count: { _all: 1 } },
      ]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_dispatch_vs_self_execution');

      expect(m.detail.dispatches).toBe(2);
      expect(m.detail.dispatchMessages).toBe(2);
      expect(m.detail.pmMessages).toBe(106);
      expect(m.value).toBe(104); // 106 − 2
      expect(m.detail.selfConclusions).toBe(104);
      expect(m.detail.dispatchShare).toBeCloseTo(2 / 106, 6);
    });

    it('一次 fan-out 多目标 = 多行回执 = 多次派发（按行计）', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_pm', channelId: 'c_group', _count: { _all: 10 } },
      ]);
      prisma.messageReceipt.groupBy.mockResolvedValue([
        { messageId: 'm_1', _count: { _all: 3 } },
      ]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_dispatch_vs_self_execution');

      expect(m.detail.dispatches).toBe(3);
      expect(m.detail.dispatchMessages).toBe(1);
      expect(m.value).toBe(9);
    });

    it('派发查询限定 PM 成员 + 团队 + dispatch 类型（不扫别人的账）', async () => {
      await service.getCoordinationMetrics(TEAM, { to: TO });

      const call = prisma.messageReceipt.groupBy.mock.calls[0][0];
      expect(call.where.teamId).toBe(TEAM);
      expect(call.where.kind).toBe('dispatch');
      expect(call.where.fromInstanceId).toEqual({ in: ['tmm_pm'] });
      expect(call.where.createdAt.lte.toISOString()).toBe(TO);
    });
  });

  describe('指标 ④：群聊 + 私聊双报', () => {
    it('粗口径：私聊占比 + 群私条数（本地基线 群 67 / 私 39）', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_pm', channelId: 'c_group', _count: { _all: 67 } },
        { senderId: 'a_pm', channelId: 'c_private', _count: { _all: 39 } },
      ]);
      prisma.$queryRawUnsafe.mockResolvedValue([{ overlapCount: 0 }]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_group_private_double_report');

      expect(m.detail.groupMessages).toBe(67);
      expect(m.detail.privateMessages).toBe(39);
      expect(m.detail.privateShare).toBeCloseTo(39 / 106, 6);
      expect(m.value).toBeCloseTo(39 / 106, 6);
      expect(m.detail.balanceRatio).toBeCloseTo(39 / 67, 6);
      expect(m.detail.exactTextOverlapMessages).toBe(0);
    });

    it('精确同文重合：DB 侧聚合返回的计数透传（逐字相同才算）', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_pm', channelId: 'c_group', _count: { _all: 2 } },
        { senderId: 'a_pm', channelId: 'c_private', _count: { _all: 2 } },
      ]);
      prisma.$queryRawUnsafe.mockResolvedValue([{ overlapCount: 2n }]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_group_private_double_report');

      expect(m.detail.exactTextOverlapMessages).toBe(2);
    });

    it('同文判定失败 ⇒ 降级 null 且不抛（观测面不因补充信号整体挂掉）', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_pm', channelId: 'c_group', _count: { _all: 1 } },
      ]);
      prisma.$queryRawUnsafe.mockRejectedValue(new Error('boom'));

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_group_private_double_report');

      expect(m.detail.exactTextOverlapMessages).toBeNull();
      expect(typeof m.value).toBe('number');
    });
  });

  describe('无数据窗口 ⇒ 全 0（不是错误）', () => {
    it('窗口内无任何消息 ⇒ 指标全 0、占比 0（不出现 NaN）', async () => {
      prisma.message.groupBy.mockResolvedValue([]);
      prisma.artifactVersion.groupBy.mockResolvedValue([]);
      prisma.messageReceipt.groupBy.mockResolvedValue([]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      expect(res.totalAgentMessages).toBe(0);
      for (const m of res.metrics) {
        expect(Number.isFinite(m.value)).toBe(true);
        expect(m.value).toBe(0);
      }
      expect(metric(res, 'pm_message_share').value).toBe(0);
      expect(metric(res, 'pm_dispatch_vs_self_execution').value).toBe(0);
      expect(res.roles.every((r) => r.messages === 0)).toBe(true);
    });

    it('团队没有任何频道 ⇒ 直接跳过消息聚合（不构造空 IN 查询）', async () => {
      prisma.chatChannel.findMany.mockResolvedValue([]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      expect(prisma.message.groupBy).not.toHaveBeenCalled();
      expect(res.totalAgentMessages).toBe(0);
      expect(metric(res, 'pm_artifact_count').value).toBe(0);
    });

    it('团队没有 PM 成员 ⇒ PM 相关指标全 0（不报错、不误报）', async () => {
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_dev',
          agentId: 'a_dev',
          role: { key: 'developer', name: '开发者', sortOrder: 4 },
        },
      ]);
      prisma.message.groupBy.mockResolvedValue([
        { senderId: 'a_dev', channelId: 'c_group', _count: { _all: 5 } },
      ]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      expect(metric(res, 'pm_message_share').value).toBe(0);
      expect(metric(res, 'pm_dispatch_vs_self_execution').value).toBe(0);
      expect(metric(res, 'pm_group_private_double_report').value).toBe(0);
      expect(prisma.messageReceipt.groupBy).not.toHaveBeenCalled();
    });

    it('agent 消息缺 sender_id ⇒ 计入总数并落 unassigned 桶（分解之和 == 总数）', async () => {
      prisma.message.groupBy.mockResolvedValue([
        { senderId: null, channelId: 'c_group', _count: { _all: 3 } },
        { senderId: 'a_dev', channelId: 'c_group', _count: { _all: 5 } },
      ]);

      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      expect(res.totalAgentMessages).toBe(8);
      expect(res.roles.find((r) => r.roleKey === 'unassigned')?.messages).toBe(
        3,
      );
      expect(res.roles.reduce((s, r) => s + r.messages, 0)).toBe(
        res.totalAgentMessages,
      );
    });
  });

  /**
   * 查询语义：**过滤器感知**的 mock —— 按 service 真正传下来的 where 过滤夹具。
   *
   * 为什么单列一组：前面的用例用「预聚合行」验证口径算术；这里验证**查询条件本身**
   * （窗口 / 频道范围 / 发送方类型 / 团队 / 回执 kind / 派发方）真的下推到了 DB 侧。
   * 夹具里刻意放了「会被错误条件捞进来」的行（窗口外、非 agent、别队频道、别队产出物、
   * 非 dispatch 回执、别人派发的回执）⇒ 一旦查询条件被删掉/写错，用例立刻转红。
   */
  describe('查询语义（where 真的下推到 DB 侧）', () => {
    interface MessageFixture {
      senderId: string;
      channelId: string;
      senderType: string;
      createdAt: Date;
      n: number;
    }
    interface ArtifactFixture {
      artifactId: string;
      authorAgentId: string | null;
      teamId: string;
      createdAt: Date;
    }
    interface ReceiptFixture {
      messageId: string;
      fromInstanceId: string;
      teamId: string;
      kind: string;
      createdAt: Date;
    }

    const messageFixture: MessageFixture[] = [
      {
        senderId: 'a_pm',
        channelId: 'c_group',
        senderType: 'agent',
        createdAt: new Date('2026-10-20T10:00:00Z'),
        n: 67,
      },
      {
        senderId: 'a_pm',
        channelId: 'c_private',
        senderType: 'agent',
        createdAt: new Date('2026-10-20T11:00:00Z'),
        n: 39,
      },
      {
        senderId: 'a_dev',
        channelId: 'c_group',
        senderType: 'agent',
        createdAt: new Date('2026-10-20T12:00:00Z'),
        n: 5,
      },
      // ↓ 三行是「不该被算进来」的：窗口外 / 非 agent / 别队频道
      {
        senderId: 'a_pm',
        channelId: 'c_group',
        senderType: 'agent',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        n: 999,
      },
      {
        senderId: 'a_pm',
        channelId: 'c_group',
        senderType: 'user',
        createdAt: new Date('2026-10-21T00:00:00Z'),
        n: 777,
      },
      {
        senderId: 'a_pm',
        channelId: 'c_other',
        senderType: 'agent',
        createdAt: new Date('2026-10-21T00:00:00Z'),
        n: 888,
      },
    ];

    const artifactFixture: ArtifactFixture[] = [
      {
        artifactId: 'art_dev',
        authorAgentId: 'a_dev',
        teamId: TEAM,
        createdAt: new Date('2026-10-20T10:00:00Z'),
      },
      // ↓ 窗口外的 PM 产出物 + 别队的 PM 产出物：都不该算
      {
        artifactId: 'art_pm_old',
        authorAgentId: 'a_pm',
        teamId: TEAM,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      },
      {
        artifactId: 'art_other_team',
        authorAgentId: 'a_pm',
        teamId: 'tm_other',
        createdAt: new Date('2026-10-20T10:00:00Z'),
      },
    ];

    const receiptFixture: ReceiptFixture[] = [
      {
        messageId: 'm_1',
        fromInstanceId: 'tmm_pm',
        teamId: TEAM,
        kind: 'dispatch',
        createdAt: new Date('2026-10-20T10:00:00Z'),
      },
      {
        messageId: 'm_2',
        fromInstanceId: 'tmm_pm',
        teamId: TEAM,
        kind: 'dispatch',
        createdAt: new Date('2026-10-20T11:00:00Z'),
      },
      // ↓ 非 dispatch 回执 / 别人派发的回执 / 窗口外的回执：都不该算
      {
        messageId: 'm_3',
        fromInstanceId: 'tmm_pm',
        teamId: TEAM,
        kind: 'wake',
        createdAt: new Date('2026-10-20T11:00:00Z'),
      },
      {
        messageId: 'm_4',
        fromInstanceId: 'tmm_dev',
        teamId: TEAM,
        kind: 'dispatch',
        createdAt: new Date('2026-10-20T11:00:00Z'),
      },
      {
        messageId: 'm_5',
        fromInstanceId: 'tmm_pm',
        teamId: TEAM,
        kind: 'dispatch',
        createdAt: new Date('2026-09-01T00:00:00Z'),
      },
    ];

    /** 按 where 过滤消息（模拟 DB 侧窗口 + 频道 + senderType 过滤）。 */
    const filterMessages = (where: Record<string, any>): MessageFixture[] => {
      const channelIds: string[] | undefined = where.channelId?.in;
      const from: number | undefined = where.createdAt?.gte?.getTime?.();
      const to: number | undefined = where.createdAt?.lte?.getTime?.();
      return messageFixture.filter((r) => {
        if (channelIds && !channelIds.includes(r.channelId)) return false;
        if (where.senderType && r.senderType !== where.senderType) return false;
        if (from !== undefined && r.createdAt.getTime() < from) return false;
        if (to !== undefined && r.createdAt.getTime() > to) return false;
        return true;
      });
    };

    /** 按 where 过滤产出物版本（团队 + 窗口）。 */
    const filterArtifacts = (where: Record<string, any>): ArtifactFixture[] => {
      const teamId: string | undefined = where.artifact?.task?.teamId;
      const from: number | undefined = where.createdAt?.gte?.getTime?.();
      const to: number | undefined = where.createdAt?.lte?.getTime?.();
      return artifactFixture.filter((r) => {
        if (teamId && r.teamId !== teamId) return false;
        if (from !== undefined && r.createdAt.getTime() < from) return false;
        if (to !== undefined && r.createdAt.getTime() > to) return false;
        return true;
      });
    };

    /** 按 where 过滤回执（团队 + kind + 派发方 + 窗口）。 */
    const filterReceipts = (where: Record<string, any>): ReceiptFixture[] => {
      const from: number | undefined = where.createdAt?.gte?.getTime?.();
      const to: number | undefined = where.createdAt?.lte?.getTime?.();
      const fromInstances: string[] | undefined = where.fromInstanceId?.in;
      return receiptFixture.filter((r) => {
        if (where.teamId && r.teamId !== where.teamId) return false;
        if (where.kind && r.kind !== where.kind) return false;
        if (fromInstances && !fromInstances.includes(r.fromInstanceId)) {
          return false;
        }
        if (from !== undefined && r.createdAt.getTime() < from) return false;
        if (to !== undefined && r.createdAt.getTime() > to) return false;
        return true;
      });
    };

    beforeEach(() => {
      prisma.message.groupBy.mockImplementation((args: any) => {
        const kept = filterMessages(args.where);
        const buckets = new Map<string, number>();
        for (const row of kept) {
          const key = `${row.senderId}|${row.channelId}`;
          buckets.set(key, (buckets.get(key) ?? 0) + row.n);
        }
        return Promise.resolve(
          [...buckets.entries()].map(([key, n]) => {
            const [senderId, channelId] = key.split('|');
            return { senderId, channelId, _count: { _all: n } };
          }),
        );
      });
      prisma.artifactVersion.groupBy.mockImplementation((args: any) =>
        Promise.resolve(
          filterArtifacts(args.where).map((r) => ({
            artifactId: r.artifactId,
            authorAgentId: r.authorAgentId,
          })),
        ),
      );
      prisma.artifactVersion.count.mockImplementation((args: any) =>
        Promise.resolve(
          filterArtifacts(args.where).filter(
            (r) =>
              !args.where.authorAgentId?.in ||
              args.where.authorAgentId.in.includes(r.authorAgentId ?? ''),
          ).length,
        ),
      );
      prisma.messageReceipt.groupBy.mockImplementation((args: any) => {
        const kept = filterReceipts(args.where);
        const buckets = new Map<string, number>();
        for (const row of kept) {
          buckets.set(row.messageId, (buckets.get(row.messageId) ?? 0) + 1);
        }
        return Promise.resolve(
          [...buckets.entries()].map(([messageId, n]) => ({
            messageId,
            _count: { _all: n },
          })),
        );
      });
    });

    it('消息口径：窗口外的行 / 非 agent 行 / 别队频道的行都不计入', async () => {
      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      expect(res.totalAgentMessages).toBe(111);
      expect(metric(res, 'pm_message_share').detail.pmMessages).toBe(106);
      expect(metric(res, 'pm_message_share').value).toBeCloseTo(106 / 111, 6);
    });

    it('产出物口径：窗口外的 PM 产出物 / 别队的 PM 产出物都不计入', async () => {
      const res = await service.getCoordinationMetrics(TEAM, { to: TO });

      expect(metric(res, 'pm_artifact_count').value).toBe(0);
      expect(metric(res, 'pm_artifact_count').ok).toBe(true);
    });

    it('派发口径：非 dispatch 回执 / 别人派发的回执 / 窗口外的回执都不计入', async () => {
      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_dispatch_vs_self_execution');

      expect(m.detail.dispatches).toBe(2);
      expect(m.detail.dispatchMessages).toBe(2);
      expect(m.value).toBe(104);
    });

    it('双报口径：群聊/私聊按频道类型分桶（窗口外与别队频道不进私聊桶）', async () => {
      const res = await service.getCoordinationMetrics(TEAM, { to: TO });
      const m = metric(res, 'pm_group_private_double_report');

      expect(m.detail.groupMessages).toBe(67);
      expect(m.detail.privateMessages).toBe(39);
      expect(m.detail.privateShare).toBeCloseTo(39 / 106, 6);
    });
  });
});
