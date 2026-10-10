import { ForbiddenException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { Test, TestingModule } from '@nestjs/testing';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UsageController } from './usage.controller';
import { TeamUsageResponse, UsageService } from './usage.service';

/**
 * UsageController 路由与转发测试（token-usage-stats Todo 4）。
 *
 * 真实 service 注入（非 mock 桩），因此本文件同时覆盖端到端的
 * 「非团队成员 → 403」链路（跨团队 / 无归属）与 `?model=` 透传。
 */
describe('UsageController', () => {
  let controller: UsageController;
  let prisma: {
    modelUsage: { groupBy: jest.Mock };
    teamMember: { findMany: jest.Mock };
    teamUserMember: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
  };

  /** 团队成员用户行（team_user_members 命中路径）。 */
  const memberUser = {
    id: 'u_member',
    enabled: true,
    role: { permissions: { tasks: { view: true } } },
  };

  const emptyTotals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };

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
      controllers: [UsageController],
      providers: [UsageService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    controller = module.get<UsageController>(UsageController);
  });

  describe('路由注册', () => {
    it('裸挂载 GET teams/:teamId/usage（对齐 chat.controller scoped 端点形态）', () => {
      expect(Reflect.getMetadata(PATH_METADATA, UsageController)).toBe('/');
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          UsageController.prototype.getTeamUsage,
        ),
      ).toBe('teams/:teamId/usage');
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          UsageController.prototype.getTeamUsage,
        ),
      ).toBe(RequestMethod.GET);
    });

    it('控制器只暴露一个端点（统计接口零写操作）', () => {
      const handlers = Object.getOwnPropertyNames(
        UsageController.prototype,
      ).filter((name) => name !== 'constructor');
      expect(handlers).toEqual(['getTeamUsage']);
    });
  });

  describe('端点转发', () => {
    it('团队成员 → 200 聚合结果，viewer 与 teamId 透传到查询', async () => {
      prisma.modelUsage.groupBy.mockResolvedValue([
        {
          teamMemberId: 'tmb_1',
          model: 'openai/gpt-5',
          _sum: {
            totalTokens: 120,
            inputTokens: 80,
            outputTokens: 30,
            cacheReadTokens: 5,
            cacheWriteTokens: 5,
            cost: 0.12,
          },
        },
      ]);
      prisma.teamMember.findMany.mockResolvedValue([
        { id: 'tmb_1', agent: { name: '产品经理' }, role: { name: '产品' } },
      ]);

      const out: TeamUsageResponse = await controller.getTeamUsage('tm_1', {
        id: 'u_member',
      } as never);

      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'tm_1', userId: 'u_member' } },
        select: { id: true },
      });
      expect(prisma.modelUsage.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamId: 'tm_1' } }),
      );
      expect(out.members).toHaveLength(1);
      expect(out.members[0]).toMatchObject({
        teamMemberId: 'tmb_1',
        agentName: '产品经理',
        roleName: '产品',
        totalTokens: 120,
        cost: 0.12,
      });
      expect(out.teamTotal.totalTokens).toBe(120);
    });

    it('空团队 → 200 {members: [], teamTotal: 全 0}', async () => {
      const out = await controller.getTeamUsage('tm_1', {
        id: 'u_member',
      } as never);

      expect(out).toEqual({ members: [], teamTotal: emptyTotals });
    });

    it('?model= 透传为 where 精确等值过滤', async () => {
      await controller.getTeamUsage(
        'tm_1',
        { id: 'u_member' } as never,
        'openai/gpt-5',
      );

      expect(prisma.modelUsage.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', model: 'openai/gpt-5' },
        }),
      );
    });
  });

  describe('成员过滤 403（跨团队 / 无归属）', () => {
    it('非成员且非管理员访问他人团队 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);

      const err = (await controller
        .getTeamUsage('tm_other', { id: 'u_member' } as never)
        .catch((e: unknown) => e)) as {
        status?: number;
        response?: { code?: string; message?: string };
      };

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.status).toBe(403);
      expect(err.response?.code).toBe(TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER);
      expect(err.response?.message).toBe('您不是该团队成员');
      expect(prisma.modelUsage.groupBy).not.toHaveBeenCalled();
    });
  });
});
