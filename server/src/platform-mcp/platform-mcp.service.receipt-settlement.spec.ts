import { Test, TestingModule } from '@nestjs/testing';
import { MESSAGE_STATUS } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { MessageReceiptsService } from '../chat/message-receipts.service';
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
import { TriggerService } from '../timers/trigger.service';

/**
 * 批次 A4 · MCP 侧的销账接线（.omo/plans/pm-coordination-hardening.md 批次 A4）。
 *
 * 这里用**真的** MessageReceiptsService（不是 mock），因此断言的是端到端效果：
 * 账本行被结掉（status=acked + settled_reason=…），且**账本一行都没多**
 * （me_0000000030：销账必须是减法；用 notify 去"清"账只会越清越多）。
 *
 * 覆盖四条接线：
 *   A4-1 群帖引用派发 messageId → 结账（负例：不引用 ⇒ 不结）；
 *   A4-1 产出物正文引用派发 messageId → 结账；
 *   A4-2 主 Agent 在群里应答 → 它收到的 question/help 回执行结账；
 *   A4-4 supersede 替换旧派发 → 旧派发的回执行结账（新派发另记一行，属派发本身）。
 */
describe('PlatformMcpService 回执结算接线（批次 A4）', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    chatChannel: { findFirst: jest.Mock; create: jest.Mock };
    message: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
    };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock; findMany: jest.Mock };
    teamMember: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    issue: { findUnique: jest.Mock; findMany: jest.Mock };
    messageReceipt: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    issueActivity: { count: jest.Mock; create: jest.Mock };
    artifactVersion: { findFirst: jest.Mock };
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
  };
  let artifactsService: { append: jest.Mock };
  let timers: { registerHandler: jest.Mock; schedule: jest.Mock };

  const taskId = 't_0000000001';
  const teamId = 'tm_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId: 'w_0000000001' };
  const mainMemberId = 'tmm_main';
  const subMemberId = 'tmm_dev';
  const dispatchMessageId = 'm_0000000100';

  /** 账本当前内容（用例自定；findMany 按 where 过滤，模拟真查询）。 */
  let receiptRows: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    receiptRows = [];
    prisma = {
      session: {
        findFirst: jest
          .fn()
          .mockImplementation((args: { where?: { teamMemberId?: string } }) =>
            Promise.resolve({
              id: 's_1',
              agentId: 'a_x',
              teamMemberId: args.where?.teamMemberId ?? mainMemberId,
            }),
          ),
        findUnique: jest.fn().mockResolvedValue({ status: 'running' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      chatChannel: {
        findFirst: jest.fn().mockResolvedValue({ id: channelId }),
        create: jest.fn(),
      },
      message: {
        create: jest.fn().mockResolvedValue({
          id: 'm_0000000900',
          channelId,
          status: MESSAGE_STATUS.sent,
          createdAt: new Date('2026-10-22T00:00:00Z'),
        }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      task: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ teamId, status: 'in_progress' }),
      },
      team: {
        findUnique: jest.fn().mockResolvedValue({
          mainAgentMemberId: mainMemberId,
          currentTaskId: null,
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      teamMember: {
        findFirst: jest.fn().mockResolvedValue({
          agentId: 'a_dev',
          alias: null,
          agent: { id: 'a_dev', name: '开发者' },
        }),
        findUnique: jest.fn().mockResolvedValue({ agentId: 'a_main' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      issue: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      messageReceipt: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
            Promise.resolve(data),
          ),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findMany: jest
          .fn()
          .mockImplementation((args: { where?: Record<string, unknown> }) => {
            const where = args.where ?? {};
            const inIds = where.messageId as { in?: string[] } | undefined;
            const inTargets = where.toInstanceId as
              { in?: string[] } | undefined;
            let rows = receiptRows;
            if (inIds?.in) {
              rows = rows.filter((r) =>
                inIds.in?.includes(r.messageId as string),
              );
            }
            if (inTargets?.in) {
              rows = rows.filter((r) =>
                inTargets.in?.includes(r.toInstanceId as string),
              );
            }
            if (typeof where.status === 'string') {
              rows = rows.filter((r) => r.status === where.status);
            }
            if (typeof where.teamId === 'string') {
              rows = rows.filter((r) => r.teamId === where.teamId);
            }
            return Promise.resolve(rows);
          }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      issueActivity: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
      },
      artifactVersion: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    idGen = { nextId: jest.fn().mockResolvedValue('m_0000000900') };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };
    artifactsService = {
      append: jest.fn().mockResolvedValue({
        status: 'created',
        artifact: { id: 'art_1', currentVersion: 1 },
      }),
    };
    timers = {
      registerHandler: jest.fn(),
      schedule: jest.fn().mockResolvedValue({ id: 'tmr_x' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        MessageReceiptsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
        { provide: WorkerClient, useValue: { fetchFile: jest.fn() } },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ArtifactsService, useValue: artifactsService },
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
        {
          provide: PlanLifecycleService,
          useValue: { autoEnsureRow: jest.fn() },
        },
        { provide: TriggerService, useValue: timers },
      ],
    }).compile();

    service = module.get(PlatformMcpService);
  });

  describe('A4-1 · 群帖引用派发 messageId 即销账', () => {
    it('群帖正文精确引用派发 messageId → 该回执行结账（settled_reason=quoted），账本一行不多', async () => {
      receiptRows = [
        {
          id: 'mr_1',
          messageId: dispatchMessageId,
          teamId,
          fromInstanceId: mainMemberId,
          toInstanceId: subMemberId,
          status: 'pending',
        },
      ];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        id: 'mr_1',
        messageId: dispatchMessageId,
        taskId: taskId,
        teamId,
        fromInstanceId: mainMemberId,
        toInstanceId: subMemberId,
        status: 'acked',
      });

      await service.groupPost(ctx, {
        taskId,
        selfInstanceId: subMemberId,
        content: `已按 ${dispatchMessageId} 的要求完成，验收通过`,
      });

      expect(prisma.messageReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr_1', status: 'pending' },
        data: expect.objectContaining({
          status: 'acked',
          settledReason: 'quoted',
        }),
      });
      // 账本只减不增：群帖路径**不得**新建回执行。
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('负例：群帖正文不引用派发 messageId → 不结账', async () => {
      receiptRows = [
        {
          id: 'mr_1',
          messageId: dispatchMessageId,
          teamId,
          fromInstanceId: mainMemberId,
          toInstanceId: subMemberId,
          status: 'pending',
        },
      ];

      await service.groupPost(ctx, {
        taskId,
        selfInstanceId: subMemberId,
        content: '我完成了，但没有引用任何派发消息',
      });

      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('负例：引用了**别的**消息 id → 不结账（精确匹配）', async () => {
      receiptRows = [
        {
          id: 'mr_1',
          messageId: dispatchMessageId,
          teamId,
          fromInstanceId: mainMemberId,
          toInstanceId: subMemberId,
          status: 'pending',
        },
      ];

      await service.groupPost(ctx, {
        taskId,
        selfInstanceId: subMemberId,
        content: '见 m_0000009999',
      });

      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('A4-1 · 产出物引用派发 messageId 即销账', () => {
    it('产出物正文引用派发 messageId → 结账（quoted）', async () => {
      receiptRows = [
        {
          id: 'mr_1',
          messageId: dispatchMessageId,
          teamId,
          fromInstanceId: mainMemberId,
          toInstanceId: subMemberId,
          status: 'pending',
        },
      ];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        id: 'mr_1',
        messageId: dispatchMessageId,
        taskId: taskId,
        teamId,
        fromInstanceId: mainMemberId,
        toInstanceId: subMemberId,
        status: 'acked',
      });

      await service.submitArtifact(ctx, {
        taskId,
        selfInstanceId: subMemberId,
        type: 'text',
        title: '实现说明',
        content: `对应派发 ${dispatchMessageId}，改动见下`,
      });

      expect(prisma.messageReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr_1', status: 'pending' },
        data: expect.objectContaining({ settledReason: 'quoted' }),
      });
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('负例：产出物正文不引用派发 messageId → 不结账', async () => {
      receiptRows = [
        {
          id: 'mr_1',
          messageId: dispatchMessageId,
          teamId,
          fromInstanceId: mainMemberId,
          toInstanceId: subMemberId,
          status: 'pending',
        },
      ];

      await service.submitArtifact(ctx, {
        taskId,
        selfInstanceId: subMemberId,
        type: 'text',
        title: '实现说明',
        content: '改动见下（没有引用任何派发消息）',
      });

      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });
  });

  describe('A4-2 · 主 Agent 应答后结 question/help 回执', () => {
    it('主 Agent 群帖应答 → 它收到的提问回执行结账（question-answered）', async () => {
      receiptRows = [
        {
          id: 'mr_q',
          messageId: 'm_0000000300',
          teamId,
          fromInstanceId: subMemberId,
          toInstanceId: mainMemberId,
          status: 'pending',
        },
      ];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        id: 'mr_q',
        messageId: 'm_0000000300',
        taskId: taskId,
        teamId,
        fromInstanceId: subMemberId,
        toInstanceId: mainMemberId,
        status: 'acked',
      });
      prisma.message.findUnique.mockResolvedValue({
        id: 'm_0000000300',
        channelId,
        createdAt: new Date('2026-10-21T09:00:00Z'),
      });

      await service.groupPost(ctx, {
        taskId,
        selfInstanceId: mainMemberId,
        content: '方案 A 批准，按方案 A 执行',
      });

      expect(prisma.messageReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr_q', status: 'pending' },
        data: expect.objectContaining({
          status: 'acked',
          settledReason: 'question-answered',
        }),
      });
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('负例：子 Agent 群帖（不是主 Agent）→ 不结主 Agent 的提问回执', async () => {
      receiptRows = [
        {
          id: 'mr_q',
          messageId: 'm_0000000300',
          teamId,
          fromInstanceId: subMemberId,
          toInstanceId: mainMemberId,
          status: 'pending',
        },
      ];
      prisma.message.findUnique.mockResolvedValue({
        id: 'm_0000000300',
        channelId,
        createdAt: new Date('2026-10-21T09:00:00Z'),
      });

      await service.groupPost(ctx, {
        taskId,
        selfInstanceId: subMemberId,
        content: '再问一次：什么时候能开工？',
      });

      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('A4-4 · supersede 替换的旧派发必须销账', () => {
    it('supersede 派发 → 旧派发的 pending 回执行结账（superseded）', async () => {
      // 账本里有一条旧派发的 pending 回执（supersede 的在途探针命中它）。
      prisma.messageReceipt.findFirst.mockResolvedValue({
        id: 'mr_old',
        messageId: dispatchMessageId,
        status: 'pending',
      });
      receiptRows = [
        {
          id: 'mr_old',
          messageId: dispatchMessageId,
          teamId,
          fromInstanceId: mainMemberId,
          toInstanceId: subMemberId,
          status: 'pending',
        },
      ];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        id: 'mr_old',
        messageId: dispatchMessageId,
        taskId: taskId,
        teamId,
        fromInstanceId: mainMemberId,
        toInstanceId: subMemberId,
        status: 'acked',
      });

      const result = await service.notifyAgent(ctx, {
        taskId,
        selfInstanceId: mainMemberId,
        targetInstanceId: subMemberId,
        content: '更正：改为先做接口再补测试',
        supersede: true,
      });

      expect(result.superseded).toBe(true);
      expect(result.origMessageId).toBe(dispatchMessageId);
      expect(prisma.messageReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr_old', status: 'pending' },
        data: expect.objectContaining({
          status: 'acked',
          settledReason: 'superseded',
        }),
      });
    });
  });
});
