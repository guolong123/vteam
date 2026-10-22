import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
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
import { buildPlatformMcpTools } from './platform-mcp.tools';

/**
 * 批次 A · 派发通道语义（.omo/plans/pm-coordination-hardening.md 批次 A）。
 *
 * - A1 可观测：返回值区分「消息落库」（triggered）与「目标真的开工」（claimed），
 *   并带目标会话状态 sessionStatus（me_0000000080：会话 failed 时派发不会被消费，
 *   调用方却只看到 triggered:true 而干等）。
 * - A2 一等更正语义：supersede=true 时同一 (发送方→目标) 的在途派发被**替换**
 *   （新消息引用原 messageId），不被内容去重吞掉（me_0000000238）。
 * - A3 通道死路可解：团队维度被 no-active-task 拦下时，团队有 currentTaskId 就
 *   自动改走任务维度重派（一次调用只落一条消息），没有则给真能走的 hint
 *   （me_0000000236：任务常已存在且 pending_review 不可回退 ⇒ 「去创建任务」是死路）。
 *
 * 反向断言同样在本文件内：supersede 不得绕过任何既有门禁（路由 403 / issue 锁 /
 * 节流），且不带 supersede 时去重行为一字不改。
 */
describe('PlatformMcpService notify_agent 派发通道语义（批次 A）', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
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
  const teamId = 'tm_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId: 'w_0000000001' };
  const mainMemberId = 'tmm_main';
  const subMemberId = 'tmm_sub';
  const targetName = '测试';
  const content = '请执行该需求';

  /** 任务维度默认入参（调用方 = 主 Agent，故路由门放行）。 */
  const baseArgs = {
    taskId,
    selfInstanceId: mainMemberId,
    targetInstanceId: subMemberId,
    content,
  };

  /** 团队维度默认入参（无 taskId）。 */
  const baseTeamArgs = {
    teamId,
    selfInstanceId: mainMemberId,
    targetInstanceId: subMemberId,
    content,
  };

  beforeEach(async () => {
    prisma = {
      session: {
        findFirst: jest.fn(),
        // A1：目标团队会话行（uk_sessions_team_member = teamId|memberId）。
        findUnique: jest.fn().mockResolvedValue({ status: 'running' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      chatChannel: { findFirst: jest.fn() },
      message: { create: jest.fn(), findMany: jest.fn() },
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: { findFirst: jest.fn(), findUnique: jest.fn() },
      issue: { findUnique: jest.fn(), findMany: jest.fn() },
      messageReceipt: { create: jest.fn(), findFirst: jest.fn() },
      issueActivity: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
      },
    };
    idGen = { nextId: jest.fn().mockResolvedValue('m_0000000900') };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };
    planLifecycle = {
      getStatus: jest.fn().mockResolvedValue('executing'),
      autoEnsureRow: jest.fn().mockResolvedValue(undefined),
    };

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

    // 归属校验：worker 在该团队/任务下有绑定会话，成员 = 主 Agent。
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: 'a_main',
      teamMemberId: mainMemberId,
    });
    prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
    prisma.teamMember.findFirst.mockResolvedValue({
      agentId: 'a_tester',
      alias: null,
      agent: { id: 'a_tester', name: targetName },
    });
    prisma.teamMember.findUnique.mockResolvedValue({ agentId: 'a_main' });
    // 团队：主成员 + 当前任务（currentTaskId 由用例覆盖）。
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: mainMemberId,
      currentTaskId: null,
    });
    prisma.task.findUnique.mockImplementation(
      (args: { where: { id?: string }; select?: { status?: boolean } }) => {
        if (args?.select?.status) {
          return Promise.resolve({ status: 'in_progress' });
        }
        return Promise.resolve({ teamId, status: 'in_progress' });
      },
    );
    prisma.message.create.mockResolvedValue({
      id: 'm_0000000900',
      channelId,
      status: MESSAGE_STATUS.sent,
      createdAt: new Date('2026-10-22T00:00:00Z'),
    });
    prisma.message.findMany.mockResolvedValue([]);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
    prisma.messageReceipt.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(data),
    );
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.issue.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  describe('A1 · 返回值可观测（triggered=落库 vs claimed=开工）', () => {
    it('目标会话 failed → triggered 仍为 true（消息落库）但 claimed=false + sessionStatus=failed（目标不会消费，别干等）', async () => {
      prisma.session.findUnique.mockResolvedValue({ status: 'failed' });

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.claimed).toBe(false);
      expect(result.sessionStatus).toBe('failed');
      // 消息照落、照广播、照派发——claimed 只是「目标会不会消费」的判据。
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    });

    it('目标会话 archived → claimed=false + sessionStatus=archived', async () => {
      prisma.session.findUnique.mockResolvedValue({ status: 'archived' });

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.claimed).toBe(false);
      expect(result.sessionStatus).toBe('archived');
    });

    it('目标会话健康（running）→ claimed=true + sessionStatus=running', async () => {
      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(true);
      expect(result.claimed).toBe(true);
      expect(result.sessionStatus).toBe('running');
    });

    it('目标**没有**会话行 → sessionStatus=null + claimed=false（首次派发，平台会在派发时建会话；不是投递失败）', async () => {
      prisma.session.findUnique.mockResolvedValue(null);

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(true);
      expect(result.sessionStatus).toBeNull();
      expect(result.claimed).toBe(false);
    });

    it('拦截路径（去重）也带 claimed=false + sessionStatus（调用方据此判断目标死活）', async () => {
      prisma.message.findMany.mockResolvedValue([
        { id: 'm_0000000100', content: { text: `@${targetName} ${content}` } },
      ]);

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.reason).toBe('dedup');
      expect(result.claimed).toBe(false);
      expect(result.sessionStatus).toBe('running');
    });
  });

  describe('A2 · 一等更正语义 supersede', () => {
    it('supersede=true + 同对在途派发 → 派发**替换**原派发（新消息引用原 messageId），不被去重吞掉', async () => {
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'pending',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        content: '更正：改为先做接口再补测试',
        supersede: true,
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.superseded).toBe(true);
      expect(result.origMessageId).toBe('m_0000000100');
      // 库里**新**增一条（被替换的那条不动），正文里带原派发 id。
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      const created = prisma.message.create.mock.calls[0][0].data;
      expect(created.content.text).toContain('m_0000000100');
      expect(created.content.text).toContain('更正此前派发');
      // 目标收到的正文也带更正标记（否则两条指令并存、目标照旧的干）。
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('m_0000000100'),
        }),
      );
    });

    it('supersede=true 且**正文完全相同**时同样不被去重吞掉（去重门只被 supersede 放行这一次）', async () => {
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'pending',
      });
      prisma.message.findMany.mockResolvedValue([
        { id: 'm_0000000100', content: { text: `@${targetName} ${content}` } },
      ]);

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        supersede: true,
      });

      expect(result.triggered).toBe(true);
      expect(result.superseded).toBe(true);
      expect(result.origMessageId).toBe('m_0000000100');
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
    });

    it('不带 supersede → 去重照旧生效（reason=dedup + 回既有 messageId，零新行）', async () => {
      prisma.message.findMany.mockResolvedValue([
        { id: 'm_0000000100', content: { text: `@${targetName} ${content}` } },
      ]);

      const result = await service.notifyAgent(ctx, baseArgs);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('dedup');
      expect(result.messageId).toBe('m_0000000100');
      expect(result.superseded).toBeUndefined();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('force + forceReason **也**败给去重（force 是门禁豁免，不是更正语义；me_0000000238 的死路正因如此）', async () => {
      prisma.message.findMany.mockResolvedValue([
        { id: 'm_0000000100', content: { text: `@${targetName} ${content}` } },
      ]);

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        force: true,
        forceReason: '线上故障需立即重发',
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('dedup');
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('supersede=true 但**没有**可替换的在途派发 → 退化为普通派发（去重照旧生效，不制造重复行）', async () => {
      prisma.messageReceipt.findFirst.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([
        { id: 'm_0000000100', content: { text: `@${targetName} ${content}` } },
      ]);

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        supersede: true,
      });

      expect(result.reason).toBe('dedup');
      expect(result.superseded).toBeUndefined();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('supersede **不**绕过非主→非主路由 403（更正语义不是门禁豁免）', async () => {
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_other_main',
        currentTaskId: null,
      });

      await expect(
        service.notifyAgent(ctx, {
          ...baseArgs,
          selfInstanceId: subMemberId,
          supersede: true,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('supersede **不**绕过 issue 锁（在途回执 + 同 assignee → 仍 reason=duplicate）', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: subMemberId,
      });
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'pending',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
        supersede: true,
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('duplicate');
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('A3 · 团队维度 no-active-task 死路可解', () => {
    it('团队有 currentTaskId（但不在进行中）→ 自动改走任务维度重派：triggered=true + channelSwitched=task + 只落一条消息', async () => {
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: mainMemberId,
        currentTaskId: taskId,
      });
      // 当前任务不在进行中 → 团队维度的定向派活门关闭。
      prisma.task.findUnique.mockImplementation(
        (args: { where: { id?: string }; select?: { status?: boolean } }) =>
          Promise.resolve(
            args?.select?.status
              ? { status: 'pending_review' }
              : { teamId, status: 'pending_review' },
          ),
      );

      const result = await service.notifyAgent(ctx, baseTeamArgs);

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result.channelSwitched).toBe('task');
      expect(result.channelSwitchReason).toBe('no-active-task');
      // **不双发**：改道发生在落库之前，库里只有一条消息、只广播一次。
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(realtime.broadcast).toHaveBeenCalledTimes(1);
      // 派发走任务维度（teamId 不再出现）。
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId,
          channelId,
          targetInstanceId: subMemberId,
        }),
      );
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalledWith(
        expect.objectContaining({ teamId: expect.anything() }),
      );
    });

    it('团队**没有** currentTaskId → 保持拦截，但 hint 可执行：点明任务维度(taskId)才是替代通道，不把调用方指去「建任务」死路', async () => {
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: mainMemberId,
        currentTaskId: null,
      });

      const result = await service.notifyAgent(ctx, baseTeamArgs);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('no-active-task');
      expect(result.channelSwitched).toBeUndefined();
      expect(result.hint).toContain('taskId');
      expect(result.hint).toContain('任务维度');
      expect(result.messageId).toBeNull();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('currentTaskId 存在但**不属于该团队** → 不换道（归属串了会把派发落到别的团队频道），保持拦截', async () => {
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: mainMemberId,
        currentTaskId: 't_0000009999',
      });
      prisma.task.findUnique.mockImplementation(
        (args: { where: { id?: string }; select?: { status?: boolean } }) =>
          Promise.resolve(
            args?.where?.id === 't_0000009999'
              ? { teamId: 'tm_other_team', status: 'pending_review' }
              : { teamId, status: 'pending_review' },
          ),
      );

      const result = await service.notifyAgent(ctx, baseTeamArgs);

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('no-active-task');
      expect(result.channelSwitched).toBeUndefined();
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('团队当前任务**进行中** → 团队维度原样放行（不改道、不加 channelSwitched）', async () => {
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: mainMemberId,
        currentTaskId: taskId,
      });

      const result = await service.notifyAgent(ctx, baseTeamArgs);

      expect(result.triggered).toBe(true);
      expect(result.channelSwitched).toBeUndefined();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ teamId, channelId }),
      );
    });
  });

  describe('force 的真实契约（布尔开关 + 顶层 forceReason）', () => {
    it('force=true + 非空 forceReason → 豁免生效（issue 锁被绕开，派发照发）', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: subMemberId,
      });
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'pending',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
        force: true,
        forceReason: '线上故障需立即执行',
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
    });

    it('force=true 但**缺** forceReason → 豁免不生效（门禁照拦）', async () => {
      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: subMemberId,
      });
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'pending',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
        force: true,
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('duplicate');
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('force 传对象 {reason} → schema 静默归一为 false（不报错），门禁照拦（别以为强制生效了）', async () => {
      const notifyTool = buildPlatformMcpTools(service).find(
        (t) => t.name === 'notify_agent',
      )!;
      const parsed = notifyTool.inputSchema.parse({
        ...baseArgs,
        force: { reason: '线上故障需立即执行' },
      }) as { force?: boolean };

      expect(parsed.force).toBe(false);

      prisma.issue.findUnique.mockResolvedValue({
        status: 'in_progress',
        assigneeInstanceId: subMemberId,
      });
      prisma.messageReceipt.findFirst.mockResolvedValue({
        messageId: 'm_0000000100',
        status: 'pending',
      });

      const result = await service.notifyAgent(ctx, {
        ...baseArgs,
        issueId: 'is_0000000001',
        force: parsed.force,
      });

      expect(result.triggered).toBe(false);
      expect(result.reason).toBe('duplicate');
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });
});
