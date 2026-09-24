import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
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
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
import { SkillsService } from '../skills/skills.service';
import { GitReposService } from '../git-repos/git-repos.service';
import { PlanLifecycleService } from '../tasks/plan-lifecycle.service';
import { MessageReceiptsService } from '../chat/message-receipts.service';

describe('PlatformMcpService reply-join fan-out JOIN', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { create: jest.Mock; findMany: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    teamMember: { findFirst: jest.Mock; findUnique: jest.Mock };
    issue: { findUnique: jest.Mock };
    messageReceipt: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
  };
  let idGen: { nextId: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
    isSessionPending: jest.Mock;
  };
  let receipts: MessageReceiptsService;
  let timers: { schedule: jest.Mock };
  let planLifecycle: { getStatus: jest.Mock; autoEnsureRow: jest.Mock };
  let loggerWarnSpy: jest.SpyInstance;

  const taskId = 't_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId: 'w_0000000001' };
  // REAL flow: a SUB reports to the MAIN. Caller (reporter) and team main
  // must be DIFFERENT ids, otherwise handleNotifyMatrix is skipped.
  const mainInstanceId = 'tmm_main';
  const sub1 = 'tmm_sub1';
  const sub2 = 'tmm_sub2';
  const teamId = 'tm_0000000001';

  const baseArgs = {
    taskId,
    targetInstanceId: mainInstanceId,
    content: '请执行该需求',
    selfInstanceId: sub1,
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
      messageReceipt: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
    };
    idGen = { nextId: jest.fn() };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
      isSessionPending: jest.fn().mockReturnValue(false),
    };
    timers = { schedule: jest.fn(async () => ({ id: 'tmr_1' })) };
    planLifecycle = { getStatus: jest.fn(), autoEnsureRow: jest.fn() };

    const receiptsSvc = {
      ackPendingFor: jest.fn().mockResolvedValue(1),
      countPendingFor: jest.fn().mockResolvedValue(0),
    };

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
        {
          provide: MessageReceiptsService,
          useValue: receiptsSvc,
        },
      ],
    }).compile();

    service = module.get(PlatformMcpService);
    receipts = module.get(MessageReceiptsService);
    loggerWarnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((() => undefined) as unknown as jest.Mock);

    prisma.task.findUnique.mockImplementation(
      (args: { where: { id?: string } }) => {
        if (args.where.id === taskId) return Promise.resolve({ teamId });
        return Promise.resolve(null);
      },
    );
    prisma.session.findFirst.mockImplementation(
      (args: { where?: { teamMemberId?: string } }) => {
        // Echo the requested member so assertWorkerTask归属 passes for any
        // reporter; the main's row stays idle here (busy-veto overrides below).
        const memberId = args?.where?.teamMemberId ?? sub1;
        const isMain = memberId === mainInstanceId;
        return Promise.resolve({
          id: isMain ? 's_main' : 's_sub',
          status: 'idle',
          workerId: 'w_0000000001',
          teamMemberId: memberId,
          agentId: isMain ? 'a_main' : 'a_sub',
        });
      },
    );
    prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
    prisma.teamMember.findFirst.mockImplementation(
      (args: { where: { id?: string } }) => {
        if (args.where.id === mainInstanceId)
          return Promise.resolve({
            agentId: 'a_main',
            alias: '主',
            agent: { id: 'a_main', name: '主' },
          });
        return Promise.resolve({
          agentId: 'a_sub',
          alias: '子',
          agent: { id: 'a_sub', name: '子' },
        });
      },
    );
    prisma.teamMember.findUnique.mockImplementation(
      (args: { where: { id?: string } }) =>
        Promise.resolve({
          agentId: args?.where?.id === mainInstanceId ? 'a_main' : 'a_sub',
        }),
    );
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: mainInstanceId,
    });
    idGen.nextId.mockImplementation(async (prefix: string) =>
      prefix === 'mr' ? 'mr_0000000001' : 'm_0000000200',
    );
    prisma.message.create.mockResolvedValue({
      id: 'm_0000000200',
      channelId,
      status: MESSAGE_STATUS.sent,
      senderType: SENDER_TYPE.agent,
      createdAt: new Date(),
    });
    prisma.message.findMany.mockResolvedValue([]);
    prisma.issue.findUnique.mockResolvedValue(null);
    prisma.messageReceipt.findFirst.mockResolvedValue(null);
    prisma.messageReceipt.findMany.mockResolvedValue([]);
    prisma.messageReceipt.count.mockResolvedValue(0);
    planLifecycle.getStatus.mockResolvedValue('executing');
    prisma.messageReceipt.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...data }),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    loggerWarnSpy.mockRestore();
  });

  it('answer+process：join 抑制（不派发执行 turn）+ 同样 ack + drain 检查；未收敛不唤醒', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    // 还有其它子未回：drain 检查后 pending>0 → 不唤醒
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(2);
    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'answer',
      stage: 'process',
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('join-pending');
    expect(result.messageId).toBe('m_0000000200');
    expect(result.hint).toContain('drain');
    // 进度汇报同样清账（旧逻辑仅 end 清账导致无 stage 汇报永不清账）
    expect(receipts.ackPendingFor).toHaveBeenCalledWith({
      fromInstanceId: mainInstanceId,
      toInstanceId: sub1,
      teamId,
    });
    // 抑制分支：本次调用自身不在主 Agent 上开执行 turn（kind 非 wake 的派发为零）
    const executionCalls =
      workerDispatcher.dispatchAgentMention.mock.calls.filter(
        (c: [{ kind: string }]) => c[0].kind !== 'wake',
      );
    expect(executionCalls.length).toBe(0);
    await jest.runOnlyPendingTimersAsync();
    const wakeCalls = workerDispatcher.dispatchAgentMention.mock.calls.filter(
      (c: [{ kind: string }]) => c[0].kind === 'wake',
    );
    expect(wakeCalls.length).toBe(0);
  });

  it('answer+end: join 抑制（不派发执行 turn）+ ackPendingFor + drain 检查，主 Agent 被唤醒一次', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(0);
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'answer',
      stage: 'end',
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('join-pending');
    expect(result.messageId).toBe('m_0000000200');
    // 报告自身的执行派发被抑制：drain 计时到期前 dispatch 零调用
    //（wakeMainAgent 已 mock，故任何 dispatch 调用都只能来自报告自身的派发）
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(receipts.ackPendingFor).toHaveBeenCalledWith({
      fromInstanceId: mainInstanceId,
      toInstanceId: sub1,
      teamId,
    });
    await jest.runOnlyPendingTimersAsync();
    await jest.advanceTimersByTimeAsync(250);
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('question: 正常执行派发 + 立即唤醒主 Agent，不计入 fan-out 计数', async () => {
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'question',
      content: '这个需求范围是否包含 X？',
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    // question 不被 join 抑制：报告自身开执行 turn（+3 loadings）…
    const executionCalls =
      workerDispatcher.dispatchAgentMention.mock.calls.filter(
        (c: [{ kind: string; targetInstanceId: string }]) =>
          c[0].kind !== 'wake' && c[0].targetInstanceId === mainInstanceId,
      );
    expect(executionCalls.length).toBe(1);
    // …叠加立即打断唤醒（interrupt，+3 loadings，合计 +6）
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(receipts.ackPendingFor).not.toHaveBeenCalled();
  });

  it('help: 正常执行派发 + 立即唤醒主 Agent，不计入 fan-out 计数', async () => {
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'help',
      content: '遇到构建错误需要协助',
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    const executionCalls =
      workerDispatcher.dispatchAgentMention.mock.calls.filter(
        (c: [{ kind: string; targetInstanceId: string }]) =>
          c[0].kind !== 'wake' && c[0].targetInstanceId === mainInstanceId,
      );
    expect(executionCalls.length).toBe(1);
    expect(wakeSpy).toHaveBeenCalledTimes(1);
    expect(receipts.ackPendingFor).not.toHaveBeenCalled();
  });

  it('adversarial: 显式 kind=execution 的 answer/end 报告仍被抑制（抑制键为 type+target，与 kind 无关）', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(0);
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'answer',
      stage: 'end',
      kind: 'execution',
    });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('join-pending');
    // kind=execution 照常记账（回执行仍创建），但执行派发被抑制
    expect(prisma.messageReceipt.create).toHaveBeenCalled();
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    await jest.runAllTimersAsync();
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('并发 ack → 主 Agent 只被唤醒一次（debounce + atomic claim）', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(0);
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const r1 = await service.notifyAgent(ctx, {
      ...baseArgs,
      selfInstanceId: sub1,
      targetInstanceId: mainInstanceId,
      type: 'answer',
      stage: 'end',
    });
    const r2 = await service.notifyAgent(ctx, {
      ...baseArgs,
      selfInstanceId: sub2,
      targetInstanceId: mainInstanceId,
      type: 'answer',
      stage: 'end',
    });
    expect(r1.triggered).toBe(false);
    expect(r1.reason).toBe('join-pending');
    expect(r2.triggered).toBe(false);
    expect(r2.reason).toBe('join-pending');
    // 两条报告自身的执行派发均被抑制：drain 前 dispatch 零调用
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();

    await jest.runAllTimersAsync();
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('double-ack 幂等：第二次 ackPendingFor 不重复唤醒', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(0);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(0);
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const r1 = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'answer',
      stage: 'end',
    });
    const r2 = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'answer',
      stage: 'end',
    });
    expect(r1.reason).toBe('join-pending');
    expect(r2.reason).toBe('join-pending');

    await jest.runAllTimersAsync();
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('busy-veto：主会话 running → 不唤醒', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(0);
    prisma.session.findFirst.mockImplementation(
      (args: { where?: { teamMemberId?: string } }) => {
        const memberId = args?.where?.teamMemberId ?? sub1;
        if (memberId === mainInstanceId)
          return Promise.resolve({
            id: 's_main',
            status: 'running',
            workerId: 'w_0000000001',
            teamMemberId: mainInstanceId,
            agentId: 'a_main',
          });
        return Promise.resolve({
          id: 's_sub',
          status: 'idle',
          workerId: 'w_0000000001',
          teamMemberId: memberId,
          agentId: 'a_sub',
        });
      },
    );
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const busyResult = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'answer',
      stage: 'end',
    });
    expect(busyResult.triggered).toBe(false);
    expect(busyResult.reason).toBe('join-pending');

    await jest.runAllTimersAsync();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('pending>0 → 不唤醒主 Agent（drain 条件未满足）', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(1);
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const pendingResult = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'answer',
      stage: 'end',
    });
    expect(pendingResult.triggered).toBe(false);
    expect(pendingResult.reason).toBe('join-pending');

    await jest.runAllTimersAsync();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('regression: sub1 answer/end pending=1 → join 抑制 + 不唤醒主 Agent', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(1);
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      selfInstanceId: sub1,
      targetInstanceId: mainInstanceId,
      type: 'answer',
      stage: 'end',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('join-pending');
    await jest.runAllTimersAsync();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('regression: sub2 answer/end pending=0 → join 抑制 + 唤醒主 Agent 恰好一次', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(0);
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      selfInstanceId: sub2,
      targetInstanceId: mainInstanceId,
      type: 'answer',
      stage: 'end',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('join-pending');
    await jest.runAllTimersAsync();
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('regression: ack 方向固定 MAIN→reporter（from=主，to=上报子）', async () => {
    jest.useFakeTimers();
    jest.spyOn(receipts, 'ackPendingFor').mockResolvedValue(1);
    jest.spyOn(receipts, 'countPendingFor').mockResolvedValue(0);
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    await service.notifyAgent(ctx, {
      ...baseArgs,
      selfInstanceId: sub2,
      targetInstanceId: mainInstanceId,
      type: 'answer',
      stage: 'end',
    });

    expect(receipts.ackPendingFor).toHaveBeenCalledWith({
      fromInstanceId: mainInstanceId,
      toInstanceId: sub2,
      teamId,
    });
    await jest.runAllTimersAsync();
    expect(wakeSpy).toHaveBeenCalledTimes(1);
  });

  it('regression: MAIN 自己上报 answer/end → 跳过矩阵（无 ack、无唤醒），但主→子派发照常', async () => {
    jest.useFakeTimers();
    const ackSpy = jest.spyOn(receipts, 'ackPendingFor');
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      selfInstanceId: mainInstanceId,
      targetInstanceId: sub1,
      type: 'answer',
      stage: 'end',
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    // 主→子 fan-out 派发不受抑制：执行 turn 照开（join 计数就靠它）
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync();
    expect(ackSpy).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('主 agent 门禁：团队无进行中任务时主→子定向派活被拦（reason=no-active-task，未发布）', async () => {
    // 团队无当前任务 → 关门（team.findUnique 缺 currentTaskId 即关）
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: mainInstanceId,
    });
    const result = await service.notifyAgent(ctx, {
      teamId,
      selfInstanceId: mainInstanceId,
      targetInstanceId: sub1,
      content: '开工干活',
      type: 'answer',
    });

    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('no-active-task');
    expect(result.messageId).toBeNull();
    expect(result.hint).toContain('vteam_task_create');
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
  });

  it('主 agent 门禁：子→主向上汇报永远放行（开门前也可回话）', async () => {
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: mainInstanceId,
    });
    const result = await service.notifyAgent(ctx, {
      teamId,
      selfInstanceId: sub1,
      targetInstanceId: mainInstanceId,
      content: '收到，明白',
      type: 'answer',
    });

    expect(result.reason).not.toBe('no-active-task');
  });

  it('主 agent 门禁：当前任务进行中 → 开门，主→子照常派发', async () => {
    prisma.team.findUnique.mockResolvedValue({
      mainAgentMemberId: mainInstanceId,
      currentTaskId: 't_9',
    });
    prisma.task.findUnique.mockResolvedValue({ status: 'in_progress' });
    const result = await service.notifyAgent(ctx, {
      teamId,
      selfInstanceId: mainInstanceId,
      targetInstanceId: sub1,
      content: '开工干活',
      type: 'answer',
    });

    expect(result.reason).not.toBe('no-active-task');
  });

  it('fail-open: 团队无主成员 → join 抑制不生效，按普通派发并告警', async () => {
    prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
    const wakeSpy = jest
      .spyOn(
        service as unknown as { wakeMainAgent: jest.Mock },
        'wakeMainAgent',
      )
      .mockResolvedValue(undefined);

    const result = await service.notifyAgent(ctx, {
      ...baseArgs,
      type: 'answer',
      stage: 'end',
    });

    expect(result.triggered).toBe(true);
    expect(result.reason).toBe('ok');
    expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).toHaveBeenCalled();
    expect(receipts.ackPendingFor).not.toHaveBeenCalled();
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it('todo 10: 非主→非主 reply 上报不绕过路由门 → 403 PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION（零 join 记账）', async () => {
    const err = await service
      .notifyAgent(ctx, {
        ...baseArgs,
        targetInstanceId: sub2,
        type: 'answer',
        stage: 'end',
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: PLATFORM_MCP_ERRORS.NOTIFY_ROUTING_VIOLATION,
    });
    expect(receipts.ackPendingFor).not.toHaveBeenCalled();
    expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});
