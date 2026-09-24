import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { ArtifactsService } from '../artifacts/artifacts.service';
import {
  WorkerClient,
  WorkerUnavailableException,
} from '../workers/worker.client';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';
import { SKILL_ERRORS } from '../common/constants/skill.constants';
import { TASK_ERRORS } from '../common/constants/task.constants';
import { SkillsService } from '../skills/skills.service';
import { GitReposService } from '../git-repos/git-repos.service';
import { PlatformMcpService } from './platform-mcp.service';
import {
  buildPlatformMcpTools,
  memorySaveSchema,
  memoryUpdateSchema,
} from './platform-mcp.tools';
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { QUESTION_CONFIRM_INTEGRITY_ERRORS } from '../questions/questions.constants';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
import { MessageReceiptsService } from '../chat/message-receipts.service';
import { HookService } from '../triggers/hook.service';

describe('PlatformMcpService', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock; findMany: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { findMany: jest.Mock; create: jest.Mock; count: jest.Mock };
    artifact: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    artifactVersion: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
    };
    task: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
    team: { findUnique: jest.Mock };
    teamMember: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    teamUserMember: { findMany: jest.Mock };
    projectMember: { findMany: jest.Mock };
    project: { findMany: jest.Mock };
    worker: { findUnique: jest.Mock };
    memory: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    agent: { findUnique: jest.Mock };
    agentQuestion: { findMany: jest.Mock };
    plan: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
    };
    planTask: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    hook: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workerClient: { fetchFile: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
  };
  let artifactsService: { append: jest.Mock; archiveFile: jest.Mock };
  let issuesService: {
    createByAgent: jest.Mock;
    findAllByAgent: jest.Mock;
    findOneByAgent: jest.Mock;
    updateByAgent: jest.Mock;
    transitionByAgent: jest.Mock;
  };
  let tasksService: {
    transitionByAgent: jest.Mock;
    updateTeam: jest.Mock;
    createByAgent: jest.Mock;
  };
  let questionsService: {
    confirmByAgent: jest.Mock;
    createForPlatform: jest.Mock;
  };
  let skillsService: { create: jest.Mock };
  let gitReposService: { findAll: jest.Mock };
  let plansService: { assignReviewer: jest.Mock };
  let outboundDispatcher: { sendToChannelByIdOrName: jest.Mock };
  let executionPolicyService: {
    resolveByRole: jest.Mock;
    resolveByAgent: jest.Mock;
  };
  let receiptsService: { countPending: jest.Mock };
  let hookService: { cancelHook: jest.Mock; registerHook: jest.Mock };
  const allowPolicy = () => {
    executionPolicyService.resolveByRole.mockResolvedValue({
      policyId: 'ep_developer',
      policyName: '开发者策略',
      agentName: 'vteam-developer',
      permission: { edit: 'allow', bash: 'ask' },
      correction: { scopeSummary: '开发者边界' },
    });
  };

  const taskId = 't_0000000001';
  const workerId = 'w_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId };
  /** 调用方 Agent（senderId 落库目标；session.agentId 对齐）。 */
  const senderAgentId = 'a_sender';
  /** 调用方成员 id（tmm_ 前缀；session.teamMemberId 对齐，senderInstanceId 落库目标）。 */
  const senderInstanceId = 'tmm_sender';

  /** 归属校验通过：该 worker 有任务归属团队的团队会话（绑定成员 tmm_sender + agentId=a_sender）。 */
  const allowWorker = () => {
    prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: senderAgentId,
      teamMemberId: senderInstanceId,
    });
  };

  /** 归属校验通过（指定成员）：session.teamMemberId 绑定指定成员 id（多成员/跨成员权限用例）。 */
  const allowWorkerAs = (instanceId: string) => {
    prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: senderAgentId,
      teamMemberId: instanceId,
    });
  };

  /** 归属校验失败：无 Session（防跨任务；任务归属团队先行，拒绝落在会话检查）。 */
  const denyWorker = () => {
    prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
    prisma.session.findFirst.mockResolvedValue(null);
  };

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn(), findMany: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
      artifact: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      artifactVersion: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      task: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      teamUserMember: { findMany: jest.fn() },
      projectMember: { findMany: jest.fn() },
      project: { findMany: jest.fn() },
      worker: { findUnique: jest.fn() },
      memory: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      agent: { findUnique: jest.fn() },
      agentQuestion: { findMany: jest.fn() },
      plan: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      planTask: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      hook: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    // FR-41：$transaction 直接透传回调（tx 复用 prisma mock），事务内查询可断言
    prisma.$transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma),
    );
    idGen = { nextId: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workerClient = { fetchFile: jest.fn() };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      // 默认无注册记录 → 回退 findFirst 原校验路径（单测隔离，不依赖 dispatch 时序）
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };
    artifactsService = { append: jest.fn(), archiveFile: jest.fn() };
    issuesService = {
      createByAgent: jest.fn(),
      findAllByAgent: jest.fn(),
      findOneByAgent: jest.fn(),
      updateByAgent: jest.fn(),
      transitionByAgent: jest.fn(),
    };
    tasksService = {
      transitionByAgent: jest.fn(),
      updateTeam: jest.fn(),
      createByAgent: jest.fn(),
    };
    questionsService = {
      confirmByAgent: jest.fn(),
      createForPlatform: jest.fn(),
    };
    skillsService = { create: jest.fn() };
    gitReposService = { findAll: jest.fn().mockResolvedValue([]) };
    plansService = { assignReviewer: jest.fn() };
    outboundDispatcher = {
      sendToChannelByIdOrName: jest.fn().mockResolvedValue(undefined),
    };
    executionPolicyService = {
      resolveByRole: jest.fn(),
      // slice 3 突变检测：resolveByAgent 保留为 spy（my_profile 不得再读执行 Agent 策略）。
      resolveByAgent: jest.fn(),
    };
    receiptsService = {
      countPending: jest.fn().mockResolvedValue({ pending: 0, total: 0 }),
    };
    hookService = {
      cancelHook: jest.fn(),
      registerHook: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
        { provide: WorkerClient, useValue: workerClient },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ArtifactsService, useValue: artifactsService },
        { provide: IssuesService, useValue: issuesService },
        { provide: TasksService, useValue: tasksService },
        { provide: QuestionsService, useValue: questionsService },
        {
          provide: NotificationDispatcherService,
          useValue: outboundDispatcher,
        },
        { provide: ExecutionPolicyService, useValue: executionPolicyService },
        { provide: SkillsService, useValue: skillsService },
        { provide: GitReposService, useValue: gitReposService },
        { provide: MessageReceiptsService, useValue: receiptsService },
        { provide: HookService, useValue: hookService },
      ],
    }).compile();

    service = module.get(PlatformMcpService);
  });

  /** 断言目标方法抛出带指定错误码的 ForbiddenException/NotFoundException。 */
  const expectCode = (
    promise: Promise<unknown>,
    ctor:
      | typeof ForbiddenException
      | typeof NotFoundException
      | typeof BadRequestException,
    code: string,
  ) =>
    promise.then(
      () => {
        throw new Error('应当抛出异常');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ctor);
        expect((err as { getResponse(): unknown }).getResponse()).toMatchObject(
          {
            code,
          },
        );
      },
    );

  describe('归属校验（每个工具 tools/call 前置）', () => {
    it('缺 workerId → 403 PLATFORM_MCP_MISSING_WORKER_ID', async () => {
      await expectCode(
        service.chatHistory({ workerId: '' }, { taskId }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.MISSING_WORKER_ID,
      );
    });

    it('worker 无该任务 Session → 403 PLATFORM_MCP_FORBIDDEN（防跨任务）', async () => {
      denyWorker();
      await expectCode(
        service.chatHistory(ctx, { taskId }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', workerId },
        }),
      );
    });

    it('四个工具共用同一归属校验', async () => {
      denyWorker();
      await expectCode(
        service.doclib(ctx, { taskId }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      await expectCode(
        service.taskContext(ctx, { taskId }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      await expectCode(
        service.groupPost(ctx, {
          taskId,
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
    });

    it('落库类工具 selfInstanceId 与 session.teamMemberId 不一致 → 403 PLATFORM_MCP_FORBIDDEN（防冒充）', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
      prisma.session.findFirst.mockResolvedValue({
        id: 's_1',
        agentId: 'a_other',
        teamMemberId: 'tmm_other',
      });
      await expectCode(
        service.groupPost(ctx, {
          taskId,
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      await expectCode(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      await expectCode(
        service.submitArtifact(ctx, {
          taskId,
          type: 'text',
          title: 'x',
          content: 'c',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(artifactsService.append).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('多实例任务：selfInstanceId 精确匹配自身会话（where 含 OR），合法成员放行到工具逻辑', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue({
        id: 'm_0000000100',
        channelId,
        senderType: SENDER_TYPE.agent,
        senderId: senderAgentId,
        content: { text: 'x', parts: [] },
        mentions: null,
        attachmentUrl: null,
        attachmentName: null,
        attachmentType: null,
        status: MESSAGE_STATUS.sent,
        createdAt: new Date('2026-08-07T00:00:00Z'),
      });
      prisma.teamMember.findUnique.mockResolvedValue({
        agentId: senderAgentId,
      } as any);

      await service.groupPost(ctx, {
        taskId,
        content: 'x',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', workerId, teamMemberId: senderInstanceId },
        }),
      );
      expect(prisma.message.create).toHaveBeenCalled();
    });
  });

  describe('chat_history', () => {
    it('返回群聊历史消息（text 从 content Json 提取，默认取最近 20 条倒序取正序回）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm_0000000002',
          senderType: SENDER_TYPE.agent,
          senderId: null,
          content: { text: '收到', parts: [] },
          createdAt: new Date('2026-08-07T00:00:01Z'),
        },
        {
          id: 'm_0000000001',
          senderType: SENDER_TYPE.user,
          senderId: 'u_1',
          content: { text: '你好', parts: [] },
          createdAt: new Date('2026-08-07T00:00:00Z'),
        },
      ]);
      prisma.message.count.mockResolvedValue(2);

      const result = await service.chatHistory(ctx, { taskId });

      expect(result).toEqual({
        items: [
          {
            id: 'm_0000000001',
            senderType: 'user',
            senderId: 'u_1',
            text: '你好',
            attachmentUrl: null,
            attachmentName: null,
            attachmentType: null,
            senderInstanceId: null,
            createdAt: '2026-08-07T00:00:00.000Z',
          },
          {
            id: 'm_0000000002',
            senderType: 'agent',
            senderId: null,
            text: '收到',
            attachmentUrl: null,
            attachmentName: null,
            attachmentType: null,
            senderInstanceId: null,
            createdAt: '2026-08-07T00:00:01.000Z',
          },
        ],
        truncated: false,
        total: 2,
      });
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: {
          teamId: 'tm_1',
          type: CHANNEL_TYPE.team_group,
          deletedAt: null,
        },
        select: { id: true },
      });
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId },
        orderBy: { id: 'desc' },
        take: 21,
      });
      expect(prisma.message.count).toHaveBeenCalledWith({
        where: { channelId },
      });
    });

    it('含附件消息返回附件字段（attachmentUrl/attachmentName/attachmentType + senderInstanceId，无附件为 null）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm_0000000021',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_1',
          senderInstanceId: 'tmm_1',
          content: { text: '已读取', parts: [] },
          attachmentUrl: null,
          attachmentName: null,
          attachmentType: null,
          createdAt: new Date('2026-08-07T00:00:03Z'),
        },
        {
          id: 'm_0000000020',
          senderType: SENDER_TYPE.user,
          senderId: 'u_1',
          senderInstanceId: null,
          content: { text: '见附件', parts: [] },
          attachmentUrl: '/uploads/uuid-1.png',
          attachmentName: '截图.png',
          attachmentType: 'png',
          createdAt: new Date('2026-08-07T00:00:02Z'),
        },
      ]);

      const result = await service.chatHistory(ctx, { taskId });

      expect(result.items[0]).toEqual({
        id: 'm_0000000020',
        senderType: 'user',
        senderId: 'u_1',
        text: '见附件',
        attachmentUrl: '/uploads/uuid-1.png',
        attachmentName: '截图.png',
        attachmentType: 'png',
        senderInstanceId: null,
        createdAt: '2026-08-07T00:00:02.000Z',
      });
      expect(result.items[1].senderInstanceId).toBe('tmm_1');
    });

    it('sinceId 游标过滤 + limit 分页透传（正序续拉，多取 1 条探底）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      await service.chatHistory(ctx, {
        taskId,
        sinceId: 'm_0000000010',
        limit: 20,
      });

      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId, id: { gt: 'm_0000000010' } },
        orderBy: { id: 'asc' },
        take: 21,
      });
    });

    it('limit 越界收敛（>100 → 100，<=0 → 1，非法 → 20）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      await service.chatHistory(ctx, { taskId, limit: 999 });
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 101 }),
      );
      await service.chatHistory(ctx, { taskId, limit: 0 });
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 2 }),
      );
      await service.chatHistory(ctx, { taskId, limit: Number.NaN });
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 21 }),
      );
    });

    it('任务无群聊频道 → 404 PLATFORM_MCP_CHANNEL_NOT_FOUND', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      await expectCode(
        service.chatHistory(ctx, { taskId }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
      );
    });
  });

  describe('chat_history 分页契约（plan-review todo 10：默认 20/截断标记/64KB 红线）', () => {
    /** 分页页形态（实现前 service 仍返回数组，此处经 unknown 收窄以便 failing-first 不编译红）。 */
    type ChatPage = {
      items: { id: string; text: string }[];
      truncated: boolean;
      total: number;
    };
    const asPage = (v: unknown) => v as unknown as ChatPage;
    const pageArgs = (a: object) =>
      a as unknown as Parameters<typeof service.chatHistory>[1];
    const histRow = (n: number, text = `消息${n}`) => ({
      id: `m_${String(n).padStart(10, '0')}`,
      senderType: SENDER_TYPE.user,
      senderId: 'u_1',
      senderInstanceId: null,
      content: { text, parts: [] },
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      createdAt: new Date('2026-08-07T00:00:00Z'),
    });

    it('无 limit 调用返回 {items, truncated, total} 且默认取最近 20 条', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => histRow(i + 1)),
      );
      prisma.message.count.mockResolvedValue(20);

      const result = asPage(await service.chatHistory(ctx, { taskId }));

      expect(result.total).toBe(20);
      expect(result.truncated).toBe(false);
      expect(result.items).toHaveLength(20);
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId },
        orderBy: { id: 'desc' },
        take: 21,
      });
      expect(prisma.message.count).toHaveBeenCalledWith({
        where: { channelId },
      });
    });

    it('超量时 truncated=true 且 items 截断到 limit（多取 1 条探底，不多查一次）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue(
        Array.from({ length: 21 }, (_, i) => histRow(i + 1)),
      );
      prisma.message.count.mockResolvedValue(25);

      const result = asPage(await service.chatHistory(ctx, { taskId }));

      expect(result.truncated).toBe(true);
      expect(result.total).toBe(25);
      expect(result.items).toHaveLength(20);
    });

    it('beforeId 倒序翻页：仅取 id 小于游标的消息，第二页拿到余量', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => histRow(i + 1)),
      );
      prisma.message.count.mockResolvedValue(25);

      const result = asPage(
        await service.chatHistory(
          ctx,
          pageArgs({ taskId, beforeId: 'm_0000000021' }),
        ),
      );

      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId, id: { lt: 'm_0000000021' } },
        orderBy: { id: 'desc' },
        take: 21,
      });
      expect(result.items).toHaveLength(5);
      expect(result.truncated).toBe(false);
      expect(result.total).toBe(25);
    });

    it('响应硬上限 64KB：单条超长消息截断文本并打标记，不做 LLM 摘要', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([
        histRow(1, 'x'.repeat(70 * 1024)),
      ]);
      prisma.message.count.mockResolvedValue(1);

      const result = asPage(await service.chatHistory(ctx, { taskId }));

      const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
      expect(size).toBeLessThanOrEqual(64 * 1024);
      expect(result.truncated).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].text).toContain('[truncated]');
      expect(result.items[0].text).not.toContain('摘要');
    });
  });

  describe('chat_history DM 模式（T6 D6：同团队 + 端点 + 审计）', () => {
    const dmChannel = {
      id: 'c_dm00000001',
      type: CHANNEL_TYPE.private,
      teamId: 'tm_1',
      teamMemberId: senderInstanceId,
    };
    const dmRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'm_0000000091',
      senderType: SENDER_TYPE.user,
      senderId: 'u_1',
      senderInstanceId: null,
      content: { text: '私聊你好', parts: [] },
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      createdAt: new Date('2026-08-07T00:00:00Z'),
      ...overrides,
    });

    it('happy path：调用方为 DM 端点 + 同团队 → 返回私聊历史并写审计', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue(dmChannel);
      prisma.message.findMany.mockResolvedValue([dmRow()]);
      prisma.message.count.mockResolvedValue(1);
      const logSpy = jest
        .spyOn(
          (
            service as unknown as {
              logger: { log: (...args: unknown[]) => void };
            }
          ).logger,
          'log',
        )
        .mockImplementation(() => undefined);

      const result = await service.chatHistory(ctx, {
        taskId,
        teamMemberId: senderInstanceId,
        selfInstanceId: senderInstanceId,
      });

      expect(result).toEqual({
        items: [
          {
            id: 'm_0000000091',
            senderType: 'user',
            senderId: 'u_1',
            text: '私聊你好',
            attachmentUrl: null,
            attachmentName: null,
            attachmentType: null,
            senderInstanceId: null,
            createdAt: '2026-08-07T00:00:00.000Z',
          },
        ],
        truncated: false,
        total: 1,
      });
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId: dmChannel.id },
        orderBy: { id: 'desc' },
        take: 21,
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[mcp] chat_history DM 访问'),
      );
      logSpy.mockRestore();
    });

    it('跨团队 DM → 403 PLATFORM_MCP_FORBIDDEN（频道归属他团队）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({
        ...dmChannel,
        teamId: 'tm_other',
      });
      await expectCode(
        service.chatHistory(ctx, {
          taskId,
          teamMemberId: senderInstanceId,
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('非端点调用方 → 403（caller 不是该 DM 的 teamMemberId）', async () => {
      allowWorkerAs('tmm_other');
      prisma.chatChannel.findFirst.mockResolvedValue(dmChannel);
      await expectCode(
        service.chatHistory(ctx, {
          taskId,
          teamMemberId: senderInstanceId,
          selfInstanceId: 'tmm_other',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('DM 模式缺 selfInstanceId → 403（禁止匿名/工作器级回退访问）', async () => {
      allowWorker();
      await expectCode(
        service.chatHistory(ctx, { taskId, teamMemberId: senderInstanceId }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('DM 模式冒充他实例 selfInstanceId → 403（实例级绑定拒绝）', async () => {
      allowWorkerAs('tmm_other');
      prisma.chatChannel.findFirst.mockResolvedValue(dmChannel);
      await expectCode(
        service.chatHistory(ctx, {
          taskId,
          teamMemberId: senderInstanceId,
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.message.findMany).not.toHaveBeenCalled();
    });

    it('DM 频道不存在 → 404 PLATFORM_MCP_CHANNEL_NOT_FOUND', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      await expectCode(
        service.chatHistory(ctx, {
          taskId,
          teamMemberId: senderInstanceId,
          selfInstanceId: senderInstanceId,
        }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
      );
    });

    it('团队维度 DM：teamId + 端点一致 → 可读', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: senderInstanceId,
      });
      prisma.chatChannel.findFirst.mockResolvedValue(dmChannel);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);
      const result = await service.chatHistory(ctx, {
        teamId: 'tm_1',
        teamMemberId: senderInstanceId,
        selfInstanceId: senderInstanceId,
      });
      expect(result).toEqual({ items: [], truncated: false, total: 0 });
    });
  });

  describe('git_repos_list（T6 P6：授权过滤 + 脱敏）', () => {
    const viewRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'gro_0000000001',
      repoUrl: 'git@gitee.com:xishuhq/test-repo',
      credentialId: 'gc_0000000001',
      credentialName: 'gitee-main',
      authType: 'ssh_key',
      fingerprint: 'ssh-rsa AAAA****',
      revokedAt: null,
      createdAt: new Date('2026-08-08T00:00:00Z'),
      grantedAgents: [
        {
          agentId: senderAgentId,
          name: '发送者',
          permission: 'read',
          effect: 'allow',
        },
      ],
      ...overrides,
    });

    it('happy path：仅返回调用方模板 Agent 持有授权的行（脱敏，无 key）', async () => {
      allowWorkerAs(senderInstanceId);
      prisma.teamMember.findUnique.mockResolvedValue({
        agentId: senderAgentId,
      });
      gitReposService.findAll.mockResolvedValue([
        viewRow(),
        viewRow({
          id: 'gro_0000000002',
          repoUrl: 'git@gitee.com:xishuhq/other-repo',
          grantedAgents: [
            {
              agentId: 'a_other',
              name: '他人',
              permission: 'read',
              effect: 'allow',
            },
          ],
        }),
      ]);

      const result = await service.gitReposList(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
      });

      expect(result).toEqual({
        repos: [
          {
            id: 'gro_0000000001',
            repoUrl: 'git@gitee.com:xishuhq/test-repo',
            credentialName: 'gitee-main',
            authType: 'ssh_key',
            fingerprint: 'ssh-rsa AAAA****',
            permission: 'read',
            effect: 'allow',
          },
        ],
      });
      const text = JSON.stringify(result);
      expect(text).not.toContain('credentialRef');
      expect(text).not.toContain('credentialId');
    });

    it('无授权 → 空清单（不泄漏他人仓库）', async () => {
      allowWorkerAs(senderInstanceId);
      prisma.teamMember.findUnique.mockResolvedValue({
        agentId: senderAgentId,
      });
      gitReposService.findAll.mockResolvedValue([
        viewRow({
          grantedAgents: [
            {
              agentId: 'a_other',
              name: '他人',
              permission: 'read',
              effect: 'allow',
            },
          ],
        }),
      ]);
      const result = await service.gitReposList(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
      });
      expect(result).toEqual({ repos: [] });
    });

    it('归属 403：冒充他实例 selfInstanceId → 拒绝', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
      prisma.session.findFirst.mockResolvedValue({
        id: 's_1',
        agentId: senderAgentId,
        teamMemberId: 'tmm_other',
      });
      await expectCode(
        service.gitReposList(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(gitReposService.findAll).not.toHaveBeenCalled();
    });

    it('成员行缺失时回退 callerId 本身作 agentId（兼容 session.agentId 形态）', async () => {
      allowWorkerAs(senderInstanceId);
      prisma.teamMember.findUnique.mockResolvedValue(null);
      gitReposService.findAll.mockResolvedValue([
        viewRow({
          grantedAgents: [
            {
              agentId: senderInstanceId,
              name: '直挂',
              permission: 'read',
              effect: 'allow',
            },
          ],
        }),
      ]);
      const result = await service.gitReposList(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
      });
      expect(result.repos).toHaveLength(1);
    });
  });

  describe('doclib', () => {
    it('无 artifactId → 产出物清单（id/type/title/category/currentVersion/updatedAt）', async () => {
      allowWorker();
      prisma.artifact.findMany.mockResolvedValue([
        {
          id: 'a_1',
          type: 'doc',
          title: '需求文档',
          category: '需求',
          currentVersion: 2,
          updatedAt: new Date('2026-08-07T00:00:00Z'),
        },
      ]);

      const result = await service.doclib(ctx, { taskId });

      expect(prisma.artifact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { taskId } }),
      );
      expect(result).toEqual({
        artifacts: [
          {
            id: 'a_1',
            type: 'doc',
            title: '需求文档',
            category: '需求',
            currentVersion: 2,
            updatedAt: '2026-08-07T00:00:00.000Z',
          },
        ],
      });
    });

    it('清单：未设 category 的行透出 null（未分类，后向兼容）', async () => {
      allowWorker();
      prisma.artifact.findMany.mockResolvedValue([
        {
          id: 'a_2',
          type: 'text',
          title: '旧产出物',
          category: null,
          currentVersion: 1,
          updatedAt: new Date('2026-08-07T00:00:00Z'),
        },
      ]);

      const result = await service.doclib(ctx, { taskId });

      expect(result).toEqual({
        artifacts: [
          {
            id: 'a_2',
            type: 'text',
            title: '旧产出物',
            category: null,
            currentVersion: 1,
            updatedAt: '2026-08-07T00:00:00.000Z',
          },
        ],
      });
    });

    it('有 artifactId 缺省 version → 返回 currentVersion 版本全文（含 category）', async () => {
      allowWorker();
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'a_1',
        type: 'text',
        title: '实现说明',
        category: '实现',
        currentVersion: 1,
        updatedAt: new Date('2026-08-07T00:00:00Z'),
      });
      prisma.artifactVersion.findUnique.mockResolvedValue({
        id: 'av_1',
        artifactId: 'a_1',
        version: 1,
        contentRef: '完成报表聚合与 CSV 导出…',
        filePath: null,
        sha256: null,
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: new Date('2026-08-07T00:00:00Z'),
      });

      const result = await service.doclib(ctx, { taskId, artifactId: 'a_1' });

      expect(prisma.artifactVersion.findUnique).toHaveBeenCalledWith({
        where: { artifactId_version: { artifactId: 'a_1', version: 1 } },
      });
      expect(result).toMatchObject({
        id: 'a_1',
        category: '实现',
        version: { contentRef: '完成报表聚合与 CSV 导出…', filePath: null },
      });
    });

    it('详情：未设 category 的产出物透出 null（未分类）', async () => {
      allowWorker();
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'a_9',
        type: 'text',
        title: '旧产出物',
        category: null,
        currentVersion: 1,
        updatedAt: new Date('2026-08-07T00:00:00Z'),
      });
      prisma.artifactVersion.findUnique.mockResolvedValue({
        id: 'av_9',
        artifactId: 'a_9',
        version: 1,
        contentRef: '旧内容',
        filePath: null,
        sha256: null,
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: new Date('2026-08-07T00:00:00Z'),
      });

      const result = await service.doclib(ctx, { taskId, artifactId: 'a_9' });

      expect(result).toMatchObject({ id: 'a_9', category: null });
    });

    it('显式 version → 返回指定版本', async () => {
      allowWorker();
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'a_1',
        type: 'text',
        title: '实现说明',
        currentVersion: 2,
        updatedAt: new Date('2026-08-07T00:00:00Z'),
      });
      prisma.artifactVersion.findUnique.mockResolvedValue({
        id: 'av_2',
        artifactId: 'a_1',
        version: 2,
        contentRef: 'v2 内容',
        filePath: null,
        sha256: null,
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: new Date('2026-08-07T00:00:00Z'),
      });

      await service.doclib(ctx, { taskId, artifactId: 'a_1', version: 2 });

      expect(prisma.artifactVersion.findUnique).toHaveBeenCalledWith({
        where: { artifactId_version: { artifactId: 'a_1', version: 2 } },
      });
    });

    it('doc/file 版本（filePath 非空）→ 附 fileUrl/fileName/fileExt', async () => {
      allowWorker();
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'a_1',
        type: 'file',
        title: '测试报告',
        currentVersion: 1,
        updatedAt: new Date('2026-08-07T00:00:00Z'),
      });
      prisma.artifactVersion.findUnique.mockResolvedValue({
        id: 'av_1',
        artifactId: 'a_1',
        version: 1,
        contentRef: '/uploads/report.pdf',
        filePath: '/data/tasks/t_1/report.pdf',
        sha256: 'abc123',
        acceptedFlag: false,
        authorAgentId: null,
        changeNote: null,
        createdAt: new Date('2026-08-07T00:00:00Z'),
      });

      const result = await service.doclib(ctx, { taskId, artifactId: 'a_1' });

      const version = (result as { version: Record<string, unknown> }).version;
      expect(version).toMatchObject({
        contentRef: '/uploads/report.pdf',
        filePath: '/data/tasks/t_1/report.pdf',
        fileUrl: '/uploads/report.pdf',
        fileName: 'report.pdf',
        fileExt: 'pdf',
      });
    });

    it('产出物不存在或不属于该任务 → 404 PLATFORM_MCP_ARTIFACT_NOT_FOUND', async () => {
      allowWorker();
      prisma.artifact.findFirst.mockResolvedValue(null);
      await expectCode(
        service.doclib(ctx, { taskId, artifactId: 'a_other' }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.ARTIFACT_NOT_FOUND,
      );
    });

    it('版本不存在 → 404 PLATFORM_MCP_VERSION_NOT_FOUND', async () => {
      allowWorker();
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'a_1',
        type: 'text',
        title: 'x',
        currentVersion: 1,
        updatedAt: new Date('2026-08-07T00:00:00Z'),
      });
      prisma.artifactVersion.findUnique.mockResolvedValue(null);
      await expectCode(
        service.doclib(ctx, { taskId, artifactId: 'a_1', version: 99 }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.VERSION_NOT_FOUND,
      );
    });
  });

  describe('task_context', () => {
    it('返回任务概览 + 群聊 channelId + 团队 agentMembers（实例形状含 main 标注）', async () => {
      allowWorker();
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        title: '需求分析',
        description: '描述',
        status: 'in_progress',
        mainAgentId: 'ag_1',
        mainAgentInstanceId: 'tmm_1',
        backgroundDocs: [{ name: '背景.md' }],
        teamId: 'tm_1',
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_1',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_1',
          alias: '产品经理-1',
          seq: 1,
          agentId: 'ag_1',
          agent: { id: 'ag_1', name: '产品' },
          role: { key: 'product', name: '产品经理' },
        },
        {
          id: 'tmm_2',
          alias: '架构师-1',
          seq: 1,
          agentId: 'ag_2',
          agent: { id: 'ag_2', name: '架构' },
          role: { key: 'architect', name: '架构师' },
        },
      ]);

      const result = await service.taskContext(ctx, { taskId });

      expect(prisma.teamMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { teamId: 'tm_1' } }),
      );
      expect(result).toEqual({
        id: taskId,
        title: '需求分析',
        description: '描述',
        status: 'in_progress',
        mainAgentId: 'ag_1',
        mainAgentInstanceId: 'tmm_1',
        backgroundDocs: [{ name: '背景.md' }],
        channelId,
        pendingReceipts: { pending: 0, total: 0 },
        agentMembers: [
          {
            id: 'tmm_1',
            alias: '产品经理-1',
            agentId: 'ag_1',
            name: '产品',
            role: 'product',
            main: true,
          },
          {
            id: 'tmm_2',
            alias: '架构师-1',
            agentId: 'ag_2',
            name: '架构',
            role: 'architect',
            main: false,
          },
        ],
      });
    });

    it('任务不存在 → 404 PLATFORM_MCP_TASK_NOT_FOUND', async () => {
      allowWorker();
      prisma.task.findUnique.mockResolvedValue(null);
      await expectCode(
        service.taskContext(ctx, { taskId }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
      );
    });

    it('pendingReceipts 返回回执 n/N 计数（按 taskId 查询）', async () => {
      allowWorker();
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        title: '需求分析',
        description: '描述',
        status: 'in_progress',
        mainAgentId: 'ag_1',
        mainAgentInstanceId: 'tmm_1',
        backgroundDocs: [],
        teamId: 'tm_1',
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_1',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.teamMember.findMany.mockResolvedValue([]);
      receiptsService.countPending.mockResolvedValue({ pending: 2, total: 5 });

      const result = await service.taskContext(ctx, { taskId });

      expect(receiptsService.countPending).toHaveBeenCalledWith({
        taskId,
      });
      expect(result.pendingReceipts).toEqual({ pending: 2, total: 5 });
    });
  });

  describe('group_post', () => {
    const createdMessage = {
      id: 'm_0000000100',
      channelId,
      senderType: SENDER_TYPE.agent,
      senderId: senderAgentId,
      content: { text: '结论：已完成', parts: [] },
      mentions: null,
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      status: MESSAGE_STATUS.sent,
      createdAt: new Date('2026-08-07T00:00:00Z'),
    };

    beforeEach(() => {
      // resolveSenderAgentId：senderId=agent id 从 selfInstanceId 成员行解析
      prisma.teamMember.findUnique.mockResolvedValue({
        agentId: senderAgentId,
      } as any);
    });

    it('落库 agent 消息（senderId=agent id + senderInstanceId=实例 id 双写）+ 广播 chat.message.new（先落库后转发）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);

      const result = await service.groupPost(ctx, {
        taskId,
        content: '结论：已完成',
        selfInstanceId: senderInstanceId,
      });

      expect(idGen.nextId).toHaveBeenCalledWith('m');
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          id: 'm_0000000100',
          channelId,
          taskId,
          senderType: SENDER_TYPE.agent,
          senderId: senderAgentId,
          senderInstanceId: senderInstanceId,
          content: { text: '结论：已完成', parts: [] },
          mentions: null,
          status: MESSAGE_STATUS.sent,
        },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.objectContaining({
          message: expect.objectContaining({ id: 'm_0000000100' }),
        }),
        { type: 'channel', id: channelId },
      );
      expect(result).toEqual({
        messageId: 'm_0000000100',
        channelId,
        attachment: null,
      });
    });

    it('2026-09-16 移除多 @ 触发：content 含 @ 成员 → 落库 mentions 但不派发（通知/留痕语义）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      // 团队实例：主 Agent（a_project_manager/鲍勃）+ 其他成员（用于 @ 前缀边界）
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_pm',
          agentId: 'a_project_manager',
          alias: '鲍勃',
          agent: { name: '项目经理' },
        },
        {
          id: 'tmm_dev',
          agentId: 'a_developer',
          alias: '刘二开',
          agent: { name: '开发者' },
        },
      ]);

      const result = await service.groupPost(ctx, {
        taskId,
        content: '@鲍勃 请审核本次方案',
        selfInstanceId: senderInstanceId,
      });

      // mentions 落库（对齐 notify_agent 形状：instanceId+agentId+name）
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mentions: [
            {
              type: 'agent',
              instanceId: 'tmm_pm',
              agentId: 'a_project_manager',
              name: '鲍勃',
            },
          ],
        }),
      });
      // 多 @ 自动触发已下线：需唤醒成员须显式调 notify_agent，group_post 不再派发
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(result).toEqual({
        messageId: 'm_0000000100',
        channelId,
        attachment: null,
      });
    });

    it('is_0000000015：content 无 @ 提及 → mentions 保持 null、不触发分派（普通群聊发布）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_pm',
          agentId: 'a_project_manager',
          alias: '鲍勃',
          agent: { name: '项目经理' },
        },
      ]);

      await service.groupPost(ctx, {
        taskId,
        content: '进度同步：所有需求已完成',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ mentions: null }),
      });
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('is_0000000015：多实例 @ 前缀边界（@开发者 不误触发 @开发者-2；@开发者-2 精确命中）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_dev1',
          agentId: 'a_developer',
          alias: '开发者-1',
          agent: { name: '开发者' },
        },
        {
          id: 'tmm_dev2',
          agentId: 'a_developer',
          alias: '开发者-2',
          agent: { name: '开发者' },
        },
      ]);

      await service.groupPost(ctx, {
        taskId,
        content: '@开发者-2 请处理',
        selfInstanceId: senderInstanceId,
      });

      const mentions = prisma.message.create.mock.calls[0][0].data.mentions;
      expect(mentions).toEqual([
        {
          type: 'agent',
          instanceId: 'tmm_dev2',
          agentId: 'a_developer',
          name: '开发者-2',
        },
      ]);
      // mentions 精确命中（前缀边界不误扩），但多 @ 触发已下线 → 不派发
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('多 @ 多人 → mentions 全部落库但零派发（本次变更核心契约）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_dev',
          agentId: 'a_developer',
          alias: '开发者-1',
          agent: { name: '开发者' },
        },
        {
          id: 'tmm_test',
          agentId: 'a_tester',
          alias: '测试-1',
          agent: { name: '测试' },
        },
        {
          id: 'tmm_arch',
          agentId: 'a_architect',
          alias: '架构师-1',
          agent: { name: '架构师' },
        },
      ]);

      await service.groupPost(ctx, {
        taskId,
        content: '@开发者-1 @测试-1 @架构师-1 请开发修复，测试待命',
        selfInstanceId: senderInstanceId,
      });

      const mentions = prisma.message.create.mock.calls[0][0].data.mentions;
      expect(mentions).toHaveLength(3);
      expect(mentions.map((m: { instanceId: string }) => m.instanceId)).toEqual(
        ['tmm_dev', 'tmm_test', 'tmm_arch'],
      );
      // 关键：即便「测试待命」写在文案里，平台也不得唤醒任何被 @ 者
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('多 @ 触发下线后：连发同对消息也不产生任何派发（消息照常落库广播+返回成功）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_pm',
          agentId: 'a_project_manager',
          alias: '鲍勃',
          agent: { name: '项目经理' },
        },
      ]);
      const throttle = (service as any).mentionThrottle;
      for (let i = 0; i < 3; i++) {
        throttle.shouldDispatch({
          taskId,
          fromInstanceId: senderInstanceId,
          toInstanceId: 'tmm_pm',
          now: Date.now(),
        });
      }

      const result = await service.groupPost(ctx, {
        taskId,
        content: '@鲍勃 请审核本次方案',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.message.create).toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(result).toEqual({
        messageId: 'm_0000000100',
        channelId,
        attachment: null,
      });
    });

    it('agent 内容含 @all → 同样不触发（消息照常发布，@ 一律仅通知）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.teamMember.findMany.mockResolvedValue([
        {
          id: 'tmm_pm',
          agentId: 'a_project_manager',
          alias: '鲍勃',
          agent: { name: '项目经理' },
        },
      ]);

      const result = await service.groupPost(ctx, {
        taskId,
        content: '@鲍勃 @all 请大家看一下',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.message.create).toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(result).toEqual({
        messageId: 'm_0000000100',
        channelId,
        attachment: null,
      });
    });

    it('is_0000000028：内存活跃集合未命中但 DB 有绑定会话 → 放行（修复间歇性误拒合法成员）', async () => {
      // 模拟并发/超时导致的内存集合陈旧：isAgentExecuting 返回不含调用方的集合
      workerDispatcher.isAgentExecuting.mockReturnValue(
        new Set(['tmm_other_instance']),
      );
      // DB 会话存在（该 worker 绑定 selfInstanceId）
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);

      const result = await service.groupPost(ctx, {
        taskId,
        content: '结论',
        selfInstanceId: senderInstanceId,
      });

      // 不抛「不在活跃实例集合」，DB 会话兜底放行
      expect(result.messageId).toBe('m_0000000100');
      expect(prisma.session.findFirst).toHaveBeenCalled();
    });

    it('is_0000000028：内存活跃集合未命中且 DB 无绑定会话 → 拒绝（真冒充仍拦截）', async () => {
      workerDispatcher.isAgentExecuting.mockReturnValue(
        new Set(['tmm_other_instance']),
      );
      // DB 无该 worker 绑定 selfInstanceId 的会话
      prisma.session.findFirst.mockResolvedValue(null);

      await expectCode(
        service.groupPost(ctx, {
          taskId,
          content: '冒名',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
    });

    it('fileRef 命中该任务已归档产出物 → 挂附件三字段', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.artifactVersion.findMany.mockResolvedValue([
        { contentRef: '/uploads/report.pdf' },
      ]);

      const result = await service.groupPost(ctx, {
        taskId,
        content: '见附件',
        fileRef: '/uploads/report.pdf',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.artifactVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { artifact: { taskId }, filePath: { not: null } },
        }),
      );
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          attachmentUrl: '/uploads/report.pdf',
          attachmentName: 'report.pdf',
          attachmentType: 'pdf',
        }),
      });
      expect(result.attachment).toEqual({
        attachmentUrl: '/uploads/report.pdf',
        attachmentName: 'report.pdf',
        attachmentType: 'pdf',
      });
    });

    it('fileRef 未命中归档产出物 → 不带附件（不报错）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      // worker 查询默认未命中（jest.fn() → undefined）→ FR-41 拉取降级不带附件
      prisma.worker.findUnique.mockResolvedValue(null);

      const result = await service.groupPost(ctx, {
        taskId,
        content: '无附件',
        fileRef: 'missing.txt',
        selfInstanceId: senderInstanceId,
      });

      expect(workerClient.fetchFile).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.not.objectContaining({
          attachmentUrl: expect.anything(),
        }),
      });
      expect(result.attachment).toBeNull();
    });

    it('FR-41：未命中归档 → 从 worker 拉取成功 → 落盘 uploads + 挂附件 + 写 artifactVersion 归档', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      // 归档在 message.create 之前执行（resolveAttachment 先于落库），按前缀区分 id 不依赖调用顺序
      idGen.nextId.mockImplementation(async (prefix: string) => {
        if (prefix === 'm') return 'm_0000000100';
        if (prefix === 'art') return 'art_1';
        return 'artv_1';
      });
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.artifactVersion.findMany.mockResolvedValue([]); // 归档表未命中
      prisma.worker.findUnique.mockResolvedValue({
        capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
      });
      workerClient.fetchFile.mockResolvedValue(Buffer.from('文件内容 bytes'));
      artifactsService.archiveFile.mockResolvedValue({
        artifactId: 'art_1',
        version: 1,
        status: 'created',
      });

      const result = await service.groupPost(ctx, {
        taskId,
        content: '见附件',
        fileRef: '/tmp/opencode/test_file.txt',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.worker.findUnique).toHaveBeenCalledWith({
        where: { id: workerId },
        select: { capabilities: true },
      });
      expect(workerClient.fetchFile).toHaveBeenCalledWith(
        {
          id: workerId,
          capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
        },
        '/tmp/opencode/test_file.txt',
      );
      // 附件三字段：attachmentUrl 为落盘 URL（UUID 文件名，前缀断言）、name/ext 派生自 fileRef
      expect(result.attachment).toMatchObject({
        attachmentUrl: expect.stringMatching(/^\/uploads\//),
        attachmentName: 'test_file.txt',
        attachmentType: 'txt',
      });
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          attachmentUrl: expect.stringMatching(/^\/uploads\//),
          attachmentName: 'test_file.txt',
          attachmentType: 'txt',
        }),
      });
      // 归档公共化：转调 ArtifactsService.archiveFile（fileRef=fileRef 原文、storedUrl=落盘 URL、storedName=派生名）
      expect(artifactsService.archiveFile).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          fileRef: '/tmp/opencode/test_file.txt',
          storedUrl: expect.stringMatching(/^\/uploads\//),
          storedName: 'test_file.txt',
          sha256: expect.any(String),
        }),
      );
    });

    it('FR-41：未命中归档 → 同 sha256 已归档 → 跳过重复写入（附件照常挂载）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      prisma.worker.findUnique.mockResolvedValue({ capabilities: {} });
      workerClient.fetchFile.mockResolvedValue(Buffer.from('重复内容'));
      artifactsService.archiveFile.mockResolvedValue({
        artifactId: 'art_existing',
        version: 1,
        status: 'duplicate',
      });

      const result = await service.groupPost(ctx, {
        taskId,
        content: '见附件',
        fileRef: '/tmp/opencode/dup.txt',
        selfInstanceId: senderInstanceId,
      });

      expect(artifactsService.archiveFile).toHaveBeenCalled();
      expect(result.attachment).toMatchObject({
        attachmentUrl: expect.stringMatching(/^\/uploads\//),
        attachmentName: 'dup.txt',
        attachmentType: 'txt',
      });
    });

    it('FR-41：未命中归档 → worker 拉取失败（fetchFile 抛错）→ 不带附件（不报错）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      prisma.worker.findUnique.mockResolvedValue({ capabilities: {} });
      workerClient.fetchFile.mockRejectedValue(
        new Error('worker 不可用：file fetch HTTP 404'),
      );

      const result = await service.groupPost(ctx, {
        taskId,
        content: '无附件',
        fileRef: '/tmp/opencode/missing.txt',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.not.objectContaining({
          attachmentUrl: expect.anything(),
        }),
      });
      expect(result.attachment).toBeNull();
    });

    it('FR-41：未命中归档 → worker 不存在 → 不带附件（不报错，不调用 fetchFile）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      prisma.worker.findUnique.mockResolvedValue(null);

      const result = await service.groupPost(ctx, {
        taskId,
        content: '无附件',
        fileRef: '/tmp/opencode/x.txt',
        selfInstanceId: senderInstanceId,
      });

      expect(workerClient.fetchFile).not.toHaveBeenCalled();
      expect(result.attachment).toBeNull();
    });

    it('任务无群聊频道 → 404 PLATFORM_MCP_CHANNEL_NOT_FOUND', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      await expectCode(
        service.groupPost(ctx, {
          taskId,
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
      );
    });

    describe('内容幂等（MCP 超时重发去重：同发送者同频道同文窗口内复用既有行）', () => {
      it('窗口内同内容重发 → 回既有 messageId，零新行零广播（-32001 重发命中）', async () => {
        allowWorker();
        prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
        prisma.teamMember.findUnique.mockResolvedValue({
          agentId: senderAgentId,
        } as any);
        prisma.message.findMany.mockResolvedValue([
          {
            id: 'm_0000000099',
            content: { text: '结论：已完成', parts: [] },
          },
        ]);

        const result = await service.groupPost(ctx, {
          taskId,
          content: '结论：已完成',
          selfInstanceId: senderInstanceId,
        });

        expect(prisma.message.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              channelId,
              senderInstanceId,
            }),
            take: 20,
          }),
        );
        expect(result).toEqual({
          messageId: 'm_0000000099',
          channelId,
          attachment: null,
        });
        expect(prisma.message.create).not.toHaveBeenCalled();
        expect(realtime.broadcast).not.toHaveBeenCalled();
      });

      it('空白差异归一化后相同 → 同样命中（sha1 比对前已归一化）', async () => {
        allowWorker();
        prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
        prisma.teamMember.findUnique.mockResolvedValue({
          agentId: senderAgentId,
        } as any);
        prisma.message.findMany.mockResolvedValue([
          {
            id: 'm_0000000099',
            content: { text: '结论：已完成', parts: [] },
          },
        ]);

        const result = await service.groupPost(ctx, {
          taskId,
          content: '  结论：已完成\n',
          selfInstanceId: senderInstanceId,
        });

        expect(result.messageId).toBe('m_0000000099');
        expect(prisma.message.create).not.toHaveBeenCalled();
      });

      it('正文不同 → 不 collapsed，正常落库广播', async () => {
        allowWorker();
        prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
        prisma.teamMember.findUnique.mockResolvedValue({
          agentId: senderAgentId,
        } as any);
        idGen.nextId.mockResolvedValue('m_0000000100');
        prisma.message.create.mockResolvedValue(createdMessage);
        prisma.message.findMany.mockResolvedValue([
          {
            id: 'm_0000000099',
            content: { text: '结论：进行中', parts: [] },
          },
        ]);

        const result = await service.groupPost(ctx, {
          taskId,
          content: '结论：已完成',
          selfInstanceId: senderInstanceId,
        });

        expect(result.messageId).toBe('m_0000000100');
        expect(prisma.message.create).toHaveBeenCalled();
        expect(realtime.broadcast).toHaveBeenCalled();
      });

      it('探针读错 → fail-open 继续落库（永不因探针失败阻断）', async () => {
        allowWorker();
        prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
        prisma.teamMember.findUnique.mockResolvedValue({
          agentId: senderAgentId,
        } as any);
        idGen.nextId.mockResolvedValue('m_0000000100');
        prisma.message.create.mockResolvedValue(createdMessage);
        prisma.message.findMany.mockRejectedValue(new Error('db down'));

        const result = await service.groupPost(ctx, {
          taskId,
          content: '结论：已完成',
          selfInstanceId: senderInstanceId,
        });

        expect(result.messageId).toBe('m_0000000100');
        expect(prisma.message.create).toHaveBeenCalled();
      });
    });
  });

  describe('notify_agent', () => {
    const createdMessage = {
      id: 'm_0000000200',
      channelId,
      senderType: SENDER_TYPE.agent,
      senderId: 'a_sender',
      senderInstanceId: 'tmm_sender',
      content: { text: '@测试 请查看这个文件', parts: [] },
      mentions: [
        {
          type: 'agent',
          instanceId: 'tmm_tester',
          agentId: 'a_tester',
          name: '测试',
        },
      ],
      attachmentUrl: null,
      attachmentName: null,
      attachmentType: null,
      status: MESSAGE_STATUS.sent,
      createdAt: new Date('2026-08-07T00:00:00Z'),
    };

    /**
     * teamMember 分流：目标成员 tmm_tester → a_tester/别名 测试（@ 目标、mentions
     * 归属依据）；发送者成员 tmm_sender → a_sender（senderId/senderInstanceId 落库归属依据）。
     * 主 Agent 路由门：缺省调用方即主成员（既有成功路径断言语义不变）。
     */
    const mockTeamMemberRows = () => {
      prisma.teamMember.findFirst.mockImplementation(
        (args: { where: { id?: string } }) => {
          if (args.where.id === 'tmm_tester') {
            return Promise.resolve({
              agentId: 'a_tester',
              alias: null,
              agent: { id: 'a_tester', name: '测试' },
            });
          }
          if (args.where.id === senderInstanceId) {
            return Promise.resolve({
              agentId: 'a_sender',
              alias: null,
              agent: { id: 'a_sender', name: '发送者' },
            });
          }
          return Promise.resolve(null);
        },
      );
      prisma.teamMember.findUnique.mockImplementation(
        (args: { where: { id?: string } }) => {
          if (args.where.id === senderInstanceId) {
            return Promise.resolve({ agentId: 'a_sender' });
          }
          return Promise.resolve(null);
        },
      );
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: senderInstanceId,
        currentTaskId: taskId,
      });
      prisma.task.findUnique.mockResolvedValue({
        teamId: 'tm_1',
        status: 'in_progress',
      });
    };

    it('落库 agent 消息（sender=发送者：senderId=发送者 agent id、senderInstanceId=selfInstanceId、mentions 含目标实例）+ 广播 + 触发目标实例 dispatch + 返回结构', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);

      const result = await service.notifyAgent(ctx, {
        taskId,
        targetInstanceId: 'tmm_tester',
        content: '请查看这个文件',
        selfInstanceId: senderInstanceId,
      });

      expect(idGen.nextId).toHaveBeenCalledWith('m');
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          id: 'm_0000000200',
          channelId,
          senderType: SENDER_TYPE.agent,
          senderId: 'a_sender',
          senderInstanceId: 'tmm_sender',
          content: { text: '@测试 请查看这个文件', parts: [] },
          mentions: [
            {
              type: 'agent',
              instanceId: 'tmm_tester',
              agentId: 'a_tester',
              name: '测试',
            },
          ],
          status: MESSAGE_STATUS.sent,
        },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.objectContaining({
          message: expect.objectContaining({ id: 'm_0000000200' }),
        }),
        { type: 'channel', id: channelId },
      );
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith({
        taskId,
        channelId,
        text: '@测试 请查看这个文件',
        targetInstanceId: 'tmm_tester',
        kind: 'execution',
      });
      expect(result).toEqual({
        messageId: 'm_0000000200',
        channelId,
        targetInstanceId: 'tmm_tester',
        triggered: true,
        reason: 'ok',
        issueBound: false,
      });
    });

    it('团队维度（teamId、无任务）→ 落库广播后经团队路径触发目标成员 + 返回 triggered:true', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: senderInstanceId,
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000205');
      prisma.message.create.mockResolvedValue({
        ...createdMessage,
        id: 'm_0000000205',
      });

      const result = await service.notifyAgent(ctx, {
        teamId: 'tm_1',
        targetInstanceId: 'tmm_tester',
        content: '请查看这个文件',
        selfInstanceId: senderInstanceId,
      });

      // 团队路径不做任务维度归属查表；唯一 task 查表是主 agent 门禁的开门状态探针。
      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: taskId },
        select: { status: true },
      });
      expect(prisma.message.create).toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith({
        teamId: 'tm_1',
        channelId,
        text: '@测试 请查看这个文件',
        targetInstanceId: 'tmm_tester',
        kind: 'execution',
      });
      expect(result).toEqual({
        messageId: 'm_0000000205',
        channelId,
        targetInstanceId: 'tmm_tester',
        triggered: true,
        reason: 'ok',
        issueBound: false,
      });
    });

    it('归属校验失败 → 403 PLATFORM_MCP_FORBIDDEN（不落库不触发）', async () => {
      denyWorker();
      await expectCode(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('任务无群聊频道 → 404 PLATFORM_MCP_CHANNEL_NOT_FOUND', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      await expectCode(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
      );
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('目标实例无会话 → dispatchAgentMention 抛错向上传播（模型可见，消息已落库广播）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);
      workerDispatcher.dispatchAgentMention.mockRejectedValue(
        new Error('实例 tmm_tester 无会话（任务 t_0000000001）'),
      );

      await expect(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
      ).rejects.toThrow(/tmm_tester 无会话/);
      // 落库 + 广播已执行（先落库后触发）
      expect(prisma.message.create).toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalled();
    });

    it('目标实例不存在或不在任务团队 → 404（不落库不触发）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.teamMember.findFirst.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('m_0000000200');

      await expectCode(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_missing',
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('@ storm 熔断：配额耗尽后不触发不落库（messageId:null + 请勿重发 hint）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);
      const throttle = (service as any).mentionThrottle;
      for (let i = 0; i < 3; i++) {
        throttle.shouldDispatch({
          taskId,
          fromInstanceId: senderInstanceId,
          toInstanceId: 'tmm_tester',
          now: Date.now(),
        });
      }

      const result = await service.notifyAgent(ctx, {
        taskId,
        targetInstanceId: 'tmm_tester',
        content: '请查看这个文件',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(result).toEqual({
        messageId: null,
        channelId,
        targetInstanceId: 'tmm_tester',
        triggered: false,
        reason: 'throttled',
        hint: expect.stringContaining('请勿重发'),
        issueBound: false,
      });
    });

    it('内部 wake 免节流：配额耗尽后 kind=wake 仍触发（不咨询不记账，零丢失）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);
      const throttle = (service as any).mentionThrottle;
      for (let i = 0; i < 3; i++) {
        throttle.shouldDispatch({
          taskId,
          fromInstanceId: senderInstanceId,
          toInstanceId: 'tmm_tester',
          now: Date.now(),
        });
      }

      const result = await service.notifyAgent(ctx, {
        taskId,
        targetInstanceId: 'tmm_tester',
        content: '回执摘要：你派发的 1 项已有回音',
        selfInstanceId: senderInstanceId,
        kind: 'wake',
      });

      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({
          targetInstanceId: 'tmm_tester',
          kind: 'wake',
        }),
      );
      expect(result).toEqual({
        messageId: 'm_0000000200',
        channelId,
        targetInstanceId: 'tmm_tester',
        triggered: true,
        reason: 'ok',
        issueBound: false,
      });
    });

    it('团队维度被节流 → 不发布不触发，返回 triggered:false + reason + messageId:null', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: senderInstanceId,
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000210');
      prisma.message.create.mockResolvedValue({
        ...createdMessage,
        id: 'm_0000000210',
      });
      const throttle = (service as any).mentionThrottle;
      for (let i = 0; i < 3; i++) {
        throttle.shouldDispatch({
          taskId: 'team:tm_1',
          fromInstanceId: senderInstanceId,
          toInstanceId: 'tmm_tester',
          now: Date.now(),
        });
      }

      const result = await service.notifyAgent(ctx, {
        teamId: 'tm_1',
        targetInstanceId: 'tmm_tester',
        content: '请查看这个文件',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(result).toEqual({
        messageId: null,
        channelId,
        targetInstanceId: 'tmm_tester',
        triggered: false,
        reason: 'throttled',
        hint: expect.stringContaining('请勿重发'),
        issueBound: false,
      });
    });

    it('@all 内容不 fan-out：notify_agent 仅触发显式单目标', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);

      const result = await service.notifyAgent(ctx, {
        taskId,
        targetInstanceId: 'tmm_tester',
        content: '请查看这个文件 @all 顺带周知',
        selfInstanceId: senderInstanceId,
      });

      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ targetInstanceId: 'tmm_tester' }),
      );
      expect(result).toEqual({
        messageId: 'm_0000000200',
        channelId,
        targetInstanceId: 'tmm_tester',
        triggered: true,
        reason: 'ok',
        issueBound: false,
      });
    });

    it('契约：成功返回 triggered:true + reason:ok 成对 + issueId 缺省 → issueBound:false（hint，不硬拦）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);

      const result = await service.notifyAgent(ctx, {
        taskId,
        targetInstanceId: 'tmm_tester',
        content: '请查看这个文件',
        selfInstanceId: senderInstanceId,
      });

      expect(result.triggered).toBe(true);
      expect(result.reason).toBe('ok');
      expect(result).toEqual(
        expect.objectContaining({
          issueBound: false,
          messageId: 'm_0000000200',
        }),
      );
    });

    it('契约：透传 issueId → dispatchAgentMention 收到 issueId + 返回 issueBound:true', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);
      const args = {
        taskId,
        targetInstanceId: 'tmm_tester',
        content: '请查看这个文件',
        selfInstanceId: senderInstanceId,
        issueId: 'is_0000000001',
      };

      const result = await service.notifyAgent(ctx, args);

      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({
          targetInstanceId: 'tmm_tester',
          issueId: 'is_0000000001',
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          triggered: true,
          reason: 'ok',
          issueBound: true,
        }),
      );
    });

    it('契约：节流返回 triggered:false + reason:throttled + messageId:null 成对（pair_limit/task_budget 统一收敛，不再透出内部节流键）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTeamMemberRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);
      const throttle = (service as any).mentionThrottle;
      for (let i = 0; i < 3; i++) {
        throttle.shouldDispatch({
          taskId,
          fromInstanceId: senderInstanceId,
          toInstanceId: 'tmm_tester',
          now: Date.now(),
        });
      }

      const result = await service.notifyAgent(ctx, {
        taskId,
        targetInstanceId: 'tmm_tester',
        content: '请查看这个文件',
        selfInstanceId: senderInstanceId,
      });

      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          triggered: false,
          reason: 'throttled',
          messageId: null,
        }),
      );
      expect(result).toEqual(expect.objectContaining({ issueBound: false }));
    });

    describe('主 Agent 路由门（落库前硬拦）', () => {
      const notifyOk = () =>
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

      beforeEach(() => {
        allowWorker();
        prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
        mockTeamMemberRows();
        idGen.nextId.mockResolvedValue('m_0000000200');
        prisma.message.create.mockResolvedValue(createdMessage);
      });

      it('主成员→普通成员放行（triggered:true，消息落库）', async () => {
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: senderInstanceId,
        });

        const result = await notifyOk();

        expect(prisma.message.create).toHaveBeenCalled();
        expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
          expect.objectContaining({ targetInstanceId: 'tmm_tester' }),
        );
        expect(result).toEqual(
          expect.objectContaining({ triggered: true, reason: 'ok' }),
        );
      });

      it('普通成员→主成员放行路由门但 join 抑制（缺省 answer：消息落库，不开执行 turn，triggered:false+join-pending）', async () => {
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: 'tmm_tester',
        });

        const result = await notifyOk();

        expect(prisma.message.create).toHaveBeenCalled();
        expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
        expect(result).toEqual(
          expect.objectContaining({ triggered: false, reason: 'join-pending' }),
        );
      });

      it('普通成员→普通成员 403 PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION（不落库不广播不触发）', async () => {
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: 'tmm_main',
        });

        await expectCode(
          notifyOk(),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.NOTIFY_ROUTING_VIOLATION,
        );
        expect(prisma.message.create).not.toHaveBeenCalled();
        expect(realtime.broadcast).not.toHaveBeenCalled();
        expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      });

      it('self-notify 403（不落库不触发）', async () => {
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: 'tmm_main',
        });

        await expectCode(
          service.notifyAgent(ctx, {
            taskId,
            targetInstanceId: senderInstanceId,
            content: '自言自语',
            selfInstanceId: senderInstanceId,
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.NOTIFY_ROUTING_VIOLATION,
        );
        expect(prisma.message.create).not.toHaveBeenCalled();
        expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      });

      it('团队未绑定主成员 → fail-open 放行 + warn（残留缺口可观测）', async () => {
        prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
        const warnSpy = jest
          .spyOn(
            (service as unknown as { logger: { warn: jest.Mock } }).logger,
            'warn',
          )
          .mockImplementation((() => undefined) as unknown as jest.Mock);

        const result = await notifyOk();

        expect(result).toEqual(
          expect.objectContaining({ triggered: true, reason: 'ok' }),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('未绑定主成员'),
        );
        warnSpy.mockRestore();
      });
    });

    describe('内容幂等（同对同文窗口内复用既有行，不新建行）', () => {
      beforeEach(() => {
        allowWorker();
        prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
        mockTeamMemberRows();
        idGen.nextId.mockResolvedValue('m_0000000200');
        prisma.message.create.mockResolvedValue(createdMessage);
      });

      it('窗口内重复发送 → reason=dedup + 回既有 messageId，零新行零触发', async () => {
        prisma.message.findMany.mockResolvedValue([
          {
            id: 'm_0000000199',
            content: { text: '@测试 请查看这个文件', parts: [] },
          },
        ]);

        const result = await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

        expect(prisma.message.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              channelId,
              senderInstanceId,
            }),
            take: 20,
          }),
        );
        expect(result).toEqual({
          messageId: 'm_0000000199',
          channelId,
          targetInstanceId: 'tmm_tester',
          triggered: false,
          reason: 'dedup',
          hint: expect.stringContaining('请勿重发'),
          issueBound: false,
        });
        expect(prisma.message.create).not.toHaveBeenCalled();
        expect(realtime.broadcast).not.toHaveBeenCalled();
        expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      });

      it('首尾空白差异归一化后相同 → 同样命中（trim 后比对）', async () => {
        prisma.message.findMany.mockResolvedValue([
          {
            id: 'm_0000000199',
            content: { text: '@测试 请查看这个文件', parts: [] },
          },
        ]);

        const result = await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '  请查看这个文件 ',
          selfInstanceId: senderInstanceId,
        });

        expect(result.reason).toBe('dedup');
        expect(result.messageId).toBe('m_0000000199');
        expect(prisma.message.create).not.toHaveBeenCalled();
      });

      it('正文不同 → 不 collapsed，正常落库触发', async () => {
        prisma.message.findMany.mockResolvedValue([
          {
            id: 'm_0000000199',
            content: { text: '@测试 请查看那个文件', parts: [] },
          },
        ]);

        const result = await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

        expect(result).toEqual(
          expect.objectContaining({
            messageId: 'm_0000000200',
            triggered: true,
            reason: 'ok',
          }),
        );
        expect(prisma.message.create).toHaveBeenCalled();
        expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalled();
      });

      it('窗口谓词：探针只查 channel/发送者/60s 内行（stale 行由查询谓词排除）', async () => {
        prisma.message.findMany.mockResolvedValue([]);

        await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

        const args = prisma.message.findMany.mock.calls[0][0];
        expect(args.where.channelId).toBe(channelId);
        expect(args.where.senderInstanceId).toBe(senderInstanceId);
        const gte = args.where.createdAt.gte as Date;
        const ageMs = Date.now() - gte.getTime();
        expect(ageMs).toBeGreaterThanOrEqual(59_000);
        expect(ageMs).toBeLessThanOrEqual(61_000);
      });

      it('探针读错 → fail-open 继续派发（永不因探针失败阻断）', async () => {
        prisma.message.findMany.mockRejectedValue(new Error('db down'));

        const result = await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

        expect(result).toEqual(
          expect.objectContaining({ triggered: true, reason: 'ok' }),
        );
        expect(prisma.message.create).toHaveBeenCalled();
      });
    });

    describe('目标 mention 前缀（已带不再补，不双 @）', () => {
      beforeEach(() => {
        allowWorker();
        prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
        mockTeamMemberRows();
        idGen.nextId.mockResolvedValue('m_0000000200');
        prisma.message.create.mockResolvedValue(createdMessage);
        prisma.message.findMany.mockResolvedValue([]);
      });

      it('内容已以 @目标 开头 → 原样落库，不双前缀，mentions 仍单条', async () => {
        const result = await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '@测试 请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

        expect(result.triggered).toBe(true);
        const data = prisma.message.create.mock.calls[0][0].data;
        expect(data.content).toEqual({
          text: '@测试 请查看这个文件',
          parts: [],
        });
        expect(data.mentions).toHaveLength(1);
      });

      it('内容以 @目标+标点开头 → 同样视为已带（如 @测试，请看）', async () => {
        await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '@测试，请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

        const data = prisma.message.create.mock.calls[0][0].data;
        expect(data.content).toEqual({
          text: '@测试，请查看这个文件',
          parts: [],
        });
      });

      it('内容未带 mention → 补前缀（原行为不变）', async () => {
        await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

        const data = prisma.message.create.mock.calls[0][0].data;
        expect(data.content).toEqual({
          text: '@测试 请查看这个文件',
          parts: [],
        });
      });

      it('@目标-2 之于目标 测试 → token 不等仍补前缀（宁可显示重复，不可指派错人）', async () => {
        await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '@测试-2 请查看这个文件',
          selfInstanceId: senderInstanceId,
        });

        const data = prisma.message.create.mock.calls[0][0].data;
        expect(data.content).toEqual({
          text: '@测试 @测试-2 请查看这个文件',
          parts: [],
        });
        expect(data.mentions).toHaveLength(1);
        expect(data.mentions[0].instanceId).toBe('tmm_tester');
      });

      it('中间 mention 不动：只判定开头（@目标 在文中不触发剥离）', async () => {
        await service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '同步一下 @测试 的结论请查收',
          selfInstanceId: senderInstanceId,
        });

        const data = prisma.message.create.mock.calls[0][0].data;
        expect(data.content).toEqual({
          text: '@测试 同步一下 @测试 的结论请查收',
          parts: [],
        });
      });
    });
  });

  describe('read_file', () => {
    let fsReadSpy: jest.SpyInstance;

    beforeEach(() => {
      // 归档路径经 FileStorageService.readUploadedFile → fsp.readFile（与 uploads.service
      // 的 `import { promises as fsp } from 'fs'` 同模块对象，spy 生效）。
      fsReadSpy = jest
        .spyOn(fs.promises, 'readFile')
        .mockResolvedValue(Buffer.from(''));
    });

    afterEach(() => {
      fsReadSpy.mockRestore();
    });

    it('归档命中（filePath 归一化匹配）→ 从 uploads 读内容 → source=archive，不触达 worker', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          contentRef: '/uploads/abc-uuid.txt',
          filePath: '/tmp/opencode/x.txt',
        },
      ]);
      fsReadSpy.mockResolvedValue(Buffer.from('归档内容'));

      const result = await service.readFile(ctx, {
        taskId,
        fileRef: '/tmp/opencode/x.txt',
      });

      expect(prisma.artifactVersion.findMany).toHaveBeenCalledWith({
        where: { artifact: { taskId }, filePath: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { contentRef: true, filePath: true },
      });
      expect(fsReadSpy).toHaveBeenCalled();
      expect(workerClient.fetchFile).not.toHaveBeenCalled();
      expect(result).toEqual({
        content: '归档内容',
        fileName: 'x.txt',
        fileRef: '/tmp/opencode/x.txt',
        source: 'archive',
      });
    });

    it('fileRef 传 /uploads/ 形式也能命中（归一化相等）', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          contentRef: '/uploads/abc-uuid.txt',
          filePath: '/tmp/opencode/x.txt',
        },
      ]);
      fsReadSpy.mockResolvedValue(Buffer.from('内容'));

      const result = await service.readFile(ctx, {
        taskId,
        fileRef: '/uploads/x.txt',
      });

      expect(result).toMatchObject({ content: '内容', source: 'archive' });
    });

    it('归档未命中 → 从调用方 worker 拉取 → source=worker', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      prisma.worker.findUnique.mockResolvedValue({
        capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
      });
      workerClient.fetchFile.mockResolvedValue(Buffer.from('worker 内容'));

      const result = await service.readFile(ctx, {
        taskId,
        fileRef: '/tmp/opencode/y.txt',
      });

      expect(prisma.worker.findUnique).toHaveBeenCalledWith({
        where: { id: workerId },
        select: { capabilities: true },
      });
      expect(workerClient.fetchFile).toHaveBeenCalledWith(
        {
          id: workerId,
          capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
        },
        '/tmp/opencode/y.txt',
      );
      expect(result).toEqual({
        content: 'worker 内容',
        fileName: 'y.txt',
        fileRef: '/tmp/opencode/y.txt',
        source: 'worker',
      });
    });

    it('is_0000000018：/uploads/* 未归档（任务背景文档经 POST /uploads 上传）→ server 上传目录直读，不触达 worker', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      fsReadSpy.mockResolvedValue(Buffer.from('背景文档内容'));

      const result = await service.readFile(ctx, {
        taskId,
        fileRef: '/uploads/8054d908-85d3-45e5-8d96-3bc1a4b8a092.md',
      });

      // 直接走 readFromArchive（readUploadedFile → fsp.readFile），不再 worker 拉取
      expect(fsReadSpy).toHaveBeenCalled();
      expect(workerClient.fetchFile).not.toHaveBeenCalled();
      expect(prisma.worker.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual({
        content: '背景文档内容',
        fileName: '8054d908-85d3-45e5-8d96-3bc1a4b8a092.md',
        fileRef: '/uploads/8054d908-85d3-45e5-8d96-3bc1a4b8a092.md',
        source: 'archive',
      });
    });

    it('归档未命中且 worker 不存在 → 404 PLATFORM_MCP_FILE_NOT_FOUND（不调用 fetchFile）', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      prisma.worker.findUnique.mockResolvedValue(null);

      await expectCode(
        service.readFile(ctx, { taskId, fileRef: '/tmp/opencode/z.txt' }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.FILE_NOT_FOUND,
      );
      expect(workerClient.fetchFile).not.toHaveBeenCalled();
    });

    it('归档未命中且 worker 拉取失败 → 上抛 WorkerUnavailableException（读取失败必须让调用方知道）', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([]);
      prisma.worker.findUnique.mockResolvedValue({ capabilities: {} });
      workerClient.fetchFile.mockRejectedValue(
        new WorkerUnavailableException(workerId, 'file fetch HTTP 404'),
      );

      await expect(
        service.readFile(ctx, { taskId, fileRef: '/tmp/opencode/missing.txt' }),
      ).rejects.toBeInstanceOf(WorkerUnavailableException);
    });

    it('归档记录命中但磁盘缺失 → 404 PLATFORM_MCP_FILE_NOT_FOUND', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          contentRef: '/uploads/ghost.txt',
          filePath: '/tmp/opencode/ghost.txt',
        },
      ]);
      fsReadSpy.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await expectCode(
        service.readFile(ctx, { taskId, fileRef: '/tmp/opencode/ghost.txt' }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.FILE_NOT_FOUND,
      );
    });

    it('maxBytes 截断 → truncated=true + content 仅前 N 字节', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          contentRef: '/uploads/abc-uuid.txt',
          filePath: '/tmp/opencode/long.txt',
        },
      ]);
      fsReadSpy.mockResolvedValue(Buffer.from('1234567890'));

      const result = await service.readFile(ctx, {
        taskId,
        fileRef: '/tmp/opencode/long.txt',
        maxBytes: 5,
      });

      expect(result).toMatchObject({
        content: '12345',
        truncated: true,
        source: 'archive',
      });
    });

    it('缺省 maxBytes（256KB）→ 小文件不截断（无 truncated 标记）', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          contentRef: '/uploads/abc-uuid.txt',
          filePath: '/tmp/opencode/small.txt',
        },
      ]);
      fsReadSpy.mockResolvedValue(Buffer.from('小文件内容'));

      const result = await service.readFile(ctx, {
        taskId,
        fileRef: '/tmp/opencode/small.txt',
      });

      expect(result.content).toBe('小文件内容');
      expect(result.truncated).toBeUndefined();
    });

    it('二进制（非法 utf8 字节）→ content 回退 base64 前缀标记', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          contentRef: '/uploads/abc-uuid.bin',
          filePath: '/tmp/opencode/data.bin',
        },
      ]);
      fsReadSpy.mockResolvedValue(Buffer.from([0xff, 0xfe, 0x00, 0x01]));

      const result = await service.readFile(ctx, {
        taskId,
        fileRef: '/tmp/opencode/data.bin',
      });

      expect(result.content).toMatch(/^base64:/);
    });

    it('缺 workerId → 403 PLATFORM_MCP_MISSING_WORKER_ID（复用 assertWorkerTask）', async () => {
      await expectCode(
        service.readFile({ workerId: '' }, { taskId, fileRef: 'x.txt' }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.MISSING_WORKER_ID,
      );
    });

    it('worker 无该任务 Session → 403 PLATFORM_MCP_FORBIDDEN（防跨任务）', async () => {
      denyWorker();
      await expectCode(
        service.readFile(ctx, { taskId, fileRef: 'x.txt' }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', workerId },
        }),
      );
    });
  });

  describe('submit_artifact', () => {
    it('text：调 ArtifactsService.append 落库 → 返回 {artifactId, version, status: created}', async () => {
      allowWorker();
      artifactsService.append.mockResolvedValue({
        status: 'archived',
        artifact: { id: 'a_1', currentVersion: 1 },
      });

      const result = await service.submitArtifact(ctx, {
        taskId,
        type: 'text',
        title: '实现说明',
        content: '已完成',
        selfInstanceId: senderInstanceId,
      });

      expect(artifactsService.append).toHaveBeenCalledWith(taskId, {
        taskId,
        type: 'text',
        title: '实现说明',
        content: '已完成',
      });
      expect(result).toEqual({
        artifactId: 'a_1',
        version: 1,
        status: 'created',
      });
    });

    it('text：带 category=测试用例 → append 透传 category', async () => {
      allowWorker();
      artifactsService.append.mockResolvedValue({
        status: 'archived',
        artifact: { id: 'a_2', currentVersion: 1 },
      });

      const result = await service.submitArtifact(ctx, {
        taskId,
        type: 'text',
        title: '登录用例',
        content: '用例正文',
        category: '测试用例',
        selfInstanceId: senderInstanceId,
      });

      expect(artifactsService.append).toHaveBeenCalledWith(taskId, {
        taskId,
        type: 'text',
        title: '登录用例',
        content: '用例正文',
        category: '测试用例',
      });
      expect(result).toEqual({
        artifactId: 'a_2',
        version: 1,
        status: 'created',
      });
    });

    it('text：不带 category → append 不传 category 键（旧调用回归，后向兼容）', async () => {
      allowWorker();
      artifactsService.append.mockResolvedValue({
        status: 'archived',
        artifact: { id: 'a_1', currentVersion: 1 },
      });

      await service.submitArtifact(ctx, {
        taskId,
        type: 'text',
        title: '实现说明',
        content: '已完成',
        selfInstanceId: senderInstanceId,
      });

      expect(artifactsService.append).toHaveBeenCalledWith(taskId, {
        taskId,
        type: 'text',
        title: '实现说明',
        content: '已完成',
      });
    });

    it('category 非法 → 400 PLATFORM_MCP_ARTIFACT_INVALID（不触达 append）', async () => {
      allowWorker();
      await expectCode(
        service.submitArtifact(ctx, {
          taskId,
          type: 'text',
          title: 'x',
          content: 'c',
          category: '不存在的类',
          selfInstanceId: senderInstanceId,
        }),
        BadRequestException,
        PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
      );
      expect(artifactsService.append).not.toHaveBeenCalled();
    });

    it('doc/file：带 category → archiveFile 第三参数透传 category', async () => {
      allowWorker();
      prisma.worker.findUnique.mockResolvedValue({ capabilities: {} });
      workerClient.fetchFile.mockResolvedValue(Buffer.from('设计稿 bytes'));
      artifactsService.archiveFile.mockResolvedValue({
        artifactId: 'art_2',
        version: 1,
        status: 'created',
      });

      const result = await service.submitArtifact(ctx, {
        taskId,
        type: 'file',
        title: '架构设计稿',
        fileRef: '/tmp/opencode/design.md',
        category: '设计',
        selfInstanceId: senderInstanceId,
      });

      expect(artifactsService.archiveFile).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          fileRef: '/tmp/opencode/design.md',
          title: '架构设计稿',
        }),
        '设计',
      );
      expect(result).toEqual({
        artifactId: 'art_2',
        version: 1,
        status: 'created',
      });
    });

    it('text：append 已存在同内容（duplicate）→ status 透传 duplicate', async () => {
      allowWorker();
      artifactsService.append.mockResolvedValue({
        status: 'duplicate',
        artifact: { id: 'a_1', currentVersion: 2 },
      });

      const result = await service.submitArtifact(ctx, {
        taskId,
        type: 'text',
        title: '实现说明',
        content: '已完成',
        selfInstanceId: senderInstanceId,
      });

      expect(result).toEqual({
        artifactId: 'a_1',
        version: 2,
        status: 'duplicate',
      });
    });

    it('text：已有同 title 产出物 append 新版本 → status: appended', async () => {
      allowWorker();
      artifactsService.append.mockResolvedValue({
        status: 'archived',
        artifact: { id: 'a_1', currentVersion: 2 },
      });

      const result = await service.submitArtifact(ctx, {
        taskId,
        type: 'text',
        title: '实现说明',
        content: '已完成',
        selfInstanceId: senderInstanceId,
      });

      expect(result).toEqual({
        artifactId: 'a_1',
        version: 2,
        status: 'appended',
      });
    });

    it('text 缺 content → 400 PLATFORM_MCP_ARTIFACT_INVALID（不触达 append）', async () => {
      allowWorker();
      await expectCode(
        service.submitArtifact(ctx, {
          taskId,
          type: 'text',
          title: 'x',
          selfInstanceId: senderInstanceId,
        }),
        BadRequestException,
        PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
      );
      expect(artifactsService.append).not.toHaveBeenCalled();
    });

    it('doc/file 缺 fileRef → 400 PLATFORM_MCP_ARTIFACT_INVALID', async () => {
      allowWorker();
      await expectCode(
        service.submitArtifact(ctx, {
          taskId,
          type: 'doc',
          title: 'x',
          selfInstanceId: senderInstanceId,
        }),
        BadRequestException,
        PLATFORM_MCP_ERRORS.ARTIFACT_INVALID,
      );
      expect(workerClient.fetchFile).not.toHaveBeenCalled();
    });

    it('doc/file：worker 拉取成功 → 落盘 uploads → 归档（转调 ArtifactsService.archiveFile，title 透传）', async () => {
      allowWorker();
      prisma.worker.findUnique.mockResolvedValue({
        capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
      });
      workerClient.fetchFile.mockResolvedValue(Buffer.from('文件内容 bytes'));
      artifactsService.archiveFile.mockResolvedValue({
        artifactId: 'art_1',
        version: 1,
        status: 'created',
      });

      const result = await service.submitArtifact(ctx, {
        taskId,
        type: 'doc',
        title: '需求文档',
        fileRef: '/tmp/opencode/req.md',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.worker.findUnique).toHaveBeenCalledWith({
        where: { id: workerId },
        select: { capabilities: true },
      });
      expect(workerClient.fetchFile).toHaveBeenCalledWith(
        {
          id: workerId,
          capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 },
        },
        '/tmp/opencode/req.md',
      );
      // 归档公共化：fileRef=fileRef 原文、storedUrl=落盘 URL、title=工具入参；category 缺省透传 undefined（未分类）
      expect(artifactsService.archiveFile).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          fileRef: '/tmp/opencode/req.md',
          storedUrl: expect.stringMatching(/^\/uploads\//),
          storedName: 'req.md',
          sha256: expect.any(String),
          title: '需求文档',
        }),
        undefined,
      );
      expect(result).toEqual({
        artifactId: 'art_1',
        version: 1,
        status: 'created',
      });
    });

    it('doc/file：同 sha256 已归档 → status: duplicate（archiveFile 幂等去重透传）', async () => {
      allowWorker();
      prisma.worker.findUnique.mockResolvedValue({ capabilities: {} });
      workerClient.fetchFile.mockResolvedValue(Buffer.from('重复内容'));
      artifactsService.archiveFile.mockResolvedValue({
        artifactId: 'art_existing',
        version: 1,
        status: 'duplicate',
      });

      const result = await service.submitArtifact(ctx, {
        taskId,
        type: 'file',
        title: '测试文件',
        fileRef: '/tmp/opencode/dup.txt',
        selfInstanceId: senderInstanceId,
      });

      expect(artifactsService.archiveFile).toHaveBeenCalled();
      expect(result).toEqual({
        artifactId: 'art_existing',
        version: 1,
        status: 'duplicate',
      });
    });

    it('doc/file：worker 不存在 → 404 PLATFORM_MCP_FILE_NOT_FOUND（不调用 fetchFile）', async () => {
      allowWorker();
      prisma.worker.findUnique.mockResolvedValue(null);

      await expectCode(
        service.submitArtifact(ctx, {
          taskId,
          type: 'file',
          title: 'x',
          fileRef: '/tmp/opencode/x.txt',
          selfInstanceId: senderInstanceId,
        }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.FILE_NOT_FOUND,
      );
      expect(workerClient.fetchFile).not.toHaveBeenCalled();
    });

    it('doc/file：worker 拉取失败 → 上抛 WorkerUnavailableException（提交失败必须让调用方知道）', async () => {
      allowWorker();
      prisma.worker.findUnique.mockResolvedValue({ capabilities: {} });
      workerClient.fetchFile.mockRejectedValue(
        new WorkerUnavailableException(workerId, 'file fetch HTTP 404'),
      );

      await expect(
        service.submitArtifact(ctx, {
          taskId,
          type: 'doc',
          title: 'x',
          fileRef: '/tmp/opencode/missing.txt',
          selfInstanceId: senderInstanceId,
        }),
      ).rejects.toBeInstanceOf(WorkerUnavailableException);
    });

    it('归属校验失败 → 403 PLATFORM_MCP_FORBIDDEN（不触达 append/拉取）', async () => {
      denyWorker();
      await expectCode(
        service.submitArtifact(ctx, {
          taskId,
          type: 'text',
          title: 'x',
          content: 'c',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(artifactsService.append).not.toHaveBeenCalled();
    });
  });

  describe('issue_*（issue 协作工具）', () => {
    const issueDto = {
      id: 'is_0000000001',
      taskId,
      taskTitle: '测试任务',
      title: '需求 issue',
      description: null,
      status: 'open',
      tags: ['需求'],
      assigneeAgentId: null,
      assigneeAgentName: null,
      assigneeUserId: null,
      assigneeUserName: null,
      creatorAgentId: senderAgentId,
      creatorAgentName: '测试 Agent',
      creatorUserId: null,
      creatorUserName: null,
      createdAt: '2026-08-13T00:00:00.000Z',
      resolvedAt: null,
      closedAt: null,
    };

    it('issue_create：三参数归属校验通过 → 调 createByAgent（assigneeInstanceId 透传）→ 返回 issue DTO', async () => {
      allowWorker();
      issuesService.createByAgent.mockResolvedValue(issueDto);

      const out = await service.issueCreate(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        title: '需求 issue',
        tags: ['需求'],
        assigneeInstanceId: 'tmm_tester',
      });

      expect(issuesService.createByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        taskId,
        expect.objectContaining({
          taskId,
          title: '需求 issue',
          tags: ['需求'],
          assigneeInstanceId: 'tmm_tester',
        }),
      );
      expect(out).toEqual(issueDto);
    });

    it('issue_create：归属校验失败（无会话）→ 403，不触达 createByAgent', async () => {
      denyWorker();
      await expectCode(
        service.issueCreate(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          title: 'x',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(issuesService.createByAgent).not.toHaveBeenCalled();
    });

    it('issue_list：三参数归属校验 → findAllByAgent（selfInstanceId/taskId/status 透传）', async () => {
      allowWorker();
      issuesService.findAllByAgent.mockResolvedValue([issueDto]);

      const out = await service.issueList(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        status: 'open',
      });

      expect(issuesService.findAllByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        taskId,
        'open',
      );
      expect(out).toEqual([issueDto]);
    });

    it('issue_get：三参数归属校验 → findOneByAgent（issueId 透传）', async () => {
      allowWorker();
      issuesService.findOneByAgent.mockResolvedValue(issueDto);

      const out = await service.issueGet(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        issueId: 'is_0000000001',
      });

      expect(issuesService.findOneByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        taskId,
        'is_0000000001',
      );
      expect(out).toEqual(issueDto);
    });

    it('issue_update：三参数归属校验 → updateByAgent（部分字段透传）', async () => {
      allowWorker();
      issuesService.updateByAgent.mockResolvedValue({
        ...issueDto,
        title: '改名',
      });

      const out = await service.issueUpdate(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        issueId: 'is_0000000001',
        title: '改名',
      });

      expect(issuesService.updateByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        taskId,
        'is_0000000001',
        expect.objectContaining({ title: '改名' }),
      );
      expect(out).toMatchObject({ title: '改名' });
    });

    it('issue_transition：三参数归属校验 → transitionByAgent（action 透传）', async () => {
      allowWorker();
      issuesService.transitionByAgent.mockResolvedValue({
        ...issueDto,
        status: 'in_progress',
      });

      const out = await service.issueTransition(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        issueId: 'is_0000000001',
        action: 'start',
      });

      expect(issuesService.transitionByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        taskId,
        'is_0000000001',
        'start',
        undefined,
      );
      expect(out).toMatchObject({ status: 'in_progress' });
    });

    it('issue_transition：reject 携带 reason 透传（is_0000000013）', async () => {
      allowWorker();
      issuesService.transitionByAgent.mockResolvedValue({
        ...issueDto,
        status: 'rejected',
        rejectReason: '原因',
      });

      const out = await service.issueTransition(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        issueId: 'is_0000000001',
        action: 'reject',
        reason: '原因',
      });

      expect(issuesService.transitionByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        taskId,
        'is_0000000001',
        'reject',
        '原因',
      );
      expect(out).toMatchObject({ status: 'rejected', rejectReason: '原因' });
    });

    it('issue_transition：归属校验失败（selfInstanceId 冒充）→ 403，不触达 transitionByAgent', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_1',
        agentId: 'a_other',
        teamMemberId: 'tmm_other',
      });
      await expectCode(
        service.issueTransition(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          issueId: 'is_0000000001',
          action: 'start',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(issuesService.transitionByAgent).not.toHaveBeenCalled();
    });
  });

  describe('task_transition（任务状态流转，仅主 Agent）', () => {
    const taskDto = {
      id: taskId,
      title: '任务标题',
      status: 'in_progress',
    };

    it('主实例放行：三参数归属校验 → transitionByAgent（taskId/selfInstanceId/action 透传，无 reason 传 undefined）', async () => {
      allowWorker();
      tasksService.transitionByAgent.mockResolvedValue(taskDto);

      const out = await service.taskTransition(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        action: 'start',
      });

      expect(tasksService.transitionByAgent).toHaveBeenCalledWith(
        taskId,
        senderInstanceId,
        'start',
        undefined,
      );
      expect(out).toMatchObject({ status: 'in_progress' });
    });

    it('reject 带 reason：归一为 {reason} 传入 transitionByAgent', async () => {
      allowWorker();
      tasksService.transitionByAgent.mockResolvedValue(taskDto);

      await service.taskTransition(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        action: 'reject',
        reason: '测试结论缺失',
      });

      expect(tasksService.transitionByAgent).toHaveBeenCalledWith(
        taskId,
        senderInstanceId,
        'reject',
        { reason: '测试结论缺失' },
      );
    });

    it('归属校验失败（selfInstanceId 冒充）→ 403，不触达 transitionByAgent', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_1',
        agentId: 'a_other',
        teamMemberId: 'tmm_other',
      });
      await expectCode(
        service.taskTransition(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          action: 'start',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(tasksService.transitionByAgent).not.toHaveBeenCalled();
    });

    it('accept → 403 TASK_AGENT_COMPLETION_FORBIDDEN，不触达 transitionByAgent', async () => {
      await expectCode(
        service.taskTransition(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          action: 'accept',
        }),
        ForbiddenException,
        'TASK_AGENT_COMPLETION_FORBIDDEN',
      );
      expect(tasksService.transitionByAgent).not.toHaveBeenCalled();
    });

    it('archive → 403 TASK_AGENT_COMPLETION_FORBIDDEN，不触达 transitionByAgent', async () => {
      await expectCode(
        service.taskTransition(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          action: 'archive',
        }),
        ForbiddenException,
        'TASK_AGENT_COMPLETION_FORBIDDEN',
      );
      expect(tasksService.transitionByAgent).not.toHaveBeenCalled();
    });

    it('TasksService 拒绝非主实例（403 TASK_STATUS_MAIN_AGENT_ONLY）→ 异常向上传播', async () => {
      allowWorker();
      tasksService.transitionByAgent.mockRejectedValue(
        new ForbiddenException({
          code: 'TASK_STATUS_MAIN_AGENT_ONLY',
          message:
            '仅主 Agent（ta_0000000001）可流转任务状态；请知会主 Agent 调用 task_transition，或由管理员在任务管理界面操作',
        }),
      );

      await expectCode(
        service.taskTransition(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          action: 'start',
        }),
        ForbiddenException,
        'TASK_STATUS_MAIN_AGENT_ONLY',
      );
      expect(tasksService.transitionByAgent).toHaveBeenCalledWith(
        taskId,
        senderInstanceId,
        'start',
        undefined,
      );
    });
  });

  describe('memory_save / memory_search（记忆存取，memory-management Todo 2）', () => {
    const taskTeamId = 'tm_0000000001';
    const taskRow = (overrides: Record<string, unknown> = {}) => ({
      teamId: taskTeamId,
      mainAgentInstanceId: senderInstanceId,
      ...overrides,
    });

    describe('memory_save', () => {
      it('Todo9 任务级记忆已删除：任务上下文 level=task → 400 MEMORY_LEVEL_INVALID（不落库）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        await expectCode(
          service.memorySave(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'task' as never,
            content: '结论：改用 Prisma 事务',
            tags: ['结论'],
          }),
          BadRequestException,
          PLATFORM_MCP_ERRORS.MEMORY_LEVEL_INVALID,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('description 直通：模型携带 description 优先落库，否则回落 content 截断', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        idGen.nextId.mockResolvedValue('me_0000000002');
        prisma.memory.create.mockResolvedValue({
          id: 'me_0000000002',
          level: 'team',
        } as any);
        await service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'team',
          content: '长内容'.repeat(100),
          description: 'token刷新踩坑',
        });
        expect(prisma.memory.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ description: 'token刷新踩坑' }),
          }),
        );
      });

      it('冒充 403：selfInstanceId 不在活跃集合且无绑定会话 → PLATFORM_MCP_FORBIDDEN，不触达 memory.create', async () => {
        denyWorker();
        await expectCode(
          service.memorySave(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'team',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('非法 level 400：zod safeParse 失败路径（controller 层 tools/call 拦截）', () => {
        expect(
          memorySaveSchema.safeParse({
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'bogus',
            content: 'x',
          }).success,
        ).toBe(false);
        expect(
          memorySaveSchema.safeParse({
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'team',
            content: '',
          }).success,
        ).toBe(false);
      });

      it('level=team 通过 zod，level=task/project 被拒（仅 team/global，400 前置）', () => {
        expect(
          memorySaveSchema.safeParse({
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'team',
            content: 'x',
          }).success,
        ).toBe(true);
        expect(
          memorySaveSchema.safeParse({
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'project',
            content: 'x',
          }).success,
        ).toBe(false);
        expect(
          memorySaveSchema.safeParse({
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'task' as never,
            content: 'x',
          }).success,
        ).toBe(false);
      });

      it('level=global 非主 Agent 403：team.mainAgentMemberId 与 selfInstanceId 不一致 → PLATFORM_MCP_FORBIDDEN（防全局污染）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: 'tmm_other',
        });
        await expectCode(
          service.memorySave(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'global',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('level=global 主 Agent 可写：taskId/teamId 均不落库（null）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: senderInstanceId,
        });
        idGen.nextId.mockResolvedValue('me_0000000002');
        prisma.memory.create.mockResolvedValue({
          id: 'me_0000000002',
          level: 'global',
        });

        const out = await service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'global',
          content: '平台通用约定',
        });

        expect(prisma.memory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            level: 'global',
            taskId: null,
            teamId: null,
            createdBy: senderInstanceId,
          }),
        });
        expect(out).toEqual({
          memoryId: 'me_0000000002',
          level: 'global',
          status: 'created',
        });
      });

      it('level=team 任务上下文：teamId 从 task 行反查落库，taskId 置空', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        idGen.nextId.mockResolvedValue('me_0000000003');
        prisma.memory.create.mockResolvedValue({
          id: 'me_0000000003',
          level: 'team',
        });

        const out = await service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'team',
          content: '团队级经验',
        });

        expect(prisma.memory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            level: 'team',
            taskId: null,
            teamId: taskTeamId,
          }),
        });
        expect(out).toEqual({
          memoryId: 'me_0000000003',
          level: 'team',
          status: 'created',
        });
      });

      it('level=team 但任务无团队归属 → 403（归属门先于级别校验，不落库）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow({ teamId: null }));
        await expectCode(
          service.memorySave(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'team',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('level=project 已下线 → 400 MEMORY_INVALID（不落库，防绕过 schema 直调）', async () => {
        allowWorker();
        await expectCode(
          service.memorySave(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'project' as never,
            content: 'x',
          }),
          BadRequestException,
          PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('任务不存在 → 404 PLATFORM_MCP_TASK_NOT_FOUND（不落库）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(null);
        await expectCode(
          service.memorySave(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'team',
            content: 'x',
          }),
          NotFoundException,
          PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('精确去重（任务上下文）：同级同团队同 contentHash 已存在 → status=duplicate，不落库', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findFirst.mockResolvedValue({
          id: 'me_0000000007',
        } as never);

        const out = await service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'team',
          content: '  团队级经验  ',
        });

        expect(prisma.memory.findFirst).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            level: 'team',
            teamId: taskTeamId,
            contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          select: { id: true },
        });
        expect(prisma.memory.create).not.toHaveBeenCalled();
        expect(out).toEqual({
          memoryId: 'me_0000000007',
          level: 'team',
          status: 'duplicate',
        });
      });

      it('精确去重归一化：首尾空白/CRLF 差异命中同一去重键（不落库）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findFirst.mockResolvedValue({
          id: 'me_0000000008',
        } as never);

        const out = await service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'team',
          content: '团队级经验\r\n',
        });

        expect(prisma.memory.create).not.toHaveBeenCalled();
        expect(out.status).toBe('duplicate');
        expect(out.memoryId).toBe('me_0000000008');
      });

      it('精确去重（团队上下文）：global 级按 teamId=null 命中 → duplicate', async () => {
        prisma.session.findFirst.mockResolvedValue({
          id: 's_team',
          teamMemberId: 'tmm_1',
        });
        prisma.team.findUnique.mockResolvedValue({
          id: 'tm_1',
          name: 'T1',
          mainAgentMemberId: 'tmm_1',
        });
        prisma.memory.findFirst.mockResolvedValue({
          id: 'me_0000000009',
        } as never);

        const out = await service.memorySave(ctx, {
          teamId: 'tm_1',
          selfInstanceId: 'tmm_1',
          level: 'global',
          content: '平台通用约定',
        });

        expect(prisma.memory.findFirst).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            level: 'global',
            teamId: null,
            contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          select: { id: true },
        });
        expect(prisma.memory.create).not.toHaveBeenCalled();
        expect(out).toEqual({
          memoryId: 'me_0000000009',
          level: 'global',
          status: 'duplicate',
        });
      });

      it('新建落库携带 contentHash（sha256 hex，去重键与正文一致）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findFirst.mockResolvedValue(null);
        idGen.nextId.mockResolvedValue('me_0000000011');
        prisma.memory.create.mockResolvedValue({
          id: 'me_0000000011',
          level: 'team',
        } as never);

        const out = await service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'team',
          content: '全新经验',
        });

        expect(prisma.memory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        });
        expect(out.status).toBe('created');
      });
    });

    describe('memory_update（T4：按 id+团队归属鉴权更新）', () => {
      const memoryRow = (overrides: Record<string, unknown> = {}) => ({
        id: 'me_0000000001',
        level: 'team',
        taskId: null,
        teamId: taskTeamId,
        content: '旧经验',
        description: '旧摘要',
        tags: null,
        createdBy: senderInstanceId,
        deletedAt: null,
        ...overrides,
      });

      it('冒充 403：无会话归属 → PLATFORM_MCP_FORBIDDEN，不读行不更新', async () => {
        denyWorker();
        await expectCode(
          service.memoryUpdate(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_0000000001',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.findUnique).not.toHaveBeenCalled();
        expect(prisma.memory.update).not.toHaveBeenCalled();
      });

      it('条目不存在 → 404 MEMORY_NOT_FOUND（不更新）', async () => {
        allowWorker();
        prisma.memory.findUnique.mockResolvedValue(null);
        await expectCode(
          service.memoryUpdate(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_missing',
            content: 'x',
          }),
          NotFoundException,
          'MEMORY_NOT_FOUND',
        );
        expect(prisma.memory.update).not.toHaveBeenCalled();
      });

      it('已软删条目 → 404 MEMORY_NOT_FOUND（不更新）', async () => {
        allowWorker();
        prisma.memory.findUnique.mockResolvedValue(
          memoryRow({ deletedAt: new Date('2026-08-10T00:00:00Z') }),
        );
        await expectCode(
          service.memoryUpdate(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_0000000001',
            content: 'x',
          }),
          NotFoundException,
          'MEMORY_NOT_FOUND',
        );
        expect(prisma.memory.update).not.toHaveBeenCalled();
      });

      it('跨团队 403：行 teamId ≠ 执行任务所属团队 → PLATFORM_MCP_FORBIDDEN（不更新）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findUnique.mockResolvedValue(
          memoryRow({ teamId: 'tm_other' }),
        );
        await expectCode(
          service.memoryUpdate(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_0000000001',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.update).not.toHaveBeenCalled();
      });

      it('跨团队 403（团队上下文）：行 teamId ≠ 传入 teamId → PLATFORM_MCP_FORBIDDEN', async () => {
        prisma.session.findFirst.mockResolvedValue({
          id: 's_team',
          teamMemberId: 'tmm_1',
        });
        prisma.memory.findUnique.mockResolvedValue(
          memoryRow({ teamId: 'tm_other' }),
        );
        await expectCode(
          service.memoryUpdate(ctx, {
            teamId: 'tm_1',
            selfInstanceId: 'tmm_1',
            memoryId: 'me_0000000001',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.update).not.toHaveBeenCalled();
      });

      it('global 行非主成员 403：执行团队主成员 ≠ 调用方 → PLATFORM_MCP_FORBIDDEN', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findUnique.mockResolvedValue(
          memoryRow({ level: 'global', teamId: null }),
        );
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: 'tmm_other',
        });
        await expectCode(
          service.memoryUpdate(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_0000000001',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.update).not.toHaveBeenCalled();
      });

      it('global 行主成员可改：更新 content 并同步重算 contentHash', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findUnique.mockResolvedValue(
          memoryRow({ level: 'global', teamId: null }),
        );
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: senderInstanceId,
        });
        prisma.memory.update.mockResolvedValue({
          id: 'me_0000000001',
          level: 'global',
        } as never);

        const out = await service.memoryUpdate(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          memoryId: 'me_0000000001',
          content: '新版平台约定',
        });

        expect(prisma.memory.update).toHaveBeenCalledWith({
          where: { id: 'me_0000000001' },
          data: expect.objectContaining({
            content: '新版平台约定',
            contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        });
        expect(out).toEqual({
          memoryId: 'me_0000000001',
          level: 'global',
          status: 'updated',
        });
      });

      it('team 行同团队部分更新：仅 description 时不碰 contentHash', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findUnique.mockResolvedValue(memoryRow());
        prisma.memory.update.mockResolvedValue({
          id: 'me_0000000001',
          level: 'team',
        } as never);

        const out = await service.memoryUpdate(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          memoryId: 'me_0000000001',
          description: '新摘要',
        });

        expect(prisma.memory.update).toHaveBeenCalledWith({
          where: { id: 'me_0000000001' },
          data: { description: '新摘要' },
        });
        expect(out.status).toBe('updated');
      });

      it('全空 400：content/description/tags 均缺省 → PLATFORM_MCP_MEMORY_INVALID（不更新）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findUnique.mockResolvedValue(memoryRow());
        await expectCode(
          service.memoryUpdate(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_0000000001',
          }),
          BadRequestException,
          PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        );
        expect(prisma.memory.update).not.toHaveBeenCalled();
      });

      it('空 content 400：空字串/空白 → PLATFORM_MCP_MEMORY_INVALID（不更新，防空覆盖）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        prisma.memory.findUnique.mockResolvedValue(memoryRow());
        await expectCode(
          service.memoryUpdate(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_0000000001',
            content: '   ',
          }),
          BadRequestException,
          PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        );
        expect(prisma.memory.update).not.toHaveBeenCalled();
      });

      it('schema 前置：memoryId 必填 + content/description/tags 至少一个（tools/call -32602 路径）', () => {
        expect(
          memoryUpdateSchema.safeParse({
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_1',
            content: 'x',
          }).success,
        ).toBe(true);
        expect(
          memoryUpdateSchema.safeParse({
            taskId,
            selfInstanceId: senderInstanceId,
            memoryId: 'me_1',
          }).success,
        ).toBe(false);
        expect(
          memoryUpdateSchema.safeParse({
            taskId,
            selfInstanceId: senderInstanceId,
            content: 'x',
          }).success,
        ).toBe(false);
      });
    });

    describe('memory_search', () => {
      /** 团队维度归属通过：该 worker 有该团队会话（绑定成员 tmm_1，主成员同值）。 */
      const allowTeamWorker = (memberId = 'tmm_1', mainId = 'tmm_1') => {
        prisma.session.findFirst.mockResolvedValue({
          id: 's_team',
          teamMemberId: memberId,
        });
        prisma.team.findUnique.mockResolvedValue({
          id: 'tm_1',
          name: 'T1',
          mainAgentMemberId: mainId,
        });
        prisma.teamMember.findFirst.mockResolvedValue({
          agentId: 'a_1',
          alias: 'M1',
        });
        prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      };

      it('团队上下文 level=team 直接落 teamId（createdBy=团队成员 id）', async () => {
        allowTeamWorker();
        idGen.nextId.mockResolvedValue('me_0000000010');
        prisma.memory.create.mockResolvedValue({
          id: 'me_0000000010',
          level: 'team',
        });

        const out = await service.memorySave(ctx, {
          teamId: 'tm_1',
          selfInstanceId: 'tmm_1',
          level: 'team',
          content: '团队经验',
        });

        expect(prisma.memory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            level: 'team',
            taskId: null,
            teamId: 'tm_1',
            createdBy: 'tmm_1',
            sourceInstanceId: 'tmm_1',
            sourceType: 'agent',
          }),
        });
        expect(out).toEqual({
          memoryId: 'me_0000000010',
          level: 'team',
          status: 'created',
        });
      });

      it('团队上下文 level=global 非主成员 → 403（主 Agent 门保留）', async () => {
        allowTeamWorker('tmm_2', 'tmm_main');
        await expectCode(
          service.memorySave(ctx, {
            teamId: 'tm_1',
            selfInstanceId: 'tmm_2',
            level: 'global',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('团队上下文 level=task → 400 MEMORY_LEVEL_INVALID（任务级记忆已删除）', async () => {
        allowTeamWorker();
        await expectCode(
          service.memorySave(ctx, {
            teamId: 'tm_1',
            selfInstanceId: 'tmm_1',
            level: 'task' as never,
            content: 'x',
          }),
          BadRequestException,
          PLATFORM_MCP_ERRORS.MEMORY_LEVEL_INVALID,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('跨团队 teamId 写入 → 403（无该团队会话，维度间无回退）', async () => {
        denyWorker();
        await expectCode(
          service.memorySave(ctx, {
            teamId: 'tm_other',
            selfInstanceId: 'tmm_1',
            level: 'team',
            content: 'x',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });

      it('Todo9 任务上下文 level=task → 400 MEMORY_LEVEL_INVALID（任务级记忆已删除，不触达 findMany）', async () => {
        allowWorker();
        await expectCode(
          service.memorySearch(ctx, { taskId, level: 'task' as never }),
          BadRequestException,
          PLATFORM_MCP_ERRORS.MEMORY_LEVEL_INVALID,
        );
        expect(prisma.memory.findMany).not.toHaveBeenCalled();
      });

      it('聚合 team+global 两级：OR 条件 + deletedAt null 过滤 + createdAt desc 排序', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ teamId: taskTeamId });
        prisma.memory.findMany.mockResolvedValue([
          {
            id: 'me_0000000002',
            level: 'global',
            content: '平台约定',
            tags: null,
            createdBy: 'tmm_main',
            createdAt: new Date('2026-08-08T00:00:02Z'),
          },
          {
            id: 'me_0000000001',
            level: 'team',
            content: '团队结论',
            tags: ['结论'],
            createdBy: senderInstanceId,
            createdAt: new Date('2026-08-08T00:00:01Z'),
          },
        ]);

        const out = await service.memorySearch(ctx, { taskId });

        expect(prisma.task.findUnique).toHaveBeenCalledWith({
          where: { id: taskId },
          select: { teamId: true },
        });
        expect(prisma.memory.findMany).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            OR: [{ level: 'team', teamId: taskTeamId }, { level: 'global' }],
          },
          orderBy: { createdAt: 'desc' },
        });
        expect(out).toEqual([
          {
            id: 'me_0000000002',
            level: 'global',
            content: '平台约定',
            description: null,
            tags: null,
            createdBy: 'tmm_main',
            createdAt: '2026-08-08T00:00:02.000Z',
            sourceAgentId: null,
            sourceInstanceId: null,
            sourceType: null,
            sessionId: null,
            sessionTitle: null,
            channelId: null,
          },
          {
            id: 'me_0000000001',
            level: 'team',
            content: '团队结论',
            description: null,
            tags: ['结论'],
            createdBy: senderInstanceId,
            createdAt: '2026-08-08T00:00:01.000Z',
            sourceAgentId: null,
            sourceInstanceId: null,
            sourceType: null,
            sessionId: null,
            sessionTitle: null,
            channelId: null,
          },
        ]);
      });

      it('query → content/description OR contains 透传 prisma 层过滤', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ teamId: taskTeamId });
        prisma.memory.findMany.mockResolvedValue([]);

        await service.memorySearch(ctx, { taskId, query: '事务' });

        expect(prisma.memory.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              AND: expect.arrayContaining([
                expect.objectContaining({ OR: expect.any(Array) }),
                expect.objectContaining({
                  OR: [
                    { content: { contains: '事务' } },
                    { description: { contains: '事务' } },
                  ],
                }),
              ]),
            }),
          }),
        );
      });

      it('tags 内存过滤（须包含全部查询标签）+ limit 截断', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ teamId: taskTeamId });
        prisma.memory.findMany.mockResolvedValue([
          {
            id: 'me_1',
            level: 'team',
            content: 'A',
            tags: ['x', 'y'],
            createdBy: 'a',
            createdAt: new Date('2026-08-08T00:00:03Z'),
          },
          {
            id: 'me_2',
            level: 'team',
            content: 'B',
            tags: ['x'],
            createdBy: 'a',
            createdAt: new Date('2026-08-08T00:00:02Z'),
          },
          {
            id: 'me_3',
            level: 'global',
            content: 'C',
            tags: ['x', 'y'],
            createdBy: 'm',
            createdAt: new Date('2026-08-08T00:00:01Z'),
          },
        ]);

        const out = await service.memorySearch(ctx, {
          taskId,
          tags: ['x', 'y'],
          limit: 2,
        });

        expect(out.map((r) => r.id)).toEqual(['me_1', 'me_3']);
      });

      it('level 入参收窄到单级：level=team 时 OR 仅含 team 分支', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ teamId: taskTeamId });
        prisma.memory.findMany.mockResolvedValue([]);

        await service.memorySearch(ctx, { taskId, level: 'team' });

        expect(prisma.memory.findMany).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            OR: [{ level: 'team', teamId: taskTeamId }],
          },
          orderBy: { createdAt: 'desc' },
        });
      });

      it('level=project 已下线 → 400 MEMORY_INVALID（不触达 findMany）', async () => {
        allowWorker();
        await expectCode(
          service.memorySearch(ctx, { taskId, level: 'project' as never }),
          BadRequestException,
          PLATFORM_MCP_ERRORS.MEMORY_INVALID,
        );
        expect(prisma.memory.findMany).not.toHaveBeenCalled();
      });

      it('任务不存在 → 404 PLATFORM_MCP_TASK_NOT_FOUND（不触达 findMany）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(null);
        await expectCode(
          service.memorySearch(ctx, { taskId }),
          NotFoundException,
          PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        );
        expect(prisma.memory.findMany).not.toHaveBeenCalled();
      });

      it('只读归属校验：无 Session → 403 PLATFORM_MCP_FORBIDDEN', async () => {
        denyWorker();
        await expectCode(
          service.memorySearch(ctx, { taskId }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
      });

      it('task 无 teamId + 显式 level=team → 归属门 403（不触达 findMany）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ teamId: null });

        await expectCode(
          service.memorySearch(ctx, { taskId, level: 'team' }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.findMany).not.toHaveBeenCalled();
      });

      it('task 无 teamId + level 未传 → 归属门 403（不触达 findMany）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ teamId: null });
        prisma.memory.findMany.mockResolvedValue([]);

        await expectCode(
          service.memorySearch(ctx, { taskId }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.findMany).not.toHaveBeenCalled();
      });

      it('团队上下文检索聚合 team+global 两级（teamId 精确匹配）', async () => {
        allowTeamWorker();
        prisma.memory.findMany.mockResolvedValue([]);

        await service.memorySearch(ctx, { teamId: 'tm_1' });

        expect(prisma.memory.findMany).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            OR: [{ level: 'team', teamId: 'tm_1' }, { level: 'global' }],
          },
          orderBy: { createdAt: 'desc' },
        });
      });

      it('团队上下文 level=team 收窄到单级', async () => {
        allowTeamWorker();
        prisma.memory.findMany.mockResolvedValue([]);

        await service.memorySearch(ctx, { teamId: 'tm_1', level: 'team' });

        expect(prisma.memory.findMany).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            OR: [{ level: 'team', teamId: 'tm_1' }],
          },
          orderBy: { createdAt: 'desc' },
        });
      });

      it('团队上下文 level=task → 400 MEMORY_LEVEL_INVALID（任务级记忆已删除）', async () => {
        allowTeamWorker();
        await expectCode(
          service.memorySearch(ctx, { teamId: 'tm_1', level: 'task' as never }),
          BadRequestException,
          PLATFORM_MCP_ERRORS.MEMORY_LEVEL_INVALID,
        );
        expect(prisma.memory.findMany).not.toHaveBeenCalled();
      });

      it('跨团队 teamId 检索 → 403（无该团队会话）', async () => {
        denyWorker();
        await expectCode(
          service.memorySearch(ctx, { teamId: 'tm_other' }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.memory.findMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('team_view / my_profile（团队感知，只读，tc-mcp-l1 Todo 3）', () => {
    const mainInstanceId = 'tmm_main';

    describe('team_view', () => {
      it('返回成员列表（含会话实时状态 sessionStatus/sessionId）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({
          id: taskId,
          teamId: 'tm_1',
        });
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: mainInstanceId,
        });
        prisma.teamMember.findMany.mockResolvedValue([
          {
            id: mainInstanceId,
            agentId: 'a_pm',
            alias: '项目经理-1',
            seq: 1,
            agent: { name: '项目经理' },
            role: { key: 'project_manager', name: '项目经理' },
          },
          {
            id: 'tmm_dev',
            agentId: 'a_dev',
            alias: '开发者-1',
            seq: 1,
            agent: { name: '开发者' },
            role: { key: 'developer', name: '开发者' },
          },
        ]);
        prisma.session.findMany.mockResolvedValue([
          { id: 's_1', status: 'running', teamMemberId: mainInstanceId },
        ]);
        const out = await service.teamView(ctx, { taskId });

        expect(prisma.session.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { teamId: 'tm_1', workerId },
          }),
        );
        expect(prisma.teamMember.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { teamId: 'tm_1' } }),
        );
        expect(prisma.session.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              teamMemberId: { in: [mainInstanceId, 'tmm_dev'] },
              status: { not: 'archived' },
            },
          }),
        );
        expect(out).toEqual({
          taskId,
          pendingReceipts: { pending: 0, total: 0 },
          members: [
            {
              id: mainInstanceId,
              agentId: 'a_pm',
              alias: '项目经理-1',
              role: 'project_manager',
              seq: 1,
              main: true,
              sessionStatus: 'running',
              sessionId: 's_1',
            },
            {
              id: 'tmm_dev',
              agentId: 'a_dev',
              alias: '开发者-1',
              role: 'developer',
              seq: 1,
              main: false,
              sessionStatus: null,
              sessionId: null,
            },
          ],
        });
      });

      it('无团队成员 → members 为空数组', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({
          id: taskId,
          teamId: 'tm_1',
        });
        prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
        prisma.teamMember.findMany.mockResolvedValue([]);
        const out = await service.teamView(ctx, { taskId });

        expect(out.members).toEqual([]);
      });

      it('任务不存在 → 404 PLATFORM_MCP_TASK_NOT_FOUND', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(null);
        await expectCode(
          service.teamView(ctx, { taskId }),
          NotFoundException,
          PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        );
        expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
      });

      it('只读归属校验：无 Session → 403 PLATFORM_MCP_FORBIDDEN', async () => {
        denyWorker();
        await expectCode(
          service.teamView(ctx, { taskId }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
      });
    });

    describe('my_profile', () => {
      const longPrompt = 'x'.repeat(600);
      const roleCapabilities = { 'chat.post': true, 'task.create': false };
      const agentRow = (overrides: Record<string, unknown> = {}) => ({
        id: senderInstanceId,
        teamId: 'tm_1',
        agentId: senderAgentId,
        alias: '开发者-1',
        seq: 1,
        workDir: '/data/vteam-worker/developer-1',
        agent: {
          id: senderAgentId,
          name: '开发者',
          prompt: longPrompt,
          defaultModelId: 'm_1',
          policyId: 'ep_developer',
        },
        role: {
          id: 'ar_developer',
          key: 'developer',
          name: '开发者',
          capabilities: roleCapabilities,
        },
        ...overrides,
      });

      it('返回自身配置：角色/effectivePermission（岗位能力矩阵）/模型 + prompt 摘要截断（前 500 字符）', async () => {
        allowWorker();
        prisma.teamMember.findFirst.mockResolvedValue(agentRow() as any);

        const out = await service.myProfile(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
        });

        expect(prisma.session.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { teamId: 'tm_1', workerId, teamMemberId: senderInstanceId },
          }),
        );
        expect(prisma.teamMember.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: senderInstanceId },
            select: expect.objectContaining({
              role: expect.objectContaining({
                select: expect.objectContaining({
                  id: true,
                  key: true,
                  capabilities: true,
                }),
              }),
            }),
          }),
        );
        expect(prisma.teamMember.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            select: expect.not.objectContaining({
              permissionScope: expect.anything(),
            }),
          }),
        );
        // capability model：my_profile 不再读 ExecutionPolicy（岗位能力矩阵即权威）。
        expect(executionPolicyService.resolveByRole).not.toHaveBeenCalled();
        expect(executionPolicyService.resolveByAgent).not.toHaveBeenCalled();
        expect(out).toEqual({
          taskId,
          instanceId: senderInstanceId,
          agentId: senderAgentId,
          name: '开发者',
          role: 'developer',
          alias: '开发者-1',
          seq: 1,
          workDir: '/data/vteam-worker/developer-1',
          defaultModelId: 'm_1',
          effectivePermission: {
            roleId: 'ar_developer',
            roleKey: 'developer',
            capabilities: roleCapabilities,
          },
          agentName: 'vteam-developer',
          promptSummary: 'x'.repeat(500),
          promptTruncated: true,
        });
      });

      it('prompt 长度 ≤500 → 原样返回 + promptTruncated=false', async () => {
        allowWorker();
        prisma.teamMember.findFirst.mockResolvedValue(
          agentRow({
            agent: {
              id: senderAgentId,
              name: '开发者',
              role: 'developer',
              prompt: '简短提示词',
              defaultModelId: null,
            },
          }),
        );

        const out = await service.myProfile(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
        });

        expect(out.promptSummary).toBe('简短提示词');
        expect(out.promptTruncated).toBe(false);
      });

      it('岗位 capabilities 为 NULL → effectivePermission.capabilities = {}（default-allow 语义）', async () => {
        allowWorker();
        prisma.teamMember.findFirst.mockResolvedValue(
          agentRow({
            role: {
              id: 'ar_custom',
              key: 'custom-x',
              name: '自定义',
              capabilities: null,
            },
          }),
        );

        const out = await service.myProfile(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
        });

        expect(out.effectivePermission).toEqual({
          roleId: 'ar_custom',
          roleKey: 'custom-x',
          capabilities: {},
        });
        expect(out.agentName).toBe('vteam-custom-x');
        expect(out).not.toHaveProperty('permissionScope');
        expect(out).not.toHaveProperty('toolEffects');
        expect(out).not.toHaveProperty('deprecated');
      });

      it('成员未绑角色 → effectivePermission=null（不读 Agent 策略）；role/agentName 回退', async () => {
        allowWorker();
        prisma.teamMember.findFirst.mockResolvedValue(
          agentRow({
            agent: {
              id: senderAgentId,
              name: '未命名',
              prompt: 'p',
              defaultModelId: null,
              policyId: 'ep_agent_deny',
            },
            role: null,
          }),
        );

        const out = await service.myProfile(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
        });

        expect(executionPolicyService.resolveByRole).not.toHaveBeenCalled();
        expect(executionPolicyService.resolveByAgent).not.toHaveBeenCalled();
        expect(out.effectivePermission).toBeNull();
        expect(out.role).toBeNull();
        expect(out.agentName).toBe('vteam-plan');
      });

      it('自定义岗位 → effectivePermission 暴露岗位能力矩阵；执行 Agent 策略不参与', async () => {
        allowWorker();
        prisma.teamMember.findFirst.mockResolvedValue(
          agentRow({
            agent: {
              id: senderAgentId,
              name: '数据分析师',
              agentKey: 'data-analyst',
              prompt: 'p',
              defaultModelId: null,
              policyId: 'ep_0000000009',
            },
            role: {
              id: 'ar_c_data',
              key: 'data-analyst',
              name: '数据分析师',
              capabilities: { 'doc.read': true, 'skill.create': false },
            },
          }),
        );

        const out = await service.myProfile(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
        });

        expect(executionPolicyService.resolveByRole).not.toHaveBeenCalled();
        expect(executionPolicyService.resolveByAgent).not.toHaveBeenCalled();
        expect(out.effectivePermission).toEqual({
          roleId: 'ar_c_data',
          roleKey: 'data-analyst',
          capabilities: { 'doc.read': true, 'skill.create': false },
        });
        expect(out.agentName).toBe('vteam-data-analyst');
      });

      it('突变检测：岗位能力矩阵与执行 Agent 策略冲突 → 岗位决定 effectivePermission', async () => {
        allowWorker();
        prisma.teamMember.findFirst.mockResolvedValue(
          agentRow({
            agent: {
              id: senderAgentId,
              name: '开发者',
              prompt: 'p',
              defaultModelId: null,
              policyId: 'ep_agent_deny',
            },
            role: {
              id: 'ar_developer',
              key: 'developer',
              name: '开发者',
              capabilities: { 'task.create': true, 'chat.post': false },
            },
          }),
        );

        const out = await service.myProfile(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
        });

        expect(executionPolicyService.resolveByRole).not.toHaveBeenCalled();
        expect(executionPolicyService.resolveByAgent).not.toHaveBeenCalled();
        expect(out.effectivePermission).toEqual({
          roleId: 'ar_developer',
          roleKey: 'developer',
          capabilities: { 'task.create': true, 'chat.post': false },
        });
      });

      it('实例不在任务团队 → 404 PLATFORM_MCP_TASK_NOT_FOUND', async () => {
        allowWorker();
        prisma.teamMember.findFirst.mockResolvedValue(null);
        await expectCode(
          service.myProfile(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
          }),
          NotFoundException,
          PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        );
      });

      it('归属 403：selfInstanceId 与 session.teamMemberId 不一致（防冒充）', async () => {
        prisma.session.findFirst.mockResolvedValue({
          id: 's_1',
          agentId: 'a_other',
          teamMemberId: 'tmm_other',
        });
        await expectCode(
          service.myProfile(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      });
    });
  });

  describe('team_add_member（成员申请增员确认门，L2 自治）', () => {
    const mainInstanceId = 'tmm_main';

    /** 主成员归属校验通过（session 绑定主成员）。 */
    const allowMainWorker = () => allowWorkerAs(mainInstanceId);

    /** 默认基线：主成员任务 + 目标 agent 存在 + 未加入 + 无 pending 申请。 */
    const mockBaseline = (
      opts: { existing?: unknown; pending?: unknown[] } = {},
    ) => {
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: mainInstanceId,
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_developer',
        name: '开发者',
        role: 'developer',
      });
      prisma.teamMember.findFirst.mockResolvedValue(opts.existing ?? null);
      prisma.agentQuestion.findMany.mockResolvedValue(opts.pending ?? []);
    };

    /** 捕获 createForPlatform 注册的 onResolved 钩子（teamAddMember 闭包）。 */
    const captureHook = () => {
      let hook:
        | ((args: {
            answers: string[][] | null;
            actor: { type: string; id: string };
          }) => Promise<void>)
        | null = null;
      questionsService.createForPlatform.mockImplementation(
        async (
          _taskId: string,
          _question: unknown,
          opts: {
            onResolved?: (args: {
              answers: string[][] | null;
              actor: { type: string; id: string };
            }) => Promise<void>;
          },
        ) => {
          hook = opts.onResolved ?? null;
          return { id: 'aq_1', requestId: 'que_platform_0000000001' };
        },
      );
      return () => hook;
    };

    it('非主成员不再被身份门拒绝 → 创建确认请求（原 403 已移除）', async () => {
      allowWorker();
      mockBaseline();
      questionsService.createForPlatform.mockResolvedValue({
        id: 'aq_1',
        requestId: 'que_platform_0000000001',
      });
      const result = await service.teamAddMember(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        agentId: 'a_developer',
      });
      expect(result).toMatchObject({
        requestId: 'que_platform_0000000001',
        taskId,
        agentId: 'a_developer',
      });
      expect(questionsService.createForPlatform).toHaveBeenCalledTimes(1);
    });

    it('申请成功：createForPlatform 创建确认请求（question 文案/options/onResolved 注册）→ 返回 requestId', async () => {
      allowMainWorker();
      mockBaseline();
      questionsService.createForPlatform.mockResolvedValue({
        id: 'aq_1',
        requestId: 'que_platform_0000000001',
      });

      const result = await service.teamAddMember(ctx, {
        taskId,
        selfInstanceId: mainInstanceId,
        agentId: 'a_developer',
        alias: '开发者-2',
        workDir: '/data/vteam-worker/dev2',
      });

      expect(questionsService.createForPlatform).toHaveBeenCalledWith(
        taskId,
        {
          question: '申请将 开发者（别名 开发者-2）加入团队，是否确认？',
          header: '团队增员确认',
          options: ['确认', '拒绝'],
        },
        expect.objectContaining({
          agentId: 'a_developer',
          requesterInstanceId: mainInstanceId,
          onResolved: expect.any(Function),
        }),
      );
      expect(result).toEqual({
        requestId: 'que_platform_0000000001',
        taskId,
        agentId: 'a_developer',
        alias: '开发者-2',
      });
    });

    it('无 alias → 申请文案不含「（别名 xxx）」', async () => {
      allowMainWorker();
      mockBaseline();
      questionsService.createForPlatform.mockResolvedValue({
        id: 'aq_1',
        requestId: 'que_platform_0000000001',
      });

      await service.teamAddMember(ctx, {
        taskId,
        selfInstanceId: mainInstanceId,
        agentId: 'a_developer',
      });

      expect(questionsService.createForPlatform).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          question: '申请将 开发者 加入团队，是否确认？',
        }),
        expect.any(Object),
      );
    });

    it('重复加入（该 agent 已在团队）→ 400 AGENT_ALREADY_IN_TEAM（不创建确认请求）', async () => {
      allowMainWorker();
      mockBaseline({ existing: { id: 'ta_existing' } });
      await expectCode(
        service.teamAddMember(ctx, {
          taskId,
          selfInstanceId: mainInstanceId,
          agentId: 'a_developer',
        }),
        BadRequestException,
        PLATFORM_MCP_ERRORS.AGENT_ALREADY_IN_TEAM,
      );
      expect(questionsService.createForPlatform).not.toHaveBeenCalled();
    });

    it('pending 重复申请 → 409 PENDING_APPLICATION（等待确认中）', async () => {
      allowMainWorker();
      mockBaseline({
        pending: [
          {
            requestId: 'que_platform_0000000001',
            content: {
              source: 'platform',
              action: 'team_add_member',
              agentId: 'a_developer',
            },
          },
        ],
      });
      await expectCode(
        service.teamAddMember(ctx, {
          taskId,
          selfInstanceId: mainInstanceId,
          agentId: 'a_developer',
        }),
        ConflictException,
        PLATFORM_MCP_ERRORS.PENDING_APPLICATION,
      );
      expect(questionsService.createForPlatform).not.toHaveBeenCalled();
    });

    it('pending 但非本 agent 申请 → 不冲突（继续创建）', async () => {
      allowMainWorker();
      mockBaseline({
        pending: [
          {
            requestId: 'que_platform_0000000002',
            content: {
              source: 'platform',
              action: 'team_add_member',
              agentId: 'a_tester',
            },
          },
        ],
      });
      questionsService.createForPlatform.mockResolvedValue({
        id: 'aq_1',
        requestId: 'que_platform_0000000001',
      });

      await service.teamAddMember(ctx, {
        taskId,
        selfInstanceId: mainInstanceId,
        agentId: 'a_developer',
      });
      expect(questionsService.createForPlatform).toHaveBeenCalled();
    });

    it('确认回调（answers=[["确认"]]，用户确认）→ updateTeam 调用 + user 审计参数', async () => {
      allowMainWorker();
      mockBaseline();
      const getHook = captureHook();
      await service.teamAddMember(ctx, {
        taskId,
        selfInstanceId: mainInstanceId,
        agentId: 'a_developer',
        alias: '开发者-2',
      });

      await getHook()!({
        answers: [['确认']],
        actor: { type: 'user', id: 'u_1' },
      });

      expect(tasksService.updateTeam).toHaveBeenCalledWith(
        taskId,
        { addInstances: [{ agentId: 'a_developer', alias: '开发者-2' }] },
        'u_1',
        { actorType: 'user', actorId: 'u_1', confirmedBy: '用户' },
      );
    });

    it('主 Agent 确认（actor=agent/主实例）→ updateTeam 审计传 agent/主实例', async () => {
      allowMainWorker();
      mockBaseline();
      const getHook = captureHook();
      await service.teamAddMember(ctx, {
        taskId,
        selfInstanceId: mainInstanceId,
        agentId: 'a_developer',
      });

      await getHook()!({
        answers: [['确认']],
        actor: { type: 'agent', id: mainInstanceId },
      });

      expect(tasksService.updateTeam).toHaveBeenCalledWith(
        taskId,
        { addInstances: [{ agentId: 'a_developer' }] },
        undefined,
        {
          actorType: 'agent',
          actorId: mainInstanceId,
          confirmedBy: '主 Agent',
        },
      );
    });

    it('拒绝（answers=null）→ 不执行（updateTeam 不调用）', async () => {
      allowMainWorker();
      mockBaseline();
      const getHook = captureHook();
      await service.teamAddMember(ctx, {
        taskId,
        selfInstanceId: mainInstanceId,
        agentId: 'a_developer',
      });

      await getHook()!({ answers: null, actor: { type: 'user', id: 'u_1' } });

      expect(tasksService.updateTeam).not.toHaveBeenCalled();
    });

    it('确认回调但任务已终态（updateTeam 409）→ 显式记录并忽略（不向上抛）', async () => {
      allowMainWorker();
      mockBaseline();
      const getHook = captureHook();
      await service.teamAddMember(ctx, {
        taskId,
        selfInstanceId: mainInstanceId,
        agentId: 'a_developer',
      });

      tasksService.updateTeam.mockRejectedValue(
        new ConflictException({ code: 'TASK_TEAM_NOT_ALLOWED' }),
      );
      await expect(
        getHook()!({ answers: [['确认']], actor: { type: 'user', id: 'u_1' } }),
      ).resolves.toBeUndefined();
    });
  });

  describe('plan_complete（标记计划执行完成，仅主 Agent 可调）', () => {
    const mainInstanceId = 'tmm_main';
    const ctx = { workerId: 'w_1' } as any;

    const mockGate = (mainId: string | null) => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: mainId });
    };

    const mockLifecycle = (result: {
      plan: { status: string };
      idempotent: boolean;
    }) => {
      const completePlan = jest.fn().mockResolvedValue(result);
      (service as any).planLifecycle = { completePlan };
      return completePlan;
    };

    it('主实例 + executing → 成功，返回 status:completed，completePlan 以 instanceId=selfInstanceId 调用', async () => {
      allowWorkerAs(mainInstanceId);
      mockGate(mainInstanceId);
      const completePlan = mockLifecycle({
        plan: { status: 'completed' },
        idempotent: false,
      });

      const out = await service.planComplete(ctx, {
        taskId: 't_1',
        selfInstanceId: mainInstanceId,
      });

      expect(completePlan).toHaveBeenCalledWith('t_1', {
        userId: mainInstanceId,
        userName: null,
        instanceId: mainInstanceId,
      });
      expect(out).toEqual({
        taskId: 't_1',
        status: 'completed',
        idempotent: false,
      });
    });

    it('非主实例不再被身份门拒绝 → 触达 completePlan（原 403 已移除）', async () => {
      allowWorkerAs('tmm_other');
      mockGate(mainInstanceId);
      const completePlan = mockLifecycle({
        plan: { status: 'completed' },
        idempotent: false,
      });

      const out = await service.planComplete(ctx, {
        taskId: 't_1',
        selfInstanceId: 'tmm_other',
      });

      expect(completePlan).toHaveBeenCalledWith('t_1', {
        userId: 'tmm_other',
        userName: null,
        instanceId: 'tmm_other',
      });
      expect(out).toEqual({
        taskId: 't_1',
        status: 'completed',
        idempotent: false,
      });
    });

    it('planLifecycle 缺失（null）→ 503', async () => {
      allowWorkerAs(mainInstanceId);
      mockGate(mainInstanceId);
      (service as any).planLifecycle = undefined;

      await expect(
        service.planComplete(ctx, {
          taskId: 't_1',
          selfInstanceId: mainInstanceId,
        }),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  describe('channel_send（通知渠道推送，T12）', () => {
    it('成功：解析当前任务上下文并调用 outboundDispatcher → 返回已发送文本，不抛异常', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
      prisma.session.findFirst.mockResolvedValueOnce({
        taskId,
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      prisma.session.findFirst.mockResolvedValueOnce({
        id: 's_1',
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      outboundDispatcher.sendToChannelByIdOrName.mockResolvedValue(undefined);

      const result = await service.channelSend(ctx, {
        target: 'nc_0000000001',
        text: 'hello world',
      });

      expect(outboundDispatcher.sendToChannelByIdOrName).toHaveBeenCalledWith(
        taskId,
        'nc_0000000001',
        'hello world',
      );
      expect(result).toEqual({
        content: [
          { type: 'text', text: '已发送至渠道 nc_0000000001: hello world' },
        ],
        isError: false,
      });
    });

    it('成功：长文本截断预览 100 字符', async () => {
      const longText = 'a'.repeat(150);
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
      prisma.session.findFirst.mockResolvedValueOnce({
        taskId,
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      prisma.session.findFirst.mockResolvedValueOnce({
        id: 's_1',
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      outboundDispatcher.sendToChannelByIdOrName.mockResolvedValue(undefined);

      const result = await service.channelSend(ctx, {
        target: 'my-webhook',
        text: longText,
      });

      expect(result.content[0].text).toBe(
        `已发送至渠道 my-webhook: ${'a'.repeat(100)}`,
      );
      expect(result.isError).toBe(false);
    });

    it('失败：dispatcher 抛 channel not found → 返回 发送失败: xxx, isError false, 不抛异常', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
      prisma.session.findFirst.mockResolvedValueOnce({
        taskId,
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      prisma.session.findFirst.mockResolvedValueOnce({
        id: 's_1',
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      outboundDispatcher.sendToChannelByIdOrName.mockRejectedValue(
        new NotFoundException('channel not found: missing'),
      );

      const result = await service.channelSend(ctx, {
        target: 'missing',
        text: 'hi',
      });

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toMatch(/发送失败:.*channel not found/);
    });

    it('失败：direction 不支持 outbound → 返回 发送失败: channel direction does not support outbound', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
      prisma.session.findFirst.mockResolvedValueOnce({
        taskId,
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      prisma.session.findFirst.mockResolvedValueOnce({
        id: 's_1',
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      outboundDispatcher.sendToChannelByIdOrName.mockRejectedValue(
        new ForbiddenException('channel direction does not support outbound'),
      );

      const result = await service.channelSend(ctx, {
        target: 'nc_in_only',
        text: 'hi',
      });

      expect(result.content[0].text).toBe(
        '发送失败: channel direction does not support outbound',
      );
      expect(result.isError).toBe(false);
    });

    it('失败：project 隔离 Forbidden → 返回 发送失败, 不抛异常', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' } as any);
      prisma.session.findFirst.mockResolvedValueOnce({
        taskId,
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      prisma.session.findFirst.mockResolvedValueOnce({
        id: 's_1',
        agentId: senderAgentId,
        teamMemberId: senderInstanceId,
      });
      outboundDispatcher.sendToChannelByIdOrName.mockRejectedValue(
        new ForbiddenException('channel project mismatch'),
      );

      const result = await service.channelSend(ctx, {
        target: 'nc_other',
        text: 'hi',
      });

      expect(result.content[0].text).toMatch(
        /发送失败:.*channel project mismatch/,
      );
      expect(result.isError).toBe(false);
    });

    it('text 越界 (>4000) → 返回发送失败, 不调用 dispatcher', async () => {
      const long = 'x'.repeat(4001);
      const result = await service.channelSend(ctx, {
        target: 'nc_1',
        text: long,
      });

      expect(result.content[0].text).toMatch(/发送失败:.*4000/);
      expect(result.isError).toBe(false);
      expect(outboundDispatcher.sendToChannelByIdOrName).not.toHaveBeenCalled();
    });

    it('无法解析任务上下文（无 session）→ 返回发送失败', async () => {
      prisma.session.findFirst.mockResolvedValueOnce(null);

      const result = await service.channelSend(ctx, {
        target: 'nc_1',
        text: 'hi',
      });

      expect(result.content[0].text).toMatch(
        /发送失败:.*无法解析当前任务上下文/,
      );
      expect(result.isError).toBe(false);
      expect(outboundDispatcher.sendToChannelByIdOrName).not.toHaveBeenCalled();
    });

    it('未提供 outboundDispatcher → 返回 发送失败: 出站分发器未就绪', async () => {
      (
        service as unknown as { outboundDispatcher: unknown }
      ).outboundDispatcher = null as unknown as NotificationDispatcherService;
      const result = await service.channelSend(ctx, {
        target: 'nc_1',
        text: 'hi',
      });
      expect(result.content[0].text).toMatch(/发送失败:.*出站分发器未就绪/);
      (
        service as unknown as { outboundDispatcher: unknown }
      ).outboundDispatcher =
        outboundDispatcher as unknown as NotificationDispatcherService;
    });
  });

  describe('tools/list 包含 channel_send', () => {
    it('snapshot includes channel_send', async () => {
      const tools = buildPlatformMcpTools(service);
      const names = tools.map((t) => t.name);
      expect(names).toContain('channel_send');
      expect(names).toEqual(
        expect.arrayContaining([
          'chat_history',
          'group_post',
          'notify_agent',
          'channel_send',
        ]),
      );
      const channelSendTool = tools.find((t) => t.name === 'channel_send')!;
      expect(channelSendTool.description).toMatch(/notification channel/);
      const schema = channelSendTool.inputSchema as unknown as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(schema.safeParse({ target: 'nc_1', text: 'hi' }).success).toBe(
        true,
      );
      expect(
        schema.safeParse({ target: 'nc_1', text: 'x'.repeat(4001) }).success,
      ).toBe(false);
      expect(schema.safeParse({ target: 'nc_1' }).success).toBe(false);
    });
  });

  describe('team-free-chat todo-4：双上下文解析矩阵（chat_history）', () => {
    it('taskId only → 任务维度（session 按任务归属团队归属）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      const result = await service.chatHistory(ctx, { taskId });

      expect(result).toEqual({ items: [], truncated: false, total: 0 });
      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', workerId },
        }),
      );
    });

    it('teamId only → 团队维度（session 按 teamId 归属 + 团队群聊）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_1',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      const result = await service.chatHistory(ctx, { teamId: 'tm_1' });

      expect(result).toEqual({ items: [], truncated: false, total: 0 });
      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ teamId: 'tm_1', workerId }),
        }),
      );
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ teamId: 'tm_1' }),
        }),
      );
    });

    it('双传 → taskId 优先（只走任务维度，不查团队维度）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([]);

      await service.chatHistory(ctx, { taskId, teamId: 'tm_1' });

      expect(prisma.session.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', workerId },
        }),
      );
    });

    it('双空 → 干净 400 该工具需要任务上下文（非 500）', async () => {
      const err = await service
        .chatHistory(ctx, {} as unknown as { taskId: string })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain('该工具需要任务上下文');
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
    });

    it('tm_ 前缀 taskId → 干净 400 指引传 teamId（非 403，不查会话）', async () => {
      const err = await service
        .chatHistory(ctx, { taskId: 'tm_0000000001' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain('团队会话请传 teamId');
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
    });

    it('tm_ 前缀 taskId + 合法 teamId 同传 → 仍 400（守卫先于 taskId 优先分支）', async () => {
      const err = await service
        .chatHistory(ctx, { taskId: 'tm_0000000001', teamId: 'tm_1' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain('团队会话请传 teamId');
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
    });

    it('t_ 前缀 taskId 不受 tm_ 守卫影响（正常走任务维度）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      const result = await service.chatHistory(ctx, { taskId });

      expect(result).toEqual({ items: [], truncated: false, total: 0 });
      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { teamId: 'tm_1', workerId },
        }),
      );
    });

    it('团队维度归属不匹配 → 403（维度间无回退）', async () => {
      prisma.session.findFirst.mockResolvedValue(null);

      await expectCode(
        service.chatHistory(ctx, { teamId: 'tm_other' }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
    });
  });

  describe('team-free-chat todo-4：task_create 主门（remove-project-dimension Todo 7 去 pid）', () => {
    it('非主实例（任务维度）不再被身份门拒绝 → 触达 createByAgent（原 403 已移除）', async () => {
      allowWorker();
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: 'tmm_other',
      });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('任务维度主 Agent → 成功，teamId 取任务所属团队', async () => {
      allowWorker();
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: senderInstanceId,
      });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('任务维度陈旧标量不参与判定：团队主为准（标量停写，读它会误 403）', async () => {
      allowWorker();
      // 标量指向 tmm_other（陈旧值），但团队主是 senderInstanceId → 仍放行
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: senderInstanceId,
      });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: senderInstanceId,
        title: '新任务',
      });
      expect(result).toEqual({ id: 't_new' });
      expect(tasksService.createByAgent).toHaveBeenCalled();
    });

    it('任务维度任务主为空 + 团队绑定已设 → 绑定成员放行（不再死锁）', async () => {
      allowWorkerAs('tmm_main');
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: 'tmm_main',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(prisma.team.findUnique).not.toHaveBeenCalled();
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        'tmm_main',
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('任务维度任务主为空 + 团队绑定已设 → 非绑定成员不再被拒（触达 createByAgent）', async () => {
      allowWorkerAs('tmm_other');
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: 'tmm_other',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        'tmm_other',
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('任务维度任务主为空 + 团队绑定缺省 → 首位成员回退放行', async () => {
      allowWorkerAs('tmm_first');
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tmm_first' });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: 'tmm_first',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        'tmm_first',
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('任务维度任务主为空 + 团队绑定缺省 → 非首位不再被拒（触达 createByAgent）', async () => {
      allowWorkerAs('tmm_other');
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tmm_first' });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: 'tmm_other',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        'tmm_other',
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('团队维度主成员 → 成功，直调 createByAgent（归属即团队）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_main',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: 'tmm_main',
      });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_main',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        'tmm_main',
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('非主成员（团队维度）不再被身份门拒绝 → 触达 createByAgent', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: 'tmm_main',
      });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_other',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        'tmm_other',
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('绑定缺省 + 首位成员（seq 升序回退）→ 放行，不再死锁', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_first',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tmm_first' });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_first',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        'tmm_first',
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('绑定缺省 + 非首位成员不再做回退解析 → 触达 createByAgent', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tmm_first' });
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_other',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        'tmm_other',
        expect.objectContaining({ teamId: 'tm_1', title: '新任务' }),
      );
    });

    it('绑定缺省 + 空名册 → 放行（不再解析主成员，失败面消失）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findFirst.mockResolvedValue(null);
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_other',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(tasksService.createByAgent).toHaveBeenCalled();
    });

    it('绑定缺省 + 回退查询失败不再影响放行（不再调用回退查询）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findFirst.mockRejectedValue(new Error('db down'));
      tasksService.createByAgent.mockResolvedValue({ id: 't_new' });

      const result = await service.taskCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_other',
        title: '新任务',
      });

      expect(result).toEqual({ id: 't_new' });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(tasksService.createByAgent).toHaveBeenCalled();
    });
  });

  describe('team-free-chat todo-4：delivery 工具缺 taskId', () => {
    it('delivery 工具缺 taskId → 干净 400 该工具需要任务上下文', async () => {
      const err = await service
        .taskContext(ctx, { taskId: undefined as unknown as string })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain('该工具需要任务上下文');
    });
  });

  describe('team-free-chat todo-4：tools/list 新工具与更新 schema', () => {
    it('包含 task_create；selfInstanceId/title 必填', () => {
      const tools = buildPlatformMcpTools(service);
      const names = tools.map((t) => t.name);
      expect(names).toContain('task_create');
      expect(names).not.toContain('my_projects');
      const taskCreate = tools.find((t) => t.name === 'task_create')!;
      const schema = taskCreate.inputSchema as unknown as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(
        schema.safeParse({
          selfInstanceId: 'tmm_1',
          title: 't',
          teamId: 'tm_1',
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          selfInstanceId: 'tmm_1',
          teamId: 'tm_1',
        }).success,
      ).toBe(false);
    });

    it('5 工具接受 teamId-only，双空亦通过 parse（回填由服务端会话完成）', () => {
      const tools = buildPlatformMcpTools(service);
      for (const name of [
        'chat_history',
        'group_post',
        'notify_agent',
        'memory_save',
        'memory_search',
      ]) {
        const tool = tools.find((t) => t.name === name)!;
        const schema = tool.inputSchema as unknown as {
          safeParse: (v: unknown) => { success: boolean };
        };
        const base =
          name === 'chat_history'
            ? {}
            : name === 'group_post' || name === 'notify_agent'
              ? {
                  selfInstanceId: 'tmm_1',
                  content: 'hi',
                  ...(name === 'notify_agent'
                    ? { targetInstanceId: 'tmm_2' }
                    : {}),
                }
              : name === 'memory_save'
                ? { selfInstanceId: 'tmm_1', level: 'global', content: 'x' }
                : {};
        expect(schema.safeParse({ ...base, teamId: 'tm_1' }).success).toBe(
          true,
        );
        expect(schema.safeParse(base).success).toBe(true);
      }
    });

    it('notify_agent input schema 接受可选 issueId（缺省/传值均合法）', () => {
      const tools = buildPlatformMcpTools(service);
      const tool = tools.find((t) => t.name === 'notify_agent')!;
      const schema = tool.inputSchema as unknown as {
        safeParse: (v: unknown) => { success: boolean };
      };
      const base = {
        selfInstanceId: 'tmm_1',
        content: 'hi',
        targetInstanceId: 'tmm_2',
        teamId: 'tm_1',
      };
      expect(schema.safeParse(base).success).toBe(true);
      expect(
        schema.safeParse({ ...base, issueId: 'is_0000000001' }).success,
      ).toBe(true);
    });

    it('notify_agent force 字符串 "true" 宽容 coercion（fail-closed）', () => {
      const tools = buildPlatformMcpTools(service);
      const tool = tools.find((t) => t.name === 'notify_agent')!;
      const schema = tool.inputSchema as unknown as {
        safeParse: (v: unknown) => {
          success: boolean;
          data?: { force?: boolean };
        };
      };
      const base = {
        selfInstanceId: 'tmm_1',
        content: 'hi',
        targetInstanceId: 'tmm_2',
        teamId: 'tm_1',
      };
      expect(schema.safeParse({ ...base, force: true }).data?.force).toBe(true);
      expect(schema.safeParse({ ...base, force: 'true' }).data?.force).toBe(
        true,
      );
      expect(schema.safeParse({ ...base, force: 'false' }).data?.force).toBe(
        false,
      );
      expect(schema.safeParse({ ...base, force: 1 }).data?.force).toBe(false);
      expect(schema.safeParse({ ...base, force: 'yes' }).data?.force).toBe(
        false,
      );
      expect(schema.safeParse(base).data?.force).toBeUndefined();
    });
  });

  describe('learning-mode P2：skill_create（仅主 Agent，默认停用）', () => {
    const skillContent =
      '---\nname: git-ops\ndescription: Git ops\n---\n# Git Ops\nbody\n';
    const skillArgs = {
      taskId,
      selfInstanceId: senderInstanceId,
      name: 'git-ops',
      content: skillContent,
    };
    const allowMainTask = () => {
      allowWorker();
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: senderInstanceId,
      });
    };

    it('任务维度主 Agent → 成功，file 适配合成后调 SkillsService.create', async () => {
      allowMainTask();
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, { ...skillArgs });

      expect(result).toMatchObject({ name: 'git-ops', enabled: false });
      expect(skillsService.create).toHaveBeenCalledWith({
        frontmatter: expect.objectContaining({ name: 'git-ops' }),
        content: skillContent,
        file: {
          originalname: 'git-ops.md',
          size: Buffer.byteLength(skillContent, 'utf8'),
          mimetype: 'text/markdown',
          buffer: expect.any(Buffer),
        },
      });
    });

    it('团队维度主成员 → 成功', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_main',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: 'tmm_main',
      });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_main',
        name: 'git-ops',
        content: skillContent,
      });

      expect(result).toMatchObject({ enabled: false });
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('非主实例（任务维度）不再被身份门拒绝 → 触达 create（原 403 已移除）', async () => {
      allowWorker();
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: 'tmm_other',
      });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, { ...skillArgs });

      expect(result).toMatchObject({ name: 'git-ops' });
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('任务维度陈旧标量不参与判定：团队主为准（标量停写，读它会误 403）', async () => {
      allowWorker();
      // 标量指向 tmm_other（陈旧值），但团队主是 senderInstanceId → 仍放行
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: senderInstanceId,
      });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, { ...skillArgs });

      expect(result).toMatchObject({ name: 'git-ops' });
      expect(skillsService.create).toHaveBeenCalled();
    });

    it('任务维度任务主为空 + 团队绑定已设 → 绑定成员放行（不再死锁）', async () => {
      allowWorkerAs('tmm_main');
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, {
        taskId,
        selfInstanceId: 'tmm_main',
        name: 'git-ops',
        content: skillContent,
      });

      expect(result).toMatchObject({ enabled: false });
      expect(prisma.team.findUnique).not.toHaveBeenCalled();
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('任务维度任务主为空 + 团队绑定已设 → 非绑定成员不再被拒（触达 create）', async () => {
      allowWorkerAs('tmm_other');
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, {
        taskId,
        selfInstanceId: 'tmm_other',
        name: 'git-ops',
        content: skillContent,
      });

      expect(result).toMatchObject({ enabled: false });
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('任务维度任务主为空 + 团队绑定缺省 → 首位成员回退放行', async () => {
      allowWorkerAs('tmm_first');
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        teamId: 'tm_1',
        mainAgentInstanceId: null,
      });
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tmm_first' });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, {
        taskId,
        selfInstanceId: 'tmm_first',
        name: 'git-ops',
        content: skillContent,
      });

      expect(result).toMatchObject({ enabled: false });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('非主成员（团队维度）不再被身份门拒绝 → 触达 create', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: 'tmm_main',
      });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_other',
        name: 'git-ops',
        content: skillContent,
      });

      expect(result).toMatchObject({ enabled: false });
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('绑定缺省 + 首位成员 → 放行且不做回退解析', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_first',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tmm_first' });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_first',
        name: 'git-ops',
        content: skillContent,
      });

      expect(result).toMatchObject({ enabled: false });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('绑定缺省 + 非首位成员 → 放行（不再回退解析 / 不再 403）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tmm_first' });
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_other',
        name: 'git-ops',
        content: skillContent,
      });

      expect(result).toMatchObject({ enabled: false });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('绑定缺省 + 空名册 → 放行（不再有“未设置”403）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_t',
        teamMemberId: 'tmm_other',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: null,
      });
      prisma.teamMember.findFirst.mockResolvedValue(null);
      skillsService.create.mockResolvedValue({
        id: 'sk_0000000001',
        name: 'git-ops',
        enabled: false,
      });

      const result = await service.skillCreate(ctx, {
        teamId: 'tm_1',
        selfInstanceId: 'tmm_other',
        name: 'git-ops',
        content: skillContent,
      });

      expect(result).toMatchObject({ enabled: false });
      expect(prisma.teamMember.findFirst).not.toHaveBeenCalled();
      expect(skillsService.create).toHaveBeenCalledTimes(1);
    });

    it('冒充（selfInstanceId 非会话成员）→ 403，不触达 create', async () => {
      denyWorker();

      await expectCode(
        service.skillCreate(ctx, { ...skillArgs }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(skillsService.create).not.toHaveBeenCalled();
    });

    it('frontmatter 非法 → 400 SKILL_FRONTMATTER_INVALID（parse 先行）', async () => {
      allowMainTask();

      await expectCode(
        service.skillCreate(ctx, { ...skillArgs, content: 'no frontmatter' }),
        BadRequestException,
        SKILL_ERRORS.SKILL_FRONTMATTER_INVALID,
      );
      expect(skillsService.create).not.toHaveBeenCalled();
    });

    it('name 重复 → 409 SKILL_NAME_EXISTS（SkillsService.create 透传）', async () => {
      allowMainTask();
      skillsService.create.mockRejectedValue(
        new ConflictException({
          code: SKILL_ERRORS.SKILL_NAME_EXISTS,
          message: '技能名 git-ops 已存在',
        }),
      );

      await expectCode(
        service.skillCreate(ctx, { ...skillArgs }),
        ConflictException,
        SKILL_ERRORS.SKILL_NAME_EXISTS,
      );
    });

    it('全文超 100KB → 400，不触达 create', async () => {
      allowMainTask();

      const err = await service
        .skillCreate(ctx, {
          ...skillArgs,
          content: 'x'.repeat(100 * 1024 + 1),
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain('100KB');
      expect(skillsService.create).not.toHaveBeenCalled();
    });

    it('tools/list 含 skill_create；selfInstanceId/name/content 必填', () => {
      const tools = buildPlatformMcpTools(service);
      const tool = tools.find((t) => t.name === 'skill_create')!;
      expect(tool).toBeDefined();
      const schema = tool.inputSchema as unknown as {
        safeParse: (v: unknown) => { success: boolean };
      };
      expect(
        schema.safeParse({
          taskId,
          selfInstanceId: senderInstanceId,
          name: 'git-ops',
          content: skillContent,
        }).success,
      ).toBe(true);
      expect(
        schema.safeParse({
          selfInstanceId: senderInstanceId,
          name: 'git-ops',
        }).success,
      ).toBe(false);
    });
  });

  describe('todo 10 保留检查锁定（retained server-side checks）', () => {
    const RETAINED_CHECKS = [
      {
        family: 'notify-self',
        code: PLATFORM_MCP_ERRORS.NOTIFY_ROUTING_VIOLATION,
        spec: 'server/src/platform-mcp/platform-mcp.service.spec.ts',
      },
      {
        family: 'notify-non-main-to-non-main',
        code: PLATFORM_MCP_ERRORS.NOTIFY_ROUTING_VIOLATION,
        spec: 'server/src/platform-mcp/platform-mcp.service.spec.ts',
      },
      {
        family: 'terminal-task-execution-dispatch',
        code: 'TERMINAL_TASK_DISPATCH_REFUSED',
        spec: 'server/src/chat/worker-dispatcher.gate.spec.ts',
      },
      {
        family: 'accept-archive-mcp-site',
        code: TASK_ERRORS.TASK_AGENT_COMPLETION_FORBIDDEN,
        spec: 'server/src/platform-mcp/platform-mcp.service.spec.ts',
      },
      {
        family: 'accept-archive-service-site',
        code: TASK_ERRORS.TASK_AGENT_COMPLETION_FORBIDDEN,
        spec: 'server/src/tasks/tasks.service.spec.ts',
      },
      {
        family: 'global-memory-write-scope',
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        spec: 'server/src/platform-mcp/platform-mcp.service.spec.ts',
      },
      {
        family: 'hook-cancel-owner-or-main',
        code: PLATFORM_MCP_ERRORS.FORBIDDEN,
        spec: 'server/src/platform-mcp/platform-mcp.service.spec.ts',
      },
      {
        family: 'plan-hash-stale-including-plan-role',
        code: 'PLAN_HASH_STALE',
        spec: 'server/src/chat/worker-dispatcher.gate.spec.ts',
      },
      {
        family: 'question-confirm-self-approval',
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.SELF_CONFIRMATION_FORBIDDEN,
        spec: 'server/src/platform-mcp/platform-mcp.service.spec.ts',
      },
      {
        family: 'question-confirm-cross-task',
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.CROSS_TASK_FORBIDDEN,
        spec: 'server/src/platform-mcp/platform-mcp.service.spec.ts',
      },
    ] as const;

    it('保留检查注册表非空、族名互异、每条命名错误码且其锁定 spec 文件存在', () => {
      const repoRoot = path.resolve(__dirname, '..', '..', '..');
      expect(RETAINED_CHECKS.length).toBe(10);
      expect(new Set(RETAINED_CHECKS.map((c) => c.family)).size).toBe(
        RETAINED_CHECKS.length,
      );
      for (const check of RETAINED_CHECKS) {
        expect(check.code.length).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(repoRoot, check.spec))).toBe(true);
      }
    });

    it('notify_agent self-notify → 403 PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION（不落库不触发）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: channelId,
      } as never);
      prisma.teamMember.findFirst.mockResolvedValue({
        agentId: 'a_sender',
        alias: null,
        agent: { id: 'a_sender', name: '发送者' },
      } as never);

      await expectCode(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: senderInstanceId,
          content: '自言自语',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.NOTIFY_ROUTING_VIOLATION,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    it('notify_agent 非主→非主 → 403 PLATFORM_MCP_NOTIFY_ROUTING_VIOLATION（不落库不广播不触发）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: channelId,
      } as never);
      prisma.teamMember.findFirst.mockResolvedValue({
        agentId: 'a_tester',
        alias: null,
        agent: { id: 'a_tester', name: '测试' },
      } as never);
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      } as never);

      await expectCode(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'tmm_tester',
          content: '请查看',
          selfInstanceId: senderInstanceId,
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.NOTIFY_ROUTING_VIOLATION,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(realtime.broadcast).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
    });

    // accept/archive 站点 2（TasksService.transitionByAgent）由 tasks.service.spec.ts 锁定。
    it.each([['accept'], ['archive']] as const)(
      'MCP taskTransition %s → 403 TASK_AGENT_COMPLETION_FORBIDDEN，不触达 transitionByAgent（站点 1）',
      async (action) => {
        await expectCode(
          service.taskTransition(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            action,
          }),
          ForbiddenException,
          TASK_ERRORS.TASK_AGENT_COMPLETION_FORBIDDEN,
        );
        expect(tasksService.transitionByAgent).not.toHaveBeenCalled();
      },
    );

    it('memory_save level=global 非主成员 → 403 PLATFORM_MCP_FORBIDDEN，不落库', async () => {
      allowWorker();
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_other',
      } as never);

      await expectCode(
        service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'global',
          content: 'x',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.memory.create).not.toHaveBeenCalled();
    });

    it('memory_save 团队维度 level=global 非主成员 → 403 PLATFORM_MCP_FORBIDDEN，不落库', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_team',
        teamMemberId: 'tmm_2',
      });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        name: 'T1',
        mainAgentMemberId: 'tmm_main',
      } as never);

      await expectCode(
        service.memorySave(ctx, {
          teamId: 'tm_1',
          selfInstanceId: 'tmm_2',
          level: 'global',
          content: 'x',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.memory.create).not.toHaveBeenCalled();
    });

    it('memory_update global 行非主成员 → 403 PLATFORM_MCP_FORBIDDEN，不更新', async () => {
      allowWorker();
      prisma.memory.findUnique.mockResolvedValue({
        id: 'me_0000000001',
        level: 'global',
        taskId: null,
        teamId: null,
        content: '旧经验',
        description: '旧',
        tags: null,
        createdBy: 'tmm_other',
        deletedAt: null,
      } as never);
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_other',
      } as never);

      await expectCode(
        service.memoryUpdate(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          memoryId: 'me_0000000001',
          content: 'x',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(prisma.memory.update).not.toHaveBeenCalled();
    });

    it('hook_cancel 非所有者且非主 Agent → 403 PLATFORM_MCP_FORBIDDEN，不触达 cancelHook', async () => {
      allowWorker();
      prisma.hook.findUnique.mockResolvedValue({
        id: 'hks_0000000001',
        ownerInstanceId: 'tmm_owner',
        scopeType: 'task',
        scopeId: taskId,
        status: 'pending',
      } as never);
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_other',
      } as never);

      await expectCode(
        service.hookCancel(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          hookId: 'hks_0000000001',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(hookService.cancelHook).not.toHaveBeenCalled();
    });

    // question_confirm 的两条完整性校验（todo 2 新增）用真实 QuestionsService 执行，
    // 不 mock —— 证明实现本身拒绝，而非断言 mock 抛错。
    const realQuestions = (overrides: {
      taskId: string;
      sessionMemberId?: string | null;
    }) =>
      new QuestionsService(
        {
          task: {
            findUnique: jest
              .fn()
              .mockResolvedValue({ id: 't_0000000001', teamId: 'tm_1' }),
          },
          team: { findUnique: jest.fn().mockResolvedValue({ id: 'tm_1' }) },
          agentQuestion: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'aq_1',
              requestId: 'que_x',
              sessionId: 's_1',
              taskId: overrides.taskId,
              kind: 'question',
              status: 'pending',
            }),
          },
          session: {
            findUnique: jest
              .fn()
              .mockResolvedValue(
                overrides.sessionMemberId
                  ? { teamMemberId: overrides.sessionMemberId }
                  : null,
              ),
          },
        } as never,
        {} as never,
        {} as never,
        {} as never,
      );

    it('questionConfirm 跨任务请求 → 403 QUESTION_CROSS_TASK_FORBIDDEN（真实实现）', async () => {
      await expectCode(
        realQuestions({ taskId: 't_other' }).confirmByAgent({
          taskId: 't_0000000001',
          instanceId: 'tmm_main',
          requestId: 'que_x',
          kind: 'question',
          answers: [['确认']],
        }),
        ForbiddenException,
        QUESTION_CONFIRM_INTEGRITY_ERRORS.CROSS_TASK_FORBIDDEN,
      );
    });

    it('questionConfirm 发起者本人确认 → 403 QUESTION_SELF_CONFIRMATION_FORBIDDEN（真实实现）', async () => {
      await expectCode(
        realQuestions({
          taskId: 't_0000000001',
          sessionMemberId: 'tmm_self',
        }).confirmByAgent({
          taskId: 't_0000000001',
          instanceId: 'tmm_self',
          requestId: 'que_x',
          kind: 'question',
          answers: [['确认']],
        }),
        ForbiddenException,
        QUESTION_CONFIRM_INTEGRITY_ERRORS.SELF_CONFIRMATION_FORBIDDEN,
      );
    });

    it('questionConfirm MCP 网关：完整性拒绝码原样向上传播（不降级为 warning），且先过归属校验', async () => {
      allowWorker();
      questionsService.confirmByAgent.mockRejectedValue(
        new ForbiddenException({
          code: QUESTION_CONFIRM_INTEGRITY_ERRORS.SELF_CONFIRMATION_FORBIDDEN,
          message: '请求由本人发起，不可自行确认',
        }),
      );

      await expectCode(
        service.questionConfirm(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          requestId: 'que_x',
          kind: 'question',
          answers: [['确认']],
        }),
        ForbiddenException,
        QUESTION_CONFIRM_INTEGRITY_ERRORS.SELF_CONFIRMATION_FORBIDDEN,
      );
      expect(questionsService.confirmByAgent).toHaveBeenCalledWith(
        expect.objectContaining({ taskId, instanceId: senderInstanceId }),
      );
    });
  });
});
