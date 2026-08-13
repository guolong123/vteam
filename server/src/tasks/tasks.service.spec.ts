import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { TASK_ERRORS } from '../common/constants/task.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { TasksService } from './tasks.service';

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
    taskAgent: {
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      aggregate: jest.Mock;
    };
    taskEvent: { create: jest.Mock };
    message: { create: jest.Mock; findFirst: jest.Mock };
    agent: { findMany: jest.Mock; findUnique: jest.Mock };
    session: { create: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let sessionLifecycle: {
    getInstancesByTask: jest.Mock;
    getInstanceBySession: jest.Mock;
  };

  const pid = 'p_seed_1';
  const userId = 'u_admin';

  /** 团队成员实例行（task_agents + 模板 agent 关联，instances 派生源）。 */
  const taRow = (
    agentId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const base: Record<string, any> = {
      a_product: {
        id: 'ta_0000000001',
        agentId: 'a_product',
        alias: '产品经理-1',
        seq: 1,
        removedAt: null,
        agent: { id: 'a_product', name: '产品经理', role: 'product' },
      },
      a_developer: {
        id: 'ta_0000000002',
        agentId: 'a_developer',
        alias: '开发者-1',
        seq: 1,
        removedAt: null,
        agent: { id: 'a_developer', name: '开发者', role: 'developer' },
      },
      a_tester: {
        id: 'ta_0000000003',
        agentId: 'a_tester',
        alias: '测试-1',
        seq: 1,
        removedAt: null,
        agent: { id: 'a_tester', name: '测试', role: 'tester' },
      },
    };
    return { ...(base[agentId] ?? { id: `ta_${agentId}`, agentId, alias: null, seq: 1, removedAt: null, agent: { id: agentId, name: agentId, role: null } }), ...overrides };
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 't_0000000001',
    projectId: pid,
    title: '任务标题',
    description: null,
    priority: 'medium',
    status: 'pending',
    mainAgentId: null,
    mainAgentInstanceId: null,
    backgroundDocs: null,
    createdBy: userId,
    createdAt: new Date('2026-08-07T00:00:00Z'),
    startedAt: null,
    pendingReviewAt: null,
    completedAt: null,
    archivedAt: null,
    taskAgents: [taRow('a_product'), taRow('a_developer')],
    ...overrides,
  });

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
      taskAgent: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        aggregate: jest.fn(),
      },
      taskEvent: { create: jest.fn() },
      message: { create: jest.fn(), findFirst: jest.fn() },
      agent: { findMany: jest.fn(), findUnique: jest.fn() },
      session: { create: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn(),
    };
    idGen = { nextId: jest.fn(), seed: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    sessionLifecycle = {
      getInstancesByTask: jest.fn().mockResolvedValue([]),
      getInstanceBySession: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
        { provide: SessionLifecycleService, useValue: sessionLifecycle },
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
      taskAgent: {
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
      artifact: { findMany: jest.fn().mockResolvedValue([]) },
      artifactVersion: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
    };
    prisma.$transaction.mockImplementation(async (fn: any) => fn(txModels));
    return txModels;
  };

  /** 状态机系统消息落库断言：任务群聊频道（task_group）写入 senderType=system 的精确文案。 */
  const assertSysMessageCreated = (
    tx: ReturnType<typeof mockTransitionTx>,
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

  describe('create（实例化团队 + 主实例，T2）', () => {
    it('同事务写入 任务+群聊频道+团队实例+状态事件，主实例落库，事务后广播 task.status.changed', async () => {
      idGen.nextId
        .mockResolvedValueOnce('t_0000000001')
        .mockResolvedValueOnce('c_0000000001')
        .mockResolvedValueOnce('ta_0000000001')
        .mockResolvedValueOnce('s_0000000001')
        .mockResolvedValueOnce('ta_0000000002')
        .mockResolvedValueOnce('s_0000000002')
        .mockResolvedValueOnce('te_0000000001');
      const txModels = mockCreateTx(
        row({
          title: '新任务',
          priority: 'high',
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'ta_0000000001',
          backgroundDocs: [{ name: '需求文档.pdf' }],
        }),
      );
      prisma.task.findUnique.mockResolvedValue(
        row({
          title: '新任务',
          priority: 'high',
          mainAgentId: 'a_product',
          mainAgentInstanceId: 'ta_0000000001',
          backgroundDocs: [{ name: '需求文档.pdf' }],
        }),
      );

      const dto = {
        title: ' 新任务 ',
        description: '描述',
        priority: 'high',
        agents: [{ agentId: 'a_product' }, { agentId: 'a_developer' }],
        mainAgentId: 'a_product',
        backgroundDocs: [{ name: '需求文档.pdf' }],
      };
      const result = await service.create(pid, userId, dto as any);

      // 任务创建字段：trim 标题、priority、status=pending、createdBy、version=0、backgroundDocs 存 Json
      expect(result).toMatchObject({
        id: 't_0000000001',
        projectId: pid,
        title: '新任务',
        priority: 'high',
        status: 'pending',
        mainAgentId: 'a_product',
        mainAgentInstanceId: 'ta_0000000001',
        teamAgentIds: ['a_product', 'a_developer'],
        createdBy: userId,
      });
      // instances：alias 默认 `<角色中文名>-<seq>`、name/role 从 agent 关联取、main 标记（按 (agentId,seq) 排序）
      expect(result.instances).toEqual([
        { id: 'ta_0000000002', agentId: 'a_developer', alias: '开发者-1', seq: 1, name: '开发者', role: 'developer', main: false },
        { id: 'ta_0000000001', agentId: 'a_product', alias: '产品经理-1', seq: 1, name: '产品经理', role: 'product', main: true },
      ]);
      expect(result.backgroundDocs).toEqual([{ name: '需求文档.pdf' }]);

      // 事务内 task.create 字段对齐契约（主实例先空置，实例创建后解析再 update）
      expect(txModels.task.create).toHaveBeenCalledWith({
        data: {
          id: 't_0000000001',
          projectId: pid,
          title: '新任务',
          description: '描述',
          priority: 'high',
          status: 'pending',
          mainAgentId: null,
          mainAgentInstanceId: null,
          backgroundDocs: [{ name: '需求文档.pdf' }],
          createdBy: userId,
          version: 0,
        },
      });
      // 主实例解析：mainAgentInstanceId 缺省时按 mainAgentId 映射到该 agent 第一个实例
      expect(txModels.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' },
      });

      // 广播：点号事件名 task.status.changed + global scope（09 篇 §4.1 全局广播）
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        {
          taskId: 't_0000000001',
          from: null,
          to: 'pending',
          actorType: 'user',
          actorId: userId,
        },
        { type: 'global' },
      );
    });

    it('事务内同时创建群聊频道（task_group）与 task_agents 实例、sessions、task_events', async () => {
      idGen.nextId
        .mockResolvedValueOnce('t_0000000001')
        .mockResolvedValueOnce('c_0000000001')
        .mockResolvedValueOnce('ta_0000000001')
        .mockResolvedValueOnce('s_0000000001')
        .mockResolvedValueOnce('ta_0000000002')
        .mockResolvedValueOnce('s_0000000002')
        .mockResolvedValueOnce('te_0000000001');
      const txModels = mockCreateTx(row());
      prisma.task.findUnique.mockResolvedValue(row());

      await service.create(pid, userId, {
        title: 'x',
        agents: [{ agentId: 'a_product' }, { agentId: 'a_developer' }],
      } as any);

      // 群聊频道：type=task_group、agent_id=null（uk_channels_task_agent 不冲突）
      expect(txModels.chatChannel.create).toHaveBeenCalledWith({
        data: {
          id: 'c_0000000001',
          type: 'task_group',
          taskId: 't_0000000001',
          agentId: null,
        },
      });
      // 团队实例：agents 全部 joined，alias 默认 `<角色中文名>-<seq>`、seq 从 1 起
      expect(txModels.taskAgent.create).toHaveBeenCalledTimes(2);
      expect(txModels.taskAgent.create).toHaveBeenNthCalledWith(1, {
        data: {
          id: 'ta_0000000001',
          taskId: 't_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
      });
      expect(txModels.taskAgent.create).toHaveBeenNthCalledWith(2, {
        data: {
          id: 'ta_0000000002',
          taskId: 't_0000000001',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      });
      // 会话：每实例一行（uk_sessions_task_agent），status=created，绑实例
      expect(txModels.session.create).toHaveBeenCalledTimes(2);
      expect(txModels.session.create).toHaveBeenNthCalledWith(1, {
        data: {
          id: 's_0000000001',
          taskId: 't_0000000001',
          taskAgentId: 'ta_0000000001',
          agentId: 'a_product',
          status: 'created',
        },
      });
      expect(txModels.session.create).toHaveBeenNthCalledWith(2, {
        data: {
          id: 's_0000000002',
          taskId: 't_0000000001',
          taskAgentId: 'ta_0000000002',
          agentId: 'a_developer',
          status: 'created',
        },
      });
      // 状态事件：from=null → to=pending，actor=user
      expect(txModels.taskEvent.create).toHaveBeenCalledWith({
        data: {
          id: 'te_0000000001',
          taskId: 't_0000000001',
          eventType: 'status_change',
          fromStatus: null,
          toStatus: 'pending',
          actorType: 'user',
          actorId: userId,
        },
      });
    });

    it('双开发者实例：同一 agentId 两个实例 → seq 1/2、alias 开发者-1/开发者-2、各自会话、主实例=第二个', async () => {
      idGen.nextId
        .mockResolvedValueOnce('t_0000000001')
        .mockResolvedValueOnce('c_0000000001')
        .mockResolvedValueOnce('ta_0000000001')
        .mockResolvedValueOnce('s_0000000001')
        .mockResolvedValueOnce('ta_0000000002')
        .mockResolvedValueOnce('s_0000000002')
        .mockResolvedValueOnce('te_0000000001');
      const txModels = mockCreateTx(row());
      // 第二个开发者实例 seq = 该 taskId+agentId 已用最大 seq(1) + 1
      txModels.taskAgent.aggregate
        .mockResolvedValueOnce({ _max: { seq: 0 } })
        .mockResolvedValueOnce({ _max: { seq: 1 } });
      prisma.task.findUnique.mockResolvedValue(row());

      await service.create(pid, userId, {
        title: 'x',
        agents: [{ agentId: 'a_developer' }, { agentId: 'a_developer' }],
        mainAgentInstanceId: 'ta_0000000002',
      } as any);

      expect(txModels.taskAgent.create).toHaveBeenCalledTimes(2);
      expect(txModels.taskAgent.create).toHaveBeenNthCalledWith(1, {
        data: {
          id: 'ta_0000000001',
          taskId: 't_0000000001',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      });
      expect(txModels.taskAgent.create).toHaveBeenNthCalledWith(2, {
        data: {
          id: 'ta_0000000002',
          taskId: 't_0000000001',
          agentId: 'a_developer',
          alias: '开发者-2',
          seq: 2,
        },
      });
      // 主实例 = 第二个开发者实例（mainAgentInstanceId 入参优先）
      expect(txModels.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { mainAgentId: 'a_developer', mainAgentInstanceId: 'ta_0000000002' },
      });
      // 两个实例各自独立会话
      expect(txModels.session.create).toHaveBeenCalledTimes(2);
    });

    it('mainAgentInstanceId 不属于本次创建实例集合 → 400（事务回滚，task.update 不执行）', async () => {
      idGen.nextId
        .mockResolvedValueOnce('t_0000000001')
        .mockResolvedValueOnce('c_0000000001')
        .mockResolvedValueOnce('ta_0000000001')
        .mockResolvedValueOnce('s_0000000001')
        .mockResolvedValueOnce('te_0000000001');
      const txModels = mockCreateTx(row());

      await expect(
        service.create(pid, userId, {
          title: 'x',
          agents: [{ agentId: 'a_product' }],
          mainAgentInstanceId: 'ta_ghost',
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(txModels.task.update).not.toHaveBeenCalled();
    });

    it('mainAgentId 不在 agents 的 agentId 内 → 400 MAIN_AGENT_NOT_IN_TEAM', async () => {
      await expect(
        service.create(pid, userId, {
          title: 'x',
          agents: [{ agentId: 'a_product' }],
          mainAgentId: 'a_tester',
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('agents 为空数组 → 400 TASK_EMPTY_TEAM', async () => {
      await expect(
        service.create(pid, userId, { title: 'x', agents: [] } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('标题为空 → BadRequestException', async () => {
      await expect(
        service.create(pid, userId, {
          title: ' ',
          agents: [{ agentId: 'a_1' }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('agents 中某 agent 不存在 → 404 AGENT_NOT_FOUND（事务回滚，不写主实例）', async () => {
      idGen.nextId
        .mockResolvedValueOnce('t_0000000001')
        .mockResolvedValueOnce('c_0000000001')
        .mockResolvedValueOnce('ta_0000000001')
        .mockResolvedValueOnce('s_0000000001');
      const txModels = mockCreateTx(row());
      txModels.agent.findUnique.mockResolvedValueOnce({
        id: 'a_product',
        ...mockAgentMeta('a_product'),
      });
      txModels.agent.findUnique.mockResolvedValue(null);

      await expect(
        service.create(pid, userId, {
          title: 'x',
          agents: [{ agentId: 'a_product' }, { agentId: 'ghost' }],
        } as any),
      ).rejects.toThrow(NotFoundException);
      expect(txModels.taskAgent.create).toHaveBeenCalledTimes(1);
      expect(txModels.task.update).not.toHaveBeenCalled();
    });
  });

  describe('findAll（看板列表）', () => {
    it('返回 {items, total, page, pageSize}，items 含 teamAgentIds 与 instances，created_at desc', async () => {
      prisma.$transaction.mockResolvedValue([
        1,
        [row(), row({ id: 't_0000000002', status: 'in_progress', taskAgents: [taRow('a_tester')] })],
      ]);

      const result = await service.findAll(pid, { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({ id: 't_0000000001', status: 'pending' });
      expect(result.items[0].teamAgentIds).toEqual(['a_product', 'a_developer']);
      expect(result.items[0].instances).toEqual([
        { id: 'ta_0000000002', agentId: 'a_developer', alias: '开发者-1', seq: 1, name: '开发者', role: 'developer', main: false },
        { id: 'ta_0000000001', agentId: 'a_product', alias: '产品经理-1', seq: 1, name: '产品经理', role: 'product', main: false },
      ]);
      expect(result.items[1].teamAgentIds).toEqual(['a_tester']);
      // 查询：projectId + 排序 + taskAgents 带模板 agent 关联
      expect(prisma.task.findMany).toHaveBeenCalledWith({
        where: { projectId: pid },
        include: { taskAgents: { include: { agent: { select: { id: true, name: true, role: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
    });

    it('status 筛选透传（TASK_STATUS 五态）', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll(pid, { status: 'pending' } as any);

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: pid, status: 'pending' },
        }),
      );
    });

    it('pageSize 上限 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll(pid, { page: 1, pageSize: 999 } as any);

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });
  });

  describe('findOne（详情）', () => {
    it('返回详情（含 teamAgentIds、instances、backgroundDocs）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ mainAgentInstanceId: 'ta_0000000001', backgroundDocs: [{ name: '需求文档.pdf' }] }),
      );

      const result = await service.findOne('t_0000000001');

      expect(result).toMatchObject({
        id: 't_0000000001',
        title: '任务标题',
        status: 'pending',
        mainAgentInstanceId: 'ta_0000000001',
        teamAgentIds: ['a_product', 'a_developer'],
      });
      // main 标记 = id === mainAgentInstanceId
      expect(result.instances.find((i: any) => i.id === 'ta_0000000001').main).toBe(true);
      expect(result.backgroundDocs).toEqual([{ name: '需求文档.pdf' }]);
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
      prisma.task.update.mockResolvedValue(
        row({ mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001', title: '改名' }),
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
          mainAgentInstanceId: 'ta_0000000001',
        },
        include: { taskAgents: { include: { agent: { select: { id: true, name: true, role: true } } } } },
      });
      expect(result).toMatchObject({
        title: '改名',
        mainAgentId: 'a_product',
        mainAgentInstanceId: 'ta_0000000001',
      });
    });

    it('mainAgentInstanceId 为团队内实例时更新成功（同步 mainAgentId）', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.task.update.mockResolvedValue(
        row({ mainAgentId: 'a_developer', mainAgentInstanceId: 'ta_0000000002' }),
      );

      const result = await service.update('t_0000000001', {
        mainAgentInstanceId: 'ta_0000000002',
      } as any);

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { mainAgentInstanceId: 'ta_0000000002', mainAgentId: 'a_developer' },
        include: expect.any(Object),
      });
      expect(result).toMatchObject({ mainAgentInstanceId: 'ta_0000000002' });
    });

    it('mainAgentInstanceId 非团队内实例 → 400 MAIN_AGENT_NOT_IN_TEAM', async () => {
      prisma.task.findUnique.mockResolvedValue(row());

      await expect(
        service.update('t_0000000001', { mainAgentInstanceId: 'ta_ghost' } as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.update('t_0000000001', { mainAgentInstanceId: 'ta_ghost' } as any);
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
      prisma.task.update.mockResolvedValue(row({ mainAgentId: null, mainAgentInstanceId: null }));

      await service.update('t_0000000001', { mainAgentInstanceId: null } as any);

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { mainAgentInstanceId: null, mainAgentId: null },
        include: expect.any(Object),
      });
    });

    it('mainAgentId 非团队内已选 Agent → 400 MAIN_AGENT_NOT_IN_TEAM', async () => {
      prisma.task.findUnique.mockResolvedValue(row());

      await expect(
        service.update('t_0000000001', { mainAgentId: 'a_tester' } as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.update('t_0000000001', { mainAgentId: 'a_tester' } as any);
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
  });

  describe('五态状态迁移（迁移表驱动 + CAS 乐观锁）', () => {
    it('start：pending → in_progress，CAS(where status+version) + version+1 + status_change 事件 + 广播 + 系统消息（群聊+私信主实例）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ status: 'pending', version: 3, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            version: 4,
            mainAgentId: 'a_product',
            mainAgentInstanceId: 'ta_0000000001',
            startedAt: new Date(),
          }),
        );
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_0000000001' }) // task_group 频道
        .mockResolvedValueOnce({ id: 'c_0000000002' }); // 主实例 private 频道
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
      // 私信定位按实例：private 频道查找 where 含 taskAgentId=主实例
      expect(prisma.chatChannel.findFirst).toHaveBeenNthCalledWith(2, {
        where: {
          taskId: 't_0000000001',
          taskAgentId: 'ta_0000000001',
          type: 'private',
        },
        select: { id: true },
      });
      // 群聊系统消息（10 篇 §8.1：「任务已开始，主 Agent：产品经理-1」，主实例默认别名）
      assertSysMessageCreated(txModels, 'c_0000000001', '任务已开始，主 Agent：产品经理-1', 1);
      // 私信主实例（13 篇 §4.2：含任务目标、团队分工[实例别名]、背景文档）
      assertSysMessageCreated(
        txModels,
        'c_0000000002',
        '任务已启动，请作为主 Agent 牵头推进。任务目标：任务标题。团队分工：开发者-1、产品经理-1',
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
        { message: expect.objectContaining({ channelId: 'c_0000000001', senderType: 'system' }) },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ channelId: 'c_0000000002', senderType: 'system' }) },
        { type: 'channel', id: 'c_0000000002' },
      );
      expect(result.status).toBe('in_progress');
    });

    it('start：非前置状态（pending_review）→ 409 TASK_INVALID_TRANSITION', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending_review', mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
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
        row({ status: 'in_progress', mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
      );

      const result = await service.start('t_0000000001', userId);

      expect(result.status).toBe('in_progress');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('start：created 会话全部置 active（T4；where 限定 status=created，frozen 不误动）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ status: 'pending', version: 0, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
        )
        .mockResolvedValue(
          row({ status: 'in_progress', version: 1, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001', startedAt: new Date() }),
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
        row({ status: 'pending', mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001', taskAgents: [] }),
      );

      await assertBadRequestCode(
        () => service.start('t_0000000001', userId),
        TASK_ERRORS.TASK_EMPTY_TEAM,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('start：主实例未确定 → 400 MAIN_AGENT_NOT_SET', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending', mainAgentId: null, mainAgentInstanceId: null }),
      );

      await assertBadRequestCode(
        () => service.start('t_0000000001', userId),
        TASK_ERRORS.MAIN_AGENT_NOT_SET,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('mark-pending-review：in_progress → pending_review，写 pendingReviewAt + 事件 + 广播 + 系统消息「任务已提交待验收」', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ status: 'in_progress', version: 5 }))
        .mockResolvedValue(
          row({ status: 'pending_review', version: 6, pendingReviewAt: new Date() }),
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
        { message: expect.objectContaining({ channelId: 'c_0000000001', senderType: 'system' }) },
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
      prisma.task.findUnique.mockResolvedValue(row({ status: 'pending_review' }));

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
      assertSysMessageCreated(txModels, 'c_0000000001', '任务已验收完成，产出物基线已锁定');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        expect.objectContaining({ from: 'pending_review', to: 'completed' }),
        { type: 'global' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ channelId: 'c_0000000001', senderType: 'system' }) },
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
        { message: expect.objectContaining({ channelId: 'c_0000000001', senderType: 'system' }) },
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

    it('archive：completed → archived，写 archivedAt + sessions 全部置 archived + archive 事件 + 广播 + 系统消息「任务已归档，历史可回看」', async () => {
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
      // 系统消息落库（10 篇 §8.1，明确内容保留）
      assertSysMessageCreated(txModels, 'c_0000000001', '任务已归档，历史可回看');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TASK_STATUS_CHANGED,
        expect.objectContaining({ from: 'completed', to: 'archived' }),
        { type: 'global' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ channelId: 'c_0000000001', senderType: 'system' }) },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(result.status).toBe('archived');
    });

    it('archive：非前置状态（pending_review）→ 409 TASK_INVALID_TRANSITION', async () => {
      prisma.task.findUnique.mockResolvedValue(row({ status: 'pending_review' }));

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
          row({ status: 'pending', version: 0, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
        )
        .mockResolvedValue(
          row({ status: 'in_progress', version: 1, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
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
          row({ status: 'pending', version: 0, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
        )
        .mockResolvedValueOnce(
          row({ status: 'in_progress', version: 1, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
        )
        .mockResolvedValueOnce(
          row({ status: 'pending', version: 0, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
        )
        .mockResolvedValue(
          row({ status: 'in_progress', version: 1, mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
        );
      // 每次 start 均先查 group 频道再查 private 频道（两个并发 start 共 4 次）
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_1' })
        .mockResolvedValueOnce({ id: 'c_2' })
        .mockResolvedValueOnce({ id: 'c_1' })
        .mockResolvedValue({ id: 'c_2' });
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
        artifactVersion: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
      assertSysMessageCreated(txModels, 'c_1', '任务已开始，主 Agent：产品经理-1', 1);
      assertSysMessageCreated(
        txModels,
        'c_2',
        '任务已启动，请作为主 Agent 牵头推进。任务目标：任务标题。团队分工：开发者-1、产品经理-1',
        2,
      );
      // task.status.changed 1 次 + chat.message.new 2 次
      const chatNewCalls = realtime.broadcast.mock.calls.filter(
        (call) => call[0] === EVENT_TYPES.CHAT_MESSAGE_NEW,
      );
      expect(chatNewCalls).toHaveLength(2);
    });
  });

  describe('updateTeam（团队调整，14 篇 §5.3 FR-02）', () => {
    /** team 调整事务的 tx mock：实例创建（seq/别名）+ 会话 + 主实例清空 + 系统消息全部可写，返回 tx 供断言。 */
    const mockTeamTx = () => {
      const txModels = {
        taskAgent: {
          create: jest
            .fn()
            .mockImplementation(({ data }: any) =>
              Promise.resolve({ id: data.id, alias: data.alias, seq: data.seq }),
            ),
          update: jest.fn().mockResolvedValue({ id: 'ta_1' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          aggregate: jest.fn().mockResolvedValue({ _max: { seq: 0 } }),
        },
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

    it('add 实例：写 task_agents + 会话绑实例 + 系统消息「{别名} 已加入团队」+ 广播 team.changed(add 含 instanceId/alias)', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ taskAgents: [taRow('a_product')] }))
        .mockResolvedValue(
          row({ taskAgents: [taRow('a_product'), taRow('a_developer')] }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('ta_0000000002')
        .mockResolvedValueOnce('s_0000000002')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { addInstances: [{ agentId: 'a_developer' }] },
        userId,
      );

      expect(txModels.taskAgent.create).toHaveBeenCalledWith({
        data: {
          id: 'ta_0000000002',
          taskId: 't_0000000001',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      });
      expect(txModels.session.create).toHaveBeenCalledWith({
        data: {
          id: 's_0000000002',
          taskId: 't_0000000001',
          taskAgentId: 'ta_0000000002',
          agentId: 'a_developer',
          status: 'created',
        },
      });
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
          instanceId: 'ta_0000000002',
          agentId: 'a_developer',
          alias: '开发者-1',
        },
        { type: 'task', id: 't_0000000001' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ channelId: 'c_0000000001', senderType: 'system' }) },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(result.teamAgentIds).toEqual(['a_product', 'a_developer']);
    });

    it('add 同 agent 第二个实例：seq = 已用最大 seq + 1（并发防重号）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ taskAgents: [taRow('a_developer')] }))
        .mockResolvedValue(
          row({
            taskAgents: [taRow('a_developer'), taRow('a_developer', { id: 'ta_0000000003', alias: '开发者-2', seq: 2 })],
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId
        .mockResolvedValueOnce('ta_0000000003')
        .mockResolvedValueOnce('s_0000000003')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();
      txModels.taskAgent.aggregate.mockResolvedValue({ _max: { seq: 1 } });

      await service.updateTeam(
        't_0000000001',
        { addInstances: [{ agentId: 'a_developer' }] },
        userId,
      );

      expect(txModels.taskAgent.aggregate).toHaveBeenCalledWith({
        _max: { seq: true },
        where: { taskId: 't_0000000001', agentId: 'a_developer' },
      });
      expect(txModels.taskAgent.create).toHaveBeenCalledWith({
        data: {
          id: 'ta_0000000003',
          taskId: 't_0000000001',
          agentId: 'a_developer',
          alias: '开发者-2',
          seq: 2,
        },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        {
          taskId: 't_0000000001',
          action: 'add',
          instanceId: 'ta_0000000003',
          agentId: 'a_developer',
          alias: '开发者-2',
        },
        { type: 'task', id: 't_0000000001' },
      );
    });

    it('add 实例：任务 in_progress 时新会话置 active（T4 衔接）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ status: 'in_progress', taskAgents: [taRow('a_product')] }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            taskAgents: [taRow('a_product'), taRow('a_developer')],
          }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId
        .mockResolvedValueOnce('ta_0000000002')
        .mockResolvedValueOnce('s_0000000002')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      await service.updateTeam(
        't_0000000001',
        { addInstances: [{ agentId: 'a_developer' }] },
        userId,
      );

      expect(txModels.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: 't_0000000001',
          taskAgentId: 'ta_0000000002',
          agentId: 'a_developer',
          status: 'active',
        }),
      });
    });

    it('remove：按实例 id 写 removed_at + 会话冻结 frozen + 系统消息「{别名} 已移出团队，其会话已冻结」+ 广播 remove', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ taskAgents: [taRow('a_product'), taRow('a_tester', { id: 'ta_0000000003' })] }),
        )
        .mockResolvedValue(row({ taskAgents: [taRow('a_product')] }));
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { removeInstanceIds: ['ta_0000000003'] },
        userId,
      );

      expect(txModels.taskAgent.updateMany).toHaveBeenCalledWith({
        where: { id: 'ta_0000000003', removedAt: null },
        data: { removedAt: expect.any(Date) },
      });
      expect(txModels.session.updateMany).toHaveBeenCalledWith({
        where: { taskAgentId: 'ta_0000000003' },
        data: { status: 'frozen' },
      });
      expect(txModels.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content: { text: '测试-1 已移出团队，其会话已冻结', parts: [] },
        }),
      });
      expect(txModels.taskAgent.create).not.toHaveBeenCalled();
      expect(txModels.task.update).not.toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        {
          taskId: 't_0000000001',
          action: 'remove',
          instanceId: 'ta_0000000003',
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

    it('remove 主实例 → mainAgentInstanceId 清空（mainAgentId 同步 null）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ mainAgentId: 'a_product', mainAgentInstanceId: 'ta_0000000001' }),
        )
        .mockResolvedValue(row({ mainAgentId: null, mainAgentInstanceId: null }));
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { removeInstanceIds: ['ta_0000000001'] },
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
      prisma.task.findUnique.mockResolvedValue(row());

      const result = await service.updateTeam(
        't_0000000001',
        { removeInstanceIds: ['ta_ghost'] },
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
      idGen.nextId
        .mockResolvedValueOnce('ta_0000000003')
        .mockResolvedValueOnce('s_0000000003');
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
      expect(txModels.taskAgent.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.updateTeam('t_missing', { addInstances: [{ agentId: 'a_developer' }] }, userId),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('T12 会话实例查询（委托 SessionLifecycleService）', () => {
    it('getInstancesByTask 委托返回任务全部实例', async () => {
      const rows = [{ id: 'ti_1', instanceId: 'ses_1' }];
      sessionLifecycle.getInstancesByTask.mockResolvedValue(rows);

      const result = await service.getInstancesByTask('t_0000000001');

      expect(sessionLifecycle.getInstancesByTask).toHaveBeenCalledWith(
        't_0000000001',
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
});
