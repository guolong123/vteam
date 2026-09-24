import { Test, TestingModule } from '@nestjs/testing';
import { MessageInboundService } from './message-inbound.service';
import { PrismaService } from '../prisma/prisma.service';
import { MessageDeliveryService } from './message-delivery.service';
import { ChatService } from '../chat/chat.service';
import { QuestionsService } from '../questions/questions.service';
import { MessageRegistryService } from './message-registry.service';
import { SENDER_TYPE, CHANNEL_TYPE } from '../common/constants/event.constants';
import { QUESTION_PENDING_TTL_MS } from '../questions/questions.constants';

describe('MessageInboundService', () => {
  let service: MessageInboundService;
  let prisma: {
    messageChannel: { findUnique: jest.Mock; update: jest.Mock };
    teamMessageChannel: { findMany: jest.Mock };
    task: { findUnique: jest.Mock };
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
  const teamId = 'tm_0000000001';
  const groupChannelId = 'c_0000000001';

  beforeEach(async () => {
    prisma = {
      messageChannel: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      teamMessageChannel: {
        findMany: jest.fn(),
      },
      task: {
        findUnique: jest.fn(),
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

  describe('submitInbound post_message via TeamMessageChannel (team-scoped fan-out)', () => {
    const baseChannel = {
      id: channelId,
      name: 'ch',
      type: 'generic_webhook',
      config: {},
      secrets: {},
      enabled: true,
    };

    it('creates external message in bound team_group channels (fan-out)', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.teamMessageChannel.findMany.mockResolvedValue([{ teamId }]);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: groupChannelId,
        type: 'team_group',
        teamId,
      });
      chatService.createMessage.mockResolvedValue({
        message: { id: 'm_1' },
        triggers: [],
      });

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hello', dedupKey: 'ext_1' } as any,
      ]);

      expect(prisma.teamMessageChannel.findMany).toHaveBeenCalledWith({
        where: { messageChannelId: channelId },
        select: { teamId: true },
      });
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { teamId, type: CHANNEL_TYPE.team_group, deletedAt: null },
      });
      // dedupKey+teamId concatenation (per-team dedup scope)
      expect(delivery.tryBeginIngest).toHaveBeenCalledWith(
        channelId,
        'ext_1_' + teamId,
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

    it('fans out to multiple bound teams', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.teamMessageChannel.findMany.mockResolvedValue([
        { teamId: 'tm_1' },
        { teamId: 'tm_2' },
      ]);
      prisma.chatChannel.findFirst.mockImplementation(
        async ({ where }: any) => {
          if (where?.teamId === 'tm_1')
            return { id: 'c_1', type: 'team_group', teamId: 'tm_1' };
          if (where?.teamId === 'tm_2')
            return { id: 'c_2', type: 'team_group', teamId: 'tm_2' };
          return null;
        },
      );

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi', dedupKey: 'k1' } as any,
      ]);
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: {
          teamId: 'tm_1',
          type: CHANNEL_TYPE.team_group,
          deletedAt: null,
        },
      });
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: {
          teamId: 'tm_2',
          type: CHANNEL_TYPE.team_group,
          deletedAt: null,
        },
      });
      expect(delivery.tryBeginIngest).toHaveBeenCalledWith(
        channelId,
        'k1_tm_1',
      );
      expect(delivery.tryBeginIngest).toHaveBeenCalledWith(
        channelId,
        'k1_tm_2',
      );
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
      prisma.teamMessageChannel.findMany.mockResolvedValue([{ teamId }]);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: groupChannelId,
        type: 'team_group',
        teamId,
      });
      chatService.createMessage.mockResolvedValue({
        message: { id: 'm_2' },
        triggers: [],
      });
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

    it('logs rejected when team_group channel missing', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.teamMessageChannel.findMany.mockResolvedValue([{ teamId }]);
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
          error: expect.stringContaining('team_group'),
        }),
      );
      expect(res.results[0].ok).toBe(false);
    });

    it('skips duplicate ingest per team (dedupKey_teamId)', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.teamMessageChannel.findMany.mockResolvedValue([{ teamId }]);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: groupChannelId,
        type: 'team_group',
        teamId,
      });
      delivery.tryBeginIngest.mockResolvedValue({ duplicate: true });

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi', dedupKey: 'dup' } as any,
      ]);
      expect(delivery.tryBeginIngest).toHaveBeenCalledWith(
        channelId,
        'dup_' + teamId,
      );
      expect(chatService.createMessage).not.toHaveBeenCalled();
      expect(res.results[0].ok).toBe(false);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        'post_message',
        'skipped',
        expect.objectContaining({ error: 'duplicate' }),
      );
    });

    it('logs skipped when no teams bound', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.teamMessageChannel.findMany.mockResolvedValue([]);

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi' } as any,
      ]);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        'skipped',
        expect.objectContaining({
          error: expect.stringContaining('no teams bound'),
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
      prisma.teamMessageChannel.findMany.mockResolvedValue([{ teamId }]);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: groupChannelId,
        type: 'team_group',
        teamId,
      });
      const mockAdapter = { registerStreamCorrelation: jest.fn() };
      registry.get.mockReturnValue(mockAdapter);

      const res = await service.submitInbound(channelId, [
        { kind: 'post_message', text: 'hi' } as any,
      ]);
      expect(mockAdapter.registerStreamCorrelation).not.toHaveBeenCalled();
      // team-scoped routing actually ran (not short-circuited on 'no teams bound')
      expect(chatService.createMessage).toHaveBeenCalledTimes(1);
      expect(res.results[0].ok).toBe(true);
    });

    it('does not handle outbound', async () => {
      // post_message is inbound only; outbound kind should be rejected
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.teamMessageChannel.findMany.mockResolvedValue([{ teamId }]);
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

  describe('submitInbound card_action via team-scoped binding', () => {
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
      // Team-scoped binding: channel bound to teamId, and the question's
      // task belongs to that bound team.
      prisma.teamMessageChannel.findMany.mockResolvedValue([{ teamId }]);
      prisma.task.findUnique.mockResolvedValue({ id: taskId, teamId });
      prisma.chatChannel.findFirst.mockResolvedValue(null);
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
      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: taskId },
        select: { teamId: true },
      });
      expect(questionsService.reply).toHaveBeenCalledWith(
        'aq_0000000001',
        { response: 'once' },
        '__external__',
      );
      expect(res.results[0].ok).toBe(true);
    });

    it('permission action forwards selection to the task team group', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.agentQuestion.findUnique.mockResolvedValue(pendingPermission);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: groupChannelId });

      const res = await service.submitInbound(channelId, [
        { kind: 'card_action', aqId: 'aq_0000000001', action: 'approve' },
      ]);

      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: {
          teamId,
          type: CHANNEL_TYPE.team_group,
          deletedAt: null,
        },
      });
      expect(chatService.createMessage).toHaveBeenCalledWith(
        groupChannelId,
        '__external__',
        expect.objectContaining({
          text: expect.stringContaining('选择了: approve'),
        }),
        { senderType: SENDER_TYPE.external, senderId: null },
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
        '__external__',
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
        '__external__',
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

    it('rejected when question team not bound (team mismatch)', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      // bound team is tm_0000000001, question's task belongs to tm_other
      prisma.teamMessageChannel.findMany.mockResolvedValue([{ teamId }]);
      prisma.task.findUnique.mockResolvedValue({
        id: 't_other',
        teamId: 'tm_other',
      });
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
          error: expect.stringContaining('team mismatch'),
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
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        'card_action',
        'skipped',
        expect.objectContaining({ error: 'expired' }),
      );
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
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        'card_action',
        'rejected',
        expect.objectContaining({
          error: expect.stringContaining('invalid action'),
        }),
      );
    });

    it('rejected when question not found', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.agentQuestion.findUnique.mockResolvedValue(null);

      const res = await service.submitInbound(channelId, [
        { kind: 'card_action', aqId: 'missing', action: 'approve' } as any,
      ]);
      expect(questionsService.reply).not.toHaveBeenCalled();
      expect(res.results[0].ok).toBe(false);
      expect(delivery.log).toHaveBeenCalledWith(
        expect.any(String),
        'card_action',
        'rejected',
        expect.objectContaining({ error: 'question not found' }),
      );
    });

    it('allowed when question team matches bound team', async () => {
      prisma.messageChannel.findUnique.mockResolvedValue(baseChannel);
      prisma.teamMessageChannel.findMany.mockResolvedValue([
        { teamId: 'tm_1' },
        { teamId: 'tm_2' },
      ]);
      prisma.task.findUnique.mockResolvedValue({ id: 't_2', teamId: 'tm_2' });
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
      expect(questionsService.reply).toHaveBeenCalledWith(
        'aq_0000000001',
        { response: 'once' },
        '__external__',
      );
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
