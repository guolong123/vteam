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
import {
  REVIEW_TRIPLET_HINT,
  ROLE_VIEW_FOOTER,
} from '../chat/review-dispatch-triplet';

/**
 * plan-review-execution-gates Todo 8（failing-first）：
 * kind=review 的 notifyAgent 派发必须携带三元组
 * round + planVersion(+hash) + expected 名单；
 * 缺三元组 → triggered:false + reason=review-triplet + 精确 hint，
 * 不调用 dispatchAgentMention（修订不开始）；
 * 三元组齐全 → 放行且派发词嵌入视角边界。
 * 单一 choke 点：notifyAgent（dispatchAgentMention 返回 void 无法回 hint，
 * 内部 wake/round-notify 走 kind=wake 永不命中本门）。
 */
describe('PlatformMcpService notifyAgent 评审三元组门（todo8）', () => {
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
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
  };
  let planLifecycle: { getStatus: jest.Mock; autoEnsureRow: jest.Mock };

  const taskId = 't_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId: 'w_0000000001' };
  const senderInstanceId = 'tmm_sender';

  const createdMessage = {
    id: 'm_0000000200',
    channelId,
    status: MESSAGE_STATUS.sent,
    createdAt: new Date('2026-08-07T00:00:00Z'),
  };

  const TRIPLET_CONTENT =
    '请评审本轮计划 R2 · 计划 v0.3#abcd1234 · expected: tmm_arch,tmm_dev，请发表 VERDICT（引用版本号）';

  const baseArgs = {
    taskId,
    targetInstanceId: 'tmm_tester',
    content: TRIPLET_CONTENT,
    selfInstanceId: senderInstanceId,
    kind: 'review' as const,
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
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };
    planLifecycle = { getStatus: jest.fn(), autoEnsureRow: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
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
    prisma.message.create.mockResolvedValue(createdMessage);
    prisma.message.findMany.mockResolvedValue([]);
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
  });

  it('缺三元组 → triggered=false + reason=review-triplet + 精确 hint，不触发 dispatch 不落库（修订不开始）', async () => {
    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      content: '请评审新版计划，大家看看给个结论',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('review-triplet');
    expect(result.hint).toContain(REVIEW_TRIPLET_HINT);
    expect(result.hint).toContain('请勿重发');
    expect(result.messageId).toBeNull();
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('缺 hash → 同样被拒（planVersion 必须带 hash 钉定，不落库）', async () => {
    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      content: '请评审 R2 · v0.3 · expected: tmm_arch,tmm_dev',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('review-triplet');
    expect(result.hint).toContain(REVIEW_TRIPLET_HINT);
    expect(result.messageId).toBeNull();
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('三元组齐全 → 放行且派发词嵌入视角边界', async () => {
    const result = await service.notifyAgent(ctx, baseArgs);

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'review',
        text: expect.stringContaining(ROLE_VIEW_FOOTER),
      }),
    );
    const dispatched = workerDispatcher.dispatchAgentMention.mock
      .calls[0][0] as {
      text: string;
    };
    expect(dispatched.text).toContain('R2');
    expect(dispatched.text).toContain('v0.3#abcd1234');
  });

  it('kind=execution 不受三元组门影响（executing 态无三元组照常放行）', async () => {
    planLifecycle.getStatus.mockResolvedValue('executing');

    const result = await service.notifyAgent(ctx, {
      taskId,
      targetInstanceId: 'tmm_tester',
      content: '请执行该需求',
      selfInstanceId: senderInstanceId,
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it.each([['nudge'], ['wake']])(
    'kind=%s 不受三元组门影响（无三元组照常放行）',
    async (kind: string) => {
      const result = await service.notifyAgent(ctx, {
        taskId,
        targetInstanceId: 'tmm_tester',
        content: '请执行该需求',
        selfInstanceId: senderInstanceId,
        kind: kind as 'nudge' | 'wake',
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
    },
  );

  it('团队维度 kind=review 缺三元组 → 同样被拒（不落库）', async () => {
    prisma.session.findFirst.mockResolvedValueOnce({
      id: 's_team',
      agentId: 'a_sender',
      teamMemberId: senderInstanceId,
    });

    const result = await service.notifyAgent(ctx, {
      teamId: 'tm_1',
      targetInstanceId: 'tmm_tester',
      content: '请评审新版计划',
      selfInstanceId: senderInstanceId,
      kind: 'review',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('review-triplet');
    expect(result.hint).toContain(REVIEW_TRIPLET_HINT);
    expect(result.messageId).toBeNull();
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});
