import { Test, TestingModule } from '@nestjs/testing';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { IdGeneratorService } from '../common/id-generator';
import { GitReposService } from '../git-repos/git-repos.service';
import { IssuesService } from '../issues/issues.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from '../questions/questions.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  PLAN_LIFECYCLE_ERRORS,
  PlanLifecycleService,
} from '../tasks/plan-lifecycle.service';
import { TasksService } from '../tasks/tasks.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { WorkerClient } from '../workers/worker.client';
import { PlatformMcpService } from './platform-mcp.service';

/**
 * plan_finalize / plan_confirm 的托管模式签署门（managedMode + 主 Agent）：
 * 团队未开托管 → 403；开了但调用方不是主 Agent → 403；两者皆满足 → 转
 * PlanLifecycleService.confirmPlan(managed:true)（draft/pending_final 可直推）。
 */
describe('PlatformMcpService 托管模式计划签署门', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
  };
  let planLifecycle: { confirmPlan: jest.Mock };

  const taskId = 't_0000000001';
  const workerId = 'w_0000000001';
  const ctx = { workerId };
  const mainId = 'tmm_main';
  const otherId = 'tmm_other';

  const setTeam = (managedMode: boolean, mainAgentMemberId: string | null) => {
    prisma.team.findUnique.mockResolvedValue({
      managedMode,
      mainAgentMemberId,
    });
  };

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn() },
      task: { findUnique: jest.fn().mockResolvedValue({ teamId: 'tm_1' }) },
      team: { findUnique: jest.fn() },
    };
    planLifecycle = { confirmPlan: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
        { provide: WorkerClient, useValue: { fetchFile: jest.fn() } },
        {
          provide: WorkerDispatcher,
          useValue: {
            dispatchAgentMention: jest.fn(),
            isAgentExecuting: jest.fn().mockReturnValue(null),
          },
        },
        { provide: ArtifactsService, useValue: { append: jest.fn() } },
        { provide: IssuesService, useValue: {} },
        { provide: TasksService, useValue: {} },
        { provide: QuestionsService, useValue: {} },
        { provide: GitReposService, useValue: {} },
        { provide: SessionLifecycleService, useValue: {} },
        { provide: PlanLifecycleService, useValue: planLifecycle },
      ],
    }).compile();
    service = module.get(PlatformMcpService);
  });

  /** 归属校验通过：该 worker 在此团队有绑定指定成员的会话。 */
  const allowWorkerAs = (instanceId: string) => {
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: 'a_x',
      teamMemberId: instanceId,
    });
  };

  it('未开托管模式 → plan_finalize 403 PLAN_MANAGED_MODE_DISABLED（不触达状态机）', async () => {
    allowWorkerAs(mainId);
    setTeam(false, mainId);

    const err = await service
      .planFinalize(ctx, { taskId, selfInstanceId: mainId })
      .catch((e) => e);

    expect(err?.response?.code ?? err?.code).toBe(
      PLAN_LIFECYCLE_ERRORS.PLAN_MANAGED_MODE_DISABLED,
    );
    expect(planLifecycle.confirmPlan).not.toHaveBeenCalled();
  });

  it('未开托管模式 → plan_confirm 403 PLAN_MANAGED_MODE_DISABLED', async () => {
    allowWorkerAs(mainId);
    setTeam(false, mainId);

    const err = await service
      .planConfirm(ctx, { taskId, selfInstanceId: mainId })
      .catch((e) => e);

    expect(err?.response?.code ?? err?.code).toBe(
      PLAN_LIFECYCLE_ERRORS.PLAN_MANAGED_MODE_DISABLED,
    );
    expect(planLifecycle.confirmPlan).not.toHaveBeenCalled();
  });

  it('托管模式开启但调用方非主 Agent → 403 PLAN_MANAGED_MODE_MAIN_ONLY', async () => {
    allowWorkerAs(otherId);
    setTeam(true, mainId);

    const err = await service
      .planConfirm(ctx, { taskId, selfInstanceId: otherId })
      .catch((e) => e);

    expect(err?.response?.code ?? err?.code).toBe(
      PLAN_LIFECYCLE_ERRORS.PLAN_MANAGED_MODE_MAIN_ONLY,
    );
    expect(planLifecycle.confirmPlan).not.toHaveBeenCalled();
  });

  it('托管模式 + 主 Agent → plan_finalize 以 managed:true 调 confirmPlan(action:finalize)', async () => {
    allowWorkerAs(mainId);
    setTeam(true, mainId);
    planLifecycle.confirmPlan.mockResolvedValue({
      plan: { status: 'approved' },
      idempotent: false,
      action: 'finalize',
    });

    const res = await service.planFinalize(ctx, {
      taskId,
      selfInstanceId: mainId,
    });

    expect(planLifecycle.confirmPlan).toHaveBeenCalledWith(taskId, {
      userId: mainId,
      userName: null,
      action: 'finalize',
      managed: true,
    });
    expect(res).toMatchObject({
      taskId,
      status: 'approved',
      idempotent: false,
      action: 'finalize',
    });
  });

  it('托管模式 + 主 Agent → plan_confirm 以 managed:true 调 confirmPlan(action:confirm)', async () => {
    allowWorkerAs(mainId);
    setTeam(true, mainId);
    planLifecycle.confirmPlan.mockResolvedValue({
      plan: { status: 'executing' },
      idempotent: false,
      action: 'confirm',
    });

    const res = await service.planConfirm(ctx, {
      taskId,
      selfInstanceId: mainId,
    });

    expect(planLifecycle.confirmPlan).toHaveBeenCalledWith(taskId, {
      userId: mainId,
      userName: null,
      action: 'confirm',
      managed: true,
    });
    expect(res).toMatchObject({ taskId, status: 'executing', action: 'confirm' });
  });

  it('计划服务未装配 → 503 PLAN_COMPLETE_UNAVAILABLE（不静默成功）', async () => {
    const bare = new PlatformMcpService(
      prisma as never,
      { nextId: jest.fn() } as never,
      { broadcast: jest.fn() } as never,
      { fetchFile: jest.fn() } as never,
      {
        dispatchAgentMention: jest.fn(),
        isAgentExecuting: jest.fn().mockReturnValue(null),
      } as never,
      { append: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    allowWorkerAs(mainId);

    const err = await bare
      .planConfirm(ctx, { taskId, selfInstanceId: mainId })
      .catch((e) => e);

    expect(err?.response?.code ?? err?.code).toBe(
      PLAN_LIFECYCLE_ERRORS.PLAN_COMPLETE_UNAVAILABLE,
    );
  });
});
