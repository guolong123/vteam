import {
  BadRequestException,
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
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';

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
  let tasksService: { transitionByAgent: jest.Mock };

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
    tasksService = { transitionByAgent: jest.fn() };

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
      );
      expect(out).toMatchObject({ status: 'in_progress' });
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
});
