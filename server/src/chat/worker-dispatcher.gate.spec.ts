import { ArtifactsService } from '../artifacts/artifacts.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkerEventIngress } from '../workers/worker-event.ingress';
import { WorkersService } from '../workers/workers.service';
import { WorkerDispatcher } from './worker-dispatcher';
import { PlanLifecycleService } from '../tasks/plan-lifecycle.service';
import { createLedger, embedLedger } from '../issues/review-round-ledger';

/**
 * plan-review-execution-gates Todo 4：dispatchAgentMention 门禁执行点。
 *
 * - kind 缺省 execution；kind=execution + 任务维度 + 计划非 executing → 抛错（含计划未放行），不调 dispatch。
 * - kind=review/nudge/wake → 豁免，永不读门禁。
 * - 门禁读错/兜底建行失败/未装配 planLifecycle → fail-open 放行 + warn（读错路径）。
 */
describe('WorkerDispatcher dispatchAgentMention 计划门禁（todo4）', () => {
  let prisma: {
    task: { findUnique: jest.Mock };
    issue: { findMany: jest.Mock };
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let sessionLifecycle: { ensureTeamSession: jest.Mock };
  let planLifecycle: { getStatus: jest.Mock; autoEnsureRow: jest.Mock };
  let moduleRef: { get: jest.Mock };
  let loggerErrorSpy: jest.SpyInstance;
  let loggerWarnSpy: jest.SpyInstance;

  const input = {
    taskId: 't_0000000001',
    channelId: 'c_0000000001',
    text: '@tmm_tester 请执行该需求',
    targetInstanceId: 'tmm_tester',
  };

  const createDispatcher = () =>
    new WorkerDispatcher(
      prisma as never,
      idGen as never,
      realtime as never,
      {} as WorkersService,
      {} as WorkerClient,
      sessionLifecycle as unknown as SessionLifecycleService,
      {} as ArtifactsService,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      {
        onTaskCompleted: jest.fn(),
        onAgentStatus: jest.fn(),
        onSessionActivity: jest.fn(),
      } as unknown as WorkerEventIngress,
      moduleRef as never,
    );

  beforeEach(() => {
    prisma = {
      task: { findUnique: jest.fn() },
      issue: { findMany: jest.fn().mockResolvedValue([]) },
    };
    idGen = { nextId: jest.fn().mockResolvedValue('m_0000000002') };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    sessionLifecycle = { ensureTeamSession: jest.fn() };
    planLifecycle = { getStatus: jest.fn(), autoEnsureRow: jest.fn() };
    moduleRef = { get: jest.fn().mockReturnValue(planLifecycle) };

    prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
    sessionLifecycle.ensureTeamSession.mockResolvedValue({
      id: 's_tester',
      agentId: 'a_tester',
      reused: true,
    });

    const d = createDispatcher();
    loggerWarnSpy = jest
      .spyOn(
        (d as unknown as { logger: { warn: (...a: unknown[]) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    loggerErrorSpy = jest
      .spyOn(
        (d as unknown as { logger: { error: (...a: unknown[]) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
    loggerErrorSpy.mockRestore();
  });

  it('execution + approved → 放行（计划状态不再是门禁），不读状态、调 dispatch', async () => {
    planLifecycle.getStatus.mockResolvedValue('approved');
    const d = createDispatcher();
    const dispatchSpy = jest
      .spyOn(d, 'dispatch')
      .mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention(input);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(planLifecycle.getStatus).not.toHaveBeenCalled();
    expect(sessionLifecycle.ensureTeamSession).toHaveBeenCalled();
  });

  it('execution + executing → 放行并透传 kind', async () => {
    planLifecycle.getStatus.mockResolvedValue('executing');
    const d = createDispatcher();
    const dispatchSpy = jest
      .spyOn(d, 'dispatch')
      .mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention(input);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([['review'], ['nudge'], ['wake']])(
    'kind=%s + approved → 豁免放行且不读门禁',
    async (kind: string) => {
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({
        ...input,
        kind: kind as 'review' | 'nudge' | 'wake',
      });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(planLifecycle.getStatus).not.toHaveBeenCalled();
    },
  );

  it('无 plan 行→兜底建行后放行（draft 状态不再拦截）', async () => {
    planLifecycle.autoEnsureRow.mockResolvedValue({ status: 'draft' });
    const d = createDispatcher();
    const dispatchSpy = jest
      .spyOn(d, 'dispatch')
      .mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention(input);

    expect(planLifecycle.autoEnsureRow).toHaveBeenCalledWith('t_0000000001');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('兜底建行失败→fail-open 放行 + warn', async () => {
    planLifecycle.autoEnsureRow.mockRejectedValue(new Error('db down'));
    const d = createDispatcher();
    const dispatchSpy = jest
      .spyOn(d, 'dispatch')
      .mockResolvedValue({ replies: [] });
    const warnSpy = jest
      .spyOn(
        (d as unknown as { logger: { warn: (...a: unknown[]) => void } })
          .logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await d.dispatchAgentMention(input);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('未装配 planLifecycle（moduleRef 缺失）→ fail-open 放行', async () => {
    const d = new WorkerDispatcher(
      prisma as never,
      idGen as never,
      realtime as never,
      {} as WorkersService,
      {} as WorkerClient,
      sessionLifecycle as unknown as SessionLifecycleService,
      {} as ArtifactsService,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      {
        onTaskCompleted: jest.fn(),
        onAgentStatus: jest.fn(),
        onSessionActivity: jest.fn(),
      } as unknown as WorkerEventIngress,
    );
    const dispatchSpy = jest
      .spyOn(d, 'dispatch')
      .mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention(input);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('团队维度（无 taskId）→ 无计划可门禁，直接放行', async () => {
    const d = createDispatcher();
    const dispatchSpy = jest
      .spyOn(d, 'dispatch')
      .mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention({
      teamId: 'tm_0000000001',
      channelId: input.channelId,
      text: input.text,
      targetInstanceId: input.targetInstanceId,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(planLifecycle.getStatus).not.toHaveBeenCalled();
  });

  it('PlanLifecycleService 可经 ModuleRef 懒解析（无 ChatModule→TasksModule 静态环）', () => {
    expect(moduleRef.get).not.toHaveBeenCalled();
    const d = createDispatcher();
    expect(d).toBeDefined();
    // 构造期不解析，调用期才懒解析。
    expect(moduleRef.get).not.toHaveBeenCalled();
    void PlanLifecycleService;
  });

  describe('a_plan 角色豁免已删除：门禁对每个目标一律生效（哈希层）', () => {
    const withTargetAgent = (agentId: string) => {
      (prisma as any).teamMember = {
        findFirst: jest.fn().mockResolvedValue({ id: 'tmm_x', agentId }),
      };
    };

    it('派给 a_plan → 照样经 autoEnsureRow 兜底建行（豁免删除）', async () => {
      withTargetAgent('a_plan');
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({ ...input, targetInstanceId: 'tmm_plan' });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(planLifecycle.autoEnsureRow).toHaveBeenCalledWith('t_0000000001');
    });

    it('无 plan 行派给 a_plan → 兜底建行后放行', async () => {
      withTargetAgent('a_plan');
      planLifecycle.autoEnsureRow.mockResolvedValue({ status: 'draft' });
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({ ...input, targetInstanceId: 'tmm_plan' });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(planLifecycle.autoEnsureRow).toHaveBeenCalledWith('t_0000000001');
    });

    it('draft 态派给 a_developer → 放行（原“计划未放行”拦截已移除）', async () => {
      withTargetAgent('a_developer');
      planLifecycle.getStatus.mockResolvedValue('draft');
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({ ...input, targetInstanceId: 'tmm_dev' });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('终态任务门禁：execution 绑定 completed/archived 即拒绝（零副作用）', () => {
    it.each([['completed'], ['archived']])(
      'execution + %s → 抛错（含任务 id/终态/task_create），不调 dispatch/ensureTeamSession，不读计划门禁',
      async (status: string) => {
        prisma.task.findUnique.mockResolvedValue({
          teamId: 'tm_0000000001',
          status,
        });
        const d = createDispatcher();
        const dispatchSpy = jest
          .spyOn(d, 'dispatch')
          .mockResolvedValue({ replies: [] });

        const err = await d
          .dispatchAgentMention(input)
          .then(() => null)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        const message = String((err as Error)?.message ?? err);
        expect(message).toContain(input.taskId);
        expect(message).toContain(status);
        expect(message).toContain('task_create');
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect(sessionLifecycle.ensureTeamSession).not.toHaveBeenCalled();
        expect(planLifecycle.getStatus).not.toHaveBeenCalled();
        expect(planLifecycle.autoEnsureRow).not.toHaveBeenCalled();
      },
    );

    it.each([['queued'], ['pending'], ['in_progress'], ['pending_review']])(
      'execution + %s（活跃态）→ 放行走计划门禁',
      async (status: string) => {
        prisma.task.findUnique.mockResolvedValue({
          teamId: 'tm_0000000001',
          status,
        });
        planLifecycle.getStatus.mockResolvedValue('executing');
        const d = createDispatcher();
        const dispatchSpy = jest
          .spyOn(d, 'dispatch')
          .mockResolvedValue({ replies: [] });

        await d.dispatchAgentMention(input);

        expect(dispatchSpy).toHaveBeenCalledTimes(1);
      },
    );

    it.each([['review'], ['nudge'], ['wake']])(
      'kind=%s + completed → 豁免放行（收尾流量）',
      async (kind: string) => {
        prisma.task.findUnique.mockResolvedValue({
          teamId: 'tm_0000000001',
          status: 'completed',
        });
        const d = createDispatcher();
        const dispatchSpy = jest
          .spyOn(d, 'dispatch')
          .mockResolvedValue({ replies: [] });

        await d.dispatchAgentMention({
          ...input,
          kind: kind as 'review' | 'nudge' | 'wake',
        });

        expect(dispatchSpy).toHaveBeenCalledTimes(1);
      },
    );

    it('execution 无 taskId（团队维度）→ 不读任务终态，直接放行', async () => {
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({
        teamId: 'tm_0000000001',
        channelId: input.channelId,
        text: input.text,
        targetInstanceId: input.targetInstanceId,
      });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(prisma.task.findUnique).not.toHaveBeenCalled();
    });

    it('execution + 任务行缺失 → 保持今日语义（无团队会话），不报终态拒绝', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await expect(d.dispatchAgentMention(input)).rejects.toThrow('无团队会话');
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('execution + 行无 status → 照旧放行（缺行语义归别处）', async () => {
      prisma.task.findUnique.mockResolvedValue({
        teamId: 'tm_0000000001',
      });
      planLifecycle.getStatus.mockResolvedValue('executing');
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention(input);

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('todo 10 保留检查锁定：过期哈希对 plan-role 目标照样拒绝（豁免已删）', () => {
    const FROZEN_HASH = 'frz00001';
    const STALE_HASH = 'deadbeef';

    const armFrozenLedger = () => {
      prisma.issue.findMany.mockResolvedValue([
        {
          description: embedLedger(
            '派发评审',
            createLedger({
              round: 2,
              planVersion: { version: 'v0.2', lines: 233, hash: FROZEN_HASH },
              expected: ['tmm_arch'],
              status: 'complete',
              timeoutAt: '2026-09-16T00:40:00Z',
            }),
          ),
        },
      ]);
    };

    it('过期 planHash + a_plan 目标 → 抛出（a_plan 豁免已删除，哈希对每个目标生效）', async () => {
      armFrozenLedger();
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      const err = await d
        .dispatchAgentMention({
          ...input,
          targetInstanceId: 'tmm_plan',
          planHash: STALE_HASH,
        })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const message = String((err as Error)?.message ?? err);
      expect(message).toContain(`#${FROZEN_HASH}`);
      expect(message).toContain(`#${STALE_HASH}`);
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('匹配 planHash + a_plan 目标 → 放行（保留哈希门不误拦匹配）', async () => {
      armFrozenLedger();
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({
        ...input,
        targetInstanceId: 'tmm_plan',
        planHash: FROZEN_HASH,
      });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
