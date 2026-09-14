import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkersService } from '../workers/workers.service';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';
import { PlatformMcpService } from './platform-mcp.service';
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';

describe('PlatformMcpService.planReview', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    teamMember: { findMany: jest.Mock };
    worker: { findUnique: jest.Mock };
  };
  let workerClient: {
    listPlanFiles: jest.Mock;
    fetchFile: jest.Mock;
    review: jest.Mock;
  };
  let workerDispatcher: {
    isAgentExecuting: jest.Mock;
    registerExecution: jest.Mock;
    unregisterExecution: jest.Mock;
    taskWorkDirRoot: string;
  };
  let workersService: { assignWorker: jest.Mock };

  const taskId = 't_0000000001';
  const workerId = 'w_0000000001';
  const reviewWorkerId = 'w_0000000002';
  const teamId = 'tm_0000000001';
  const mainId = 'tmm_main';
  const ctx = { workerId };
  const taskWorkDir = '/data/vteam-worker/tasks/t_0000000001';

  const members = [
    {
      id: mainId,
      agentId: 'a_product',
      agent: { id: 'a_product', role: 'product' },
    },
    {
      id: 'tmm_dev',
      agentId: 'a_dev',
      agent: { id: 'a_dev', role: 'developer' },
    },
    {
      id: 'tmm_tester',
      agentId: 'a_tester',
      agent: { id: 'a_tester', role: 'tester' },
    },
  ];

  const allowAs = (instanceId: string) => {
    prisma.task.findUnique.mockResolvedValue({ teamId });
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: 'a_product',
      teamMemberId: instanceId,
    });
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: mainId,
    });
    prisma.teamMember.findMany.mockResolvedValue(members);
    prisma.worker.findUnique.mockResolvedValue({ capabilities: {} });
  };

  const planFiles = (content = '# 执行计划\n\n- step 1') => {
    workerClient.listPlanFiles.mockResolvedValue([
      {
        name: 'old.md',
        updatedAt: '2026-09-13T00:00:00.000Z',
        size: 4,
        content: '# 旧计划',
        truncated: false,
      },
      {
        name: 'plan.md',
        updatedAt: '2026-09-14T00:00:00.000Z',
        size: content.length,
        content,
        truncated: false,
      },
    ]);
  };

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn() },
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: { findMany: jest.fn() },
      worker: { findUnique: jest.fn() },
    };
    workerClient = {
      listPlanFiles: jest.fn(),
      fetchFile: jest.fn(),
      review: jest.fn(),
    };
    workerDispatcher = {
      isAgentExecuting: jest.fn().mockReturnValue(null),
      registerExecution: jest.fn(),
      unregisterExecution: jest.fn(),
      taskWorkDirRoot: '/data/vteam-worker',
    };
    workersService = {
      assignWorker: jest.fn().mockResolvedValue(reviewWorkerId),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
        { provide: WorkerClient, useValue: workerClient },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ArtifactsService, useValue: {} },
        { provide: IssuesService, useValue: {} },
        { provide: TasksService, useValue: {} },
        { provide: QuestionsService, useValue: {} },
        { provide: WorkersService, useValue: workersService },
      ],
    }).compile();

    service = module.get(PlatformMcpService);
  });

  it('非主 Agent 调用 → 403 PLATFORM_MCP_FORBIDDEN（计划尚未读取）', async () => {
    allowAs('tmm_dev');
    await expect(
      service.planReview(ctx, {
        taskId,
        selfInstanceId: 'tmm_dev',
        reviewers: ['tester'],
      }),
    ).rejects.toMatchObject({
      status: 403,
    });
    try {
      await service.planReview(ctx, {
        taskId,
        selfInstanceId: 'tmm_dev',
        reviewers: ['tester'],
      });
      throw new Error('应当抛出异常');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
      });
    }
    expect(workerClient.listPlanFiles).not.toHaveBeenCalled();
  });

  it('计划目录无 .md → 400（缺省定位失败，消息明确）', async () => {
    allowAs(mainId);
    workerClient.listPlanFiles.mockResolvedValue([]);
    try {
      await service.planReview(ctx, {
        taskId,
        selfInstanceId: mainId,
        reviewers: ['developer'],
      });
      throw new Error('应当抛出异常');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
      });
      expect(
        (err as { message: string }).message,
      ).toContain('.opencode/plans/');
    }
    expect(workerClient.review).not.toHaveBeenCalled();
  });

  it.each(['../../evil.md', '/etc/passwd', 'a/../../b.md'])(
    'planPath 穿越任务目录（%s）→ 400 且不读文件',
    async (planPath) => {
      allowAs(mainId);
      planFiles();
      await expect(
        service.planReview(ctx, {
          taskId,
          selfInstanceId: mainId,
          reviewers: ['developer'],
          planPath,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(workerClient.fetchFile).not.toHaveBeenCalled();
      expect(workerClient.review).not.toHaveBeenCalled();
    },
  );

  it('评审者解析：缺席 role 与主 Agent 自身 role 跳过并附 notes', async () => {
    allowAs(mainId);
    planFiles();
    workerClient.review.mockImplementation(
      async (worker: { id: string }, opts: { agent?: string }) =>
        opts.agent === 'vteam-developer'
          ? { text: 'VERDICT: APPROVE\n依据充分，同意执行', sessionId: 'ses_d' }
          : { text: 'verdict: reject\n缺少回滚方案', sessionId: 'ses_t' },
    );

    const result = await service.planReview(ctx, {
      taskId,
      selfInstanceId: mainId,
      reviewers: ['developer', 'tester', 'architect', 'product'],
    });

    expect(result.verdicts).toEqual([
      {
        role: 'developer',
        memberId: 'tmm_dev',
        verdict: 'APPROVE',
        findings: '依据充分，同意执行',
      },
      {
        role: 'tester',
        memberId: 'tmm_tester',
        verdict: 'REJECT',
        findings: '缺少回滚方案',
      },
    ]);
    expect(result.notes).toHaveLength(2);
    expect(result.notes.join('\n')).toContain('architect');
    expect(result.notes.join('\n')).toContain('product');

    const devCall = workerClient.review.mock.calls.find(
      ([, opts]) => (opts as { agent?: string }).agent === 'vteam-developer',
    )!;
    const devOpts = devCall[1] as Record<string, unknown>;
    expect(devOpts.agent).toBe('vteam-developer');
    expect(devOpts.agentId).toBe('a_dev');
    expect(devOpts.taskId).toBe(taskId);
    expect(devOpts.directory).toBe(taskWorkDir);
    expect(devOpts.prompt as string).toContain('skill(plan-review-developer)');
    expect(devOpts.prompt as string).toContain('# 执行计划');
    expect(devOpts.prompt as string).toContain('VERDICT: APPROVE');
  });

  it('评审文本无 VERDICT → NEEDS-ATTENTION（原文进 findings）', async () => {
    allowAs(mainId);
    planFiles();
    workerClient.review.mockResolvedValue({
      text: '我觉得还行，但说不清',
      sessionId: 'ses_x',
    });

    const result = await service.planReview(ctx, {
      taskId,
      selfInstanceId: mainId,
      reviewers: ['developer'],
    });

    expect(result.verdicts).toEqual([
      {
        role: 'developer',
        memberId: 'tmm_dev',
        verdict: 'NEEDS-ATTENTION',
        findings: '我觉得还行，但说不清',
      },
    ]);
    expect(result.notes).toEqual([]);
  });

  it('聚合：一个评审超时 → 该路 NEEDS-ATTENTION，其余正常返回', async () => {
    allowAs(mainId);
    planFiles();
    workerClient.review.mockImplementation(
      async (worker: { id: string }, opts: { agent?: string }) => {
        if ((opts.agent as string) === 'vteam-tester') {
          return new Promise<never>(() => undefined);
        }
        return { text: 'VERDICT: APPROVE\n同意', sessionId: 'ses_d' };
      },
    );

    const result = await service.planReview(ctx, {
      taskId,
      selfInstanceId: mainId,
      reviewers: ['developer', 'tester'],
      timeoutMs: 80,
    });

    expect(result.verdicts[0]).toMatchObject({
      role: 'developer',
      verdict: 'APPROVE',
    });
    expect(result.verdicts[1]).toMatchObject({
      role: 'tester',
      memberId: 'tmm_tester',
      verdict: 'NEEDS-ATTENTION',
    });
    expect(result.verdicts[1].findings).toContain('超时');
  });

  it('review 抛错 → NEEDS-ATTENTION，且 register/unregister 配对（finally）', async () => {
    allowAs(mainId);
    planFiles();
    workerClient.review.mockRejectedValue(new Error('boom'));

    const result = await service.planReview(ctx, {
      taskId,
      selfInstanceId: mainId,
      reviewers: ['developer'],
    });

    expect(result.verdicts).toEqual([
      {
        role: 'developer',
        memberId: 'tmm_dev',
        verdict: 'NEEDS-ATTENTION',
        findings: 'boom',
      },
    ]);
    expect(workerDispatcher.registerExecution).toHaveBeenCalledWith(
      reviewWorkerId,
      `team:${teamId}`,
      'tmm_dev',
    );
    expect(workerDispatcher.unregisterExecution).toHaveBeenCalledWith(
      reviewWorkerId,
      `team:${teamId}`,
      'tmm_dev',
    );
  });

  it('无可用 worker → 该路 NEEDS-ATTENTION（不抛错，不丢弃其余结果）', async () => {
    allowAs(mainId);
    planFiles();
    workersService.assignWorker.mockResolvedValue(null);
    workerClient.review.mockResolvedValue({
      text: 'VERDICT: APPROVE\n同意',
      sessionId: 'ses_d',
    });

    const result = await service.planReview(ctx, {
      taskId,
      selfInstanceId: mainId,
      reviewers: ['developer'],
    });

    expect(result.verdicts[0].verdict).toBe('NEEDS-ATTENTION');
    expect(result.verdicts[0].findings).toContain('无可用 worker');
    expect(workerClient.review).not.toHaveBeenCalled();
  });

  it('显式 planPath：任务目录内相对路径 → fetchFile 读取并内联进提示词', async () => {
    allowAs(mainId);
    workerClient.fetchFile.mockResolvedValue(Buffer.from('# 定制计划'));
    workerClient.review.mockResolvedValue({
      text: 'VERDICT: APPROVE\n同意',
      sessionId: 'ses_d',
    });

    const result = await service.planReview(ctx, {
      taskId,
      selfInstanceId: mainId,
      reviewers: ['developer'],
      planPath: '.opencode/plans/custom.md',
    });

    expect(workerClient.fetchFile).toHaveBeenCalledWith(
      { id: workerId, capabilities: {} },
      `${taskWorkDir}/.opencode/plans/custom.md`,
    );
    expect(workerClient.listPlanFiles).not.toHaveBeenCalled();
    const prompt = (
      workerClient.review.mock.calls[0][1] as { prompt: string }
    ).prompt;
    expect(prompt).toContain('# 定制计划');
    expect(result.verdicts[0].verdict).toBe('APPROVE');
  });
});
