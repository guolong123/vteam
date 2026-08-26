import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  WorkerClient,
  WorkerUnavailableException,
} from '../workers/worker.client';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import { QUESTIONS_ERRORS } from './questions.constants';
import { QuestionsService } from './questions.service';

describe('QuestionsService（AgentQuestion 读/回复：worker 转发 + 落库 + emit 收敛）', () => {
  let service: QuestionsService;
  let prisma: {
    agentQuestion: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    session: { findUnique: jest.Mock; findFirst: jest.Mock };
    worker: { findUnique: jest.Mock };
    task: { findUnique: jest.Mock; findMany: jest.Mock };
  };
  let realtime: { emit: jest.Mock };
  let workerClient: { questionReply: jest.Mock; permissionReply: jest.Mock };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };

  const aqRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'aq_0000000001',
    requestId: 'que_1',
    sessionId: 's_1',
    taskId: 't_1',
    agentId: 'a_1',
    kind: 'question',
    content: {
      questions: [{ question: '继续吗？', header: '确认', options: [] }],
    },
    status: 'pending',
    answers: null,
    createdAt: new Date(),
    updatedAt: new Date('2026-08-12T00:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    idGen = { nextId: jest.fn(async () => 'aq_0000000001'), seed: jest.fn() };
    prisma = {
      agentQuestion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
      },
      session: { findUnique: jest.fn(), findFirst: jest.fn() },
      worker: { findUnique: jest.fn() },
      task: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 't_1', managedMode: false }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    realtime = { emit: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workerClient = {
      questionReply: jest.fn().mockResolvedValue(undefined),
      permissionReply: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuestionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
        { provide: WorkerClient, useValue: workerClient },
      ],
    }).compile();
    service = module.get<QuestionsService>(QuestionsService);
  });

  describe('findAll', () => {
    it('taskId + status 过滤 → 透传 DTO 列表（会话页补拉）', async () => {
      prisma.agentQuestion.findMany.mockResolvedValue([aqRow()]);
      const list = await service.findAll({ taskId: 't_1', status: 'pending' });
      expect(prisma.agentQuestion.findMany).toHaveBeenCalledWith({
        where: { taskId: 't_1', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'aq_0000000001',
        kind: 'question',
        status: 'pending',
      });
    });

    it('status 缺省 pending（会话页默认补拉待处理）', async () => {
      prisma.agentQuestion.findMany.mockResolvedValue([]);
      await service.findAll({ taskId: 't_1' });
      expect(prisma.agentQuestion.findMany).toHaveBeenCalledWith({
        where: { taskId: 't_1', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('pending 超 TTL → 惰性过期落库 expired + emit 收敛 + 重查过滤（僵尸弹窗不无限）', async () => {
      const stale = aqRow({
        id: 'aq_stale',
        requestId: 'per_stale',
        kind: 'permission',
        status: 'pending',
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      });
      prisma.agentQuestion.findMany
        .mockResolvedValueOnce([stale])
        .mockResolvedValueOnce([]);
      prisma.agentQuestion.update.mockResolvedValue(
        aqRow({ id: 'aq_stale', status: 'expired' }),
      );

      const list = await service.findAll({ taskId: 't_1', status: 'pending' });

      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_stale' },
        data: expect.objectContaining({ status: 'expired' }),
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({ resolved: true }),
        { type: 'task', id: 't_1' },
      );
      expect(list).toEqual([]);
    });

    it('pending 未超 TTL → 不过期不重查（原样返回）', async () => {
      const fresh = aqRow({ id: 'aq_fresh', createdAt: new Date() });
      prisma.agentQuestion.findMany.mockResolvedValue([fresh]);
      const list = await service.findAll({ taskId: 't_1', status: 'pending' });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
      expect(list).toHaveLength(1);
    });
  });

  describe('reply（question）', () => {
    it('answers 数组 → workerClient.questionReply 转发 → 落库 resolved + answers → emit {resolved}', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(aqRow());
      prisma.session.findUnique.mockResolvedValue({
        workerId: 'w_1',
        instanceRef: 'ses_abc',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: { execBaseUrl: 'http://worker:4198' },
      });
      const updated = aqRow({ status: 'resolved', answers: [['继续']] });
      prisma.agentQuestion.update.mockResolvedValue(updated);

      const result = await service.reply('aq_1', {
        answers: [['继续']],
      } as ReplyQuestionDto);

      expect(workerClient.questionReply).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: { execBaseUrl: 'http://worker:4198' } },
        { sessionId: 'ses_abc', requestId: 'que_1', answers: [['继续']] },
      );
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_0000000001' },
        data: { status: 'resolved', answers: [['继续']] },
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({ resolved: true, taskId: 't_1' }),
        { type: 'task', id: 't_1' },
      );
      expect(result.status).toBe('resolved');
    });

    it('answers=null → reject 转发 → 落库 rejected（用户拒绝）', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(aqRow());
      prisma.session.findUnique.mockResolvedValue({
        workerId: 'w_1',
        instanceRef: 'ses_abc',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      prisma.agentQuestion.update.mockResolvedValue(
        aqRow({ status: 'rejected', answers: null }),
      );

      await service.reply('aq_1', { answers: null } as ReplyQuestionDto);

      expect(workerClient.questionReply).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: {} },
        { sessionId: 'ses_abc', requestId: 'que_1', answers: null },
      );
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_0000000001' },
        data: { status: 'rejected', answers: null },
      });
    });
  });

  describe('reply（permission）', () => {
    it('response=once → workerClient.permissionReply 转发 → 落库 resolved + {response}', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(
        aqRow({
          id: 'aq_2',
          requestId: 'per_1',
          kind: 'permission',
          content: { title: 'bash', pattern: '/data/*' },
        }),
      );
      prisma.session.findUnique.mockResolvedValue({
        workerId: 'w_1',
        instanceRef: 'ses_abc',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      prisma.agentQuestion.update.mockResolvedValue(
        aqRow({
          id: 'aq_2',
          status: 'resolved',
          answers: { response: 'once' },
        }),
      );

      await service.reply('aq_2', { response: 'once' } as ReplyQuestionDto);

      expect(workerClient.permissionReply).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: {} },
        { sessionId: 'ses_abc', permissionId: 'per_1', response: 'once' },
      );
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_2' },
        data: { status: 'resolved', answers: { response: 'once' } },
      });
    });

    it('permission 缺 response → 400 QUESTION_INVALID_REPLY', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(
        aqRow({ kind: 'permission' }),
      );
      await expect(
        service.reply('aq_1', {} as ReplyQuestionDto),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY },
      });
    });
  });

  describe('reply 错误路径', () => {
    it('AgentQuestion 不存在 → 404 QUESTION_NOT_FOUND', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(null);
      await expect(
        service.reply('aq_missing', { answers: [['x']] } as ReplyQuestionDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('已终态（resolved）→ 400 QUESTION_ALREADY_RESOLVED（防重复回复）', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(
        aqRow({ status: 'resolved' }),
      );
      await expect(
        service.reply('aq_1', { answers: [['x']] } as ReplyQuestionDto),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_ALREADY_RESOLVED },
      });
    });

    it('question 缺 answers → 400 QUESTION_INVALID_REPLY', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(aqRow());
      await expect(
        service.reply('aq_1', {} as ReplyQuestionDto),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY },
      });
    });

    it('ses_ 前缀 sessionId（ingress 反查失败兜底）→ 直接透传 worker，worker 按 taskId+agentId 反查', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(
        aqRow({
          id: 'aq_3',
          requestId: 'que_3',
          sessionId: 'ses_abc',
          taskId: 't_9',
          agentId: 'a_9',
        }),
      );
      prisma.session.findUnique.mockResolvedValue(null); // ses_ 无主键记录
      prisma.session.findFirst.mockResolvedValue({ workerId: 'w_1' });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      prisma.agentQuestion.update.mockResolvedValue(
        aqRow({ id: 'aq_3', status: 'resolved' }),
      );

      await service.reply('aq_3', { answers: [['继续']] } as ReplyQuestionDto);

      expect(workerClient.questionReply).toHaveBeenCalledWith(
        { id: 'w_1', capabilities: {} },
        { sessionId: 'ses_abc', requestId: 'que_3', answers: [['继续']] },
      );
    });

    it('session 无 instanceRef → 503 QUESTION_WORKER_UNAVAILABLE（不静默）', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(aqRow());
      prisma.session.findUnique.mockResolvedValue({
        workerId: 'w_1',
        instanceRef: null,
      });
      await expect(
        service.reply('aq_1', { answers: [['x']] } as ReplyQuestionDto),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_WORKER_UNAVAILABLE },
      });
    });

    it('session 无绑定 worker → 503 QUESTION_WORKER_UNAVAILABLE', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(aqRow());
      prisma.session.findUnique.mockResolvedValue({
        workerId: null,
        instanceRef: 'ses_abc',
      });
      await expect(
        service.reply('aq_1', { answers: [['x']] } as ReplyQuestionDto),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_WORKER_UNAVAILABLE },
      });
    });

    it('workerClient 失败（worker 不可达）→ 向上抛 503 WorkerUnavailableException（不静默）', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(aqRow());
      prisma.session.findUnique.mockResolvedValue({
        workerId: 'w_1',
        instanceRef: 'ses_abc',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      workerClient.questionReply.mockRejectedValue(
        new ServiceUnavailableException('worker offline'),
      );

      await expect(
        service.reply('aq_1', { answers: [['x']] } as ReplyQuestionDto),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
    });

    it('僵尸 pending（转发 serve 404）→ 终态落库 expired + emit 收敛 + 抛 410 QUESTION_EXPIRED', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(
        aqRow({ id: 'aq_4', requestId: 'per_stale', kind: 'permission' }),
      );
      prisma.session.findUnique.mockResolvedValue({
        workerId: 'w_1',
        instanceRef: 'ses_abc',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      workerClient.permissionReply.mockRejectedValue(
        new WorkerUnavailableException('w_1', 'permission reply HTTP 404'),
      );
      prisma.agentQuestion.update.mockResolvedValue(
        aqRow({
          id: 'aq_4',
          status: 'expired',
          answers: {
            expired: true,
            reason: 'reply 转发 serve 404（per_stale）',
          },
        }),
      );

      await expect(
        service.reply('aq_4', { response: 'once' } as ReplyQuestionDto),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_EXPIRED },
      });
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_4' },
        data: expect.objectContaining({ status: 'expired' }),
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({ resolved: true, taskId: 't_1' }),
        { type: 'task', id: 't_1' },
      );
    });
  });

  describe('onModuleInit（重启续号）', () => {
    it('对齐 aq_ 前缀序号（resyncIdPrefix 幂等调用）', async () => {
      await service.onModuleInit();
      expect(prisma.agentQuestion.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'aq_' } },
        select: { id: true },
      });
    });
  });

  /** 平台 question 行（content.source='platform'，确认门场景）。 */
  const platformRow = (overrides: Record<string, unknown> = {}) =>
    aqRow({
      id: 'aq_platform',
      requestId: 'que_platform_0000000001',
      sessionId: 's_main',
      content: {
        questions: [
          {
            question: '主 Agent 申请将 开发者 加入团队，是否确认？',
            header: '团队增员确认',
            options: [
              { label: '确认', description: '' },
              { label: '拒绝', description: '' },
            ],
          },
        ],
        source: 'platform',
      },
      ...overrides,
    });

  describe('createForPlatform（平台侧创建确认门 question，L2 自治）', () => {
    it('创建落库：que_platform_ requestId + 主 Agent 会话占位 + content 前端形状(source=platform) + emit AGENT_QUESTION', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        mainAgentInstanceId: 'ta_main',
        managedMode: false,
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
      prisma.agentQuestion.create.mockResolvedValue(platformRow());

      const result = await service.createForPlatform(
        't_1',
        {
          question: '主 Agent 申请将 开发者 加入团队，是否确认？',
          header: '团队增员确认',
          options: ['确认', '拒绝'],
        },
        { agentId: 'a_1' },
      );

      expect(prisma.agentQuestion.create).toHaveBeenCalledWith({
        data: {
          id: 'aq_0000000001',
          requestId: 'que_platform_0000000001',
          sessionId: 's_main',
          taskId: 't_1',
          agentId: 'a_1',
          kind: 'question',
          content: {
            questions: [
              {
                question: '主 Agent 申请将 开发者 加入团队，是否确认？',
                header: '团队增员确认',
                options: [
                  { label: '确认', description: '' },
                  { label: '拒绝', description: '' },
                ],
              },
            ],
            source: 'platform',
          },
          status: 'pending',
        },
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({
          taskId: 't_1',
          question: expect.objectContaining({
            requestId: 'que_platform_0000000001',
          }),
        }),
        { type: 'task', id: 't_1' },
      );
      expect(result.requestId).toBe('que_platform_0000000001');
    });

    it('无主 Agent 会话 → sessionId 占位符（s_placeholder，仅满足非空约束不实际转发）', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        mainAgentInstanceId: null,
        managedMode: false,
      });
      prisma.agentQuestion.create.mockResolvedValue(
        platformRow({ sessionId: 's_placeholder' }),
      );

      await service.createForPlatform('t_1', {
        question: 'Q',
        options: ['确认', '拒绝'],
      });

      expect(prisma.agentQuestion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sessionId: 's_placeholder' }),
      });
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('平台 question 短路（Oracle R2 旁路：不转发 worker）', () => {
    it('reply 平台 question → workerClient 不调用 → 终态落库 + hook 收到二维 answers + emit resolved 收敛', async () => {
      const hook = jest.fn().mockResolvedValue(undefined);
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        mainAgentInstanceId: 'ta_main',
        managedMode: false,
      });
      prisma.agentQuestion.create.mockResolvedValue(platformRow());
      await service.createForPlatform(
        't_1',
        { question: 'Q', options: ['确认', '拒绝'] },
        { onResolved: hook },
      );

      prisma.agentQuestion.findUnique.mockResolvedValue(platformRow());
      prisma.agentQuestion.update.mockResolvedValue(
        platformRow({ status: 'resolved', answers: [['确认']] }),
      );

      const result = await service.reply(
        'aq_platform',
        { answers: [['确认']] } as ReplyQuestionDto,
        'u_1',
      );

      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(prisma.session.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_platform' },
        data: { status: 'resolved', answers: [['确认']] },
      });
      expect(hook).toHaveBeenCalledWith({
        answers: [['确认']],
        actor: { type: 'user', id: 'u_1' },
      });
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({ resolved: true, taskId: 't_1' }),
        { type: 'task', id: 't_1' },
      );
      expect(result.status).toBe('resolved');
    });

    it('confirmByAgent 平台 question → 旁路 + hook actor={type:agent, id:主实例}', async () => {
      const hook = jest.fn().mockResolvedValue(undefined);
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        mainAgentInstanceId: 'ta_main',
        managedMode: false,
      });
      prisma.agentQuestion.create.mockResolvedValue(platformRow());
      await service.createForPlatform(
        't_1',
        { question: 'Q', options: ['确认', '拒绝'] },
        { onResolved: hook },
      );

      prisma.agentQuestion.findUnique.mockResolvedValue(platformRow());
      prisma.agentQuestion.update.mockResolvedValue(
        platformRow({ status: 'resolved', answers: [['确认']] }),
      );

      const result = await service.confirmByAgent({
        taskId: 't_1',
        instanceId: 'ta_main',
        requestId: 'que_platform_0000000001',
        kind: 'question',
        answers: [['确认']],
      });

      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(hook).toHaveBeenCalledWith({
        answers: [['确认']],
        actor: { type: 'agent', id: 'ta_main' },
      });
      expect(result.status).toBe('resolved');
    });

    it('拒绝（answers=null）→ 终态落库 rejected + hook 收到 answers=null（拒绝不执行）', async () => {
      const hook = jest.fn().mockResolvedValue(undefined);
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        mainAgentInstanceId: 'ta_main',
        managedMode: false,
      });
      prisma.agentQuestion.create.mockResolvedValue(platformRow());
      await service.createForPlatform(
        't_1',
        { question: 'Q', options: ['确认', '拒绝'] },
        { onResolved: hook },
      );

      prisma.agentQuestion.findUnique.mockResolvedValue(platformRow());
      prisma.agentQuestion.update.mockResolvedValue(
        platformRow({ status: 'rejected', answers: null }),
      );

      await service.reply(
        'aq_platform',
        { answers: null } as ReplyQuestionDto,
        'u_1',
      );

      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_platform' },
        data: { status: 'rejected', answers: null },
      });
      expect(hook).toHaveBeenCalledWith({
        answers: null,
        actor: { type: 'user', id: 'u_1' },
      });
    });

    it('hook 抛错（如终态回调）→ 不阻塞弹窗收敛（question 已终态落库）', async () => {
      const hook = jest.fn().mockRejectedValue(new Error('updateTeam 409'));
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        mainAgentInstanceId: 'ta_main',
        managedMode: false,
      });
      prisma.agentQuestion.create.mockResolvedValue(platformRow());
      await service.createForPlatform(
        't_1',
        { question: 'Q', options: ['确认', '拒绝'] },
        { onResolved: hook },
      );

      prisma.agentQuestion.findUnique.mockResolvedValue(platformRow());
      prisma.agentQuestion.update.mockResolvedValue(
        platformRow({ status: 'resolved', answers: [['确认']] }),
      );

      const result = await service.reply(
        'aq_platform',
        { answers: [['确认']] } as ReplyQuestionDto,
        'u_1',
      );

      expect(result.status).toBe('resolved');
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({ resolved: true }),
        { type: 'task', id: 't_1' },
      );
    });
  });
});
