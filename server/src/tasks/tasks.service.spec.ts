import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { TASK_ERRORS } from '../common/constants/task.constants';
import {
  EXECUTION_MODES,
  PLAN_ERRORS,
  PLAN_STATUS,
  PLAN_TASK_STATUS,
} from '../plans/plan.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { TaskProgressionScheduler } from './task-progression.scheduler';
import { TasksService } from './tasks.service';
import { sanitizeWorkDirName } from './work-dir.util';

describe('TasksService', () => {
  let service: TasksService;
  let prisma: {
    task: {
      create: jest.Mock;
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    chatChannel: { create: jest.Mock; findFirst: jest.Mock };
    taskEvent: { create: jest.Mock };
    message: { create: jest.Mock; findFirst: jest.Mock };
    agent: { findMany: jest.Mock; findUnique: jest.Mock };
    session: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
    plan: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    planTask: { findFirst: jest.Mock; findMany: jest.Mock };
    teamUserMember: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
    teamMember: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    teamQueue: {
      create: jest.Mock;
      aggregate: jest.Mock;
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
    $queryRawUnsafe: jest.Mock;
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let sessionLifecycle: {
    getInstancesByTeamMember: jest.Mock;
    getInstanceBySession: jest.Mock;
  };

  const userId = 'u_admin';

  /** 团队成员行（team_members + 模板 agent 关联，任务侧实例快照已删除，统一用 tmm_ 行）。 */
  const memberRow = (
    agentId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const base: Record<string, any> = {
      a_product: {
        id: 'tmm_0000000001',
        agentId: 'a_product',
        alias: '产品经理-1',
        seq: 1,
        agent: { id: 'a_product', name: '产品经理', role: 'product' },
      },
      a_developer: {
        id: 'tmm_0000000002',
        agentId: 'a_developer',
        alias: '开发者-1',
        seq: 1,
        agent: { id: 'a_developer', name: '开发者', role: 'developer' },
      },
      a_tester: {
        id: 'tmm_0000000003',
        agentId: 'a_tester',
        alias: '测试-1',
        seq: 1,
        agent: { id: 'a_tester', name: '测试', role: 'tester' },
      },
    };
    return {
      ...(base[agentId] ?? {
        id: `tmm_${agentId}`,
        agentId,
        alias: null,
        seq: 1,
        agent: { id: agentId, name: agentId, role: null },
      }),
      ...overrides,
    };
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 't_0000000001',
    title: '任务标题',
    description: null,
    priority: 'medium',
    status: 'pending',
    mainAgentId: null,
    mainAgentInstanceId: null,
    managedMode: false,
    executionMode: 'direct',
    backgroundDocs: null,
    teamId: 'tm_0000000001',
    createdBy: userId,
    createdAt: new Date('2026-08-07T00:00:00Z'),
    startedAt: null,
    pendingReviewAt: null,
    completedAt: null,
    archivedAt: null,
    legacySnapshots: [memberRow('a_product'), memberRow('a_developer')],
    ...overrides,
  });

  /** 团队成员行（team_members + 模板 agent 关联，Todo11 后 instances 唯一派生源）。 */
  const tmmRow = (
    id: string,
    agentId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const base: Record<string, { alias: string; name: string; role: string }> =
      {
        a_product: {
          alias: '产品经理-1',
          name: '产品经理',
          role: 'product',
        },
        a_developer: {
          alias: '开发者-1',
          name: '开发者',
          role: 'developer',
        },
        a_tester: { alias: '测试-1', name: '测试', role: 'tester' },
      };
    const b = base[agentId] ?? { alias: agentId, name: agentId, role: agentId };
    return {
      id,
      teamId: 'tm_0000000001',
      agentId,
      alias: b.alias,
      seq: 1,
      workDir: `/data/vteam-worker/${b.name}`,
      agent: { id: agentId, name: b.name, role: b.role },
      ...overrides,
    };
  };

  beforeEach(async () => {
    prisma = {
      task: {
        create: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      chatChannel: { create: jest.fn(), findFirst: jest.fn() },
      taskEvent: { create: jest.fn() },
      message: { create: jest.fn(), findFirst: jest.fn() },
      agent: { findMany: jest.fn(), findUnique: jest.fn() },
      session: {
        create: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      plan: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
      planTask: { findFirst: jest.fn(), findMany: jest.fn() },
      teamUserMember: { findUnique: jest.fn() },
      team: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
      teamMember: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      teamQueue: {
        create: jest.fn(),
        aggregate: jest.fn(),
        findFirst: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn(),
      $queryRawUnsafe: jest.fn(),
    };
    idGen = { nextId: jest.fn(), seed: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    // 团队化默认基线：归属团队存在 + 主成员已定 + 2 成员（start 预检/主门/DTO 组装默认放行；
    // 404/空团队/未设主成员用例各自覆写）。
    prisma.team.findUnique.mockResolvedValue({
      id: 'tm_0000000001',
      mainAgentMemberId: 'tmm_0000000001',
      currentTaskId: 't_0000000001',
    } as any);
    (prisma.teamMember.count as jest.Mock).mockResolvedValue(2);
    sessionLifecycle = {
      getInstancesByTeamMember: jest.fn().mockResolvedValue([]),
      getInstanceBySession: jest.fn().mockResolvedValue(null),
    } as any;
    (sessionLifecycle as any).resetTeamSessionsInTx = jest
      .fn()
      .mockResolvedValue(2);
    (sessionLifecycle as any).resetTeamSessions = jest
      .fn()
      .mockResolvedValue(2);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
        { provide: SessionLifecycleService, useValue: sessionLifecycle },
        {
          provide: TaskProgressionScheduler,
          useValue: {
            register: jest.fn().mockResolvedValue(undefined),
            unregister: jest.fn(),
            triggerMemoryHarvest: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
  });

  /** 模板 agent 信息（createInstances 事务内 findUnique 用；id 未命中时回退通用值）。 */
  const mockAgentMeta = (id: string) => {
    const meta: Record<string, { name: string; role: string }> = {
      a_product: { name: '产品经理', role: 'product' },
      a_project_manager: { name: '项目经理', role: 'project_manager' },
      a_architect: { name: '架构师', role: 'architect' },
      a_developer: { name: '开发者', role: 'developer' },
      a_tester: { name: '测试', role: 'tester' },
    };
    return meta[id] ?? { name: id, role: 'custom' };
  };

  /** 创建事务的 tx mock：三件套 + 实例（seq 默认从 0 起）+ 会话 + 主实例 update + 事件，返回 tx 供断言。 */
  const mockCreateTx = (createdRow: unknown) => {
    const txModels = {
      task: {
        create: jest.fn().mockResolvedValue(createdRow),
        update: jest.fn().mockResolvedValue(createdRow),
      },
      chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
      teamMember: {
        create: jest
          .fn()
          .mockImplementation(({ data }: any) =>
            Promise.resolve({ id: data.id, alias: data.alias, seq: data.seq }),
          ),
        aggregate: jest.fn().mockResolvedValue({ _max: { seq: 0 } }),
      },
      agent: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve({ id: where.id, ...mockAgentMeta(where.id) }),
          ),
      },
      session: { create: jest.fn().mockResolvedValue({ id: 's_1' }) },
      taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
    };
    prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
    return txModels;
  };

  /** 状态迁移事务的 tx mock：CAS updateMany 默认命中（count=1），返回 tx 供断言。 */
  const mockTransitionTx = () => {
    const txModels = {
      task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      // 队首晋升默认无团队（accept/archive/reject 后 promote 空转；晋升用例各自覆写）
      team: { findUnique: jest.fn().mockResolvedValue(null) },
      teamQueue: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      artifact: { findMany: jest.fn().mockResolvedValue([]) },
      artifactVersion: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      message: {
        create: jest.fn().mockImplementation(({ data }: { data: any }) => ({
          id: data.id,
          channelId: data.channelId,
          senderType: data.senderType,
          senderId: data.senderId,
          content: data.content,
          mentions: data.mentions,
          status: data.status,
          createdAt: new Date('2026-08-07T00:00:00Z'),
        })),
      },
      plan: { update: jest.fn().mockResolvedValue({ id: 'pl_1' }) },
    };
    prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
    return txModels;
  };

  /** 状态机系统消息落库断言：任务群聊频道（task_group）写入 senderType=system 的精确文案。 */
  const assertSysMessageCreated = (
    tx: { message: { create: jest.Mock } },
    channelId: string,
    text: string,
    nth = 1,
  ) => {
    expect(tx.message.create).toHaveBeenNthCalledWith(nth, {
      data: {
        id: expect.any(String),
        channelId,
        senderType: 'system',
        senderId: null,
        content: { text, parts: [] },
        mentions: null,
        status: 'sent',
      },
    });
  };

  /** 断言 409：具体错误 code 必须为 TASK_INVALID_TRANSITION，且带 {from, to, current} 详情。 */
  const assertInvalidTransition = async (
    fn: () => Promise<unknown>,
    from: string,
    to: string,
    current: string,
  ) => {
    try {
      await fn();
      fail('应抛出 ConflictException');
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({
        code: TASK_ERRORS.TASK_INVALID_TRANSITION,
        details: { from, to, current },
      });
    }
  };

  /** 断言 400：断言具体业务错误 code。 */
  const assertBadRequestCode = async (
    fn: () => Promise<unknown>,
    code: string,
  ) => {
    try {
      await fn();
      fail('应抛出 BadRequestException');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).getResponse()).toMatchObject({ code });
    }
  };

  describe('create（团队指派 + FIFO 串行，FOR UPDATE+version 双保险）', () => {
    const teamId = 'tm_0000000001';
    const mockMembers = [
      {
        id: 'tmm_0000000001',
        teamId,
        agentId: 'a_product',
        alias: '产品经理-1',
        seq: 1,
        workDir: '/data/vteam-worker/产品经理',
        agent: { id: 'a_product', name: '产品经理', role: 'product' },
      },
      {
        id: 'tmm_0000000002',
        teamId,
        agentId: 'a_developer',
        alias: '开发者-1',
        seq: 1,
        workDir: '/data/vteam-worker/开发者',
        agent: { id: 'a_developer', name: '开发者', role: 'developer' },
      },
    ];
    const mockTeamIdle = {
      id: teamId,
      name: 'vteam开发团队',
      version: 0,
      currentTaskId: null,
      reuseSession: true,
    };
    const mockTeamBusy = {
      id: teamId,
      name: 'vteam开发团队',
      version: 1,
      currentTaskId: 't_0000000009',
      reuseSession: true,
    };

    const setupTxIdle = (taskId: string) => {
      prisma.teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      } as any);
      idGen.nextId.mockImplementation(async (prefix: string) => {
        const map: Record<string, string> = {
          t: taskId,
          c: 'c_0000000001',
          s: 's_0000000001',
          te: 'te_0000000001',
          tq: 'tq_0000000001',
        };
        // fallback per prefix counter
        if (map[prefix]) {
          const v = map[prefix];
          map[prefix] = v;
          return v;
        }
        return `${prefix}_0000000001`;
      });
      let sCounter = 0;
      const tx: any = {
        team: {
          findUnique: jest.fn().mockResolvedValue(mockTeamIdle),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        teamMember: { findMany: jest.fn().mockResolvedValue(mockMembers) },
        teamQueue: {
          create: jest.fn().mockResolvedValue({ id: 'tq_0000000001' }),
          aggregate: jest.fn().mockResolvedValue({ _max: { position: 0 } }),
        },
        task: {
          create: jest
            .fn()
            .mockImplementation(({ data }: any) => Promise.resolve(data)),
        },
        chatChannel: {
          create: jest.fn().mockResolvedValue({ id: 'c_0000000001' }),
        },
        session: {
          create: jest.fn().mockImplementation(({ data }: any) => {
            sCounter++;
            return Promise.resolve({ id: data.id });
          }),
        },
        taskEvent: {
          create: jest.fn().mockResolvedValue({ id: 'te_0000000001' }),
        },
        $queryRawUnsafe: jest
          .fn()
          .mockRejectedValue(new Error('mock raw fallback')),
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.task.findUnique.mockResolvedValue(
        row({ id: taskId, teamId, status: 'pending', title: '新任务' }) as any,
      );
      return tx;
    };

    const setupTxBusy = (taskId: string, maxPos: number) => {
      prisma.teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      } as any);
      idGen.nextId.mockImplementation(
        async (prefix: string) => `${prefix}_0000000001`,
      );
      const tx: any = {
        team: {
          findUnique: jest.fn().mockResolvedValue(mockTeamBusy),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        teamMember: { findMany: jest.fn().mockResolvedValue(mockMembers) },
        teamQueue: {
          create: jest.fn().mockResolvedValue({ id: 'tq_0000000002' }),
          aggregate: jest
            .fn()
            .mockResolvedValue({ _max: { position: maxPos } }),
        },
        task: {
          create: jest
            .fn()
            .mockImplementation(({ data }: any) => Promise.resolve(data)),
        },
        chatChannel: {
          create: jest.fn().mockResolvedValue({ id: 'c_0000000001' }),
        },
        session: {
          create: jest.fn().mockResolvedValue({ id: 's_0000000001' }),
        },
        taskEvent: {
          create: jest.fn().mockResolvedValue({ id: 'te_0000000001' }),
        },
        $queryRawUnsafe: jest
          .fn()
          .mockRejectedValue(new Error('mock raw fallback')),
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.task.findUnique.mockResolvedValue(
        row({ id: taskId, teamId, status: 'queued', title: '排队任务' }) as any,
      );
      return tx;
    };

    it('空闲团队：创建 pending 任务，currentTaskId 指向新任务，快照成员零会话写，广播双事件', async () => {
      const taskId = 't_0000000001';
      const tx = setupTxIdle(taskId);
      idGen.nextId
        .mockResolvedValueOnce(taskId)
        .mockResolvedValueOnce('c_0000000001')
        .mockResolvedValueOnce('tmm_0000000001')
        .mockResolvedValueOnce('tmm_0000000002')
        .mockResolvedValueOnce('te_0000000001');

      const result = await service.create(userId, {
        title: '新任务',
        teamId,
      } as any);

      expect(result).toMatchObject({ id: taskId, teamId, status: 'pending' });
      expect(result).not.toHaveProperty('projectId');
      expect(tx.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teamId,
            status: 'pending',
            mainAgentId: null,
            mainAgentInstanceId: null,
          }),
        }),
      );
      expect(tx.team.updateMany).toHaveBeenCalledWith({
        where: { id: teamId, version: 0 },
        data: { currentTaskId: taskId, version: { increment: 1 } },
      });
      // 任务只作为数据行：无任务侧实例快照写（成员唯一来源为团队成员表），无会话写
      expect(tx.session.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        expect.objectContaining({ taskId, to: 'pending' }),
        { type: 'global' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_QUEUE_CHANGED,
        expect.objectContaining({ teamId, taskId, status: 'pending' }),
        { type: 'team', id: teamId },
      );
    });

    it('忙时团队：创建 queued 任务，写入 TeamQueue position=MAX+1 FOR UPDATE，currentTaskId 不变', async () => {
      const taskId = 't_0000000002';
      const tx = setupTxBusy(taskId, 1);
      idGen.nextId
        .mockResolvedValueOnce(taskId)
        .mockResolvedValueOnce('c_0000000001')
        .mockResolvedValueOnce('tmm_0000000001')
        .mockResolvedValueOnce('tmm_0000000002')
        .mockResolvedValueOnce('tq_0000000002')
        .mockResolvedValueOnce('te_0000000001');

      const result = await service.create(userId, {
        title: '排队任务',
        teamId,
      } as any);

      expect(result).toMatchObject({ status: 'queued' });
      expect(tx.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'queued' }),
        }),
      );
      expect(tx.teamQueue.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ teamId, taskId, position: 2 }),
      });
      expect(tx.team.updateMany).toHaveBeenCalledWith({
        where: { id: teamId, version: 1 },
        data: { version: { increment: 1 } },
      });
      expect(tx.session.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_QUEUE_CHANGED,
        expect.objectContaining({ position: 2, status: 'queued' }),
        { type: 'team', id: teamId },
      );
    });

    it('并发：version CAS 重试3次，最终仅一个 pending 其余 queued（模拟首试冲突后重试成功）', async () => {
      const taskId = 't_0000000003';
      prisma.teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      } as any);
      // first attempt conflict, second attempt busy success
      let attempt = 0;
      prisma.$transaction.mockImplementation(async (fn: any) => {
        attempt++;
        if (attempt === 1) {
          const txConflict: any = {
            team: {
              findUnique: jest.fn().mockResolvedValue(mockTeamIdle),
              updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
            teamMember: { findMany: jest.fn().mockResolvedValue(mockMembers) },
            teamQueue: {
              create: jest.fn(),
              aggregate: jest.fn().mockResolvedValue({ _max: { position: 0 } }),
            },
            task: { create: jest.fn().mockResolvedValue({ id: taskId }) },
            chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
            session: { create: jest.fn().mockResolvedValue({ id: 's_1' }) },
            taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
            $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
          };
          return fn(txConflict);
        }
        const txOk: any = {
          team: {
            findUnique: jest.fn().mockResolvedValue(mockTeamBusy),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          teamMember: { findMany: jest.fn().mockResolvedValue(mockMembers) },
          teamQueue: {
            create: jest.fn().mockResolvedValue({ id: 'tq_0000000002' }),
            aggregate: jest.fn().mockResolvedValue({ _max: { position: 1 } }),
          },
          task: {
            create: jest
              .fn()
              .mockResolvedValue({ id: taskId, status: 'queued' }),
          },
          chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
          session: { create: jest.fn().mockResolvedValue({ id: 's_1' }) },
          taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
          $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
        };
        return fn(txOk);
      });
      idGen.nextId.mockResolvedValue(taskId);
      prisma.task.findUnique.mockResolvedValue(
        row({ id: taskId, teamId, status: 'queued' }) as any,
      );

      const result = await service.create(userId, {
        title: '并发任务',
        teamId,
      } as any);
      expect(result.status).toBe('queued');
      expect(attempt).toBe(2);
    });

    it('teamId 缺失 → 400 TEAM_REQUIRED', async () => {
      await expect(
        service.create(userId, { title: 'x' } as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.create(userId, { title: 'x' } as any);
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TEAM_REQUIRED,
        });
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('team 不存在 → 404 TEAM_NOT_FOUND', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      } as any);
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          team: { findUnique: jest.fn().mockResolvedValue(null) },
          $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('')),
        }),
      );
      idGen.nextId.mockResolvedValue('t_0000000001');
      await expect(
        service.create(userId, { title: 'x', teamId: 'tm_missing' } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue(null);
      await expect(
        service.create(userId, { title: 'x', teamId } as any),
      ).rejects.toThrow(ForbiddenException);
      try {
        await service.create(userId, { title: 'x', teamId } as any);
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        });
        expect(TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER).toBe(
          'PERMISSION_TEAM_NOT_MEMBER',
        );
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('团队成员为空 → 400 TASK_EMPTY_TEAM', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      } as any);
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          team: { findUnique: jest.fn().mockResolvedValue(mockTeamIdle) },
          teamMember: { findMany: jest.fn().mockResolvedValue([]) },
          $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('')),
        }),
      );
      idGen.nextId.mockResolvedValue('t_0000000001');
      await expect(
        service.create(userId, { title: 'x', teamId } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('标题为空 → 400', async () => {
      await expect(
        service.create(userId, { title: ' ', teamId } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createByAgent（agent 建任务通道，去 pid，owner 回填 createdBy）', () => {
    const teamId = 'tm_0000000001';
    const setupAgentTx = () => {
      const captured: any[] = [];
      const tx: any = {
        team: {
          findUnique: jest.fn().mockResolvedValue({
            id: teamId,
            version: 0,
            currentTaskId: null,
            reuseSession: true,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        teamMember: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'tmm_0000000001',
              teamId,
              agentId: 'a_product',
              alias: '产品经理-1',
              seq: 1,
              workDir: '/data/a',
              agent: { id: 'a_product', name: '产品经理', role: 'product' },
            },
          ]),
        },
        teamQueue: {
          create: jest.fn(),
          aggregate: jest.fn().mockResolvedValue({ _max: { position: 0 } }),
        },
        task: {
          create: jest.fn().mockImplementation(({ data }: any) => {
            captured.push(data);
            return Promise.resolve(data);
          }),
        },
        chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
        session: { create: jest.fn().mockResolvedValue({ id: 's_1' }) },
        taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      idGen.nextId.mockResolvedValue('t_0000000001');
      return { tx, captured };
    };

    it('happy：owner 回填 createdBy，事件/broadcast actor 记 agent/调用实例', async () => {
      (prisma.teamUserMember as any).findMany = jest.fn().mockResolvedValue([
        { userId: 'u_owner', role: 'owner' },
        { userId: 'u_member', role: 'member' },
      ]);
      const { tx, captured } = setupAgentTx();
      prisma.task.findUnique.mockResolvedValue(
        row({ id: 't_0000000001', teamId, status: 'pending' }) as any,
      );

      const result = await service.createByAgent('tmm_caller_1', {
        title: 'agent 任务',
        teamId,
      } as any);

      expect(result).toMatchObject({ teamId, status: 'pending' });
      expect(captured[0].createdBy).toBe('u_owner');
      expect(tx.taskEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorType: 'agent',
            actorId: 'tmm_caller_1',
          }),
        }),
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        expect.objectContaining({ actorType: 'agent', actorId: 'tmm_caller_1' }),
        { type: 'global' },
      );
    });

    it('teamId 缺失 → 400 TEAM_REQUIRED（不触达成员查询）', async () => {
      const findMany = jest.fn();
      (prisma.teamUserMember as any).findMany = findMany;
      await assertBadRequestCode(
        () => service.createByAgent('tmm_caller_1', { title: 'x' } as any),
        TASK_ERRORS.TEAM_REQUIRED,
      );
      expect(findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('团队无用户成员 → 400 TASK_EMPTY_TEAM', async () => {
      (prisma.teamUserMember as any).findMany = jest.fn().mockResolvedValue([]);
      await assertBadRequestCode(
        () =>
          service.createByAgent('tmm_caller_1', { title: 'x', teamId } as any),
        TASK_ERRORS.TASK_EMPTY_TEAM,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('findAll（看板列表）', () => {
    it('返回 {items, total, page, pageSize}，items 含 teamAgentIds 与 instances（团队成员组装），created_at desc', async () => {
      prisma.$transaction.mockResolvedValue([
        1,
        [
          row({ teamId: 'tm_0000000001' }),
          row({
            id: 't_0000000002',
            status: 'in_progress',
            teamId: 'tm_0000000001',
          }),
        ],
      ]);
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findMany.mockResolvedValue([
        tmmRow('tmm_0000000001', 'a_product'),
        tmmRow('tmm_0000000002', 'a_developer'),
      ]);
      (prisma.session as any).findMany = jest.fn().mockResolvedValue([]);

      const result = await service.findAll({ page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: 't_0000000001',
        status: 'pending',
      });
      expect(result.items[0].teamAgentIds).toEqual([
        'a_product',
        'a_developer',
      ]);
      expect(result.items[0].instances).toEqual([
        {
          id: 'tmm_0000000002',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
          workDir: '/data/vteam-worker/开发者',
          name: '开发者',
          role: 'developer',
          main: false,
          enabled: true,
          overrideModelId: null,
          sessionStatus: null,
          sessionId: null,
        },
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
          workDir: '/data/vteam-worker/产品经理',
          name: '产品经理',
          role: 'product',
          main: false,
          enabled: true,
          overrideModelId: null,
          sessionStatus: null,
          sessionId: null,
        },
      ]);
      expect(result.items[1].teamAgentIds).toEqual([
        'a_product',
        'a_developer',
      ]);
      // 查询：无 teamId 不带团队过滤 + 排序，无任务实例表读取（Todo11 团队组装）
      expect(prisma.task.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
    });

    it('status 筛选透传（TASK_STATUS 五态）', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ status: 'pending' } as any);

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'pending' },
        }),
      );
    });

    it('teamId 传入 → 按 teamId 过滤（团队作用域）', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ teamId: 'tm_0000000001' } as any);

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_0000000001' },
        }),
      );
    });

    it('pageSize 上限 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ page: 1, pageSize: 999 } as any);

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });
  });

  describe('findOne（详情）', () => {
    it('返回详情（含 teamAgentIds、instances、backgroundDocs；团队成员组装）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          teamId: 'tm_0000000001',
          mainAgentInstanceId: 'tmm_0000000001',
          backgroundDocs: [{ name: '需求文档.pdf' }],
        }),
      );
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        mainAgentMemberId: 'tmm_0000000001',
      });
      prisma.teamMember.findMany.mockResolvedValue([
        tmmRow('tmm_0000000001', 'a_product'),
        tmmRow('tmm_0000000002', 'a_developer'),
      ]);
      (prisma.session as any).findMany = jest.fn().mockResolvedValue([]);

      const result = await service.findOne('t_0000000001');

      expect(result).toMatchObject({
        id: 't_0000000001',
        title: '任务标题',
        status: 'pending',
        mainAgentInstanceId: 'tmm_0000000001',
        teamAgentIds: ['a_product', 'a_developer'],
      });
      // main 标记 = 团队主成员（team.mainAgentMemberId）
      expect(
        result.instances.find((i: any) => i.id === 'tmm_0000000001').main,
      ).toBe(true);
      expect(
        result.instances.find((i: any) => i.id === 'tmm_0000000002').main,
      ).toBe(false);
      expect(result.backgroundDocs).toEqual([{ name: '需求文档.pdf' }]);
      expect(result).not.toHaveProperty('projectId');
      // 详情查询无任务实例表读取
      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
      });
    });

    it('instances 携带会话状态快照 sessionStatus/sessionId（团队会话行，切页回来不丢工作中）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ teamId: 'tm_0000000001' }),
      );
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findMany.mockResolvedValue([
        tmmRow('tmm_0000000001', 'a_product'),
        tmmRow('tmm_0000000002', 'a_developer'),
      ]);
      (prisma.session as any).findMany = jest.fn().mockResolvedValue([
        {
          id: 's_0000000041',
          status: 'running',
          teamMemberId: 'tmm_0000000001',
        },
        {
          id: 's_0000000042',
          status: 'idle',
          teamMemberId: 'tmm_0000000002',
        },
      ]);

      const result = await service.findOne('t_0000000001');

      expect(
        result.instances.find((i: any) => i.id === 'tmm_0000000001'),
      ).toMatchObject({
        sessionStatus: 'running',
        sessionId: 's_0000000041',
      });
      expect(
        result.instances.find((i: any) => i.id === 'tmm_0000000002'),
      ).toMatchObject({
        sessionStatus: 'idle',
        sessionId: 's_0000000042',
      });
      for (const inst of result.instances) {
        expect(inst.id.startsWith('tmm_')).toBe(true);
      }
    });

    it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(service.findOne('t_missing')).rejects.toThrow(
        NotFoundException,
      );
      try {
        await service.findOne('t_missing');
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TASK_NOT_FOUND,
        });
      }
    });
  });

  describe('update（PATCH 编辑）', () => {
    it('mainAgentId 为团队内已选 Agent 时更新成功（同步映射到第一个实例）', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.teamMember.findMany.mockResolvedValue([
        memberRow('a_product'),
        memberRow('a_developer'),
      ]);
      prisma.task.update.mockResolvedValue(
        row({
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'tmm_0000000001',
          title: '改名',
        }),
      );

      const result = await service.update('t_0000000001', {
        title: '改名',
        mainAgentId: 'a_product',
      } as any);

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: {
          title: '改名',
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'tmm_0000000001',
        },
      });
      expect(result).toMatchObject({
        title: '改名',
        mainAgentId: 'a_product',
        mainAgentInstanceId: 'tmm_0000000001',
      });
    });

    it('mainAgentInstanceId 为团队内实例时更新成功（同步 mainAgentId）', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.teamMember.findMany.mockResolvedValue([
        memberRow('a_product'),
        memberRow('a_developer'),
      ]);
      prisma.task.update.mockResolvedValue(
        row({
          mainAgentId: 'a_developer',
          mainAgentInstanceId: 'tmm_0000000002',
        }),
      );

      const result = await service.update('t_0000000001', {
        mainAgentInstanceId: 'tmm_0000000002',
      } as any);

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: {
          mainAgentInstanceId: 'tmm_0000000002',
          mainAgentId: 'a_developer',
        },
      });
      expect(result).toMatchObject({ mainAgentInstanceId: 'tmm_0000000002' });
    });

    it('mainAgentInstanceId 非团队内实例 → 400 MAIN_AGENT_NOT_IN_TEAM', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.teamMember.findMany.mockResolvedValue([memberRow('a_product')]);

      await expect(
        service.update('t_0000000001', {
          mainAgentInstanceId: 'tmm_ghost',
        } as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.update('t_0000000001', {
          mainAgentInstanceId: 'tmm_ghost',
        } as any);
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: TASK_ERRORS.MAIN_AGENT_NOT_IN_TEAM,
        });
      }
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('mainAgentInstanceId 传 null → 清除主 Agent（mainAgentId 同步 null）', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.task.update.mockResolvedValue(
        row({ mainAgentId: null, mainAgentInstanceId: null }),
      );

      await service.update('t_0000000001', {
        mainAgentInstanceId: null,
      } as any);

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { mainAgentInstanceId: null, mainAgentId: null },
      });
    });

    it('mainAgentId 非团队内已选 Agent → 400 MAIN_AGENT_NOT_IN_TEAM', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.teamMember.findMany.mockResolvedValue([
        memberRow('a_product'),
        memberRow('a_developer'),
      ]);

      await expect(
        service.update('t_0000000001', { mainAgentId: 'a_tester' } as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.update('t_0000000001', {
          mainAgentId: 'a_tester',
        } as any);
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: TASK_ERRORS.MAIN_AGENT_NOT_IN_TEAM,
        });
      }
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.update('t_missing', { title: 'x' } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('backgroundDocs 更新生效（is_0000000011：PATCH 支持改背景文档，传 [] 清空）', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.task.update.mockResolvedValue(
        row({ backgroundDocs: [{ name: '新需求文档.md' }] }),
      );

      const result = await service.update('t_0000000001', {
        backgroundDocs: [{ name: '新需求文档.md' }],
      } as any);

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { backgroundDocs: [{ name: '新需求文档.md' }] },
      });
      expect(result.backgroundDocs).toEqual([{ name: '新需求文档.md' }]);
    });
  });

  describe('五态状态迁移（迁移表驱动 + CAS 乐观锁）', () => {
    it('start：pending → in_progress，CAS(where status+version) + version+1 + status_change 事件 + 广播 + 系统消息（群聊+私信主实例）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            status: 'pending',
            version: 3,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            version: 4,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
            startedAt: new Date(),
          }),
        );
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_0000000001' }) // task_group 频道
        .mockResolvedValueOnce({ id: 'c_0000000002' }); // 主成员 private 频道
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'tmm_0000000001',
        alias: '产品经理-1',
        agent: { id: 'a_product', name: '产品经理', role: 'product' },
      } as any);
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001') // 群聊系统消息
        .mockResolvedValueOnce('m_0000000002'); // 私信主实例
      const txModels = mockTransitionTx();

      const result = await service.start('t_0000000001', userId);

      expect(txModels.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000001', status: 'pending', version: 3 },
        data: {
          status: 'in_progress',
          version: { increment: 1 },
          startedAt: expect.any(Date),
        },
      });
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: {
          id: 'te_0000000001',
          taskId: 't_0000000001',
          eventType: 'status_change',
          fromStatus: 'pending',
          toStatus: 'in_progress',
          actorType: 'user',
          actorId: userId,
          metadata: undefined,
        },
      });
      // T4：启动事务内 created 会话全部置 active（where 限定 status=created，不误动 frozen）
      expect(txModels.session.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', status: 'created' },
        data: { status: 'active' },
      });
      // 私信定位按成员：private 频道查找 where 含 teamMemberId=主成员
      expect(prisma.chatChannel.findFirst).toHaveBeenNthCalledWith(2, {
        where: {
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
          type: 'private',
        },
        select: { id: true },
      });
      // 群聊系统消息（10 篇 §8.1：「任务已开始，主 Agent：产品经理-1」，主实例默认别名）
      assertSysMessageCreated(
        txModels,
        'c_0000000001',
        '任务已开始，主 Agent：产品经理-1',
        1,
      );
      // 私信主成员（13 篇 §4.2：含任务目标；团队分工段已随任务快照删除而移除）
      assertSysMessageCreated(
        txModels,
        'c_0000000002',
        '任务已启动，请作为主 Agent 牵头推进。任务目标：任务标题',
        2,
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        {
          taskId: 't_0000000001',
          from: 'pending',
          to: 'in_progress',
          actorType: 'user',
          actorId: userId,
        },
        { type: 'global' },
      );
      // 系统消息事务后广播 chat.message.new（群聊 + 私信各一）
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000001',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000002',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000002' },
      );
      expect(result.status).toBe('in_progress');
    });

    it('start：非前置状态（pending_review）→ 409 TASK_INVALID_TRANSITION', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          status: 'pending_review',
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'tmm_0000000001',
        }),
      );

      await assertInvalidTransition(
        () => service.start('t_0000000001', userId),
        'pending',
        'in_progress',
        'pending_review',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('start：已处目标态（in_progress）→ 幂等 200，不写事件不广播', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          status: 'in_progress',
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'tmm_0000000001',
        }),
      );

      const result = await service.start('t_0000000001', userId);

      expect(result.status).toBe('in_progress');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('start：created 会话全部置 active（T4；where 限定 status=created，frozen 不误动）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            status: 'pending',
            version: 0,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            version: 1,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
            startedAt: new Date(),
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('m_0000000002');
      const txModels = mockTransitionTx();

      await service.start('t_0000000001', userId);

      expect(txModels.session.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', status: 'created' },
        data: { status: 'active' },
      });
    });

    it('start：团队为空 → 400 TASK_EMPTY_TEAM', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          status: 'pending',
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'tmm_0000000001',
          legacySnapshots: [],
        }),
      );
      prisma.teamMember.count.mockResolvedValue(0);

      await assertBadRequestCode(
        () => service.start('t_0000000001', userId),
        TASK_ERRORS.TASK_EMPTY_TEAM,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('start：主实例未确定 → 400 MAIN_AGENT_NOT_SET', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          status: 'pending',
          mainAgentId: null,
          mainAgentInstanceId: null,
        }),
      );
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        mainAgentMemberId: null,
        currentTaskId: 't_0000000001',
      } as any);

      await assertBadRequestCode(
        () => service.start('t_0000000001', userId),
        TASK_ERRORS.MAIN_AGENT_NOT_SET,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('start：团队空闲 + 孤儿 pending → 认领队首后启动（取消排队死锁自愈）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            status: 'pending',
            version: 3,
            teamId: 'tm_1',
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            version: 4,
            teamId: 'tm_1',
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
            startedAt: new Date(),
          }),
        );
      // transition() 检查读到空闲 → 认领；其后 preflight 重读到已认领（生产 DB 真实推进，此处 mock 模拟）
      (prisma.team.findUnique as jest.Mock)
        .mockResolvedValueOnce({
          id: 'tm_1',
          version: 0,
          currentTaskId: null,
          mainAgentMemberId: 'tmm_0000000001',
        })
        .mockResolvedValue({
          id: 'tm_1',
          version: 1,
          currentTaskId: 't_0000000001',
          mainAgentMemberId: 'tmm_0000000001',
        });
      (prisma.team.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_0000000001' })
        .mockResolvedValueOnce({ id: 'c_0000000002' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('m_0000000002');
      const txModels = mockTransitionTx();

      const result = await service.start('t_0000000001', userId);

      expect(prisma.team.updateMany).toHaveBeenCalledWith({
        where: { id: 'tm_1', currentTaskId: null, version: 0 },
        data: { currentTaskId: 't_0000000001', version: { increment: 1 } },
      });
      expect(txModels.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000001', status: 'pending', version: 3 },
        data: {
          status: 'in_progress',
          version: { increment: 1 },
          startedAt: expect.any(Date),
        },
      });
      expect(result.status).toBe('in_progress');
    });

    it('start：团队忙碌且非队首 → 409 TEAM_NOT_QUEUE_HEAD（认领仅限空闲）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          status: 'pending',
          teamId: 'tm_1',
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'tmm_0000000001',
        }),
      );
      (prisma.team.findUnique as jest.Mock).mockResolvedValue({
        id: 'tm_1',
        version: 1,
        currentTaskId: 't_0000000009',
      });

      try {
        await service.start('t_0000000001', userId);
        fail('应抛出 ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TEAM_NOT_QUEUE_HEAD,
        });
      }
      expect(prisma.team.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('start：空闲认领并发冲突 → 409 VERSION_CONFLICT（可重试）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          status: 'pending',
          teamId: 'tm_1',
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'tmm_0000000001',
        }),
      );
      (prisma.team.findUnique as jest.Mock).mockResolvedValue({
        id: 'tm_1',
        version: 0,
        currentTaskId: null,
      });
      (prisma.team.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.start('t_0000000001', userId)).rejects.toThrow(
        '团队并发冲突，请重试',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('mark-pending-review：in_progress → pending_review，写 pendingReviewAt + 事件 + 广播 + 系统消息「任务已提交待验收」', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ status: 'in_progress', version: 5 }))
        .mockResolvedValue(
          row({
            status: 'pending_review',
            version: 6,
            pendingReviewAt: new Date(),
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTransitionTx();

      const result = await service.markPendingReview('t_0000000001', userId);

      expect(txModels.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000001', status: 'in_progress', version: 5 },
        data: {
          status: 'pending_review',
          version: { increment: 1 },
          pendingReviewAt: expect.any(Date),
        },
      });
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'status_change',
          fromStatus: 'in_progress',
          toStatus: 'pending_review',
        }),
      });
      // 系统消息落库：task_group 频道 senderType=system（10 篇 §8.1）
      assertSysMessageCreated(txModels, 'c_0000000001', '任务已提交待验收');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        expect.objectContaining({ from: 'in_progress', to: 'pending_review' }),
        { type: 'global' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000001',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(result.status).toBe('pending_review');
    });

    it('mark-pending-review：非前置状态（pending）→ 409 TASK_INVALID_TRANSITION', async () => {
      prisma.task.findUnique.mockResolvedValue(row({ status: 'pending' }));

      await assertInvalidTransition(
        () => service.markPendingReview('t_0000000001', userId),
        'in_progress',
        'pending_review',
        'pending',
      );
    });

    it('mark-pending-review：已处目标态（pending_review）→ 幂等 200', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending_review' }),
      );

      const result = await service.markPendingReview('t_0000000001', userId);

      expect(result.status).toBe('pending_review');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('accept：pending_review → completed，写 completedAt + accept 事件 + 广播 + 系统消息「任务已验收完成，产出物基线已锁定」', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ status: 'pending_review', version: 4 }))
        .mockResolvedValue(
          row({ status: 'completed', version: 5, completedAt: new Date() }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTransitionTx();

      const result = await service.accept('t_0000000001', userId);

      expect(txModels.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000001', status: 'pending_review', version: 4 },
        data: {
          status: 'completed',
          version: { increment: 1 },
          completedAt: expect.any(Date),
        },
      });
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'accept',
          fromStatus: 'pending_review',
          toStatus: 'completed',
        }),
      });
      // 系统消息落库（10 篇 §8.1，强调基线锁定）
      assertSysMessageCreated(
        txModels,
        'c_0000000001',
        '任务已验收完成，产出物基线已锁定',
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        expect.objectContaining({ from: 'pending_review', to: 'completed' }),
        { type: 'global' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000001',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000001' },
      );
      // 无产出物 → 不触发 accepted_flag 标记
      expect(txModels.artifactVersion.updateMany).not.toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });

    it('accept：锁定全部产出物当前版本基线（12 篇 §7，accepted_flag=true）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ status: 'pending_review', version: 4 }))
        .mockResolvedValue(
          row({ status: 'completed', version: 5, completedAt: new Date() }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTransitionTx();
      // 任务有两个产出物：art_1 当前 v2、art_2 当前 v1
      txModels.artifact.findMany.mockResolvedValue([
        { id: 'art_0000000001', currentVersion: 2 },
        { id: 'art_0000000002', currentVersion: 1 },
      ]);

      const result = await service.accept('t_0000000001', userId);

      expect(txModels.artifact.findMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001' },
        select: { id: true, currentVersion: true },
      });
      // (artifactId, version) 精确组合 OR 匹配，不误标非当前版本
      expect(txModels.artifactVersion.updateMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { artifactId: 'art_0000000001', version: 2 },
            { artifactId: 'art_0000000002', version: 1 },
          ],
        },
        data: { acceptedFlag: true },
      });
      expect(result.status).toBe('completed');
    });

    it('accept：主实例存在时私信主 Agent 记忆总结引导（senderType=system 落 private 频道 + 事务后广播）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            status: 'pending_review',
            version: 4,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({
            status: 'completed',
            version: 5,
            completedAt: new Date(),
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        );
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_0000000001' }) // task_group 频道
        .mockResolvedValueOnce({ id: 'c_0000000002' }); // 主成员 private 频道
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'tmm_0000000001',
        alias: '产品经理-1',
        agent: { id: 'a_product', name: '产品经理', role: 'product' },
      } as any);
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001') // 群聊系统消息
        .mockResolvedValueOnce('m_0000000002'); // 私信主实例
      const txModels = mockTransitionTx();

      const result = await service.accept('t_0000000001', userId);

      // 私信定位按成员：accept 与 start 同路径，private 频道查找 where 含 teamMemberId=主成员
      expect(prisma.chatChannel.findFirst).toHaveBeenNthCalledWith(2, {
        where: {
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
          type: 'private',
        },
        select: { id: true },
      });
      // 群聊系统消息（accept 群聊文案不变）
      assertSysMessageCreated(
        txModels,
        'c_0000000001',
        '任务已验收完成，产出物基线已锁定',
        1,
      );
      // 私信主实例：memory_save 引导文案（senderType=system 落 private 频道，被动提示）
      assertSysMessageCreated(
        txModels,
        'c_0000000002',
        '任务已验收完成，产出物基线已锁定。记忆收集已自动触发（见触发消息），请按其要求只沉淀可复用经验（做法/坑/约束），不要保存会话总结。',
        2,
      );
      // 系统消息事务后广播 chat.message.new（群聊 + 私信各一）
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000001',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000002',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000002' },
      );
      expect(result.status).toBe('completed');
    });

    it('accept：无团队主成员 → 正常完成，不解析 private 频道、不写私信、不报错', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ status: 'pending_review', version: 4 }))
        .mockResolvedValue(
          row({ status: 'completed', version: 5, completedAt: new Date() }),
        );
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        mainAgentMemberId: null,
        currentTaskId: 't_0000000001',
      } as any);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTransitionTx();

      const result = await service.accept('t_0000000001', userId);

      // 仅解析 task_group 频道一次（团队主成员=null 不查 private）
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledTimes(1);
      // 仅一条群聊系统消息，无私信落库
      expect(txModels.message.create).toHaveBeenCalledTimes(1);
      assertSysMessageCreated(
        txModels,
        'c_0000000001',
        '任务已验收完成，产出物基线已锁定',
        1,
      );
      expect(result.status).toBe('completed');
    });

    it('accept：非前置状态（in_progress）→ 409 TASK_INVALID_TRANSITION', async () => {
      prisma.task.findUnique.mockResolvedValue(row({ status: 'in_progress' }));

      await assertInvalidTransition(
        () => service.accept('t_0000000001', userId),
        'pending_review',
        'completed',
        'in_progress',
      );
    });

    it('accept：已处目标态（completed）→ 幂等 200', async () => {
      prisma.task.findUnique.mockResolvedValue(row({ status: 'completed' }));

      const result = await service.accept('t_0000000001', userId);

      expect(result.status).toBe('completed');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('reject：pending_review → in_progress，reason 写 metadata + 重置 pendingReviewAt + reject 事件 + 系统消息附驳回原因', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ status: 'pending_review', version: 2 }))
        .mockResolvedValue(
          row({ status: 'in_progress', version: 3, pendingReviewAt: null }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTransitionTx();

      await service.reject('t_0000000001', userId, {
        reason: '需求文档缺失性能测试结论',
      });

      expect(txModels.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000001', status: 'pending_review', version: 2 },
        data: {
          status: 'in_progress',
          version: { increment: 1 },
          pendingReviewAt: null,
        },
      });
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: {
          id: 'te_0000000001',
          taskId: 't_0000000001',
          eventType: 'reject',
          fromStatus: 'pending_review',
          toStatus: 'in_progress',
          actorType: 'user',
          actorId: userId,
          metadata: { reason: '需求文档缺失性能测试结论' },
        },
      });
      // 系统消息落库：附驳回原因（13 篇 §4.4）
      assertSysMessageCreated(
        txModels,
        'c_0000000001',
        '任务被驳回，请补齐产出后重新提交。驳回原因：需求文档缺失性能测试结论',
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        expect.objectContaining({ from: 'pending_review', to: 'in_progress' }),
        { type: 'global' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000001',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000001' },
      );
    });

    it('reject：非前置状态（completed）→ 409 TASK_INVALID_TRANSITION', async () => {
      prisma.task.findUnique.mockResolvedValue(row({ status: 'completed' }));

      await assertInvalidTransition(
        () => service.reject('t_0000000001', userId),
        'pending_review',
        'in_progress',
        'completed',
      );
    });

    it('reject：已处目标态（in_progress）→ 幂等 200', async () => {
      prisma.task.findUnique.mockResolvedValue(row({ status: 'in_progress' }));

      const result = await service.reject('t_0000000001', userId);

      expect(result.status).toBe('in_progress');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('archive：completed → archived，写 archivedAt + sessions 全部置 archived + archive 事件 + 广播 + 系统消息「任务已归档，历史可回看。任务级记忆已随验收沉淀（未总结不影响归档）」', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ status: 'completed', version: 7 }))
        .mockResolvedValue(
          row({ status: 'archived', version: 8, archivedAt: new Date() }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTransitionTx();

      const result = await service.archive('t_0000000001', userId);

      expect(txModels.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000001', status: 'completed', version: 7 },
        data: {
          status: 'archived',
          version: { increment: 1 },
          archivedAt: expect.any(Date),
        },
      });
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'archive',
          fromStatus: 'completed',
          toStatus: 'archived',
        }),
      });
      expect(txModels.session.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001' },
        data: { status: 'archived' },
      });
      // 系统消息落库（10 篇 §8.1，明确内容保留；mem-trigger 补充：任务级记忆已随验收沉淀）
      assertSysMessageCreated(
        txModels,
        'c_0000000001',
        '任务已归档，历史可回看。任务级记忆已随验收沉淀（未总结不影响归档）',
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        expect.objectContaining({ from: 'completed', to: 'archived' }),
        { type: 'global' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000001',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(result.status).toBe('archived');
    });

    it('archive：非前置状态（pending_review）→ 409 TASK_INVALID_TRANSITION', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending_review' }),
      );

      await assertInvalidTransition(
        () => service.archive('t_0000000001', userId),
        'completed',
        'archived',
        'pending_review',
      );
    });

    it('archive：已处目标态（archived）→ 幂等 200', async () => {
      prisma.task.findUnique.mockResolvedValue(row({ status: 'archived' }));

      const result = await service.archive('t_0000000001', userId);

      expect(result.status).toBe('archived');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('归档后（archived）任意状态迁移端点 → 409 TASK_INVALID_TRANSITION', async () => {
      prisma.task.findUnique.mockResolvedValue(row({ status: 'archived' }));

      await assertInvalidTransition(
        () => service.accept('t_0000000001', userId),
        'pending_review',
        'completed',
        'archived',
      );
      await assertInvalidTransition(
        () => service.markPendingReview('t_0000000001', userId),
        'in_progress',
        'pending_review',
        'archived',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('CAS 并发：updateMany 影响 0 行 → 重读已处目标态 → 幂等 200，无重复 task_events', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            status: 'pending',
            version: 0,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            version: 1,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        );
      const txModels = {
        task: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        taskEvent: { create: jest.fn() },
        session: { updateMany: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));

      const result = await service.start('t_0000000001', userId);

      expect(txModels.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000001', status: 'pending', version: 0 },
        data: {
          status: 'in_progress',
          version: { increment: 1 },
          startedAt: expect.any(Date),
        },
      });
      expect(result.status).toBe('in_progress');
      expect(txModels.taskEvent.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('CAS 并发：两个并发 start → 一个成功一个重读幂等 200，无重复 task_events；成功方系统消息落库', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            status: 'pending',
            version: 0,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValueOnce(
          row({
            status: 'in_progress',
            version: 1,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValueOnce(
          row({
            status: 'pending',
            version: 0,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            version: 1,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        );
      // 每次 start 均先查 group 频道再查 private 频道（两个并发 start 共 4 次）
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_1' })
        .mockResolvedValueOnce({ id: 'c_2' })
        .mockResolvedValueOnce({ id: 'c_1' })
        .mockResolvedValue({ id: 'c_2' });
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'tmm_0000000001',
        alias: '产品经理-1',
        agent: { id: 'a_product', name: '产品经理', role: 'product' },
      } as any);
      const txModels = {
        task: {
          updateMany: jest
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValue({ count: 0 }),
        },
        taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
        session: { updateMany: jest.fn() },
        artifact: { findMany: jest.fn().mockResolvedValue([]) },
        artifactVersion: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        message: {
          create: jest.fn().mockImplementation(({ data }: { data: any }) => ({
            id: data.id,
            channelId: data.channelId,
            senderType: data.senderType,
            senderId: data.senderId,
            content: data.content,
            mentions: data.mentions,
            status: data.status,
            createdAt: new Date('2026-08-07T00:00:00Z'),
          })),
        },
        plan: { update: jest.fn().mockResolvedValue({ id: 'pl_1' }) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('m_0000000002');

      const r1 = await service.start('t_0000000001', userId);
      const r2 = await service.start('t_0000000001', userId);

      expect(r1.status).toBe('in_progress');
      expect(r2.status).toBe('in_progress');
      expect(txModels.taskEvent.create).toHaveBeenCalledTimes(1);
      // 成功方（第一次 start）系统消息落库：群聊 + 私信各一条（主实例默认别名）
      assertSysMessageCreated(
        txModels,
        'c_1',
        '任务已开始，主 Agent：产品经理-1',
        1,
      );
      assertSysMessageCreated(
        txModels,
        'c_2',
        '任务已启动，请作为主 Agent 牵头推进。任务目标：任务标题',
        2,
      );
      // task.status.changed 1 次 + chat.message.new 2 次
      const chatNewCalls = realtime.broadcast.mock.calls.filter(
        (call) => call[0] === EVENT_TYPES.CHAT_MESSAGE_NEW,
      );
      expect(chatNewCalls).toHaveLength(2);
    });

    it('transitionByAgent：主实例 start → actor=agent 写入 task_events + TASK_STATUS_CHANGED 广播 + 系统消息照常', async () => {
      // 首次查询为 transitionByAgent 主成员校验（仅 select id/teamId，经团队主成员门）
      prisma.task.findUnique
        .mockResolvedValueOnce({
          id: 't_0000000001',
          teamId: 'tm_0000000001',
        })
        .mockResolvedValueOnce(
          row({
            status: 'pending',
            version: 3,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            version: 4,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
            startedAt: new Date(),
          }),
        );
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_0000000001' }) // task_group 频道
        .mockResolvedValueOnce({ id: 'c_0000000002' }); // 主成员 private 频道
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'tmm_0000000001',
        alias: '产品经理-1',
        agent: { id: 'a_product', name: '产品经理', role: 'product' },
      } as any);
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('m_0000000002');
      const txModels = mockTransitionTx();

      const result = await service.transitionByAgent(
        't_0000000001',
        'tmm_0000000001',
        'start',
      );

      expect(result.status).toBe('in_progress');
      // task_events 记 actor=agent/实例（非 user/用户）
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: {
          id: 'te_0000000001',
          taskId: 't_0000000001',
          eventType: 'status_change',
          fromStatus: 'pending',
          toStatus: 'in_progress',
          actorType: 'agent',
          actorId: 'tmm_0000000001',
          metadata: undefined,
        },
      });
      // 广播 actor=agent/实例
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        {
          taskId: 't_0000000001',
          from: 'pending',
          to: 'in_progress',
          actorType: 'agent',
          actorId: 'tmm_0000000001',
        },
        { type: 'global' },
      );
      // 系统消息照常落库（主实例别名）
      assertSysMessageCreated(
        txModels,
        'c_0000000001',
        '任务已开始，主 Agent：产品经理-1',
        1,
      );
    });

    it('transitionByAgent：非主实例 → 403 TASK_STATUS_MAIN_AGENT_ONLY（不触达状态机）', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't_0000000001',
        teamId: 'tm_0000000001',
      });

      try {
        await service.transitionByAgent(
          't_0000000001',
          'tmm_0000000002',
          'start',
        );
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TASK_STATUS_MAIN_AGENT_ONLY,
          message:
            '仅主 Agent（tmm_0000000001）可流转任务状态；请知会主 Agent 调用 task_transition，或由管理员在任务管理界面操作',
        });
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('transitionByAgent：任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      try {
        await service.transitionByAgent('t_ghost', 'tmm_0000000001', 'start');
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TASK_NOT_FOUND,
        });
      }
    });

    it('transitionByAgent：reject 的 reason 透传 metadata（actor=agent）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce({
          id: 't_0000000001',
          teamId: 'tm_0000000001',
        })
        .mockResolvedValueOnce(
          row({
            status: 'pending_review',
            version: 2,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({ status: 'in_progress', version: 3, pendingReviewAt: null }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTransitionTx();

      await service.transitionByAgent(
        't_0000000001',
        'tmm_0000000001',
        'reject',
        {
          reason: '性能测试不达标',
        },
      );

      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'reject',
          actorType: 'agent',
          actorId: 'tmm_0000000001',
          metadata: { reason: '性能测试不达标' },
        }),
      });
      assertSysMessageCreated(
        txModels,
        'c_0000000001',
        '任务被驳回，请补齐产出后重新提交。驳回原因：性能测试不达标',
      );
    });

    it('transitionByAgent：mark-pending-review 主实例成功（各 action 复用 transitionOpts）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce({
          id: 't_0000000001',
          teamId: 'tm_0000000001',
        })
        .mockResolvedValueOnce(
          row({
            status: 'in_progress',
            version: 5,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({
            status: 'pending_review',
            version: 6,
            pendingReviewAt: new Date(),
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTransitionTx();

      const result = await service.transitionByAgent(
        't_0000000001',
        'tmm_0000000001',
        'mark-pending-review',
      );

      expect(result.status).toBe('pending_review');
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'status_change',
          actorType: 'agent',
          actorId: 'tmm_0000000001',
        }),
      });
      assertSysMessageCreated(txModels, 'c_0000000001', '任务已提交待验收');
    });

    describe('tc-flow：plan 模式分支（start/mark-pending-review/accept/archive）', () => {
      it('start（plan 模式）：计划已评审通过 → 成功 + 事务内计划置 executing（approved → executing）', async () => {
        prisma.task.findUnique
          .mockResolvedValueOnce(
            row({
              status: 'pending',
              version: 3,
              executionMode: EXECUTION_MODES.plan,
              mainAgentId: 'a_product',
              mainAgentInstanceId: 'tmm_0000000001',
            }),
          )
          .mockResolvedValue(
            row({
              status: 'in_progress',
              version: 4,
              executionMode: EXECUTION_MODES.plan,
              mainAgentId: 'a_product',
              mainAgentInstanceId: 'tmm_0000000001',
              startedAt: new Date(),
            }),
          );
        prisma.plan.findUnique.mockResolvedValue({
          id: 'pl_1',
          status: PLAN_STATUS.approved,
        });
        prisma.chatChannel.findFirst
          .mockResolvedValueOnce({ id: 'c_0000000001' })
          .mockResolvedValueOnce({ id: 'c_0000000002' });
        idGen.nextId
          .mockResolvedValueOnce('te_0000000001')
          .mockResolvedValueOnce('m_0000000001')
          .mockResolvedValueOnce('m_0000000002');
        const txModels = mockTransitionTx();

        const result = await service.start('t_0000000001', userId);

        expect(prisma.plan.findUnique).toHaveBeenCalledWith({
          where: { taskId: 't_0000000001' },
          select: { status: true },
        });
        expect(txModels.plan.update).toHaveBeenCalledWith({
          where: { taskId: 't_0000000001' },
          data: { status: PLAN_STATUS.executing },
        });
        expect(result.status).toBe('in_progress');
      });

      it('start（plan 模式）：计划不存在 → 400 PLAN_NOT_APPROVED（不触达事务）', async () => {
        prisma.task.findUnique.mockResolvedValue(
          row({
            status: 'pending',
            executionMode: EXECUTION_MODES.plan,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        );
        prisma.plan.findUnique.mockResolvedValue(null);

        await assertBadRequestCode(
          () => service.start('t_0000000001', userId),
          PLAN_ERRORS.PLAN_NOT_APPROVED,
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('start（plan 模式）：计划未评审通过（reviewing）→ 400 PLAN_NOT_APPROVED', async () => {
        prisma.task.findUnique.mockResolvedValue(
          row({
            status: 'pending',
            executionMode: EXECUTION_MODES.plan,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        );
        prisma.plan.findUnique.mockResolvedValue({
          id: 'pl_1',
          status: PLAN_STATUS.reviewing,
        });

        await assertBadRequestCode(
          () => service.start('t_0000000001', userId),
          PLAN_ERRORS.PLAN_NOT_APPROVED,
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('start（direct 模式）：不查计划、不置 executing（plan 分支零触发）', async () => {
        prisma.task.findUnique
          .mockResolvedValueOnce(
            row({
              status: 'pending',
              version: 0,
              executionMode: EXECUTION_MODES.direct,
              mainAgentId: 'a_product',
              mainAgentInstanceId: 'tmm_0000000001',
            }),
          )
          .mockResolvedValue(
            row({
              status: 'in_progress',
              version: 1,
              executionMode: EXECUTION_MODES.direct,
              mainAgentId: 'a_product',
              mainAgentInstanceId: 'tmm_0000000001',
              startedAt: new Date(),
            }),
          );
        prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
        idGen.nextId
          .mockResolvedValueOnce('te_0000000001')
          .mockResolvedValueOnce('m_0000000001')
          .mockResolvedValueOnce('m_0000000002');
        const txModels = mockTransitionTx();

        await service.start('t_0000000001', userId);

        expect(prisma.plan.findUnique).not.toHaveBeenCalled();
        expect(txModels.plan.update).not.toHaveBeenCalled();
      });

      it('mark-pending-review（plan 模式）：存在未完成计划子任务 → 409 PLAN_TASKS_INCOMPLETE', async () => {
        prisma.task.findUnique.mockResolvedValue(
          row({
            status: 'in_progress',
            version: 5,
            executionMode: EXECUTION_MODES.plan,
          }),
        );
        prisma.planTask.findFirst.mockResolvedValue({ id: 'pt_1' });

        try {
          await service.markPendingReview('t_0000000001', userId);
          fail('应抛出 ConflictException');
        } catch (e) {
          expect(e).toBeInstanceOf(ConflictException);
          expect((e as ConflictException).getResponse()).toMatchObject({
            code: PLAN_ERRORS.PLAN_TASKS_INCOMPLETE,
          });
        }
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('mark-pending-review（plan 模式）：全部计划子任务完成 → 成功', async () => {
        prisma.task.findUnique
          .mockResolvedValueOnce(
            row({
              status: 'in_progress',
              version: 5,
              executionMode: EXECUTION_MODES.plan,
            }),
          )
          .mockResolvedValue(
            row({
              status: 'pending_review',
              version: 6,
              executionMode: EXECUTION_MODES.plan,
              pendingReviewAt: new Date(),
            }),
          );
        prisma.planTask.findFirst.mockResolvedValue(null);
        prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
        idGen.nextId
          .mockResolvedValueOnce('te_0000000001')
          .mockResolvedValueOnce('m_0000000001');
        const txModels = mockTransitionTx();

        const result = await service.markPendingReview('t_0000000001', userId);

        expect(prisma.planTask.findFirst).toHaveBeenCalledWith({
          where: {
            plan: { taskId: 't_0000000001' },
            status: {
              in: [PLAN_TASK_STATUS.pending, PLAN_TASK_STATUS.in_progress],
            },
          },
          select: { id: true },
        });
        expect(result.status).toBe('pending_review');
      });

      it('mark-pending-review（direct 模式）：不查计划子任务', async () => {
        prisma.task.findUnique
          .mockResolvedValueOnce(
            row({
              status: 'in_progress',
              version: 5,
              executionMode: EXECUTION_MODES.direct,
            }),
          )
          .mockResolvedValue(
            row({
              status: 'pending_review',
              version: 6,
              executionMode: EXECUTION_MODES.direct,
              pendingReviewAt: new Date(),
            }),
          );
        prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
        idGen.nextId
          .mockResolvedValueOnce('te_0000000001')
          .mockResolvedValueOnce('m_0000000001');
        const txModels = mockTransitionTx();

        await service.markPendingReview('t_0000000001', userId);

        expect(prisma.planTask.findFirst).not.toHaveBeenCalled();
        expect(txModels.plan.update).not.toHaveBeenCalled();
      });

      it('accept（plan 模式）：存在计划 → 验收通过后计划置 completed', async () => {
        prisma.task.findUnique
          .mockResolvedValueOnce(
            row({
              status: 'pending_review',
              version: 4,
              executionMode: EXECUTION_MODES.plan,
            }),
          )
          .mockResolvedValue(
            row({
              status: 'completed',
              version: 5,
              executionMode: EXECUTION_MODES.plan,
              completedAt: new Date(),
            }),
          );
        prisma.plan.findUnique.mockResolvedValue({
          id: 'pl_1',
          status: PLAN_STATUS.executing,
        });
        prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
        idGen.nextId
          .mockResolvedValueOnce('te_0000000001')
          .mockResolvedValueOnce('m_0000000001');
        const txModels = mockTransitionTx();

        const result = await service.accept('t_0000000001', userId);

        expect(txModels.plan.update).toHaveBeenCalledWith({
          where: { taskId: 't_0000000001' },
          data: { status: PLAN_STATUS.completed },
        });
        expect(result.status).toBe('completed');
      });

      it('accept（direct 模式）：不查计划、不置 completed', async () => {
        prisma.task.findUnique
          .mockResolvedValueOnce(
            row({
              status: 'pending_review',
              version: 4,
              executionMode: EXECUTION_MODES.direct,
            }),
          )
          .mockResolvedValue(
            row({
              status: 'completed',
              version: 5,
              executionMode: EXECUTION_MODES.direct,
              completedAt: new Date(),
            }),
          );
        prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
        idGen.nextId
          .mockResolvedValueOnce('te_0000000001')
          .mockResolvedValueOnce('m_0000000001');
        const txModels = mockTransitionTx();

        await service.accept('t_0000000001', userId);

        expect(prisma.plan.findUnique).not.toHaveBeenCalled();
        expect(txModels.plan.update).not.toHaveBeenCalled();
      });

      it('archive（plan 模式）：存在计划 → 归档后计划置 completed', async () => {
        prisma.task.findUnique
          .mockResolvedValueOnce(
            row({
              status: 'completed',
              version: 6,
              executionMode: EXECUTION_MODES.plan,
            }),
          )
          .mockResolvedValue(
            row({
              status: 'archived',
              version: 7,
              executionMode: EXECUTION_MODES.plan,
              archivedAt: new Date(),
            }),
          );
        prisma.plan.findUnique.mockResolvedValue({
          id: 'pl_1',
          status: PLAN_STATUS.completed,
        });
        prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
        idGen.nextId
          .mockResolvedValueOnce('te_0000000001')
          .mockResolvedValueOnce('m_0000000001');
        const txModels = mockTransitionTx();

        const result = await service.archive('t_0000000001', userId);

        expect(txModels.plan.update).toHaveBeenCalledWith({
          where: { taskId: 't_0000000001' },
          data: { status: PLAN_STATUS.completed },
        });
        expect(result.status).toBe('archived');
      });

      it('archive（direct 模式）：不查计划、不置 completed', async () => {
        prisma.task.findUnique
          .mockResolvedValueOnce(
            row({
              status: 'completed',
              version: 6,
              executionMode: EXECUTION_MODES.direct,
            }),
          )
          .mockResolvedValue(
            row({
              status: 'archived',
              version: 7,
              executionMode: EXECUTION_MODES.direct,
              archivedAt: new Date(),
            }),
          );
        prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
        idGen.nextId
          .mockResolvedValueOnce('te_0000000001')
          .mockResolvedValueOnce('m_0000000001');
        const txModels = mockTransitionTx();

        await service.archive('t_0000000001', userId);

        expect(prisma.plan.findUnique).not.toHaveBeenCalled();
        expect(txModels.plan.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('updateTeam（团队调整，14 篇 §5.3 FR-02）', () => {
    /** team 调整事务的 tx mock：团队成员创建（seq/别名）+ 删除 + 会话冻结 + 主成员清空 + 系统消息全部可写，返回 tx 供断言。 */
    const mockTeamTx = () => {
      const txModels = {
        teamMember: {
          create: jest.fn().mockImplementation(({ data }: any) =>
            Promise.resolve({
              id: data.id,
              alias: data.alias,
              seq: data.seq,
            }),
          ),
          delete: jest.fn().mockResolvedValue({ id: 'tmm_1' }),
          aggregate: jest.fn().mockResolvedValue({ _max: { seq: 0 } }),
        },
        team: { update: jest.fn().mockResolvedValue({ id: 'tm_0000000001' }) },
        agent: {
          findUnique: jest
            .fn()
            .mockImplementation(({ where }: any) =>
              Promise.resolve({ id: where.id, ...mockAgentMeta(where.id) }),
            ),
        },
        session: {
          create: jest.fn().mockResolvedValue({ id: 's_1' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        task: { update: jest.fn().mockResolvedValue({ id: 't_1' }) },
        taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
        message: {
          create: jest.fn().mockResolvedValue({
            id: 'm_0000000001',
            channelId: 'c_0000000001',
            senderType: 'system',
            senderId: null,
            content: { text: '', parts: [] },
            mentions: null,
            status: 'sent',
            createdAt: new Date('2026-08-07T00:00:00Z'),
          }),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
      return txModels;
    };

    it('add 实例：写 team_members 零会话写 + 系统消息「{别名} 已加入团队」+ 广播 team.changed(add 含 instanceId/alias)', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ legacySnapshots: [memberRow('a_product')] }))
        .mockResolvedValue(
          row({
            teamId: 'tm_0000000001',
            legacySnapshots: [memberRow('a_product'), memberRow('a_developer')],
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findMany.mockResolvedValue([
        tmmRow('tmm_0000000001', 'a_product'),
        tmmRow('tmm_0000000002', 'a_developer'),
      ]);
      (prisma.session as any).findMany = jest.fn().mockResolvedValue([]);
      idGen.nextId
        .mockResolvedValueOnce('tmm_0000000002')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { addInstances: [{ agentId: 'a_developer' }] },
        userId,
      );

      expect(txModels.teamMember.create).toHaveBeenCalledWith({
        data: {
          id: 'tmm_0000000002',
          teamId: 'tm_0000000001',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
          workDir: '/data/vteam-worker/开发者',
        },
      });
      expect(txModels.session.create).not.toHaveBeenCalled();
      expect(txModels.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'c_0000000001',
          senderType: 'system',
          senderId: null,
          content: { text: '开发者-1 已加入团队', parts: [] },
          status: 'sent',
        }),
      });
      expect(txModels.session.updateMany).not.toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        {
          taskId: 't_0000000001',
          action: 'add',
          instanceId: 'tmm_0000000002',
          agentId: 'a_developer',
          alias: '开发者-1',
        },
        { type: 'task', id: 't_0000000001' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_0000000001',
            senderType: 'system',
          }),
        },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(result.teamAgentIds).toEqual(['a_product', 'a_developer']);
    });

    it('add 同 agent 第二个实例：seq = 已用最大 seq + 1（并发防重号）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ legacySnapshots: [memberRow('a_developer')] }))
        .mockResolvedValue(
          row({
            legacySnapshots: [
              memberRow('a_developer'),
              memberRow('a_developer', {
                id: 'tmm_0000000003',
                alias: '开发者-2',
                seq: 2,
              }),
            ],
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId
        .mockResolvedValueOnce('tmm_0000000003')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();
      txModels.teamMember.aggregate.mockResolvedValue({ _max: { seq: 1 } });

      await service.updateTeam(
        't_0000000001',
        { addInstances: [{ agentId: 'a_developer' }] },
        userId,
      );

      expect(txModels.teamMember.aggregate).toHaveBeenCalledWith({
        _max: { seq: true },
        where: { teamId: 'tm_0000000001', agentId: 'a_developer' },
      });
      expect(txModels.teamMember.create).toHaveBeenCalledWith({
        data: {
          id: 'tmm_0000000003',
          teamId: 'tm_0000000001',
          agentId: 'a_developer',
          alias: '开发者-2',
          seq: 2,
          workDir: '/data/vteam-worker/开发者-2',
        },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        {
          taskId: 't_0000000001',
          action: 'add',
          instanceId: 'tmm_0000000003',
          agentId: 'a_developer',
          alias: '开发者-2',
        },
        { type: 'task', id: 't_0000000001' },
      );
    });

    it('add 实例：任务 in_progress 时亦零会话写（T4 衔接：会话归团队侧）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ status: 'in_progress', legacySnapshots: [memberRow('a_product')] }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            legacySnapshots: [memberRow('a_product'), memberRow('a_developer')],
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId
        .mockResolvedValueOnce('tmm_0000000002')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      await service.updateTeam(
        't_0000000001',
        { addInstances: [{ agentId: 'a_developer' }] },
        userId,
      );

      expect(txModels.teamMember.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          teamId: 'tm_0000000001',
          agentId: 'a_developer',
        }),
      });
      expect(txModels.session.create).not.toHaveBeenCalled();
    });

    it('remove：按成员 id 删除成员行 + 会话冻结 frozen + 系统消息「{别名} 已移出团队，其会话已冻结」+ 广播 remove', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            legacySnapshots: [
              memberRow('a_product'),
              memberRow('a_tester', { id: 'tmm_0000000003' }),
            ],
          }),
        )
        .mockResolvedValue(
          row({
            teamId: 'tm_0000000001',
            legacySnapshots: [memberRow('a_product')],
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findMany
        .mockResolvedValueOnce([
          tmmRow('tmm_0000000001', 'a_product'),
          tmmRow('tmm_0000000003', 'a_tester'),
        ])
        .mockResolvedValue([tmmRow('tmm_0000000001', 'a_product')]);
      (prisma.session as any).findMany = jest.fn().mockResolvedValue([]);
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { removeInstanceIds: ['tmm_0000000003'] },
        userId,
      );

      expect(txModels.teamMember.delete).toHaveBeenCalledWith({
        where: { id: 'tmm_0000000003' },
      });
      expect(txModels.session.updateMany).toHaveBeenCalledWith({
        where: { teamMemberId: 'tmm_0000000003' },
        data: { status: 'frozen' },
      });
      expect(txModels.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content: { text: '测试-1 已移出团队，其会话已冻结', parts: [] },
        }),
      });
      expect(txModels.teamMember.create).not.toHaveBeenCalled();
      expect(txModels.task.update).not.toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        {
          taskId: 't_0000000001',
          action: 'remove',
          instanceId: 'tmm_0000000003',
          agentId: 'a_tester',
          alias: '测试-1',
        },
        { type: 'task', id: 't_0000000001' },
      );
      expect(realtime.broadcast).not.toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        { taskId: 't_0000000001', action: 'add' },
        { type: 'task', id: 't_0000000001' },
      );
      expect(result.teamAgentIds).toEqual(['a_product']);
    });

    it('remove 主成员 → 团队主成员清空（任务侧主标量同步 null）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          }),
        )
        .mockResolvedValue(
          row({ mainAgentId: null, mainAgentInstanceId: null }),
        );
      prisma.teamMember.findMany.mockResolvedValue([
        tmmRow('tmm_0000000001', 'a_product'),
      ]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { removeInstanceIds: ['tmm_0000000001'] },
        userId,
      );

      expect(txModels.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { mainAgentId: null, mainAgentInstanceId: null },
      });
      expect(result.mainAgentId).toBeNull();
      expect(result.mainAgentInstanceId).toBeNull();
    });

    it('remove 不在团队/已移除 → 幂等 200：无事务、无广播', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ teamId: 'tm_0000000001' }),
      );
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findMany.mockResolvedValue([
        tmmRow('tmm_0000000001', 'a_product'),
        tmmRow('tmm_0000000002', 'a_developer'),
      ]);
      (prisma.session as any).findMany = jest.fn().mockResolvedValue([]);

      const result = await service.updateTeam(
        't_0000000001',
        { removeInstanceIds: ['tmm_ghost'] },
        userId,
      );

      expect(result.teamAgentIds).toEqual(['a_product', 'a_developer']);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('空请求（add/remove 皆无）→ 幂等返回当前任务', async () => {
      prisma.task.findUnique.mockResolvedValue(row());

      const result = await service.updateTeam('t_0000000001', {}, userId);

      expect(result.id).toBe('t_0000000001');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('时间窗外（pending_review/completed/archived）→ 409 TASK_TEAM_NOT_ALLOWED', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending_review' }),
      );

      try {
        await service.updateTeam(
          't_0000000001',
          { addInstances: [{ agentId: 'a_developer' }] },
          userId,
        );
        fail('应抛出 ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TASK_TEAM_NOT_ALLOWED,
          details: { current: 'pending_review' },
        });
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('add 目标 Agent 不存在 → 404 AGENT_NOT_FOUND（事务回滚）', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('tmm_0000000003');
      const txModels = mockTeamTx();
      txModels.agent.findUnique.mockResolvedValue(null);

      try {
        await service.updateTeam(
          't_0000000001',
          { addInstances: [{ agentId: 'ghost' }] },
          userId,
        );
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: TASK_ERRORS.AGENT_NOT_FOUND,
        });
      }
      expect(txModels.teamMember.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.updateTeam(
          't_missing',
          { addInstances: [{ agentId: 'a_developer' }] },
          userId,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('add 实例：写 team_add task_event 审计（actorType/actorId=user/userId）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ legacySnapshots: [memberRow('a_product')] }))
        .mockResolvedValue(
          row({ legacySnapshots: [memberRow('a_product'), memberRow('a_developer')] }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId
        .mockResolvedValueOnce('tmm_0000000002')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('te_0000000001');
      const txModels = mockTeamTx();

      await service.updateTeam(
        't_0000000001',
        { addInstances: [{ agentId: 'a_developer' }] },
        userId,
      );

      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: {
          id: 'te_0000000001',
          taskId: 't_0000000001',
          eventType: 'team_add',
          fromStatus: null,
          toStatus: null,
          actorType: 'user',
          actorId: userId,
          metadata: { agentIds: ['a_developer'], confirmedBy: null },
        },
      });
    });

    it('确认门增员（opts actor/confirmedBy）→ 系统消息标注「经主 Agent 申请、<确认方> 确认」+ team_add 审计 actor=agent/主实例', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ legacySnapshots: [memberRow('a_product')] }))
        .mockResolvedValue(
          row({ legacySnapshots: [memberRow('a_product'), memberRow('a_developer')] }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId
        .mockResolvedValueOnce('tmm_0000000002')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('te_0000000001');
      const txModels = mockTeamTx();

      await service.updateTeam(
        't_0000000001',
        { addInstances: [{ agentId: 'a_developer' }] },
        undefined,
        { actorType: 'agent', actorId: 'tmm_main', confirmedBy: '主 Agent' },
      );

      expect(txModels.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content: {
            text: '开发者-1 已加入团队（经主 Agent 申请、主 Agent 确认）',
            parts: [],
          },
        }),
      });
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: {
          id: 'te_0000000001',
          taskId: 't_0000000001',
          eventType: 'team_add',
          fromStatus: null,
          toStatus: null,
          actorType: 'agent',
          actorId: 'tmm_main',
          metadata: { agentIds: ['a_developer'], confirmedBy: '主 Agent' },
        },
      });
    });
  });

  describe('T12 会话实例查询（Todo10：委托团队键查询）', () => {
    it('getInstancesByTeamMember 委托返回成员全部实例', async () => {
      const rows = [{ id: 'ti_1', instanceId: 'ses_1' }];
      sessionLifecycle.getInstancesByTeamMember.mockResolvedValue(rows);

      const result = await service.getInstancesByTeamMember(
        'tm_0000000001',
        'tmm_0000000001',
      );

      expect(sessionLifecycle.getInstancesByTeamMember).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000001',
      );
      expect(result).toEqual(rows);
    });

    it('getInstanceBySession 委托返回会话绑定实例（未绑定 → null）', async () => {
      const row = { id: 'ti_1', instanceId: 'ses_1' };
      sessionLifecycle.getInstanceBySession.mockResolvedValue(row);

      const result = await service.getInstanceBySession('s_1');

      expect(sessionLifecycle.getInstanceBySession).toHaveBeenCalledWith('s_1');
      expect(result).toEqual(row);
    });
  });

  describe('create（tc-flow）：executionMode 落库', () => {
    it('缺省 direct；显式 plan 落库（Todo9 起 tasks 不再接受 managedMode，托管开关走团队行）', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      } as any);
      const teamId = 'tm_0000000001';
      const mockTeam = {
        id: teamId,
        version: 0,
        currentTaskId: null,
        reuseSession: true,
      };
      const members = [
        {
          id: 'tmm_0000000001',
          teamId,
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
          workDir: '/data/vteam-worker/开发者',
          agent: { id: 'a_developer', name: '开发者', role: 'developer' },
        },
      ];
      let captured: any[] = [];
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          team: {
            findUnique: jest.fn().mockResolvedValue(mockTeam),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          teamMember: { findMany: jest.fn().mockResolvedValue(members) },
          teamQueue: {
            create: jest.fn(),
            aggregate: jest.fn().mockResolvedValue({ _max: { position: 0 } }),
          },
          task: {
            create: jest.fn().mockImplementation(({ data }: any) => {
              captured.push(data);
              return Promise.resolve(data);
            }),
          },
          chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
          session: { create: jest.fn().mockResolvedValue({ id: 's_1' }) },
          taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
          $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
        }),
      );
      prisma.task.findUnique.mockResolvedValue(
        row({ id: 't_0000000001', teamId, executionMode: 'direct' }) as any,
      );
      idGen.nextId.mockResolvedValue('t_0000000001');
      await service.create(userId, { title: '任务', teamId } as any);
      expect(captured[0].executionMode).toBe(EXECUTION_MODES.direct);
      // second call with plan
      prisma.task.findUnique.mockResolvedValue(
        row({ id: 't_0000000002', teamId, executionMode: 'plan' }) as any,
      );
      idGen.nextId.mockResolvedValue('t_0000000002');
      captured = [];
      // need new transaction mock to capture second
      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          team: {
            findUnique: jest.fn().mockResolvedValue({
              id: teamId,
              version: 1,
              currentTaskId: 't_0000000001',
              reuseSession: true,
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          teamMember: { findMany: jest.fn().mockResolvedValue(members) },
          teamQueue: {
            create: jest.fn().mockResolvedValue({ id: 'tq_1' }),
            aggregate: jest.fn().mockResolvedValue({ _max: { position: 0 } }),
          },
          task: {
            create: jest.fn().mockImplementation(({ data }: any) => {
              captured.push(data);
              return Promise.resolve(data);
            }),
          },
          chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
          session: { create: jest.fn().mockResolvedValue({ id: 's_1' }) },
          taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
          $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
        }),
      );
      await service.create(userId, {
        title: '任务',
        teamId,
        executionMode: EXECUTION_MODES.plan,
      } as any);
      expect(captured[0].executionMode).toBe(EXECUTION_MODES.plan);
      expect(captured[0].managedMode).toBeUndefined();
    });
  });

  describe('updateExecutionMode（tc-flow：执行模式切换）', () => {
    it('plan → direct 直接切换（只更新任务执行模式，计划保持现状）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.plan }),
      );
      prisma.task.update.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.direct }),
      );

      const result = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.direct,
      );

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { executionMode: EXECUTION_MODES.direct },
      });
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(result.executionMode).toBe(EXECUTION_MODES.direct);
    });

    it('direct → plan 且任务无计划 → 直接切换成功（切换=意图声明，计划门在 start）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.direct }),
      );
      prisma.task.update.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.plan }),
      );

      const result = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.plan,
      );

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { executionMode: EXECUTION_MODES.plan },
      });
      expect(prisma.plan.findUnique).not.toHaveBeenCalled();
      expect(result.executionMode).toBe(EXECUTION_MODES.plan);
    });

    it('direct → plan 且计划未评审通过（reviewing）→ 仍切换成功（计划状态不拦截切换）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.direct }),
      );
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        status: PLAN_STATUS.reviewing,
      });
      prisma.task.update.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.plan }),
      );

      const result = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.plan,
      );

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { executionMode: EXECUTION_MODES.plan },
      });
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(result.executionMode).toBe(EXECUTION_MODES.plan);
    });

    it('direct → plan 计划已 approved（任务未开始）→ 仅切换模式，计划保持 approved', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.direct }),
      );
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        status: PLAN_STATUS.approved,
      });
      prisma.task.update.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.plan }),
      );

      const result = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.plan,
      );

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { executionMode: EXECUTION_MODES.plan },
      });
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(result.executionMode).toBe(EXECUTION_MODES.plan);
    });

    it('direct → plan 计划 approved 且任务已 in_progress → 事务内顺带计划置 executing', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'in_progress', executionMode: EXECUTION_MODES.direct }),
      );
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        status: PLAN_STATUS.approved,
      });
      const txModels = {
        plan: { update: jest.fn().mockResolvedValue({ id: 'pl_1' }) },
        task: {
          update: jest.fn().mockResolvedValue(
            row({
              status: 'in_progress',
              executionMode: EXECUTION_MODES.plan,
            }),
          ),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));

      const result = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.plan,
      );

      expect(txModels.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001' },
        data: { status: PLAN_STATUS.executing },
      });
      expect(txModels.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { executionMode: EXECUTION_MODES.plan },
      });
      expect(result.executionMode).toBe(EXECUTION_MODES.plan);
    });

    it('plan（executing）→ direct → 再切回 plan 成功（executing 曾批准即放行，消除切换死锁 F2 M1）', async () => {
      // 第一步：plan 模式已启动（任务 in_progress + plan=executing）→ 切 direct（plan 保持 executing）
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'in_progress', executionMode: EXECUTION_MODES.plan }),
      );
      prisma.task.update.mockResolvedValue(
        row({ status: 'in_progress', executionMode: EXECUTION_MODES.direct }),
      );

      const r1 = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.direct,
      );

      expect(r1.executionMode).toBe(EXECUTION_MODES.direct);
      expect(prisma.plan.update).not.toHaveBeenCalled();

      // 第二步：回切 plan——plan=executing 放行（无需重新评审），任务仍 in_progress → 事务内 plan 保持 executing
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'in_progress', executionMode: EXECUTION_MODES.direct }),
      );
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        status: PLAN_STATUS.executing,
      });
      const txModels = {
        plan: { update: jest.fn().mockResolvedValue({ id: 'pl_1' }) },
        task: {
          update: jest.fn().mockResolvedValue(
            row({
              status: 'in_progress',
              executionMode: EXECUTION_MODES.plan,
            }),
          ),
        },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));

      const r2 = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.plan,
      );

      expect(txModels.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001' },
        data: { status: PLAN_STATUS.executing },
      });
      expect(r2.executionMode).toBe(EXECUTION_MODES.plan);
    });

    it('direct → plan 计划已 completed → 仍切换成功（仅切模式，不重置计划状态）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.direct }),
      );
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        status: PLAN_STATUS.completed,
      });
      prisma.task.update.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.plan }),
      );

      const result = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.plan,
      );

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { executionMode: EXECUTION_MODES.plan },
      });
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(result.executionMode).toBe(EXECUTION_MODES.plan);
    });

    it('direct → plan 任务 in_progress 且计划 reviewing → 仅切模式，不置 executing', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'in_progress', executionMode: EXECUTION_MODES.direct }),
      );
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        status: PLAN_STATUS.reviewing,
      });
      prisma.task.update.mockResolvedValue(
        row({ status: 'in_progress', executionMode: EXECUTION_MODES.plan }),
      );

      const result = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.plan,
      );

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { executionMode: EXECUTION_MODES.plan },
      });
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(result.executionMode).toBe(EXECUTION_MODES.plan);
    });

    it('目标模式与当前一致 → 幂等返回，不写库', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending', executionMode: EXECUTION_MODES.plan }),
      );

      const result = await service.updateExecutionMode(
        't_0000000001',
        EXECUTION_MODES.plan,
      );

      expect(result.executionMode).toBe(EXECUTION_MODES.plan);
      expect(prisma.task.update).not.toHaveBeenCalled();
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });

    it('非法模式 → BadRequestException（不触达查询）', async () => {
      await expect(
        service.updateExecutionMode('t_0000000001', 'agile'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.task.findUnique).not.toHaveBeenCalled();
    });

    it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      try {
        await service.updateExecutionMode('t_ghost', EXECUTION_MODES.plan);
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TASK_NOT_FOUND,
        });
      }
    });
  });

  describe('queued 状态机扩展 queued 与自动拉起（promoteNext，含锁）', () => {
    const teamId = 'tm_0000000001';
    it('accept：事务内 FOR UPDATE 锁 team 行 promoteNext，队首 queued→pending，队列删除队首重排，广播 TEAM_QUEUE_CHANGED', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            id: 't_0000000001',
            status: 'pending_review',
            version: 4,
            teamId,
          } as any),
        )
        .mockResolvedValue(
          row({
            id: 't_0000000001',
            status: 'completed',
            version: 5,
            teamId,
          } as any),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      prisma.plan.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const tx: any = {
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
        session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        artifact: { findMany: jest.fn().mockResolvedValue([]) },
        artifactVersion: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        message: {
          create: jest.fn().mockImplementation(({ data }: any) => ({
            id: data.id,
            channelId: data.channelId,
            senderType: data.senderType,
            senderId: data.senderId,
            content: data.content,
            mentions: data.mentions,
            status: data.status,
            createdAt: new Date(),
          })),
        },
        plan: { update: jest.fn().mockResolvedValue({ id: 'pl_1' }) },
        team: {
          findUnique: jest.fn().mockResolvedValue({
            id: teamId,
            version: 2,
            currentTaskId: 't_0000000001',
          }),
        },
        teamQueue: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ taskId: 't_0000000002', position: 1 }),
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'tq_0000000003', position: 2, taskId: 't_0000000003' },
            ]),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({ id: 'tq_0000000003' }),
        },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      // team updateMany + task queued→pending
      tx.team.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      tx.task.updateMany = jest.fn().mockImplementation(async (args: any) => {
        if (args.where?.status === 'queued') return { count: 1 };
        return { count: 1 };
      });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));

      await service.accept('t_0000000001', userId);

      expect(tx.team.updateMany).toHaveBeenCalledWith({
        where: { id: teamId, version: 2 },
        data: { currentTaskId: 't_0000000002', version: { increment: 1 } },
      });
      expect(tx.teamQueue.deleteMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000002' },
      });
      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { id: 't_0000000002', status: 'queued' },
        data: { status: 'pending' },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_QUEUE_CHANGED,
        expect.objectContaining({
          teamId,
          taskId: 't_0000000002',
          status: 'promoted',
        }),
        { type: 'team', id: teamId },
      );
    });

    it('archive：队列空则 currentTaskId=null，广播 idle', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            id: 't_0000000001',
            status: 'completed',
            version: 4,
            teamId,
          } as any),
        )
        .mockResolvedValue(
          row({
            id: 't_0000000001',
            status: 'archived',
            version: 5,
            teamId,
          } as any),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      prisma.plan.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const tx: any = {
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
        session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        message: {
          create: jest.fn().mockImplementation(({ data }: any) => ({
            id: data.id,
            channelId: data.channelId,
            senderType: data.senderType,
            senderId: data.senderId,
            content: data.content,
            mentions: data.mentions,
            status: data.status,
            createdAt: new Date(),
          })),
        },
        plan: { update: jest.fn().mockResolvedValue({ id: 'pl_1' }) },
        team: {
          findUnique: jest.fn().mockResolvedValue({
            id: teamId,
            version: 5,
            currentTaskId: 't_0000000001',
          }),
        },
        teamQueue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn(),
          update: jest.fn(),
        },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      tx.team.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));

      await service.archive('t_0000000001', userId);

      expect(tx.team.updateMany).toHaveBeenCalledWith({
        where: { id: teamId, version: 5 },
        data: { currentTaskId: null, version: { increment: 1 } },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_QUEUE_CHANGED,
        expect.objectContaining({ teamId, action: 'idle' }),
        { type: 'team', id: teamId },
      );
    });

    it('start：非队首 409 TEAM_NOT_QUEUE_HEAD（pending 但非 currentTaskId）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          id: 't_0000000002',
          status: 'pending',
          version: 0,
          teamId,
          mainAgentInstanceId: 'tmm_0000000001',
          mainAgentId: 'a_product',
        } as any),
      );
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({
          id: teamId,
          currentTaskId: 't_0000000001',
          version: 0,
        }),
      };

      try {
        await service.start('t_0000000002', userId);
        fail('应抛出 ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TEAM_NOT_QUEUE_HEAD,
        });
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('start：queued 非队首 409 TEAM_NOT_QUEUE_HEAD', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({
          id: 't_0000000003',
          status: 'queued',
          version: 0,
          teamId,
        } as any),
      );
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({
          id: teamId,
          currentTaskId: 't_0000000001',
          version: 0,
        }),
      };

      try {
        await service.start('t_0000000003', userId);
        fail('应抛出 ConflictException');
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: TASK_ERRORS.TEAM_NOT_QUEUE_HEAD,
        });
      }
    });

    it('start：队首 pending 可 start 成功', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            id: 't_0000000001',
            status: 'pending',
            version: 0,
            teamId,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          } as any),
        )
        .mockResolvedValue(
          row({
            id: 't_0000000001',
            status: 'in_progress',
            version: 1,
            teamId,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'tmm_0000000001',
          } as any),
        );
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({
          id: teamId,
          currentTaskId: 't_0000000001',
          version: 0,
          mainAgentMemberId: 'tmm_0000000001',
        }),
      };
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('m_0000000002');
      const tx: any = {
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
        session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        message: {
          create: jest.fn().mockImplementation(({ data }: any) => ({
            id: data.id,
            channelId: data.channelId,
            senderType: data.senderType,
            senderId: data.senderId,
            content: data.content,
            mentions: data.mentions,
            status: data.status,
            createdAt: new Date(),
          })),
        },
        plan: { update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      // mock second team lookup inside transition head check (same id)
      prisma.team.findUnique = jest.fn().mockResolvedValue({
        id: teamId,
        currentTaskId: 't_0000000001',
        version: 0,
        mainAgentMemberId: 'tmm_0000000001',
      } as any);

      const result = await service.start('t_0000000001', userId);
      expect(result.status).toBe('in_progress');
    });
  });

  describe('会话记忆开关 reuseSession + resetAfterComplete（Todo7）', () => {
    const teamId = 'tm_0000000001';
    it('reuse=true 且未勾选 → accept 不重置会话，instanceRef 保留', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            id: 't_0000000001',
            status: 'pending_review',
            version: 4,
            teamId,
            resetAfterComplete: false,
          } as any),
        )
        .mockResolvedValue(
          row({
            id: 't_0000000001',
            status: 'completed',
            version: 5,
            teamId,
          } as any),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      prisma.plan.findUnique.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('te_0000000001');
      const tx: any = {
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        taskEvent: { create: jest.fn().mockResolvedValue({}) },
        session: {
          updateMany: jest.fn().mockResolvedValue({}),
          findMany: jest.fn(),
          deleteMany: jest.fn(),
          create: jest.fn(),
        },
        message: {
          create: jest.fn().mockImplementation(({ data }: any) => ({
            id: data.id,
            channelId: data.channelId,
            senderType: data.senderType,
            content: data.content,
            mentions: data.mentions,
            status: data.status,
            createdAt: new Date(),
          })),
        },
        artifact: { findMany: jest.fn().mockResolvedValue([]) },
        artifactVersion: { updateMany: jest.fn() },
        plan: { update: jest.fn() },
        team: {
          findUnique: jest.fn().mockResolvedValue({ reuseSession: true }),
        },
        teamQueue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn(),
          update: jest.fn(),
        },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      tx.team.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      tx.task.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      (sessionLifecycle as any).resetTeamSessionsInTx.mockClear();

      await service.accept('t_0000000001', userId);

      expect(
        (sessionLifecycle as any).resetTeamSessionsInTx,
      ).not.toHaveBeenCalled();
      const messages = tx.message.create.mock.calls.map(
        (c: any) => c[0].data.content.text,
      );
      expect(messages).not.toContain('已为下一任务开新会话');
    });

    it('reuse=false 或 resetAfterComplete=true → accept 事务内批量 reset + 系统消息分隔', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            id: 't_0000000001',
            status: 'pending_review',
            version: 4,
            teamId,
            resetAfterComplete: true,
          } as any),
        )
        .mockResolvedValue(
          row({
            id: 't_0000000001',
            status: 'completed',
            version: 5,
            teamId,
          } as any),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      prisma.plan.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('m_0000000002');
      const tx: any = {
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        taskEvent: { create: jest.fn().mockResolvedValue({}) },
        session: {
          updateMany: jest.fn().mockResolvedValue({}),
          findMany: jest.fn(),
          deleteMany: jest.fn(),
          create: jest.fn(),
        },
        message: {
          create: jest.fn().mockImplementation(({ data }: any) => ({
            id: data.id,
            channelId: data.channelId,
            senderType: data.senderType,
            content: data.content,
            mentions: data.mentions,
            status: data.status,
            createdAt: new Date(),
          })),
        },
        artifact: { findMany: jest.fn().mockResolvedValue([]) },
        artifactVersion: { updateMany: jest.fn() },
        plan: { update: jest.fn() },
        team: {
          findUnique: jest.fn().mockResolvedValue({ reuseSession: false }),
        },
        teamQueue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn(),
          update: jest.fn(),
        },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      tx.team.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      tx.task.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      (sessionLifecycle as any).resetTeamSessionsInTx.mockResolvedValue(2);

      await service.accept('t_0000000001', userId);

      expect(
        (sessionLifecycle as any).resetTeamSessionsInTx,
      ).toHaveBeenCalledWith(expect.any(Object), teamId);
      const messages = tx.message.create.mock.calls.map(
        (c: any) => c[0].data.content.text,
      );
      expect(messages).toContain('已为下一任务开新会话');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.objectContaining({
          message: expect.objectContaining({ channelId: 'c_0000000001' }),
        }),
        { type: 'channel', id: 'c_0000000001' },
      );
    });

    it('archive 带 reset 同样触发批量 reset', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            id: 't_0000000001',
            status: 'completed',
            version: 4,
            teamId,
            resetAfterComplete: true,
          } as any),
        )
        .mockResolvedValue(
          row({
            id: 't_0000000001',
            status: 'archived',
            version: 5,
            teamId,
          } as any),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      prisma.plan.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001')
        .mockResolvedValueOnce('m_0000000002');
      const tx: any = {
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        taskEvent: { create: jest.fn().mockResolvedValue({}) },
        session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        message: {
          create: jest.fn().mockImplementation(({ data }: any) => ({
            id: data.id,
            channelId: data.channelId,
            senderType: data.senderType,
            content: data.content,
            mentions: data.mentions,
            status: data.status,
            createdAt: new Date(),
          })),
        },
        plan: { update: jest.fn() },
        team: {
          findUnique: jest.fn().mockResolvedValue({ reuseSession: true }),
        },
        teamQueue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn(),
          update: jest.fn(),
        },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      tx.team.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      (sessionLifecycle as any).resetTeamSessionsInTx.mockResolvedValue(1);

      await service.archive('t_0000000001', userId);

      expect(
        (sessionLifecycle as any).resetTeamSessionsInTx,
      ).toHaveBeenCalledWith(expect.any(Object), teamId);
    });

    it('reject 同样走 promoteNext：事务内闲置则 currentTaskId=null 广播 idle', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            id: 't_0000000001',
            status: 'pending_review',
            version: 1,
            teamId,
            resetAfterComplete: false,
          } as any),
        )
        .mockResolvedValue(
          row({
            id: 't_0000000001',
            status: 'in_progress',
            version: 2,
            teamId,
          } as any),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      prisma.plan.findUnique.mockResolvedValue(null);
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001');
      const tx: any = {
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        taskEvent: { create: jest.fn().mockResolvedValue({}) },
        session: { updateMany: jest.fn().mockResolvedValue({}) },
        message: {
          create: jest.fn().mockImplementation(({ data }: any) => ({
            id: data.id,
            channelId: data.channelId,
            senderType: data.senderType,
            content: data.content,
            mentions: data.mentions,
            status: data.status,
            createdAt: new Date(),
          })),
        },
        plan: { update: jest.fn() },
        team: {
          findUnique: jest.fn().mockResolvedValue({
            id: teamId,
            version: 3,
            currentTaskId: 't_0000000001',
          }),
        },
        teamQueue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      tx.team.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      await service.reject('t_0000000001', userId, { reason: 'nope' });
      expect(tx.team.updateMany).toHaveBeenCalledWith({
        where: { id: teamId, version: 3 },
        data: { currentTaskId: null, version: { increment: 1 } },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_QUEUE_CHANGED,
        expect.objectContaining({ teamId, action: 'idle' }),
        { type: 'team', id: teamId },
      );
    });
  });

  describe('补充覆盖：并发 version 冲突重试边界与 onModuleInit/空队首', () => {
    it('并发三试均 VERSION_CONFLICT → 抛最后一次错误', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      } as any);
      let attempt = 0;
      prisma.$transaction.mockImplementation(async (fn: any) => {
        attempt++;
        const tx: any = {
          team: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'tm_0000000001',
              version: 0,
              currentTaskId: null,
              reuseSession: true,
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          teamMember: {
            findMany: jest.fn().mockResolvedValue([
              {
                id: 'tmm_1',
                teamId: 'tm_0000000001',
                agentId: 'a_product',
                alias: '产品经理-1',
                seq: 1,
                workDir: '/data/a',
                agent: { id: 'a_product', name: '产品经理', role: 'product' },
              },
            ]),
          },
          teamQueue: {
            create: jest.fn(),
            aggregate: jest.fn().mockResolvedValue({ _max: { position: 0 } }),
          },
          task: { create: jest.fn().mockResolvedValue({ id: 't_0000000001' }) },
          chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
          session: { create: jest.fn().mockResolvedValue({ id: 's_1' }) },
          taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
          $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
        };
        return fn(tx);
      });
      idGen.nextId.mockResolvedValue('t_0000000001');
      prisma.task.findUnique.mockResolvedValue(
        row({
          id: 't_0000000001',
          teamId: 'tm_0000000001',
          status: 'pending',
        }) as any,
      );
      await expect(
        service.create(userId, { title: 'x', teamId: 'tm_0000000001' } as any),
      ).rejects.toThrow(ConflictException);
      expect(attempt).toBe(3);
    });

    it('onModuleInit 按最大 id 对齐 6 前缀 seed（任务实例快照表已删除，不再 seed ta_）', async () => {
      (prisma.task as any).findFirst = jest
        .fn()
        .mockResolvedValue({ id: 't_0000000009' });
      (prisma.chatChannel as any).findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'c_0000000003' });
      (prisma.taskEvent as any).findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'te_0000000002' });
      (prisma.message as any).findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'm_0000000004' });
      (prisma.session as any).findFirst = jest
        .fn()
        .mockResolvedValue({ id: 's_0000000006' });
      (prisma as any).teamQueue = {
        findFirst: jest.fn().mockResolvedValue({ id: 'tq_0000000001' }),
      };
      await service.onModuleInit();
      expect(idGen.seed).toHaveBeenCalledWith('t', 9);
      expect(idGen.seed).toHaveBeenCalledWith('c', 3);
      expect(idGen.seed).not.toHaveBeenCalledWith('ta', expect.anything());
    });

    it('promoteNext 独立事务入口：队首晋升与 idle 双分支', async () => {
      const teamId = 'tm_0000000001';
      const tx1: any = {
        team: {
          findUnique: jest.fn().mockResolvedValue({
            id: teamId,
            version: 0,
            currentTaskId: 't_old',
          }),
        },
        teamQueue: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ taskId: 't_0000000002', position: 1 }),
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn(),
        },
        task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      tx1.team.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      tx1.task.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      tx1.teamQueue.update = jest.fn().mockResolvedValue({});
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx1));
      await service.promoteNext(teamId);
      expect(tx1.teamQueue.deleteMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000002' },
      });
      const tx2: any = {
        team: {
          findUnique: jest.fn().mockResolvedValue({
            id: teamId,
            version: 1,
            currentTaskId: 't_0000000002',
          }),
        },
        teamQueue: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn(),
          update: jest.fn(),
        },
        task: { updateMany: jest.fn() },
        $queryRawUnsafe: jest.fn().mockRejectedValue(new Error('fallback')),
      };
      tx2.team.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx2));
      await service.promoteNext(teamId);
      expect(tx2.team.updateMany).toHaveBeenCalledWith({
        where: { id: teamId, version: 1 },
        data: { currentTaskId: null, version: { increment: 1 } },
      });
    });

    it('create：MAX(position) NaN 不 finite → 回落 0，仍 queued position=1', async () => {
      prisma.teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      } as any);
      const tx: any = {
        team: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'tm_0000000001',
            version: 0,
            currentTaskId: 't_busy',
            reuseSession: true,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        teamMember: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'tmm_1',
              teamId: 'tm_0000000001',
              agentId: 'a_product',
              alias: '产品经理-1',
              seq: 1,
              workDir: '/data/a',
              agent: { id: 'a_product', name: '产品经理', role: 'product' },
            },
          ]),
        },
        teamQueue: {
          create: jest.fn().mockResolvedValue({ id: 'tq_1' }),
          aggregate: jest.fn().mockResolvedValue({ _max: { position: NaN } }),
        },
        task: {
          create: jest
            .fn()
            .mockResolvedValue({ id: 't_0000000001', status: 'queued' }),
        },
        chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
        session: { create: jest.fn().mockResolvedValue({ id: 's_1' }) },
        taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
        $queryRawUnsafe: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('FROM teams'))
            return [
              {
                id: 'tm_0000000001',
                version: 0,
                currentTaskId: 't_busy',
                reuseSession: 1,
              },
            ];
          if (sql.includes('FROM team_queues')) return [{ maxPos: 'nan' }];
          return [];
        }),
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      idGen.nextId.mockResolvedValue('t_0000000001');
      prisma.task.findUnique.mockResolvedValue(
        row({
          id: 't_0000000001',
          teamId: 'tm_0000000001',
          status: 'queued',
        }) as any,
      );
      const result = await service.create(userId, {
        title: 'queued-nan',
        teamId: 'tm_0000000001',
      } as any);
      expect(result.status).toBe('queued');
      expect(tx.teamQueue.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ position: 1 }),
      });
    });
  });
});
