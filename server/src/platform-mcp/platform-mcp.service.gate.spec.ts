import { Test, TestingModule } from '@nestjs/testing';
import {
  EVENT_TYPES,
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

/**
 * plan-review-execution-gates Todo 4：执行 kind 分类 + 计划门禁 + issue 锁。
 *
 * 门禁矩阵（notifyAgent 层）：
 * - kind=execution + plans.status 非 executing → triggered:false + reason=plan-gated（含计划未放行 hint），不触发 dispatch。
 * - kind=review/nudge/wake → 在任何计划态（含无行/DB 错）下全放行。
 * - force=true + 非空 forceReason → 绕过门禁并写回执审计行（forceReason 落库）。
 * - kind=wake（含内部 wake/round-notify）永不写回执行。
 * - DB 读错 → fail-open 放行 + warn 日志（永不静默转 fail-closed）。
 * issue 锁（issue.constants 五态机，assigneeInstanceId 为比较字段——与实现一致，无文档漂移）：
 * - open → 放行；in_progress + 同 assigneeInstanceId → reason=duplicate + origMessageId；
 *   换人 → 放行；resolved/closed/rejected → 作为新一轮放行。
 */
describe('PlatformMcpService notifyAgent 门禁矩阵（todo4）', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { create: jest.Mock };
    task: { findUnique: jest.Mock };
    teamMember: { findFirst: jest.Mock; findUnique: jest.Mock };
    issue: { findUnique: jest.Mock };
    messageReceipt: { create: jest.Mock; findFirst: jest.Mock };
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workerDispatcher: { dispatchAgentMention: jest.Mock; isAgentExecuting: jest.Mock };
  let planLifecycle: { getStatus: jest.Mock; autoEnsureRow: jest.Mock };
  let loggerWarnSpy: jest.SpyInstance;

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
      message: { create: jest.fn() },
      task: { findUnique: jest.fn() },
      teamMember: { findFirst: jest.fn(), findUnique: jest.fn() },
      issue: { findUnique: jest.fn() },
      messageReceipt: { create: jest.fn(), findFirst: jest.fn() },
    };
    idGen = { nextId: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workerDispatcher = { dispatchAgentMention: jest.fn().mockResolvedValue(undefined), isAgentExecuting: jest.fn().mockReturnValue(null) };
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
    loggerWarnSpy = jest
      .spyOn((service as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation((() => undefined) as unknown as jest.Mock);

    // 归属校验 + 落库前置一律通过（门禁层唯一变量为计划态/issue 态/kind/force）。
    prisma.task.findUnique.mockImplementation((args: { where: { id?: string } }) => {
      if (args.where.id === taskId) {
        return Promise.resolve({ teamId: 'tm_1' });
      }
      return Promise.resolve(null);
    });
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
    idGen.nextId.mockResolvedValue('m_0000000200');
    prisma.message.create.mockResolvedValue(createdMessage);
    // 缺省：无 issue 绑定、无回执行。
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  describe('计划门禁（kind=execution）', () => {
    it.each([['draft'], ['reviewing'], ['approved'], ['rejected'], ['completed']])(
      '执行派发在 %s 态被拦：triggered=false + reason=plan-gated + 计划未放行 hint，不触发 dispatch',
      async (status: string) => {
        planLifecycle.getStatus.mockResolvedValue(status);

        const result = await service.notifyAgent(ctx, baseArgs);

        expect(planLifecycle.getStatus).toHaveBeenCalledWith(taskId);
        expect(result.triggered).toBe(false);
        expect(result.reason).toBe('plan-gated');
        expect(result.hint).toMatch('计划未放行');
        expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
        // 消息本身仍已落库广播（门禁只拦触发，不拦发布）。
        expect(prisma.message.create).toHaveBeenCalled();
      },
    );

    it('executing 态放行：kind 透传给 dispatchAgentMention', async () => {
      planLifecycle.getStatus.mockResolvedValue('executing');

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'execution' }),
      );
    });

    it('无 plan 行→autoEnsureRow 建行后再门禁（新建 draft 行→仍被拦）', async () => {
      planLifecycle.getStatus.mockResolvedValue(null);
      planLifecycle.autoEnsureRow.mockResolvedValue({ status: 'draft' });

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(planLifecycle.autoEnsureRow).toHaveBeenCalledWith(taskId);
      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('plan-gated');
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('DB 读错→fail-open 放行 + warn 日志（永不转 fail-closed）', async () => {
      planLifecycle.getStatus.mockRejectedValue(new Error('db down'));

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it('兜底建行失败→fail-open 放行 + warn 日志', async () => {
      planLifecycle.getStatus.mockResolvedValue(null);
      planLifecycle.autoEnsureRow.mockRejectedValue(new Error('db down'));

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(true);
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it('force=true + forceReason→绕过门禁并写回执审计行', async () => {
      planLifecycle.getStatus.mockResolvedValue('approved');
      prisma.messageReceipt.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(data),
      );

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        force: true,
        forceReason: '线上故障需立即执行',
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
      expect(prisma.messageReceipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          messageId: 'm_0000000200',
          forceReason: '线上故障需立即执行',
          kind: 'dispatch',
        }),
      });
    });

    it('force=true 但缺 forceReason→仍被拦（空原因不算绕过）', async () => {
      planLifecycle.getStatus.mockResolvedValue('approved');

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        force: true,
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('plan-gated');
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });
  });

  describe('豁免 kind：review/nudge/wake 在任何计划态下全放行', () => {
    // todo 8 起 kind=review 须带三元组（round + planVersion(+hash) + expected）：
    // 以下豁免断言验证“免计划门禁”，故 review 用三元组齐全派发词；
    // 缺三元组拒绝见 platform-mcp.service.review-dispatch.spec.ts。
    const reviewArgs = {
      ...baseArgs,
      content:
        '请评审本轮计划 R1 · 计划 v0.1#1234abcd · expected: tmm_arch,tmm_dev，请发表 VERDICT',
    };
    it.each([['review'], ['nudge'], ['wake']])(
      'kind=%s + approved 态→放行且不查门禁写回执',
      async (kind: string) => {
        const result = await service.notifyAgent(ctx, {
          ...(kind === 'review' ? reviewArgs : baseArgs),
          kind: kind as 'review' | 'nudge' | 'wake',
        });

        expect(result.triggered).toBe(true);
        expect(result.reason).toBe('ok');
        expect(planLifecycle.getStatus).not.toHaveBeenCalled();
        expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
        expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
          expect.objectContaining({ kind }),
        );
      },
    );

    it.each([['review'], ['nudge'], ['wake']])(
      'kind=%s + DB 读错→照常放行（豁免路径永不读门禁）',
      async (kind: string) => {
        planLifecycle.getStatus.mockRejectedValue(new Error('db down'));

        const result = await service.notifyAgent(ctx, {
          ...(kind === 'review' ? reviewArgs : baseArgs),
          kind: kind as 'review' | 'nudge' | 'wake',
        });

        expect(result.triggered).toBe(true);
        expect(planLifecycle.getStatus).not.toHaveBeenCalled();
      },
    );
  });

  describe('计划角色豁免：kind=execution 派给 a_plan 永不进计划门禁', () => {
    it('draft 态派给 a_plan → 放行且不读门禁（计划工作永非执行）', async () => {
      prisma.teamMember.findFirst.mockResolvedValueOnce({
        agentId: 'a_plan',
        alias: null,
        agent: { id: 'a_plan', name: '计划员' },
      });
      planLifecycle.getStatus.mockResolvedValue('draft');

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        targetInstanceId: 'tmm_plan',
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(planLifecycle.getStatus).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'execution' }),
      );
    });

    it('无 plan 行派给 a_plan → 放行且不兜底建行', async () => {
      prisma.teamMember.findFirst.mockResolvedValueOnce({
        agentId: 'a_plan',
        alias: null,
        agent: { id: 'a_plan', name: '计划员' },
      });
      planLifecycle.getStatus.mockResolvedValue(null);

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        targetInstanceId: 'tmm_plan',
      });

      expect(result.triggered).toBe(true);
      expect(planLifecycle.getStatus).not.toHaveBeenCalled();
      expect(planLifecycle.autoEnsureRow).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
    });

    it('draft 态派给 a_developer → 仍被拦且 hint 含计划未放行', async () => {
      prisma.teamMember.findFirst.mockResolvedValueOnce({
        agentId: 'a_developer',
        alias: null,
        agent: { id: 'a_developer', name: '开发者' },
      });
      planLifecycle.getStatus.mockResolvedValue('draft');

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        targetInstanceId: 'tmm_dev',
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('plan-gated');
      expect(result.hint).toMatch('计划未放行');
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });
  });

  describe('issue 状态锁', () => {
    beforeEach(() => {
      planLifecycle.getStatus.mockResolvedValue('executing');
    });

    it('open → 放行', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'open',
        assigneeInstanceId: null,
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
      });

      expect(result.triggered).toBe(true);
      expect(result.issueBound).toBe(true);
    });

    it('in_progress + 同 assigneeInstanceId → reason=duplicate + origMessageId，不触发', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: 'tmm_tester',
      });
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('duplicate');
      expect(result.origMessageId).toBe('m_0000000100');
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('in_progress + 换人（assignee 不同）→ 放行新一轮', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: 'tmm_other',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
    });

    it.each([['resolved'], ['closed'], ['rejected']])(
      '终态 %s → 作为新一轮放行',
      async (status: string) => {
        prisma.issue.findUnique.mockResolvedValue({
          status,
          assigneeInstanceId: 'tmm_tester',
        });

        const result = await service.notifyAgent(ctx, {
          ...baseArgs,
          issueId: 'is_0000000001',
        });

        expect(result.triggered).toBe(true);
        expect(result.reason).toBe('ok');
      },
    );

    it('issue 读错→fail-open 放行 + warn', async () => {
      prisma.issue.findUnique.mockRejectedValue(new Error('db down'));

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
      });

      expect(result.triggered).toBe(true);
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });
});
