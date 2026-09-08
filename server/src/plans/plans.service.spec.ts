import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { TASK_ERRORS } from '../common/constants/task.constants';
import { PLAN_ERRORS, PLAN_STATUS } from './plan.constants';
import { PlansService } from './plans.service';

describe('PlansService', () => {
  let service: PlansService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let prisma: {
    plan: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    planTask: { findMany: jest.Mock };
    task: { findUnique: jest.Mock };
    teamUserMember: { findUnique: jest.Mock };
    teamMember: { findMany: jest.Mock; findFirst: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { create: jest.Mock };
    $transaction: jest.Mock;
  };

  const taskId = 't_0000000001';
  const userId = 'u_member';
  const planId = 'pl_0000000001';

  /** 团队成员校验通过：任务存在 + 团队用户成员记录命中。 */
  const allowMember = () => {
    prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
    prisma.teamUserMember.findUnique.mockResolvedValue({ id: 'tum_1' });
  };

  const planRow = (overrides: Record<string, unknown> = {}) => ({
    id: planId,
    taskId,
    title: '实施稻邕线消缺',
    summary: null,
    scopeIn: null,
    scopeOut: null,
    status: PLAN_STATUS.reviewing,
    createdBy: 'tmm_main',
    reviewerInstanceId: 'tmm_reviewer',
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
    updatedAt: new Date('2026-08-16T00:00:00.000Z'),
    ...overrides,
  });

  const planTaskRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'pt_0000000001',
    planId,
    seq: 1,
    title: '定位故障点',
    content: {
      what: '定位故障点',
      mustNot: null,
      references: null,
      acceptance: null,
      qa: null,
      commit: null,
    },
    assigneeInstanceId: 'tmm_assignee',
    status: 'pending',
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
    updatedAt: new Date('2026-08-16T00:00:00.000Z'),
    ...overrides,
  });

  const allowChannel = () => {
    prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
  };

  const expectCode = (
    promise: Promise<unknown>,
    ctor:
      | typeof ForbiddenException
      | typeof NotFoundException
      | typeof BadRequestException,
    code: string,
  ) =>
    promise.then(
      () => {
        throw new Error('应当抛出异常');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ctor);
        expect((err as { getResponse(): unknown }).getResponse()).toMatchObject(
          {
            code,
          },
        );
      },
    );

  beforeEach(async () => {
    idGen = {
      nextId: jest.fn(),
      seed: jest.fn(),
    };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    prisma = {
      plan: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      planTask: { findMany: jest.fn() },
      task: { findUnique: jest.fn() },
      teamUserMember: { findUnique: jest.fn() },
      teamMember: { findMany: jest.fn(), findFirst: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    // 事务直接透传回调（tx 复用 prisma mock），事务内查询/落库可断言
    prisma.$transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlansService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();

    service = module.get<PlansService>(PlansService);
  });

  describe('onModuleInit（重启续号，对齐 pl_ 前缀）', () => {
    it('库内已有 pl_<数字> 最大 id 时对齐 plan 前缀序号', async () => {
      prisma.plan.findMany.mockResolvedValue([{ id: 'pl_0000000042' }]);
      prisma.planTask.findMany.mockResolvedValue([]);

      await service.onModuleInit();

      expect(prisma.plan.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'pl_' } },
        select: { id: true },
      });
      expect(prisma.planTask.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'pt_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('pl', 42);
      expect(idGen.seed).not.toHaveBeenCalledWith('pt', expect.anything());
    });

    it('混入 pl_builtin_* 命名 id 时仍按数字序号续号（parseInt NaN 防护）', async () => {
      prisma.plan.findMany.mockResolvedValue([
        { id: 'pl_0000000001' },
        { id: 'pl_builtin_sample' },
        { id: 'pl_0000000010' },
      ]);
      prisma.planTask.findMany.mockResolvedValue([]);

      await service.onModuleInit();

      expect(idGen.seed).toHaveBeenCalledWith('pl', 10);
    });

    it('空库/无记录时跳过续号', async () => {
      prisma.plan.findMany.mockResolvedValue([]);
      prisma.planTask.findMany.mockResolvedValue([]);

      await service.onModuleInit();

      expect(idGen.seed).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit（重启续号，对齐 pt_ 前缀）', () => {
    it('库内已有 pt_<数字> 最大 id 时对齐 planTask 前缀序号', async () => {
      prisma.plan.findMany.mockResolvedValue([]);
      prisma.planTask.findMany.mockResolvedValue([
        { id: 'pt_0000000003' },
        { id: 'pt_0000000012' },
        { id: 'pt_archived_sample' },
      ]);

      await service.onModuleInit();

      expect(prisma.planTask.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'pt_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('pt', 12);
    });
  });

  describe('findByTask（GET /plans?taskId=，指派概览走团队成员 tmm_）', () => {
    it('团队成员查询返回计划头 + 子任务清单（含团队成员指派概览）', async () => {
      allowMember();
      prisma.plan.findUnique.mockResolvedValue(planRow());
      prisma.planTask.findMany.mockResolvedValue([planTaskRow()]);
      prisma.teamMember.findMany.mockResolvedValue([
        { id: 'tmm_assignee', alias: '开发者-1', agent: { name: '开发者' } },
      ]);

      const out = await service.findByTask(taskId, userId);

      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: taskId },
        select: { teamId: true },
      });
      expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
        where: { teamId_userId: { teamId: 'tm_0000000001', userId } },
        select: { id: true },
      });
      expect(prisma.plan.findUnique).toHaveBeenCalledWith({
        where: { taskId },
      });
      expect(prisma.planTask.findMany).toHaveBeenCalledWith({
        where: { planId },
        orderBy: { seq: 'asc' },
      });
      expect(out).toEqual({
        ...planRow(),
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
        tasks: [
          {
            id: 'pt_0000000001',
            seq: 1,
            title: '定位故障点',
            content: {
              what: '定位故障点',
              mustNot: null,
              references: null,
              acceptance: null,
              qa: null,
              commit: null,
            },
            assigneeInstanceId: 'tmm_assignee',
            assigneeAlias: '开发者-1',
            assigneeName: '开发者',
            status: 'pending',
          },
        ],
      });
    });

    it('指派概览按团队成员表解析（teamId 归属 + tmm_ id）', async () => {
      allowMember();
      prisma.plan.findUnique.mockResolvedValue(planRow());
      prisma.planTask.findMany.mockResolvedValue([planTaskRow()]);
      prisma.teamMember.findMany.mockResolvedValue([
        { id: 'tmm_assignee', alias: '开发者-1', agent: { name: '开发者' } },
      ]);

      await service.findByTask(taskId, userId);

      expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['tmm_assignee'] }, teamId: 'tm_0000000001' },
        select: { id: true, alias: true, agent: { select: { name: true } } },
      });
    });

    it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      await expectCode(
        service.findByTask(taskId, userId),
        NotFoundException,
        TASK_ERRORS.TASK_NOT_FOUND,
      );
      expect(prisma.plan.findUnique).not.toHaveBeenCalled();
    });

    it('非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      await expectCode(
        service.findByTask(taskId, userId),
        ForbiddenException,
        TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
      );
    });

    it('任务无计划 → 404 PLAN_NOT_FOUND', async () => {
      allowMember();
      prisma.plan.findUnique.mockResolvedValue(null);
      await expectCode(
        service.findByTask(taskId, userId),
        NotFoundException,
        PLAN_ERRORS.PLAN_NOT_FOUND,
      );
    });
  });

  describe('findTasks（GET /plans/:id/tasks）', () => {
    it('团队成员查询返回子任务清单（含团队成员指派概览）', async () => {
      prisma.plan.findUnique.mockResolvedValue(planRow());
      allowMember();
      prisma.planTask.findMany.mockResolvedValue([planTaskRow()]);
      prisma.teamMember.findMany.mockResolvedValue([
        { id: 'tmm_assignee', alias: '开发者-1', agent: { name: '开发者' } },
      ]);

      const out = await service.findTasks(planId, userId);

      expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['tmm_assignee'] }, teamId: 'tm_0000000001' },
        select: { id: true, alias: true, agent: { select: { name: true } } },
      });
      expect(out).toEqual([
        {
          id: 'pt_0000000001',
          seq: 1,
          title: '定位故障点',
          content: {
            what: '定位故障点',
            mustNot: null,
            references: null,
            acceptance: null,
            qa: null,
            commit: null,
          },
          assigneeInstanceId: 'tmm_assignee',
          assigneeAlias: '开发者-1',
          assigneeName: '开发者',
          status: 'pending',
        },
      ]);
    });

    it('计划不存在 → 404 PLAN_NOT_FOUND（不触达成员校验）', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);
      await expectCode(
        service.findTasks(planId, userId),
        NotFoundException,
        PLAN_ERRORS.PLAN_NOT_FOUND,
      );
      expect(prisma.task.findUnique).not.toHaveBeenCalled();
    });

    it('非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      prisma.plan.findUnique.mockResolvedValue(planRow());
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      await expectCode(
        service.findTasks(planId, userId),
        ForbiddenException,
        TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
      );
    });
  });

  describe('review（PATCH /plans/:id/review）', () => {
    it('approved：团队成员评审通过 → plan.update(status=approved, reviewerInstanceId=null) + 系统消息', async () => {
      prisma.plan.findUnique.mockResolvedValue(planRow());
      allowMember();
      allowChannel();
      idGen.nextId.mockResolvedValueOnce('m_0000000100');
      prisma.plan.update.mockResolvedValue(
        planRow({
          status: PLAN_STATUS.approved,
          reviewerInstanceId: null,
        }),
      );

      const out = await service.review(planId, userId, 'approved');

      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { id: planId },
        data: { status: 'approved', reviewerInstanceId: null },
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'c_1',
          senderType: 'system',
          senderId: null,
          content: {
            text: '执行计划已通过评审，请等待用户手动启动任务后再实施',
            parts: [],
          },
        }),
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        'chat.message.new',
        expect.objectContaining({
          message: {
            text: '执行计划已通过评审，请等待用户手动启动任务后再实施',
            channelId: 'c_1',
          },
        }),
        expect.any(Object),
      );
      expect(out).toEqual({
        id: planId,
        taskId,
        status: 'approved',
        reviewerInstanceId: null,
      });
    });

    it('rejected 附 reason：评审驳回 → plan.update(status=rejected) + 引导文案系统消息', async () => {
      prisma.plan.findUnique.mockResolvedValue(planRow());
      allowMember();
      allowChannel();
      prisma.plan.update.mockResolvedValue(
        planRow({ status: PLAN_STATUS.rejected, reviewerInstanceId: null }),
      );

      const out = await service.review(
        planId,
        userId,
        'rejected',
        '缺少验收标准',
      );

      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { id: planId },
        data: { status: 'rejected', reviewerInstanceId: null },
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content: {
            text: '执行计划被驳回：缺少验收标准（可修改后重提或切换 direct 模式）',
            parts: [],
          },
        }),
      });
      expect(out.status).toBe('rejected');
    });

    it('rejected 无 reason → 400 PLAN_STRUCTURE_INVALID', async () => {
      prisma.plan.findUnique.mockResolvedValue(planRow());
      allowMember();
      await expectCode(
        service.review(planId, userId, 'rejected'),
        BadRequestException,
        PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });

    it('状态机：非 reviewing（approved）→ 400 PLAN_INVALID_STATUS', async () => {
      prisma.plan.findUnique.mockResolvedValue(
        planRow({ status: PLAN_STATUS.approved }),
      );
      allowMember();
      await expectCode(
        service.review(planId, userId, 'approved'),
        BadRequestException,
        PLAN_ERRORS.PLAN_INVALID_STATUS,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });

    it('计划不存在 → 404 PLAN_NOT_FOUND', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);
      await expectCode(
        service.review(planId, userId, 'approved'),
        NotFoundException,
        PLAN_ERRORS.PLAN_NOT_FOUND,
      );
    });

    it('非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      prisma.plan.findUnique.mockResolvedValue(planRow());
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      await expectCode(
        service.review(planId, userId, 'approved'),
        ForbiddenException,
        TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });
  });

  describe('assignReviewer（plan_assign_reviewer MCP 通道复用，评审者为团队成员 tmm_）', () => {
    it('写入 reviewerInstanceId + 系统消息「已指派 <alias> 评审执行计划」', async () => {
      prisma.plan.findUnique.mockResolvedValue(planRow());
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      prisma.teamMember.findFirst.mockResolvedValue({
        id: 'tmm_reviewer',
        alias: '开发者-1',
        agentId: 'a_dev',
      });
      allowChannel();
      prisma.plan.update.mockResolvedValue(
        planRow({ reviewerInstanceId: 'tmm_reviewer' }),
      );

      const out = await service.assignReviewer(planId, 'tmm_reviewer');

      expect(prisma.teamMember.findFirst).toHaveBeenCalledWith({
        where: { id: 'tmm_reviewer', teamId: 'tm_0000000001' },
        select: { id: true, alias: true, agentId: true },
      });
      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { id: planId },
        data: { reviewerInstanceId: 'tmm_reviewer' },
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content: { text: '已指派 开发者-1 评审执行计划', parts: [] },
        }),
      });
      expect(out).toEqual({
        planId,
        taskId,
        reviewerInstanceId: 'tmm_reviewer',
        reviewerAlias: '开发者-1',
      });
    });

    it('评审者不在任务团队 → 400 PLAN_STRUCTURE_INVALID（不落库）', async () => {
      prisma.plan.findUnique.mockResolvedValue(planRow());
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      prisma.teamMember.findFirst.mockResolvedValue(null);
      await expectCode(
        service.assignReviewer(planId, 'tmm_ghost'),
        BadRequestException,
        PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });

    it('计划不存在 → 404 PLAN_NOT_FOUND', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);
      await expectCode(
        service.assignReviewer(planId, 'tmm_reviewer'),
        NotFoundException,
        PLAN_ERRORS.PLAN_NOT_FOUND,
      );
    });
  });
});
