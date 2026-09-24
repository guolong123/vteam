import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { CHANNEL_TYPE } from '../common/constants/event.constants';
import { TASK_STATUS } from '../common/constants/task.constants';
import { TRIGGER_KIND } from '../common/constants/trigger.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TRIGGER_STATUS, TriggerService } from '../timers/trigger.service';
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
    message: { create: jest.Mock; findFirst: jest.Mock };
    issue: { findFirst: jest.Mock };
    agentQuestion: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    trigger: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let realtime: { subscribe: jest.Mock; broadcast: jest.Mock };
  let idGen: { nextId: jest.Mock };
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

  /**
   * canonical 触发器行 fake（Map 移除后唯一的巡检状态源）：
   * schedule 幂等建 pending 行、cancel 留 cancelled、update 合并 payload/status。
   */
  type FakeTriggerRow = {
    id: string;
    kind: string;
    dedupKey: string;
    status: string;
    payload: { taskId: string; quietStreak?: number };
    nextFireAt: Date | null;
    fireCount: number;
    maxFires: number | null;
  };
  let rows: Record<string, FakeTriggerRow>;
  let rowSeq: number;
  const findRowById = (id: string): FakeTriggerRow | null =>
    Object.values(rows).find((r) => r.id === id) ?? null;

  /** canonical 行播种（id 固定 tmr_1，与 fireCtx 对齐，便于 handler 直调）。 */
  const seedPatrolRow = (
    taskId = 't_1',
    over: Partial<FakeTriggerRow> = {},
  ): FakeTriggerRow => {
    const dedupKey = buildProgressionDedupKey(taskId);
    rows[dedupKey] = {
      id: 'tmr_1',
      kind: TRIGGER_KIND.PROGRESSION_PATROL,
      dedupKey,
      status: TRIGGER_STATUS.PENDING,
      payload: { taskId },
      nextFireAt: new Date(Date.now() - 1000),
      fireCount: 0,
      maxFires: 6,
      ...over,
    };
    return rows[dedupKey];
  };

  beforeEach(async () => {
    rows = {};
    rowSeq = 0;
    prisma = {
      task: { findUnique: jest.fn(), findMany: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { create: jest.fn(), findFirst: jest.fn() },
      issue: { findFirst: jest.fn() },
      agentQuestion: { findUnique: jest.fn() },
      team: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ mainAgentMemberId: 'tmm_0000000001' }),
      },
      trigger: {
        findUnique: jest.fn(
          async (args: { where?: { dedupKey?: string; id?: string } }) => {
            if (args?.where?.dedupKey) {
              return rows[args.where.dedupKey] ?? null;
            }
            if (args?.where?.id) {
              return findRowById(args.where.id);
            }
            return null;
          },
        ),
        findMany: jest.fn(
          async (args?: { where?: { kind?: string; status?: string } }) =>
            Object.values(rows).filter((r) => {
              if (args?.where?.kind && r.kind !== args.where.kind) {
                return false;
              }
              if (args?.where?.status && r.status !== args.where.status) {
                return false;
              }
              return true;
            }),
        ),
        update: jest.fn(
          async (args: {
            where: { id?: string; dedupKey?: string };
            data: Partial<FakeTriggerRow>;
          }) => {
            const target = args.where.dedupKey
              ? (rows[args.where.dedupKey] ?? null)
              : args.where.id
                ? findRowById(args.where.id)
                : null;
            if (!target) {
              return null;
            }
            Object.assign(target, args.data);
            return target;
          },
        ),
        delete: jest.fn(async (args: { where: { dedupKey: string } }) => {
          const target = rows[args.where.dedupKey] ?? null;
          if (target) {
            delete rows[args.where.dedupKey];
          }
          return target;
        }),
      },
    };
    idGen = { nextId: jest.fn().mockResolvedValue('m_0000000999') };
    realtime = {
      subscribe: jest.fn(() => () => {}),
      broadcast: jest.fn().mockResolvedValue(undefined),
    };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isSessionPending: jest.fn().mockReturnValue(false),
      getLastActivityAt: jest.fn().mockReturnValue(undefined),
    };
    triggers = {
      schedule: jest.fn(
        async (
          kind: string,
          dueAt: Date,
          payload: { taskId: string },
          dedupKey: string,
          opts?: { intervalMs?: number; maxFires?: number },
        ) => {
          const existing = rows[dedupKey];
          if (existing) {
            return { id: existing.id };
          }
          rowSeq += 1;
          const id = `tmr_${rowSeq}`;
          rows[dedupKey] = {
            id,
            kind,
            dedupKey,
            status: TRIGGER_STATUS.PENDING,
            payload: { ...payload },
            nextFireAt: dueAt,
            fireCount: 0,
            maxFires: opts?.maxFires ?? null,
          };
          return { id };
        },
      ),
      cancel: jest.fn(async (dedupKey: string) => {
        const target = rows[dedupKey];
        if (target) {
          target.status = TRIGGER_STATUS.CANCELLED;
        }
        return { id: target?.id ?? dedupKey };
      }),
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
        { provide: IdGeneratorService, useValue: idGen },
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
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
    });

    it('幂等：重复注册保留 pending 行（fireCount/quietStreak 不清零）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      const key = buildProgressionDedupKey('t_1');
      rows[key].fireCount = 2;
      rows[key].payload.quietStreak = 1;
      await scheduler.register('t_1');
      expect(triggers.schedule).toHaveBeenCalledTimes(1);
      expect(rows[key].fireCount).toBe(2);
      expect(rows[key].payload.quietStreak).toBe(1);
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
    });

    it('非 in_progress 任务 → 不注册（脏条目清除）', async () => {
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ status: TASK_STATUS.pending }),
      );
      await scheduler.register('t_1');
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
      expect(triggers.schedule).not.toHaveBeenCalled();
    });

    it('主成员缺失 → 不注册', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({ mainAgentMemberId: null }),
      };
      await scheduler.register('t_1');
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
      expect(triggers.schedule).not.toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('注销巡检 → cancel 触发器行（留 cancelled 备查）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
      scheduler.unregister('t_1');
      await new Promise((r) => setImmediate(r));
      expect(triggers.cancel).toHaveBeenCalledWith(
        buildProgressionDedupKey('t_1'),
      );
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
    });
  });

  describe('scan', () => {
    it('到期 pending 行 → dispatch 巡检消息给主 Agent（Map 缺席，派生自触发器行）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      seedPatrolRow('t_1', { nextFireAt: new Date(Date.now() - 1000) });
      expect('loop' in scheduler).toBe(false);
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = workerDispatcher.dispatchAgentMention.mock.calls[0][0];
      expect(call.taskId).toBe('t_1');
      expect(call.targetInstanceId).toBe('tmm_0000000001');
      expect(call.text).toContain('【任务巡检】');
      expect(call.channelId).toBe('c_private');
      // scan 不记账：行仍 pending，计数归基座 fireCount。
      expect(rows[buildProgressionDedupKey('t_1')].status).toBe(
        TRIGGER_STATUS.PENDING,
      );
    });

    it('任务状态非 in_progress → 注销且不 dispatch', async () => {
      seedPatrolRow('t_1');
      prisma.task.findUnique.mockResolvedValue(
        inProgressTask({ status: TASK_STATUS.pending_review }),
      );
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
    });

    it('主成员缺失（团队调整移除）→ 注销防空转', async () => {
      seedPatrolRow('t_1');
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({ mainAgentMemberId: null }),
      };
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
    });

    it('未到期行不触发', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      seedPatrolRow('t_1', { nextFireAt: new Date(Date.now() + 60_000) });
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
    });

    it('scan 不做内存轮次强制（上限由基座 maxFires 强制）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      seedPatrolRow('t_1', { fireCount: 5, maxFires: 6 });
      await (scheduler as any).scan();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
    });
  });

  describe('patrolNow', () => {
    it('pending 行存在 → 跳过到期判定直接 dispatch', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      seedPatrolRow('t_1', { nextFireAt: new Date(Date.now() + 600_000) });
      await scheduler.patrolNow('t_1');
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = workerDispatcher.dispatchAgentMention.mock.calls[0][0];
      expect(call.taskId).toBe('t_1');
      expect(call.text).toContain('【任务巡检】');
    });

    it('未注册任务 no-op', async () => {
      await scheduler.patrolNow('t_unknown');
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit', () => {
    it('重启恢复：扫描库内 in_progress 任务重建巡检 + 订阅 realtime bus', async () => {
      prisma.task.findMany.mockResolvedValue([{ id: 't_1' }, { id: 't_2' }]);
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      await scheduler.onModuleInit();
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
      await expect(scheduler.isRegistered('t_2')).resolves.toBe(true);
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

    it('team:<id> 域（团队会话无任务）→ 跳过 task 查表，按团队解析主成员并以 teamId 直传 dispatch', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      await scheduler.onModuleInit();
      const listener = realtime.subscribe.mock.calls[0][0];
      prisma.agentQuestion.findUnique.mockResolvedValue({
        id: 'aq_9',
        requestId: 'per_9',
        kind: 'permission',
        content: { title: 'external_directory', pattern: '/root/*' },
        status: 'pending',
        sessionId: null,
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      prisma.task.findUnique.mockClear();

      await listener({
        type: 'agent.question',
        payload: {
          managed: true,
          question: { taskId: 'team:tm_9', requestId: 'per_9' },
          taskId: 'team:tm_9',
          teamId: 'tm_9',
        },
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = workerDispatcher.dispatchAgentMention.mock.calls[0][0];
      expect(call.taskId).toBeNull();
      expect(call.teamId).toBe('tm_9');
      expect(call.text).toContain('【托管确认】');
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

    it('register 排期周期巡检（看门狗复活：interval 行 + guard + maxFires）+ unregister 仍 cancel 旧行', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      await scheduler.register('t_1');
      // 复活契约：触发器行落库 + 排 interval 巡检行
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
      expect(triggers.schedule).toHaveBeenCalledTimes(1);
      const [kind, dueAt, payload, dedupKey, opts] =
        triggers.schedule.mock.calls[0];
      expect(kind).toBe(TRIGGER_KIND.PROGRESSION_PATROL);
      expect(dueAt.getTime()).toBeGreaterThan(Date.now());
      expect(payload).toEqual({ taskId: 't_1' });
      expect(dedupKey).toBe(buildProgressionDedupKey('t_1'));
      expect(opts).toMatchObject({ guardKey: PROGRESSION_COOLDOWN_GUARD });
      expect(opts.intervalMs).toBeGreaterThan(0);
      expect(opts.maxFires).toBeGreaterThan(0);
      // unregister 仍 cancel 旧行（清扫遗留 pending 行）
      scheduler.unregister('t_1');
      await flush();
      expect(triggers.cancel).toHaveBeenCalledWith(
        buildProgressionDedupKey('t_1'),
      );
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
    });

    it('register 幂等：pending 行已存在 → 保留 fireCount（不清零，不重建）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      seedPatrolRow('t_1', {
        fireCount: 2,
        payload: { taskId: 't_1', quietStreak: 1 },
      });
      await scheduler.register('t_1');
      expect(triggers.schedule).not.toHaveBeenCalled();
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
      const key = buildProgressionDedupKey('t_1');
      expect(rows[key].fireCount).toBe(2);
      expect(rows[key].payload.quietStreak).toBe(1);
    });

    it('register 数据修复：终态行 → 先删后建（否则基座 dedup 回旧行 Resume 后巡检不恢复）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      seedPatrolRow('t_1', { status: TRIGGER_STATUS.CANCELLED });
      await scheduler.register('t_1');
      expect(prisma.trigger.delete).toHaveBeenCalledWith({
        where: { dedupKey: buildProgressionDedupKey('t_1') },
      });
      expect(triggers.schedule).toHaveBeenCalledTimes(1);
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
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
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
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

    /**
     * 生产对齐的 fire 上下文：基座每次都传库内最新行 payload，
     * 故此处从 fake 表读当前 payload（quietStreak 跨轮累加才成立）。
     */
    const liveFireCtx = (overrides: Record<string, unknown> = {}) => {
      const row = rows[buildProgressionDedupKey('t_1')];
      return fireCtx({
        payload: row ? { ...row.payload } : { taskId: 't_1' },
        ...overrides,
      });
    };

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

    it('连续 3 轮静默 → 触发停滞回调 + 注销巡检（看门狗自动置阻塞链路）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      const stalled: Array<{ taskId: string; reason: string }> = [];
      scheduler.onStallDetected((taskId, reason) =>
        stalled.push({ taskId, reason }),
      );
      const handler = await handlerOf();
      seedPatrolRow('t_1');
      // 主会话不存在 → 否决链跳过，每轮都叫醒（静默）
      await handler(liveFireCtx({ fireCount: 0 }));
      await handler(liveFireCtx({ fireCount: 1 }));
      expect(stalled).toHaveLength(0);
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
      await handler(liveFireCtx({ fireCount: 2 }));
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(3);
      expect(stalled).toHaveLength(1);
      expect(stalled[0].taskId).toBe('t_1');
      expect(stalled[0].reason).toContain('看门狗');
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
    });

    it('静默达上限但有 issue in_progress → 递延不置阻塞（巡检继续，streak 清零）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      const stalled: Array<{ taskId: string; reason: string }> = [];
      scheduler.onStallDetected((taskId, reason) =>
        stalled.push({ taskId, reason }),
      );
      prisma.issue.findFirst.mockResolvedValue({
        id: 'is_0000000001',
        status: 'in_progress',
      });
      prisma.message.findFirst.mockResolvedValue(null);
      const handler = await handlerOf();
      seedPatrolRow('t_1');
      await handler(liveFireCtx({ fireCount: 0 }));
      await handler(liveFireCtx({ fireCount: 1 }));
      await handler(liveFireCtx({ fireCount: 2 }));
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(3);
      expect(stalled).toHaveLength(0);
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
      expect(rows[buildProgressionDedupKey('t_1')].payload.quietStreak).toBe(0);
      expect(prisma.issue.findFirst).toHaveBeenCalledWith({
        where: {
          taskId: 't_1',
          status: { in: ['in_progress'] },
          deletedAt: null,
        },
        select: { id: true, status: true },
      });
    });

    it('静默达上限但任务频道近期有聊天 → 递延不置阻塞', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      const stalled: unknown[] = [];
      scheduler.onStallDetected((taskId, reason) =>
        stalled.push({ taskId, reason }),
      );
      prisma.issue.findFirst.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue({ id: 'm_0000000001' });
      const handler = await handlerOf();
      seedPatrolRow('t_1');
      await handler(liveFireCtx({ fireCount: 0 }));
      await handler(liveFireCtx({ fireCount: 1 }));
      await handler(liveFireCtx({ fireCount: 2 }));
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(3);
      expect(stalled).toHaveLength(0);
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          taskId: 't_1',
          createdAt: { gte: expect.any(Date) },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
    });

    it('静默达上限且真正空闲（无在途 issue、无近期聊天）→ 置阻塞如前', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      const stalled: Array<{ taskId: string; reason: string }> = [];
      scheduler.onStallDetected((taskId, reason) =>
        stalled.push({ taskId, reason }),
      );
      prisma.issue.findFirst.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue(null);
      const handler = await handlerOf();
      seedPatrolRow('t_1');
      await handler(liveFireCtx({ fireCount: 0 }));
      await handler(liveFireCtx({ fireCount: 1 }));
      expect(stalled).toHaveLength(0);
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
      await handler(liveFireCtx({ fireCount: 2 }));
      expect(stalled).toHaveLength(1);
      expect(stalled[0].taskId).toBe('t_1');
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(false);
    });

    it('中间观测到活跃 → 静默计数清零（有活干不算停滞）', async () => {
      prisma.task.findUnique.mockResolvedValue(inProgressTask());
      allowMainMember();
      const stalled: unknown[] = [];
      scheduler.onStallDetected((taskId, reason) =>
        stalled.push({ taskId, reason }),
      );
      const handler = await handlerOf();
      seedPatrolRow('t_1');
      // 两轮静默（streak=2）
      await handler(liveFireCtx({ fireCount: 0 }));
      await handler(liveFireCtx({ fireCount: 1 }));
      expect(rows[buildProgressionDedupKey('t_1')].payload.quietStreak).toBe(2);
      // 一轮活跃 → 跳过叫醒且清零（主会话存在 + 近期有活动）
      (prisma as any).session = {
        findFirst: jest.fn().mockResolvedValue({ id: 's_main' }),
      };
      workerDispatcher.getLastActivityAt.mockReturnValue(Date.now());
      await handler(liveFireCtx({ fireCount: 2 }));
      expect(rows[buildProgressionDedupKey('t_1')].payload.quietStreak).toBe(0);
      // 再两轮静默 → streak 回到 2，仍不触发停滞（若不清零此时已是 4 轮连静默）
      workerDispatcher.getLastActivityAt.mockReturnValue(undefined);
      delete (prisma as any).session;
      await handler(liveFireCtx({ fireCount: 3 }));
      await handler(liveFireCtx({ fireCount: 4 }));
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(4);
      expect(stalled).toHaveLength(0);
      await expect(scheduler.isRegistered('t_1')).resolves.toBe(true);
    });
  });

  describe('postStallNoticeToTeamGroup（停滞群公告）', () => {
    it('团队群频道存在 → 落 system 消息 + 广播', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_group' });
      prisma.message.create.mockResolvedValue({ id: 'm_0000000999' });

      await scheduler.postStallNoticeToTeamGroup(
        'tm_1',
        't_1',
        '巡检任务',
        '看门狗：连续 3 轮无进展',
      );

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'c_group',
          senderType: 'system',
          status: 'sent',
        }),
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        'chat.message.new',
        expect.objectContaining({
          message: expect.objectContaining({ channelId: 'c_group' }),
        }),
        { type: 'channel', id: 'c_group' },
      );
    });

    it('无群频道 → 跳过不抛错', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue(null);

      await expect(
        scheduler.postStallNoticeToTeamGroup('tm_1', 't_1', '巡检任务', '卡住'),
      ).resolves.toBeUndefined();
      expect(prisma.message.create).not.toHaveBeenCalled();
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
