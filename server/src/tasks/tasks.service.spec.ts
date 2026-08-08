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
    };
    taskEvent: { create: jest.Mock };
    message: { create: jest.Mock; findFirst: jest.Mock };
    agent: { findMany: jest.Mock; findUnique: jest.Mock };
    session: { updateMany: jest.Mock };
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

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 't_0000000001',
    projectId: pid,
    title: '任务标题',
    description: null,
    priority: 'medium',
    status: 'pending',
    mainAgentId: null,
    backgroundDocs: null,
    createdBy: userId,
    createdAt: new Date('2026-08-07T00:00:00Z'),
    startedAt: null,
    pendingReviewAt: null,
    completedAt: null,
    archivedAt: null,
    taskAgents: [
      { agentId: 'a_product', removedAt: null },
      { agentId: 'a_developer', removedAt: null },
    ],
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
      },
      taskEvent: { create: jest.fn() },
      message: { create: jest.fn(), findFirst: jest.fn() },
      agent: { findMany: jest.fn(), findUnique: jest.fn() },
      session: { updateMany: jest.fn() },
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

  /** 创建事务的 tx mock：三件套 + 会话 + 事件全部落库，返回 tx 供断言。 */
  const mockCreateTx = (createdRow: unknown) => {
    const txModels = {
      task: { create: jest.fn().mockResolvedValue(createdRow) },
      chatChannel: { create: jest.fn().mockResolvedValue({ id: 'c_1' }) },
      taskAgent: { create: jest.fn().mockResolvedValue({ id: 'ta_1' }) },
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

  describe('create（三件套同事务）', () => {
    it('同事务写入 任务+群聊频道+团队+状态事件，事务后广播 task.status.changed', async () => {
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
          backgroundDocs: [{ name: '需求文档.pdf' }],
        }),
      );

      const dto = {
        title: ' 新任务 ',
        description: '描述',
        priority: 'high',
        agentIds: ['a_product', 'a_developer'],
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
        teamAgentIds: ['a_product', 'a_developer'],
        createdBy: userId,
      });
      expect(result.backgroundDocs).toEqual([{ name: '需求文档.pdf' }]);

      // 事务内 task.create 字段对齐契约
      expect(txModels.task.create).toHaveBeenCalledWith({
        data: {
          id: 't_0000000001',
          projectId: pid,
          title: '新任务',
          description: '描述',
          priority: 'high',
          status: 'pending',
          mainAgentId: 'a_product',
          backgroundDocs: [{ name: '需求文档.pdf' }],
          createdBy: userId,
          version: 0,
        },
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

    it('事务内同时创建群聊频道（task_group）与 task_agents、task_events', async () => {
      idGen.nextId
        .mockResolvedValueOnce('t_0000000001')
        .mockResolvedValueOnce('c_0000000001')
        .mockResolvedValueOnce('ta_0000000001')
        .mockResolvedValueOnce('s_0000000001')
        .mockResolvedValueOnce('ta_0000000002')
        .mockResolvedValueOnce('s_0000000002')
        .mockResolvedValueOnce('te_0000000001');
      const txModels = mockCreateTx(row());

      await service.create(pid, userId, {
        title: 'x',
        agentIds: ['a_product', 'a_developer'],
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
      // 团队：agentIds 全部 joined
      expect(txModels.taskAgent.create).toHaveBeenCalledTimes(2);
      expect(txModels.taskAgent.create).toHaveBeenNthCalledWith(1, {
        data: { id: 'ta_0000000001', taskId: 't_0000000001', agentId: 'a_product' },
      });
      expect(txModels.taskAgent.create).toHaveBeenNthCalledWith(2, {
        data: { id: 'ta_0000000002', taskId: 't_0000000001', agentId: 'a_developer' },
      });
      // 会话：每 Agent 每任务一行（uk_sessions_task_agent），status=created
      expect(txModels.session.create).toHaveBeenCalledTimes(2);
      expect(txModels.session.create).toHaveBeenNthCalledWith(1, {
        data: {
          id: 's_0000000001',
          taskId: 't_0000000001',
          agentId: 'a_product',
          status: 'created',
        },
      });
      expect(txModels.session.create).toHaveBeenNthCalledWith(2, {
        data: {
          id: 's_0000000002',
          taskId: 't_0000000001',
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

    it('mainAgentId 不在 agentIds 内 → 400 MAIN_AGENT_NOT_IN_TEAM', async () => {
      await expect(
        service.create(pid, userId, {
          title: 'x',
          agentIds: ['a_product'],
          mainAgentId: 'a_tester',
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('标题为空 → BadRequestException', async () => {
      await expect(
        service.create(pid, userId, { title: ' ', agentIds: ['a_1'] } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll（看板列表）', () => {
    it('返回 {items, total, page, pageSize}，items 含 teamAgentIds，created_at desc', async () => {
      prisma.$transaction.mockResolvedValue([
        1,
        [row(), row({ id: 't_0000000002', status: 'in_progress', taskAgents: [{ agentId: 'a_tester', removedAt: null }] })],
      ]);

      const result = await service.findAll(pid, { page: 1, pageSize: 20 });

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({ id: 't_0000000001', status: 'pending' });
      expect(result.items[0].teamAgentIds).toEqual(['a_product', 'a_developer']);
      expect(result.items[1].teamAgentIds).toEqual(['a_tester']);
      // 查询：projectId + 排序
      expect(prisma.task.findMany).toHaveBeenCalledWith({
        where: { projectId: pid },
        include: { taskAgents: true },
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
    it('返回详情（含 teamAgentIds、backgroundDocs）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ backgroundDocs: [{ name: '需求文档.pdf' }] }),
      );

      const result = await service.findOne('t_0000000001');

      expect(result).toMatchObject({
        id: 't_0000000001',
        title: '任务标题',
        status: 'pending',
        teamAgentIds: ['a_product', 'a_developer'],
      });
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
    it('mainAgentId 为团队内已选 Agent 时更新成功', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.task.update.mockResolvedValue(
        row({ mainAgentId: 'a_product', title: '改名' }),
      );

      const result = await service.update('t_0000000001', {
        title: '改名',
        mainAgentId: 'a_product',
      } as any);

      expect(prisma.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { title: '改名', mainAgentId: 'a_product' },
        include: { taskAgents: true },
      });
      expect(result).toMatchObject({ title: '改名', mainAgentId: 'a_product' });
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
    it('start：pending → in_progress，CAS(where status+version) + version+1 + status_change 事件 + 广播 + 系统消息（群聊+私信主 Agent）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ status: 'pending', version: 3, mainAgentId: 'a_product' }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            version: 4,
            mainAgentId: 'a_product',
            startedAt: new Date(),
          }),
        );
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_0000000001' }) // task_group 频道
        .mockResolvedValueOnce({ id: 'c_0000000002' }); // 主 Agent private 频道
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', name: '产品经理' });
      idGen.nextId
        .mockResolvedValueOnce('te_0000000001')
        .mockResolvedValueOnce('m_0000000001') // 群聊系统消息
        .mockResolvedValueOnce('m_0000000002'); // 私信主 Agent
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
      // 群聊系统消息（10 篇 §8.1：「任务已开始，主 Agent：产品经理」，含主 Agent 名）
      assertSysMessageCreated(txModels, 'c_0000000001', '任务已开始，主 Agent：产品经理', 1);
      // 私信主 Agent（13 篇 §4.2：含任务目标、团队分工、背景文档）
      assertSysMessageCreated(
        txModels,
        'c_0000000002',
        '任务已启动，请作为主 Agent 牵头推进。任务目标：任务标题。团队分工：a_product、a_developer',
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
        row({ status: 'pending_review', mainAgentId: 'a_product' }),
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
        row({ status: 'in_progress', mainAgentId: 'a_product' }),
      );

      const result = await service.start('t_0000000001', userId);

      expect(result.status).toBe('in_progress');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('start：created 会话全部置 active（T4；where 限定 status=created，frozen 不误动）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ status: 'pending', version: 0, mainAgentId: 'a_product' }),
        )
        .mockResolvedValue(
          row({ status: 'in_progress', version: 1, mainAgentId: 'a_product', startedAt: new Date() }),
        );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', name: '产品经理' });
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
        row({ status: 'pending', mainAgentId: 'a_product', taskAgents: [] }),
      );

      await assertBadRequestCode(
        () => service.start('t_0000000001', userId),
        TASK_ERRORS.TASK_EMPTY_TEAM,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('start：主 Agent 未确定 → 400 MAIN_AGENT_NOT_SET', async () => {
      prisma.task.findUnique.mockResolvedValue(
        row({ status: 'pending', mainAgentId: null }),
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
          row({ status: 'pending', version: 0, mainAgentId: 'a_product' }),
        )
        .mockResolvedValue(
          row({ status: 'in_progress', version: 1, mainAgentId: 'a_product' }),
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
          row({ status: 'pending', version: 0, mainAgentId: 'a_product' }),
        )
        .mockResolvedValueOnce(
          row({ status: 'in_progress', version: 1, mainAgentId: 'a_product' }),
        )
        .mockResolvedValueOnce(
          row({ status: 'pending', version: 0, mainAgentId: 'a_product' }),
        )
        .mockResolvedValue(
          row({ status: 'in_progress', version: 1, mainAgentId: 'a_product' }),
        );
      // 每次 start 均先查 group 频道再查 private 频道（两个并发 start 共 4 次）
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_1' })
        .mockResolvedValueOnce({ id: 'c_2' })
        .mockResolvedValueOnce({ id: 'c_1' })
        .mockResolvedValue({ id: 'c_2' });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', name: '产品经理' });
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
      // 成功方（第一次 start）系统消息落库：群聊 + 私信各一条
      assertSysMessageCreated(txModels, 'c_1', '任务已开始，主 Agent：产品经理', 1);
      assertSysMessageCreated(
        txModels,
        'c_2',
        '任务已启动，请作为主 Agent 牵头推进。任务目标：任务标题。团队分工：a_product、a_developer',
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
    /** team 调整事务的 tx mock：成员变更 + 会话冻结 + 系统消息全部可写，返回 tx 供断言。 */
    const mockTeamTx = () => {
      const txModels = {
        taskAgent: {
          create: jest.fn().mockResolvedValue({ id: 'ta_1' }),
          update: jest.fn().mockResolvedValue({ id: 'ta_1' }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

    it('add 全新 Agent：写 task_agents + 系统消息「{名} 已加入团队」+ 广播 team.changed(add) 与 chat.message.new', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({ taskAgents: [{ agentId: 'a_product', removedAt: null }] }),
        )
        .mockResolvedValue(
          row({
            taskAgents: [
              { agentId: 'a_product', removedAt: null },
              { agentId: 'a_developer', removedAt: null },
            ],
          }),
        );
      prisma.agent.findMany.mockResolvedValue([
        { id: 'a_developer', name: '开发者' },
      ]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_0000000001' });
      idGen.nextId
        .mockResolvedValueOnce('ta_0000000002')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { addAgentIds: ['a_developer'] },
        userId,
      );

      expect(txModels.taskAgent.create).toHaveBeenCalledWith({
        data: {
          id: 'ta_0000000002',
          taskId: 't_0000000001',
          agentId: 'a_developer',
        },
      });
      expect(txModels.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'c_0000000001',
          senderType: 'system',
          senderId: null,
          content: { text: '开发者 已加入团队', parts: [] },
          status: 'sent',
        }),
      });
      expect(txModels.taskAgent.update).not.toHaveBeenCalled();
      expect(txModels.session.updateMany).not.toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        { taskId: 't_0000000001', action: 'add', agentId: 'a_developer' },
        { type: 'task', id: 't_0000000001' },
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ channelId: 'c_0000000001', senderType: 'system' }) },
        { type: 'channel', id: 'c_0000000001' },
      );
      expect(result.teamAgentIds).toEqual(['a_product', 'a_developer']);
    });

    it('add 已存在且未移除 → 幂等 200：无事务、无广播', async () => {
      prisma.task.findUnique.mockResolvedValue(row());

      const result = await service.updateTeam(
        't_0000000001',
        { addAgentIds: ['a_product'] },
        userId,
      );

      expect(result.teamAgentIds).toEqual(['a_product', 'a_developer']);
      expect(prisma.agent.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('add 已移除 Agent（重新加入）：task_agents update removedAt=null + joinedAt 刷新 + 广播 add', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            taskAgents: [
              { agentId: 'a_product', removedAt: null },
              { agentId: 'a_tester', removedAt: new Date() },
            ],
          }),
        )
        .mockResolvedValue(row());
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester', name: '测试' }]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      await service.updateTeam(
        't_0000000001',
        { addAgentIds: ['a_tester'] },
        userId,
      );

      expect(txModels.taskAgent.create).not.toHaveBeenCalled();
      expect(txModels.taskAgent.update).toHaveBeenCalledWith({
        where: { taskId_agentId: { taskId: 't_0000000001', agentId: 'a_tester' } },
        data: { removedAt: null, joinedAt: expect.any(Date) },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        { taskId: 't_0000000001', action: 'add', agentId: 'a_tester' },
        { type: 'task', id: 't_0000000001' },
      );
    });

    it('add 已移除 Agent（重新加入）：任务 in_progress 时恢复会话置 active（T4 衔接）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            status: 'in_progress',
            mainAgentId: 'a_product',
            taskAgents: [
              { agentId: 'a_product', removedAt: null },
              { agentId: 'a_tester', removedAt: new Date() },
            ],
          }),
        )
        .mockResolvedValue(row({ status: 'in_progress' }));
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester', name: '测试' }]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      await service.updateTeam(
        't_0000000001',
        { addAgentIds: ['a_tester'] },
        userId,
      );

      expect(txModels.taskAgent.update).toHaveBeenCalledWith({
        where: { taskId_agentId: { taskId: 't_0000000001', agentId: 'a_tester' } },
        data: { removedAt: null, joinedAt: expect.any(Date) },
      });
      expect(txModels.session.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', agentId: 'a_tester' },
        data: { status: 'active' },
      });
    });

    it('add 已移除 Agent（重新加入）：任务 pending 时恢复会话保持 created', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            taskAgents: [
              { agentId: 'a_product', removedAt: null },
              { agentId: 'a_tester', removedAt: new Date() },
            ],
          }),
        )
        .mockResolvedValue(row());
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester', name: '测试' }]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      await service.updateTeam(
        't_0000000001',
        { addAgentIds: ['a_tester'] },
        userId,
      );

      expect(txModels.session.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', agentId: 'a_tester' },
        data: { status: 'created' },
      });
    });

    it('add 全新 Agent：任务 in_progress 时新会话置 active（T4 衔接）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            status: 'in_progress',
            mainAgentId: 'a_product',
            taskAgents: [{ agentId: 'a_product', removedAt: null }],
          }),
        )
        .mockResolvedValue(
          row({
            status: 'in_progress',
            taskAgents: [
              { agentId: 'a_product', removedAt: null },
              { agentId: 'a_developer', removedAt: null },
            ],
          }),
        );
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_developer', name: '开发者' }]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId
        .mockResolvedValueOnce('ta_0000000002')
        .mockResolvedValueOnce('s_0000000002')
        .mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      await service.updateTeam(
        't_0000000001',
        { addAgentIds: ['a_developer'] },
        userId,
      );

      expect(txModels.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: 't_0000000001',
          agentId: 'a_developer',
          status: 'active',
        }),
      });
    });

    it('remove：task_agents 写 removed_at + 会话冻结 frozen + 系统消息「已移出团队，其会话已冻结」+ 广播 remove', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(
          row({
            mainAgentId: 'a_product',
            taskAgents: [
              { agentId: 'a_product', removedAt: null },
              { agentId: 'a_tester', removedAt: null },
            ],
          }),
        )
        .mockResolvedValue(
          row({
            mainAgentId: 'a_product',
            taskAgents: [{ agentId: 'a_product', removedAt: null }],
          }),
        );
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_tester', name: '测试' }]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { removeAgentIds: ['a_tester'] },
        userId,
      );

      expect(txModels.taskAgent.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', agentId: 'a_tester', removedAt: null },
        data: { removedAt: expect.any(Date) },
      });
      expect(txModels.session.updateMany).toHaveBeenCalledWith({
        where: { taskId: 't_0000000001', agentId: 'a_tester' },
        data: { status: 'frozen' },
      });
      expect(txModels.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content: { text: '测试 已移出团队，其会话已冻结', parts: [] },
        }),
      });
      expect(txModels.taskAgent.create).not.toHaveBeenCalled();
      expect(txModels.task.update).not.toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        { taskId: 't_0000000001', action: 'remove', agentId: 'a_tester' },
        { type: 'task', id: 't_0000000001' },
      );
      expect(realtime.broadcast).not.toHaveBeenCalledWith(
        EVENT_TYPES.TEAM_CHANGED,
        { taskId: 't_0000000001', action: 'add', agentId: 'a_tester' },
        { type: 'task', id: 't_0000000001' },
      );
      expect(result.teamAgentIds).toEqual(['a_product']);
    });

    it('remove 主 Agent → mainAgentId 清空（置 null）', async () => {
      prisma.task.findUnique
        .mockResolvedValueOnce(row({ mainAgentId: 'a_product' }))
        .mockResolvedValue(row({ mainAgentId: null }));
      prisma.agent.findMany.mockResolvedValue([{ id: 'a_product', name: '产品经理' }]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      idGen.nextId.mockResolvedValueOnce('m_0000000001');
      const txModels = mockTeamTx();

      const result = await service.updateTeam(
        't_0000000001',
        { removeAgentIds: ['a_product'] },
        userId,
      );

      expect(txModels.task.update).toHaveBeenCalledWith({
        where: { id: 't_0000000001' },
        data: { mainAgentId: null },
      });
      expect(result.mainAgentId).toBeNull();
    });

    it('remove 不在团队/已移除 → 幂等 200：无事务、无广播', async () => {
      prisma.task.findUnique.mockResolvedValue(row());

      const result = await service.updateTeam(
        't_0000000001',
        { removeAgentIds: ['a_tester'] },
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
      expect(prisma.agent.findMany).not.toHaveBeenCalled();
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
          { addAgentIds: ['a_developer'] },
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
      expect(prisma.agent.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('add 目标 Agent 不存在 → 404 AGENT_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(row());
      prisma.agent.findMany.mockResolvedValue([]);

      try {
        await service.updateTeam(
          't_0000000001',
          { addAgentIds: ['ghost'] },
          userId,
        );
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: TASK_ERRORS.AGENT_NOT_FOUND,
        });
      }
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.updateTeam('t_missing', { addAgentIds: ['a_developer'] }, userId),
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
