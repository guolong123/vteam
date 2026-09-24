import { ConfigService } from '@nestjs/config';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TriggerService } from '../timers/trigger.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import {
  buildHookFireDedupKey,
  HOOK_ALL_IDLE_GRACE_MS_DEFAULT,
  HOOK_KIND,
  HOOK_POLL_DEDUP_KEY,
  HOOK_STATUS,
  HOOK_WAKE_TEXT_MAX,
} from './hook.constants';
import {
  HookService,
  parseHookTarget,
  RegisterHookInput,
} from './hook.service';

describe('hook.constants（dedup/前缀/唤醒词组装）', () => {
  it('fire dedup 形状 hook_fire:hook:<hookId>（todo-3 可回查）', () => {
    expect(buildHookFireDedupKey('hks_0000000001')).toBe(
      'hook_fire:hook:hks_0000000001',
    );
  });

  it('全局 poll dedup 一域一行', () => {
    expect(HOOK_POLL_DEDUP_KEY).toBe('hook_poll:global:all_idle');
  });

  it('grace 缺省 4min（plan 3–5min 区间内，todo-10 PoC 定终值）', () => {
    expect(HOOK_ALL_IDLE_GRACE_MS_DEFAULT).toBe(4 * 60 * 1000);
  });
});

describe('HookService（agent-hook 域，todo-11）', () => {
  let svc: HookService;
  let prisma: {
    hook: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    trigger: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
      updateMany: jest.Mock;
    };
    task: { findUnique: jest.Mock };
    teamMember: { findUnique: jest.Mock };
    session: { findMany: jest.Mock; findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let txHookCreate: jest.Mock;
  let txTriggerCreate: jest.Mock;
  let triggers: {
    registerHandler: jest.Mock;
    schedule: jest.Mock;
    cancel: jest.Mock;
  };
  let dispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
    isSessionPending: jest.Mock;
  };
  let realtime: { emit: jest.Mock };
  let seq: number;

  const hookRow = (over: Record<string, unknown> = {}) => ({
    id: 'hks_0000000001',
    scopeType: 'team',
    scopeId: 'tm_1',
    ownerInstanceId: 'tmm_1',
    kind: HOOK_KIND.TIME,
    wakeText: 'wake me',
    target: {
      taskId: 't_1',
      teamId: 'tm_1',
      channelId: 'c_1',
      targetInstanceId: 'tmm_1',
    },
    status: HOOK_STATUS.PENDING,
    dueAt: new Date(Date.now() - 1000),
    graceMs: null,
    expiresAt: new Date(Date.now() + 3600_000),
    dedupKey: 'hook:team:wake-1',
    fireCount: 0,
    parentHookId: null,
    rootTaskId: 't_1',
    lastError: null,
    skipReason: null,
    createdAt: new Date(),
    ...over,
  });

  const timeInput = (
    over: Partial<RegisterHookInput> = {},
  ): RegisterHookInput => ({
    scopeType: 'team',
    scopeId: 'tm_1',
    ownerInstanceId: 'tmm_1',
    kind: HOOK_KIND.TIME,
    wakeText: 'wake me up',
    target: {
      taskId: 't_1',
      teamId: 'tm_1',
      channelId: 'c_1',
      targetInstanceId: 'tmm_1',
    },
    dueAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3600_000),
    dedupKey: 'hook:team:wake-1',
    ...over,
  });

  /** 目标解析全放行：任务在途 + 成员在 + 会话绑定（idle）。 */
  const mockTargetOk = () => {
    prisma.task.findUnique.mockResolvedValue({
      status: 'in_progress',
      teamId: 'tm_1',
    });
    prisma.teamMember.findUnique.mockResolvedValue({
      id: 'tmm_1',
      teamId: 'tm_1',
    });
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      status: 'idle',
      workerId: null,
    });
  };

  beforeEach(() => {
    seq = 1;
    txHookCreate = jest.fn(async ({ data }: { data: unknown }) => ({
      ...(data as Record<string, unknown>),
      createdAt: new Date(),
    }));
    txTriggerCreate = jest.fn(async ({ data }: { data: unknown }) => data);
    prisma = {
      hook: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(async ({ data }: { data: unknown }) => data),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      trigger: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        delete: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      task: { findUnique: jest.fn() },
      teamMember: { findUnique: jest.fn() },
      session: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      $transaction: jest.fn(async (cb: unknown) =>
        (cb as (tx: unknown) => Promise<unknown>)({
          hook: { create: txHookCreate },
          trigger: { create: txTriggerCreate },
        }),
      ),
    };
    triggers = {
      registerHandler: jest.fn(),
      schedule: jest.fn(async () => ({})),
      cancel: jest.fn(async () => ({})),
    };
    dispatcher = {
      dispatchAgentMention: jest.fn(async () => undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
      isSessionPending: jest.fn().mockReturnValue(false),
    };
    const idGen = {
      nextId: jest.fn(async (prefix: string) => {
        const id = `${prefix}_${String(seq).padStart(10, '0')}`;
        seq += 1;
        return id;
      }),
      seed: jest.fn(),
    };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    realtime = { emit: jest.fn(async () => ({})) };
    svc = new HookService(
      prisma as unknown as PrismaService,
      idGen as unknown as IdGeneratorService,
      triggers as unknown as TriggerService,
      dispatcher as unknown as WorkerDispatcher,
      config as unknown as ConfigService,
      realtime as unknown as RealtimeService,
    );
  });

  describe('registerHook 输入白名单（loud 拒绝）', () => {
    it.each([['timer'], ['event'], ['']])(
      '未知 kind %p → 抛错不落库',
      async (kind) => {
        await expect(svc.registerHook(timeInput({ kind }))).rejects.toThrow(
          'unknown hook kind',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('time 缺 dueAt → 抛错', async () => {
      await expect(
        svc.registerHook(timeInput({ dueAt: null })),
      ).rejects.toThrow('dueAt');
    });

    it('time dueAt >= expiresAt → 抛错（否则到期即过期永不唤醒）', async () => {
      const now = Date.now();
      await expect(
        svc.registerHook(
          timeInput({
            dueAt: new Date(now + 7200_000),
            expiresAt: new Date(now + 3600_000),
          }),
        ),
      ).rejects.toThrow('dueAt 必须早于 expiresAt');
    });

    it('all_idle 带 dueAt → 抛错（静默由全局 poll 评估）', async () => {
      await expect(
        svc.registerHook(
          timeInput({ kind: HOOK_KIND.ALL_IDLE, dueAt: new Date() }),
        ),
      ).rejects.toThrow('不接受 dueAt');
    });

    it('空 wakeText → 抛错', async () => {
      await expect(
        svc.registerHook(timeInput({ wakeText: '' })),
      ).rejects.toThrow('wakeText 必填');
    });

    it(`wakeText 超 ${HOOK_WAKE_TEXT_MAX} 字 → 截断落库（非拒绝）`, async () => {
      await svc.registerHook(timeInput({ wakeText: 'x'.repeat(2500) }));
      expect(txHookCreate).toHaveBeenCalledTimes(1);
      const data = txHookCreate.mock.calls[0][0].data as {
        wakeText: string;
      };
      expect(data.wakeText).toHaveLength(HOOK_WAKE_TEXT_MAX);
    });

    it('缺 expiresAt → 抛错（无无限 hook）', async () => {
      const input = timeInput();
      delete (input as Partial<RegisterHookInput>).expiresAt;
      await expect(svc.registerHook(input)).rejects.toThrow('expiresAt 必填');
    });

    it('parentHookId 悬空 → 抛错（拒绝悬空血缘）', async () => {
      await expect(
        svc.registerHook(timeInput({ parentHookId: 'hks_9999999999' })),
      ).rejects.toThrow('无对应 hook 行');
    });
  });

  describe('registerHook 落库（hook + fire 同事务）', () => {
    it('time：同 $transaction 内落 hook 行 + hook_fire 行', async () => {
      const dueAt = new Date(Date.now() + 60_000);
      const expiresAt = new Date(Date.now() + 3600_000);
      await svc.registerHook(timeInput({ dueAt, expiresAt }));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txHookCreate).toHaveBeenCalledTimes(1);
      expect(txTriggerCreate).toHaveBeenCalledTimes(1);

      const hookData = txHookCreate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(hookData['id']).toMatch(/^hks_/);
      expect(hookData['status']).toBe(HOOK_STATUS.PENDING);
      expect(hookData['dueAt']).toBe(dueAt);

      const fireData = txTriggerCreate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(fireData['id']).toMatch(/^tmr_/);
      expect(fireData['kind']).toBe('hook_fire');
      expect(fireData['dueAt']).toBe(dueAt);
      expect(fireData['payload']).toEqual({ hookId: hookData['id'] });
      expect(fireData['dedupKey']).toBe(
        buildHookFireDedupKey(hookData['id'] as string),
      );
      // 归属透传（todo-22 REST 按 agent 派生 source）
      expect(fireData['scopeType']).toBe('team');
      expect(fireData['ownerInstanceId']).toBe('tmm_1');
      // 基座 expiresAt 永不先于 handler 结算（fire 行不设，防 stranded pending）
      expect(fireData['expiresAt']).toBeUndefined();
    });

    it('all_idle：hook 行 dueAt=NULL + graceMs 落缺省，fire 行定于 expiresAt', async () => {
      const expiresAt = new Date(Date.now() + 3600_000);
      await svc.registerHook({
        scopeType: 'team',
        scopeId: 'tm_1',
        ownerInstanceId: 'tmm_1',
        kind: HOOK_KIND.ALL_IDLE,
        wakeText: 'wake when quiet',
        target: { teamId: 'tm_1', channelId: 'c_1', targetInstanceId: 'tmm_1' },
        expiresAt,
        dedupKey: 'hook:team:quiet-1',
      });

      const hookData = txHookCreate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(hookData['kind']).toBe(HOOK_KIND.ALL_IDLE);
      expect(hookData['dueAt']).toBeNull();
      expect(hookData['graceMs']).toBe(HOOK_ALL_IDLE_GRACE_MS_DEFAULT);
      const fireData = txTriggerCreate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(fireData['dueAt']).toBe(expiresAt);
    });

    it('重复 dedupKey → 幂等直返既有行（事务不跑）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      const got = await svc.registerHook(timeInput());
      expect(got).toMatchObject({ id: 'hks_0000000001' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('半写不可能：fire 行抛错 → 事务整体抛，调用方可见（Prisma 原子回滚）', async () => {
      txTriggerCreate.mockRejectedValue(new Error('db down'));
      await expect(svc.registerHook(timeInput())).rejects.toThrow('db down');
      expect(txHookCreate).toHaveBeenCalledTimes(1);
      expect(txTriggerCreate).toHaveBeenCalledTimes(1);
    });

    it('并发撞 dedup 唯一键（P2002）→ 回读胜者行幂等直返', async () => {
      prisma.hook.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(hookRow());
      txHookCreate.mockRejectedValue({ code: 'P2002' });
      const got = await svc.registerHook(timeInput());
      expect(got).toMatchObject({ id: 'hks_0000000001' });
    });
  });

  describe('registerHook 血缘（parentHookId/rootTaskId）', () => {
    it('被唤醒轮内续注册：parentHookId 落行 + rootTaskId 继承（不重置）', async () => {
      const parent = hookRow({
        id: 'hks_0000000007',
        rootTaskId: 't_origin',
        target: {
          taskId: 't_other',
          teamId: 'tm_1',
          channelId: 'c_1',
          targetInstanceId: 'tmm_1',
        },
      });
      prisma.hook.findUnique.mockImplementation(
        async ({ where }: { where: Record<string, string> }) => {
          if (where['dedupKey']) return null;
          if (where['id'] === 'hks_0000000007') return parent;
          return null;
        },
      );
      await svc.registerHook(
        timeInput({
          dedupKey: 'hook:team:child-1',
          parentHookId: 'hks_0000000007',
          target: {
            taskId: 't_new',
            teamId: 'tm_1',
            channelId: 'c_1',
            targetInstanceId: 'tmm_1',
          },
        }),
      );
      const data = txHookCreate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['parentHookId']).toBe('hks_0000000007');
      // 父链 rootTaskId=t_origin 被继承，而非本次 target 的 t_new
      expect(data['rootTaskId']).toBe('t_origin');
    });

    it('首 hook 无 parent：rootTaskId 取 target.taskId', async () => {
      await svc.registerHook(timeInput());
      const data = txHookCreate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['parentHookId']).toBeNull();
      expect(data['rootTaskId']).toBe('t_1');
    });
  });

  describe('handleHookFire（time 到期唤醒）', () => {
    const fireCtx = (hookId: string) => ({
      id: 'tmr_0000000001',
      kind: 'hook_fire',
      payload: { hookId },
    });

    it('到点 + 目标完好 + 空闲 → wake 分派（kind:wake，前缀 [hook:time id]），hook 落 fired', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      mockTargetOk();

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toEqual({ done: true });
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = dispatcher.dispatchAgentMention.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(call['kind']).toBe('wake');
      expect(call['taskId']).toBe('t_1');
      expect(call['targetInstanceId']).toBe('tmm_1');
      expect(call['text']).toMatch(/^\[hook:time hks_0000000001\] /);
      expect(prisma.hook.update).toHaveBeenCalledWith({
        where: { id: 'hks_0000000001' },
        data: { status: HOOK_STATUS.FIRED, fireCount: { increment: 1 } },
      });
    });

    it('行缺失 / 已 cancelled → no-op（cancelled hook 永不触发）', async () => {
      prisma.hook.findUnique.mockResolvedValueOnce(null);
      await expect(svc.handleHookFire(fireCtx('hks_x'))).resolves.toEqual({
        done: true,
      });
      prisma.hook.findUnique.mockResolvedValueOnce(
        hookRow({ status: HOOK_STATUS.CANCELLED }),
      );
      await expect(
        svc.handleHookFire(fireCtx('hks_0000000001')),
      ).resolves.toEqual({
        done: true,
      });
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('已过期（now >= expiresAt）→ expired + lastError，不分派', async () => {
      prisma.hook.findUnique.mockResolvedValue(
        hookRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(
        svc.handleHookFire(fireCtx('hks_0000000001')),
      ).resolves.toEqual({
        done: true,
      });
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.hook.update).toHaveBeenCalledWith({
        where: { id: 'hks_0000000001' },
        data: expect.objectContaining({ status: HOOK_STATUS.EXPIRED }),
      });
    });

    it.each([
      ['任务归档', { task: { status: 'archived', teamId: 'tm_1' } }],
      ['任务删除', { task: null }],
      ['成员删除', { member: null }],
      ['会话重置缺失', { session: null }],
    ])(
      'stale_state：%s → expired（永不抛，永不静默消失）',
      async (_label, fix) => {
        prisma.hook.findUnique.mockResolvedValue(hookRow());
        prisma.task.findUnique.mockResolvedValue(
          'task' in fix ? fix.task : { status: 'in_progress', teamId: 'tm_1' },
        );
        prisma.teamMember.findUnique.mockResolvedValue(
          'member' in fix ? fix.member : { id: 'tmm_1', teamId: 'tm_1' },
        );
        prisma.session.findFirst.mockResolvedValue(
          'session' in fix
            ? fix.session
            : { id: 's_1', status: 'idle', workerId: null },
        );
        await expect(
          svc.handleHookFire(fireCtx('hks_0000000001')),
        ).resolves.toEqual({
          done: true,
        });
        expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
        const update = prisma.hook.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(update.data['status']).toBe(HOOK_STATUS.EXPIRED);
        expect(update.data['lastError']).toBeTruthy();
      },
    );

    it('busy（首字等待中）→ 否决：不分派 + skipReason 落库 + 重排（非 expired）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      mockTargetOk();
      dispatcher.isSessionPending.mockReturnValue(true);

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(out).toHaveProperty('rescheduleAt');
      const skipWrite = prisma.hook.update.mock.calls.find(
        ([args]: [{ data: Record<string, unknown> }]) =>
          'skipReason' in args.data,
      );
      expect(skipWrite).toBeTruthy();
      expect(
        (skipWrite as unknown as [{ data: { skipReason: string } }])[0].data
          .skipReason,
      ).toMatch(/veto/);
    });

    it('busy 且重试越过 expiresAt → 改判 expired（触发器基座永不先取消）', async () => {
      prisma.hook.findUnique.mockResolvedValue(
        hookRow({ expiresAt: new Date(Date.now() + 1000) }),
      );
      mockTargetOk();
      dispatcher.isSessionPending.mockReturnValue(true);

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toEqual({ done: true });
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      const last = prisma.hook.update.mock.calls.at(-1)[0] as {
        data: Record<string, unknown>;
      };
      expect(last.data['status']).toBe(HOOK_STATUS.EXPIRED);
    });

    it('all_idle 的 fire 兜底行 → no-op（唤醒权在全局 poll）', async () => {
      prisma.hook.findUnique.mockResolvedValue(
        hookRow({ kind: HOOK_KIND.ALL_IDLE, dueAt: null }),
      );
      await expect(
        svc.handleHookFire(fireCtx('hks_0000000001')),
      ).resolves.toEqual({
        done: true,
      });
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.hook.update).not.toHaveBeenCalled();
    });

    it('wake 分派抛错 → lastError 落库 + 重排（永不抛）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      mockTargetOk();
      dispatcher.dispatchAgentMention.mockRejectedValue(new Error('no worker'));

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toHaveProperty('rescheduleAt');
      const last = prisma.hook.update.mock.calls.at(-1)[0] as {
        data: Record<string, unknown>;
      };
      expect(last.data['lastError']).toMatch(/wake 分派失败/);
    });
  });

  describe('handleHookPoll（全局统一扫描，非 per-hook 轮询）', () => {
    const quietHook = (over: Record<string, unknown> = {}) =>
      hookRow({
        id: 'hks_0000000001',
        kind: HOOK_KIND.ALL_IDLE,
        dueAt: null,
        graceMs: 1000,
        ...over,
      });

    it('scope 静默 + 目标完好 + 空闲 → 唤醒且同 tick 至多 ONE 个', async () => {
      const second = quietHook({
        id: 'hks_0000000002',
        dedupKey: 'hook:team:q2',
      });
      prisma.hook.findMany.mockResolvedValue([quietHook(), second]);
      // scope 零 running：最近活动 1h 前，grace=1s → 静默
      prisma.session.findMany.mockResolvedValue([
        { status: 'idle', lastActivityAt: new Date(Date.now() - 3600_000) },
      ]);
      mockTargetOk();

      const out = await svc.handleHookPoll();

      expect(out).toEqual({ done: true });
      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = dispatcher.dispatchAgentMention.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(call['kind']).toBe('wake');
      expect(call['text']).toMatch(/^\[hook:all_idle hks_0000000001\] /);
      // 首个落 fired，第二个留 pending（排队等下轮）
      const fired = prisma.hook.update.mock.calls.filter(
        ([args]: [{ data: Record<string, unknown> }]) =>
          args.data['status'] === HOOK_STATUS.FIRED,
      );
      expect(fired).toHaveLength(1);
      expect(fired[0][0]).toMatchObject({ where: { id: 'hks_0000000001' } });
      // 唤醒后配套 fire 兜底行被 cancel
      expect(triggers.cancel).toHaveBeenCalledWith(
        buildHookFireDedupKey('hks_0000000001'),
      );
      expect(triggers.cancel).not.toHaveBeenCalledWith(
        buildHookFireDedupKey('hks_0000000002'),
      );
    });

    it('scope 内有 running 会话 → 非静默：不唤醒零写库', async () => {
      prisma.hook.findMany.mockResolvedValue([quietHook()]);
      prisma.session.findMany.mockResolvedValue([
        { status: 'running', lastActivityAt: new Date() },
      ]);

      await svc.handleHookPoll();

      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.hook.update).not.toHaveBeenCalled();
    });

    it('grace 未满（刚活跃 1s 前，宽限 4min 缺省）→ 不唤醒', async () => {
      prisma.hook.findMany.mockResolvedValue([
        quietHook({ graceMs: HOOK_ALL_IDLE_GRACE_MS_DEFAULT }),
      ]);
      prisma.session.findMany.mockResolvedValue([
        { status: 'idle', lastActivityAt: new Date(Date.now() - 1000) },
      ]);

      await svc.handleHookPoll();

      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('否决：首个 mid-turn（activeExecutions 命中）→ skipReason 落库并继续，第二个被唤醒', async () => {
      const second = quietHook({
        id: 'hks_0000000002',
        dedupKey: 'hook:team:q2',
      });
      prisma.hook.findMany.mockResolvedValue([quietHook(), second]);
      prisma.session.findMany.mockResolvedValue([
        { status: 'idle', lastActivityAt: new Date(Date.now() - 3600_000) },
      ]);
      mockTargetOk();
      // resolve（findFirst 第1/3/5…次）与 busy 检查（第2/4/6…次）交替调用：
      // 首 hook busy（running），次 hook 空闲
      let n = 0;
      prisma.session.findFirst.mockImplementation(async () => {
        n += 1;
        const busyTurn = n <= 2;
        return busyTurn
          ? { id: 's_1', status: 'running', workerId: 'w_1' }
          : { id: 's_2', status: 'idle', workerId: null };
      });

      await svc.handleHookPoll();

      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const call = dispatcher.dispatchAgentMention.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(call['text']).toMatch(/hks_0000000002/);
      const skipWrite = prisma.hook.update.mock.calls.find(
        ([args]: [{ data: Record<string, unknown> }]) =>
          'skipReason' in args.data,
      );
      expect(skipWrite).toBeTruthy();
      expect(
        (skipWrite as unknown as [{ where: { id: string } }])[0].where.id,
      ).toBe('hks_0000000001');
    });

    it('目标失效（任务归档）→ expired 并继续扫下一个', async () => {
      const second = quietHook({
        id: 'hks_0000000002',
        dedupKey: 'hook:team:q2',
      });
      prisma.hook.findMany.mockResolvedValue([quietHook(), second]);
      prisma.session.findMany.mockResolvedValue([]);
      prisma.task.findUnique.mockResolvedValueOnce({
        status: 'archived',
        teamId: 'tm_1',
      });
      prisma.task.findUnique.mockResolvedValue({
        status: 'in_progress',
        teamId: 'tm_1',
      });
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'tmm_1',
        teamId: 'tm_1',
      });
      prisma.session.findFirst.mockResolvedValue({
        id: 's_2',
        status: 'idle',
        workerId: null,
      });

      await svc.handleHookPoll();

      expect(dispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      const expired = prisma.hook.update.mock.calls.filter(
        ([args]: [{ data: Record<string, unknown> }]) =>
          args.data['status'] === HOOK_STATUS.EXPIRED,
      );
      expect(expired).toHaveLength(1);
      expect(expired[0][0]).toMatchObject({ where: { id: 'hks_0000000001' } });
    });
  });

  describe('cancelHook / expireTaskHooks', () => {
    it('pending → cancelled + 配套 fire 行 cancel', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      await svc.cancelHook('hks_0000000001');
      expect(prisma.hook.update).toHaveBeenCalledWith({
        where: { id: 'hks_0000000001' },
        data: { status: HOOK_STATUS.CANCELLED },
      });
      expect(triggers.cancel).toHaveBeenCalledWith(
        buildHookFireDedupKey('hks_0000000001'),
      );
    });

    it('已终态行 → 幂等直返（fire 行不动）', async () => {
      prisma.hook.findUnique.mockResolvedValue(
        hookRow({ status: HOOK_STATUS.FIRED }),
      );
      const got = await svc.cancelHook('hks_0000000001');
      expect(got).toMatchObject({ status: HOOK_STATUS.FIRED });
      expect(triggers.cancel).not.toHaveBeenCalled();
    });

    it('未知 id → 抛错（todo-12 映射 404）', async () => {
      await expect(svc.cancelHook('hks_nope')).rejects.toThrow('不存在');
    });

    it('expireTaskHooks：按 rootTaskId 标 expired（只标不删，返回计数）', async () => {
      prisma.hook.updateMany.mockResolvedValue({ count: 3 });
      await expect(svc.expireTaskHooks('t_1')).resolves.toBe(3);
      expect(prisma.hook.updateMany).toHaveBeenCalledWith({
        where: { rootTaskId: 't_1', status: HOOK_STATUS.PENDING },
        data: expect.objectContaining({ status: HOOK_STATUS.EXPIRED }),
      });
    });
  });

  describe('todo-20 trigger 生命周期可观测事件（fired/expired/skipped）', () => {
    const fireCtx = (hookId: string) => ({
      id: 'tmr_0000000001',
      kind: 'hook_fire',
      payload: { hookId },
    });

    it('成功唤醒 → trigger.fired（含 hookId/kind/归属/owner，team scope）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      prisma.hook.update.mockResolvedValueOnce(hookRow());
      mockTargetOk();

      await expect(
        svc.handleHookFire(fireCtx('hks_0000000001')),
      ).resolves.toEqual({
        done: true,
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.TRIGGER_FIRED,
        expect.objectContaining({
          hookId: 'hks_0000000001',
          kind: HOOK_KIND.TIME,
          scopeType: 'team',
          scopeId: 'tm_1',
          ownerInstanceId: 'tmm_1',
          status: HOOK_STATUS.FIRED,
        }),
        { type: 'team', id: 'tm_1' },
      );
    });

    it('首轮 busy 否决 → trigger.skipped（skipReason+busyRetries=1 落库并发射）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow({ busyRetries: 0 }));
      mockTargetOk();
      dispatcher.isSessionPending.mockReturnValue(true);

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toHaveProperty('rescheduleAt');
      const skipWrite = prisma.hook.update.mock.calls.find(
        ([args]: [{ data: Record<string, unknown> }]) =>
          'skipReason' in args.data,
      );
      expect(skipWrite).toBeTruthy();
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.TRIGGER_SKIPPED,
        expect.objectContaining({
          hookId: 'hks_0000000001',
          skipReason: expect.stringMatching(/veto/),
          busyRetries: 1,
        }),
        { type: 'team', id: 'tm_1' },
      );
    });

    it('重复否决只写列不重发（poll 每 tick 否决有界，不刷屏）', async () => {
      mockTargetOk();
      dispatcher.isSessionPending.mockReturnValue(true);
      prisma.hook.findUnique.mockResolvedValue(hookRow({ busyRetries: 0 }));
      await svc.handleHookFire(fireCtx('hks_0000000001'));
      expect(realtime.emit).toHaveBeenCalledTimes(1);

      prisma.hook.findUnique.mockResolvedValue(hookRow({ busyRetries: 1 }));
      await svc.handleHookFire(fireCtx('hks_0000000001'));
      expect(realtime.emit).toHaveBeenCalledTimes(1);
      const skipWrites = prisma.hook.update.mock.calls.filter(
        ([args]: [{ data: Record<string, unknown> }]) =>
          'skipReason' in args.data,
      );
      expect(skipWrites).toHaveLength(2);
    });

    it('超时过期 → trigger.expired + settleHook 同写 skipReason（UI 可读）', async () => {
      prisma.hook.findUnique.mockResolvedValue(
        hookRow({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        svc.handleHookFire(fireCtx('hks_0000000001')),
      ).resolves.toEqual({
        done: true,
      });
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      const settled = prisma.hook.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(settled.data['status']).toBe(HOOK_STATUS.EXPIRED);
      expect(settled.data['skipReason']).toBeTruthy();
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.TRIGGER_EXPIRED,
        expect.objectContaining({
          hookId: 'hks_0000000001',
          skipReason: expect.any(String),
        }),
        { type: 'team', id: 'tm_1' },
      );
    });

    it('目标非法（任务删除）→ trigger.expired + skipReason 落库', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      prisma.task.findUnique.mockResolvedValue(null);
      prisma.teamMember.findUnique.mockResolvedValue({
        id: 'tmm_1',
        teamId: 'tm_1',
      });
      prisma.session.findFirst.mockResolvedValue({
        id: 's_1',
        status: 'idle',
        workerId: null,
      });

      await expect(
        svc.handleHookFire(fireCtx('hks_0000000001')),
      ).resolves.toEqual({
        done: true,
      });
      const settled = prisma.hook.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(settled.data['status']).toBe(HOOK_STATUS.EXPIRED);
      expect(settled.data['skipReason']).toMatch(/已删除/);
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.TRIGGER_EXPIRED,
        expect.objectContaining({ hookId: 'hks_0000000001' }),
        { type: 'team', id: 'tm_1' },
      );
    });

    it('stale_state：已终态行 no-op → 零发射（不 double-emit）', async () => {
      prisma.hook.findUnique.mockResolvedValue(
        hookRow({ status: HOOK_STATUS.FIRED }),
      );
      await expect(
        svc.handleHookFire(fireCtx('hks_0000000001')),
      ).resolves.toEqual({
        done: true,
      });
      expect(realtime.emit).not.toHaveBeenCalled();
      expect(prisma.hook.update).not.toHaveBeenCalled();
    });

    it('分派失败重试（lastError 路径）→ 不发 skipped（只写列，终态才发 expired）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow({ busyRetries: 0 }));
      mockTargetOk();
      dispatcher.dispatchAgentMention.mockRejectedValue(new Error('no worker'));

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toHaveProperty('rescheduleAt');
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('事件落库失败 → 行终态照结算（可观测永不阻断唤醒）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      prisma.hook.update.mockResolvedValueOnce(hookRow());
      mockTargetOk();
      realtime.emit.mockRejectedValueOnce(new Error('db down'));

      await expect(
        svc.handleHookFire(fireCtx('hks_0000000001')),
      ).resolves.toEqual({
        done: true,
      });
      expect(prisma.hook.update).toHaveBeenCalledWith({
        where: { id: 'hks_0000000001' },
        data: { status: HOOK_STATUS.FIRED, fireCount: { increment: 1 } },
      });
    });

    it('expireTaskHooks 批量结算同写 skipReason（UI 读路径全覆盖）', async () => {
      prisma.hook.updateMany.mockResolvedValue({ count: 2 });
      await expect(svc.expireTaskHooks('t_1')).resolves.toBe(2);
      expect(prisma.hook.updateMany).toHaveBeenCalledWith({
        where: { rootTaskId: 't_1', status: HOOK_STATUS.PENDING },
        data: expect.objectContaining({
          status: HOOK_STATUS.EXPIRED,
          skipReason: expect.any(String),
        }),
      });
    });
  });

  describe('onModuleInit（hks_ 续号 + handler 接线 + 全局 poll 确保）', () => {
    it('注册 hook_fire + hook_poll handler，缺失 poll 行时 schedule interval 行', async () => {
      prisma.hook.findMany.mockResolvedValue([]);
      prisma.trigger.findUnique.mockResolvedValue(null);

      await svc.onModuleInit();

      // hks_ 前缀续号扫描
      expect(prisma.hook.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'hks_' } },
        select: { id: true },
      });
      // tmr_ 自助续号（跨模块 onModuleInit 无序防御，live 抓到 colliding id）
      expect(prisma.trigger.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'tmr_' } },
        select: { id: true },
      });
      const kinds = triggers.registerHandler.mock.calls.map(
        ([kind]: [string]) => kind,
      );
      expect(kinds).toEqual(expect.arrayContaining(['hook_fire', 'hook_poll']));
      expect(triggers.schedule).toHaveBeenCalledWith(
        'hook_poll',
        expect.any(Date),
        expect.objectContaining({ scope: 'global' }),
        HOOK_POLL_DEDUP_KEY,
        { intervalMs: expect.any(Number) },
      );
    });

    it('poll 行 pending 已存在 → 不重建', async () => {
      prisma.hook.findMany.mockResolvedValue([]);
      prisma.trigger.findUnique.mockResolvedValue({ status: 'pending' });

      await svc.onModuleInit();

      expect(triggers.schedule).not.toHaveBeenCalled();
    });
  });

  describe('guardrails（todo-19 anti-runaway，全部 loud 拒绝/显式结算）', () => {
    const fireCtx = (hookId: string) => ({
      id: 'tmr_0000000001',
      kind: 'hook_fire',
      payload: { hookId },
    });

    /** hook.findMany 按查询意图分流（scope 上限 vs task 预算 vs poll 扫描）。 */
    const mockHookFindMany = (opts: {
      scopePeers?: Array<Record<string, unknown>>;
      lineage?: Array<Record<string, unknown>>;
      pollBatch?: Array<Record<string, unknown>>;
    }) => {
      prisma.hook.findMany.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) => {
          if (where && 'scopeType' in where) return opts.scopePeers ?? [];
          if (where && 'rootTaskId' in where) return opts.lineage ?? [];
          return opts.pollBatch ?? [];
        },
      );
    };

    const lineageRows = (n: number, over: Record<string, unknown> = {}) =>
      Array.from({ length: n }, (_, i) => ({ id: `hks_line_${i}`, ...over }));

    it('guardrail #1：time 延迟 30s（<60s）→ 显式拒绝', async () => {
      await expect(
        svc.registerHook(
          timeInput({
            dueAt: new Date(Date.now() + 30_000),
            expiresAt: new Date(Date.now() + 3600_000),
          }),
        ),
      ).rejects.toThrow('延迟过短');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('malformed_input：dueAt 已过去（负延迟）→ 显式拒绝', async () => {
      await expect(
        svc.registerHook(
          timeInput({
            dueAt: new Date(Date.now() - 10_000),
            expiresAt: new Date(Date.now() + 3600_000),
          }),
        ),
      ).rejects.toThrow('延迟过短');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('guardrail #2a：all_idle expiresAt 已过去 → 显式拒绝', async () => {
      await expect(
        svc.registerHook({
          scopeType: 'team',
          scopeId: 'tm_1',
          ownerInstanceId: 'tmm_1',
          kind: HOOK_KIND.ALL_IDLE,
          wakeText: 'stale hook',
          target: {
            teamId: 'tm_1',
            channelId: 'c_1',
            targetInstanceId: 'tmm_1',
          },
          expiresAt: new Date(Date.now() - 1000),
          dedupKey: 'hook:team:stale-1',
        }),
      ).rejects.toThrow('expiresAt 已过去');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('malformed_input：ttl 8d（>7d 上界）→ 显式拒绝', async () => {
      await expect(
        svc.registerHook(
          timeInput({
            dueAt: new Date(Date.now() + 120_000),
            expiresAt: new Date(Date.now() + 8 * 24 * 3600_000),
          }),
        ),
      ).rejects.toThrow('超上界');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('guardrail #2b：ttl 6d（<7d 上界）→ 放行且 busyRetries=0 落库', async () => {
      mockHookFindMany({});
      await svc.registerHook(
        timeInput({
          dueAt: new Date(Date.now() + 120_000),
          expiresAt: new Date(Date.now() + 6 * 24 * 3600_000),
          dedupKey: 'hook:team:ttl-ok',
        }),
      );
      const data = txHookCreate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['busyRetries']).toBe(0);
    });

    it('guardrail #3：同 scope 20 个 pending → 第 21 个显式拒绝', async () => {
      mockHookFindMany({ scopePeers: lineageRows(20) });
      await expect(
        svc.registerHook(
          timeInput({
            dueAt: new Date(Date.now() + 120_000),
            dedupKey: 'hook:team:cap-hit',
          }),
        ),
      ).rejects.toThrow('已满');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('guardrail #3：不同 scope 不受 cap 牵连 → 放行', async () => {
      mockHookFindMany({ scopePeers: [] });
      await svc.registerHook(
        timeInput({
          scopeId: 'tm_other',
          dueAt: new Date(Date.now() + 120_000),
          dedupKey: 'hook:team:cap-other',
        }),
      );
      expect(txHookCreate).toHaveBeenCalledTimes(1);
    });

    it('guardrail #4：同 task fired+pending 已满 5 → 第 6 个显式拒绝', async () => {
      mockHookFindMany({ lineage: lineageRows(5) });
      await expect(
        svc.registerHook(
          timeInput({
            dueAt: new Date(Date.now() + 120_000),
            dedupKey: 'hook:team:budget-hit',
          }),
        ),
      ).rejects.toThrow('预算耗尽');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('guardrail #4：同 task 仅 4 行 → 放行', async () => {
      mockHookFindMany({ lineage: lineageRows(4) });
      await svc.registerHook(
        timeInput({
          dueAt: new Date(Date.now() + 120_000),
          dedupKey: 'hook:team:budget-ok',
        }),
      );
      expect(txHookCreate).toHaveBeenCalledTimes(1);
    });

    it('guardrail #5a：同任务 A↔B 对穿（A 唤 B 后 B 唤 A）→ 显式拒绝', async () => {
      const h1 = hookRow({
        id: 'hks_0000000007',
        ownerInstanceId: 'tmm_A',
        target: {
          taskId: 't_1',
          teamId: 'tm_1',
          channelId: 'c_1',
          targetInstanceId: 'tmm_B',
        },
        rootTaskId: 't_1',
        wakeText: 'ping from agent A, please continue the work',
      });
      prisma.hook.findUnique.mockImplementation(
        async ({ where }: { where: Record<string, string> }) => {
          if (where['dedupKey']) return null;
          if (where['id'] === 'hks_0000000007') return h1;
          return null;
        },
      );
      mockHookFindMany({});
      await expect(
        svc.registerHook(
          timeInput({
            ownerInstanceId: 'tmm_B',
            target: {
              taskId: 't_1',
              teamId: 'tm_1',
              channelId: 'c_1',
              targetInstanceId: 'tmm_A',
            },
            dueAt: new Date(Date.now() + 120_000),
            expiresAt: new Date(Date.now() + 3600_000),
            dedupKey: 'hook:team:pong',
            parentHookId: 'hks_0000000007',
          }),
        ),
      ).rejects.toThrow('对穿环');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('guardrail #5b：跨任务复读（team 域无 task，owner/target 回显 + 唤醒词相似）→ 显式拒绝', async () => {
      const h1 = hookRow({
        id: 'hks_0000000007',
        scopeType: 'team',
        ownerInstanceId: 'tmm_A',
        target: { teamId: 'tm_1', channelId: 'c_1', targetInstanceId: 'tmm_B' },
        rootTaskId: null,
        wakeText: 'please review the pipeline status update',
      });
      prisma.hook.findUnique.mockImplementation(
        async ({ where }: { where: Record<string, string> }) => {
          if (where['dedupKey']) return null;
          if (where['id'] === 'hks_0000000007') return h1;
          return null;
        },
      );
      mockHookFindMany({});
      await expect(
        svc.registerHook(
          timeInput({
            ownerInstanceId: 'tmm_B',
            target: {
              teamId: 'tm_1',
              channelId: 'c_1',
              targetInstanceId: 'tmm_A',
            },
            dueAt: new Date(Date.now() + 120_000),
            expiresAt: new Date(Date.now() + 3600_000),
            dedupKey: 'hook:team:cross-echo',
            parentHookId: 'hks_0000000007',
            wakeText: 'please review the pipeline status update — pong',
          }),
        ),
      ).rejects.toThrow('复读环');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('no-false-positive：合法新任务（无 parent + 文本不同）不受旧任务预算牵连', async () => {
      // 旧任务 t_old 纵有 5 行满预算，新任务 t_new 的 lineage 为空 → 放行。
      prisma.hook.findMany.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) => {
          if (where && 'scopeType' in where) return [];
          if (where && 'rootTaskId' in where) {
            return (where as { rootTaskId: string }).rootTaskId === 't_old'
              ? lineageRows(5)
              : [];
          }
          return [];
        },
      );
      await svc.registerHook(
        timeInput({
          target: {
            taskId: 't_new',
            teamId: 'tm_1',
            channelId: 'c_1',
            targetInstanceId: 'tmm_1',
          },
          dueAt: new Date(Date.now() + 120_000),
          expiresAt: new Date(Date.now() + 3600_000),
          dedupKey: 'hook:team:fresh-task',
          wakeText: 'brand new reminder for the new task only',
        }),
      );
      const data = txHookCreate.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data['rootTaskId']).toBe('t_new');
    });

    it('stale_state：expired 旧链 + 不同目标 + 不同文本的新注册 → 不误伤', async () => {
      const hOld = hookRow({
        id: 'hks_0000000007',
        status: HOOK_STATUS.EXPIRED,
        ownerInstanceId: 'tmm_1',
        target: {
          taskId: 't_old',
          teamId: 'tm_1',
          channelId: 'c_1',
          targetInstanceId: 'tmm_1',
        },
        rootTaskId: 't_old',
        wakeText: 'old reminder from the archived task run',
      });
      prisma.hook.findUnique.mockImplementation(
        async ({ where }: { where: Record<string, string> }) => {
          if (where['dedupKey']) return null;
          if (where['id'] === 'hks_0000000007') return hOld;
          return null;
        },
      );
      mockHookFindMany({});
      await svc.registerHook(
        timeInput({
          target: {
            taskId: 't_new',
            teamId: 'tm_1',
            channelId: 'c_1',
            targetInstanceId: 'tmm_1',
          },
          dueAt: new Date(Date.now() + 120_000),
          expiresAt: new Date(Date.now() + 3600_000),
          dedupKey: 'hook:team:stale-ok',
          parentHookId: 'hks_0000000007',
          wakeText: 'completely different fresh reminder text here',
        }),
      );
      expect(txHookCreate).toHaveBeenCalledTimes(1);
    });

    it('guardrail #6a：busy 否决递增 busyRetries（0→1）+ skipReason 照写 + 重排', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow({ busyRetries: 0 }));
      mockHookFindMany({ lineage: lineageRows(1) });
      mockTargetOk();
      dispatcher.isSessionPending.mockReturnValue(true);

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toHaveProperty('rescheduleAt');
      const retryWrite = prisma.hook.update.mock.calls.find(
        ([args]: [{ data: Record<string, unknown> }]) =>
          'skipReason' in args.data && 'busyRetries' in args.data,
      );
      expect(retryWrite).toBeTruthy();
      expect(
        (retryWrite as unknown as [{ data: { busyRetries: unknown } }])[0].data
          .busyRetries,
      ).toEqual({ increment: 1 });
    });

    it('guardrail #6b：busy 重试梯满 10 次（9→10）→ 改判 expired，不重排', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow({ busyRetries: 9 }));
      mockHookFindMany({ lineage: lineageRows(1) });
      mockTargetOk();
      dispatcher.isSessionPending.mockReturnValue(true);

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toEqual({ done: true });
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      const last = prisma.hook.update.mock.calls.at(-1)[0] as {
        data: Record<string, unknown>;
      };
      expect(last.data['status']).toBe(HOOK_STATUS.EXPIRED);
      expect(last.data['lastError']).toMatch(/重试满 10 次/);
    });

    it('guardrail #4-fire 侧：lineage 超预算（6>5）→ 改判 expired，不分派', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow({ busyRetries: 0 }));
      mockHookFindMany({ lineage: lineageRows(6) });
      mockTargetOk();

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toEqual({ done: true });
      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      const last = prisma.hook.update.mock.calls.at(-1)[0] as {
        data: Record<string, unknown>;
      };
      expect(last.data['status']).toBe(HOOK_STATUS.EXPIRED);
      expect(last.data['lastError']).toMatch(/预算耗尽/);
    });

    it('guardrail #6-poll 侧：busy 梯满 10 次 → 改判 expired（否决仍写 skipReason）', async () => {
      const hook = hookRow({
        id: 'hks_0000000001',
        kind: HOOK_KIND.ALL_IDLE,
        dueAt: null,
        graceMs: 1000,
        busyRetries: 9,
      });
      prisma.hook.findMany.mockImplementation(
        async ({ where }: { where: Record<string, unknown> }) => {
          if (where && 'rootTaskId' in where) return lineageRows(1);
          return [hook];
        },
      );
      prisma.session.findMany.mockResolvedValue([
        { status: 'idle', lastActivityAt: new Date(Date.now() - 3600_000) },
      ]);
      mockTargetOk();
      dispatcher.isSessionPending.mockReturnValue(true);

      await svc.handleHookPoll();

      expect(dispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      const skipWrite = prisma.hook.update.mock.calls.find(
        ([args]: [{ data: Record<string, unknown> }]) =>
          'skipReason' in args.data,
      );
      expect(skipWrite).toBeTruthy();
      const last = prisma.hook.update.mock.calls.at(-1)[0] as {
        data: Record<string, unknown>;
      };
      expect(last.data['status']).toBe(HOOK_STATUS.EXPIRED);
    });
  });

  describe('wake 失败记录（wakeSessionId 回写 + recordWakeFailure 认领）', () => {
    const fireCtx = (hookId: string) => ({
      id: 'tmr_0000000001',
      kind: 'hook_fire',
      payload: { hookId },
    });

    it('dispatchAgentMention 返回会话主键 → 回写 target.wakeSessionId（保留既有键）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      prisma.hook.update.mockResolvedValue(hookRow());
      mockTargetOk();
      dispatcher.dispatchAgentMention.mockResolvedValue('s_0000000018');

      await svc.handleHookFire(fireCtx('hks_0000000001'));

      const targetWrite = prisma.hook.update.mock.calls.find(
        ([args]: [{ data: Record<string, unknown> }]) => 'target' in args.data,
      );
      expect(targetWrite).toBeTruthy();
      expect(
        (
          targetWrite as unknown as [
            { data: { target: Record<string, unknown> } },
          ]
        )[0].data.target,
      ).toEqual({
        taskId: 't_1',
        teamId: 'tm_1',
        channelId: 'c_1',
        targetInstanceId: 'tmm_1',
        wakeSessionId: 's_0000000018',
      });
    });

    it('分派返回缺失（旧实现/异常路径）→ 不写 target（fired 照落）', async () => {
      prisma.hook.findUnique.mockResolvedValue(hookRow());
      prisma.hook.update.mockResolvedValue(hookRow());
      mockTargetOk();
      dispatcher.dispatchAgentMention.mockResolvedValue(undefined);

      const out = await svc.handleHookFire(fireCtx('hks_0000000001'));

      expect(out).toEqual({ done: true });
      const targetWrite = prisma.hook.update.mock.calls.find(
        ([args]: [{ data: Record<string, unknown> }]) => 'target' in args.data,
      );
      expect(targetWrite).toBeUndefined();
      expect(prisma.hook.update).toHaveBeenCalledWith({
        where: { id: 'hks_0000000001' },
        data: { status: HOOK_STATUS.FIRED, fireCount: { increment: 1 } },
      });
    });

    it('parseHookTarget 往返：wakeSessionId 生存 + 非法键/存量行安全降级', () => {
      const parsed = parseHookTarget({
        taskId: 't_1',
        teamId: 'tm_1',
        channelId: 'c_1',
        targetInstanceId: 'tmm_1',
        wakeSessionId: 's_1',
        unknownKey: 'ignored',
      });
      expect(parsed).toEqual({
        taskId: 't_1',
        teamId: 'tm_1',
        channelId: 'c_1',
        targetInstanceId: 'tmm_1',
        wakeSessionId: 's_1',
      });
      expect(
        parseHookTarget({ channelId: 'c_1', targetInstanceId: 't' }),
      ).toEqual({
        taskId: null,
        teamId: null,
        channelId: 'c_1',
        targetInstanceId: 't',
        wakeSessionId: null,
      });
      expect(
        parseHookTarget({
          channelId: 'c_1',
          targetInstanceId: 't',
          wakeSessionId: 42,
        })?.wakeSessionId,
      ).toBeNull();
      expect(parseHookTarget(null)).toBeNull();
    });

    it('recordWakeFailure：命中 fired hook + wakeSessionId → 记 hook/trigger/事件', async () => {
      prisma.hook.findFirst.mockResolvedValue(
        hookRow({ status: HOOK_STATUS.FIRED }),
      );
      prisma.hook.updateMany.mockResolvedValue({ count: 1 });
      prisma.trigger.updateMany.mockResolvedValue({ count: 1 });

      const ok = await svc.recordWakeFailure({
        sessionId: 's_0000000018',
        reason: 'Rate limit exceeded',
      });

      expect(ok).toBe(true);
      expect(prisma.hook.findFirst).toHaveBeenCalledWith({
        where: {
          status: HOOK_STATUS.FIRED,
          target: { path: '$.wakeSessionId', equals: 's_0000000018' },
        },
      });
      expect(prisma.hook.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'hks_0000000001',
          status: HOOK_STATUS.FIRED,
          lastError: null,
        },
        data: {
          lastError: 'Rate limit exceeded',
          skipReason: 'Rate limit exceeded',
        },
      });
      expect(prisma.trigger.updateMany).toHaveBeenCalledWith({
        where: { dedupKey: buildHookFireDedupKey('hks_0000000001') },
        data: {
          lastError: 'Rate limit exceeded',
          skipReason: 'Rate limit exceeded',
        },
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        'trigger.wake.failed',
        expect.objectContaining({
          hookId: 'hks_0000000001',
          wakeSessionId: 's_0000000018',
          status: HOOK_STATUS.FIRED,
        }),
        { type: 'team', id: 'tm_1' },
      );
    });

    it('recordWakeFailure：查无 hook → false，零写库零事件', async () => {
      prisma.hook.findFirst.mockResolvedValue(null);

      const ok = await svc.recordWakeFailure({
        sessionId: 's_rotated',
        reason: 'x',
      });

      expect(ok).toBe(false);
      expect(prisma.hook.updateMany).not.toHaveBeenCalled();
      expect(prisma.trigger.updateMany).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('recordWakeFailure：重复事件（认领 count=0）→ false，不写 trigger/事件', async () => {
      prisma.hook.findFirst.mockResolvedValue(
        hookRow({ status: HOOK_STATUS.FIRED }),
      );
      prisma.hook.updateMany.mockResolvedValue({ count: 0 });

      const ok = await svc.recordWakeFailure({ sessionId: 's_1', reason: 'x' });

      expect(ok).toBe(false);
      expect(prisma.trigger.updateMany).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    it('recordWakeFailure：DB 抛错 → false（永不抛，fired 不回滚）', async () => {
      prisma.hook.findFirst.mockRejectedValue(new Error('db down'));

      await expect(
        svc.recordWakeFailure({ sessionId: 's_1', reason: 'x' }),
      ).resolves.toBe(false);
    });
  });
});
