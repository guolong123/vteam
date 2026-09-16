import { ArtifactsService } from '../artifacts/artifacts.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkerEventIngress } from '../workers/worker-event.ingress';
import { WorkersService } from '../workers/workers.service';
import { WorkerDispatcher } from './worker-dispatcher';
import { PlanLifecycleService } from '../tasks/plan-lifecycle.service';

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
    prisma = { task: { findUnique: jest.fn() } };
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
      .spyOn((d as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    loggerErrorSpy = jest
      .spyOn((d as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
    loggerErrorSpy.mockRestore();
  });

  it('execution + approved → 抛错含计划未放行，不调 dispatch/ensureTeamSession', async () => {
    planLifecycle.getStatus.mockResolvedValue('approved');
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

    await expect(d.dispatchAgentMention(input)).rejects.toThrow('计划未放行');
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(sessionLifecycle.ensureTeamSession).not.toHaveBeenCalled();
  });

  it('execution + executing → 放行并透传 kind', async () => {
    planLifecycle.getStatus.mockResolvedValue('executing');
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention(input);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([['review'], ['nudge'], ['wake']])(
    'kind=%s + approved → 豁免放行且不读门禁',
    async (kind: string) => {
      const d = createDispatcher();
      const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({
        ...input,
        kind: kind as 'review' | 'nudge' | 'wake',
      });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(planLifecycle.getStatus).not.toHaveBeenCalled();
    },
  );

  it('无 plan 行→兜底建行后再门禁（draft → 抛错）', async () => {
    planLifecycle.getStatus.mockResolvedValue(null);
    planLifecycle.autoEnsureRow.mockResolvedValue({ status: 'draft' });
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

    await expect(d.dispatchAgentMention(input)).rejects.toThrow('计划未放行');
    expect(planLifecycle.autoEnsureRow).toHaveBeenCalledWith('t_0000000001');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('门禁读错→fail-open 放行 + warn', async () => {
    planLifecycle.getStatus.mockRejectedValue(new Error('db down'));
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });
    const warnSpy = jest
      .spyOn((d as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn')
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
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention(input);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('团队维度（无 taskId）→ 无计划可门禁，直接放行', async () => {
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

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

  describe('计划角色豁免：kind=execution 派给 a_plan 永不进计划门禁', () => {
    const withTargetAgent = (agentId: string) => {
      (prisma as any).teamMember = {
        findFirst: jest.fn().mockResolvedValue({ id: 'tmm_x', agentId }),
      };
    };

    it('draft 态派给 a_plan → 放行且不读门禁（计划工作永非执行）', async () => {
      withTargetAgent('a_plan');
      planLifecycle.getStatus.mockResolvedValue('draft');
      const d = createDispatcher();
      const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({ ...input, targetInstanceId: 'tmm_plan' });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(planLifecycle.getStatus).not.toHaveBeenCalled();
    });

    it('无 plan 行派给 a_plan → 放行且不兜底建行', async () => {
      withTargetAgent('a_plan');
      planLifecycle.getStatus.mockResolvedValue(null);
      const d = createDispatcher();
      const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({ ...input, targetInstanceId: 'tmm_plan' });

      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expect(planLifecycle.getStatus).not.toHaveBeenCalled();
      expect(planLifecycle.autoEnsureRow).not.toHaveBeenCalled();
    });

    it('draft 态派给 a_developer → 仍被拦且报错含计划未放行', async () => {
      withTargetAgent('a_developer');
      planLifecycle.getStatus.mockResolvedValue('draft');
      const d = createDispatcher();
      const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

      await expect(
        d.dispatchAgentMention({ ...input, targetInstanceId: 'tmm_dev' }),
      ).rejects.toThrow('计划未放行');
      expect(dispatchSpy).not.toHaveBeenCalled();
    });
  });
});
