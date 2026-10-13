import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerClient } from '../workers/worker.client';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import { QuestionsService } from './questions.service';

const SENTINEL = 's3cr3t-A9f';

describe('TASK2_MANUAL_QA secret_input no-echo capture', () => {
  let service: QuestionsService;
  let prisma: any;
  let realtime: any;
  let workerClient: any;
  let idGen: any;

  const secretRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'aq_secret_1',
    requestId: 'que_platform_0000000001',
    sessionId: 's_main',
    taskId: 't_1',
    agentId: 'a_1',
    kind: 'secret_input',
    content: {
      source: 'secret_input',
      template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
      variables: [{ name: 'DB_PASSWORD', secret: true }],
      reason: '导出订单表',
    },
    status: 'pending',
    answers: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeAll(async () => {
    let seq = 0;
    idGen = {
      nextId: jest.fn(async () => {
        seq += 1;
        return `aq_000000000${seq}`;
      }),
      seed: jest.fn(),
    };
    prisma = {
      agentQuestion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async (args: any) => ({ ...secretRow(), ...args.data })),
        update: jest.fn(),
      },
      session: {
        findUnique: jest.fn().mockResolvedValue({ teamId: 'tm_1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 's_main' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      worker: { findUnique: jest.fn() },
      team: {
        findUnique: jest.fn().mockResolvedValue({
          mainAgentMemberId: 'tmm_main',
          managedMode: false,
        }),
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

  it('captures update args / SSE payload / hook args in one run', async () => {
    const updateArgs: unknown[] = [];
    const emitArgs: unknown[] = [];
    const hookArgs: unknown[] = [];
    prisma.agentQuestion.update.mockImplementation(async (args: any) => {
      updateArgs.push(args);
      return {
        ...secretRow({ id: args.where.id }),
        status: args.data.status,
        answers: args.data.answers,
      };
    });
    realtime.emit.mockImplementation(async (...args: unknown[]) => {
      emitArgs.push(args);
      return { id: 'ev_1' };
    });
    const hook = jest.fn(async (args: unknown) => {
      hookArgs.push(args);
    });

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
    const provided = await service.reply(
      'aq_secret_1',
      { secrets: { DB_PASSWORD: SENTINEL } } as ReplyQuestionDto,
      'u_1',
    );

    prisma.agentQuestion.findUnique.mockResolvedValue(
      secretRow({ id: 'aq_secret_2', requestId: 'que_platform_0000000002' }),
    );
    const cancelled = await service.reply(
      'aq_secret_2',
      { secrets: null } as ReplyQuestionDto,
      'u_1',
    );

    const answersJson = JSON.stringify(
      updateArgs.map((u: any) => u.data.answers),
    );
    const sseJson = JSON.stringify(emitArgs);
    const hookJson = JSON.stringify(hookArgs);
    const dtoJson = JSON.stringify([provided, cancelled]);

    console.log('===AGENT_QUESTION_UPDATE_ARGS_JSON===');
    console.log(JSON.stringify(updateArgs, null, 2));
    console.log('===SERIALIZED_REALTIME_EMIT_PAYLOAD===');
    console.log(JSON.stringify(emitArgs, null, 2));
    console.log('===HOOK_ARGS_IN_MEMORY===');
    console.log(JSON.stringify(hookArgs, null, 2));
    console.log('===SENTINEL_SCAN===');
    console.log(`answers          sentinel_hits=${answersJson.split(SENTINEL).length - 1}`);
    console.log(`sse_payload      sentinel_hits=${sseJson.split(SENTINEL).length - 1}`);
    console.log(`reply_dto        sentinel_hits=${dtoJson.split(SENTINEL).length - 1}`);
    console.log(`hook_in_memory   sentinel_hits=${hookJson.split(SENTINEL).length - 1}`);
    console.log(`provided.status=${provided.status} cancelled.status=${cancelled.status}`);
    console.log(
      `workerClient.questionReply_calls=${workerClient.questionReply.mock.calls.length} permissionReply_calls=${workerClient.permissionReply.mock.calls.length} worker.findUnique_calls=${prisma.worker.findUnique.mock.calls.length}`,
    );
    console.log(
      `create_calls=${prisma.agentQuestion.create.mock.calls.length} update_calls=${updateArgs.length} emit_calls=${emitArgs.length}`,
    );

    expect(answersJson).not.toContain(SENTINEL);
    expect(sseJson).not.toContain(SENTINEL);
    expect(dtoJson).not.toContain(SENTINEL);
    expect(hookJson).toContain(SENTINEL);
    expect(workerClient.questionReply).not.toHaveBeenCalled();
    expect(provided.status).toBe('resolved');
    expect(cancelled.status).toBe('rejected');
  });
});
