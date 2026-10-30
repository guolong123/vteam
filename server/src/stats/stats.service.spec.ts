import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { STATS_ERRORS, STATS_MAX_WINDOW_DAYS } from './stats.constants';
import { StatsService, emptyTotals, QUEUE_WAIT_SOURCE } from './stats.service';

/**
 * StatsService 测试（口径正确性 + 鉴权门 + 边界）。
 *
 * 重点不是「有没有返回」，而是「数字口径对不对」：
 * - 未知 ≠ 0（cost 全 NULL ⇒ null，不是 0）
 * - 去重产出物 ≠ 版本数（两列独立相加）
 * - 桶求和 == 窗口总量（前端要靠这条对账指标卡与趋势图）
 * - 窗口上限不静默截断（超 90 天直接 400）
 * - 两个端点的门禁不同（overview 管理员 / teamDetail 成员）
 */

/** 构造一条日粒度聚合行（$queryRaw 的返回形状）。 */
function dayRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    day: '2026-10-30',
    teamId: 'tm_1',
    tasksCreated: 3,
    tasksCompleted: 2,
    tasksBlocked: 0,
    tasksRejected: 0,
    artifacts: 4,
    artifactVersions: 6,
    inputTokens: 1000,
    outputTokens: 200,
    reasoningTokens: 0,
    cacheReadTokens: 5000,
    cacheWriteTokens: 100,
    costSum: 1.5,
    costKnown: 1,
    agentMessages: 20,
    ...over,
  };
}

describe('StatsService', () => {
  let service: StatsService;
  let prisma: {
    $queryRawUnsafe: jest.Mock;
    team: { findMany: jest.Mock; findUnique: jest.Mock };
    task: { findMany: jest.Mock; groupBy: jest.Mock };
    taskEvent: { findMany: jest.Mock };
    artifact: { groupBy: jest.Mock };
    artifactVersion: { findMany: jest.Mock };
    modelUsage: { groupBy: jest.Mock };
    teamMember: { findMany: jest.Mock };
    message: { groupBy: jest.Mock };
    session: { findMany: jest.Mock };
    teamUserMember: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      team: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'tm_1',
            name: '团队一',
            description: 'desc',
            _count: { members: 3 },
          },
        ]),
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'tm_1', name: '团队一', description: null }),
      },
      task: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      taskEvent: { findMany: jest.fn().mockResolvedValue([]) },
      artifact: { groupBy: jest.fn().mockResolvedValue([]) },
      artifactVersion: { findMany: jest.fn().mockResolvedValue([]) },
      modelUsage: { groupBy: jest.fn().mockResolvedValue([]) },
      teamMember: { findMany: jest.fn().mockResolvedValue([]) },
      message: { groupBy: jest.fn().mockResolvedValue([]) },
      session: { findMany: jest.fn().mockResolvedValue([]) },
      teamUserMember: { findUnique: jest.fn().mockResolvedValue(null) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [StatsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<StatsService>(StatsService);
  });

  describe('空数据（零值结构，不抛错）', () => {
    it('空团队列表 → overview 返回零值总量而不是报错', async () => {
      const result = await service.overview({ days: 30, granularity: 'day' });
      const zero = emptyTotals();
      expect(result.totals).toEqual(zero);
      // 仍要返回完整的桶序列（横轴连续，不能因为没数据就不画）
      expect(result.buckets.length).toBe(30);
      expect(result.teams).toHaveLength(1); // mock 里有一个团队
      expect(result.firstPassRate).toBe(0);
    });

    it('空数据时 cost 为 null（未知），不是 0（免费）', async () => {
      const result = await service.overview({ days: 30, granularity: 'day' });
      expect(result.totals.cost).toBeNull();
      expect(result.totals.costPerTask).toBeNull();
      expect(result.totals.costPerArtifact).toBeNull();
    });
  });

  describe('总量口径（deriveTotals 经 overview 暴露）', () => {
    it('token 六元组：totalTokens = 五元组之和，不读 total_tokens 列', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({
          inputTokens: 1000,
          outputTokens: 200,
          reasoningTokens: 30,
          cacheReadTokens: 5000,
          cacheWriteTokens: 100,
        }),
      ]);
      const result = await service.overview({ days: 1, granularity: 'day' });
      expect(result.totals.totalTokens).toBe(1000 + 200 + 30 + 5000 + 100);
    });

    it('缓存命中率分母取 input+cacheRead（不含 cacheWrite）', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({
          inputTokens: 1000,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 5000,
          cacheWriteTokens: 100,
        }),
      ]);
      const result = await service.overview({ days: 1, granularity: 'day' });
      // 5000 / (1000 + 5000) = 0.8333，若把 cacheWrite 计入分母会得到 0.8196
      expect(result.totals.cacheHitRate).toBeCloseTo(5000 / 6000, 6);
      expect(result.totals.cacheHitRate).not.toBeCloseTo(5000 / 6100, 4);
    });

    it('去重产出物与版本数是两个独立字段（不可相加）', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({ artifacts: 4, artifactVersions: 9 }),
      ]);
      const result = await service.overview({ days: 1, granularity: 'day' });
      expect(result.totals.artifacts).toBe(4);
      expect(result.totals.artifactVersions).toBe(9);
    });

    it('cost 已知时按完成任务/产出物派生每单位成本', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({ tasksCompleted: 2, artifacts: 4, costSum: 2.0, costKnown: 1 }),
      ]);
      const result = await service.overview({ days: 1, granularity: 'day' });
      expect(result.totals.cost).toBe(2);
      expect(result.totals.costPerTask).toBe(1);
      expect(result.totals.costPerArtifact).toBe(0.5);
    });

    it('cost 全未知（costKnown=0）→ null 且 costUnknownRatio=1', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({ costSum: 0, costKnown: 0 }),
      ]);
      const result = await service.overview({ days: 1, granularity: 'day' });
      expect(result.totals.cost).toBeNull();
      expect(result.totals.costUnknownRatio).toBe(1);
    });

    it('🔴 成本部分已知时，每单位成本一律 null（不给「基于部分数据的假精确值」）', async () => {
      // 现实场景：cost=0（已知那部分确实是 0）+ 40% 日行未知。
      // 若用 0 / 产出物 会得到 $0.00 —— 看起来精确，其实是系统性偏小的假数。
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({ day: '2026-10-29', costSum: 2, costKnown: 1 }),
        dayRow({ day: '2026-10-30', costSum: 0, costKnown: 0 }),
      ]);
      const result = await service.overview({ days: 2, granularity: 'day' });
      expect(result.totals.cost).toBe(2); // 已知部分之和
      expect(result.totals.costUnknownRatio).toBe(0.5);
      // 关键断言：三个每单位成本都必须是 null，不能是 2/2=1 或 0/x=0
      expect(result.totals.costPerTask).toBeNull();
      expect(result.totals.costPerArtifact).toBeNull();
      expect(result.totals.costPerKToken).toBeNull();
    });

    it('成本全窗已知（ratio=0）→ 每单位成本正常返回', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({ day: '2026-10-29', costSum: 1, costKnown: 1 }),
        dayRow({ day: '2026-10-30', costSum: 1, costKnown: 1, tasksCompleted: 2, artifacts: 4 }),
      ]);
      const result = await service.overview({ days: 2, granularity: 'day' });
      expect(result.totals.costUnknownRatio).toBe(0);
      expect(result.totals.costPerTask).not.toBeNull();
      expect(result.totals.costPerArtifact).not.toBeNull();
    });

    it('cost 部分未知 → 给已知部分之和 + 覆盖率（不假装全额已知）', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({ day: '2026-10-29', costSum: 2, costKnown: 1 }),
        dayRow({ day: '2026-10-30', costSum: 0, costKnown: 0 }),
      ]);
      const result = await service.overview({ days: 2, granularity: 'day' });
      expect(result.totals.cost).toBe(2);
      expect(result.totals.costUnknownRatio).toBe(0.5);
    });

    it('零任务时 completionRate 为 0（不是 NaN）', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({ tasksCreated: 0, tasksCompleted: 0 }),
      ]);
      const result = await service.overview({ days: 1, granularity: 'day' });
      expect(result.totals.completionRate).toBe(0);
    });
  });

  describe('🔴 驳回判定（event_type 而非 to_status）', () => {
    it('countRework 只认 event_type=reject（首次 start 不算返工）', async () => {
      // 真实库实况：6 条 status_change(pending→in_progress) 是「首次开始」，
      // 若按 to_status='in_progress' 判定会被全部误算成驳回。
      prisma.taskEvent.findMany.mockResolvedValue([]);
      const result = await service.overview({ days: 30, granularity: 'day' });
      expect(result.reworkCount).toBe(0);
      // 查询必须带 eventType: 'reject'，绝不能只看 toStatus
      expect(prisma.taskEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ eventType: 'reject' }),
        }),
      );
    });

    it('真正的 reject 事件计入返工（去重任务）', async () => {
      prisma.taskEvent.findMany.mockResolvedValue([
        { taskId: 't_1' },
        { taskId: 't_1' }, // 同一任务多次驳回只计一次
        { taskId: 't_2' },
      ]);
      prisma.$queryRawUnsafe.mockResolvedValue([dayRow({ tasksCompleted: 3 })]);
      const result = await service.overview({ days: 30, granularity: 'day' });
      expect(result.reworkCount).toBe(2);
    });

    it('一次通过率 = (completed - rework) / completed', async () => {
      prisma.taskEvent.findMany.mockResolvedValue([{ taskId: 't_1' }]);
      prisma.$queryRawUnsafe.mockResolvedValue([dayRow({ tasksCompleted: 4 })]);
      const result = await service.overview({ days: 30, granularity: 'day' });
      expect(result.firstPassRate).toBeCloseTo((4 - 1) / 4, 6);
    });

    it('无完成任务时一次通过率为 0（不是 NaN / 负数）', async () => {
      prisma.taskEvent.findMany.mockResolvedValue([{ taskId: 't_1' }]);
      prisma.$queryRawUnsafe.mockResolvedValue([dayRow({ tasksCompleted: 0 })]);
      const result = await service.overview({ days: 30, granularity: 'day' });
      expect(result.firstPassRate).toBe(0);
    });
  });

  describe('时间桶（横轴连续 + 桶求和 == 窗口总量）', () => {
    it('桶数 = 窗口天数（日粒度），缺数据的桶补零', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([
        dayRow({ day: '2026-10-01', tasksCreated: 3 }),
        // 中间大片空档不返回行，验证枚举补齐
        dayRow({ day: '2026-10-30', tasksCreated: 2 }),
      ]);
      const result = await service.overview({
        days: 30,
        to: '2026-10-30',
        granularity: 'day',
      });
      expect(result.buckets).toHaveLength(30);
      const withData = result.buckets.filter((b) => b.totals.tasksCreated > 0);
      expect(withData).toHaveLength(2);
      // 空桶的 tasksCreated 是 0
      expect(result.buckets[1].totals.tasksCreated).toBe(0);
    });

    it('🔴 桶求和 == 窗口总量（前端对账的硬约束）', async () => {
      const rows = [
        dayRow({
          day: '2026-10-01',
          tasksCreated: 3,
          tasksCompleted: 2,
          artifacts: 4,
        }),
        dayRow({
          day: '2026-10-05',
          tasksCreated: 1,
          tasksCompleted: 1,
          artifacts: 2,
        }),
        dayRow({
          day: '2026-10-30',
          tasksCreated: 4,
          tasksCompleted: 3,
          artifacts: 5,
        }),
      ];
      prisma.$queryRawUnsafe.mockResolvedValue(rows);
      for (const g of ['day', 'week', 'month'] as const) {
        const result = await service.overview({
          days: 30,
          to: '2026-10-30',
          granularity: g,
        });
        const sumCreated = result.buckets.reduce(
          (a, b) => a + b.totals.tasksCreated,
          0,
        );
        const sumArtifacts = result.buckets.reduce(
          (a, b) => a + b.totals.artifacts,
          0,
        );
        expect(sumCreated).toBe(result.totals.tasksCreated);
        expect(sumArtifacts).toBe(result.totals.artifacts);
      }
    });

    it('周粒度桶键为周一日期', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([dayRow({ day: '2026-10-30' })]);
      const result = await service.overview({
        days: 7,
        to: '2026-10-30',
        granularity: 'week',
      });
      expect(result.buckets[result.buckets.length - 1].key).toBe('2026-10-26');
    });

    it('近 7 天 + 月粒度 → 1 个桶（由前端呈现「粒度大于区间」空态）', async () => {
      const result = await service.overview({
        days: 7,
        to: '2026-10-30',
        granularity: 'month',
      });
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].key).toBe('2026-10');
    });
  });

  describe('窗口参数边界（不静默截断）', () => {
    it('days 超上限（91）→ 400', async () => {
      await expect(
        service.overview({ days: STATS_MAX_WINDOW_DAYS + 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('days = 0 → 400', async () => {
      await expect(service.overview({ days: 0 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('days 非整数 → 400', async () => {
      await expect(service.overview({ days: 2.5 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('to 落在未来 → 400（未来窗口必然全空，会给「这几天没产出」的错觉）', async () => {
      await expect(
        service.overview({ days: 7, to: '2099-01-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('边界值 days=90 允许（上限本身合法）', async () => {
      const result = await service.overview({ days: 90, to: '2026-10-30' });
      expect(result.window.days).toBe(90);
      expect(result.window.maxDays).toBe(STATS_MAX_WINDOW_DAYS);
    });

    it('window 回显时区与上限（前端据此标注）', async () => {
      const result = await service.overview({ days: 7, to: '2026-10-30' });
      expect(result.window.timezone).toBe('Asia/Shanghai');
      expect(result.window.granularity).toBe('day');
    });
  });

  describe('teamIds 解析', () => {
    it('逗号串去空去重保序', async () => {
      await service.overview({ days: 7, teamIds: ' tm_1 , tm_2 ,, tm_1 ' });
      expect(prisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['tm_1', 'tm_2'] } } }),
      );
    });

    it('缺省 = 全部团队（where 为空对象）', async () => {
      await service.overview({ days: 7 });
      expect(prisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  describe('teamDetail（团队门禁与详情口径）', () => {
    it('非成员且非管理员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      // 只调用一次并捕获异常对象：用 expect().rejects 会消费 promise，
      // 再调一次拿到的就是成功结果（缓存命中），类型变成联合体。
      const err = await service
        .teamDetail('tm_1', { days: 7 }, { id: 'u_outsider' })
        .then(
          () => null,
          (e: unknown) => e as ForbiddenException,
        );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err?.getResponse() as { code: string }).code).toBe(
        TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
      );
    });

    it('团队成员 → 放行', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      const result = await service.teamDetail(
        'tm_1',
        { days: 7 },
        { id: 'u_member' },
      );
      expect(result.teamId).toBe('tm_1');
    });

    it('平台管理员即使不是团队成员也放行（AdminGuard 同口径回落）', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u_admin',
        enabled: true,
        role: { permissions: { all: true } },
      });
      const result = await service.teamDetail(
        'tm_1',
        { days: 7 },
        { id: 'u_admin' },
      );
      expect(result.teamId).toBe('tm_1');
    });

    it('团队不存在 → 404 TEAM_NOT_FOUND', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(
        service.teamDetail('tm_missing', { days: 7 }, { id: 'u_member' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('无完成样本 → avgCycleHours 为 null（不是 0，0 会显示成「周期极短」）', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      const result = await service.teamDetail(
        'tm_1',
        { days: 7 },
        { id: 'u_member' },
      );
      expect(result.avgCycleHours).toBeNull();
      expect(result.avgQueueWaitHours).toBeNull();
      expect(result.queueWaitSource).toBe(QUEUE_WAIT_SOURCE);
    });

    it('评审轮次当前无采集点 → 如实返回 0（不编数）', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      const result = await service.teamDetail(
        'tm_1',
        { days: 7 },
        { id: 'u_member' },
      );
      expect(result.reviewRounds).toBe(0);
    });

    it('产出物构成三态全覆盖（缺类型补 0）', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.artifact.groupBy.mockResolvedValue([
        { type: 'text', _count: { _all: 6 } },
      ]);
      const result = await service.teamDetail(
        'tm_1',
        { days: 7 },
        { id: 'u_member' },
      );
      expect(result.artifactMix.map((m) => m.type)).toEqual([
        'text',
        'doc',
        'file',
      ]);
      expect(result.artifactMix[0].count).toBe(6);
      expect(result.artifactMix[0].share).toBe(1);
      expect(result.artifactMix[1].count).toBe(0);
    });

    it('状态快照七态全覆盖（缺态补 0）', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.task.groupBy.mockResolvedValue([
        { status: 'pending_review', _count: { _all: 6 } },
      ]);
      const result = await service.teamDetail(
        'tm_1',
        { days: 7 },
        { id: 'u_member' },
      );
      expect(result.statusMix.pending_review).toBe(6);
      expect(result.statusMix.completed).toBe(0);
      expect(Object.keys(result.statusMix)).toHaveLength(7);
    });

    it('成员行按 totalTokens 降序', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.modelUsage.groupBy.mockResolvedValue([
        {
          teamMemberId: 'tmm_a',
          _sum: {
            inputTokens: 100,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
          },
        },
        {
          teamMemberId: 'tmm_b',
          _sum: {
            inputTokens: 900,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
          },
        },
      ]);
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_a',
          alias: '开发者-1',
          agent: { name: 'dev' },
          role: { name: '开发者' },
        },
        {
          id: 'tmm_b',
          alias: '开发者-2',
          agent: { name: 'dev2' },
          role: { name: '开发者' },
        },
      ]);
      const result = await service.teamDetail(
        'tm_1',
        { days: 7 },
        { id: 'u_member' },
      );
      expect(result.members[0].teamMemberId).toBe('tmm_b');
      expect(result.members[0].totalTokens).toBe(900);
      expect(result.members[1].teamMemberId).toBe('tmm_a');
    });

    it('成员 cost 未知（_sum.cost 为 null）→ 该成员 cost 为 null', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
      prisma.modelUsage.groupBy.mockResolvedValue([
        {
          teamMemberId: 'tmm_a',
          _sum: {
            inputTokens: 100,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: null,
          },
        },
      ]);
      const result = await service.teamDetail(
        'tm_1',
        { days: 7 },
        { id: 'u_member' },
      );
      expect(result.members[0].cost).toBeNull();
    });
  });

  describe('缓存（60s TTL，键含查看者）', () => {
    it('同键第二次查询命中缓存，不再打 DB', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([dayRow()]);
      await service.overview({ days: 7, to: '2026-10-30', granularity: 'day' });
      const callsAfterFirst = prisma.$queryRawUnsafe.mock.calls.length;
      await service.overview({ days: 7, to: '2026-10-30', granularity: 'day' });
      expect(prisma.$queryRawUnsafe.mock.calls.length).toBe(callsAfterFirst);
    });

    it('不同粒度不复用缓存（口径不同）', async () => {
      prisma.$queryRawUnsafe.mockResolvedValue([dayRow()]);
      await service.overview({
        days: 30,
        to: '2026-10-30',
        granularity: 'day',
      });
      const after1 = prisma.$queryRawUnsafe.mock.calls.length;
      await service.overview({
        days: 30,
        to: '2026-10-30',
        granularity: 'week',
      });
      expect(prisma.$queryRawUnsafe.mock.calls.length).toBeGreaterThan(after1);
    });
  });

  describe('错误码常量', () => {
    it('QUERY_INVALID 与 TEAM_NOT_FOUND 的码值稳定', () => {
      expect(STATS_ERRORS.QUERY_INVALID).toBe('STATS_QUERY_INVALID');
      expect(STATS_ERRORS.TEAM_NOT_FOUND).toBe('TEAM_NOT_FOUND');
    });
  });
});
