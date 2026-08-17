import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
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
import { WorkerClient, WorkerUnavailableException } from '../workers/worker.client';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';
import { PlatformMcpService } from './platform-mcp.service';
import { memorySaveSchema } from './platform-mcp.tools';
import { PLAN_ERRORS } from '../plans/plan.constants';
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { PlansService } from '../plans/plans.service';

describe('PlatformMcpService', () => {
  let service: PlatformMcpService;
  let prisma: {
    session: { findFirst: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { findMany: jest.Mock; create: jest.Mock };
    artifact: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    artifactVersion: { findUnique: jest.Mock; findMany: jest.Mock; create: jest.Mock; findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    taskAgent: { findMany: jest.Mock; findFirst: jest.Mock };
    worker: { findUnique: jest.Mock };
    memory: { create: jest.Mock; findMany: jest.Mock };
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
  let tasksService: { transitionByAgent: jest.Mock; updateTeam: jest.Mock };
  let questionsService: { confirmByAgent: jest.Mock; createForPlatform: jest.Mock };
  let plansService: { assignReviewer: jest.Mock };

  const taskId = 't_0000000001';
  const workerId = 'w_0000000001';
  const channelId = 'c_0000000001';
  const ctx = { workerId };
  /** 调用方 Agent（senderId 落库目标；session.agentId 对齐）。 */
  const senderAgentId = 'a_sender';
  /** 调用方实例 id（ta_ 前缀；session.taskAgentId 对齐，senderInstanceId 落库目标）。 */
  const senderInstanceId = 'ta_sender';

  /** 归属校验通过：该 worker 有该任务 Session（绑定实例 ta_sender + agentId=a_sender）。 */
  const allowWorker = () => {
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: senderAgentId,
      taskAgentId: senderInstanceId,
    });
  };

  /** 归属校验通过（指定实例）：session.taskAgentId 绑定指定实例 id（多实例/跨实例权限用例）。 */
  const allowWorkerAs = (instanceId: string) => {
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: senderAgentId,
      taskAgentId: instanceId,
    });
  };

  /** 归属校验失败：无 Session（防跨任务）。 */
  const denyWorker = () => {
    prisma.session.findFirst.mockResolvedValue(null);
  };

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { findMany: jest.fn(), create: jest.fn() },
      artifact: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      artifactVersion: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
    task: { findUnique: jest.fn() },
    taskAgent: { findMany: jest.fn(), findFirst: jest.fn() },
      worker: { findUnique: jest.fn() },
      memory: { create: jest.fn(), findMany: jest.fn() },
      agent: { findUnique: jest.fn() },
      agentQuestion: { findMany: jest.fn() },
      plan: { findUnique: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(), update: jest.fn() },
      planTask: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    // FR-41：$transaction 直接透传回调（tx 复用 prisma mock），事务内查询可断言
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(prisma),
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
    tasksService = { transitionByAgent: jest.fn(), updateTeam: jest.fn() };
    questionsService = { confirmByAgent: jest.fn(), createForPlatform: jest.fn() };
    plansService = { assignReviewer: jest.fn() };

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
        { provide: PlansService, useValue: plansService },
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
        expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
          code,
        });
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
        expect.objectContaining({ where: { taskId, workerId } }),
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
        service.groupPost(ctx, { taskId, content: 'x', selfInstanceId: senderInstanceId }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
    });

    it('落库类工具 selfInstanceId 与 session.taskAgentId 不一致 → 403 PLATFORM_MCP_FORBIDDEN（防冒充）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_1',
        agentId: 'a_other',
        taskAgentId: 'ta_other',
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
          targetInstanceId: 'ta_tester',
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
      prisma.taskAgent.findFirst.mockResolvedValue({ agentId: senderAgentId });

      await service.groupPost(ctx, {
        taskId,
        content: 'x',
        selfInstanceId: senderInstanceId,
      });

      expect(prisma.session.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { taskId, workerId, taskAgentId: senderInstanceId },
        }),
      );
      expect(prisma.message.create).toHaveBeenCalled();
    });
  });

  describe('chat_history', () => {
    it('返回群聊历史消息（text 从 content Json 提取，orderBy id asc，缺省 limit 50）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm_0000000001',
          senderType: SENDER_TYPE.user,
          senderId: 'u_1',
          content: { text: '你好', parts: [] },
          createdAt: new Date('2026-08-07T00:00:00Z'),
        },
        {
          id: 'm_0000000002',
          senderType: SENDER_TYPE.agent,
          senderId: null,
          content: { text: '收到', parts: [] },
          createdAt: new Date('2026-08-07T00:00:01Z'),
        },
      ]);

      const result = await service.chatHistory(ctx, { taskId });

      expect(result).toEqual([
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
      ]);
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { taskId, type: CHANNEL_TYPE.task_group },
        select: { id: true },
      });
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId },
        orderBy: { id: 'asc' },
        take: 50,
      });
    });

    it('含附件消息返回附件字段（attachmentUrl/attachmentName/attachmentType + senderInstanceId，无附件为 null）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([
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
        {
          id: 'm_0000000021',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_1',
          senderInstanceId: 'ta_1',
          content: { text: '已读取', parts: [] },
          attachmentUrl: null,
          attachmentName: null,
          attachmentType: null,
          createdAt: new Date('2026-08-07T00:00:03Z'),
        },
      ]);

      const result = await service.chatHistory(ctx, { taskId });

      expect(result[0]).toEqual({
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
      expect(result[1].senderInstanceId).toBe('ta_1');
    });

    it('sinceId 游标过滤 + limit 分页透传', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([]);

      await service.chatHistory(ctx, { taskId, sinceId: 'm_0000000010', limit: 20 });

      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: { channelId, id: { gt: 'm_0000000010' } },
        orderBy: { id: 'asc' },
        take: 20,
      });
    });

    it('limit 越界收敛（>100 → 100，<=0 → 1，非法 → 50）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.message.findMany.mockResolvedValue([]);

      await service.chatHistory(ctx, { taskId, limit: 999 });
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
      await service.chatHistory(ctx, { taskId, limit: 0 });
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
      await service.chatHistory(ctx, { taskId, limit: Number.NaN });
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
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

  describe('doclib', () => {
    it('无 artifactId → 产出物清单（id/type/title/currentVersion/updatedAt）', async () => {
      allowWorker();
      prisma.artifact.findMany.mockResolvedValue([
        {
          id: 'a_1',
          type: 'doc',
          title: '需求文档',
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
            currentVersion: 2,
            updatedAt: '2026-08-07T00:00:00.000Z',
          },
        ],
      });
    });

    it('有 artifactId 缺省 version → 返回 currentVersion 版本全文', async () => {
      allowWorker();
      prisma.artifact.findFirst.mockResolvedValue({
        id: 'a_1',
        type: 'text',
        title: '实现说明',
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
        version: { contentRef: '完成报表聚合与 CSV 导出…', filePath: null },
      });
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
        mainAgentInstanceId: 'ta_1',
        backgroundDocs: [{ name: '背景.md' }],
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.taskAgent.findMany.mockResolvedValue([
        {
          id: 'ta_1',
          alias: '产品经理-1',
          seq: 1,
          agentId: 'ag_1',
          agent: { id: 'ag_1', name: '产品', role: 'product' },
        },
        {
          id: 'ta_2',
          alias: '架构师-1',
          seq: 1,
          agentId: 'ag_2',
          agent: { id: 'ag_2', name: '架构', role: 'architect' },
        },
      ]);

      const result = await service.taskContext(ctx, { taskId });

      expect(prisma.taskAgent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { taskId, removedAt: null } }),
      );
      expect(result).toEqual({
        id: taskId,
        title: '需求分析',
        description: '描述',
        status: 'in_progress',
        mainAgentId: 'ag_1',
        mainAgentInstanceId: 'ta_1',
        backgroundDocs: [{ name: '背景.md' }],
        channelId,
        agentMembers: [
          {
            id: 'ta_1',
            alias: '产品经理-1',
            agentId: 'ag_1',
            name: '产品',
            role: 'product',
            main: true,
          },
          {
            id: 'ta_2',
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
      // resolveSenderAgentId：senderId=agent id 从 selfInstanceId 实例行解析
      prisma.taskAgent.findFirst.mockResolvedValue({ agentId: senderAgentId });
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

    it('is_0000000015：content 含 @主 Agent → 落库 mentions + 定向分派被 @ 实例（含主 Agent 触发）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      // 团队实例：主 Agent（a_project_manager/鲍勃）+ 其他成员（用于 @ 前缀边界）
      prisma.taskAgent.findMany.mockResolvedValue([
        { id: 'ta_pm', agentId: 'a_project_manager', alias: '鲍勃', agent: { name: '项目经理' } },
        { id: 'ta_dev', agentId: 'a_developer', alias: '刘二开', agent: { name: '开发者' } },
      ]);

      const result = await service.groupPost(ctx, {
        taskId,
        content: '@鲍勃 请审核本次方案',
        selfInstanceId: senderInstanceId,
      });

      // mentions 落库（对齐 notify_agent 形状：instanceId+agentId+name）
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mentions: [{ type: 'agent', instanceId: 'ta_pm', agentId: 'a_project_manager', name: '鲍勃' }],
        }),
      });
      // 定向分派被 @ 实例（主 Agent）
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith({
        taskId,
        channelId,
        text: '@鲍勃 请审核本次方案',
        targetInstanceId: 'ta_pm',
      });
      expect(result).toEqual({ messageId: 'm_0000000100', channelId, attachment: null });
    });

    it('is_0000000015：content 无 @ 提及 → mentions 保持 null、不触发分派（普通群聊发布）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      idGen.nextId.mockResolvedValue('m_0000000100');
      prisma.message.create.mockResolvedValue(createdMessage);
      prisma.taskAgent.findMany.mockResolvedValue([
        { id: 'ta_pm', agentId: 'a_project_manager', alias: '鲍勃', agent: { name: '项目经理' } },
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
      prisma.taskAgent.findMany.mockResolvedValue([
        { id: 'ta_dev1', agentId: 'a_developer', alias: '开发者-1', agent: { name: '开发者' } },
        { id: 'ta_dev2', agentId: 'a_developer', alias: '开发者-2', agent: { name: '开发者' } },
      ]);

      await service.groupPost(ctx, {
        taskId,
        content: '@开发者-2 请处理',
        selfInstanceId: senderInstanceId,
      });

      const mentions = prisma.message.create.mock.calls[0][0].data.mentions;
      expect(mentions).toEqual([
        { type: 'agent', instanceId: 'ta_dev2', agentId: 'a_developer', name: '开发者-2' },
      ]);
      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledWith(
        expect.objectContaining({ targetInstanceId: 'ta_dev2' }),
      );
    });

    it('is_0000000028：内存活跃集合未命中但 DB 有绑定会话 → 放行（修复间歇性误拒合法成员）', async () => {
      // 模拟并发/超时导致的内存集合陈旧：isAgentExecuting 返回不含调用方的集合
      workerDispatcher.isAgentExecuting.mockReturnValue(
        new Set(['ta_other_instance']),
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
        new Set(['ta_other_instance']),
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
        { id: workerId, capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 } },
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
      workerClient.fetchFile.mockRejectedValue(new Error('worker 不可用：file fetch HTTP 404'));

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
        service.groupPost(ctx, { taskId, content: 'x', selfInstanceId: senderInstanceId }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.CHANNEL_NOT_FOUND,
      );
    });
  });

  describe('notify_agent', () => {
    const createdMessage = {
      id: 'm_0000000200',
      channelId,
      senderType: SENDER_TYPE.agent,
      senderId: 'a_sender',
      senderInstanceId: 'ta_sender',
      content: { text: '@测试 请查看这个文件', parts: [] },
      mentions: [
        {
          type: 'agent',
          instanceId: 'ta_tester',
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
     * taskAgent.findFirst 分流：目标实例 ta_tester → a_tester/别名 测试（@ 目标、mentions
     * 归属依据）；发送者实例 ta_sender → a_sender（senderId/senderInstanceId 落库归属依据）。
     */
    const mockTaskAgentRows = () => {
      prisma.taskAgent.findFirst.mockImplementation((args: { where: { id?: string } }) => {
        if (args.where.id === 'ta_sender') {
          return Promise.resolve({ agentId: 'a_sender' });
        }
        if (args.where.id === 'ta_tester') {
          return Promise.resolve({
            agentId: 'a_tester',
            alias: null,
            agent: { id: 'a_tester', name: '测试' },
          });
        }
        return Promise.resolve(null);
      });
    };

    it('落库 agent 消息（sender=发送者：senderId=发送者 agent id、senderInstanceId=selfInstanceId、mentions 含目标实例）+ 广播 + 触发目标实例 dispatch + 返回结构', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      mockTaskAgentRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);

      const result = await service.notifyAgent(ctx, {
        taskId,
        targetInstanceId: 'ta_tester',
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
          senderInstanceId: 'ta_sender',
          content: { text: '@测试 请查看这个文件', parts: [] },
          mentions: [
            {
              type: 'agent',
              instanceId: 'ta_tester',
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
        targetInstanceId: 'ta_tester',
      });
      expect(result).toEqual({
        messageId: 'm_0000000200',
        channelId,
        targetInstanceId: 'ta_tester',
      });
    });

    it('归属校验失败 → 403 PLATFORM_MCP_FORBIDDEN（不落库不触发）', async () => {
      denyWorker();
      await expectCode(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'ta_tester',
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
          targetInstanceId: 'ta_tester',
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
      mockTaskAgentRows();
      idGen.nextId.mockResolvedValue('m_0000000200');
      prisma.message.create.mockResolvedValue(createdMessage);
      workerDispatcher.dispatchAgentMention.mockRejectedValue(
        new Error('实例 ta_tester 无会话（任务 t_0000000001）'),
      );

      await expect(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'ta_tester',
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
      ).rejects.toThrow(/ta_tester 无会话/);
      // 落库 + 广播已执行（先落库后触发）
      expect(prisma.message.create).toHaveBeenCalled();
      expect(realtime.broadcast).toHaveBeenCalled();
    });

    it('目标实例不存在或不在任务团队 → 404（不落库不触发）', async () => {
      allowWorker();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
      prisma.taskAgent.findFirst.mockResolvedValue(null);
      idGen.nextId.mockResolvedValue('m_0000000200');

      await expectCode(
        service.notifyAgent(ctx, {
          taskId,
          targetInstanceId: 'ta_missing',
          content: 'x',
          selfInstanceId: senderInstanceId,
        }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
      );
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
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
        { contentRef: '/uploads/abc-uuid.txt', filePath: '/tmp/opencode/x.txt' },
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
        { contentRef: '/uploads/abc-uuid.txt', filePath: '/tmp/opencode/x.txt' },
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
        { id: workerId, capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 } },
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
        { contentRef: '/uploads/ghost.txt', filePath: '/tmp/opencode/ghost.txt' },
      ]);
      fsReadSpy.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await expectCode(
        service.readFile(ctx, { taskId, fileRef: '/tmp/opencode/ghost.txt' }),
        NotFoundException,
        PLATFORM_MCP_ERRORS.FILE_NOT_FOUND,
      );
    });

    it('maxBytes 截断 → truncated=true + content 仅前 N 字节', async () => {
      allowWorker();
      prisma.artifactVersion.findMany.mockResolvedValue([
        { contentRef: '/uploads/abc-uuid.txt', filePath: '/tmp/opencode/long.txt' },
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
        { contentRef: '/uploads/abc-uuid.txt', filePath: '/tmp/opencode/small.txt' },
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
        { contentRef: '/uploads/abc-uuid.bin', filePath: '/tmp/opencode/data.bin' },
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
        expect.objectContaining({ where: { taskId, workerId } }),
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
      expect(result).toEqual({ artifactId: 'a_1', version: 1, status: 'created' });
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

      expect(result).toEqual({ artifactId: 'a_1', version: 2, status: 'duplicate' });
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

      expect(result).toEqual({ artifactId: 'a_1', version: 2, status: 'appended' });
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
        { id: workerId, capabilities: { baseUrl: 'http://worker:46267', execPort: 4198 } },
        '/tmp/opencode/req.md',
      );
      // 归档公共化：fileRef=fileRef 原文、storedUrl=落盘 URL、title=工具入参
      expect(artifactsService.archiveFile).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          fileRef: '/tmp/opencode/req.md',
          storedUrl: expect.stringMatching(/^\/uploads\//),
          storedName: 'req.md',
          sha256: expect.any(String),
          title: '需求文档',
        }),
      );
      expect(result).toEqual({ artifactId: 'art_1', version: 1, status: 'created' });
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
        assigneeInstanceId: 'ta_tester',
      });

      expect(issuesService.createByAgent).toHaveBeenCalledWith(
        senderInstanceId,
        taskId,
        expect.objectContaining({
          taskId,
          title: '需求 issue',
          tags: ['需求'],
          assigneeInstanceId: 'ta_tester',
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
      issuesService.updateByAgent.mockResolvedValue({ ...issueDto, title: '改名' });

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
        taskAgentId: 'ta_other',
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
        taskAgentId: 'ta_other',
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
    const taskProjectId = 'p_0000000001';
    const taskRow = (overrides: Record<string, unknown> = {}) => ({
      projectId: taskProjectId,
      mainAgentInstanceId: senderInstanceId,
      ...overrides,
    });

    describe('memory_save', () => {
      it('task 级合法落库：projectId 冗余存 task 行值，返回 {memoryId, level}', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        idGen.nextId.mockResolvedValue('me_0000000001');
        prisma.memory.create.mockResolvedValue({
          id: 'me_0000000001',
          level: 'task',
          taskId,
          projectId: taskProjectId,
          content: '结论：改用 Prisma 事务',
          tags: ['结论'],
          createdBy: senderInstanceId,
        });

        const out = await service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'task',
          content: '结论：改用 Prisma 事务',
          tags: ['结论'],
        });

        expect(prisma.task.findUnique).toHaveBeenCalledWith({
          where: { id: taskId },
          select: { projectId: true, mainAgentInstanceId: true },
        });
        expect(prisma.memory.create).toHaveBeenCalledWith({
          data: {
            id: 'me_0000000001',
            level: 'task',
            taskId,
            projectId: taskProjectId,
            content: '结论：改用 Prisma 事务',
            tags: ['结论'],
            createdBy: senderInstanceId,
          },
        });
        expect(out).toEqual({ memoryId: 'me_0000000001', level: 'task' });
      });

      it('冒充 403：selfInstanceId 不在活跃集合且无绑定会话 → PLATFORM_MCP_FORBIDDEN，不触达 memory.create', async () => {
        denyWorker();
        await expectCode(
          service.memorySave(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'task',
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
            level: 'task',
            content: '',
          }).success,
        ).toBe(false);
      });

      it('level=global 非主 Agent 403：mainAgentInstanceId 与 selfInstanceId 不一致 → PLATFORM_MCP_FORBIDDEN（防全局污染）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(
          taskRow({ mainAgentInstanceId: 'ta_main' }),
        );
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

      it('level=global 主 Agent 可写：taskId/projectId 均不落库（null）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
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
            projectId: null,
            createdBy: senderInstanceId,
          }),
        });
        expect(out).toEqual({ memoryId: 'me_0000000002', level: 'global' });
      });

      it('level=project 不接收 projectId 入参：projectId 从 task 行反查，taskId 不落库', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(taskRow());
        idGen.nextId.mockResolvedValue('me_0000000003');
        prisma.memory.create.mockResolvedValue({
          id: 'me_0000000003',
          level: 'project',
        });

        const out = await service.memorySave(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          level: 'project',
          content: '项目级经验',
        });

        expect(prisma.memory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            level: 'project',
            taskId: null,
            projectId: taskProjectId,
          }),
        });
        expect(out).toEqual({ memoryId: 'me_0000000003', level: 'project' });
      });

      it('任务不存在 → 404 PLATFORM_MCP_TASK_NOT_FOUND（不落库）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(null);
        await expectCode(
          service.memorySave(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
            level: 'task',
            content: 'x',
          }),
          NotFoundException,
          PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        );
        expect(prisma.memory.create).not.toHaveBeenCalled();
      });
    });

    describe('memory_search', () => {
      it('聚合 task+project+global 三级：OR 条件 + deletedAt null 过滤 + createdAt desc 排序', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ projectId: taskProjectId });
        prisma.memory.findMany.mockResolvedValue([
          {
            id: 'me_0000000002',
            level: 'global',
            content: '平台约定',
            tags: null,
            createdBy: 'ta_main',
            createdAt: new Date('2026-08-08T00:00:02Z'),
          },
          {
            id: 'me_0000000001',
            level: 'task',
            content: '任务结论',
            tags: ['结论'],
            createdBy: senderInstanceId,
            createdAt: new Date('2026-08-08T00:00:01Z'),
          },
        ]);

        const out = await service.memorySearch(ctx, { taskId });

        expect(prisma.task.findUnique).toHaveBeenCalledWith({
          where: { id: taskId },
          select: { projectId: true },
        });
        expect(prisma.memory.findMany).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            OR: [
              { level: 'task', taskId },
              { level: 'project', projectId: taskProjectId },
              { level: 'global' },
            ],
          },
          orderBy: { createdAt: 'desc' },
        });
        expect(out).toEqual([
          {
            id: 'me_0000000002',
            level: 'global',
            content: '平台约定',
            tags: null,
            createdBy: 'ta_main',
            createdAt: '2026-08-08T00:00:02.000Z',
          },
          {
            id: 'me_0000000001',
            level: 'task',
            content: '任务结论',
            tags: ['结论'],
            createdBy: senderInstanceId,
            createdAt: '2026-08-08T00:00:01.000Z',
          },
        ]);
      });

      it('query → content contains 透传 prisma 层过滤', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ projectId: taskProjectId });
        prisma.memory.findMany.mockResolvedValue([]);

        await service.memorySearch(ctx, { taskId, query: '事务' });

        expect(prisma.memory.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              content: { contains: '事务' },
            }),
          }),
        );
      });

      it('tags 内存过滤（须包含全部查询标签）+ limit 截断', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ projectId: taskProjectId });
        prisma.memory.findMany.mockResolvedValue([
          {
            id: 'me_1',
            level: 'task',
            content: 'A',
            tags: ['x', 'y'],
            createdBy: 'a',
            createdAt: new Date('2026-08-08T00:00:03Z'),
          },
          {
            id: 'me_2',
            level: 'task',
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

      it('level 入参收窄到单级：level=project 时 OR 仅含 project 分支', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ projectId: taskProjectId });
        prisma.memory.findMany.mockResolvedValue([]);

        await service.memorySearch(ctx, { taskId, level: 'project' });

        expect(prisma.memory.findMany).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            OR: [{ level: 'project', projectId: taskProjectId }],
          },
          orderBy: { createdAt: 'desc' },
        });
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

      it('task 无 projectId + 显式 level=project → whereOr 空早返回 []（不触达 findMany）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ projectId: null });

        const out = await service.memorySearch(ctx, {
          taskId,
          level: 'project',
        });

        expect(prisma.memory.findMany).not.toHaveBeenCalled();
        expect(out).toEqual([]);
      });

      it('task 无 projectId + level 未传 → project 分支被跳过（OR 仅 task + global 两级）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ projectId: null });
        prisma.memory.findMany.mockResolvedValue([]);

        await service.memorySearch(ctx, { taskId });

        expect(prisma.memory.findMany).toHaveBeenCalledWith({
          where: {
            deletedAt: null,
            OR: [{ level: 'task', taskId }, { level: 'global' }],
          },
          orderBy: { createdAt: 'desc' },
        });
      });
    });
  });

  describe('plan_submit / plan_review / plan_task_transition（协作计划，tc-mcp-plan Todo 2）', () => {
    const mainInstanceId = senderInstanceId;
    const reviewerId = 'ta_reviewer';
    const assigneeId = 'ta_assignee';
    const planId = 'pl_0000000001';
    const planTaskId = 'pt_0000000001';
    const submitArgs = {
      taskId,
      selfInstanceId: mainInstanceId,
      title: '实施稻邕线消缺',
      tasks: [
        { title: '步骤一', what: '定位故障点', assigneeInstanceId: assigneeId },
        { title: '步骤二', what: '执行消缺' },
      ],
    };
    /** 主实例任务行（plan 工具主实例校验通过）。 */
    const mainTaskRow = (overrides: Record<string, unknown> = {}) => ({
      mainAgentInstanceId: mainInstanceId,
      ...overrides,
    });
    /** 群聊频道 mock：planSubmit/planReview 系统消息落库目标。 */
    const allowChannel = () => {
      prisma.chatChannel.findFirst.mockResolvedValue({ id: channelId });
    };

    describe('plan_submit', () => {
      it('首次提交合法落库：plan.upsert(create) + planTask 批量创建 + 群聊系统消息，返回 reviewing', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.taskAgent.findMany.mockResolvedValue([{ id: assigneeId }]);
        prisma.plan.findUnique.mockResolvedValue(null);
        allowChannel();
        idGen.nextId.mockResolvedValueOnce('pl_0000000001');
        idGen.nextId.mockResolvedValueOnce('pt_0000000001');
        idGen.nextId.mockResolvedValueOnce('pt_0000000002');
        idGen.nextId.mockResolvedValueOnce('m_0000000099');
        prisma.plan.upsert.mockResolvedValue({
          id: planId,
          status: 'reviewing',
        });
        prisma.planTask.create.mockResolvedValue({ id: planTaskId });

        const out = await service.planSubmit(ctx, submitArgs);

        expect(prisma.plan.upsert).toHaveBeenCalledWith({
          where: { taskId },
          update: expect.objectContaining({
            title: '实施稻邕线消缺',
            status: 'reviewing',
            reviewerInstanceId: null,
          }),
          create: expect.objectContaining({
            taskId,
            status: 'reviewing',
            createdBy: mainInstanceId,
            reviewerInstanceId: null,
          }),
        });
        expect(prisma.planTask.create).toHaveBeenCalledTimes(2);
        expect(prisma.planTask.create).toHaveBeenNthCalledWith(1, {
          data: expect.objectContaining({
            planId,
            seq: 1,
            assigneeInstanceId: assigneeId,
            status: 'pending',
            content: { what: '定位故障点', mustNot: null, references: null, acceptance: null, qa: null, commit: null },
          }),
        });
        expect(prisma.message.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            channelId,
            senderType: SENDER_TYPE.system,
            senderId: null,
            content: { text: '主 Agent 提交执行计划，请评审', parts: [] },
          }),
        });
        expect(out).toEqual({ planId, status: 'reviewing', taskCount: 2 });
      });

      it('结构校验 400：子任务 what 为空 → PLAN_STRUCTURE_INVALID，不触达事务', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.plan.findUnique.mockResolvedValue(null);
        await expectCode(
          service.planSubmit(ctx, {
            ...submitArgs,
            tasks: [{ title: '空任务', what: '   ' }],
          }),
          BadRequestException,
          PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
        );
        expect(prisma.plan.upsert).not.toHaveBeenCalled();
      });

      it('归属 403：无 Session → PLATFORM_MCP_FORBIDDEN', async () => {
        denyWorker();
        await expectCode(
          service.planSubmit(ctx, submitArgs),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
      });

      it('非主实例 403：mainAgentInstanceId 与 selfInstanceId 不一致 → PLATFORM_MCP_FORBIDDEN', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(
          mainTaskRow({ mainAgentInstanceId: 'ta_other' }),
        );
        await expectCode(
          service.planSubmit(ctx, submitArgs),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.plan.upsert).not.toHaveBeenCalled();
      });

      it('未终态重复 409：status=reviewing 时重复提交 → PLAN_INVALID_STATUS', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.plan.findUnique.mockResolvedValue({ id: planId, status: 'reviewing' });
        await expectCode(
          service.planSubmit(ctx, submitArgs),
          ConflictException,
          PLAN_ERRORS.PLAN_INVALID_STATUS,
        );
        expect(prisma.plan.upsert).not.toHaveBeenCalled();
      });

      it('assignee 校验 400：指派实例不在任务团队 → PLAN_STRUCTURE_INVALID', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.plan.findUnique.mockResolvedValue(null);
        prisma.taskAgent.findMany.mockResolvedValue([]);
        await expectCode(
          service.planSubmit(ctx, submitArgs),
          BadRequestException,
          PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
        );
        expect(prisma.taskAgent.findMany).toHaveBeenCalledWith({
          where: { taskId, id: { in: [assigneeId] }, removedAt: null },
          select: { id: true },
        });
      });

      it('覆盖重提（rejected → upsert update）：reviewerInstanceId=null + 删旧建新重建 planTask（Oracle B2/R1/R5）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.taskAgent.findMany.mockResolvedValue([{ id: assigneeId }]);
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'rejected',
        });
        allowChannel();
        idGen.nextId.mockResolvedValue('pt_0000000010');
        prisma.plan.upsert.mockResolvedValue({ id: planId, status: 'reviewing' });

        await service.planSubmit(ctx, submitArgs);

        expect(prisma.plan.upsert).toHaveBeenCalledWith({
          where: { taskId },
          update: expect.objectContaining({
            status: 'reviewing',
            reviewerInstanceId: null,
          }),
          create: expect.any(Object),
        });
        expect(prisma.planTask.deleteMany).toHaveBeenCalledWith({
          where: { planId },
        });
        expect(prisma.planTask.create).toHaveBeenCalledTimes(2);
        expect(
          prisma.planTask.create.mock.calls.map(
            (c) => (c[0] as { data: { seq: number } }).data.seq,
          ),
        ).toEqual([1, 2]);
      });

      it('completed 终态同样可覆盖重提（不属于 409 活动态集合）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.taskAgent.findMany.mockResolvedValue([{ id: assigneeId }]);
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'completed',
        });
        prisma.plan.upsert.mockResolvedValue({ id: planId, status: 'reviewing' });
        await service.planSubmit(ctx, submitArgs);
        expect(prisma.plan.upsert).toHaveBeenCalled();
      });
    });

    describe('plan_review', () => {
      it('approved：主 Agent 评审通过 → plan.update(status=approved, reviewerInstanceId=null) + 系统消息', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'reviewing',
          reviewerInstanceId: reviewerId,
        });
        allowChannel();
        prisma.plan.update.mockResolvedValue({ id: planId, status: 'approved' });

        const out = await service.planReview(ctx, {
          taskId,
          selfInstanceId: mainInstanceId,
          verdict: 'approved',
        });

        expect(prisma.plan.update).toHaveBeenCalledWith({
          where: { id: planId },
          data: { status: 'approved', reviewerInstanceId: null },
        });
        expect(prisma.message.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            content: { text: '执行计划已通过评审，可启动实施', parts: [] },
          }),
        });
        expect(out).toEqual({ planId, status: 'approved' });
      });

      it('rejected 无 reason → 400 PLAN_STRUCTURE_INVALID（zod refine 失败路径）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'reviewing',
          reviewerInstanceId: reviewerId,
        });
        await expectCode(
          service.planReview(ctx, {
            taskId,
            selfInstanceId: mainInstanceId,
            verdict: 'rejected',
          }),
          BadRequestException,
          PLAN_ERRORS.PLAN_STRUCTURE_INVALID,
        );
        expect(prisma.plan.update).not.toHaveBeenCalled();
      });

      it('rejected 附 reason：评审驳回 → plan.update(status=rejected) + 引导文案系统消息', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'reviewing',
          reviewerInstanceId: reviewerId,
        });
        allowChannel();
        prisma.plan.update.mockResolvedValue({ id: planId, status: 'rejected' });

        const out = await service.planReview(ctx, {
          taskId,
          selfInstanceId: mainInstanceId,
          verdict: 'rejected',
          reason: '缺少验收标准',
        });

        expect(prisma.plan.update).toHaveBeenCalledWith({
          where: { id: planId },
          data: { status: 'rejected', reviewerInstanceId: null },
        });
        expect(prisma.message.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            content: {
              text: '执行计划被驳回：缺少验收标准（可修改后重提或切换 direct 模式）',
              parts: [],
            },
          }),
        });
        expect(out).toEqual({ planId, status: 'rejected' });
      });

      it('权限 403：非主 Agent 且非评审者 → PLATFORM_MCP_FORBIDDEN', async () => {
        allowWorkerAs(reviewerId);
        prisma.task.findUnique.mockResolvedValue(
          mainTaskRow({ mainAgentInstanceId: 'ta_other' }),
        );
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'reviewing',
          reviewerInstanceId: null,
        });
        await expectCode(
          service.planReview(ctx, {
            taskId,
            selfInstanceId: reviewerId,
            verdict: 'approved',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
      });

      it('仅 reviewing 可评审：status=approved → 400 PLAN_INVALID_STATUS', async () => {
        allowWorkerAs(reviewerId);
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'approved',
          reviewerInstanceId: reviewerId,
        });
        await expectCode(
          service.planReview(ctx, {
            taskId,
            selfInstanceId: reviewerId,
            verdict: 'approved',
          }),
          BadRequestException,
          PLAN_ERRORS.PLAN_INVALID_STATUS,
        );
      });

      it('被指派 reviewer 经 plan_review 成功（reviewer 权限联动，tc-review）：assignReviewer 后评审者通过 → 置 null + 系统消息', async () => {
        allowWorkerAs(reviewerId);
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        // plan_assign_reviewer 已写入 reviewerInstanceId → 评审者可评审
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'reviewing',
          reviewerInstanceId: reviewerId,
        });
        allowChannel();
        prisma.plan.update.mockResolvedValue({ id: planId, status: 'approved' });

        const out = await service.planReview(ctx, {
          taskId,
          selfInstanceId: reviewerId,
          verdict: 'approved',
        });

        expect(prisma.plan.update).toHaveBeenCalledWith({
          where: { id: planId },
          data: { status: 'approved', reviewerInstanceId: null },
        });
        expect(prisma.message.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            content: { text: '执行计划已通过评审，可启动实施', parts: [] },
          }),
        });
        expect(out).toEqual({ planId, status: 'approved' });
      });

      it('幽灵评审者回归（Oracle MED-A）：覆盖重提后 reviewerInstanceId=null，原评审者再评审 → 403', async () => {
        allowWorkerAs(reviewerId);
        prisma.task.findUnique.mockResolvedValue(
          mainTaskRow({ mainAgentInstanceId: 'ta_other' }),
        );
        // 覆盖重提（rejected → reviewing）后 reviewerInstanceId 被置 null
        prisma.plan.findUnique.mockResolvedValue({
          id: planId,
          status: 'reviewing',
          reviewerInstanceId: null,
        });
        await expectCode(
          service.planReview(ctx, {
            taskId,
            selfInstanceId: reviewerId,
            verdict: 'approved',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
      });
    });

    describe('plan_task_transition', () => {
      const planTaskRow = (overrides: Record<string, unknown> = {}) => ({
        id: planTaskId,
        planId,
        assigneeInstanceId: assigneeId,
        status: 'pending',
        plan: { taskId },
        ...overrides,
      });

      it('指派实例更新状态：planTask.update(status) 生效', async () => {
        allowWorkerAs(assigneeId);
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.planTask.findUnique.mockResolvedValue(planTaskRow());
        prisma.planTask.update.mockResolvedValue({
          id: planTaskId,
          status: 'in_progress',
        });
        prisma.planTask.findMany.mockResolvedValue([{ status: 'in_progress' }]);

        const out = await service.planTaskTransition(ctx, {
          taskId,
          selfInstanceId: assigneeId,
          planTaskId,
          status: 'in_progress',
        });

        expect(prisma.planTask.update).toHaveBeenCalledWith({
          where: { id: planTaskId },
          data: { status: 'in_progress' },
        });
        expect(out).toEqual({ planTaskId, status: 'in_progress' });
      });

      it('主 Agent 也可流转非本人指派的子任务（assignee/主实例双权限）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.planTask.findUnique.mockResolvedValue(planTaskRow());
        prisma.planTask.update.mockResolvedValue({
          id: planTaskId,
          status: 'done',
        });
        prisma.planTask.findMany.mockResolvedValue([{ status: 'pending' }]);
        await service.planTaskTransition(ctx, {
          taskId,
          selfInstanceId: mainInstanceId,
          planTaskId,
          status: 'done',
        });
        expect(prisma.planTask.update).toHaveBeenCalled();
      });

      it('权限 403：非指派实例且非主实例 → PLATFORM_MCP_FORBIDDEN', async () => {
        allowWorkerAs(reviewerId);
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.planTask.findUnique.mockResolvedValue(planTaskRow());
        await expectCode(
          service.planTaskTransition(ctx, {
            taskId,
            selfInstanceId: reviewerId,
            planTaskId,
            status: 'done',
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.planTask.update).not.toHaveBeenCalled();
      });

      it('planTask 不属于该任务 → 404 PLAN_NOT_FOUND', async () => {
        allowWorkerAs(assigneeId);
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.planTask.findUnique.mockResolvedValue(
          planTaskRow({ plan: { taskId: 't_other' } }),
        );
        await expectCode(
          service.planTaskTransition(ctx, {
            taskId,
            selfInstanceId: assigneeId,
            planTaskId,
            status: 'done',
          }),
          NotFoundException,
          PLAN_ERRORS.PLAN_NOT_FOUND,
        );
      });

      it('全部子任务达终态（done/blocked/skipped 且无 pending/in_progress）→ 群聊提示可提交验收', async () => {
        allowWorkerAs(assigneeId);
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.planTask.findUnique.mockResolvedValue(
          planTaskRow({ status: 'in_progress' }),
        );
        prisma.planTask.update.mockResolvedValue({
          id: planTaskId,
          status: 'done',
        });
        prisma.planTask.findMany.mockResolvedValue([
          { status: 'done' },
          { status: 'blocked' },
        ]);
        allowChannel();

        await service.planTaskTransition(ctx, {
          taskId,
          selfInstanceId: assigneeId,
          planTaskId,
          status: 'done',
        });

        expect(prisma.message.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            content: { text: '执行计划任务已全部完成，可提交验收', parts: [] },
          }),
        });
      });

      it('仍有 pending/in_progress 子任务 → 不生成完成提示', async () => {
        allowWorkerAs(assigneeId);
        prisma.task.findUnique.mockResolvedValue(mainTaskRow());
        prisma.planTask.findUnique.mockResolvedValue(planTaskRow());
        prisma.planTask.update.mockResolvedValue({
          id: planTaskId,
          status: 'done',
        });
        prisma.planTask.findMany.mockResolvedValue([
          { status: 'done' },
          { status: 'pending' },
        ]);

        await service.planTaskTransition(ctx, {
          taskId,
          selfInstanceId: assigneeId,
          planTaskId,
          status: 'done',
        });

        expect(prisma.message.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('team_view / my_profile（团队感知，只读，tc-mcp-l1 Todo 3）', () => {
    const mainInstanceId = 'ta_main';

    describe('team_view', () => {
      it('返回成员列表（含会话实时状态 sessionStatus/sessionId）+ planSummary 计数', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({
          id: taskId,
          mainAgentInstanceId: mainInstanceId,
        });
        prisma.taskAgent.findMany.mockResolvedValue([
          {
            id: mainInstanceId,
            agentId: 'a_pm',
            alias: '项目经理-1',
            seq: 1,
            agent: { role: 'project_manager' },
            sessions: [{ id: 's_1', status: 'running' }],
          },
          {
            id: 'ta_dev',
            agentId: 'a_dev',
            alias: '开发者-1',
            seq: 1,
            agent: { role: 'developer' },
            sessions: [],
          },
        ]);
        prisma.planTask.findMany.mockResolvedValue([
          { status: 'done' },
          { status: 'blocked' },
          { status: 'pending' },
          { status: 'in_progress' },
        ]);

        const out = await service.teamView(ctx, { taskId });

        expect(prisma.session.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { taskId, workerId } }),
        );
        expect(prisma.taskAgent.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { taskId, removedAt: null },
            orderBy: { joinedAt: 'asc' },
            select: expect.objectContaining({
              sessions: {
                orderBy: { createdAt: 'asc' },
                select: { id: true, status: true },
              },
            }),
          }),
        );
        expect(prisma.planTask.findMany).toHaveBeenCalledWith({
          where: { plan: { taskId } },
          select: { status: true },
        });
        expect(out).toEqual({
          taskId,
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
              id: 'ta_dev',
              agentId: 'a_dev',
              alias: '开发者-1',
              role: 'developer',
              seq: 1,
              main: false,
              sessionStatus: null,
              sessionId: null,
            },
          ],
          planSummary: { total: 4, done: 2, pending: 2 },
        });
      });

      it('无计划子任务 → planSummary 全 0', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({
          id: taskId,
          mainAgentInstanceId: mainInstanceId,
        });
        prisma.taskAgent.findMany.mockResolvedValue([]);
        prisma.planTask.findMany.mockResolvedValue([]);

        const out = await service.teamView(ctx, { taskId });

        expect(out.planSummary).toEqual({ total: 0, done: 0, pending: 0 });
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
        expect(prisma.taskAgent.findMany).not.toHaveBeenCalled();
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
      const agentRow = (overrides: Record<string, unknown> = {}) => ({
        id: senderInstanceId,
        agentId: senderAgentId,
        alias: '开发者-1',
        seq: 1,
        workDir: '/data/vteam-worker/developer-1',
        agent: {
          id: senderAgentId,
          name: '开发者',
          role: 'developer',
          prompt: longPrompt,
          defaultModelId: 'm_1',
          permissionScope: { tools: ['read', 'write'] },
          toolEffects: [
            { toolAction: 'read_file', effect: '读取工作区文件' },
          ],
        },
        ...overrides,
      });

      it('返回自身配置：角色/权限范围/toolEffects/模型 + prompt 摘要截断（前 500 字符）', async () => {
        allowWorker();
        prisma.taskAgent.findFirst.mockResolvedValue(agentRow());

        const out = await service.myProfile(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
        });

        expect(prisma.session.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { taskId, workerId, taskAgentId: senderInstanceId },
          }),
        );
        expect(prisma.taskAgent.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: senderInstanceId, taskId, removedAt: null },
            select: expect.objectContaining({
              agent: expect.objectContaining({
                select: expect.objectContaining({
                  prompt: true,
                  permissionScope: true,
                  toolEffects: { select: { toolAction: true, effect: true } },
                }),
              }),
            }),
          }),
        );
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
          permissionScope: { tools: ['read', 'write'] },
          toolEffects: [
            { toolAction: 'read_file', effect: '读取工作区文件' },
          ],
          promptSummary: 'x'.repeat(500),
          promptTruncated: true,
        });
      });

      it('prompt 长度 ≤500 → 原样返回 + promptTruncated=false', async () => {
        allowWorker();
        prisma.taskAgent.findFirst.mockResolvedValue(
          agentRow({
            agent: {
              id: senderAgentId,
              name: '开发者',
              role: 'developer',
              prompt: '简短提示词',
              defaultModelId: null,
              permissionScope: null,
              toolEffects: [],
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

      it('实例不在任务团队 → 404 PLATFORM_MCP_TASK_NOT_FOUND', async () => {
        allowWorker();
        prisma.taskAgent.findFirst.mockResolvedValue(null);
        await expectCode(
          service.myProfile(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
          }),
          NotFoundException,
          PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        );
      });

      it('归属 403：selfInstanceId 与 session.taskAgentId 不一致（防冒充）', async () => {
        prisma.session.findFirst.mockResolvedValue({
          id: 's_1',
          agentId: 'a_other',
          taskAgentId: 'ta_other',
        });
        await expectCode(
          service.myProfile(ctx, {
            taskId,
            selfInstanceId: senderInstanceId,
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
      });
    });
  });

  describe('plan_get / plan_assign_reviewer（评审通道，tc-review Todo 5）', () => {
    const planId = 'pl_0000000001';
    const mainInstanceId = 'ta_main';
    const reviewerId = 'ta_reviewer';

    describe('plan_get', () => {
      const planRow = (overrides: Record<string, unknown> = {}) => ({
        id: planId,
        taskId,
        title: '实施稻邕线消缺',
        summary: null,
        scopeIn: null,
        scopeOut: null,
        status: 'reviewing',
        createdBy: mainInstanceId,
        reviewerInstanceId: reviewerId,
        createdAt: new Date('2026-08-16T00:00:00.000Z'),
        updatedAt: new Date('2026-08-16T00:00:00.000Z'),
        ...overrides,
      });

      it('只读返回计划头 + 任务清单全文（content 六要素 + 指派概览）', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ id: taskId });
        prisma.plan.findUnique.mockResolvedValue(planRow());
        prisma.planTask.findMany.mockResolvedValue([
          {
            id: 'pt_0000000001',
            seq: 1,
            title: '定位故障点',
            content: {
              what: '定位故障点',
              mustNot: '禁止带电作业',
              references: null,
              acceptance: '故障点定位准确',
              qa: null,
              commit: null,
            },
            assigneeInstanceId: reviewerId,
            status: 'pending',
          },
        ]);
        prisma.taskAgent.findMany.mockResolvedValue([
          {
            id: reviewerId,
            alias: '开发者-1',
            agent: { name: '开发者' },
          },
        ]);

        const out = await service.planGet(ctx, { taskId });

        expect(prisma.session.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { taskId, workerId } }),
        );
        expect(prisma.planTask.findMany).toHaveBeenCalledWith({
          where: { planId },
          orderBy: { seq: 'asc' },
        });
        expect(out).toEqual({
          id: planId,
          taskId,
          title: '实施稻邕线消缺',
          summary: null,
          scopeIn: null,
          scopeOut: null,
          status: 'reviewing',
          createdBy: mainInstanceId,
          reviewerInstanceId: reviewerId,
          createdAt: '2026-08-16T00:00:00.000Z',
          updatedAt: '2026-08-16T00:00:00.000Z',
          tasks: [
            {
              id: 'pt_0000000001',
              seq: 1,
              title: '定位故障点',
              content: {
                what: '定位故障点',
                mustNot: '禁止带电作业',
                references: null,
                acceptance: '故障点定位准确',
                qa: null,
                commit: null,
              },
              assigneeInstanceId: reviewerId,
              assigneeAlias: '开发者-1',
              assigneeName: '开发者',
              status: 'pending',
            },
          ],
        });
      });

      it('planId 提供时按归属校验（findFirst id+taskId），planId 属于他任务 → 404 PLAN_NOT_FOUND', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ id: taskId });
        prisma.plan.findFirst.mockResolvedValue(null);

        await expectCode(
          service.planGet(ctx, { taskId, planId }),
          NotFoundException,
          PLAN_ERRORS.PLAN_NOT_FOUND,
        );
        expect(prisma.plan.findFirst).toHaveBeenCalledWith({
          where: { id: planId, taskId },
        });
      });

      it('任务无计划 → 404 PLAN_NOT_FOUND', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue({ id: taskId });
        prisma.plan.findUnique.mockResolvedValue(null);

        await expectCode(
          service.planGet(ctx, { taskId }),
          NotFoundException,
          PLAN_ERRORS.PLAN_NOT_FOUND,
        );
      });

      it('只读归属 403：无 Session → PLATFORM_MCP_FORBIDDEN', async () => {
        denyWorker();
        await expectCode(
          service.planGet(ctx, { taskId }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.plan.findUnique).not.toHaveBeenCalled();
      });

      it('任务不存在 → 404 PLATFORM_MCP_TASK_NOT_FOUND', async () => {
        allowWorker();
        prisma.task.findUnique.mockResolvedValue(null);
        await expectCode(
          service.planGet(ctx, { taskId }),
          NotFoundException,
          PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        );
        expect(prisma.plan.findUnique).not.toHaveBeenCalled();
      });
    });

    describe('plan_assign_reviewer', () => {
      it('主 Agent 指派评审者 → 复用 PlansService.assignReviewer 落库 + 系统消息', async () => {
        allowWorkerAs(mainInstanceId);
        prisma.task.findUnique.mockResolvedValue({
          mainAgentInstanceId: mainInstanceId,
        });
        prisma.plan.findUnique.mockResolvedValue({ id: planId });
        plansService.assignReviewer.mockResolvedValue({
          planId,
          taskId,
          reviewerInstanceId: reviewerId,
          reviewerAlias: '开发者-1',
        });

        const out = await service.planAssignReviewer(ctx, {
          taskId,
          selfInstanceId: mainInstanceId,
          reviewerInstanceId: reviewerId,
        });

        expect(prisma.plan.findUnique).toHaveBeenCalledWith({
          where: { taskId },
          select: { id: true },
        });
        expect(plansService.assignReviewer).toHaveBeenCalledWith(
          planId,
          reviewerId,
        );
        expect(out).toEqual({
          planId,
          taskId,
          reviewerInstanceId: reviewerId,
          reviewerAlias: '开发者-1',
        });
      });

      it('仅主实例可调：非主实例 → 403 PLATFORM_MCP_FORBIDDEN（不触达 assignReviewer）', async () => {
        allowWorkerAs(reviewerId);
        prisma.task.findUnique.mockResolvedValue({
          mainAgentInstanceId: mainInstanceId,
        });

        await expectCode(
          service.planAssignReviewer(ctx, {
            taskId,
            selfInstanceId: reviewerId,
            reviewerInstanceId: reviewerId,
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
        expect(prisma.plan.findUnique).not.toHaveBeenCalled();
        expect(plansService.assignReviewer).not.toHaveBeenCalled();
      });

      it('任务不存在 → 404 PLATFORM_MCP_TASK_NOT_FOUND', async () => {
        allowWorkerAs(mainInstanceId);
        prisma.task.findUnique.mockResolvedValue(null);
        await expectCode(
          service.planAssignReviewer(ctx, {
            taskId,
            selfInstanceId: mainInstanceId,
            reviewerInstanceId: reviewerId,
          }),
          NotFoundException,
          PLATFORM_MCP_ERRORS.TASK_NOT_FOUND,
        );
      });

      it('任务无计划 → 404 PLAN_NOT_FOUND', async () => {
        allowWorkerAs(mainInstanceId);
        prisma.task.findUnique.mockResolvedValue({
          mainAgentInstanceId: mainInstanceId,
        });
        prisma.plan.findUnique.mockResolvedValue(null);
        await expectCode(
          service.planAssignReviewer(ctx, {
            taskId,
            selfInstanceId: mainInstanceId,
            reviewerInstanceId: reviewerId,
          }),
          NotFoundException,
          PLAN_ERRORS.PLAN_NOT_FOUND,
        );
        expect(plansService.assignReviewer).not.toHaveBeenCalled();
      });

      it('归属 403：无 Session → PLATFORM_MCP_FORBIDDEN', async () => {
        denyWorker();
        await expectCode(
          service.planAssignReviewer(ctx, {
            taskId,
            selfInstanceId: mainInstanceId,
            reviewerInstanceId: reviewerId,
          }),
          ForbiddenException,
          PLATFORM_MCP_ERRORS.FORBIDDEN,
        );
      });
    });
  });

  describe('team_add_member（主 Agent 申请增员确认门，L2 自治）', () => {
    const mainInstanceId = 'ta_main';

    /** 主实例归属校验通过（session 绑定主实例）。 */
    const allowMainWorker = () => allowWorkerAs(mainInstanceId);

    /** 默认基线：主实例任务 + 目标 agent 存在 + 未加入 + 无 pending 申请。 */
    const mockBaseline = (
      opts: { existing?: unknown; pending?: unknown[] } = {},
    ) => {
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        mainAgentInstanceId: mainInstanceId,
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_developer',
        name: '开发者',
        role: 'developer',
      });
      prisma.taskAgent.findFirst.mockResolvedValue(opts.existing ?? null);
      prisma.agentQuestion.findMany.mockResolvedValue(opts.pending ?? []);
    };

    /** 捕获 createForPlatform 注册的 onResolved 钩子（teamAddMember 闭包）。 */
    const captureHook = () => {
      let hook: ((args: {
        answers: string[][] | null;
        actor: { type: string; id: string };
      }) => Promise<void>) | null = null;
      questionsService.createForPlatform.mockImplementation(
        async (
          _taskId: string,
          _question: unknown,
          opts: { onResolved?: (args: {
            answers: string[][] | null;
            actor: { type: string; id: string };
          }) => Promise<void> },
        ) => {
          hook = opts.onResolved ?? null;
          return { id: 'aq_1', requestId: 'que_platform_0000000001' };
        },
      );
      return () => hook;
    };

    it('非主实例 → 403 PLATFORM_MCP_FORBIDDEN（仅主 Agent 可申请增员）', async () => {
      allowWorker();
      prisma.task.findUnique.mockResolvedValue({
        id: taskId,
        mainAgentInstanceId: mainInstanceId,
      });
      await expectCode(
        service.teamAddMember(ctx, {
          taskId,
          selfInstanceId: senderInstanceId,
          agentId: 'a_developer',
        }),
        ForbiddenException,
        PLATFORM_MCP_ERRORS.FORBIDDEN,
      );
      expect(questionsService.createForPlatform).not.toHaveBeenCalled();
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
          question: '主 Agent 申请将 开发者（别名 开发者-2）加入团队，是否确认？',
          header: '团队增员确认',
          options: ['确认', '拒绝'],
        },
        expect.objectContaining({
          agentId: 'a_developer',
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
          question: '主 Agent 申请将 开发者 加入团队，是否确认？',
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

      await getHook()!({ answers: [['确认']], actor: { type: 'user', id: 'u_1' } });

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
        { actorType: 'agent', actorId: mainInstanceId, confirmedBy: '主 Agent' },
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
});

