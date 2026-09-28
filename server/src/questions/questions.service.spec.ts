import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  WorkerClient,
  WorkerUnavailableException,
} from '../workers/worker.client';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import {
  AGENT_QUESTION_KINDS,
  QUESTION_CONFIRM_INTEGRITY_ERRORS,
  QUESTIONS_ERRORS,
  SECRET_INPUT_BUDGET_MS,
  SECRET_QUESTION_SOURCE,
} from './questions.constants';
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
    session: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
    };
    worker: { findUnique: jest.Mock };
    task: { findUnique: jest.Mock; findMany: jest.Mock };
    team: { findUnique: jest.Mock; findMany: jest.Mock };
    teamMember: { findFirst: jest.Mock };
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
      session: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      worker: { findUnique: jest.fn() },
      team: {
        findUnique: jest.fn().mockResolvedValue({ managedMode: false }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      teamMember: { findFirst: jest.fn() },
      task: {
        findUnique: jest.fn().mockResolvedValue({ id: 't_1', teamId: 'tm_1' }),
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
        { type: 'team', id: 'tm_1' },
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

    it('teamId 过滤 → 任务归属 + 会话归属双路 OR（无 schema 变更）', async () => {
      prisma.task.findMany.mockResolvedValue([{ id: 't_1' }, { id: 't_2' }]);
      prisma.session.findMany.mockResolvedValue([{ id: 's_1' }]);
      prisma.agentQuestion.findMany.mockResolvedValue([aqRow()]);

      const list = await service.findAll({ teamId: 'tm_1' });

      expect(prisma.task.findMany).toHaveBeenCalledWith({
        where: { teamId: 'tm_1' },
        select: { id: true },
      });
      expect(prisma.session.findMany).toHaveBeenCalledWith({
        where: { teamId: 'tm_1' },
        select: { id: true },
      });
      expect(prisma.agentQuestion.findMany).toHaveBeenCalledWith({
        where: {
          status: 'pending',
          OR: [
            { taskId: { in: ['t_1', 't_2'] } },
            { sessionId: { in: ['s_1'] } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
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
        { type: 'team', id: 'tm_1' },
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

    it('Todo9 failing-first：任务有团队归属但团队行缺失 → 404 QUESTION_TEAM_NOT_FOUND（托管读团队行）', async () => {
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
        aqRow({ status: 'resolved', answers: [['继续']] }),
      );
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue(null);
      await expect(
        service.reply('aq_1', { answers: [['继续']] } as ReplyQuestionDto),
      ).rejects.toMatchObject({
        response: { code: 'QUESTION_TEAM_NOT_FOUND' },
      });
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

    it('ses_ 前缀 sessionId（ingress 反查失败兜底）→ 直接透传 worker，worker 按团队会话（teamId + 团队成员）反查', async () => {
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
      prisma.task.findUnique.mockResolvedValue({
        id: 't_9',
        teamId: 'tm_9',
        managedMode: false,
      });
      prisma.teamMember.findFirst.mockResolvedValue({
        id: 'tmm_9',
        agentId: 'a_9',
      });
      prisma.session.findFirst.mockResolvedValue({ workerId: 'w_1' });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_1',
        capabilities: {},
      });
      prisma.agentQuestion.update.mockResolvedValue(
        aqRow({ id: 'aq_3', status: 'resolved' }),
      );

      await service.reply('aq_3', { answers: [['继续']] } as ReplyQuestionDto);

      expect(prisma.teamMember.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_9', agentId: 'a_9' },
        select: { id: true },
      });
      expect(prisma.session.findFirst).toHaveBeenCalledWith({
        where: {
          teamId: 'tm_9',
          teamMemberId: 'tmm_9',
          workerId: { not: null },
        },
        select: { workerId: true },
        orderBy: { updatedAt: 'desc' },
      });
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
        { type: 'team', id: 'tm_1' },
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

    it('重启后 que 计数器从 request_id 最大数字尾段续号（...07 → ...08，不重发 ...01 撞 P2002）', async () => {
      // 模拟进程重启：全新的 IdGeneratorService（内存计数器全空 = 重启归零）。
      const restartedModule = await Test.createTestingModule({
        providers: [
          QuestionsService,
          { provide: PrismaService, useValue: prisma },
          { provide: IdGeneratorService, useValue: new IdGeneratorService() },
          { provide: RealtimeService, useValue: realtime },
          { provide: WorkerClient, useValue: workerClient },
        ],
      }).compile();
      const restarted = restartedModule.get<QuestionsService>(QuestionsService);

      prisma.agentQuestion.findMany.mockImplementation(
        (args: {
          where?: {
            id?: { startsWith?: string };
            requestId?: { startsWith?: string };
          };
          select?: Record<string, boolean>;
        }) => {
          if (args?.where?.requestId?.startsWith === 'que_platform_') {
            return Promise.resolve([
              { requestId: 'que_platform_0000000007' },
              { requestId: 'que_platform_not-a-seq' }, // 非数字尾段必须忽略
              { requestId: 'que_platform_' }, // 空尾段必须忽略
              { requestId: `que_platform_${'9'.repeat(25)}` }, // 超安全整数尾段必须忽略
              { requestId: 'per_0000000099' }, // 非 que_platform_ 行不参与
            ]);
          }
          return Promise.resolve([]); // aq_ 续号：重启后空表
        },
      );
      prisma.team.findUnique.mockResolvedValue({
        managedMode: false,
        mainAgentMemberId: 'tmm_main',
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
      prisma.agentQuestion.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(aqRow({ ...data })),
      );

      await restarted.onModuleInit();

      // 必须真的按 request_id 前缀查询（防“没查也算绿”的假成功）
      expect(prisma.agentQuestion.findMany).toHaveBeenCalledWith({
        where: { requestId: { startsWith: 'que_platform_' } },
        select: { requestId: true },
      });

      const input = {
        template: 'echo $TOKEN',
        variables: [{ name: 'TOKEN', secret: true }],
      };
      const first = await restarted.createSecretForPlatform('t_1', input, {
        agentId: 'a_1',
      });
      const firstInsert =
        prisma.agentQuestion.create.mock.calls[
          prisma.agentQuestion.create.mock.calls.length - 1
        ][0];
      // 断言实际生成并落库的 requestId（而非仅 seed 被调用）
      expect(firstInsert.data.requestId).toBe('que_platform_0000000008');
      expect(first.requestId).toBe('que_platform_0000000008');
      expect(first.requestId).not.toBe('que_platform_0000000001');

      const second = await restarted.createSecretForPlatform('t_1', input, {
        agentId: 'a_1',
      });
      expect(second.requestId).toBe('que_platform_0000000009');
      expect(
        prisma.agentQuestion.create.mock.calls[
          prisma.agentQuestion.create.mock.calls.length - 1
        ][0].data.requestId,
      ).toBe('que_platform_0000000009');
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
            question: '申请将 开发者 加入团队，是否确认？',
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

  describe('createForPlatform（平台侧创建确认门 question，L2 自治，会话占位走团队主成员会话）', () => {
    it('创建落库：que_platform_ requestId + 主成员团队会话占位 + content 前端形状(source=platform) + emit AGENT_QUESTION', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        teamId: 'tm_1',
        managedMode: false,
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
      prisma.agentQuestion.create.mockResolvedValue(platformRow());

      const result = await service.createForPlatform(
        't_1',
        {
          question: '申请将 开发者 加入团队，是否确认？',
          header: '团队增员确认',
          options: ['确认', '拒绝'],
        },
        { agentId: 'a_1', requesterInstanceId: 'tmm_sender' },
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
                question: '申请将 开发者 加入团队，是否确认？',
                header: '团队增员确认',
                options: [
                  { label: '确认', description: '' },
                  { label: '拒绝', description: '' },
                ],
              },
            ],
            source: 'platform',
            requesterInstanceId: 'tmm_sender',
          },
          status: 'pending',
        },
      });
      // Todo 12:团队域投递 — create emit 须带顶层 teamId（与 scope 同源），
      // 否则 web matchesScope team: 兜底按真实 t_... taskId 匹配失败、实时帧被丢弃。
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({
          taskId: 't_1',
          teamId: 'tm_1',
          question: expect.objectContaining({
            requestId: 'que_platform_0000000001',
          }),
        }),
        { type: 'team', id: 'tm_1' },
      );
      expect(result.requestId).toBe('que_platform_0000000001');
    });

    it('无主成员团队会话 → sessionId 占位符（s_placeholder，仅满足非空约束不实际转发）', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        teamId: 'tm_1',
        managedMode: false,
      });
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: null });
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
        teamId: 'tm_1',
      });
      prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_1' });
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
      expect(prisma.session.findUnique).toHaveBeenCalledWith({
        where: { id: 's_main' },
        select: { teamId: true },
      });
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
        { type: 'team', id: 'tm_1' },
      );
      expect(result.status).toBe('resolved');
    });

    it('confirmByAgent 平台 question → 旁路 + hook actor={type:agent, id:主成员}', async () => {
      const hook = jest.fn().mockResolvedValue(undefined);
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        teamId: 'tm_1',
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
        managedMode: true,
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
        instanceId: 'tmm_main',
        requestId: 'que_platform_0000000001',
        kind: 'question',
        answers: [['确认']],
      });

      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(hook).toHaveBeenCalledWith({
        answers: [['确认']],
        actor: { type: 'agent', id: 'tmm_main' },
      });
      expect(result.status).toBe('resolved');
    });

    it('confirmByAgent 非主成员不再被身份门拒绝 → 正常终态落库（原团队主门 403 已移除）', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        teamId: 'tm_1',
      });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
        managedMode: true,
      });
      prisma.agentQuestion.findUnique.mockResolvedValue(platformRow());
      prisma.session.findUnique.mockResolvedValue({
        teamMemberId: 'tmm_sender',
      });
      prisma.agentQuestion.update.mockResolvedValue(
        platformRow({ status: 'resolved', answers: [['确认']] }),
      );

      const result = await service.confirmByAgent({
        taskId: 't_1',
        instanceId: 'tmm_other',
        requestId: 'que_platform_0000000001',
        kind: 'question',
        answers: [['确认']],
      });

      expect(result.status).toBe('resolved');
    });

    it('confirmByAgent 自批（发起者会话成员 == 确认者）→ 403 SELF_CONFIRMATION_FORBIDDEN', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        teamId: 'tm_1',
      });
      prisma.agentQuestion.findUnique.mockResolvedValue(platformRow());
      prisma.session.findUnique.mockResolvedValue({
        teamMemberId: 'tmm_other',
      });

      const err = await service
        .confirmByAgent({
          taskId: 't_1',
          instanceId: 'tmm_other',
          requestId: 'que_platform_0000000001',
          kind: 'question',
          answers: [['确认']],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.SELF_CONFIRMATION_FORBIDDEN,
      });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
    });

    it('confirmByAgent 跨任务确认（请求归属他任务）→ 403 CROSS_TASK_FORBIDDEN', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        teamId: 'tm_1',
      });
      prisma.agentQuestion.findUnique.mockResolvedValue(
        platformRow({ taskId: 't_other' }),
      );

      const err = await service
        .confirmByAgent({
          taskId: 't_1',
          instanceId: 'tmm_main',
          requestId: 'que_platform_0000000001',
          kind: 'question',
          answers: [['确认']],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.CROSS_TASK_FORBIDDEN,
      });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
    });

    it('confirmByAgent team:<id> 形态（团队会话行 taskId 空）→ 会话团队归属校验通过 + 收敛帧补 team 形态', async () => {
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_9',
        mainAgentMemberId: 'tmm_main',
      });
      prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_9' });
      prisma.agentQuestion.findUnique.mockResolvedValue(
        platformRow({ taskId: '', sessionId: 's_9' }),
      );
      prisma.agentQuestion.update.mockResolvedValue(
        platformRow({ taskId: '', sessionId: 's_9', status: 'resolved' }),
      );

      const result = await service.confirmByAgent({
        taskId: 'team:tm_9',
        instanceId: 'tmm_main',
        requestId: 'que_platform_0000000001',
        kind: 'question',
        answers: [['确认']],
      });

      expect(result.status).toBe('resolved');
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({ resolved: true, taskId: 'team:tm_9' }),
        { type: 'team', id: 'tm_9' },
      );
    });

    it('confirmByAgent team:<id> 形态但行会话归属他团队 → 403 CROSS_TASK_FORBIDDEN', async () => {
      prisma.team.findUnique.mockResolvedValue({ id: 'tm_9' });
      prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_other' });
      prisma.agentQuestion.findUnique.mockResolvedValue(
        platformRow({ taskId: '', sessionId: 's_9' }),
      );

      const err = await service
        .confirmByAgent({
          taskId: 'team:tm_9',
          instanceId: 'tmm_main',
          requestId: 'que_platform_0000000001',
          kind: 'question',
          answers: [['确认']],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.CROSS_TASK_FORBIDDEN,
      });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
    });

    it('拒绝（answers=null）→ 终态落库 rejected + hook 收到 answers=null（拒绝不执行）', async () => {
      const hook = jest.fn().mockResolvedValue(undefined);
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        teamId: 'tm_1',
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
        teamId: 'tm_1',
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
        { type: 'team', id: 'tm_1' },
      );
    });
  });

  describe('平台 question 自批拒绝端到端（发起者记录 → 确认者比对，真实路径）', () => {
    /**
     * 走真实 createForPlatform 组装 content（requesterInstanceId 落库）→ 捕获落库行供
     * 后续按 requestId 读回 → 真实 confirmByAgent 校验。刻意**不** mock session.findUnique
     * 返回确认者自身 id（旧套件正因如此而盲）：平台行必须靠记录的发起者拒绝自批，
     * 不能依赖主成员会话占位。
     */
    const createThenReadBack = async (requesterInstanceId: string) => {
      let created: Record<string, unknown> | null = null;
      prisma.agentQuestion.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          created = { ...platformRow(), ...data };
          return created;
        },
      );
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
        managedMode: true,
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });

      await service.createForPlatform(
        't_1',
        { question: 'Q', options: ['确认', '拒绝'] },
        { agentId: 'a_1', requesterInstanceId },
      );
      expect(
        (created as unknown as { content: { requesterInstanceId: string } })
          .content.requesterInstanceId,
      ).toBe(requesterInstanceId);
      prisma.agentQuestion.findUnique.mockImplementation(async () => created);
    };

    it('createForPlatform(requester=m_A) → confirmByAgent(m_A) 拒绝 SELF_CONFIRMATION_FORBIDDEN', async () => {
      await createThenReadBack('m_A');

      const err = await service
        .confirmByAgent({
          taskId: 't_1',
          instanceId: 'm_A',
          requestId: 'que_platform_0000000001',
          kind: 'question',
          answers: [['确认']],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.SELF_CONFIRMATION_FORBIDDEN,
      });
      // 自批在终态落库前被拒：请求仍 pending，未执行增员钩子。
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
    });

    it('同一请求由不同成员 m_B 确认 → 成功终态（能力未被移除）', async () => {
      await createThenReadBack('m_A');
      prisma.agentQuestion.update.mockResolvedValue(
        platformRow({ status: 'resolved', answers: [['确认']] }),
      );

      const result = await service.confirmByAgent({
        taskId: 't_1',
        instanceId: 'm_B',
        requestId: 'que_platform_0000000001',
        kind: 'question',
        answers: [['确认']],
      });

      expect(result.status).toBe('resolved');
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_0000000001' },
        data: { status: 'resolved', answers: [['确认']] },
      });
    });

    it('跨任务确认（请求归属他任务）→ 仍拒绝 CROSS_TASK_FORBIDDEN', async () => {
      await createThenReadBack('m_A');

      const err = await service
        .confirmByAgent({
          taskId: 't_other',
          instanceId: 'm_A',
          requestId: 'que_platform_0000000001',
          kind: 'question',
          answers: [['确认']],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: QUESTION_CONFIRM_INTEGRITY_ERRORS.CROSS_TASK_FORBIDDEN,
      });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
    });
  });

  describe('secret_input（不回显的敏感输入生命周期）', () => {
    /** no-leak 哨兵：断言 update 参数 / SSE 序列化 payload / DTO 均 0 命中。 */
    const SECRET_SENTINEL = 's3cr3t-A9f';

    /** todo 9 证据 sink：仅在 VTEAM_TASK9_SINK_DIR 设置时落盘，未设置零副作用。 */
    const SINK_DIR = process.env.VTEAM_TASK9_SINK_DIR;
    const dumpSink = (file: string, text: string): void => {
      if (!SINK_DIR) return;
      fs.mkdirSync(SINK_DIR, { recursive: true });
      fs.appendFileSync(path.join(SINK_DIR, file), `${text}\n`);
    };

    /** secret_input pending 行（content 只有模板 + 变量元数据，无值）。 */
    const secretRow = (overrides: Record<string, unknown> = {}) =>
      aqRow({
        id: 'aq_secret',
        requestId: 'que_platform_0000000001',
        kind: AGENT_QUESTION_KINDS.SECRET_INPUT,
        content: {
          source: SECRET_QUESTION_SOURCE,
          template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
          variables: [{ name: 'DB_PASSWORD', secret: true }],
          reason: '导出订单表',
        },
        ...overrides,
      });

    /** 落库回显真实入参：update 直接回写收到的 status/answers（断言的 payload 来自真实调用参数）。 */
    const echoUpdate = () => {
      prisma.agentQuestion.update.mockImplementation(
        async (args: { data: { status: string; answers: unknown } }) => ({
          ...secretRow(),
          status: args.data.status,
          answers: args.data.answers,
        }),
      );
    };

    /** 走真实 createSecretForPlatform 注册终态钩子（key=requestId），返回 mock hook。 */
    const createSecretQuestion = async () => {
      const hook = jest.fn().mockResolvedValue(undefined);
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
        managedMode: false,
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
      prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.agentQuestion.create.mockResolvedValue(secretRow());
      await service.createSecretForPlatform(
        't_1',
        {
          template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
          variables: [{ name: 'DB_PASSWORD', secret: true }],
          reason: '导出订单表',
        },
        { agentId: 'a_1', onSecretResolved: hook },
      );
      prisma.agentQuestion.create.mockClear();
      return hook;
    };

    it('输入预算常量固定 540s（阻塞式 secret_command 的输入预算，不是 600s）', () => {
      expect(SECRET_INPUT_BUDGET_MS).toBe(540 * 1000);
      expect(AGENT_QUESTION_KINDS.SECRET_INPUT).toBe('secret_input');
      expect(SECRET_QUESTION_SOURCE).toBe('secret_input');
    });

    it('createSecretForPlatform：content 只落模板与变量元数据（source=secret_input）+ 返回 managedMode:false + emit 收敛帧', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
        managedMode: false,
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
      prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.agentQuestion.create.mockResolvedValue(secretRow());

      const result = await service.createSecretForPlatform(
        't_1',
        {
          template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
          variables: [{ name: 'DB_PASSWORD', secret: true }],
          reason: '导出订单表',
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
          kind: AGENT_QUESTION_KINDS.SECRET_INPUT,
          content: {
            source: SECRET_QUESTION_SOURCE,
            template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
            variables: [{ name: 'DB_PASSWORD', secret: true }],
            reason: '导出订单表',
          },
          status: 'pending',
        },
      });
      expect(result).toMatchObject({
        kind: AGENT_QUESTION_KINDS.SECRET_INPUT,
        status: 'pending',
        managedMode: false,
      });
      // Todo 12:团队域投递 — secret create emit 同样须带顶层 teamId（弹窗不刷新即弹）。
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({
          taskId: 't_1',
          teamId: 'tm_1',
          question: expect.objectContaining({
            kind: AGENT_QUESTION_KINDS.SECRET_INPUT,
          }),
        }),
        { type: 'team', id: 'tm_1' },
      );
    });

    it('托管团队 + 非主 Agent 发起：agentQuestion.create 调用 0（无孤儿 pending 行）且不 emit', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({
        managedMode: true,
        mainAgentMemberId: 'tmm_main',
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
      prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_1' });

      await expect(
        service.createSecretForPlatform(
          't_1',
          {
            template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
            variables: [{ name: 'DB_PASSWORD', secret: true }],
          },
          { agentId: 'a_1', requesterInstanceId: 'tmm_other' },
        ),
      ).rejects.toMatchObject({
        response: {
          code: QUESTIONS_ERRORS.QUESTION_SECRET_MANAGED_FORBIDDEN,
        },
      });

      expect(prisma.agentQuestion.create).not.toHaveBeenCalled();
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
      expect(realtime.emit).not.toHaveBeenCalled();
    });

    // ------------------------------------------------------------------
    // is_0000000001 问题 2：托管模式放行主 Agent，密钥值仍由用户提供
    // ------------------------------------------------------------------

    it('托管团队 + 发起人即主 Agent → 放行创建，且 DTO.managedMode 恒 false（用户弹窗必须出现）', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({
        managedMode: true,
        mainAgentMemberId: 'tmm_main',
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
      prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.agentQuestion.create.mockResolvedValue(secretRow());

      const result = await service.createSecretForPlatform(
        't_1',
        {
          template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
          variables: [{ name: 'DB_PASSWORD', secret: true }],
        },
        { agentId: 'a_1', requesterInstanceId: 'tmm_main' },
      );

      expect(prisma.agentQuestion.create).toHaveBeenCalledTimes(1);
      // 关键：团队明明托管中，DTO 仍必须 managedMode=false —— 前端据此过滤
      // (!q.managedMode)，带 true 会让密钥弹窗永不出现，等于把主 Agent 也堵死。
      expect(result.managedMode).toBe(false);
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({
          question: expect.objectContaining({ managedMode: false }),
        }),
        { type: 'team', id: 'tm_1' },
      );
    });

    it('toDto 口径：secret_input 恒 managedMode=false（reply/expire 收敛帧同样带 false）', async () => {
      const hook = await createSecretQuestion();
      prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());
      echoUpdate();

      const result = await service.reply(
        'aq_secret',
        { secrets: { DB_PASSWORD: SECRET_SENTINEL } } as ReplyQuestionDto,
        'u_1',
      );

      expect(result.managedMode).toBe(false);
      const emitted = realtime.emit.mock.calls.find(
        (call) => call[0] === EVENT_TYPES.AGENT_QUESTION,
      );
      expect(emitted?.[1]).toMatchObject({
        question: expect.objectContaining({ managedMode: false }),
      });
      await hook;
    });

    it('团队直聊（taskId="" + teamId）→ 落库走团队主 Agent 会话，不查任务表', async () => {
      prisma.task.findUnique.mockReset();
      prisma.team.findUnique.mockResolvedValue({
        managedMode: false,
        mainAgentMemberId: 'tmm_main',
      });
      prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
      prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.agentQuestion.create.mockResolvedValue(
        secretRow({ taskId: '', sessionId: 's_main' }),
      );

      const result = await service.createSecretForPlatform(
        '',
        {
          template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
          variables: [{ name: 'DB_PASSWORD', secret: true }],
        },
        { agentId: 'a_1', teamId: 'tm_1', requesterInstanceId: 'tmm_main' },
      );

      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentQuestion.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ taskId: '', sessionId: 's_main' }),
      });
      expect(result).toMatchObject({ taskId: '', managedMode: false });
      expect(realtime.emit).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_QUESTION,
        expect.objectContaining({ teamId: 'tm_1' }),
        { type: 'team', id: 'tm_1' },
      );
    });

    it('带 sentinel 的回复：落库 answers 只有 {provided,filled,actorType,actorId}，update 入参与序列化 SSE payload 0 命中，hook 内存收到明文', async () => {
      const hook = await createSecretQuestion();
      prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());
      echoUpdate();

      const result = await service.reply(
        'aq_secret',
        { secrets: { DB_PASSWORD: SECRET_SENTINEL } } as ReplyQuestionDto,
        'u_1',
      );

      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(workerClient.permissionReply).not.toHaveBeenCalled();
      expect(prisma.worker.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_secret' },
        data: {
          status: 'resolved',
          answers: {
            provided: true,
            filled: ['DB_PASSWORD'],
            actorType: 'user',
            actorId: 'u_1',
          },
        },
      });
      expect(
        JSON.stringify(prisma.agentQuestion.update.mock.calls),
      ).not.toContain(SECRET_SENTINEL);
      expect(realtime.emit.mock.calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(realtime.emit.mock.calls)).not.toContain(
        SECRET_SENTINEL,
      );
      expect(JSON.stringify(result)).not.toContain(SECRET_SENTINEL);
      expect(hook).toHaveBeenCalledWith({
        outcome: 'provided',
        secrets: { DB_PASSWORD: SECRET_SENTINEL },
        actor: { type: 'user', id: 'u_1' },
      });
      expect(result.status).toBe('resolved');
      expect(result.answers).toEqual({
        provided: true,
        filled: ['DB_PASSWORD'],
        actorType: 'user',
        actorId: 'u_1',
      });
    });

    it('todo 9 sink：完整 create→reply 链路的落库入参 / SSE / 日志 / 回包落盘且 0 命中（明文只在内存钩子）', async () => {
      const logLines: string[] = [];
      const capture = (...args: unknown[]): void => {
        logLines.push(args.map(String).join(' '));
      };
      const logger = (
        service as unknown as {
          logger: Record<
            'log' | 'warn' | 'error',
            (...args: unknown[]) => void
          >;
        }
      ).logger;
      const spies = [
        jest.spyOn(logger, 'log').mockImplementation(capture),
        jest.spyOn(logger, 'warn').mockImplementation(capture),
        jest.spyOn(logger, 'error').mockImplementation(capture),
      ];
      try {
        prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
        prisma.team.findUnique.mockResolvedValue({
          mainAgentMemberId: 'tmm_main',
          managedMode: false,
        });
        prisma.session.findFirst.mockResolvedValue({ id: 's_main' });
        prisma.session.findUnique.mockResolvedValue({ teamId: 'tm_1' });
        prisma.agentQuestion.create.mockResolvedValue(secretRow());
        const hook = jest.fn().mockResolvedValue(undefined);
        await service.createSecretForPlatform(
          't_1',
          {
            template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
            variables: [{ name: 'DB_PASSWORD', secret: true }],
            reason: '导出订单表',
          },
          { agentId: 'a_1', onSecretResolved: hook },
        );
        prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());
        echoUpdate();

        const replyResult = await service.reply(
          'aq_secret',
          { secrets: { DB_PASSWORD: SECRET_SENTINEL } } as ReplyQuestionDto,
          'u_1',
        );

        const sinks: Array<readonly [string, string]> = [
          [
            'question-create.json',
            JSON.stringify(prisma.agentQuestion.create.mock.calls, null, 2),
          ],
          [
            'question-answers.json',
            JSON.stringify(prisma.agentQuestion.update.mock.calls, null, 2),
          ],
          [
            'sse-payload.json',
            JSON.stringify(realtime.emit.mock.calls, null, 2),
          ],
          ['question-reply-result.json', JSON.stringify(replyResult, null, 2)],
          ['questions-server.log', logLines.join('\n')],
        ];
        for (const [file, text] of sinks) {
          expect(text.split(SECRET_SENTINEL).length - 1).toBe(0);
          dumpSink(file, text);
        }
        expect(prisma.agentQuestion.create.mock.calls.length).toBeGreaterThan(
          0,
        );
        expect(logLines.length).toBeGreaterThan(0);
        expect(hook).toHaveBeenCalledWith(
          expect.objectContaining({
            secrets: { DB_PASSWORD: SECRET_SENTINEL },
          }),
        );
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });

    it('{secrets:null} → 取消：终态 rejected + hook outcome=cancelled + 不执行命令（不触 worker）', async () => {
      const hook = await createSecretQuestion();
      prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());
      echoUpdate();

      const result = await service.reply(
        'aq_secret',
        { secrets: null } as ReplyQuestionDto,
        'u_1',
      );

      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(prisma.worker.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentQuestion.update).toHaveBeenCalledWith({
        where: { id: 'aq_secret' },
        data: {
          status: 'rejected',
          answers: {
            provided: false,
            filled: [],
            actorType: 'user',
            actorId: 'u_1',
          },
        },
      });
      expect(hook).toHaveBeenCalledWith({
        outcome: 'cancelled',
        secrets: null,
        actor: { type: 'user', id: 'u_1' },
      });
      expect(result.status).toBe('rejected');
    });

    it('钩子抛出含 sentinel 的错误 → logger.error 落盘前精确脱敏（0 命中）且收敛照常完成', async () => {
      const hook = await createSecretQuestion();
      hook.mockRejectedValue(new Error(`worker failed: ${SECRET_SENTINEL}`));
      const errSpy = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => undefined);
      prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());
      echoUpdate();

      const result = await service.reply(
        'aq_secret',
        { secrets: { DB_PASSWORD: SECRET_SENTINEL } } as ReplyQuestionDto,
        'u_1',
      );

      const logged = errSpy.mock.calls
        .map((call: unknown[]) => call.map(String).join(' '))
        .join('\n');
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(logged).toContain('***');
      expect(logged).not.toContain(SECRET_SENTINEL);
      expect(result.status).toBe('resolved');
      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(JSON.stringify(realtime.emit.mock.calls)).not.toContain(
        SECRET_SENTINEL,
      );
      errSpy.mockRestore();
    });

    it('缺 secrets（字段未携带）→ 400 QUESTION_INVALID_REPLY（不落库、不触发钩子）', async () => {
      const hook = await createSecretQuestion();
      prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());

      await expect(
        service.reply('aq_secret', {} as ReplyQuestionDto, 'u_1'),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY },
      });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      expect(workerClient.questionReply).not.toHaveBeenCalled();
    });

    it('未声明变量（secrets 带 content 未声明的 key）→ 400 QUESTION_INVALID_REPLY', async () => {
      const hook = await createSecretQuestion();
      prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());

      await expect(
        service.reply(
          'aq_secret',
          { secrets: { ROOT_PASSWORD: SECRET_SENTINEL } } as ReplyQuestionDto,
          'u_1',
        ),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY },
      });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      expect(JSON.stringify(realtime.emit.mock.calls)).not.toContain(
        SECRET_SENTINEL,
      );
    });

    it('已声明变量缺值（secrets:{}）→ 400 QUESTION_INVALID_REPLY', async () => {
      const hook = await createSecretQuestion();
      prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());

      await expect(
        service.reply('aq_secret', { secrets: {} } as ReplyQuestionDto, 'u_1'),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_INVALID_REPLY },
      });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
    });

    it('终态重复回复（已 resolved）→ 400 QUESTION_ALREADY_RESOLVED（不再触发钩子）', async () => {
      const hook = await createSecretQuestion();
      prisma.agentQuestion.findUnique.mockResolvedValue(
        secretRow({ status: 'resolved' }),
      );

      await expect(
        service.reply(
          'aq_secret',
          { secrets: { DB_PASSWORD: SECRET_SENTINEL } } as ReplyQuestionDto,
          'u_1',
        ),
      ).rejects.toMatchObject({
        response: { code: QUESTIONS_ERRORS.QUESTION_ALREADY_RESOLVED },
      });
      expect(prisma.agentQuestion.update).not.toHaveBeenCalled();
      expect(hook).not.toHaveBeenCalled();
      expect(workerClient.questionReply).not.toHaveBeenCalled();
    });

    it('secret source 即使被送进 forwardReply 也走平台旁路：不查 worker、不调 questionReply、不落明文', async () => {
      const hook = await createSecretQuestion();
      echoUpdate();

      const result = await (service as any).forwardReply(
        secretRow(),
        { secrets: { DB_PASSWORD: SECRET_SENTINEL } },
        { type: 'user', id: 'u_1' },
      );

      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(prisma.worker.findUnique).not.toHaveBeenCalled();
      expect(
        JSON.stringify(prisma.agentQuestion.update.mock.calls),
      ).not.toContain(SECRET_SENTINEL);
      expect(hook).toHaveBeenCalledWith({
        outcome: 'provided',
        secrets: { DB_PASSWORD: SECRET_SENTINEL },
        actor: { type: 'user', id: 'u_1' },
      });
      expect(result.status).toBe('resolved');
    });

    it('钩子未注册（进程重启丢失）→ 落库 + emit 照常，不抛错（stale pending 不悬挂）', async () => {
      prisma.agentQuestion.findUnique.mockResolvedValue(secretRow());
      echoUpdate();

      const result = await service.reply(
        'aq_secret',
        { secrets: { DB_PASSWORD: SECRET_SENTINEL } } as ReplyQuestionDto,
        'u_1',
      );

      expect(result.status).toBe('resolved');
      expect(workerClient.questionReply).not.toHaveBeenCalled();
      expect(JSON.stringify(realtime.emit.mock.calls)).not.toContain(
        SECRET_SENTINEL,
      );
    });
  });
});
