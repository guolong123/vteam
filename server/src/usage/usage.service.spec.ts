import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TeamUsageResponse, UsageService, UsageViewer } from './usage.service';

/**
 * UsageService 聚合数学与鉴权门测试（token-usage-stats Todo 4）。
 *
 * 覆盖计划要求的四条：成员过滤 403（跨团队/无归属）、groupBy 求和正确（含多模型分行）、
 * 空团队零值结构、`?model=` 过滤生效；另补：null cost 按 0 参与、成员行缺失回落、
 * 三层汇总一致性（成员小计之和 == 团队合计）、排序确定性。
 */
describe('UsageService', () => {
  let service: UsageService;
  let prisma: {
    modelUsage: { groupBy: jest.Mock };
    teamMember: { findMany: jest.Mock };
    teamUserMember: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };

  /** 平台管理员用户行（permissions.all 简写，AdminGuard 口径）。 */
  const adminUser = {
    id: 'u_admin',
    enabled: true,
    role: { permissions: { all: true } },
  };
  /** 普通成员用户行（无 users.manage）。 */
  const memberUser = {
    id: 'u_member',
    enabled: true,
    role: { permissions: { tasks: { view: true } } },
  };

  /** 调用方（团队成员，team_user_members 命中）。 */
  const viewer: UsageViewer = { id: 'u_member' };

  /**
   * 单个 (teamMemberId, model) 聚合行的 mock 形状（Prisma groupBy 返回）。
   * 未给的 sum 字段视为 0（真实 SQL SUM 无匹配时返回 null，服务层归一为 0）。
   */
  function groupRow(
    teamMemberId: string,
    model: string,
    sum: {
      totalTokens?: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      cacheReadTokens?: number | null;
      cacheWriteTokens?: number | null;
      cost?: number | null;
    },
  ) {
    return {
      teamMemberId,
      model,
      _sum: {
        totalTokens: sum.totalTokens ?? 0,
        inputTokens: sum.inputTokens ?? 0,
        outputTokens: sum.outputTokens ?? 0,
        cacheReadTokens: sum.cacheReadTokens ?? 0,
        cacheWriteTokens: sum.cacheWriteTokens ?? 0,
        cost: sum.cost ?? 0,
      },
    };
  }

  beforeEach(async () => {
    prisma = {
      modelUsage: { groupBy: jest.fn().mockResolvedValue([]) },
      teamMember: { findMany: jest.fn().mockResolvedValue([]) },
      teamUserMember: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tum_1' }),
      },
      user: { findUnique: jest.fn().mockResolvedValue(memberUser) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsageService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsageService>(UsageService);
  });

  describe('鉴权门（team_user_members + 平台管理员回落，fail closed）', () => {
    it('跨团队/无归属：team_user_members 无行且非 admin → 403 且不查用量', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(memberUser);

      const err = (await service
        .getTeamUsage('tm_other', viewer)
        .catch((e: unknown) => e)) as {
        status?: number;
        response?: { code?: string; message?: string };
      };

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.status).toBe(403);
      expect(err.response?.code).toBe(TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER);
      expect(prisma.modelUsage.groupBy).not.toHaveBeenCalled();
    });

    it('无 viewer（理论不可达）同样 403——绝不 fail open', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      await expect(service.getTeamUsage('tm_1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.modelUsage.groupBy).not.toHaveBeenCalled();
    });

    it('平台管理员无归属行仍可读（AdminGuard 同一口径）', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(adminUser);

      const out = await service.getTeamUsage('tm_1', { id: 'u_admin' });

      expect(out).toEqual({
        members: [],
        teamTotal: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
      });
      expect(prisma.modelUsage.groupBy).toHaveBeenCalledTimes(1);
    });

    it('团队成员命中 team_user_members 时不查管理员（省一次 user 查询）', async () => {
      await service.getTeamUsage('tm_1', viewer);

      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'tm_1', userId: 'u_member' } },
        select: { id: true },
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('groupBy 查询选型（一次查询 + 走团队维度索引）', () => {
    it('by=[teamMemberId, model] + _sum 六项口径，where 只带 teamId', async () => {
      await service.getTeamUsage('tm_1', viewer);

      expect(prisma.modelUsage.groupBy).toHaveBeenCalledWith({
        by: ['teamMemberId', 'model'],
        where: { teamId: 'tm_1' },
        _sum: {
          totalTokens: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          cost: true,
        },
      });
    });
  });

  describe('?model= 精确过滤', () => {
    it('带 model 时 where 叠精确等值（命中 idx_usage_team_model 最左前缀）', async () => {
      await service.getTeamUsage('tm_1', viewer, 'openai/gpt-5');

      expect(prisma.modelUsage.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', model: 'openai/gpt-5' },
        }),
      );
    });

    it('空串/纯空白 model 视为不过滤（不产出空结果）', async () => {
      await service.getTeamUsage('tm_1', viewer, '   ');

      expect(prisma.modelUsage.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamId: 'tm_1' } }),
      );
    });

    it('过滤后无匹配行 → 零值结构', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([]);

      const out = await service.getTeamUsage('tm_1', viewer, 'nope/none');

      expect(out.members).toEqual([]);
      expect(out.teamTotal.totalTokens).toBe(0);
      expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
    });
  });

  describe('空团队零值结构', () => {
    it('无任何用量行 → {members: [], teamTotal: 全 0}（cost 也是数字 0）', async () => {
      const out: TeamUsageResponse = await service.getTeamUsage('tm_1', viewer);

      expect(out).toEqual({
        members: [],
        teamTotal: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
      });
    });
  });

  describe('聚合数学（含多模型分行）', () => {
    it('单成员单模型：字段逐项透传，成员名实时联表', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        groupRow('tmb_1', 'openai/gpt-5', {
          totalTokens: 300,
          inputTokens: 100,
          outputTokens: 150,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
          cost: 0.42,
        }),
      ]);
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmb_1',
          alias: '测试-1',
          agent: { name: '产品经理' },
          role: { name: '产品' },
        },
      ]);

      const out = await service.getTeamUsage('tm_1', viewer);

      expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['tmb_1'] } },
        select: {
          id: true,
          alias: true,
          agent: { select: { name: true } },
          role: { select: { name: true } },
        },
      });
      expect(out.members).toEqual([
        {
          teamMemberId: 'tmb_1',
          memberName: '测试-1',
          agentName: '产品经理',
          roleName: '产品',
          totalTokens: 300,
          inputTokens: 100,
          outputTokens: 150,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
          cost: 0.42,
          models: [
            {
              model: 'openai/gpt-5',
              totalTokens: 300,
              inputTokens: 100,
              outputTokens: 150,
              cacheReadTokens: 40,
              cacheWriteTokens: 10,
              cost: 0.42,
            },
          ],
        },
      ]);
      expect(out.teamTotal).toEqual({
        totalTokens: 300,
        inputTokens: 100,
        outputTokens: 150,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        cost: 0.42,
      });
    });

    it('同成员两个模型：models 分行，成员小计 = 两桶之和', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        groupRow('tmb_1', 'openai/gpt-5', {
          totalTokens: 100,
          inputTokens: 60,
          outputTokens: 30,
          cacheReadTokens: 5,
          cacheWriteTokens: 5,
          cost: 0.1,
        }),
        groupRow('tmb_1', 'anthropic/claude', {
          totalTokens: 200,
          inputTokens: 120,
          outputTokens: 60,
          cacheReadTokens: 10,
          cacheWriteTokens: 10,
          cost: 0.2,
        }),
      ]);

      const out = await service.getTeamUsage('tm_1', viewer);
      const [member] = out.members;

      // 模型桶按 totalTokens 降序：200 先于 100
      expect(member.models.map((m) => m.model)).toEqual([
        'anthropic/claude',
        'openai/gpt-5',
      ]);
      expect(member.totalTokens).toBe(300);
      expect(member.inputTokens).toBe(180);
      expect(member.outputTokens).toBe(90);
      expect(member.cacheReadTokens).toBe(15);
      expect(member.cacheWriteTokens).toBe(15);
      // 0.1 + 0.2 = 0.30000000000000004（浮点原值累加，不四舍五入，展示层负责精度）
      expect(member.cost).toBeCloseTo(0.3, 10);
      expect(out.teamTotal).toEqual({
        totalTokens: 300,
        inputTokens: 180,
        outputTokens: 90,
        cacheReadTokens: 15,
        cacheWriteTokens: 15,
        cost: member.cost,
      });
    });

    it('多成员多模型：成员按 totalTokens 降序，团队合计 = 全部成员小计之和', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        groupRow('tmb_small', 'openai/gpt-5', { totalTokens: 50, cost: 0.05 }),
        groupRow('tmb_big', 'openai/gpt-5', { totalTokens: 500, cost: 0.5 }),
        groupRow('tmb_big', 'anthropic/claude', {
          totalTokens: 250,
          inputTokens: 250,
          cost: 0.25,
        }),
      ]);
      prisma.teamMember.findMany.mockResolvedValue([
        { id: 'tmb_small', agent: { name: '测试' }, role: null },
        { id: 'tmb_big', agent: { name: '架构师' }, role: { name: '架构' } },
      ]);

      const out = await service.getTeamUsage('tm_1', viewer);

      expect(out.members.map((m) => m.teamMemberId)).toEqual([
        'tmb_big',
        'tmb_small',
      ]);
      expect(out.members[0].totalTokens).toBe(750);
      expect(out.members[0].models).toHaveLength(2);
      expect(out.members[1].totalTokens).toBe(50);
      // 三层一致：成员小计之和 === 团队合计
      const sumOfMembers = out.members.reduce(
        (acc, m) => ({
          totalTokens: acc.totalTokens + m.totalTokens,
          inputTokens: acc.inputTokens + m.inputTokens,
          outputTokens: acc.outputTokens + m.outputTokens,
          cacheReadTokens: acc.cacheReadTokens + m.cacheReadTokens,
          cacheWriteTokens: acc.cacheWriteTokens + m.cacheWriteTokens,
          cost: acc.cost + m.cost,
        }),
        {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
      );
      expect(sumOfMembers.totalTokens).toBe(out.teamTotal.totalTokens);
      expect(sumOfMembers.inputTokens).toBe(out.teamTotal.inputTokens);
      expect(sumOfMembers.outputTokens).toBe(out.teamTotal.outputTokens);
      expect(sumOfMembers.cacheReadTokens).toBe(out.teamTotal.cacheReadTokens);
      expect(sumOfMembers.cacheWriteTokens).toBe(
        out.teamTotal.cacheWriteTokens,
      );
      expect(sumOfMembers.cost).toBeCloseTo(out.teamTotal.cost, 10);
    });
  });

  describe('cost null 口径（NULL = 上游未上报，聚合按 0 参与）', () => {
    it('_sum.cost 为 null（组内全 NULL）→ 桶/成员/团队三层都是数字 0', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        groupRow('tmb_1', 'free/model', { totalTokens: 10, cost: null }),
        groupRow('tmb_2', 'paid/model', { totalTokens: 20, cost: 0.2 }),
      ]);

      const out = await service.getTeamUsage('tm_1', viewer);

      const free = out.members.find((m) => m.teamMemberId === 'tmb_1');
      expect(free.cost).toBe(0);
      expect(free.models[0].cost).toBe(0);
      expect(out.teamTotal.cost).toBeCloseTo(0.2, 10);
    });
  });

  describe('显示名实时联表（不存快照）', () => {
    it('成员无绑定角色 → roleName null', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        groupRow('tmb_1', 'openai/gpt-5', { totalTokens: 10 }),
      ]);
      prisma.teamMember.findMany.mockResolvedValue([
        { id: 'tmb_1', alias: null, agent: { name: '自由人' }, role: null },
      ]);

      const out = await service.getTeamUsage('tm_1', viewer);

      expect(out.members[0].agentName).toBe('自由人');
      expect(out.members[0].roleName).toBeNull();
      // alias 空时 memberName 回落 agentName
      expect(out.members[0].memberName).toBe('自由人');
    });

    it('memberName 取 alias（同 Agent 多实例「测试-1/测试-2」可区分），agentName 保留为副信息', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        groupRow('tmb_a', 'openai/gpt-5', { totalTokens: 10 }),
        groupRow('tmb_b', 'openai/gpt-5', { totalTokens: 20 }),
      ]);
      prisma.teamMember.findMany.mockResolvedValue([
        { id: 'tmb_a', alias: '测试-1', agent: { name: '开发者' }, role: { name: '开发' } },
        { id: 'tmb_b', alias: '测试-2', agent: { name: '开发者' }, role: { name: '开发' } },
      ]);

      const out = await service.getTeamUsage('tm_1', viewer);

      const names = out.members.map((m) => [m.memberName, m.agentName]).sort();
      expect(names).toEqual([
        ['测试-1', '开发者'],
        ['测试-2', '开发者'],
      ]);
    });

    it('成员行已删（model_usage 无 FK）→ 名字回落空串，数字不丢', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        groupRow('tmb_gone', 'openai/gpt-5', { totalTokens: 77, cost: 0.7 }),
      ]);
      prisma.teamMember.findMany.mockResolvedValue([]);

      const out = await service.getTeamUsage('tm_1', viewer);

      expect(out.members).toHaveLength(1);
      expect(out.members[0]).toMatchObject({
        teamMemberId: 'tmb_gone',
        memberName: '',
        agentName: '',
        roleName: null,
        totalTokens: 77,
        cost: 0.7,
      });
    });
  });

  describe('排序确定性', () => {
    it('totalTokens 相同 → 按 teamMemberId 升序；模型桶按 model 名升序', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        // tmb_b 两个模型各 5 → 成员小计 10，与 tmb_a 的 10 同值（走 id 升序分支）
        groupRow('tmb_b', 'zzz/model', { totalTokens: 5 }),
        groupRow('tmb_b', 'aaa/model', { totalTokens: 5 }),
        groupRow('tmb_a', 'mmm/model', { totalTokens: 10 }),
      ]);

      const out = await service.getTeamUsage('tm_1', viewer);

      expect(out.members.map((m) => m.teamMemberId)).toEqual([
        'tmb_a',
        'tmb_b',
      ]);
      expect(out.members[1].models.map((m) => m.model)).toEqual([
        'aaa/model',
        'zzz/model',
      ]);
    });
  });
});
