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
import {
  createLedger,
  embedLedger,
} from '../issues/review-round-ledger';

/**
 * plan-review-execution-gates Todo 4：执行 kind 分类 + 计划门禁 + issue 锁。
 *
 * 门禁矩阵（notifyAgent 层）：
 * - kind=execution + plans.status 非 executing → triggered:false + reason=plan-gated（含计划未放行 hint），不触发 dispatch，不落库不广播（messageId:null）。
 * - kind=review/nudge/wake → 在任何计划态（含无行/DB 错）下全放行。
 * - force=true + 非空 forceReason → 绕过门禁并写回执审计行（forceReason 落库）。
 * - kind=wake（含内部 wake/round-notify）永不写回执行。
 * - DB 读错 → fail-open 放行 + warn 日志（永不静默转 fail-closed）。
 * issue 锁（issue.constants 五态机，assigneeInstanceId 为比较字段——与实现一致，无文档漂移）：
 * - open → 放行；in_progress + 同 assigneeInstanceId → reason=duplicate + messageId/origMessageId=既有在途消息，不落库；
 *   换人 → 放行；resolved/closed/rejected → 作为新一轮放行。
 */
describe('PlatformMcpService notifyAgent 门禁矩阵（todo4）', () => {
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
    issueActivity: { count: jest.Mock; create: jest.Mock };
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
  };
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
      message: { create: jest.fn(), findMany: jest.fn() },
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: { findFirst: jest.fn(), findUnique: jest.fn() },
      issue: { findUnique: jest.fn(), findMany: jest.fn() },
      messageReceipt: { create: jest.fn(), findFirst: jest.fn() },
      issueActivity: { count: jest.fn().mockResolvedValue(0), create: jest.fn() },
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
    loggerWarnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((() => undefined) as unknown as jest.Mock);

    // 归属校验 + 落库前置一律通过（门禁层唯一变量为计划态/issue 态/kind/force）。
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
    // 主 Agent 路由门：缺省调用方即主成员（门禁矩阵断言只关心计划态/issue 态，路由维度恒放行）。
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: senderInstanceId,
    });
    idGen.nextId.mockResolvedValue('m_0000000200');
    prisma.message.create.mockResolvedValue(createdMessage);
    // 幂等探针缺省无命中（各 reject 用例断言“零新行”时探针不干扰）。
    prisma.message.findMany.mockResolvedValue([]);
    // 缺省：无 issue 绑定、无回执行。
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.issue.findMany.mockResolvedValue([]);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  function armFrozenHash(hash: string): void {
    prisma.issue.findMany = jest.fn().mockResolvedValue([
      {
        description: embedLedger(
          '派发评审',
          createLedger({
            round: 1,
            planVersion: { version: 'v0.1', lines: 10, hash },
            expected: ['tmm_tester'],
            status: 'complete',
            timeoutAt: '2026-09-16T00:40:00Z',
          }),
        ),
      },
    ]);
  }

  describe('计划状态不再作为派发门禁（kind=execution）', () => {
    it.each([
      ['draft'],
      ['reviewing'],
      ['approved'],
      ['rejected'],
      ['completed'],
    ])(
      '执行派发在 %s 态一律放行：triggered=true + 不读计划状态、不落 plan-gated',
      async (status: string) => {
        planLifecycle.getStatus.mockResolvedValue(status);

        const result = await service.notifyAgent(ctx, baseArgs);

        expect(result.triggered).toBe(true);
        expect(result.reason).toBe('ok');
        expect(planLifecycle.getStatus).not.toHaveBeenCalled();
        expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'execution' }),
        );
        expect(prisma.message.create).toHaveBeenCalled();
      },
    );

    it('执行派发仍兜底建 plan 行 + 透传 kind 给 dispatchAgentMention', async () => {
      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(true);
      expect(planLifecycle.autoEnsureRow).toHaveBeenCalledWith(taskId);
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'execution' }),
      );
    });

    it('兜底建行失败→fail-open 放行 + warn 日志', async () => {
      planLifecycle.autoEnsureRow.mockRejectedValue(new Error('db down'));

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalled();
    });

    it('携带过期 planHash → 哈希门禁拦截（triggered=false + reason=plan-gated，不落库）', async () => {
      armFrozenHash('expected1');
      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        planHash: 'stalexyz',
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('plan-gated');
      expect(result.hint).toContain('#expected1');
      expect(result.hint).toContain('#stalexyz');
      expect(result.messageId).toBeNull();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('force=true + forceReason 可绕过过期哈希并写回执审计行', async () => {
      armFrozenHash('expected1');
      prisma.messageReceipt.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => Promise.resolve(data),
      );

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        planHash: 'stalexyz',
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

  describe('a_plan 角色豁免已删除：hash 门禁对每个目标一律生效', () => {
    it('draft 态派给 a_plan → 放行（状态门禁已移除）且仍经 autoEnsureRow 兜底建行', async () => {
      prisma.teamMember.findFirst.mockResolvedValueOnce({
        agentId: 'a_plan',
        alias: null,
        agent: { id: 'a_plan', name: '计划员' },
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        targetInstanceId: 'tmm_plan',
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(planLifecycle.autoEnsureRow).toHaveBeenCalledWith(taskId);
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'execution' }),
      );
    });

    it('派给 a_plan 且携带过期哈希 → 哈希门禁照常拦截（豁免删除的核心）', async () => {
      prisma.teamMember.findFirst.mockResolvedValueOnce({
        agentId: 'a_plan',
        alias: null,
        agent: { id: 'a_plan', name: '计划员' },
      });
      armFrozenHash('expected1');

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        targetInstanceId: 'tmm_plan',
        planHash: 'stalexyz',
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('plan-gated');
      expect(result.hint).toContain('#expected1');
      expect(result.hint).toContain('#stalexyz');
      expect(result.messageId).toBeNull();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('draft 态派给 a_developer → 放行（原“计划未放行”拦截已移除）', async () => {
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

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
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

    it('in_progress + 同 assignee + **回执在途(pending)** → reason=duplicate + 既有消息回显，不触发不落库', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: 'tmm_tester',
      });
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'pending',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('duplicate');
      expect(result.origMessageId).toBe('m_0000000100');
      expect(result.messageId).toBe('m_0000000100');
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('in_progress + 同 assignee 但**无在途回执** → 放行重派（断死锁：曾被拦在写回执之前 → 永远 duplicate 且无人可解）', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: 'tmm_tester',
      });
      prisma.messageReceipt.findFirst.mockResolvedValue(null);

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
      });

      expect(result.triggered).toBe(true);
      expect(result.issueBound).toBe(true);
      expect(prisma.message.create).toHaveBeenCalled();
    });

    it('in_progress + 同 assignee + 回执已 acked → 同样放行（仅 pending 才算在途）', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: 'tmm_tester',
      });
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'acked',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
      });

      expect(result.triggered).toBe(true);
    });

    it('被 issue 门拦下 → 落 issue_activities(dispatch_blocked) 留痕（原先只 warn，平台无感知）', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: 'tmm_tester',
      });
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'pending',
      });
      prisma.issueActivity.count.mockResolvedValue(1); // 窗口内第 2 次 → 触发升级提示

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
      });

      expect(result.triggered).toBe(false);
      expect(prisma.issueActivity.create).toHaveBeenCalledTimes(1);
      expect(prisma.issueActivity.create.mock.calls[0][0].data).toMatchObject({
        issueId: 'is_0000000001',
        action: 'dispatch_blocked',
        instanceId: expect.any(String),
      });
      // 第 2 次被拦 → 向频道发一条 system 升级提示
      const created = prisma.message.create.mock.calls[0]?.[0]?.data;
      expect(created?.senderType).toBe('system');
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

  describe('task-11 双空上下文回填（resolveToolCallerWithContext）', () => {
    it('(a) 回填绑定最近会话的 taskId', async () => {
      prisma.session.findFirst.mockResolvedValueOnce({
        taskId: 't_latest',
        teamId: 'tm_1',
        teamMemberId: 'tmm_sender',
        agentId: 'a_sender',
      });
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.session.findFirst.mockResolvedValue({
        id: 's_1',
        agentId: 'a_sender',
        teamMemberId: 'tmm_sender',
      });

      await expect(
        service.resolveToolCallerWithContext(ctx, {}),
      ).resolves.toMatchObject({
        callerId: 'tmm_sender',
        taskId: 't_latest',
      });
    });

    it('(a2) 任务维缺失时回填绑定最近会话的 teamId', async () => {
      prisma.session.findFirst.mockResolvedValueOnce({
        taskId: null,
        teamId: 'tm_latest',
        teamMemberId: 'tmm_sender',
        agentId: 'a_sender',
      });
      prisma.session.findFirst.mockResolvedValue({
        id: 's_team',
        teamMemberId: 'tmm_sender',
      });

      await expect(
        service.resolveToolCallerWithContext(ctx, {}),
      ).resolves.toMatchObject({
        callerId: 'tmm_sender',
        teamId: 'tm_latest',
      });
    });

    it('(b) 无会话 → 403 PLATFORM_MCP_TOOL_NOT_PERMITTED', async () => {
      prisma.session.findFirst.mockResolvedValue(null);

      await expect(
        service.resolveToolCallerWithContext(ctx, {}),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'PLATFORM_MCP_TOOL_NOT_PERMITTED',
        }),
      });
    });
  });
});
