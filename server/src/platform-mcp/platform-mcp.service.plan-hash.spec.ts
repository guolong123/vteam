import { Test, TestingModule } from '@nestjs/testing';
import {
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
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
import { createLedger, embedLedger } from '../issues/review-round-ledger';

/**
 * plan-finalize-actions todo 3 + server-gate-removal-tool-authority todo 3：
 * notifyAgent 执行认哈希门禁（计划状态不再是门禁）。
 *
 * - 调用方 planHash 与冻结哈希不一致 → triggered:false + reason=plan-gated +
 *   hint 同时命名期望/实际短哈希，不触发 dispatch（任何计划态、任何目标一致）；
 * - 哈希一致 → 放行；
 * - 未携带 planHash → 门禁未武装，放行（不收紧既有放行面）；
 * - force=true + 非空 forceReason → 照旧绕过并留审计行（不因哈希新增限制）。
 */
describe('PlatformMcpService notifyAgent 哈希门禁（todo 3）', () => {
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
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
  };
  let planLifecycle: { getStatus: jest.Mock; autoEnsureRow: jest.Mock };

  const taskId = 't_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId: 'w_0000000001' };
  const senderInstanceId = 'tmm_sender';

  const FROZEN_HASH = 'a1b2c3d4';
  const STALE_HASH = 'deadbeef';

  const frozenDescription = embedLedger(
    '派发评审',
    createLedger({
      round: 2,
      planVersion: { version: 'v0.2', lines: 233, hash: FROZEN_HASH },
      expected: ['tmm_arch'],
      status: 'complete',
      timeoutAt: '2026-09-16T00:40:00Z',
    }),
  );

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
      issue: { findUnique: jest.fn(), findMany: jest.fn() },
      messageReceipt: { create: jest.fn(), findFirst: jest.fn() },
    };
    idGen = { nextId: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };
    planLifecycle = { getStatus: jest.fn(), autoEnsureRow: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
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
      ],
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
          return Promise.resolve({ teamId: 'tm_1' });
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
    idGen.nextId.mockResolvedValue('m_0000000200');
    prisma.message.create.mockResolvedValue({
      id: 'm_0000000200',
      channelId,
      status: MESSAGE_STATUS.sent,
      createdAt: new Date('2026-08-07T00:00:00Z'),
    });
    prisma.message.findMany.mockResolvedValue([]);
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
    prisma.issue.findMany.mockResolvedValue([
      { description: frozenDescription },
    ]);
    planLifecycle.getStatus.mockResolvedValue('executing');
  });

  it('过期哈希被拦：triggered=false + reason=plan-gated + hint 含两边短哈希 + 不落库', async () => {
    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      planHash: STALE_HASH,
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('plan-gated');
    expect(result.hint).toContain(`#${FROZEN_HASH}`);
    expect(result.hint).toContain(`#${STALE_HASH}`);
    expect(result.hint).toContain('请勿重发');
    expect(result.messageId).toBeNull();
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('哈希匹配 → 放行透传', async () => {
    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      planHash: FROZEN_HASH,
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
  });

  it('未携带 planHash → 原行为（executing 放行，不读账本不收紧）', async () => {
    const result = await service.notifyAgent(ctx, baseArgs);

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(prisma.issue.findMany).not.toHaveBeenCalled();
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
  });

  it('非 executing 态 + 哈希匹配 → 放行（状态门禁已移除，仅哈希裁决）', async () => {
    planLifecycle.getStatus.mockResolvedValue('approved');

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      planHash: FROZEN_HASH,
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('非 executing 态（draft）且无 planHash → 放行（无状态门禁、哈希未武装）', async () => {
    planLifecycle.getStatus.mockResolvedValue('draft');

    const result = await service.notifyAgent(ctx, baseArgs);

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
  });

  it('过期哈希 + force=true/原因 → 绕过并写审计行（不因哈希新增限制）', async () => {
    prisma.messageReceipt.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(data),
    );

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      planHash: STALE_HASH,
      force: true,
      forceReason: '线上故障需立即执行',
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(prisma.messageReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ forceReason: '线上故障需立即执行' }),
    });
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
  });

  it('账本读错 → fail-open 放行（永不转 fail-closed）', async () => {
    prisma.issue.findMany.mockRejectedValue(new Error('db down'));

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      planHash: STALE_HASH,
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
  });
});
