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
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CHAT_ERRORS } from './chat.constants';
import { ChatService } from './chat.service';
import { MessageDispatcher } from './message-dispatcher';

describe('ChatService', () => {
  let service: ChatService;
  let prisma: {
    chatChannel: { findUnique: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock; count: jest.Mock; create: jest.Mock; update: jest.Mock };
    message: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock };
    task: { findUnique: jest.Mock };
    projectMember: { findMany: jest.Mock; findUnique: jest.Mock };
    taskAgent: { findMany: jest.Mock; findFirst: jest.Mock };
    session: { findFirst: jest.Mock };
    agent: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let dispatcher: {
    dispatch: jest.Mock;
    onLoading: jest.Mock;
    onFinal: jest.Mock;
    onError: jest.Mock;
  };

  const userId = 'u_admin';
  const channelId = 'c_0000000001';
  const taskId = 't_0000000001';

  const channelRow = (overrides: Record<string, unknown> = {}) => ({
    id: channelId,
    type: CHANNEL_TYPE.task_group,
    taskId,
    agentId: null,
    pinned: false,
    lastReadAt: null,
    deletedAt: null,
    createdAt: new Date('2026-08-07T00:00:00Z'),
    task: { id: taskId, title: '任务标题', status: 'pending', projectId: 'p_seed_1' },
    agent: null,
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

  /** 授权通过：频道存在 + 调用者为项目成员。 */
  const allowAccess = (row = channelRow()) => {
    prisma.chatChannel.findUnique.mockResolvedValue(row);
    prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
  };

  beforeEach(async () => {
    prisma = {
      chatChannel: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      message: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
      task: { findUnique: jest.fn() },
      projectMember: { findMany: jest.fn(), findUnique: jest.fn() },
      taskAgent: { findMany: jest.fn(), findFirst: jest.fn() },
      session: { findFirst: jest.fn() },
      agent: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    idGen = { nextId: jest.fn(), seed: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
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
      prisma.taskAgent.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_0000000001' });
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());
      dispatcher.dispatch.mockResolvedValue({
        replies: [{ agentId: 'a_product', text: '需求已明确' }],
      });

      const dto = { text: '你好', mentions: [{ type: 'agent', agentId: 'a_product' }] };
      const result = await service.createMessage(channelId, userId, dto as any);

      // 3. 落库：仅用户消息（agent 回复由分派器异步落库，此处不重复）
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          id: 'm_0000000001',
          channelId,
          senderType: SENDER_TYPE.user,
          senderId: userId,
          content: { text: '你好', parts: [] },
          mentions: [{ type: 'agent', agentId: 'a_product' }],
          status: MESSAGE_STATUS.sent,
        },
      });

      // 4. 仅广播用户消息（loading/回复由分派器广播）
      expect(realtime.broadcast).toHaveBeenCalledTimes(1);
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ id: 'm_0000000001', senderType: 'user' }) },
        { type: 'channel', id: channelId },
      );

      // 5. 分派受理：dispatched 目标下发（fire-and-forget，不阻塞 201 响应）
      expect(dispatcher.dispatch).toHaveBeenCalledWith({
        messageId: 'm_0000000001',
        channelId,
        taskId,
        text: '你好',
        targets: [{ agentId: 'a_product', sessionId: 's_0000000001' }],
      });

      // 响应契约：{message, triggers}
      expect(result.message).toMatchObject({ id: 'm_0000000001', channelId, senderType: 'user' });
      expect(result.triggers).toEqual([
        { agentId: 'a_product', sessionId: 's_0000000001', status: 'dispatched' },
      ]);
    });

    it('无 mentions：triggers 为空、dispatcher 空目标、仅广播用户消息', async () => {
      allowAccess();
      prisma.taskAgent.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, { text: '无 @' } as any);

      expect(result.triggers).toEqual([]);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ targets: [] }),
      );
      expect(realtime.broadcast).toHaveBeenCalledTimes(1);
    });

    it('UX-10 带附件：attachmentUrl/Name/Type 落库 + 响应透出（分发/广播不受影响）', async () => {
      allowAccess();
      prisma.taskAgent.findMany.mockResolvedValue([]);
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
      prisma.taskAgent.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('m_0000000001');
      prisma.message.create.mockResolvedValue(messageRow());

      const result = await service.createMessage(channelId, userId, { text: '纯文字' } as any);

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

    it('归档任务频道发消息 → 409 TASK_ARCHIVED（不落库不广播）', async () => {
      allowAccess(channelRow({ task: { id: taskId, title: 'x', status: 'archived', projectId: 'p_seed_1' } }));

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

    it('非项目成员 → 403 PERMISSION_PROJECT_NOT_MEMBER', async () => {
      allowAccess();
      prisma.projectMember.findUnique.mockResolvedValue(null);

      await expect(
        service.createMessage(channelId, userId, { text: 'hi' } as any),
      ).rejects.toThrow(ForbiddenException);
      try {
        await service.createMessage(channelId, userId, { text: 'hi' } as any);
        fail('应抛出 ForbiddenException');
      } catch (e) {
        expect((e as ForbiddenException).getResponse()).toMatchObject({
          code: 'PERMISSION_PROJECT_NOT_MEMBER',
        });
      }
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('@ 解析（resolveMentions）', () => {
    it('agent 型团队内未移除 + 有会话 → dispatched', async () => {
      allowAccess();
      prisma.taskAgent.findMany.mockResolvedValue([
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
      prisma.taskAgent.findMany.mockResolvedValue([
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
      prisma.taskAgent.findMany.mockResolvedValue([]);
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
      prisma.taskAgent.findMany.mockResolvedValue([
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
      prisma.taskAgent.findMany.mockResolvedValue([]);

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
      prisma.taskAgent.findMany.mockResolvedValue([]);

      await expect(
        service.createMessage(channelId, userId, {
          text: 'hi',
          mentions: [{ type: 'agent' }],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findMessages（游标分页）', () => {
    it('首页（无 cursor）：id 升序取 limit+1 判末页，nextCursor=第 limit 条 id', async () => {
      allowAccess();
      prisma.message.findMany.mockResolvedValue(genMessages(51));

      const result = await service.findMessages(channelId, userId, {} as any);

      // 查询契约：idx_messages_channel_id 命中（channelId + id>cursor ORDER BY id ASC）
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId },
        orderBy: { id: 'asc' },
        take: 51, // limit(50) + 1 判末页
      });
      expect(result.items).toHaveLength(50);
      expect(result.items[0].id).toBe('m_0000000001');
      expect(result.items[49].id).toBe('m_0000000050');
      expect(result.nextCursor).toBe('m_0000000050');
    });

    it('limit 默认 50、上限 100', async () => {
      allowAccess();
      prisma.message.findMany.mockResolvedValue([]);

      await service.findMessages(channelId, userId, {} as any);
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 51 }),
      );

      prisma.message.findMany.mockResolvedValue(genMessages(101));
      await service.findMessages(channelId, userId, { limit: 200 } as any);
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 101 }),
      );
    });

    it('cursor 传入 → WHERE id > cursor（翻页续拉）', async () => {
      allowAccess();
      prisma.message.findMany.mockResolvedValue(genMessages(3));

      const result = await service.findMessages(channelId, userId, {
        cursor: 'm_0000000050',
      } as any);

      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId, id: { gt: 'm_0000000050' } },
        orderBy: { id: 'asc' },
        take: 51,
      });
      // 首页 nextCursor 续传即下一页起始游标 → 无重复无遗漏
      expect(result.items.map((m) => m.id)).toEqual([
        'm_0000000001',
        'm_0000000002',
        'm_0000000003',
      ]);
    });

    it('末页/空历史 → nextCursor null', async () => {
      allowAccess();
      prisma.message.findMany.mockResolvedValue(genMessages(3));

      const result = await service.findMessages(channelId, userId, {} as any);
      expect(result.items).toHaveLength(3);
      expect(result.nextCursor).toBeNull();

      prisma.message.findMany.mockResolvedValue([]);
      const empty = await service.findMessages(channelId, userId, {} as any);
      expect(empty.items).toEqual([]);
      expect(empty.nextCursor).toBeNull();
    });
  });

  describe('getTriggerResults（@ 触发结果轮询）', () => {
    const triggerMessage = (overrides: Record<string, unknown> = {}) =>
      messageRow({
        mentions: [{ type: 'agent', agentId: 'a_product' }],
        ...overrides,
      });

    it('dispatched + 有回复：返回 {agentId, status:dispatched, replyMessageId}', async () => {
      allowAccess();
      prisma.message.findUnique.mockResolvedValue(triggerMessage());
      prisma.taskAgent.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue({ id: 's_1' });
      prisma.message.findFirst.mockResolvedValue({ id: 'm_0000000002' });

      const result = await service.getTriggerResults(channelId, userId, 'm_0000000001');

      expect(result.triggers).toEqual([
        { agentId: 'a_product', status: 'dispatched', replyMessageId: 'm_0000000002' },
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
      allowAccess();
      prisma.message.findUnique.mockResolvedValue(triggerMessage());
      prisma.taskAgent.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
      ]);
      prisma.session.findFirst.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue(null);

      const result = await service.getTriggerResults(channelId, userId, 'm_0000000001');

      expect(result.triggers).toEqual([
        { agentId: 'a_product', status: 'no_session' },
      ]);
      expect(result.triggers[0]).not.toHaveProperty('replyMessageId');
    });

    it('agent_removed：已移除 → status agent_removed、不查会话', async () => {
      allowAccess();
      prisma.message.findUnique.mockResolvedValue(triggerMessage());
      prisma.taskAgent.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: new Date('2026-08-01T00:00:00Z') },
      ]);

      const result = await service.getTriggerResults(channelId, userId, 'm_0000000001');

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
      expect(prisma.taskAgent.findMany).not.toHaveBeenCalled();
    });

    it('用户消息无 mentions → 返回空 triggers（不查团队不查回复）', async () => {
      allowAccess();
      prisma.message.findUnique.mockResolvedValue(triggerMessage({ mentions: null }));

      const result = await service.getTriggerResults(channelId, userId, 'm_0000000001');

      expect(result.triggers).toEqual([]);
      expect(prisma.taskAgent.findMany).not.toHaveBeenCalled();
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
    });

    it('{type:all} mentions → 展开为团队全部未移除 Agent', async () => {
      allowAccess();
      prisma.message.findUnique.mockResolvedValue(
        triggerMessage({ mentions: [{ type: 'all' }] }),
      );
      prisma.taskAgent.findMany.mockResolvedValue([
        { agentId: 'a_product', removedAt: null },
        { agentId: 'a_developer', removedAt: null },
        { agentId: 'a_removed', removedAt: new Date('2026-08-01T00:00:00Z') },
      ]);
      prisma.session.findFirst
        .mockResolvedValueOnce({ id: 's_1' })
        .mockResolvedValueOnce({ id: 's_2' });
      prisma.message.findFirst.mockResolvedValue(null);

      const result = await service.getTriggerResults(channelId, userId, 'm_0000000001');

      // 未移除 2 个展开；已移除 a_removed 不出现
      expect(result.triggers).toEqual([
        { agentId: 'a_product', status: 'dispatched' },
        { agentId: 'a_developer', status: 'dispatched' },
      ]);
    });
  });

  describe('findAccessibleChannels（频道列表）', () => {
    it('仅返回调用者已加入项目的频道，{items,total} + type 过滤透传', async () => {
      prisma.projectMember.findMany.mockResolvedValue([
        { projectId: 'p_seed_1' },
        { projectId: 'p_seed_2' },
      ]);
      prisma.$transaction.mockResolvedValue([
        1,
        [channelRow(), channelRow({ id: 'c_2', type: 'private', agentId: 'a_product' })],
      ]);

      const result = await service.findAccessibleChannels(userId, 'task_group');

      expect(prisma.projectMember.findMany).toHaveBeenCalledWith({
        where: { userId },
        select: { projectId: true },
      });
      expect(prisma.chatChannel.findMany).toHaveBeenCalledWith({
        where: {
          task: { projectId: { in: ['p_seed_1', 'p_seed_2'] } },
          // UX-09：已删除会话隐藏
          deletedAt: null,
          type: 'task_group',
        },
        include: expect.anything(),
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: channelId,
        type: 'task_group',
        taskId,
        task: { id: taskId, projectId: 'p_seed_1' },
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
  });

  describe('findOne（频道详情）', () => {
    it('返回频道信息 + 成员 Agent（团队未 removed）', async () => {
      allowAccess();
      prisma.taskAgent.findMany.mockResolvedValue([
        {
          agentId: 'a_product',
          removedAt: null,
          agent: { id: 'a_product', name: '产品经理', role: 'product' },
        },
      ]);

      const result = await service.findOne(channelId, userId);

      expect(result).toMatchObject({
        id: channelId,
        type: 'task_group',
        taskId,
        agentMembers: [{ id: 'a_product', name: '产品经理', role: 'product' }],
      });
      expect(prisma.taskAgent.findMany).toHaveBeenCalledWith({
        where: { taskId, removedAt: null },
        select: expect.anything(),
      });
    });
  });

  describe('createDmChannel（私聊频道）', () => {
    it('正常创建 private 频道（task_id+agent_id，type=private）', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_seed_1' });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product' });
      prisma.chatChannel.findUnique.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('c_0000000001');
      prisma.chatChannel.create.mockResolvedValue(
        channelRow({ id: 'c_0000000001', type: 'private', agentId: 'a_product' }),
      );

      const result = await service.createDmChannel(userId, {
        taskId,
        agentId: 'a_product',
      });

      expect(prisma.chatChannel.create).toHaveBeenCalledWith({
        data: {
          id: 'c_0000000001',
          type: 'private',
          taskId,
          agentId: 'a_product',
        },
        include: expect.anything(),
      });
      expect(result).toMatchObject({
        id: 'c_0000000001',
        type: 'private',
        taskId,
        agentId: 'a_product',
      });
    });

    it('uk_channels_task_agent 已存在 → 幂等返回已有频道（不重复创建）', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_seed_1' });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product' });
      prisma.chatChannel.findUnique.mockResolvedValue(
        channelRow({ type: 'private', agentId: 'a_product' }),
      );

      const result = await service.createDmChannel(userId, {
        taskId,
        agentId: 'a_product',
      });

      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: channelId, type: 'private' });
    });

    it('已 soft delete 的私聊频道 → 复活（deletedAt 置空，复用原记录）', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_seed_1' });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product' });
      prisma.chatChannel.findUnique.mockResolvedValue(
        channelRow({ type: 'private', agentId: 'a_product', deletedAt: new Date('2026-08-08T00:00:00Z') }),
      );
      prisma.chatChannel.update.mockResolvedValue(
        channelRow({ type: 'private', agentId: 'a_product' }),
      );

      const result = await service.createDmChannel(userId, {
        taskId,
        agentId: 'a_product',
      });

      expect(prisma.chatChannel.update).toHaveBeenCalledWith({
        where: { id: channelId },
        data: { deletedAt: null },
        include: expect.anything(),
      });
      expect(prisma.chatChannel.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: channelId, type: 'private' });
    });

    it('任务不存在 → 404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.createDmChannel(userId, { taskId, agentId: 'a_product' }),
      ).rejects.toThrow(NotFoundException);
      try {
        await service.createDmChannel(userId, { taskId, agentId: 'a_product' });
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.TASK_NOT_FOUND,
        });
      }
    });

    it('非项目成员 → 403', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_seed_1' });
      prisma.projectMember.findUnique.mockResolvedValue(null);

      await expect(
        service.createDmChannel(userId, { taskId, agentId: 'a_product' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Agent 不存在 → 404 AGENT_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue({ projectId: 'p_seed_1' });
      prisma.projectMember.findUnique.mockResolvedValue({ id: 'pm_1' });
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(
        service.createDmChannel(userId, { taskId, agentId: 'a_ghost' }),
      ).rejects.toThrow(NotFoundException);
      try {
        await service.createDmChannel(userId, { taskId, agentId: 'a_ghost' });
        fail('应抛出 NotFoundException');
      } catch (e) {
        expect((e as NotFoundException).getResponse()).toMatchObject({
          code: CHAT_ERRORS.AGENT_NOT_FOUND,
        });
      }
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

      await expect(
        service.removeChannel(channelId, userId),
      ).rejects.toThrow(NotFoundException);
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

    it('非项目成员 → 403 PERMISSION_PROJECT_NOT_MEMBER（不执行删除）', async () => {
      allowAccess();
      prisma.projectMember.findUnique.mockResolvedValue(null);

      await expect(
        service.removeChannel(channelId, userId),
      ).rejects.toThrow(ForbiddenException);
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
      prisma.chatChannel.update.mockResolvedValue(channelRow({ pinned: false }));

      const result = await service.updateChannelPinned(channelId, userId, false);

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
      prisma.chatChannel.update.mockResolvedValue({ id: channelId, lastReadAt });

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

      await expect(
        service.markChannelRead(channelId, userId),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.chatChannel.update).not.toHaveBeenCalled();
    });
  });
});
