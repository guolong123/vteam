import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { CHANNEL_TYPE } from '../common/constants/event.constants';
import { TASK_STATUS } from '../common/constants/task.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  buildProgressionPrompt,
  TaskProgressionScheduler,
} from './task-progression.scheduler';

describe('TaskProgressionScheduler', () => {
  let scheduler: TaskProgressionScheduler;
  let prisma: {
    task: { findUnique: jest.Mock; findMany: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    agentQuestion: { findUnique: jest.Mock };
  };
  let realtime: { subscribe: jest.Mock };
  let workerDispatcher: { dispatchAgentMention: jest.Mock };
  let config: { get: jest.Mock };

  const inProgressTask = (overrides: Record<string, unknown> = {}) => ({
    id: 't_0000000001',
    title: '巡检任务',
    status: TASK_STATUS.in_progress,
    mainAgentInstanceId: 'ta_0000000001',
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      task: { findUnique: jest.fn(), findMany: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      agentQuestion: { findUnique: jest.fn() },
    };
    realtime = { subscribe: jest.fn(() => () => {}) };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
    };
    config = { get: jest.fn().mockReturnValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskProgressionScheduler,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    scheduler = module.get(TaskProgressionScheduler);
    // 默认私有频道命中（dispatch 前置）
    prisma.chatChannel.findFirst.mockResolvedValue({
      id: 'c_private',
      type: CHANNEL_TYPE.private,
    });
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
    jest.clearAllMocks();
  });

  describe('register', () => {
    it('in_progress + 主实例存在 → 注册', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      expect(scheduler.isRegistered('t_1')).toBe(true);
    });

    it('幂等：重复注册重置轮次计时', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      await scheduler.register('t_1');
      const entry = (scheduler as any).loop.get('t_1') as {
        rounds: number;
        nextRunAt: number;
      };
      expect(entry.rounds).toBe(0);
      expect(entry.nextRunAt).toBeGreaterThan(Date.now());
    });

    it('非 in_progress 任务 → 不注册（脏条目清除）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ status: TASK_STATUS.pending }),
      );
      await scheduler.register('t_1');
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });

    it('主 Agent 缺失 → 不注册', async () => {
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ mainAgentInstanceId: null }),
      );
      await scheduler.register('t_1');
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });
  });

  describe('unregister', () => {
    it('删除循环条目', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      scheduler.unregister('t_1');
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });
  });

  describe('scan', () => {
    it('nextRunAt <= now → dispatch 巡检消息给主 Agent + 轮次累计', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      const entry = (scheduler as any).loop.get('t_1') as { nextRunAt: number };
      entry.nextRunAt = 0; // 强制到期
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = workerDispatcher.dispatchAgentMention.mock.calls[0][0];
      expect(call.taskId).toBe('t_1');
      expect(call.targetInstanceId).toBe('ta_0000000001');
      expect(call.text).toContain('【任务巡检】');
      expect(call.channelId).toBe('c_private');
      expect((scheduler as any).loop.get('t_1').rounds).toBe(1);
    });

    it('任务状态非 in_progress → 注销且不 dispatch', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      (scheduler as any).loop.get('t_1').nextRunAt = 0; // 强制到期
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ status: TASK_STATUS.pending_review }),
      );
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });

    it('主 Agent 缺失（团队调整移除）→ 注销防空转', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      (scheduler as any).loop.get('t_1').nextRunAt = 0; // 强制到期
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ mainAgentInstanceId: null }),
      );
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });

    it('未到期条目不触发', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      const entry = (scheduler as any).loop.get('t_1') as { nextRunAt: number };
      entry.nextRunAt = Date.now() + 60_000; // 未到期
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(scheduler.isRegistered('t_1')).toBe(true);
    });

    it('轮次上限：rounds >= maxRounds → 注销 + 不再 dispatch', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      const entry = (scheduler as any).loop.get('t_1') as {
        rounds: number;
        nextRunAt: number;
      };
      entry.nextRunAt = 0;
      entry.rounds = (scheduler as any).maxRounds - 1; // 本次触发即达上限
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });
  });

  describe('patrolNow', () => {
    it('跳过 nextRunAt 判定直接 dispatch + 轮次累计', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.register('t_1');
      await scheduler.patrolNow('t_1');
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      expect((scheduler as any).loop.get('t_1').rounds).toBe(1);
    });

    it('未注册任务 no-op', async () => {
      await scheduler.patrolNow('t_unknown');
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit', () => {
    it('重启恢复：扫描库内 in_progress 任务重建循环 + 订阅 realtime bus', async () => {
      prisma.task.findMany.mockResolvedValue([{ id: 't_1' }, { id: 't_2' }]);
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.onModuleInit();
      expect(scheduler.isRegistered('t_1')).toBe(true);
      expect(scheduler.isRegistered('t_2')).toBe(true);
      expect(realtime.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('托管确认路由（realtime bus 订阅回调）', () => {
    it('payload.managed=true 且 pending → dispatch 托管确认消息给主 Agent', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.onModuleInit();
      const listener = realtime.subscribe.mock.calls[0][0];
      prisma.agentQuestion.findUnique.mockResolvedValue({
        id: 'aq_1',
        requestId: 'que_1',
        kind: 'permission',
        content: { title: '写入文件', pattern: 'Write' },
        status: 'pending',
      });
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ title: '托管任务' }),
      );
      const errorSpy = jest.spyOn((scheduler as any).logger, 'error');
      await listener({
        type: 'agent.question',
        payload: {
          managed: true,
          question: { taskId: 't_1', requestId: 'que_1' },
          taskId: 't_1',
        },
      });
      // listener 为 fire-and-forget（void ...catch），等待异步链路完成
      await new Promise((r) => setTimeout(r, 20));
      expect(errorSpy).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = workerDispatcher.dispatchAgentMention.mock.calls[0][0];
      expect(call.text).toContain('【托管确认】');
      expect(call.text).toContain('question_confirm');
    });

    it('非托管（managed≠true）不路由', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      await scheduler.onModuleInit();
      const listener = realtime.subscribe.mock.calls[0][0];
      await listener({
        type: 'agent.question',
        payload: { question: { taskId: 't_1', requestId: 'que_1' } },
      });
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('resolved=true（收敛事件）不路由', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      await scheduler.onModuleInit();
      const listener = realtime.subscribe.mock.calls[0][0];
      await listener({
        type: 'agent.question',
        payload: {
          managed: true,
          resolved: true,
          question: { taskId: 't_1', requestId: 'que_1' },
        },
      });
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });
  });

  describe('buildProgressionPrompt', () => {
    it('包含巡检引导与状态', () => {
      const text = buildProgressionPrompt('标题', TASK_STATUS.in_progress);
      expect(text).toContain('【任务巡检】');
      expect(text).toContain('标题');
      expect(text).toContain('mark-pending-review');
      expect(text).toContain('notify_agent');
    });
  });
});
