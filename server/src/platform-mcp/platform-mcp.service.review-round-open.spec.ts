import { Test, TestingModule } from '@nestjs/testing';
import { MESSAGE_STATUS } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerClient } from '../workers/worker.client';
import { PlatformMcpService } from './platform-mcp.service';
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
import { SkillsService } from '../skills/skills.service';
import { GitReposService } from '../git-repos/git-repos.service';
import { PlanLifecycleService } from '../tasks/plan-lifecycle.service';
import { TimerService } from '../timers/trigger.service';
import { REVIEW_ROUND_TIMEOUT_MS } from '../issues/review-round-gate.service';
import { ReviewRoundService } from '../issues/review-round.service';
import {
  REVIEW_ROUND_TIMEOUT_KIND,
  buildReviewRoundTimeoutDedupKey,
} from '../chat/review-round-timeout.handler';

describe('PlatformMcpService notifyAgent review-round-open（开轮 sidecar）', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { create: jest.Mock; findMany: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    teamMember: { findFirst: jest.Mock; findUnique: jest.Mock };
    issue: { findUnique: jest.Mock; findMany: jest.Mock };
    messageReceipt: { create: jest.Mock; findFirst: jest.Mock };
  };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
  };
  let rounds: { applyRoundUpdate: jest.Mock };
  let timers: { schedule: jest.Mock };
  let issuesService: { createByAgent: jest.Mock };

  const taskId = 't_0000000001';
  const teamId = 'tm_1';
  const channelId = 'c_0000000001';
  const ctx = { workerId: 'w_0000000001' };
  const senderInstanceId = 'tmm_sender';
  const hostIssueId = 'is_0000000007';

  const TRIPLET_CONTENT =
    '请评审本轮计划 R2 · 计划 v0.3#abcd1234 · expected: tmm_arch,tmm_dev，请发表 VERDICT（引用版本号）';

  const baseArgs = {
    taskId,
    targetInstanceId: 'tmm_tester',
    content: TRIPLET_CONTENT,
    selfInstanceId: senderInstanceId,
    kind: 'review' as const,
  };

  async function buildModule(opts?: {
    withTimers?: boolean;
    withRounds?: boolean;
  }) {
    const withTimers = opts?.withTimers ?? true;
    const withRounds = opts?.withRounds ?? true;
    prisma = {
      session: { findFirst: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { create: jest.fn(), findMany: jest.fn() },
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: { findFirst: jest.fn(), findUnique: jest.fn() },
      issue: { findUnique: jest.fn(), findMany: jest.fn() },
      messageReceipt: { create: jest.fn(), findFirst: jest.fn() },
    };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };
    rounds = { applyRoundUpdate: jest.fn().mockResolvedValue({ round: 2 }) };
    timers = { schedule: jest.fn().mockResolvedValue({ id: 'tmr_1' }) };
    issuesService = {
      createByAgent: jest.fn().mockResolvedValue({ id: 'is_new' }),
    };

    const providers: unknown[] = [
      PlatformMcpService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: IdGeneratorService,
        useValue: { nextId: jest.fn().mockResolvedValue('m_0000000200') },
      },
      {
        provide: RealtimeService,
        useValue: { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) },
      },
      { provide: WorkerClient, useValue: { fetchFile: jest.fn() } },
      { provide: WorkerDispatcher, useValue: workerDispatcher },
      { provide: ArtifactsService, useValue: {} },
      { provide: IssuesService, useValue: issuesService },
      { provide: TasksService, useValue: {} },
      { provide: QuestionsService, useValue: {} },
      {
        provide: NotificationDispatcherService,
        useValue: { sendToChannelByIdOrName: jest.fn() },
      },
      { provide: ExecutionPolicyService, useValue: {} },
      { provide: SkillsService, useValue: {} },
      { provide: GitReposService, useValue: { findAll: jest.fn() } },
      {
        provide: PlanLifecycleService,
        useValue: { getStatus: jest.fn(), autoEnsureRow: jest.fn() },
      },
    ];
    if (withTimers) providers.push({ provide: TimerService, useValue: timers });
    if (withRounds)
      providers.push({ provide: ReviewRoundService, useValue: rounds });

    const module: TestingModule = await Test.createTestingModule({
      providers: providers as never[],
    }).compile();

    service = module.get(PlatformMcpService);
    jest
      .spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((() => undefined) as unknown as jest.Mock);

    prisma.task.findUnique.mockImplementation(
      (args: { where: { id?: string } }) => {
        if (args.where.id === taskId) {
          return Promise.resolve({ teamId });
        }
        return Promise.resolve(null);
      },
    );
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: 'a_sender',
      teamMemberId: senderInstanceId,
    });
    prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
    prisma.teamMember.findFirst.mockResolvedValue({
      agentId: 'a_tester',
      alias: null,
      agent: { id: 'a_tester', name: '测试' },
    });
    prisma.teamMember.findUnique.mockResolvedValue({ agentId: 'a_sender' });
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: senderInstanceId,
    });
    prisma.message.create.mockResolvedValue({
      id: 'm_0000000200',
      channelId,
      status: MESSAGE_STATUS.sent,
      createdAt: new Date('2026-08-07T00:00:00Z'),
    });
    prisma.message.findMany.mockResolvedValue([]);
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.issue.findMany.mockResolvedValue([]);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
  }

  it('有效三元组 + issueId → 账本经 applyRoundUpdate 落盘 + timer 按 dedupKey 排期', async () => {
    await buildModule();
    const before = Date.now();

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      issueId: hostIssueId,
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(rounds.applyRoundUpdate).toHaveBeenCalledTimes(1);
    expect(rounds.applyRoundUpdate).toHaveBeenCalledWith(hostIssueId, {
      round: 2,
      planVersion: { version: 'v0.3', hash: 'abcd1234' },
      expected: ['tmm_arch', 'tmm_dev'],
      taskId,
      status: 'collecting',
      timeoutAt: expect.any(String),
    });
    const update = rounds.applyRoundUpdate.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(update).not.toHaveProperty('received');
    const timeoutAt = new Date(update.timeoutAt as string).getTime();
    expect(timeoutAt - before).toBeGreaterThanOrEqual(
      REVIEW_ROUND_TIMEOUT_MS - 60_000,
    );
    expect(timeoutAt - before).toBeLessThanOrEqual(
      REVIEW_ROUND_TIMEOUT_MS + 60_000,
    );
    expect(timers.schedule).toHaveBeenCalledTimes(1);
    expect(timers.schedule).toHaveBeenCalledWith(
      REVIEW_ROUND_TIMEOUT_KIND,
      expect.any(Date),
      { issueId: hostIssueId, taskId, teamId, round: 2 },
      buildReviewRoundTimeoutDedupKey(hostIssueId, 2),
    );
    expect(timers.schedule.mock.calls[0][3]).toBe(
      `review_round_timeout:${hostIssueId}:2`,
    );
  });

  it('同轮重派 → 幂等：只刷新 expected/timeout，不写 received（received 由裁决路径持有）', async () => {
    await buildModule();

    await service.notifyAgent(ctx, { ...baseArgs, issueId: hostIssueId });
    await service.notifyAgent(ctx, { ...baseArgs, issueId: hostIssueId });

    expect(rounds.applyRoundUpdate).toHaveBeenCalledTimes(2);
    for (const call of rounds.applyRoundUpdate.mock.calls) {
      expect(call[1]).not.toHaveProperty('received');
      expect(call[1]).toEqual(
        expect.objectContaining({ round: 2, status: 'collecting' }),
      );
    }
    expect(timers.schedule).toHaveBeenCalledTimes(2);
    expect(timers.schedule.mock.calls[0][3]).toBe(
      timers.schedule.mock.calls[1][3],
    );
  });

  it('三元组非法 → 不写账本、不排 timer、不落库（review-triplet 拦截零新行）', async () => {
    await buildModule();

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      issueId: hostIssueId,
      content: '请评审新版计划，大家看看给个结论',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('review-triplet');
    expect(result.messageId).toBeNull();
    expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
    expect(timers.schedule).not.toHaveBeenCalled();
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('TimerService 缺席 → 账本照写，派发仍 triggered:true（best-effort sidecar）', async () => {
    await buildModule({ withTimers: false });

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      issueId: hostIssueId,
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(rounds.applyRoundUpdate).toHaveBeenCalledTimes(1);
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
  });

  it('ReviewRoundService 缺席 → 派发仍 triggered:true', async () => {
    await buildModule({ withRounds: false });

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      issueId: hostIssueId,
    });

    expect(result.triggered).toBe(true);
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
  });

  it('无 issueId 但任务已有账本宿主 → 复用宿主，不创建 issue', async () => {
    await buildModule();
    prisma.issue.findMany.mockResolvedValue([
      { id: 'is_other', description: '纯人类文本' },
      {
        id: hostIssueId,
        description:
          '<!-- REVIEW-ROUND-JSON -->\n```json\n{"schemaVersion":1,"round":1,"planVersion":{"version":"v0.1","lines":0,"hash":""},"expected":[],"received":{},"status":"collecting","timeoutAt":""}\n```',
      },
    ]);

    const result = await service.notifyAgent(ctx, baseArgs);

    expect(result.triggered).toBe(true);
    expect(issuesService.createByAgent).not.toHaveBeenCalled();
    expect(rounds.applyRoundUpdate).toHaveBeenCalledWith(
      hostIssueId,
      expect.objectContaining({ round: 2 }),
    );
  });

  it('无 issueId 且无宿主 → 经 createByAgent 建宿主（标题含 R{round} + 版本）', async () => {
    await buildModule();
    prisma.issue.findMany.mockResolvedValue([]);

    const result = await service.notifyAgent(ctx, baseArgs);

    expect(result.triggered).toBe(true);
    expect(issuesService.createByAgent).toHaveBeenCalledWith(
      senderInstanceId,
      taskId,
      expect.objectContaining({
        taskId,
        title: expect.stringContaining('R2'),
      }),
    );
    const title = issuesService.createByAgent.mock.calls[0][2].title as string;
    expect(title).toContain('v0.3');
    expect(rounds.applyRoundUpdate).toHaveBeenCalledWith(
      'is_new',
      expect.objectContaining({ round: 2, status: 'collecting' }),
    );
  });

  describe('同轮重派守卫（G3：complete/stale 为终态，非新轮不得回退）', () => {
    const ledgerText = (status: string, round = 2) =>
      `<!-- REVIEW-ROUND-JSON -->\n\`\`\`json\n${JSON.stringify({
        schemaVersion: 1,
        round,
        planVersion: { version: 'v0.3', lines: 233, hash: 'abcd1234' },
        taskId,
        issueId: hostIssueId,
        expected: ['tmm_arch', 'tmm_dev'],
        received: {
          tmm_arch: { verdict: 'APPROVE', msgId: 'm_540', version: 'v0.3' },
          tmm_dev: { verdict: 'APPROVE', msgId: 'm_541', version: 'v0.3' },
        },
        status,
        timeoutAt: '2026-09-16T00:40:00Z',
      })}\n\`\`\``;

    it('同轮重派 complete 账本 → 跳过 applyRoundUpdate（收敛不被撤销），派发仍成功', async () => {
      await buildModule();
      prisma.issue.findUnique.mockResolvedValue({
        description: ledgerText('complete'),
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: hostIssueId,
      });

      expect(result.triggered).toBe(true);
      expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
    });

    it('同轮重派 stale 账本 → 跳过 applyRoundUpdate（转人工不被撤销）', async () => {
      await buildModule();
      prisma.issue.findUnique.mockResolvedValue({
        description: ledgerText('stale'),
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: hostIssueId,
      });

      expect(result.triggered).toBe(true);
      expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
      expect(timers.schedule).not.toHaveBeenCalled();
    });

    it('同轮重派 collecting 账本 → 行为不变（刷新 expected/timeout）', async () => {
      await buildModule();
      prisma.issue.findUnique.mockResolvedValue({
        description: ledgerText('collecting'),
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: hostIssueId,
      });

      expect(result.triggered).toBe(true);
      expect(rounds.applyRoundUpdate).toHaveBeenCalledTimes(1);
      expect(rounds.applyRoundUpdate).toHaveBeenCalledWith(
        hostIssueId,
        expect.objectContaining({ round: 2, status: 'collecting' }),
      );
      expect(timers.schedule).toHaveBeenCalledTimes(1);
    });

    it('新轮号重派 complete 账本 → 照常开轮（round 前进不受守卫拦截）', async () => {
      await buildModule();
      prisma.issue.findUnique.mockResolvedValue({
        description: ledgerText('complete', 1),
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: hostIssueId,
      });

      expect(result.triggered).toBe(true);
      expect(rounds.applyRoundUpdate).toHaveBeenCalledTimes(1);
    });

    it('F2#1：旧轮重派终态账本 → 跳过（status/expected/timeout 不被覆盖）', async () => {
      await buildModule();
      prisma.issue.findUnique.mockResolvedValue({
        description: ledgerText('complete', 2),
      });
      const warn = (service as unknown as { logger: { warn: jest.Mock } })
        .logger.warn;

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: hostIssueId,
        content:
          '请评审本轮计划 R1 · 计划 v0.2#abcd1234 · expected: tmm_arch,tmm_dev，请发表 VERDICT（引用版本号）',
      });

      expect(result.triggered).toBe(true);
      expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('重派跳过'));
    });

    it('F2#1：旧轮重派 collecting 账本 → 跳过（不覆盖当前轮 expected/timeout）', async () => {
      await buildModule();
      prisma.issue.findUnique.mockResolvedValue({
        description: ledgerText('collecting', 2),
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: hostIssueId,
        content:
          '请评审本轮计划 R1 · 计划 v0.2#abcd1234 · expected: tmm_arch,tmm_dev，请发表 VERDICT（引用版本号）',
      });

      expect(result.triggered).toBe(true);
      expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
      expect(timers.schedule).not.toHaveBeenCalled();
    });

    it('F2#4：账本读取失败 → fail-closed 跳过开轮 + warn（不覆盖终态）', async () => {
      await buildModule();
      prisma.issue.findUnique.mockRejectedValue(new Error('db 瞬断'));
      const warn = (service as unknown as { logger: { warn: jest.Mock } })
        .logger.warn;

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: hostIssueId,
      });

      expect(result.triggered).toBe(true);
      expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
      expect(timers.schedule).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('账本读取失败'),
      );
    });
  });
});
