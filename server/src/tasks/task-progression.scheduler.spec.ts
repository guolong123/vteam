import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { CHANNEL_TYPE } from '../common/constants/event.constants';
import { TASK_STATUS } from '../common/constants/task.constants';
import { TRIGGER_KIND } from '../common/constants/trigger.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TriggerService } from '../timers/trigger.service';
import {
  PROGRESSION_COOLDOWN_GUARD,
  buildProgressionDedupKey,
  buildProgressionPrompt,
  TaskProgressionScheduler,
} from './task-progression.scheduler';

describe('TaskProgressionScheduler', () => {
  let scheduler: TaskProgressionScheduler;
  let prisma: {
    task: { findUnique: jest.Mock; findMany: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    agentQuestion: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
  };
  let realtime: { subscribe: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isSessionPending: jest.Mock;
    getLastActivityAt: jest.Mock;
  };
  let triggers: {
    schedule: jest.Mock;
    cancel: jest.Mock;
    registerHandler: jest.Mock;
    registerGuard: jest.Mock;
  };
  let config: { get: jest.Mock };

  const inProgressTask = (overrides: Record<string, unknown> = {}) => ({
    id: 't_0000000001',
    title: '巡检任务',
    status: TASK_STATUS.in_progress,
    teamId: 'tm_0000000001',
    ...overrides,
  });

  /** 主成员门默认放行（beforeEach 已置 tmm_0000000001；缺失用例各自覆写）。 */
  const allowMainMember = () => {
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: 'tmm_0000000001',
    });
  };

  beforeEach(async () => {
    prisma = {
      task: { findUnique: jest.fn(), findMany: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      agentQuestion: { findUnique: jest.fn() },
      team: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ mainAgentMemberId: 'tmm_0000000001' }),
      },
    };
    realtime = { subscribe: jest.fn(() => () => {}) };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isSessionPending: jest.fn().mockReturnValue(false),
      getLastActivityAt: jest.fn().mockReturnValue(undefined),
    };
    triggers = {
      schedule: jest.fn().mockResolvedValue({ id: 'tmr_1' }),
      cancel: jest.fn().mockResolvedValue({ id: 'tmr_1' }),
      registerHandler: jest.fn(),
      registerGuard: jest.fn(),
    };
    config = { get: jest.fn().mockReturnValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskProgressionScheduler,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: TriggerService, useValue: triggers },
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
    it('in_progress + 主成员存在 → 注册', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      expect(scheduler.isRegistered('t_1')).toBe(true);
    });

    it('幂等：重复注册重置轮次计时', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
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

    it('主成员缺失 → 不注册', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({ mainAgentMemberId: null }),
      };
      await scheduler.register('t_1');
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });
  });

  describe('unregister', () => {
    it('删除循环条目', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      scheduler.unregister('t_1');
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });
  });

  describe('scan', () => {
    it('nextRunAt <= now → dispatch 巡检消息给主 Agent + 轮次累计', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      const entry = (scheduler as any).loop.get('t_1') as { nextRunAt: number };
      entry.nextRunAt = 0; // 强制到期
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = workerDispatcher.dispatchAgentMention.mock.calls[0][0];
      expect(call.taskId).toBe('t_1');
      expect(call.targetInstanceId).toBe('tmm_0000000001');
      expect(call.text).toContain('【任务巡检】');
      expect(call.channelId).toBe('c_private');
      expect((scheduler as any).loop.get('t_1').rounds).toBe(1);
    });

    it('任务状态非 in_progress → 注销且不 dispatch', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      (scheduler as any).loop.get('t_1').nextRunAt = 0; // 强制到期
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ status: TASK_STATUS.pending_review }),
      );
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });

    it('主成员缺失（团队调整移除）→ 注销防空转', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      (scheduler as any).loop.get('t_1').nextRunAt = 0; // 强制到期
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({ mainAgentMemberId: null }),
      };
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });

    it('未到期条目不触发', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      const entry = (scheduler as any).loop.get('t_1') as { nextRunAt: number };
      entry.nextRunAt = Date.now() + 60_000; // 未到期
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(scheduler.isRegistered('t_1')).toBe(true);
    });

    it('轮次上限：rounds >= maxRounds → 注销 + 不再 dispatch', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
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
      allowMainMember();
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

  describe('trigger 持久化（todo-8：rounds≡fireCount，maxRounds≡maxFires）', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('register 不再排期周期巡检（periodic patrol 已退役，仅内存镜像）+ unregister 仍 cancel 旧行', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      // 退役契约：内存镜像仍注册，但不再排任何 interval 巡检行
      expect(scheduler.isRegistered('t_1')).toBe(true);
      expect(triggers.schedule).not.toHaveBeenCalled();
      const intervalCalls = triggers.schedule.mock.calls.filter(
        (call) => call[4]?.intervalMs !== undefined,
      );
      expect(intervalCalls).toHaveLength(0);
      // unregister 仍 cancel 旧行（清扫遗留 pending 行）
      scheduler.unregister('t_1');
      await flush();
      expect(triggers.cancel).toHaveBeenCalledWith(
        buildProgressionDedupKey('t_1'),
      );
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });

    it('register 幂等：pending 行已存在 → 保留 fireCount（不清零，不重建）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      (prisma as any).trigger = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'tmr_1', status: 'pending' }),
      };
      await scheduler.register('t_1');
      expect(triggers.schedule).not.toHaveBeenCalled();
      expect(scheduler.isRegistered('t_1')).toBe(true);
    });

    it('register 数据修复：终态行 → 不删除不重建（退役 no-op，仅重建内存镜像）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      const del = jest.fn().mockResolvedValue({ id: 'tmr_1' });
      (prisma as any).trigger = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'tmr_1', status: 'cancelled' }),
        delete: del,
      };
      await scheduler.register('t_1');
      expect(del).not.toHaveBeenCalled();
      expect(triggers.schedule).not.toHaveBeenCalled();
      expect(scheduler.isRegistered('t_1')).toBe(true);
    });

    it('unregister → cancel 触发器（行留 cancelled）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      scheduler.unregister('t_1');
      await flush();
      expect(triggers.cancel).toHaveBeenCalledWith(
        buildProgressionDedupKey('t_1'),
      );
      expect(scheduler.isRegistered('t_1')).toBe(false);
    });

    it('onModuleInit 接线 handler + guard', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      await scheduler.onModuleInit();
      expect(triggers.registerGuard).toHaveBeenCalledWith(
        PROGRESSION_COOLDOWN_GUARD,
        expect.any(Function),
      );
      expect(triggers.registerHandler).toHaveBeenCalledWith(
        TRIGGER_KIND.PROGRESSION_PATROL,
        expect.any(Function),
      );
    });
  });

  describe('handleProgressionFire（todo-8）', () => {
    const fireCtx = (overrides: Record<string, unknown> = {}) => ({
      id: 'tmr_1',
      kind: TRIGGER_KIND.PROGRESSION_PATROL,
      fireCount: 2,
      payload: { taskId: 't_1' },
      ...overrides,
    });

    const handlerOf = async () => {
      prisma.task.findMany.mockResolvedValue([]);
      await scheduler.onModuleInit();
      return triggers.registerHandler.mock.calls[0][1];
    };

    it('正常 → dispatch wake 巡检（同 prompt/同链路）+ 返回 void（基座重排+计数）', async () => {
      const handler = await handlerOf();
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      const out = await handler(fireCtx());
      expect(out).toBeUndefined();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = workerDispatcher.dispatchAgentMention.mock.calls[0][0];
      expect(call.taskId).toBe('t_1');
      expect(call.targetInstanceId).toBe('tmm_0000000001');
      expect(call.kind).toBe('wake');
      expect(call.text).toContain('【任务巡检】');
    });

    it('任务已离场 → {expire:true} 且不 dispatch', async () => {
      const handler = await handlerOf();
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ status: TASK_STATUS.pending_review }),
      );
      const out = await handler(fireCtx());
      expect(out).toEqual({ expire: true });
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('payload 缺 taskId → {expire:true}', async () => {
      const handler = await handlerOf();
      const out = await handler(fireCtx({ payload: {} }));
      expect(out).toEqual({ expire: true });
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('race 窗口否决（主会话忙）→ 跳过 dispatch 但返回 void（保守计轮次）', async () => {
      const handler = await handlerOf();
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      (prisma as any).session = {
        findFirst: jest.fn().mockResolvedValue({ id: 's_main' }),
      };
      workerDispatcher.isSessionPending.mockReturnValue(true);
      const out = await handler(fireCtx());
      expect(out).toBeUndefined();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });
  });

  describe('progressionCooldownGuard（todo-8：否决不消耗轮次）', () => {
    const guardOf = async () => {
      prisma.task.findMany.mockResolvedValue([]);
      await scheduler.onModuleInit();
      return triggers.registerGuard.mock.calls[0][1];
    };
    const guardCtx = () => ({
      id: 'tmr_1',
      kind: TRIGGER_KIND.PROGRESSION_PATROL,
      fireCount: 2,
      payload: { taskId: 't_1' },
    });

    it('主会话 pending → false', async () => {
      const guard = await guardOf();
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      (prisma as any).session = {
        findFirst: jest.fn().mockResolvedValue({ id: 's_main' }),
      };
      workerDispatcher.isSessionPending.mockReturnValue(true);
      await expect(guard(guardCtx())).resolves.toBe(false);
    });

    it('主会话近期活跃 → false', async () => {
      const guard = await guardOf();
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      (prisma as any).session = {
        findFirst: jest.fn().mockResolvedValue({ id: 's_main' }),
      };
      workerDispatcher.isSessionPending.mockReturnValue(false);
      workerDispatcher.getLastActivityAt.mockReturnValue(Date.now());
      await expect(guard(guardCtx())).resolves.toBe(false);
    });

    it('空闲 → true', async () => {
      const guard = await guardOf();
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await expect(guard(guardCtx())).resolves.toBe(true);
    });

    it('DB 异常 → true（fail-open）', async () => {
      const guard = await guardOf();
      prisma.task.findUnique.mockRejectedValue(new Error('db down'));
      await expect(guard(guardCtx())).resolves.toBe(true);
    });
  });
});
