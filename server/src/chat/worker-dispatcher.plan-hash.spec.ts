import { ArtifactsService } from '../artifacts/artifacts.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkerEventIngress } from '../workers/worker-event.ingress';
import { WorkersService } from '../workers/workers.service';
import { WorkerDispatcher } from './worker-dispatcher';
import { PlanLifecycleService } from '../tasks/plan-lifecycle.service';
import { createLedger, embedLedger } from '../issues/review-round-ledger';

/**
 * plan-finalize-actions todo 3：dispatchAgentMention 执行认哈希门禁（第二道防线）。
 *
 * - executing 态 + 调用方 planHash 与冻结哈希不一致 → 抛错且报错同时命名
 *   期望/实际短哈希，不调 dispatch；
 * - 哈希一致 → 放行；未携带 planHash → 原行为（门禁未武装，不收紧）。
 */
describe('WorkerDispatcher dispatchAgentMention 哈希门禁（todo 3）', () => {
  let prisma: {
    task: { findUnique: jest.Mock };
    issue: { findMany: jest.Mock };
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let sessionLifecycle: { ensureTeamSession: jest.Mock };
  let planLifecycle: { getStatus: jest.Mock; autoEnsureRow: jest.Mock };
  let moduleRef: { get: jest.Mock };

  const FROZEN_HASH = 'a1b2c3d4';
  const STALE_HASH = 'deadbeef';

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
      issue: { findMany: jest.fn() },
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
    planLifecycle.getStatus.mockResolvedValue('executing');

    const d = createDispatcher();
    jest
      .spyOn((d as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  it('过期哈希 → 抛错同时命名期望/实际短哈希，不调 dispatch', async () => {
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

    const err = await d
      .dispatchAgentMention({ ...input, planHash: STALE_HASH })
      .catch((e) => e);

    expect(String(err?.message ?? err)).toContain(`#${FROZEN_HASH}`);
    expect(String(err?.message ?? err)).toContain(`#${STALE_HASH}`);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('哈希匹配 → 放行', async () => {
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention({ ...input, planHash: FROZEN_HASH });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('未携带 planHash → 原行为（executing 放行，不读账本）', async () => {
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention(input);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
  });

  it('账本读错 → fail-open 放行', async () => {
    prisma.issue.findMany.mockRejectedValue(new Error('db down'));
    const d = createDispatcher();
    const dispatchSpy = jest.spyOn(d, 'dispatch').mockResolvedValue({ replies: [] });

    await d.dispatchAgentMention({ ...input, planHash: STALE_HASH });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
