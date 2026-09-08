import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { TEAM_MEMBERSHIP_ERRORS } from '../common/guards/team-membership.guard';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerClient } from '../workers/worker.client';
import { CHAT_ERRORS } from './chat.constants';
import { ChatService } from './chat.service';
import { MessageDispatcher } from './message-dispatcher';

describe('ChatService', () => {
  let service: ChatService;
  let prisma: {
    chatChannel: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    message: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
    };
    task: { findUnique: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
    team: { findUnique: jest.Mock };
    teamMember: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
    };
    teamUserMember: { findUnique: jest.Mock; findMany: jest.Mock };
    session: { findFirst: jest.Mock; findMany: jest.Mock };
    worker: { findUnique: jest.Mock };
    agent: { findUnique: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workerClient: { getMessages: jest.Mock };
  let dispatcher: {
    dispatch: jest.Mock;
    onLoading: jest.Mock;
    onFinal: jest.Mock;
    onError: jest.Mock;
  };

  const userId = 'u_admin';
  const channelId = 'c_0000000001';
  const taskId = 't_0000000001';

  const channelRow = (overrides: Record<string, unknown> = {}) => {
    const type =
      (overrides as any).type ??
      (CHANNEL_TYPE as any).team_group ??
      'team_group';
    const isPrivate = type === CHANNEL_TYPE.private;
    const base: any = {
      id: channelId,
      type,
      teamId: isPrivate ? null : 'tm_0000000001',
      taskId: isPrivate ? taskId : null,
      agentId: null,
      pinned: false,
      lastReadAt: null,
      deletedAt: null,
      createdAt: new Date('2026-08-07T00:00:00Z'),
      team: isPrivate ? null : { id: 'tm_0000000001', name: '团队' },
      task: isPrivate
        ? {
            id: taskId,
            title: '任务标题',
            status: 'pending',
            teamId: 'tm_0000000001',
          }
        : null,
      agent: null,
    };
    return { ...base, ...overrides };
  };
  const taskGroupRow = (overrides: Record<string, unknown> = {}) =>
    channelRow({
      type: CHANNEL_TYPE.task_group,
      teamId: null,
      taskId,
      team: null,
      task: {
        id: taskId,
        title: '任务标题',
        status: 'pending',
        teamId: 'tm_0000000001',
      },
      ...overrides,
    });

  const messageRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'm_0000000001',
    channelId,
    senderType: SENDER_TYPE.user,
    senderId: userId,
    content: { text: '你好', parts: [] },
    mentions: [],
    attachmentUrl: null,
    attachmentName: null,
    attachmentType: null,
    status: MESSAGE_STATUS.sent,
    createdAt: new Date('2026-08-07T00:00:00Z'),
    ...overrides,
  });

  /** 生成 n 条升序消息（m_0000000001..m_n），供分页测试。 */
  const genMessages = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      messageRow({ id: `m_${String(i + 1).padStart(10, '0')}` }),
    );

  const allowAccess = (row = channelRow()) => {
    prisma.chatChannel.findUnique.mockResolvedValue(row);
    if ((row as any).teamId) {
      prisma.team.findUnique.mockResolvedValue({ id: (row as any).teamId });
      prisma.task.findFirst.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: (row as any).teamId,
        mainAgentInstanceId: null,
        mainAgentId: null,
      } as any);
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: (row as any).teamId,
        mainAgentInstanceId: null,
        mainAgentId: null,
      } as any);
      (prisma as any).teamMember.findMany.mockResolvedValue([]);
    }
  };

  beforeEach(async () => {
    prisma = {
      chatChannel: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockImplementation(async (args: any) => ({
          id: args?.where?.id ?? channelId,
        })),
      },
      message: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      task: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      team: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tm_0000000001' }),
      },
      teamMember: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null) as any,
      },
      teamUserMember: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tum_1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      session: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]) as any,
      },
      worker: { findUnique: jest.fn() },
      agent: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(),
    };
    idGen = { nextId: jest.fn(), seed: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workerClient = { getMessages: jest.fn().mockResolvedValue([]) };
    dispatcher = {
      dispatch: jest.fn().mockResolvedValue({ replies: [] }),
      onLoading: jest.fn().mockReturnThis(),
      onFinal: jest.fn().mockReturnThis(),
      onError: jest.fn().mockReturnThis(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
        { provide: WorkerClient, useValue: workerClient },
        { provide: MessageDispatcher, useValue: dispatcher },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  describe('createMessage（8 步流程）', () => {
    it('构造时接通分派回调：onLoading/onFinal/onError 各注册一次（行为不变，仅日志）', () => {
      expect(dispatcher.onLoading).toHaveBeenCalledTimes(1);
      expect(dispatcher.onFinal).toHaveBeenCalledTimes(1);
      expect(dispatcher.onError).toHaveBeenCalledTimes(1);
    });

    it('发消息全流程：权限→@解析→落库→广播→分派受理，返回 {message, triggers}（回复异步回流）', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_0000000001' });
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());
      dispatcher.dispatch.mockResolvedValue({
        replies: [{ agentId: 'a_product', text: '需求已明确' }],
      });

      const dto = {
        text: '你好',
        mentions: [{ type: 'agent', agentId: 'a_product' }],
      };
      const result = await service.createMessage(channelId, userId, dto as any);

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'm_0000000001',
          channelId,
          taskId: taskId,
          senderType: SENDER_TYPE.user,
          senderId: userId,
          content: { text: '你好', parts: [] },
          mentions: [{ type: 'agent', agentId: 'a_product' }],
          status: MESSAGE_STATUS.sent,
        }),
      });

      // 4. 广播用户消息（loading/回复由分派器广播）
      expect(realtime.broadcast).toHaveBeenCalledTimes(2);
      expect(realtime.broadcast).toHaveBeenNthCalledWith(
        1,
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            id: 'm_0000000001',
            senderType: 'user',
          }),
        },
        { type: 'channel', id: channelId },
      );

      // 5. 分派受理：dispatched 目标下发（fire-and-forget，不阻塞 201 响应）
      // Todo 1 单入口：teamId 必填 + 任务经 taskContext 透传
      expect(dispatcher.dispatch).toHaveBeenCalledWith({
        messageId: 'm_0000000001',
        channelId,
        taskId,
        teamId: 'tm_0000000001',
        taskContext: { taskId },
        text: '你好',
        targets: [{ agentId: 'a_product', sessionId: 's_0000000001' }],
      });

      // 响应契约：{message, triggers}
      expect(result.message).toMatchObject({
        id: 'm_0000000001',
        channelId,
        senderType: 'user',
      });
      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          sessionId: 's_0000000001',
          status: 'dispatched',
        },
      ]);
    });

    it('多目标 @（{type:all} 展开全部）→ 触发多目标分派', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
        { agentId: 'a_architect', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_1' });
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: '大家好',
        mentions: [{ type: 'all' }],
      } as any);

      // 仅用户消息落库，无 ACK
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(result.triggers).toHaveLength(2);
      expect(realtime.broadcast).toHaveBeenCalledTimes(2);
    });

    it('无 mentions 且任务无主实例（task_group）→ 不触发：triggers 空、dispatcher 空目标、仅广播用户消息', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: '无 @',
      } as any);

      expect(result.triggers).toEqual([]);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ targets: [] }),
      );
      expect(realtime.broadcast).toHaveBeenCalledTimes(2);
      // 无主成员配置（mock team 无 mainAgentMemberId 且空名册）→ 不查会话
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
    });

    it('UX-10 带附件：attachmentUrl/Name/Type 落库 + 响应透出（分发/广播不受影响）', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(
        messageRow({
          attachmentUrl: '/uploads/abc.png',
          attachmentName: '架构图.png',
          attachmentType: 'png',
        }),
      );

      const dto = {
        text: '见图',
        attachmentUrl: '/uploads/abc.png',
        attachmentName: '架构图.png',
        attachmentType: 'png',
      };
      const result = await service.createMessage(channelId, userId, dto as any);

      // 落库：附件三字段随消息写入（无附件消息不携带——条件展开）
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          attachmentUrl: '/uploads/abc.png',
          attachmentName: '架构图.png',
          attachmentType: 'png',
        }),
      });
      // 响应 DTO 透出附件（前端气泡渲染数据源）
      expect(result.message).toMatchObject({
        attachmentUrl: '/uploads/abc.png',
        attachmentName: '架构图.png',
        attachmentType: 'png',
      });
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ targets: [] }),
      );
    });

    it('UX-10 无附件：落库 data 不带附件字段，响应透出 null', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: '纯文字',
      } as any);

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.not.objectContaining({
          data: expect.objectContaining({ attachmentUrl: expect.anything() }),
        }),
      );
      expect(result.message).toMatchObject({
        attachmentUrl: null,
        attachmentName: null,
        attachmentType: null,
      });
    });

    it('归档任务频道发消息 → legacy task_group 保持 409 TASK_ARCHIVED（不落库不广播）', async () => {
      allowAccess(
        taskGroupRow({
          task: {
            id: taskId,
            title: 'x',
            status: 'archived',
            teamId: 'tm_0000000001',
          },
        }),
      );

      await expect(
        service.createMessage(channelId, userId, { text: 'hi' } as any),
      ).rejects.toThrow(ConflictException);
      try {
        await service.createMessage(channelId, userId, { text: 'hi' } as any);
        fail('应抛出 ConflictException');
      } catch (e) {
        expect((e as ConflictException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.TASK_ARCHIVED,
        });
      }
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('频道不存在 → 404 CHANNEL_NOT_FOUND', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(null);

      await expect(
        service.createMessage(channelId, userId, { text: 'hi' } as any),
      ).rejects.toThrow(NotFoundException);
      try {
        await service.createMessage(channelId, userId, { text: 'hi' } as any);
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.CHANNEL_NOT_FOUND,
        });
      }
    });

    it('非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      allowAccess();
      (prisma as any).teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.createMessage(channelId, userId, { text: 'hi' } as any),
      ).rejects.toThrow(ForbiddenException);
      try {
        await service.createMessage(channelId, userId, { text: 'hi' } as any);
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: 'PERMISSION_TEAM_NOT_MEMBER',
        });
      }
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('团队频道无任务上下文：非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(channelRow());
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findUnique.mockResolvedValue(null);
      prisma.task.findFirst.mockResolvedValue(null);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.createMessage(channelId, userId, { text: 'hi' } as any),
      ).rejects.toThrow(ForbiddenException);
      try {
        await service.createMessage(channelId, userId, { text: 'hi' } as any);
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: 'PERMISSION_TEAM_NOT_MEMBER',
        });
      }
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('团队频道无任务上下文：团队成员 → 200 落库广播', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(channelRow());
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findUnique.mockResolvedValue(null);
      prisma.task.findFirst.mockResolvedValue(null);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
      (prisma as any).teamMember.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
      } as any);

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(result.message).toMatchObject({ id: 'm_0000000001', channelId });
      expect(realtime.broadcast).toHaveBeenCalledTimes(2);
    });

    describe('T8 群聊无 @ 自动路由主实例', () => {
      // 主实例配置齐全的任务频道行（mock task 含 mainAgentInstanceId/mainAgentId）
      const mainChannel = (type: string = CHANNEL_TYPE.task_group) =>
        channelRow({
          type,
          task: {
            id: taskId,
            title: '任务标题',
            status: 'pending',
            teamId: 'tm_0000000001',
            mainAgentInstanceId: 'ti_pm',
            mainAgentId: 'a_project_manager',
          },
        });
      // 通用主实例触发 mock：团队行 + 主实例行 + 会话 + ACK
      const mockMainDispatched = (opts: {
        team: { id: string; agentId: string; removedAt: Date | null }[];
        mainRow?: {
          id: string;
          agentId: string;
          removedAt: Date | null;
        } | null;
        session?: { id: string } | null;
        mainMemberId?: string | null;
      }) => {
        (prisma as any).teamMember.findMany.mockResolvedValue(opts.team);
        (prisma as any).team.findUnique.mockResolvedValue({
          id: 'tm_0000000001',
          mainAgentMemberId:
            opts.mainMemberId !== undefined
              ? opts.mainMemberId
              : (opts.mainRow?.id ?? null),
        });
        (prisma as any).teamMember.findFirst.mockResolvedValue(
          opts.mainRow ?? null,
        );
        prisma.session.findFirst.mockResolvedValue(
          opts.session ?? { id: 's_pm' },
        );
        idGen.nextId.mockResolvedValue('m_1');
        prisma.message.create.mockResolvedValue(messageRow());
      };

      it('task_group 无 @ → 主实例 trigger（dispatched）', async () => {
        allowAccess(mainChannel());
        mockMainDispatched({
          team: [
            { id: 'tmm_pm', agentId: 'a_project_manager', removedAt: null },
            { id: 'tmm_dev', agentId: 'a_developer', removedAt: null },
          ],
          mainRow: {
            id: 'tmm_pm',
            agentId: 'a_project_manager',
            removedAt: null,
          },
          session: { id: 's_pm' },
        });

        const result = await service.createMessage(channelId, userId, {
          text: '无 @ 消息',
        } as any);

        // triggers 含主实例（instanceId=主成员，status=dispatched）
        expect(result.triggers).toEqual([
          {
            agentId: 'a_project_manager',
            instanceId: 'tmm_pm',
            sessionId: 's_pm',
            status: 'dispatched',
          },
        ]);
        // dispatch targets 携带 instanceId
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            targets: [
              {
                agentId: 'a_project_manager',
                instanceId: 'tmm_pm',
                sessionId: 's_pm',
              },
            ],
          }),
        );
        // team-only 主门：读团队主成员，不读任务快照
        expect((prisma as any).team.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'tm_0000000001' } }),
        );
        expect(prisma.message.create).toHaveBeenCalledTimes(1);
        expect(realtime.broadcast).toHaveBeenCalledTimes(2);
      });

      it('无 @ 且主实例已 removed → 不触发（triggers 空，仅落库广播，不查会话不落 ACK）', async () => {
        allowAccess(mainChannel());
        const removedAt = new Date('2026-08-01T00:00:00Z');
        mockMainDispatched({
          team: [{ id: 'tmm_pm', agentId: 'a_project_manager', removedAt }],
          mainRow: { id: 'tmm_pm', agentId: 'a_project_manager', removedAt },
          session: null,
        });
        prisma.message.create.mockResolvedValue(messageRow());

        const result = await service.createMessage(channelId, userId, {
          text: '无 @ 消息',
        } as any);

        expect(result.triggers).toEqual([]);
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ targets: [] }),
        );
        expect(prisma.session.findFirst).not.toHaveBeenCalled();
        expect(prisma.message.create).toHaveBeenCalledTimes(1);
        expect(realtime.broadcast).toHaveBeenCalledTimes(2);
      });

      it('有 @ → 仅 @ 目标，不叠加主实例', async () => {
        allowAccess(mainChannel());
        (prisma as any).teamMember.findMany.mockResolvedValue([
          { id: 'tmm_dev', agentId: 'a_developer', removedAt: null },
        ]);
        prisma.session.findFirst.mockResolvedValue({ id: 's_dev' });
        idGen.nextId.mockResolvedValue('m_1');
        prisma.message.create.mockResolvedValue(messageRow());

        const result = await service.createMessage(channelId, userId, {
          text: '@开发者',
          mentions: [{ type: 'agent', agentId: 'a_developer' }],
        } as any);

        expect(result.triggers).toEqual([
          {
            agentId: 'a_developer',
            instanceId: 'tmm_dev',
            sessionId: 's_dev',
            status: 'dispatched',
          },
        ]);
        expect(result.triggers).toHaveLength(1);
        // 主成员行不查询（@ 语义优先，不叠加）
        expect((prisma as any).teamMember.findFirst).not.toHaveBeenCalled();
      });

      it('private 频道无 @ → 不触发（仅 task_group 路由主实例）', async () => {
        allowAccess(mainChannel(CHANNEL_TYPE.private));
        (prisma as any).teamMember.findMany.mockResolvedValue([]);
        idGen.nextId.mockResolvedValue('m_1');
        prisma.message.create.mockResolvedValue(messageRow());

        const result = await service.createMessage(channelId, userId, {
          text: '私聊无 @',
        } as any);

        expect(result.triggers).toEqual([]);
        expect((prisma as any).teamMember.findFirst).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ targets: [] }),
        );
      });

      it('Todo5：mainAgentMemberId 缺省 → 首位成员（seq 升序，任务 mainAgentId 不再读取）', async () => {
        allowAccess(
          channelRow({
            task: {
              id: taskId,
              title: '任务标题',
              status: 'pending',
              teamId: 'tm_0000000001',
              mainAgentInstanceId: null,
              mainAgentId: 'a_developer',
            },
          }),
        );
        (prisma as any).teamMember.findMany.mockResolvedValue([
          { id: 'tmm_dev1', agentId: 'a_developer', removedAt: null },
          { id: 'tmm_dev2', agentId: 'a_developer', removedAt: null },
        ]);
        (prisma as any).teamMember.findFirst.mockResolvedValue({
          id: 'tmm_dev1',
          agentId: 'a_developer',
          removedAt: null,
        });
        prisma.session.findFirst.mockResolvedValue({ id: 's_dev1' });
        idGen.nextId.mockResolvedValue('m_1');
        prisma.message.create.mockResolvedValue(messageRow());

        const result = await service.createMessage(channelId, userId, {
          text: '无 @ 消息',
        } as any);

        expect(result.triggers).toEqual([
          {
            agentId: 'a_developer',
            instanceId: 'tmm_dev1',
            sessionId: 's_dev1',
            status: 'dispatched',
          },
        ]);
        // 主门查询：团队主成员（mainAgentMemberId 缺省 → seq 升序首位），无任务快照查询
        expect((prisma as any).teamMember.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { teamId: 'tm_0000000001' },
            orderBy: { seq: 'asc' },
          }),
        );
        expect(prisma.session.findFirst).toHaveBeenCalledWith({
          where: { teamId: 'tm_0000000001', teamMemberId: 'tmm_dev1' },
          select: { id: true },
        });
      });

      it('无 @ 且主成员不存在（空名册）→ 不触发（triggers 空）', async () => {
        allowAccess(mainChannel());
        (prisma as any).teamMember.findMany.mockResolvedValue([
          { id: 'tmm_other', agentId: 'a_developer', removedAt: null },
        ]);
        (prisma as any).teamMember.findFirst.mockResolvedValue(null);
        idGen.nextId.mockResolvedValue('m_1');
        prisma.message.create.mockResolvedValue(messageRow());

        const result = await service.createMessage(channelId, userId, {
          text: '无 @ 消息',
        } as any);

        expect(result.triggers).toEqual([]);
        expect(prisma.session.findFirst).not.toHaveBeenCalled();
        expect(prisma.message.create).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('@ 解析（resolveMentions）', () => {
    it('agent 型团队内未移除 + 有会话 → dispatched', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_1' });
      idGen.nextId.mockResolvedValue('m_1');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
        mentions: [{ type: 'agent', agentId: 'a_product' }],
      } as any);

      expect(result.triggers).toEqual([
        { agentId: 'a_product', sessionId: 's_1', status: 'dispatched' },
      ]);
      // 落库 mentions 原样存储
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mentions: [{ type: 'agent', agentId: 'a_product' }],
          }),
        }),
      );
    });

    it('agent 型已移除 → agent_removed（不查会话、不参与分派）', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: new Date('2026-08-01T00:00:00Z') },
      ]);
      idGen.nextId.mockResolvedValue('m_1');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
        mentions: [{ type: 'agent', agentId: 'a_product' }],
      } as any);

      expect(prisma.session.findFirst).not.toHaveBeenCalled();
      expect(result.triggers).toEqual([
        { agentId: 'a_product', sessionId: null, status: 'agent_removed' },
      ]);
      // agent_removed 不进 dispatcher 目标
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ targets: [] }),
      );
    });

    it('agent 型不在团队 → 400 MENTION_AGENT_NOT_IN_TEAM（不落库）', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([]);
      const dto = {
        text: 'hi',
        mentions: [{ type: 'agent', agentId: 'a_ghost' }],
      };

      await expect(
        service.createMessage(channelId, userId, dto as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.createMessage(channelId, userId, dto as any);
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
        });
      }
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('{type:all} → 展开为团队全部未移除 Agent，落库保持 all 原样', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
        { agentId: 'a_developer', removedAt: null },
        { agentId: 'a_removed', removedAt: new Date('2026-08-01T00:00:00Z') },
      ]);
      prisma.session.findFirst
        .mockResolvedValueOnce({ id: 's_1' })
        .mockResolvedValueOnce({ id: 's_2' });
      idGen.nextId.mockResolvedValue('m_1');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: '@all',
        mentions: [{ type: 'all' }],
      } as any);

      // 展开未移除 2 个（不含 a_removed），各按会话 dispatched
      expect(result.triggers).toEqual([
        { agentId: 'a_product', sessionId: 's_1', status: 'dispatched' },
        { agentId: 'a_developer', sessionId: 's_2', status: 'dispatched' },
      ]);
      // 落库 mentions 原样保持 all 语义
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mentions: [{ type: 'all' }] }),
        }),
      );
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [
            { agentId: 'a_product', sessionId: 's_1' },
            { agentId: 'a_developer', sessionId: 's_2' },
          ],
        }),
      );
    });

    it('mention type 非法 → 400 MENTION_TYPE_INVALID', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([]);

      await expect(
        service.createMessage(channelId, userId, {
          text: 'hi',
          mentions: [{ type: 'everyone' }],
        } as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.createMessage(channelId, userId, {
          text: 'hi',
          mentions: [{ type: 'everyone' }],
        } as any);
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.MENTION_TYPE_INVALID,
        });
      }
    });

    it('agent mention 缺 agentId → 400 MENTION_AGENT_NOT_IN_TEAM', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([]);

      await expect(
        service.createMessage(channelId, userId, {
          text: 'hi',
          mentions: [{ type: 'agent' }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findMessages（游标分页）', () => {
    it('首页（无 cursor）：id 降序取最新 limit+1 判末页，items 反转升序，nextCursor=当前页最早 id', async () => {
      allowAccess();
      // DB `ORDER BY id DESC` 返回：最新优先
      prisma.message.findMany.mockResolvedValue(genMessages(51).reverse());

      const result = await service.findMessages(channelId, userId, {} as any);

      // 查询契约：idx_messages_channel_id 命中（channelId，ORDER BY id DESC，take=limit+1 判末页）
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId },
        orderBy: { id: 'desc' },
        take: 51, // limit(50) + 1 判末页
      });
      // 最新 50 条（m_2..m_51），items id 升序（时间正序）返回
      expect(result.items).toHaveLength(50);
      expect(result.items[0].id).toBe('m_0000000002');
      expect(result.items[49].id).toBe('m_0000000051');
      // nextCursor = 当前页最早一条 id（m_2），下一页取更老
      expect(result.nextCursor).toBe('m_0000000002');
    });

    it('limit 默认 50、上限 100', async () => {
      allowAccess();
      prisma.message.findMany.mockResolvedValue([]);

      await service.findMessages(channelId, userId, {} as any);
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { id: 'desc' }, take: 51 }),
      );

      prisma.message.findMany.mockResolvedValue(genMessages(101).reverse());
      await service.findMessages(channelId, userId, { limit: 200 } as any);
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { id: 'desc' }, take: 101 }),
      );
    });

    it('cursor 传入 → WHERE id < cursor（下一页取更老）', async () => {
      allowAccess();
      prisma.message.findMany.mockResolvedValue(genMessages(3).reverse());

      const result = await service.findMessages(channelId, userId, {
        cursor: 'm_0000000050',
      } as any);

      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId, id: { lt: 'm_0000000050' } },
        orderBy: { id: 'desc' },
        take: 51,
      });
      // items 反转回升序（时间正序），nextCursor 续传即下一页起始游标 → 无重复无遗漏
      expect(result.items.map((m) => m.id)).toEqual([
        'm_0000000001',
        'm_0000000002',
        'm_0000000003',
      ]);
    });

    it('末页/空历史 → nextCursor null', async () => {
      allowAccess();
      prisma.message.findMany.mockResolvedValue(genMessages(3).reverse());

      const result = await service.findMessages(channelId, userId, {} as any);
      expect(result.items.map((m) => m.id)).toEqual([
        'm_0000000001',
        'm_0000000002',
        'm_0000000003',
      ]);
      expect(result.nextCursor).toBeNull();

      prisma.message.findMany.mockResolvedValue([]);
      const empty = await service.findMessages(channelId, userId, {} as any);
      expect(empty.items).toEqual([]);
      expect(empty.nextCursor).toBeNull();
    });
  });

  describe('getSessionHistory（私聊历史 = serve 会话完整历史，含思考/工具）', () => {
    /** 私聊频道（默认 channelRow 为 task_group，override type/agentId/teamMemberId）。 */
    const privateChannel = (overrides: Record<string, unknown> = {}) =>
      channelRow({
        type: CHANNEL_TYPE.private,
        agentId: 'a_product',
        teamMemberId: 'tmm_1',
        ...overrides,
      });
    /** 存量私聊频道（无 teamMemberId）：team-only 下回退平台表，不查会话。 */
    const legacyTaskChannel = (overrides: Record<string, unknown> = {}) =>
      channelRow({
        type: CHANNEL_TYPE.private,
        agentId: 'a_product',
        teamMemberId: null,
        ...overrides,
      });

    const boundSession = (overrides: Record<string, unknown> = {}) => ({
      instanceRef: 'ses_abc',
      workerId: 'w_1',
      agentId: 'a_product',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      ...overrides,
    });

    /** serve GET /session/{id}/message 返回的会话消息（info/parts 形状对齐 v1-driver ServeMessage）。 */
    const serveMessages = () => [
      {
        info: { id: 'msg_user_1', role: 'user', time: { created: 1000 } },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: '帮我调研一下', synthetic: false },
          { type: 'text', text: '（注入的群聊历史上下文）', synthetic: true },
        ],
      },
      {
        info: { id: 'msg_asst_1', role: 'assistant', time: { created: 2000 } },
        parts: [
          { type: 'reasoning', text: '先拆解需求', synthetic: false },
          {
            type: 'tool',
            tool: 'vteam_task_context',
            state: { status: 'success' },
          },
          { type: 'text', text: '调研结果如下', synthetic: false },
          // 实测 serve 历史消息 step-finish 常不持久化 → 非最后一条 assistant 仍须 sent
        ],
      },
      {
        info: { id: 'msg_asst_2', role: 'assistant', time: { created: 3000 } },
        parts: [{ type: 'text', text: '补充说明', synthetic: false }],
      },
    ];

    it('private + 会话已绑定 → serve agent 增补 + DB 全量合并（source=session；思考/工具 parts 保留；未完成标 processing）', async () => {
      allowAccess(privateChannel());
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([boundSession()]);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: { baseUrl: 'http://worker' },
      });
      workerClient.getMessages.mockResolvedValue(serveMessages());
      // DB 空：合并 = session agent 增补（session user 注入伪影排除，DB user 行为准）
      prisma.message.findMany.mockResolvedValue([]);

      const result = await service.getSessionHistory(channelId, userId);

      // 调 worker serve GET /session/{id}/message（worker 引用 + instanceRef）
      expect(workerClient.getMessages).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: { baseUrl: 'http://worker' } },
        'ses_abc',
      );
      expect(result.source).toBe('session');
      expect(result.nextCursor).toBeNull();

      const [a1, a2] = result.items as Array<Record<string, any>>;
      expect(result.items).toHaveLength(2);
      // assistant：senderType=agent、senderId=频道模板 agent、senderInstanceId=teamMemberId
      expect(a1.senderType).toBe('agent');
      expect(a1.senderId).toBe('a_product');
      expect(a1.senderInstanceId).toBe('tmm_1');
      // parts：reasoning/tool/text 保留；step-start/step-finish 过滤
      expect(a1.content.parts.map((p) => p.type)).toEqual([
        'reasoning',
        'tool',
        'text',
      ]);
      expect(a1.content.text).toBe('调研结果如下');
      // 历史 assistant 无 step-finish（serve 不持久化）→ 非最后一条仍 sent；
      // 仅最后一条无 finish 标 processing（会话末尾可能仍在流式）
      expect(a1.status).toBe('sent');
      expect(a2.status).toBe('processing');
      // createdAt = serve info.time.created（毫秒）转 ISO
      expect(a1.createdAt).toBe(new Date(2000).toISOString());
      expect(a2.createdAt).toBe(new Date(3000).toISOString());
    });

    it('DM-own-message 回归：DB 为真源 + session 仅 agent 增补（user 可见、已落库去重、流式保留）', async () => {
      allowAccess(privateChannel());
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([boundSession()]);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      // serve 侧：注入 user 伪影 + 已落库 agent(msg_asst_1) + 流式中 agent(msg_asst_2)
      workerClient.getMessages.mockResolvedValue(serveMessages());
      // DB 侧（id 降序 mock，与实现 orderBy id desc 对齐）：用户 own message +
      // 已落库 agent（parts.messageID 引用 msg_asst_1，含 reasoning/tool 过程）
      prisma.message.findMany.mockResolvedValue([
        messageRow({
          id: 'm_0000000002',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          content: {
            text: '调研结果如下',
            parts: [
              {
                type: 'reasoning',
                text: '先拆解需求',
                messageID: 'msg_asst_1',
              },
              { type: 'text', text: '调研结果如下', messageID: 'msg_asst_1' },
            ],
          },
          createdAt: new Date(2500),
        }),
        messageRow({
          id: 'm_0000000001',
          senderType: SENDER_TYPE.user,
          senderId: userId,
          content: { text: '平台用户消息', parts: [] },
          createdAt: new Date(1500),
        }),
      ]);

      const result = await service.getSessionHistory(channelId, userId);

      expect(result.source).toBe('session');
      const items = result.items as Array<Record<string, any>>;
      const ids = items.map((m) => m.id);
      // 根因修复：DB 用户 own message 可见
      expect(ids).toContain('m_0000000001');
      // session 注入 user 伪影排除（DB user 行为准）
      expect(ids).not.toContain('msg_user_1');
      // 已落库 agent 去重：DB 行为准，session 同体排除（无 msg_asst_1 会话项）
      expect(ids).not.toContain('msg_asst_1');
      expect(ids).toContain('m_0000000002');
      // 未落库流式 agent 保留为增补（reasoning/tool 渲染不断）
      expect(ids).toContain('msg_asst_2');
      // 时间正序：DB user(1500) < DB agent(2500) < session 流式(3000)
      expect(ids).toEqual(['m_0000000001', 'm_0000000002', 'msg_asst_2']);
      const asst2 = items.find((m) => m.id === 'msg_asst_2');
      expect(asst2.status).toBe('processing');
      expect(asst2.senderType).toBe('agent');
    });

    it('serve 消息按 time.created 升序（乱序输入 → 输出时间正序）', async () => {
      allowAccess(privateChannel());
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([boundSession()]);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      const [m1, m2, m3] = serveMessages();
      workerClient.getMessages.mockResolvedValue([m3, m1, m2]);
      prisma.message.findMany.mockResolvedValue([]);

      const result = await service.getSessionHistory(channelId, userId);
      expect(
        (result.items as Array<Record<string, any>>).map((m) => m.id),
      ).toEqual(['msg_asst_1', 'msg_asst_2']);
    });

    it('最后一条 assistant 含 step-finish(reason=stop) → sent（不误标 processing）', async () => {
      allowAccess(privateChannel());
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([boundSession()]);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      const [u, a1] = serveMessages();
      workerClient.getMessages.mockResolvedValue([
        u,
        {
          ...a1,
          parts: [...a1.parts, { type: 'step-finish', reason: 'stop' }],
        },
      ]);
      prisma.message.findMany.mockResolvedValue([]);

      const result = await service.getSessionHistory(channelId, userId);
      const items = result.items as Array<Record<string, any>>;
      // session user 伪影排除后仅剩终态 assistant 一条
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('msg_asst_1');
      expect(items[0].status).toBe('sent');
    });

    it('会话未绑定（workerId/instanceRef 空，created 态）→ 回退平台表 source=db，不调 worker', async () => {
      allowAccess(privateChannel());
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([
          boundSession({ instanceRef: null, workerId: null }),
        ]);
      prisma.message.findMany.mockResolvedValue(genMessages(3).reverse());

      const result = await service.getSessionHistory(channelId, userId);

      expect(result.source).toBe('db');
      expect(result.items).toHaveLength(3);
      expect(workerClient.getMessages).not.toHaveBeenCalled();
    });

    it('Todo5：无 teamMemberId（存量任务锚定频道）→ 回退平台表，不查会话', async () => {
      allowAccess(legacyTaskChannel());
      prisma.message.findMany.mockResolvedValue([]);

      const result = await service.getSessionHistory(channelId, userId);

      expect(result.source).toBe('db');
      expect(result.items).toEqual([]);
      expect(prisma.session.findMany).not.toHaveBeenCalled();
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
    });

    it('worker 不存在 → 回退平台表', async () => {
      allowAccess(privateChannel());
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([boundSession()]);
      prisma.worker.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue(genMessages(2).reverse());

      const result = await service.getSessionHistory(channelId, userId);

      expect(result.source).toBe('db');
      expect(result.items).toHaveLength(2);
      expect(workerClient.getMessages).not.toHaveBeenCalled();
    });

    it('worker 拉取失败 → 回退平台表（读历史不因 worker 异常阻塞）', async () => {
      allowAccess(privateChannel());
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([boundSession()]);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      workerClient.getMessages.mockRejectedValue(new Error('worker down'));
      prisma.message.findMany.mockResolvedValue(genMessages(2).reverse());

      const result = await service.getSessionHistory(channelId, userId);

      expect(result.source).toBe('db');
      expect(result.items).toHaveLength(2);
    });

    it('非 private（task_group）→ 400 SESSION_HISTORY_NOT_SUPPORTED（群聊保持平台表）', async () => {
      allowAccess();

      try {
        await service.getSessionHistory(channelId, userId);
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.SESSION_HISTORY_NOT_SUPPORTED,
        });
      }
      expect(prisma.session.findMany).not.toHaveBeenCalled();
      expect(workerClient.getMessages).not.toHaveBeenCalled();
    });

    it('非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      allowAccess(privateChannel());
      (prisma as any).teamUserMember.findUnique.mockResolvedValue(null);

      try {
        await service.getSessionHistory(channelId, userId);
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        });
      }
    });

    it('teamMember 维度：private team 私聊 + teamMember 会话已绑定 → serve 复用历史保留（跨任务 reuse=true）', async () => {
      const teamId = 'tm_0000000001';
      const teamMemberId = 'tmm_0000000001';
      const teamChannel = channelRow({
        type: CHANNEL_TYPE.private,
        teamId,
        teamMemberId,
        agentId: 'a_product',
        taskId: null,
      } as any);
      allowAccess(teamChannel);
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([boundSession()]);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      } as any);
      workerClient.getMessages.mockResolvedValue(serveMessages());
      prisma.message.findMany.mockResolvedValue([]);
      const result = await service.getSessionHistory(channelId, userId);
      expect((prisma.session as any).findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamMemberId } }),
      );
      expect(workerClient.getMessages).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: {} },
        'ses_abc',
      );
      expect(result.source).toBe('session');
      expect(
        (result.items as Array<Record<string, any>>).map((m) => m.id),
      ).toEqual(['msg_asst_1', 'msg_asst_2']);
    });

    it('teamMember 维度：会话未绑定（reset后 instanceRef 空）→ 回退平台表历史清空', async () => {
      const teamId = 'tm_0000000001';
      const teamMemberId = 'tmm_0000000001';
      const teamChannel = channelRow({
        type: CHANNEL_TYPE.private,
        teamId,
        teamMemberId,
        agentId: 'a_product',
        taskId: null,
      } as any);
      allowAccess(teamChannel);
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([
          boundSession({ instanceRef: null, workerId: null }),
        ]);
      prisma.message.findMany.mockResolvedValue([]);
      const result = await service.getSessionHistory(channelId, userId);
      expect(result.source).toBe('db');
      expect(result.items).toEqual([]);
      expect(workerClient.getMessages).not.toHaveBeenCalled();
    });

    it('teamMember 维度：多会话中选最新已绑定的（跨任务复用，最新空则取旧任务绑定）', async () => {
      const teamId = 'tm_0000000001';
      const teamMemberId = 'tmm_0000000001';
      const teamChannel = channelRow({
        type: CHANNEL_TYPE.private,
        teamId,
        teamMemberId,
        agentId: 'a_product',
        taskId: null,
      } as any);
      allowAccess(teamChannel);
      const oldBound = boundSession({
        createdAt: new Date('2026-08-01T00:00:00Z'),
      });
      const newEmpty = boundSession({
        instanceRef: null,
        workerId: null,
        createdAt: new Date('2026-08-02T00:00:00Z'),
      });
      (prisma.session as any).findMany = jest
        .fn()
        .mockResolvedValue([newEmpty, oldBound]);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      } as any);
      workerClient.getMessages.mockResolvedValue(serveMessages());
      prisma.message.findMany.mockResolvedValue([]);
      const result = await service.getSessionHistory(channelId, userId);
      expect(workerClient.getMessages).toHaveBeenCalledWith(
        expect.anything(),
        'ses_abc',
      );
      expect(result.source).toBe('session');
    });
  });

  describe('getTriggerResults（@ 触发结果轮询）', () => {
    const triggerMessage = (overrides: Record<string, unknown> = {}) =>
      messageRow({
        mentions: [{ type: 'agent', agentId: 'a_product' }],
        ...overrides,
      });

    it('dispatched + 有回复：返回 {agentId, status:dispatched, replyMessageId}', async () => {
      allowAccess(taskGroupRow());
      prisma.message.findUnique.mockResolvedValue(triggerMessage());
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_1' });
      prisma.message.findFirst.mockResolvedValue({ id: 'm_0000000002' });

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          status: 'dispatched',
          replyMessageId: 'm_0000000002',
        },
      ]);
      // 回复查询契约：本频道 + senderType=agent + senderId=Agent + createdAt 晚于原消息，id 升序取最早一条
      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          channelId,
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          createdAt: { gt: new Date('2026-08-07T00:00:00Z') },
        },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
    });

    it('no_session：无会话 → status no_session、无 replyMessageId（不判为已分派）', async () => {
      allowAccess(taskGroupRow());
      prisma.message.findUnique.mockResolvedValue(triggerMessage());
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue(null);

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      expect(result.triggers).toEqual([
        { agentId: 'a_product', status: 'no_session' },
      ]);
      expect(result.triggers[0]).not.toHaveProperty('replyMessageId');
    });

    it('agent_removed：已移除 → status agent_removed、不查会话', async () => {
      allowAccess(taskGroupRow());
      prisma.message.findUnique.mockResolvedValue(triggerMessage());
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: new Date('2026-08-01T00:00:00Z') },
      ]);

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      expect(prisma.session.findFirst).not.toHaveBeenCalled();
      expect(result.triggers).toEqual([
        { agentId: 'a_product', status: 'agent_removed' },
      ]);
    });

    it('消息不存在或属于其他频道 → 404 MESSAGE_NOT_FOUND', async () => {
      allowAccess();
      prisma.message.findUnique.mockResolvedValue(null);

      await expect(
        service.getTriggerResults(channelId, userId, 'm_999'),
      ).rejects.toThrow(NotFoundException);
      try {
        await service.getTriggerResults(channelId, userId, 'm_999');
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.MESSAGE_NOT_FOUND,
        });
      }
    });

    it('非用户消息 → 400 MESSAGE_NOT_USER', async () => {
      allowAccess();
      prisma.message.findUnique.mockResolvedValue(
        triggerMessage({
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          mentions: null,
        }),
      );

      await expect(
        service.getTriggerResults(channelId, userId, 'm_0000000002'),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.getTriggerResults(channelId, userId, 'm_0000000002');
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.MESSAGE_NOT_USER,
        });
      }
      expect((prisma as any).teamMember.findMany).not.toHaveBeenCalled();
    });

    it('用户消息无 mentions → 返回空 triggers（不查团队不查回复）', async () => {
      allowAccess();
      prisma.message.findUnique.mockResolvedValue(
        triggerMessage({ mentions: null }),
      );

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      expect(result.triggers).toEqual([]);
      expect((prisma as any).teamMember.findMany).not.toHaveBeenCalled();
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
    });

    it('{type:all} mentions → 展开为团队全部未移除 Agent', async () => {
      allowAccess(taskGroupRow());
      prisma.message.findUnique.mockResolvedValue(
        triggerMessage({ mentions: [{ type: 'all' }] }),
      );
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
        { agentId: 'a_developer', removedAt: null },
        { agentId: 'a_removed', removedAt: new Date('2026-08-01T00:00:00Z') },
      ]);
      prisma.session.findFirst
        .mockResolvedValueOnce({ id: 's_1' })
        .mockResolvedValueOnce({ id: 's_2' });
      prisma.message.findFirst.mockResolvedValue(null);

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      // 未移除 2 个展开；已移除 a_removed 不出现
      expect(result.triggers).toEqual([
        { agentId: 'a_product', status: 'dispatched' },
        { agentId: 'a_developer', status: 'dispatched' },
      ]);
    });
  });

  describe('getTriggerResults 团队维度（零任务 team_group，team-mention-fix）', () => {
    const teamZeroTaskRow = () =>
      channelRow({ teamId: 'tm_0000000001', taskId: null, task: null });
    const allowZeroTaskTeam = (row = teamZeroTaskRow()) => {
      prisma.chatChannel.findUnique.mockResolvedValue(row);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findFirst.mockResolvedValue(null);
      prisma.task.findUnique.mockResolvedValue(null);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
    };

    it('零任务团队 @all → 各成员 triggers（dispatched/no_session），200 不 500', async () => {
      allowZeroTaskTeam();
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      prisma.message.findUnique.mockResolvedValue(
        messageRow({ mentions: [{ type: 'all' }] }),
      );
      prisma.session.findFirst
        .mockResolvedValueOnce({ id: 's_0000000001' })
        .mockResolvedValueOnce(null);
      prisma.message.findFirst.mockResolvedValue(null);

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          instanceId: 'tmm_0000000001',
          status: 'dispatched',
        },
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000002',
          status: 'no_session',
        },
      ]);
      // 团队维度会话查询（teamId + teamMemberId），无 task 维度查询
      expect(prisma.session.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_0000000001', teamMemberId: 'tmm_0000000001' },
        select: { id: true },
      });
    });

    it('零任务团队 @agent → 仅单个目标 + 回复定位（senderInstanceId=成员）', async () => {
      allowZeroTaskTeam();
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      prisma.message.findUnique.mockResolvedValue(
        messageRow({
          mentions: [
            {
              type: 'agent',
              agentId: 'a_developer',
              instanceId: 'tmm_0000000002',
            },
          ],
        }),
      );
      prisma.session.findFirst.mockResolvedValue({ id: 's_0000000002' });
      prisma.message.findFirst.mockResolvedValue({ id: 'm_0000000005' });

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      expect(result.triggers).toEqual([
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000002',
          status: 'dispatched',
          replyMessageId: 'm_0000000005',
        },
      ]);
      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          channelId,
          senderType: SENDER_TYPE.agent,
          senderId: 'a_developer',
          createdAt: { gt: new Date('2026-08-07T00:00:00Z') },
          OR: [
            { senderInstanceId: 'tmm_0000000002' },
            { senderInstanceId: null },
          ],
        },
        orderBy: { id: 'asc' },
        select: { id: true },
      });
    });

    it('零任务团队 @agent 指向已移除成员 → agent_removed（不查会话）', async () => {
      allowZeroTaskTeam();
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tmm_0000000009',
          agentId: 'a_gone',
          alias: '离职-1',
          seq: 9,
          removedAt: new Date('2026-08-01T00:00:00Z'),
        },
      ]);
      prisma.message.findUnique.mockResolvedValue(
        messageRow({ mentions: [{ type: 'agent', agentId: 'a_gone' }] }),
      );
      prisma.message.findFirst.mockResolvedValue(null);

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      expect(prisma.session.findFirst).not.toHaveBeenCalled();
      expect(result.triggers).toEqual([
        {
          agentId: 'a_gone',
          instanceId: 'tmm_0000000009',
          status: 'agent_removed',
        },
      ]);
    });

    it('零任务团队 createMessage 带 @all → 不 500：团队分支降级 no_session（createMessage 无需动）', async () => {
      allowZeroTaskTeam();
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: '@所有人',
        mentions: [{ type: 'all' }],
      } as any);

      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          instanceId: 'tmm_0000000001',
          sessionId: null,
          status: 'no_session',
        },
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000002',
          sessionId: null,
          status: 'no_session',
        },
      ]);
    });
  });

  describe('Todo5 触发收敛（team-only：无 task 锚定分支）', () => {
    const triggerMessage = (overrides: Record<string, unknown> = {}) =>
      messageRow({
        mentions: [{ type: 'agent', agentId: 'a_product' }],
        ...overrides,
      });

    it('存量任务频道轮询：经任务归属 teamId 反查团队成员 + 团队会话直查', async () => {
      allowAccess(taskGroupRow());
      prisma.message.findUnique.mockResolvedValue(triggerMessage());
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { id: 'tmm_1', agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_1' });
      prisma.message.findFirst.mockResolvedValue(null);

      const result = await service.getTriggerResults(
        channelId,
        userId,
        'm_0000000001',
      );

      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          instanceId: 'tmm_1',
          status: 'dispatched',
        },
      ]);
      expect((prisma as any).teamMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamId: 'tm_0000000001' } }),
      );
      expect(prisma.session.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_0000000001', teamMemberId: 'tmm_1' },
        select: { id: true },
      });
    });

    it('存量任务频道发消息：@ 经任务归属团队解析，无任务侧快照', async () => {
      allowAccess(taskGroupRow());
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      (prisma as any).teamMember.findMany.mockResolvedValue([
        { id: 'tmm_1', agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_1' });
      idGen.nextId.mockResolvedValue('m_1');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
        mentions: [{ type: 'agent', agentId: 'a_product' }],
      } as any);

      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          instanceId: 'tmm_1',
          sessionId: 's_1',
          status: 'dispatched',
        },
      ]);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [
            { agentId: 'a_product', instanceId: 'tmm_1', sessionId: 's_1' },
          ],
        }),
      );
    });
  });

  describe('findAccessibleChannels（频道列表）', () => {
    it('仅返回调用者已加入团队的频道，{items,total} + type 过滤透传（team_group）', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_0000000001' },
        { teamId: 'tm_0000000002' },
      ]);
      prisma.$transaction.mockResolvedValue([
        1,
        [
          channelRow(),
          channelRow({
            id: 'c_2',
            type: 'private',
            agentId: 'a_product',
            taskId: 't_1',
            teamId: null,
            team: null,
            task: { id: 't_1', title: 'x', status: 'pending' },
          }),
        ],
      ]);

      const result = await service.findAccessibleChannels(userId, 'team_group');

      expect((prisma as any).teamUserMember.findMany).toHaveBeenCalledWith({
        where: { userId },
        select: { teamId: true },
      });
      expect(prisma.chatChannel.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          deletedAt: null,
          type: 'team_group',
        }),
        include: expect.anything(),
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: channelId,
        type: 'team_group',
      });
    });

    it('type 非法 → 400 CHANNEL_TYPE_INVALID', async () => {
      await expect(
        service.findAccessibleChannels(userId, 'hack'),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.findAccessibleChannels(userId, 'hack');
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.CHANNEL_TYPE_INVALID,
        });
      }
    });

    it('task_group 已废弃 → 400 CHANNEL_TYPE_DEPRECATED', async () => {
      await expect(
        service.findAccessibleChannels(userId, 'task_group'),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.findAccessibleChannels(userId, 'task_group');
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.CHANNEL_TYPE_DEPRECATED,
        });
      }
    });

    it('teamId 过滤 → 仅返回该团队频道（@unique 一团队一群）', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_0000000001' },
      ]);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.$transaction.mockResolvedValue([
        1,
        [channelRow({ teamId: 'tm_0000000001' })],
      ]);

      const result = await service.findAccessibleChannels(
        userId,
        undefined,
        'tm_0000000001',
      );

      expect(prisma.chatChannel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ teamId: 'tm_0000000001' }),
        }),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0].teamId).toBe('tm_0000000001');
    });

    it('taskId 过渡映射 → 经 Task.teamId 映射到 team 过滤', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_0000000001' },
      ]);
      prisma.task.findUnique.mockResolvedValue({
        teamId: 'tm_0000000001',
      } as any);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.$transaction.mockResolvedValue([1, [channelRow()]]);

      const result = await service.findAccessibleChannels(
        userId,
        undefined,
        undefined,
        taskId,
      );

      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: taskId },
        select: { teamId: true },
      });
      expect(result.items).toHaveLength(1);
    });
  });

  describe('findAccessibleChannels 团队成员门（channel → taskId → teamId → teamUserMember）', () => {
    it('团队成员 → 200 + 行（团队归属即授权）', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_0000000001' },
      ]);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.chatChannel.findFirst.mockResolvedValue(channelRow() as any);
      prisma.$transaction.mockResolvedValue([1, [channelRow()]]);

      const result = await service.findAccessibleChannels(
        userId,
        undefined,
        'tm_0000000001',
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].teamId).toBe('tm_0000000001');
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });

    it('团队成员 + team_group 缺失 → 调用后恰好创建 1 条 team_group', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_0000000001' },
      ]);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('c_new');
      prisma.chatChannel.create.mockResolvedValue(
        channelRow({ id: 'c_new' }) as any,
      );
      prisma.$transaction.mockResolvedValue([1, [channelRow({ id: 'c_new' })]]);

      await service.findAccessibleChannels(userId, undefined, 'tm_0000000001');

      expect(prisma.chatChannel.create).toHaveBeenCalledTimes(1);
      expect(prisma.chatChannel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teamId: 'tm_0000000001',
            type: 'team_group',
          }),
        }),
      );
    });

    it('团队成员 + type=private 过滤 → 200 且不补建 team_group', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([
        { teamId: 'tm_0000000001' },
      ]);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.$transaction.mockResolvedValue([0, []]);

      const result = await service.findAccessibleChannels(
        userId,
        'private',
        'tm_0000000001',
      );

      expect(result.total).toBe(0);
      expect(prisma.chatChannel.findFirst).not.toHaveBeenCalled();
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });

    it('非成员带 teamId 过滤 → 空集（不泄漏频道存在性，不抛 403）', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([]);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      const result = await service.findAccessibleChannels(
        userId,
        undefined,
        'tm_0000000001',
      );
      expect(result).toEqual({ items: [], total: 0 });
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });

    it('非成员无过滤 → 空集（仅调用者团队可见，零团队即空）', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([]);
      prisma.$transaction.mockResolvedValue([0, []]);
      const result = await service.findAccessibleChannels(userId, 'team_group');
      expect(result).toEqual({ items: [], total: 0 });
      expect(prisma.chatChannel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: [] } }),
        }),
      );
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });

    it('任务上下文无 teamId 归属 → 403（fail closed，无项目回退）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(channelRow());
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findUnique.mockResolvedValue(null);
      prisma.task.findFirst.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: null,
      } as any);
      try {
        await service.findMessages(channelId, userId, {} as any);
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        });
      }
      expect((prisma as any).projectMember).toBeUndefined();
    });

    it('旧频道任务无 teamId 归属 → 403（fail closed，不查 project_members）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(
        taskGroupRow({
          task: { id: taskId, title: 'x', status: 'pending' },
        }),
      );
      try {
        await service.findMessages(channelId, userId, {} as any);
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect(e).toBeInstanceOf(ForbiddenException);
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        });
      }
      expect((prisma as any).projectMember).toBeUndefined();
    });
  });

  describe('findOne（频道详情）', () => {
    it('返回频道信息 + 成员 Agent（团队成员）', async () => {
      allowAccess();
      prisma.teamMember.findMany.mockResolvedValue([
        {
          agentId: 'a_product',
          agent: { id: 'a_product', name: '产品经理', role: 'product' },
        },
      ] as any);

      const result = await service.findOne(channelId, userId);

      expect(result).toMatchObject({
        id: channelId,
        type: 'team_group',
        agentMembers: [{ id: 'a_product', name: '产品经理', role: 'product' }],
      });
      expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
        where: { teamId: 'tm_0000000001' },
        select: expect.anything(),
      });
    });
  });

  describe('team_group 分区与系统分隔（每团队一群复用）', () => {
    it('同一团队两任务历史：消息按 taskId 分区，跨任务插入 system 分隔并双订阅 team:/task:', async () => {
      allowAccess(channelRow({ teamId: 'tm_0000000001', taskId: null }));
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_1',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        } as any,
      ]);
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue({
        taskId: 't_0000000001',
      } as any);
      (prisma.task.findUnique as any).mockResolvedValueOnce({
        status: 'pending',
        teamId: 'tm_0000000001',
      } as any);
      prisma.task.findUnique.mockResolvedValue({ title: '任务B' } as any);
      idGen.nextId
        .mockResolvedValueOnce('m_sys_1')
        .mockResolvedValueOnce('m_0000000002');
      prisma.message.create
        .mockResolvedValueOnce({
          id: 'm_sys_1',
          channelId,
          senderType: SENDER_TYPE.system,
          senderId: null,
          content: { text: '--- Task 任务B started ---', parts: [] },
          mentions: [],
          status: MESSAGE_STATUS.sent,
          createdAt: new Date(),
          taskId: 't_0000000002',
        } as any)
        .mockResolvedValueOnce(
          messageRow({ id: 'm_0000000002', taskId: 't_0000000002' } as any),
        );
      prisma.message.findFirst.mockResolvedValue({
        taskId: 't_0000000001',
      } as any);

      const result = await service.createMessage(channelId, userId, {
        text: '任务B消息',
        taskId: 't_0000000002',
      } as any);

      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const sysCall = (prisma.message.create as jest.Mock).mock.calls[0][0];
      expect(sysCall.data.senderType).toBe(SENDER_TYPE.system);
      expect(sysCall.data.content.text).toContain('Task');
      expect(prisma.message.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ taskId: 't_0000000002' }),
        }),
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'team', id: 'tm_0000000001' },
      );
    });

    it('createMessage 权限防泄漏：team 存在但非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(
        channelRow({ teamId: 'tm_0000000001' }) as any,
      );
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' } as any);
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: 'tm_0000000001',
      } as any);
      prisma.task.findFirst.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: 'tm_0000000001',
      } as any);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue(null);

      await expect(
        service.createMessage(channelId, userId, { text: 'hi', taskId } as any),
      ).rejects.toThrow(ForbiddenException);
      try {
        await service.createMessage(channelId, userId, {
          text: 'hi',
          taskId,
        } as any);
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        });
      }
    });

    it('ensureTeamChannel 懒创建：不存在时创建 team_group，存在时复用', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('c_new');
      prisma.chatChannel.create.mockResolvedValue(
        channelRow({ id: 'c_new', teamId: 'tm_0000000001' }) as any,
      );

      const created = await service.ensureTeamChannel('tm_0000000001');
      expect(prisma.chatChannel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teamId: 'tm_0000000001',
            type: 'team_group',
          }),
        }),
      );
      expect(created.id).toBe('c_new');

      prisma.chatChannel.findFirst.mockResolvedValue(
        channelRow({ id: 'c_exist' }) as any,
      );
      prisma.chatChannel.create.mockClear();
      const reused = await service.ensureTeamChannel('tm_0000000001');
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
      expect(reused.id).toBe('c_exist');
    });
  });

  describe('createDmChannel（私聊频道 teamMember 维度复用）', () => {
    const teamId = 'tm_0000000001';
    const teamMemberId = 'tmm_0000000001';
    it('正常创建 private 频道（teamId+teamMemberId，type=private）', async () => {
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({ id: teamId }),
      };
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      (prisma as any).teamMember.findUnique = jest
        .fn()
        .mockResolvedValue({ id: teamMemberId, teamId, agentId: 'a_product' });
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('c_0000000001');
      prisma.chatChannel.create.mockResolvedValue(
        channelRow({
          id: 'c_0000000001',
          type: 'private',
          teamId,
          teamMemberId,
          agentId: 'a_product',
          taskId: null,
        }) as any,
      );
      // also support via prisma.teamMember
      (prisma as any).teamMember.findUnique.mockResolvedValue({
        id: teamMemberId,
        teamId,
        agentId: 'a_product',
      });

      const result = await service.createDmChannel(userId, {
        teamId,
        teamMemberId,
      } as any);

      expect(prisma.chatChannel.create).toHaveBeenCalledWith({
        data: {
          id: 'c_0000000001',
          type: 'private',
          teamId,
          teamMemberId,
          agentId: 'a_product',
          taskId: null,
        },
        include: expect.anything(),
      });
      expect(result).toMatchObject({
        id: 'c_0000000001',
        type: 'private',
        teamId,
        teamMemberId,
      });
    });

    it('teamId+agentId 解析到 teamMember（单实例）', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      (prisma as any).teamMember.findFirst = jest
        .fn()
        .mockResolvedValue({ id: teamMemberId, agentId: 'a_product' });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product' } as any);
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('c_0000000002');
      prisma.chatChannel.create.mockResolvedValue(
        channelRow({
          id: 'c_0000000002',
          type: 'private',
          teamId,
          teamMemberId,
          agentId: 'a_product',
          taskId: null,
        } as any),
      );
      (prisma as any).teamMember.findFirst.mockResolvedValue({
        id: teamMemberId,
        agentId: 'a_product',
      });

      const result = await service.createDmChannel(userId, {
        teamId,
        agentId: 'a_product',
      } as any);
      expect((prisma as any).teamMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamId, agentId: 'a_product' } }),
      );
      expect(result).toMatchObject({ teamId, teamMemberId });
    });

    it('uk_channels_team_member 已存在 → 幂等返回已有频道（不重复创建）', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      (prisma as any).teamMember.findUnique = jest
        .fn()
        .mockResolvedValue({ id: teamMemberId, teamId, agentId: 'a_product' });
      prisma.chatChannel.findFirst.mockResolvedValue(
        channelRow({
          type: 'private',
          teamId,
          teamMemberId,
          agentId: 'a_product',
        } as any),
      );
      (prisma as any).teamMember.findUnique.mockResolvedValue({
        id: teamMemberId,
        teamId,
        agentId: 'a_product',
      });

      const result = await service.createDmChannel(userId, {
        teamId,
        teamMemberId,
      } as any);

      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: channelId, type: 'private' });
    });

    it('已 soft delete 的私聊频道 → 复活（deletedAt 置空，复用原记录）', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      (prisma as any).teamMember.findUnique = jest
        .fn()
        .mockResolvedValue({ id: teamMemberId, teamId, agentId: 'a_product' });
      prisma.chatChannel.findFirst.mockResolvedValue(
        channelRow({
          type: 'private',
          teamId,
          teamMemberId,
          agentId: 'a_product',
          deletedAt: new Date('2026-08-08T00:00:00Z'),
        } as any),
      );
      prisma.chatChannel.update.mockResolvedValue(
        channelRow({
          type: 'private',
          teamId,
          teamMemberId,
          agentId: 'a_product',
        } as any),
      );
      (prisma as any).teamMember.findUnique.mockResolvedValue({
        id: teamMemberId,
        teamId,
        agentId: 'a_product',
      });

      const result = await service.createDmChannel(userId, {
        teamId,
        teamMemberId,
      } as any);

      expect(prisma.chatChannel.update).toHaveBeenCalledWith({
        where: { id: channelId },
        data: { deletedAt: null },
        include: expect.anything(),
      });
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: channelId, type: 'private' });
    });

    it('团队不存在 → 404 TEAM_NOT_FOUND', async () => {
      prisma.team.findUnique.mockResolvedValue(null as any);
      await expect(
        service.createDmChannel(userId, { teamId, teamMemberId } as any),
      ).rejects.toThrow(NotFoundException);
      try {
        await service.createDmChannel(userId, { teamId, teamMemberId } as any);
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.TEAM_NOT_FOUND,
        });
      }
    });

    it('团队成员不属于该团队 → 400 MENTION_AGENT_NOT_IN_TEAM', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      (prisma as any).teamMember.findUnique = jest.fn().mockResolvedValue({
        id: teamMemberId,
        teamId: 'tm_other',
        agentId: 'a_product',
      });
      (prisma as any).teamMember.findUnique.mockResolvedValue({
        id: teamMemberId,
        teamId: 'tm_other',
        agentId: 'a_product',
      });
      await expect(
        service.createDmChannel(userId, { teamId, teamMemberId } as any),
      ).rejects.toThrow(BadRequestException);
      try {
        await service.createDmChannel(userId, { teamId, teamMemberId } as any);
        fail('应抛出 BadRequestException');
      } catch (e) {
        expect((e as BadRequestException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.MENTION_AGENT_NOT_IN_TEAM,
        });
      }
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });

    it('Agent 不存在 → 404 AGENT_NOT_FOUND', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      prisma.agent.findUnique.mockResolvedValue(null as any);
      await expect(
        service.createDmChannel(userId, { teamId, agentId: 'a_ghost' } as any),
      ).rejects.toThrow(NotFoundException);
      try {
        await service.createDmChannel(userId, {
          teamId,
          agentId: 'a_ghost',
        } as any);
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.AGENT_NOT_FOUND,
        });
      }
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });

    it('Agent 不在团队内 → 400 MENTION_AGENT_NOT_IN_TEAM', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_ghost' } as any);
      (prisma as any).teamMember.findFirst = jest.fn().mockResolvedValue(null);
      await expect(
        service.createDmChannel(userId, { teamId, agentId: 'a_ghost' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('teamMemberId 与 agentId 都缺 → 400', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      await expect(
        service.createDmChannel(userId, { teamId } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('同一 teamMember 复用：不为每任务创建私聊（幂等）', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: teamId } as any);
      prisma.teamMember.findUnique.mockResolvedValue({
        id: teamMemberId,
        teamId,
        agentId: 'a_product',
      } as any);
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product' } as any);
      prisma.teamMember.findFirst.mockResolvedValue({
        id: teamMemberId,
        agentId: 'a_product',
      } as any);
      const existing = channelRow({
        id: 'c_reuse',
        type: 'private',
        teamId,
        teamMemberId,
        agentId: 'a_product',
        taskId: null,
      } as any);
      prisma.chatChannel.findFirst.mockResolvedValue(existing as any);
      const r1 = await service.createDmChannel(userId, {
        teamId,
        teamMemberId,
      } as any);
      const r2 = await service.createDmChannel(userId, {
        teamId,
        agentId: 'a_product',
      } as any);
      expect(r1.id).toBe('c_reuse');
      expect(r2.id).toBe('c_reuse');
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });
  });

  describe('removeChannel（UX-09 删除会话）', () => {
    it('soft delete：deletedAt 置当前时间，返回 {id, deletedAt}', async () => {
      allowAccess();
      const deletedAt = new Date('2026-08-09T00:00:00Z');
      prisma.chatChannel.update.mockResolvedValue({ id: channelId, deletedAt });

      const result = await service.removeChannel(channelId, userId);

      expect(prisma.chatChannel.update).toHaveBeenCalledWith({
        where: { id: channelId },
        data: { deletedAt: expect.any(Date) },
        select: { id: true, deletedAt: true },
      });
      expect(result).toEqual({
        id: channelId,
        deletedAt: deletedAt.toISOString(),
      });
    });

    it('已删除频道（deletedAt 非空）→ 404 CHANNEL_NOT_FOUND（幂等）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(
        channelRow({ deletedAt: new Date('2026-08-08T00:00:00Z') }),
      );

      await expect(service.removeChannel(channelId, userId)).rejects.toThrow(
        NotFoundException,
      );
      try {
        await service.removeChannel(channelId, userId);
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.CHANNEL_NOT_FOUND,
        });
      }
      expect(prisma.chatChannel.update).not.toHaveBeenCalled();
    });

    it('非团队成员 → 403 PERMISSION_TEAM_NOT_MEMBER（不执行删除）', async () => {
      allowAccess();
      (prisma as any).teamUserMember.findUnique.mockResolvedValue(null);

      await expect(service.removeChannel(channelId, userId)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.chatChannel.update).not.toHaveBeenCalled();
    });
  });

  describe('updateChannelPinned（UX-09 置顶/取消置顶）', () => {
    it('置顶 true：update pinned=true，返回频道 DTO 带 pinned', async () => {
      allowAccess();
      prisma.chatChannel.update.mockResolvedValue(channelRow({ pinned: true }));

      const result = await service.updateChannelPinned(channelId, userId, true);

      expect(prisma.chatChannel.update).toHaveBeenCalledWith({
        where: { id: channelId },
        data: { pinned: true },
        include: expect.anything(),
      });
      expect(result).toMatchObject({ id: channelId, pinned: true });
    });

    it('取消置顶 false：update pinned=false，返回频道 DTO', async () => {
      allowAccess();
      prisma.chatChannel.update.mockResolvedValue(
        channelRow({ pinned: false }),
      );

      const result = await service.updateChannelPinned(
        channelId,
        userId,
        false,
      );

      expect(prisma.chatChannel.update).toHaveBeenCalledWith({
        where: { id: channelId },
        data: { pinned: false },
        include: expect.anything(),
      });
      expect(result).toMatchObject({ id: channelId, pinned: false });
    });

    it('已删除频道 → 404（不可置顶）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(
        channelRow({ deletedAt: new Date('2026-08-08T00:00:00Z') }),
      );

      await expect(
        service.updateChannelPinned(channelId, userId, true),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.chatChannel.update).not.toHaveBeenCalled();
    });
  });

  describe('markChannelRead（UX-09 标记已读）', () => {
    it('lastReadAt 置当前时间，返回 {id, lastReadAt}', async () => {
      allowAccess();
      const lastReadAt = new Date('2026-08-09T01:00:00Z');
      prisma.chatChannel.update.mockResolvedValue({
        id: channelId,
        lastReadAt,
      });

      const result = await service.markChannelRead(channelId, userId);

      expect(prisma.chatChannel.update).toHaveBeenCalledWith({
        where: { id: channelId },
        data: { lastReadAt: expect.any(Date) },
        select: { id: true, lastReadAt: true },
      });
      expect(result).toEqual({
        id: channelId,
        lastReadAt: lastReadAt.toISOString(),
      });
    });

    it('已删除频道 → 404（不可标记已读）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(
        channelRow({ deletedAt: new Date('2026-08-08T00:00:00Z') }),
      );

      await expect(service.markChannelRead(channelId, userId)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.chatChannel.update).not.toHaveBeenCalled();
    });
  });

  describe('补充覆盖：team 成员@解析与 SSE team scope 双广播', () => {
    it('onModuleInit 按最大 m_/c_ 对齐 seed', async () => {
      (prisma.message as any).findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'm_0000000005' }]);
      (prisma.chatChannel as any).findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'c_0000000007' }]);
      await service.onModuleInit();
      expect(idGen.seed).toHaveBeenCalledWith('m', 5);
      expect(idGen.seed).toHaveBeenCalledWith('c', 7);
    });

    it('team 维度 @all：展开为团队成员全部未移除，disabled 跳过，落库保持 all，广播 team+channel 双事件', async () => {
      allowAccess(channelRow({ teamId: 'tm_0000000001', taskId: null } as any));
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());
      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
        mentions: [{ type: 'all' }],
      } as any);
      expect(result.triggers).toHaveLength(2);
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mentions: [{ type: 'all' }] }),
        }),
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'team', id: 'tm_0000000001' },
      );
    });

    it('team 成员 agent @：按 teamMemberId 精确，instanceId 命中', async () => {
      allowAccess(
        channelRow({ teamId: 'tm_0000000001', taskId: 't_0000000001' } as any),
      );
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_product',
          alias: '产品经理-2',
          seq: 2,
        },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_1' } as any);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());
      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
        mentions: [
          { type: 'agent', agentId: 'a_product', instanceId: 'tmm_0000000002' },
        ],
      } as any);
      expect(result.triggers[0]).toMatchObject({
        agentId: 'a_product',
        instanceId: 'tmm_0000000002',
        status: 'dispatched',
      });
    });

    it('team 成员 @ 但 taskId 无实例行 → no_session 且保留 instanceId', async () => {
      allowAccess(
        channelRow({ teamId: 'tm_0000000001', taskId: 't_0000000001' } as any),
      );
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
      ]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());
      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
        mentions: [{ type: 'agent', agentId: 'a_product' }],
      } as any);
      expect(result.triggers[0]).toMatchObject({
        agentId: 'a_product',
        status: 'no_session',
      });
    });

    it('team 成员 @ 非团队内 → 400 MENTION_AGENT_NOT_IN_TEAM', async () => {
      allowAccess(channelRow({ teamId: 'tm_0000000001' } as any));
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
      ]);
      await expect(
        service.createMessage(channelId, userId, {
          text: 'hi',
          mentions: [{ type: 'agent', agentId: 'a_ghost' }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('任务分区 ta_ instanceId 未命中成员行 → 按 agentId 回退匹配（非主 Agent 可 @）', async () => {
      allowAccess(channelRow({ teamId: 'tm_0000000001', taskId: null } as any));
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_project_manager',
          alias: '项目经理-1',
          seq: 1,
        },
      ]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());
      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
        mentions: [
          {
            type: 'agent',
            agentId: 'a_project_manager',
            instanceId: 'ta_0000000002',
          },
        ],
      } as any);
      expect(result.triggers[0]).toMatchObject({
        agentId: 'a_project_manager',
        instanceId: 'tmm_0000000002',
        status: 'no_session',
      });
    });

    it('Todo5：team @ 不再读任务快照 enabled——成员直解 dispatched（快照禁用不阻塞）', async () => {
      allowAccess(channelRow({ teamId: 'tm_0000000001' } as any));
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        { id: 'tmm_1', agentId: 'a_product', alias: '产品经理-1', seq: 1 },
        { id: 'tmm_2', agentId: 'a_developer', alias: '开发者-1', seq: 1 },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_1' });
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());
      const result = await service.createMessage(channelId, userId, {
        text: 'hi',
        mentions: [{ type: 'agent', agentId: 'a_product' }],
      } as any);
      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          instanceId: 'tmm_1',
          sessionId: 's_1',
          status: 'dispatched',
        },
      ]);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [
            { agentId: 'a_product', instanceId: 'tmm_1', sessionId: 's_1' },
          ],
        }),
      );
    });

    it('findAccessibleChannels 零团队成员时返回空集（无泄漏）', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([]);
      prisma.$transaction.mockResolvedValue([0, []]);
      const result = await service.findAccessibleChannels(userId, 'team_group');
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('findAccessibleChannels teamId 不存在 → 404 TEAM_NOT_FOUND', async () => {
      (prisma as any).teamUserMember.findMany.mockResolvedValue([]);
      prisma.team.findUnique.mockResolvedValue(null as any);
      await expect(
        service.findAccessibleChannels(userId, undefined, 'tm_missing'),
      ).rejects.toThrow(NotFoundException);
    });

    it('external senderType 发消息走 team 维度鉴权分支', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(
        channelRow({ teamId: 'tm_0000000001', taskId: null } as any),
      );
      (prisma as any).team.findUnique = jest
        .fn()
        .mockResolvedValue({ id: 'tm_0000000001' } as any);
      (prisma as any).task.findUnique = jest.fn().mockResolvedValue({
        id: 't_0000000001',
        status: 'pending',
        teamId: 'tm_0000000001',
      } as any);
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([]);
      (prisma as any).teamMember.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(
        messageRow({ senderType: 'external', senderId: 'ext_1' }),
      );
      const result = await service.createMessage(
        channelId,
        userId,
        { text: 'external hi', taskId: 't_0000000001' } as any,
        { senderType: 'external', senderId: 'ext_1' },
      );
      expect(result.message.senderType).toBe('external');
    });
  });

  describe('createMessage 零任务团队 @-mention ensure（mention-target-fix）', () => {
    const teamZeroTaskRow = () =>
      channelRow({ teamId: 'tm_0000000001', taskId: null, task: null });
    const allowZeroTaskCreate = (row = teamZeroTaskRow()) => {
      prisma.chatChannel.findUnique.mockResolvedValue(row);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findFirst.mockResolvedValue(null);
      prisma.task.findUnique.mockResolvedValue(null);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
    };
    const twoMembers = () => {
      (prisma.teamMember.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'tmm_0000000008',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
        },
        {
          id: 'tmm_0000000009',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
    };
    const mockEnsure = (impl?: (...args: any[]) => Promise<unknown>) => {
      (dispatcher as any).buildTeamMemberTrigger = jest.fn().mockImplementation(
        impl ??
          (async (teamId: string, memberId: string) => ({
            agentId:
              memberId === 'tmm_0000000008' ? 'a_product' : 'a_developer',
            instanceId: memberId,
            sessionId: `s_team_${memberId.slice(4)}`,
          })),
      );
    };

    it('零任务 @agent → 会话确保后 dispatched + 真实 sessionId + 非空 targets（含 teamId 透传）', async () => {
      allowZeroTaskCreate();
      twoMembers();
      mockEnsure(async () => ({
        agentId: 'a_developer',
        instanceId: 'tmm_0000000009',
        sessionId: 's_team_0000000009',
      }));
      idGen.nextId.mockResolvedValue('m_0000000047');
      prisma.message.create.mockResolvedValue(
        messageRow({ id: 'm_0000000047' }),
      );

      const result = await service.createMessage(channelId, userId, {
        text: '@开发者-1 看看这个',
        mentions: [
          {
            type: 'agent',
            agentId: 'a_developer',
            instanceId: 'tmm_0000000009',
          },
        ],
      } as any);

      expect(result.triggers).toEqual([
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000009',
          sessionId: 's_team_0000000009',
          status: 'dispatched',
        },
      ]);
      expect((dispatcher as any).buildTeamMemberTrigger).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000009',
      );
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'tm_0000000001',
          targets: [
            {
              agentId: 'a_developer',
              instanceId: 'tmm_0000000009',
              sessionId: 's_team_0000000009',
            },
          ],
        }),
      );
    });

    it('零任务 @all → 2 成员全部 dispatched + 各自会话 + targets 非空', async () => {
      allowZeroTaskCreate();
      twoMembers();
      mockEnsure();
      idGen.nextId.mockResolvedValue('m_0000000048');
      prisma.message.create.mockResolvedValue(
        messageRow({ id: 'm_0000000048' }),
      );

      const result = await service.createMessage(channelId, userId, {
        text: '@所有人 看看',
        mentions: [{ type: 'all' }],
      } as any);

      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          instanceId: 'tmm_0000000008',
          sessionId: 's_team_0000000008',
          status: 'dispatched',
        },
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000009',
          sessionId: 's_team_0000000009',
          status: 'dispatched',
        },
      ]);
      expect((dispatcher as any).buildTeamMemberTrigger).toHaveBeenCalledTimes(
        2,
      );
      const targets = dispatcher.dispatch.mock.calls[0][0].targets;
      expect(targets).toHaveLength(2);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: expect.arrayContaining([
            expect.objectContaining({ sessionId: 's_team_0000000008' }),
            expect.objectContaining({ sessionId: 's_team_0000000009' }),
          ]),
        }),
      );
    });

    it('任务团队 @agent 仍走 task 会话路径（不调用团队 ensure，task-mode 字节一致）', async () => {
      allowAccess();
      (prisma as any).teamMember.findMany.mockResolvedValue([
        {
          id: 'ta_0000000001',
          agentId: 'a_product',
          removedAt: null,
          enabled: true,
        },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_0000000001' });
      idGen.nextId.mockResolvedValue('m_0000000049');
      prisma.message.create.mockResolvedValue(
        messageRow({ id: 'm_0000000049' }),
      );

      const result = await service.createMessage(channelId, userId, {
        text: '@产品 看看',
        mentions: [{ type: 'agent', agentId: 'a_product' }],
      } as any);

      expect(result.triggers).toEqual([
        {
          agentId: 'a_product',
          instanceId: 'ta_0000000001',
          sessionId: 's_0000000001',
          status: 'dispatched',
        },
      ]);
      expect((dispatcher as any).buildTeamMemberTrigger).toBeUndefined();
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          targets: [
            {
              agentId: 'a_product',
              instanceId: 'ta_0000000001',
              sessionId: 's_0000000001',
            },
          ],
        }),
      );
    });
  });

  describe('createMessage 团队私聊 team-mode 直聊（dm-stream-fix）', () => {
    const teamPrivateRow = () =>
      channelRow({
        type: CHANNEL_TYPE.private,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000009',
        agentId: 'a_developer',
        taskId: null,
        task: null,
      });
    const allowTeamPrivate = (row = teamPrivateRow()) => {
      prisma.chatChannel.findUnique.mockResolvedValue(row);
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findFirst.mockResolvedValue(null);
      prisma.task.findUnique.mockResolvedValue(null);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
      (prisma as any).teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_0000000009',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      (dispatcher as any).buildTeamMemberTrigger = jest.fn().mockResolvedValue({
        agentId: 'a_developer',
        instanceId: 'tmm_0000000009',
        sessionId: 's_team_0000000009',
      });
      idGen.nextId.mockResolvedValue('m_0000000050');
      prisma.message.create.mockResolvedValue(
        messageRow({ id: 'm_0000000050' }),
      );
    };

    it('私聊无 @ → 对端成员回退触发 dispatched + team-mode 分派（taskId 空 + teamId 透传）', async () => {
      allowTeamPrivate();

      const result = await service.createMessage(channelId, userId, {
        text: '你好',
        mentions: [],
      } as any);

      expect(result.triggers).toEqual([
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000009',
          sessionId: 's_team_0000000009',
          status: 'dispatched',
        },
      ]);
      expect((dispatcher as any).buildTeamMemberTrigger).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000009',
      );
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: '',
          teamId: 'tm_0000000001',
          targets: [
            {
              agentId: 'a_developer',
              instanceId: 'tmm_0000000009',
              sessionId: 's_team_0000000009',
            },
          ],
        }),
      );
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ taskId: expect.anything() }),
        }),
      );
    });

    it('团队有 currentTask 时私聊仍走 team-mode（不继承 currentTask，不走 task 快照）', async () => {
      allowTeamPrivate();
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_0000000001',
        currentTaskId: 't_0000000003',
      });
      prisma.task.findUnique.mockResolvedValue({
        id: 't_0000000003',
        status: 'pending',
        teamId: 'tm_0000000001',
        mainAgentInstanceId: null,
        mainAgentId: null,
      } as any);

      const result = await service.createMessage(channelId, userId, {
        text: '请介绍一下你自己',
        mentions: [{ type: 'agent', agentId: 'a_developer' }],
      } as any);

      expect(result.triggers).toEqual([
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000009',
          sessionId: 's_team_0000000009',
          status: 'dispatched',
        },
      ]);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: '',
          teamId: 'tm_0000000001',
          targets: [expect.objectContaining({ instanceId: 'tmm_0000000009' })],
        }),
      );
    });
  });

  describe('createMessage 群 @ DM 镜像（dm-mirror）', () => {
    const groupTeamRow = () =>
      channelRow({
        type: CHANNEL_TYPE.team_group,
        teamId: 'tm_0000000001',
        taskId: null,
        task: null,
      });
    const allowGroupTeam = () => {
      prisma.chatChannel.findUnique.mockResolvedValue(groupTeamRow());
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findFirst.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: 'tm_0000000001',
        mainAgentInstanceId: null,
        mainAgentId: null,
      } as any);
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: 'tm_0000000001',
        mainAgentInstanceId: null,
        mainAgentId: null,
      } as any);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
      (prisma as any).teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_0000000009',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_team_9' });
    };

    it('群 @agent → 私聊频道新增恰好一条逐字 user 拷贝 + 私聊 scope 广播', async () => {
      allowGroupTeam();
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      prisma.chatChannel.create.mockResolvedValue({ id: 'c_dm_9' } as any);
      idGen.nextId
        .mockResolvedValueOnce('m_0000000101')
        .mockResolvedValueOnce('c_dm_9')
        .mockResolvedValueOnce('m_0000000102');
      const groupContent = {
        text: '@开发者-1 看看这个',
        parts: [{ type: 'text', text: '@开发者-1 看看这个' }],
      };
      const groupMentions = [
        {
          type: 'agent',
          agentId: 'a_developer',
          instanceId: 'tmm_0000000009',
        },
      ];
      (prisma.message.create as jest.Mock)
        .mockImplementationOnce(async (args: any) => ({
          ...args.data,
          content: groupContent,
          mentions: groupMentions,
          createdAt: new Date('2026-08-07T00:00:00Z'),
        }))
        .mockImplementation(async (args: any) => ({
          ...args.data,
          createdAt: new Date('2026-08-07T00:00:00Z'),
        }));

      const result = await service.createMessage(channelId, userId, {
        text: '@开发者-1 看看这个',
        mentions: [
          {
            type: 'agent',
            agentId: 'a_developer',
            instanceId: 'tmm_0000000009',
          },
        ],
      } as any);

      // 群触发本身不受影响
      expect(result.triggers).toEqual([
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000009',
          sessionId: 's_team_9',
          status: 'dispatched',
        },
      ]);
      // 恰好一次镜像：群 1 + 镜像 1
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const mirrorCall = (prisma.message.create as jest.Mock).mock.calls[1][0];
      expect(mirrorCall.data.channelId).toBe('c_dm_9');
      expect(mirrorCall.data.senderType).toBe(SENDER_TYPE.user);
      expect(mirrorCall.data.senderId).toBe(userId);
      // 逐字：content 深相等（含 parts），mentions 原样
      expect(mirrorCall.data.content).toEqual(groupContent);
      expect(mirrorCall.data.mentions).toEqual(groupMentions);
      // DM 无任务分区：不带 taskId
      expect('taskId' in mirrorCall.data).toBe(false);
      expect(mirrorCall.data.status).toBe(MESSAGE_STATUS.sent);
      // 私聊频道按 POST /dm-channels 语义创建
      expect(prisma.chatChannel.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: CHANNEL_TYPE.private,
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000009',
        }),
      });
      // 私聊 scope 广播
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            channelId: 'c_dm_9',
            senderType: 'user',
          }),
        },
        { type: 'channel', id: 'c_dm_9' },
      );
    });

    it('私聊频道已存在 → 复用不创建，仍恰好镜像一条', async () => {
      allowGroupTeam();
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_dm_exist',
        type: 'private',
      } as any);
      idGen.nextId
        .mockResolvedValueOnce('m_0000000101')
        .mockResolvedValueOnce('m_0000000102');
      (prisma.message.create as jest.Mock).mockImplementation(
        async (args: any) => ({
          ...args.data,
          createdAt: new Date('2026-08-07T00:00:00Z'),
        }),
      );

      await service.createMessage(channelId, userId, {
        text: '@开发者-1 看看这个',
        mentions: [{ type: 'agent', agentId: 'a_developer' }],
      } as any);

      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const mirrorCall = (prisma.message.create as jest.Mock).mock.calls[1][0];
      expect(mirrorCall.data.channelId).toBe('c_dm_exist');
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({ channelId: 'c_dm_exist' }),
        },
        { type: 'channel', id: 'c_dm_exist' },
      );
    });

    it('@all 广播 → 不镜像（仅群消息落库广播）', async () => {
      allowGroupTeam();
      idGen.nextId.mockResolvedValue('m_0000000101');
      (prisma.message.create as jest.Mock).mockImplementation(
        async (args: any) => ({
          ...args.data,
          createdAt: new Date('2026-08-07T00:00:00Z'),
        }),
      );

      const result = await service.createMessage(channelId, userId, {
        text: '@所有人 看看',
        mentions: [{ type: 'all' }],
      } as any);

      expect(result.triggers).toHaveLength(1);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(realtime.broadcast).toHaveBeenCalledTimes(2);
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });

    it('DM 来源 → 不镜像（私聊直发无回写）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(
        channelRow({
          type: CHANNEL_TYPE.private,
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000009',
          agentId: 'a_developer',
          taskId: null,
          task: null,
        }),
      );
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findFirst.mockResolvedValue(null);
      prisma.task.findUnique.mockResolvedValue(null);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
      (prisma as any).teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_0000000009',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      (dispatcher as any).buildTeamMemberTrigger = jest.fn().mockResolvedValue({
        agentId: 'a_developer',
        instanceId: 'tmm_0000000009',
        sessionId: 's_team_9',
      });
      idGen.nextId.mockResolvedValue('m_0000000101');
      (prisma.message.create as jest.Mock).mockImplementation(
        async (args: any) => ({
          ...args.data,
          createdAt: new Date('2026-08-07T00:00:00Z'),
        }),
      );

      const result = await service.createMessage(channelId, userId, {
        text: '私聊里 @你',
        mentions: [{ type: 'agent', agentId: 'a_developer' }],
      } as any);

      expect(result.triggers[0]).toMatchObject({ status: 'dispatched' });
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });

    it('无 triggers → 不镜像（无 @ 且无主实例）', async () => {
      allowGroupTeam();
      prisma.session.findFirst.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('m_0000000101');
      (prisma.message.create as jest.Mock).mockImplementation(
        async (args: any) => ({
          ...args.data,
          createdAt: new Date('2026-08-07T00:00:00Z'),
        }),
      );

      const result = await service.createMessage(channelId, userId, {
        text: '大家好',
      } as any);

      expect(result.triggers).toEqual([]);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(realtime.broadcast).toHaveBeenCalledTimes(2);
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
    });
  });

  describe('createMessage group-send-fixes（F-A 冷启动 / F-B 归档降级）', () => {
    const groupWithTaskRow = () =>
      channelRow({
        type: CHANNEL_TYPE.team_group,
        teamId: 'tm_0000000001',
        taskId: null,
        task: null,
      });
    const allowGroupWithTask = () => {
      prisma.chatChannel.findUnique.mockResolvedValue(groupWithTaskRow());
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findFirst.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: 'tm_0000000001',
        mainAgentInstanceId: null,
        mainAgentId: null,
      } as any);
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        status: 'pending',
        teamId: 'tm_0000000001',
        mainAgentInstanceId: null,
        mainAgentId: null,
      } as any);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
      (prisma as any).teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_0000000009',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
    };

    it('F-A：有 current task 但无 team session 时 @agent 冷启动必须 dispatched（ensure 即建）', async () => {
      allowGroupWithTask();
      prisma.session.findFirst.mockResolvedValue(null);
      (dispatcher as any).buildTeamMemberTrigger = jest.fn().mockResolvedValue({
        agentId: 'a_developer',
        instanceId: 'tmm_0000000009',
        sessionId: 's_team_coldstart',
      });
      idGen.nextId.mockResolvedValue('m_0000000201');
      prisma.message.create.mockResolvedValue(messageRow({ id: 'm_0000000201' }));

      const result = await service.createMessage(channelId, userId, {
        text: '@开发者-1 冷启动',
        mentions: [
          { type: 'agent', agentId: 'a_developer', instanceId: 'tmm_0000000009' },
        ],
      } as any);

      expect(result.triggers).toEqual([
        {
          agentId: 'a_developer',
          instanceId: 'tmm_0000000009',
          sessionId: 's_team_coldstart',
          status: 'dispatched',
        },
      ]);
      expect((dispatcher as any).buildTeamMemberTrigger).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000009',
      );
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'tm_0000000001',
          targets: [
            {
              agentId: 'a_developer',
              instanceId: 'tmm_0000000009',
              sessionId: 's_team_coldstart',
            },
          ],
        }),
      );
    });

    it('F-B：team_group resolved 任务 archived 时降级团队直聊（201 + taskId 空 + teamId 透传，不 409）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(groupWithTaskRow());
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_0000000001' });
      prisma.task.findFirst.mockResolvedValue(null);
      prisma.task.findUnique.mockResolvedValue({
        id: 't_archived',
        status: 'archived',
        teamId: 'tm_0000000001',
        mainAgentInstanceId: null,
        mainAgentId: null,
      } as any);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
      (prisma as any).teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_0000000009',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_team_9' });
      idGen.nextId.mockResolvedValue('m_0000000202');
      prisma.message.create.mockResolvedValue(messageRow({ id: 'm_0000000202' }));

      const result = await service.createMessage(channelId, userId, {
        text: '@开发者-1 归档后直聊',
        mentions: [
          { type: 'agent', agentId: 'a_developer', instanceId: 'tmm_0000000009' },
        ],
      } as any);

      expect(result.triggers[0]).toMatchObject({ status: 'dispatched' });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ taskId: expect.anything() }),
        }),
      );
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: '', teamId: 'tm_0000000001' }),
      );
    });

    it('F-B：fallback 无可用任务时走团队直聊合成上下文（task.findFirst 排除 archived）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(groupWithTaskRow());
      prisma.team.findUnique
        .mockResolvedValueOnce({ id: 'tm_0000000001' })
        .mockResolvedValueOnce({ id: 'tm_0000000001', currentTaskId: null });
      prisma.task.findFirst.mockResolvedValue(null);
      prisma.task.findUnique.mockResolvedValue(null);
      (prisma as any).teamUserMember.findUnique.mockResolvedValue({
        id: 'tum_1',
      });
      (prisma as any).teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_0000000009',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
        },
      ]);
      (dispatcher as any).buildTeamMemberTrigger = jest.fn().mockResolvedValue({
        agentId: 'a_developer',
        instanceId: 'tmm_0000000009',
        sessionId: 's_team_9',
      });
      idGen.nextId.mockResolvedValue('m_0000000203');
      prisma.message.create.mockResolvedValue(messageRow({ id: 'm_0000000203' }));

      const result = await service.createMessage(channelId, userId, {
        text: '@开发者-1 无任务直聊',
        mentions: [{ type: 'agent', agentId: 'a_developer' }],
      } as any);

      expect(prisma.task.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            teamId: 'tm_0000000001',
            status: { not: 'archived' },
          }),
        }),
      );
      expect(result.triggers[0]).toMatchObject({ status: 'dispatched' });
    });
  });
});
