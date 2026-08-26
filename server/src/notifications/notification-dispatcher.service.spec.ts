import { Test, TestingModule } from '@nestjs/testing';
import {
  NotificationDispatcherService,
  formatTaskStatusMarkdown,
} from './notification-dispatcher.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationRegistryService } from './notification-registry.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { NOTIFICATION_EVENTS } from './notification.constants';

describe('NotificationDispatcherService', () => {
  let service: NotificationDispatcherService;
  let realtime: {
    subscribe: jest.Mock;
    busListener: ((e: any) => void) | null;
    disposer: jest.Mock;
  };
  let prisma: {
    taskNotificationChannel: { findMany: jest.Mock };
    notificationChannel: { findMany: jest.Mock };
    task: { findUnique: jest.Mock };
    chatChannel: { findUnique: jest.Mock };
  };
  let registry: { get: jest.Mock };
  let delivery: { log: jest.Mock; finish: jest.Mock };
  let adapterSendOutbound: jest.Mock;

  const makeModule = async () => {
    realtime = {
      subscribe: jest.fn((listener: (e: any) => void) => {
        realtime.busListener = listener;
        return realtime.disposer;
      }),
      busListener: null,
      disposer: jest.fn(),
    };
    prisma = {
      taskNotificationChannel: { findMany: jest.fn().mockResolvedValue([]) },
      notificationChannel: { findMany: jest.fn().mockResolvedValue([]) },
      task: { findUnique: jest.fn().mockResolvedValue(null) },
      chatChannel: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    adapterSendOutbound = jest
      .fn()
      .mockResolvedValue({ externalId: 'ext_1', meta: {} });
    registry = {
      get: jest.fn().mockReturnValue({ sendOutbound: adapterSendOutbound }),
    };
    delivery = {
      log: jest.fn().mockResolvedValue({ id: 'nd_0000000001' }),
      finish: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDispatcherService,
        { provide: RealtimeService, useValue: realtime },
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationRegistryService, useValue: registry },
        { provide: NotificationDeliveryService, useValue: delivery },
      ],
    }).compile();

    service = module.get(NotificationDispatcherService);
    return module;
  };

  const notificationChannel = (overrides: Record<string, any> = {}) => ({
    id: 'nc_1',
    name: 'ch-1',
    type: 'webhook',
    config: { events: [NOTIFICATION_EVENTS.TASK_STATUS_CHANGED] },
    secrets: {},
    enabled: true,
    ...overrides,
  });

  beforeEach(async () => {
    await makeModule();
  });

  describe('onModuleInit decoupled (auto-push disabled by default)', () => {
    it('does NOT subscribe to realtime when autoPushEnabled is false (default)', async () => {
      await service.onModuleInit();
      expect(realtime.subscribe).not.toHaveBeenCalled();
    });

    it('subscribes when autoPushEnabled is forced true (legacy opt-in via env)', async () => {
      (service as any).autoPushEnabled = true;
      await service.onModuleInit();
      expect(realtime.subscribe).toHaveBeenCalledTimes(1);
      expect(typeof realtime.subscribe.mock.calls[0][0]).toBe('function');
      service.onModuleDestroy();
      expect(realtime.disposer).toHaveBeenCalled();
    });
  });

  describe('handle is no-op when auto-push disabled (decoupled: agent must call channel_send)', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('TASK_STATUS_CHANGED does NOT auto-dispatch even with bound enabled channel', async () => {
      const ch = notificationChannel();
      prisma.taskNotificationChannel.findMany.mockResolvedValue([
        { notificationChannelId: 'nc_1' },
      ]);
      prisma.notificationChannel.findMany.mockResolvedValue([ch]);
      prisma.task.findUnique.mockResolvedValue({ title: 'My Task' });

      const event = {
        id: 'ev_1',
        type: EVENT_TYPES.TASK_STATUS_CHANGED,
        payload: {
          taskId: 't_1',
          from: 'pending',
          to: 'in_progress',
          actorType: 'user',
          actorId: 'u_1',
        },
        scopeType: 'global' as const,
        scopeId: null,
        projectId: null,
        timestamp: new Date().toISOString(),
      };

      await service.handle(event);
      await new Promise((r) => setTimeout(r, 20));

      expect(adapterSendOutbound).not.toHaveBeenCalled();
      expect(delivery.log).not.toHaveBeenCalled();
    });

    it('AGENT_QUESTION does NOT auto-dispatch even when pending', async () => {
      const ch = notificationChannel({
        id: 'nc_q',
        type: 'wecom_group_robot',
        config: { events: [NOTIFICATION_EVENTS.AGENT_QUESTION] },
      });
      prisma.taskNotificationChannel.findMany.mockResolvedValue([
        { notificationChannelId: 'nc_q' },
      ]);
      prisma.notificationChannel.findMany.mockResolvedValue([ch]);

      const event = {
        id: 'ev_2',
        type: EVENT_TYPES.AGENT_QUESTION,
        payload: {
          question: {
            kind: 'question',
            content: {
              questions: [
                { question: 'Q1?', options: ['yes', 'no'], header: 'H' },
              ],
            },
            taskId: 't_1',
            status: 'pending',
          },
        },
        scopeType: 'global' as const,
        scopeId: null,
        projectId: null,
        timestamp: new Date().toISOString(),
      };
      await service.handle(event);
      await new Promise((r) => setTimeout(r, 20));
      expect(adapterSendOutbound).not.toHaveBeenCalled();
    });

    it('agent reply does NOT auto-dispatch even when subscribed', async () => {
      const ch = notificationChannel({
        config: { events: [NOTIFICATION_EVENTS.AGENT_REPLY] },
      });
      prisma.taskNotificationChannel.findMany.mockResolvedValue([
        { notificationChannelId: 'nc_1' },
      ]);
      prisma.notificationChannel.findMany.mockResolvedValue([ch]);
      prisma.chatChannel.findUnique.mockResolvedValue({ taskId: 't_1' });

      const event = {
        id: 'ev_3',
        type: EVENT_TYPES.CHAT_MESSAGE_NEW,
        payload: {
          message: {
            senderType: 'agent',
            status: 'sent',
            content: { text: 'hello from agent' },
            channelId: 'c_1',
          },
        },
        scopeType: 'channel' as const,
        scopeId: 'c_1',
        projectId: null,
        timestamp: new Date().toISOString(),
      };
      await service.handle(event);
      await new Promise((r) => setTimeout(r, 20));
      expect(adapterSendOutbound).not.toHaveBeenCalled();
    });
  });

  describe('manual dispatch via MCP still works (channel_send)', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('dispatchToChannel still sends via adapter and logs delivery', async () => {
      const ch = notificationChannel();
      await service.dispatchToChannel(ch, { kind: 'markdown', text: 'manual hello' });
      expect(adapterSendOutbound).toHaveBeenCalledTimes(1);
      expect(adapterSendOutbound.mock.calls[0][1].text).toContain('manual hello');
      expect(delivery.log).toHaveBeenCalledWith(
        'outbound',
        'markdown',
        'pending',
        expect.objectContaining({ channelId: 'nc_1' }),
      );
      expect(delivery.finish).toHaveBeenCalledWith(
        'nd_0000000001',
        'ok',
        null,
        expect.anything(),
        expect.anything(),
      );
    });

    it('sendToChannelByIdOrName routes to bound channel by id/name', async () => {
      const ch = notificationChannel({ id: 'nc_1', name: 'ch-1' });
      prisma.taskNotificationChannel.findMany.mockResolvedValue([
        { notificationChannelId: 'nc_1' },
      ]);
      prisma.notificationChannel.findMany.mockResolvedValue([ch]);

      await service.sendToChannelByIdOrName('t_1', 'ch-1', 'hello via MCP');
      expect(adapterSendOutbound).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'nc_1' }),
        expect.objectContaining({ kind: 'markdown', text: 'hello via MCP' }),
      );
    });

    it('sendToChannelByIdOrName throws if channel not bound to task', async () => {
      prisma.taskNotificationChannel.findMany.mockResolvedValue([]);
      prisma.notificationChannel.findMany.mockResolvedValue([]);
      await expect(service.sendToChannelByIdOrName('t_1', 'nc_missing', 'hi')).rejects.toThrow();
    });

    it('adapter error logged via finish failed and does not block other channels', async () => {
      const ch1 = notificationChannel({ id: 'nc_1', type: 'webhook' });
      const ch2 = notificationChannel({
        id: 'nc_2',
        type: 'wecom_group_robot',
        config: { events: [NOTIFICATION_EVENTS.TASK_STATUS_CHANGED] },
      });

      const failAdapter = {
        sendOutbound: jest.fn().mockRejectedValue(new Error('boom')),
      };
      const okAdapter = {
        sendOutbound: jest.fn().mockResolvedValue({ externalId: 'ok' }),
      };
      registry.get.mockImplementation((type: string) => {
        if (type === 'webhook') return failAdapter as any;
        return okAdapter as any;
      });
      delivery.log
        .mockResolvedValueOnce({ id: 'nd_1' })
        .mockResolvedValueOnce({ id: 'nd_2' });

      // dispatch sequentially via queue: first fails, second succeeds
      await service.dispatchToChannel(ch1, { kind: 'markdown', text: 'a' });
      delivery.log.mockResolvedValueOnce({ id: 'nd_2' });
      await service.dispatchToChannel(ch2, { kind: 'markdown', text: 'b' });

      expect(failAdapter.sendOutbound).toHaveBeenCalled();
      expect(okAdapter.sendOutbound).toHaveBeenCalled();
      expect(delivery.finish).toHaveBeenCalledWith(
        'nd_1',
        'failed',
        'boom',
        expect.anything(),
        null,
      );
      expect(delivery.finish).toHaveBeenCalledWith(
        'nd_2',
        'ok',
        null,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('dispatchToChannel serial queue', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('executes per-channel sequentially (Promise chain)', async () => {
      const ch = notificationChannel({ id: 'nc_seq' });
      const order: number[] = [];
      let resolveFirst: (v: unknown) => void = () => {};
      const firstCall = new Promise((r) => (resolveFirst = r as any));
      adapterSendOutbound
        .mockImplementationOnce(async () => {
          order.push(1);
          await firstCall;
          order.push(3);
          return { externalId: 'a' };
        })
        .mockImplementationOnce(async () => {
          order.push(4);
          return { externalId: 'b' };
        });

      delivery.log.mockResolvedValue({ id: 'nd_seq' });

      const p1 = service.dispatchToChannel(ch, {
        kind: 'markdown',
        text: 'first',
      });
      const p2 = service.dispatchToChannel(ch, {
        kind: 'markdown',
        text: 'second',
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual([1]);

      resolveFirst(undefined);
      await Promise.all([p1, p2]);
      expect(order).toEqual([1, 3, 4]);
    });

    it('calls NotificationAdapter.sendOutbound with NotificationChannelResolved shape (no direction/taskId)', async () => {
      const ch = notificationChannel({ id: 'nc_shape', type: 'webhook' });
      await service.dispatchToChannel(ch, { kind: 'markdown', text: 'hi' });
      expect(adapterSendOutbound).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'nc_shape',
          type: 'webhook',
          config: expect.any(Object),
          secrets: expect.any(Object),
          enabled: true,
        }),
        expect.objectContaining({ kind: 'markdown', text: 'hi' }),
      );
      const resolved = adapterSendOutbound.mock.calls[0][0];
      expect(resolved).not.toHaveProperty('direction');
      expect(resolved).not.toHaveProperty('taskId');
    });
  });

  describe('formatTaskStatusMarkdown', () => {
    it('includes title, transition, actor', () => {
      const md = formatTaskStatusMarkdown(
        {
          taskId: 't_1',
          from: 'pending',
          to: 'in_progress',
          actorType: 'user',
          actorId: 'u_1',
        },
        'My Title',
      );
      expect(md).toContain('My Title');
      expect(md).toContain('pending');
      expect(md).toContain('in_progress');
      expect(md).toContain('user');
    });
  });
});
