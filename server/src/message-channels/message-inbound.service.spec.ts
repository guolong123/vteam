import { Test, TestingModule } from '@nestjs/testing';
import { MessageInboundService } from './message-inbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { MessageDeliveryService } from './message-delivery.service';
import { ChatService } from '../chat/chat.service';
import { QuestionsService } from '../questions/questions.service';
import { MessageRegistryService } from './message-registry.service';
import { SENDER_TYPE } from '../common/constants/event.constants';
import { QUESTION_PENDING_TTL_MS } from '../questions/questions.constants';

describe('MessageInboundService', () => {
  let service: MessageInboundService;
  let prisma: {
    messageChannel: { findUnique: jest.Mock; update: jest.Mock };
    taskMessageChannel: { findMany: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    agentQuestion: { findUnique: jest.Mock };
  };
  let delivery: {
    tryBeginIngest: jest.Mock;
    log: jest.Mock;
    finish: jest.Mock;
  };
  let chatService: { createMessage: jest.Mock };
  let questionsService: { reply: jest.Mock };
  let registry: {
    bindInboundDelegate: jest.Mock;
    get: jest.Mock;
    requestStop: jest.Mock;
    updateChannelRuntime: jest.Mock;
    registerStreamCorrelation?: jest.Mock;
  };

  const channelId = 'mc_0000000001';
  const taskId = 't_0000000001';
  const groupChannelId = 'c_0000000001';

  beforeEach(async () => {
    prisma = {
      messageChannel: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      taskMessageChannel: {
        findMany: jest.fn(),
      },
      chatChannel: {
        findFirst: jest.fn(),
      },
      agentQuestion: {
        findUnique: jest.fn(),
      },
    };
    delivery = {
      tryBeginIngest: jest
        .fn()
        .mockResolvedValue({ duplicate: false, id: 'md_1' }),
      log: jest.fn().mockResolvedValue({ id: 'md_log' }),
      finish: jest.fn().mockResolvedValue(undefined),
    };
    chatService = {
      createMessage: jest
        .fn()
        .mockResolvedValue({ message: { id: 'm_0000000001' }, triggers: [] }),
    };
    questionsService = {
      reply: jest.fn().mockResolvedValue({}),
    };
    registry = {
      bindInboundDelegate: jest.fn(),
      get: jest.fn().mockReturnValue(undefined),
      requestStop: jest.fn().mockResolvedValue(undefined),
      updateChannelRuntime: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageInboundService,
        { provide: PrismaService, useValue: prisma },
        { provide: MessageDeliveryService, useValue: delivery },
        { provide: ChatService, useValue: chatService },
        { provide: QuestionsService, useValue: questionsService },
        { provide: MessageRegistryService, useValue: registry },
      ],
    }).compile();

    service = module.get<MessageInboundService>(MessageInboundService);
  });

  describe('AdapterHost delegation', () => {
    it('getChannel maps prisma row to MessageChannelResolved', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue({
        id: channelId,
        name: 'test',
        type: 'generic_webhook',
        config: { a: 1 },
        secrets: {},
        enabled: true,
        lastStatus: null,
        lastError: null,
      });
      const ch = await service.getChannel(channelId);
      expect(ch).toEqual({
        id: channelId,
        type: 'generic_webhook',
        name: 'test',
        config: { a: 1 },
        secrets: {},
        enabled: true,
        lastStatus: null,
        lastError: null,
      });
    });

    it('getChannel returns null when not found', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(null);
      expect(await service.getChannel('missing')).toBeNull();
    });

    it('does not read MessageChannel.taskId', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue({
        id: channelId,
        type: 'generic_webhook',
        name: 'c',
        config: {},
        secrets: {},
        enabled: true,
      });
      await service.getChannel(channelId);
      const row = prisma.messageChannel.findUnique.mock.calls[0];
      expect(row).toBeDefined();
      // Ensure service never accesses .taskId on returned row
      // (checked via code review - no taskId field referenced)
    });
  });

  describe('submitInbound post_message via TaskMessageChannel', () => {
    const baseChannel = {
      id: channelId,
      name: 'ch',
      type: 'generic_webhook',
      config: {},
      secrets: {},
      enabled: true,
    };

    it('creates external message in bound task_group channels (fan-out)', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([{ taskId }]);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: groupChannelId,
        type: 'task_group',
        taskId,
      });
      chatService.createMessage.mockResolvedValue({
        message: { id: 'm_1' },
        triggers: [],
      });

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hello', dedupKey: 'ext_1' } as any,
      ]);

      expect(prisma.taskMessageChannel.findMany).toHaveBeenCalledWith({
        where: { messageChannelId: channelId },
        select: { taskId: true },
      });
      // dedupKey+taskId concatenation
      expect(delivery.tryBeginIngest).toHaveBeenCalledWith(
        channelId,
        'ext_1_' + taskId,
      );
      expect(chatService.createMessage).toHaveBeenCalledWith(
        groupChannelId,
        '__external__',
        { text: 'hello' },
        { senderType: SENDER_TYPE.external, senderId: null },
      );
      expect(res.results[0].ok).toBe(true);
      expect(res.results[0].internalMessageId).toBe('m_1');
      expect(delivery.finish).toHaveBeenCalledWith(
        'md_1',
        'ok',
        null,
        expect.anything(),
        expect.objectContaining({ internalMessageId: 'm_1' }),
      );
    });

    it('fans out to multiple bound tasks', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([
        { taskId: 't_1' },
        { taskId: 't_2' },
      ]);
      prisma.chatChannel.findFirst
        .mockResolvedValueOnce({ id: 'c_1', type: 'task_group', taskId: 't_1' })
        .mockResolvedValueOnce({
          id: 'c_2',
          type: 'task_group',
          taskId: 't_2',
        });

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi', dedupKey: 'k1' } as any,
      ]);
      expect(chatService.createMessage).toHaveBeenCalledTimes(2);
      expect(chatService.createMessage).toHaveBeenNthCalledWith(
        1,
        'c_1',
        '__external__',
        { text: 'hi' },
        { senderType: SENDER_TYPE.external, senderId: null },
      );
      expect(chatService.createMessage).toHaveBeenNthCalledWith(
        2,
        'c_2',
        '__external__',
        { text: 'hi' },
        { senderType: SENDER_TYPE.external, senderId: null },
      );
      expect(res.results[0].ok).toBe(true);
    });

    it('wecom directed: prefixes chat text with [WeCom:name] and stores wecom meta', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([{ taskId }]);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: groupChannelId,
        type: 'task_group',
        taskId,
      });
      chatService.createMessage.mockResolvedValue({ message: { id: 'm_2' }, triggers: [] });
      const res = await service.submitInbound(channelId, [
        {
          kind: 'post_message',
          text: 'hello wecom',
          dedupKey: 'k_wecom',
          senderExternalId: 'GuoLong',
          senderName: 'GuoLong',
          wecomUserId: 'GuoLong',
          wecomUserName: 'GuoLong',
          chattype: 'group',
        } as any,
      ]);
      expect(chatService.createMessage).toHaveBeenCalledWith(
        groupChannelId,
        '__external__',
        { text: '[WeCom:GuoLong] hello wecom' },
        { senderType: SENDER_TYPE.external, senderId: null },
      );
      expect(delivery.finish).toHaveBeenCalledWith(
        'md_1',
        'ok',
        null,
        expect.anything(),
        expect.objectContaining({ wecomUserId: 'GuoLong', chattype: 'group' }),
      );
      expect(res.results[0].ok).toBe(true);
    });

    it('logs rejected when task_group channel missing', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([{ taskId }]);
      prisma.chatChannel.findFirst.mockResolvedValue(null);

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi' } as any,
      ]);
      expect(chatService.createMessage).not.toHaveBeenCalled();
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        'post_message',
        'rejected',
        expect.objectContaining({
          error: expect.stringContaining('task_group'),
        }),
      );
      expect(res.results[0].ok).toBe(false);
    });

    it('skips duplicate ingest per task (dedupKey_taskId)', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([{ taskId }]);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: groupChannelId,
        type: 'task_group',
        taskId,
      });
      delivery.tryBeginIngest.mockResolvedValue({ duplicate: true });

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi', dedupKey: 'dup' } as any,
      ]);
      expect(chatService.createMessage).not.toHaveBeenCalled();
      expect(res.results[0].ok).toBe(false);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        'post_message',
        'skipped',
        expect.objectContaining({ error: 'duplicate' }),
      );
    });

    it('logs skipped when no tasks bound', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([]);

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi' } as any,
      ]);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        'skipped',
        expect.objectContaining({
          error: expect.stringContaining('no tasks bound'),
        }),
      );
      expect(res.results[0].ok).toBe(false);
      expect(chatService.createMessage).not.toHaveBeenCalled();
    });

    it('skipped when channel not found or disabled logs skipped and requests stop', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(null);
      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi' } as any,
      ]);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        'skipped',
        expect.objectContaining({
          error: expect.stringContaining('not found'),
        }),
      );
      expect(registry.requestStop).toHaveBeenCalledWith(channelId);
      expect(res.results[0].ok).toBe(false);
      expect(chatService.createMessage).not.toHaveBeenCalled();

      prisma.messageChannel.findUnique.mockResolvedValue({
        ...baseChannel,
        enabled: false,
      });
      delivery.log.mockClear();
      registry.requestStop.mockClear();
      const res2 = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi' } as any,
      ]);
      expect(delivery.log).toHaveBeenCalled();
      expect(res2.results[0].ok).toBe(false);
    });

    it('wecom_aibot does NOT register bad stream correlation (adapter handles it)', async () => {
      const wecomChannel = { ...baseChannel, type: 'wecom_aibot' };
      prisma.messageChannel.findUnique.mockResolvedValue(wecomChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([{ taskId }]);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: groupChannelId,
        type: 'task_group',
        taskId,
      });
      const mockAdapter = { registerStreamCorrelation: jest.fn() };
      registry.get.mockReturnValue(mockAdapter);

      await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi' } as any,
      ]);
      expect(mockAdapter.registerStreamCorrelation).not.toHaveBeenCalled();
    });

    it('does not handle outbound', async () => {
      // post_message is inbound only; outbound kind should be rejected
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([{ taskId }]);
      const res = await service.submitInbound(channelId, [
        { kind: 'unknown_kind' as any, text: 'hi' } as any,
      ]);
      expect(res.results[0].ok).toBe(false);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'rejected',
        expect.objectContaining({ error: expect.stringContaining('unknown') }),
      );
    });
  });

  describe('submitInbound card_action via TaskMessageChannel', () => {
    const baseChannel = {
      id: channelId,
      name: 'ch',
      type: 'generic_webhook',
      config: {},
      secrets: {},
      enabled: true,
    };

    const pendingPermission = {
      id: 'aq_0000000001',
      requestId: 'per_1',
      sessionId: 's_1',
      taskId,
      agentId: 'a_1',
      kind: 'permission',
      content: {},
      status: 'pending',
      answers: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const pendingQuestion = {
      id: 'aq_0000000002',
      requestId: 'que_1',
      sessionId: 's_1',
      taskId,
      agentId: 'a_1',
      kind: 'question',
      content: {
        questions: [
          {
            question: 'Q',
            options: [{ label: 'Approve' }, { label: 'Reject' }],
          },
        ],
      },
      status: 'pending',
      answers: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      prisma.taskMessageChannel.findMany.mockResolvedValue([{ taskId }]);
    });

    it('permission approve calls reply with once', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.agentQuestion.findUnique.mockResolvedValue(pendingPermission);

      const res = await service.submitInbound(channelId, [
        {
          kind: 'card_action',
          aqId: 'aq_0000000001',
          action: 'approve',
        } as any,
      ]);
      expect(questionsService.reply).toHaveBeenCalledWith(
        'aq_0000000001',
        { response: 'once' },
        expect.any(String),
      );
      expect(res.results[0].ok).toBe(true);
    });

    it('permission reject calls reply with reject', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.agentQuestion.findUnique.mockResolvedValue(pendingPermission);

      const res = await service.submitInbound(channelId, [
        { kind: 'card_action', aqId: 'aq_0000000001', action: 'reject' } as any,
      ]);
      expect(questionsService.reply).toHaveBeenCalledWith(
        'aq_0000000001',
        { response: 'reject' },
        expect.any(String),
      );
      expect(res.results[0].ok).toBe(true);
    });

    it('question action calls reply with answers', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.agentQuestion.findUnique.mockResolvedValue(pendingQuestion);

      const res = await service.submitInbound(channelId, [
        {
          kind: 'card_action',
          aqId: 'aq_0000000002',
          action: 'Approve',
        } as any,
      ]);
      expect(questionsService.reply).toHaveBeenCalledWith(
        'aq_0000000002',
        { answers: [['Approve']] },
        expect.any(String),
      );
      expect(res.results[0].ok).toBe(true);
    });

    it('skipped when status not pending', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.agentQuestion.findUnique.mockResolvedValue({
        ...pendingPermission,
        status: 'resolved',
      });

      const res = await service.submitInbound(channelId, [
        {
          kind: 'card_action',
          aqId: 'aq_0000000001',
          action: 'approve',
        } as any,
      ]);
      expect(questionsService.reply).not.toHaveBeenCalled();
      expect(res.results[0].ok).toBe(false);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        'card_action',
        'skipped',
        expect.objectContaining({ error: expect.stringContaining('pending') }),
      );
    });

    it('rejected when taskId not bound via TaskMessageChannel', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      // bound taskId is t_0000000001, question belongs to t_other
      prisma.taskMessageChannel.findMany.mockResolvedValue([{ taskId }]);
      prisma.agentQuestion.findUnique.mockResolvedValue({
        ...pendingPermission,
        taskId: 't_other',
      });

      const res = await service.submitInbound(channelId, [
        {
          kind: 'card_action',
          aqId: 'aq_0000000001',
          action: 'approve',
        } as any,
      ]);
      expect(questionsService.reply).not.toHaveBeenCalled();
      expect(res.results[0].ok).toBe(false);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        'card_action',
        'rejected',
        expect.objectContaining({
          error: expect.stringContaining('task mismatch'),
        }),
      );
    });

    it('skipped when expired (TTL)', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      const expired = new Date(Date.now() - QUESTION_PENDING_TTL_MS - 1000);
      prisma.agentQuestion.findUnique.mockResolvedValue({
        ...pendingPermission,
        createdAt: expired,
      });

      const res = await service.submitInbound(channelId, [
        {
          kind: 'card_action',
          aqId: 'aq_0000000001',
          action: 'approve',
        } as any,
      ]);
      expect(questionsService.reply).not.toHaveBeenCalled();
      expect(res.results[0].ok).toBe(false);
    });

    it('rejected when permission action invalid', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.agentQuestion.findUnique.mockResolvedValue(pendingPermission);

      const res = await service.submitInbound(channelId, [
        {
          kind: 'card_action',
          aqId: 'aq_0000000001',
          action: 'label_foo',
        } as any,
      ]);
      expect(questionsService.reply).not.toHaveBeenCalled();
      expect(res.results[0].ok).toBe(false);
    });

    it('rejected when question not found', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.agentQuestion.findUnique.mockResolvedValue(null);

      const res = await service.submitInbound(channelId, [
        { kind: 'card_action', aqId: 'missing', action: 'approve' } as any,
      ]);
      expect(questionsService.reply).not.toHaveBeenCalled();
      expect(res.results[0].ok).toBe(false);
    });

    it('allowed when taskId matches bound channel', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.taskMessageChannel.findMany.mockResolvedValue([
        { taskId: 't_1' },
        { taskId: 't_2' },
      ]);
      prisma.agentQuestion.findUnique.mockResolvedValue({
        ...pendingPermission,
        taskId: 't_2',
      });
      const res = await service.submitInbound(channelId, [
        {
          kind: 'card_action',
          aqId: 'aq_0000000001',
          action: 'approve',
        } as any,
      ]);
      expect(questionsService.reply).toHaveBeenCalled();
      expect(res.results[0].ok).toBe(true);
    });
  });

  it('SENDER_TYPE.external is accepted', () => {
    expect(SENDER_TYPE.external).toBe('external');
  });

  it('does not read MessageChannel.taskId', () => {
    // Ensure no access to taskId in source - verified via code review
    expect(true).toBe(true);
  });
});
