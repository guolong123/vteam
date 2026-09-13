import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient } from '../workers/worker.client';
import { PlanStepsService } from './plan-steps.service';

describe('PlanStepsService', () => {
  let service: PlanStepsService;
  let prisma: any;
  let workerClient: { listTodos: jest.Mock };

  beforeEach(async () => {
    prisma = {
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      session: { findFirst: jest.fn() },
      worker: { findUnique: jest.fn() },
    };
    workerClient = { listTodos: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanStepsService,
        { provide: PrismaService, useValue: prisma },
        { provide: WorkerClient, useValue: workerClient },
      ],
    }).compile();
    service = module.get<PlanStepsService>(PlanStepsService);
  });

  function happyPath() {
    prisma.task.findUnique.mockResolvedValue({
      id: 't_1',
      teamId: 'tm_1',
    });
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: 'tmm_main',
    });
    prisma.session.findFirst.mockResolvedValue({
      workerId: 'w_1',
      instanceRef: 'ses_1',
    });
    prisma.worker.findUnique.mockResolvedValue({
      id: 'w_1',
      status: 'online',
      capabilities: { execBaseUrl: 'http://worker:4198' },
    });
  }

  it('成功：定位主成员会话 → listTodos 透传 worker capabilities + ses id', async () => {
    happyPath();
    const steps = [{ content: '拆解任务', status: 'completed' }];
    workerClient.listTodos.mockResolvedValue(steps);

    const out = await service.listPlanSteps('t_1');

    expect(prisma.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teamId: 'tm_1', teamMemberId: 'tmm_main' },
      }),
    );
    // ⚠️ capabilities 回归断言（listOpencodeAgents 本地部署踩坑同类 bug）：
    // 只传 { id } 会回退 WORKER_BASE_URL，跨容器必失败。
    expect(workerClient.listTodos).toHaveBeenCalledWith(
      { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } },
      'ses_1',
    );
    expect(out).toEqual({ steps, workerId: 'w_1', degraded: false });
  });

  it('空 todo（agent 还没用 todo 工具）→ degraded=false + steps=[]（正常情况）', async () => {
    happyPath();
    workerClient.listTodos.mockResolvedValue([]);

    const out = await service.listPlanSteps('t_1');

    expect(out).toEqual({ steps: [], workerId: 'w_1', degraded: false });
  });

  it('任务无团队 → degraded（不抛错）', async () => {
    prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: null });

    const out = await service.listPlanSteps('t_1');

    expect(out).toEqual({ steps: [], workerId: null, degraded: true });
    expect(workerClient.listTodos).not.toHaveBeenCalled();
  });

  it('团队无主 Agent → degraded', async () => {
    prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
    prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });

    const out = await service.listPlanSteps('t_1');

    expect(out).toEqual({ steps: [], workerId: null, degraded: true });
  });

  it('主成员无会话（workerId/instanceRef 缺失）→ degraded', async () => {
    prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
    prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: 'tmm_main' });
    prisma.session.findFirst.mockResolvedValue(null);

    const out = await service.listPlanSteps('t_1');

    expect(out).toEqual({ steps: [], workerId: null, degraded: true });
  });

  it('worker 离线（offline）→ degraded，不下发调用', async () => {
    prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
    prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: 'tmm_main' });
    prisma.session.findFirst.mockResolvedValue({
      workerId: 'w_1',
      instanceRef: 'ses_1',
    });
    prisma.worker.findUnique.mockResolvedValue({
      id: 'w_1',
      status: 'offline',
      capabilities: {},
    });

    const out = await service.listPlanSteps('t_1');

    expect(out).toEqual({ steps: [], workerId: 'w_1', degraded: true });
    expect(workerClient.listTodos).not.toHaveBeenCalled();
  });

  it('degraded 状态 worker 仍可下发（仅 offline 阻断，调度降权≠不可达）', async () => {
    happyPath();
    prisma.worker.findUnique.mockResolvedValue({
      id: 'w_1',
      status: 'degraded',
      capabilities: {},
    });
    workerClient.listTodos.mockResolvedValue([]);

    const out = await service.listPlanSteps('t_1');

    expect(workerClient.listTodos).toHaveBeenCalled();
    expect(out.degraded).toBe(false);
  });

  it('DB 异常 → degraded（不冒泡到 HTTP 层）', async () => {
    prisma.task.findUnique.mockRejectedValue(new Error('db down'));

    const out = await service.listPlanSteps('t_1');

    expect(out).toEqual({ steps: [], workerId: null, degraded: true });
  });
});
