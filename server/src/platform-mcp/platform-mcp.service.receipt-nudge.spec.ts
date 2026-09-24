import { Test, TestingModule } from '@nestjs/testing';
import {
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TimerService } from '../timers/trigger.service';
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
import { RECEIPT_NUDGE_KIND } from '../chat/receipt-nudge.handler';
import { createLedger, embedLedger } from '../issues/review-round-ledger';

describe('PlatformMcpService notifyAgent 回执自动催办排期（receipt-nudge-consumer）', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { create: jest.Mock; findMany: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    teamMember: { findFirst: jest.Mock; findUnique: jest.Mock };
    issue: { findUnique: jest.Mock };
    messageReceipt: { create: jest.Mock; findFirst: jest.Mock };
  };
  let idGen: { nextId: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
  };
  let timers: { schedule: jest.Mock };
  let planLifecycle: { getStatus: jest.Mock; autoEnsureRow: jest.Mock };
  let loggerWarnSpy: jest.SpyInstance;

  const taskId = 't_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId: 'w_0000000001' };
  const senderInstanceId = 'tmm_sender';

  const baseArgs = {
    taskId,
    targetInstanceId: 'tmm_tester',
    content: '请执行该需求',
    selfInstanceId: senderInstanceId,
  };

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { create: jest.fn(), findMany: jest.fn() },
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: { findFirst: jest.fn(), findUnique: jest.fn() },
      issue: { findUnique: jest.fn() },
      messageReceipt: { create: jest.fn(), findFirst: jest.fn() },
    };
    idGen = { nextId: jest.fn() };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };
    timers = { schedule: jest.fn(async () => ({ id: 'tmr_1' })) };
    planLifecycle = { getStatus: jest.fn(), autoEnsureRow: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
        { provide: WorkerClient, useValue: { fetchFile: jest.fn() } },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ArtifactsService, useValue: {} },
        { provide: IssuesService, useValue: {} },
        { provide: TasksService, useValue: {} },
        { provide: QuestionsService, useValue: {} },
        {
          provide: NotificationDispatcherService,
          useValue: { sendToChannelByIdOrName: jest.fn() },
        },
        { provide: ExecutionPolicyService, useValue: {} },
        { provide: SkillsService, useValue: {} },
        { provide: GitReposService, useValue: { findAll: jest.fn() } },
        { provide: PlanLifecycleService, useValue: planLifecycle },
        { provide: TimerService, useValue: timers },
      ],
    }).compile();

    service = module.get(PlatformMcpService);
    loggerWarnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((() => undefined) as unknown as jest.Mock);

    prisma.task.findUnique.mockImplementation(
      (args: { where: { id?: string } }) => {
        if (args.where.id === taskId)
          return Promise.resolve({ teamId: 'tm_1' });
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
      alias: '测试',
      agent: { id: 'a_tester', name: '测试' },
    });
    prisma.teamMember.findUnique.mockResolvedValue({ agentId: 'a_sender' });
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: senderInstanceId,
    });
    idGen.nextId.mockImplementation(async (prefix: string) =>
      prefix === 'mr' ? 'mr_0000000001' : 'm_0000000200',
    );
    prisma.message.create.mockResolvedValue({
      id: 'm_0000000200',
      channelId,
      status: MESSAGE_STATUS.sent,
      senderType: SENDER_TYPE.agent,
      createdAt: new Date('2026-08-07T00:00:00Z'),
    });
    prisma.message.findMany.mockResolvedValue([]);
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
    planLifecycle.getStatus.mockResolvedValue('executing');
    prisma.messageReceipt.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...data }),
    );
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  it('缺省超时 30 分钟：记账 expiresAt≈now+30min + timer kind/fireAt/dedupKey/payload', async () => {
    const before = Date.now();

    const result = await service.notifyAgent(ctx, baseArgs);

    const after = Date.now();
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(prisma.messageReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        messageId: 'm_0000000200',
        fromInstanceId: senderInstanceId,
        toInstanceId: 'tmm_tester',
        taskId,
        teamId: 'tm_1',
        status: 'pending',
        kind: 'dispatch',
      }),
    });
    const created = prisma.messageReceipt.create.mock.calls[0][0].data as {
      expiresAt: Date;
    };
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 30 * 60 * 1000,
    );
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(
      after + 30 * 60 * 1000,
    );
    expect(timers.schedule).toHaveBeenCalledTimes(1);
    const [kind, fireAt, payload, dedupKey] = timers.schedule.mock.calls[0] as [
      string,
      Date,
      Record<string, unknown>,
      string,
    ];
    expect(kind).toBe(RECEIPT_NUDGE_KIND);
    expect(fireAt.getTime()).toBe(created.expiresAt.getTime());
    expect(dedupKey).toBe('receipt_nudge:tm_1:mr_0000000001');
    expect(payload).toMatchObject({
      receiptId: 'mr_0000000001',
      teamId: 'tm_1',
      taskId,
      channelId,
      messageId: 'm_0000000200',
      toInstanceId: 'tmm_tester',
    });
  });

  it('显式 receiptTimeoutMin=30：expiresAt≈now+30min', async () => {
    const before = Date.now();

    await service.notifyAgent(ctx, { ...baseArgs, receiptTimeoutMin: 30 });

    const after = Date.now();
    const created = prisma.messageReceipt.create.mock.calls[0][0].data as {
      expiresAt: Date;
    };
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 30 * 60 * 1000,
    );
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(
      after + 30 * 60 * 1000,
    );
  });

  it('超上限夹到 1440：receiptTimeoutMin=5000 → expiresAt≈now+1440min', async () => {
    const before = Date.now();

    await service.notifyAgent(ctx, { ...baseArgs, receiptTimeoutMin: 5000 });

    const after = Date.now();
    const created = prisma.messageReceipt.create.mock.calls[0][0].data as {
      expiresAt: Date;
    };
    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 1440 * 60 * 1000,
    );
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(
      after + 1440 * 60 * 1000,
    );
  });

  it.each([[0], [-5], [NaN]])(
    '非法输入 %p → 回落缺省 30 分钟（永不抛）',
    async (bad: number) => {
      const before = Date.now();

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        receiptTimeoutMin: bad,
      });

      const after = Date.now();
      expect(result.triggered).toBe(true);
      const created = prisma.messageReceipt.create.mock.calls[0][0].data as {
        expiresAt: Date;
      };
      expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + 30 * 60 * 1000,
      );
      expect(created.expiresAt.getTime()).toBeLessThanOrEqual(
        after + 30 * 60 * 1000,
      );
    },
  );

  it('timer 排期失败 → 派发仍成功（best-effort，仅 warn）', async () => {
    timers.schedule.mockRejectedValue(new Error('timer db down'));

    const result = await service.notifyAgent(ctx, baseArgs);

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalled();
  });

  it('记账落库失败 → 派发仍成功且无 timer（no receipt → no timer）', async () => {
    prisma.messageReceipt.create.mockRejectedValue(new Error('db down'));
    prisma.messageReceipt.findFirst.mockResolvedValue(null);

    const result = await service.notifyAgent(ctx, baseArgs);

    expect(result.triggered).toBe(true);
    expect(timers.schedule).not.toHaveBeenCalled();
    expect(loggerWarnSpy).toHaveBeenCalled();
  });

  it('kind=nudge/wake/review → 永不记账不排期（账本豁免语义不变）', async () => {
    const reviewArgs = {
      ...baseArgs,
      kind: 'review' as const,
      content:
        '请评审本轮计划 R1 · 计划 v0.1#1234abcd · expected: tmm_arch,tmm_dev，请发表 VERDICT',
    };
    for (const args of [
      { ...baseArgs, kind: 'nudge' as const },
      { ...baseArgs, kind: 'wake' as const },
      reviewArgs,
    ]) {
      prisma.messageReceipt.create.mockClear();
      timers.schedule.mockClear();

      const result = await service.notifyAgent(ctx, args);

      expect(result.triggered).toBe(true);
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
      expect(timers.schedule).not.toHaveBeenCalled();
    }
  });

  it('is_5 回归：同 issue 不同内容 → 不同 dedupKey，两次均派发（禁止 issue 尾碰撞误吞）', async () => {
    const first = await service.notifyAgent(ctx, {
      ...baseArgs,
      issueId: 'is_0000000001',
      content: '请评审第一版方案设计文档并给出结论',
    });
    const second = await service.notifyAgent(ctx, {
      ...baseArgs,
      issueId: 'is_0000000001',
      content: '请修复登录页面的空指针崩溃问题',
    });

    expect(first.triggered).toBe(true);
    expect(first.reason).toBe('ok');
    expect(second.triggered).toBe(true);
    expect(second.reason).toBe('ok');
    expect(prisma.messageReceipt.create).toHaveBeenCalledTimes(2);
    const calls = prisma.messageReceipt.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(calls[0].dedupKey).not.toBe(calls[1].dedupKey);
    // issueId 仍按列落库（仅不参与组键）
    expect(calls[0].issueId).toBe('is_0000000001');
    expect(calls[1].issueId).toBe('is_0000000001');
  });

  it('记账 P2002 去重命中 pending 行 → 复用既有 receipt 排期（fireAt 取既有 expiresAt）', async () => {
    const existingExpires = new Date(Date.now() + 5 * 60 * 1000);
    prisma.messageReceipt.create.mockRejectedValue({
      code: 'P2002',
      // 实测形态：MySQL 下 Prisma 的 meta.target 为字符串约束名
      meta: { target: 'message_receipts_dedup_key_key' },
    });
    prisma.messageReceipt.findFirst.mockResolvedValue({
      id: 'mr_exist',
      status: 'pending',
      expiresAt: existingExpires,
    });

    const result = await service.notifyAgent(ctx, baseArgs);

    expect(result.triggered).toBe(true);
    expect(timers.schedule).toHaveBeenCalledTimes(1);
    const [kind, fireAt, payload, dedupKey] = timers.schedule.mock.calls[0] as [
      string,
      Date,
      Record<string, unknown>,
      string,
    ];
    expect(kind).toBe(RECEIPT_NUDGE_KIND);
    expect(fireAt.getTime()).toBe(existingExpires.getTime());
    expect(dedupKey).toBe('receipt_nudge:tm_1:mr_exist');
    expect(payload).toMatchObject({ receiptId: 'mr_exist' });
  });

  it('哈希门禁拦截（plan-gated）→ 不落库不记账不排期（只在真实分派后排）', async () => {
    prisma.issue = {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([
        {
          description: embedLedger(
            '派发评审',
            createLedger({
              round: 1,
              planVersion: { version: 'v0.1', lines: 10, hash: 'expected1' },
              expected: ['tmm_tester'],
              status: 'complete',
              timeoutAt: '2026-09-16T00:40:00Z',
            }),
          ),
        },
      ]),
    } as never;

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      planHash: 'stalexyz',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('plan-gated');
    expect(result.messageId).toBeNull();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    expect(timers.schedule).not.toHaveBeenCalled();
  });
});
