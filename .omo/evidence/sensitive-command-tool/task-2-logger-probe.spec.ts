import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerClient } from '../workers/worker.client';
import { ReplyQuestionDto } from './dto/reply-question.dto';
import { QuestionsService } from './questions.service';

const SENTINEL = 's3cr3t-A9f';

describe('TASK2_FIX_LOGGER_PROBE secret hook error redaction', () => {
  let service: QuestionsService;
  let prisma: any;
  let realtime: any;

  const row = () => ({
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
  });

  beforeAll(async () => {
    prisma = {
      agentQuestion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(row()),
        create: jest.fn(async (args: any) => ({ ...row(), ...args.data })),
        update: jest.fn(async (args: any) => ({
          ...row(),
          status: args.data.status,
          answers: args.data.answers,
        })),
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuestionsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: IdGeneratorService,
          useValue: {
            nextId: jest.fn(async () => 'aq_0000000001'),
            seed: jest.fn(),
          },
        },
        { provide: RealtimeService, useValue: realtime },
        {
          provide: WorkerClient,
          useValue: {
            questionReply: jest.fn().mockResolvedValue(undefined),
            permissionReply: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = module.get<QuestionsService>(QuestionsService);
  });

  it('hook Error carries sentinel -> logger.error is redacted, resolution still converges', async () => {
    const hook = jest
      .fn()
      .mockRejectedValue(new Error(`worker failed: ${SENTINEL}`));
    await service.createSecretForPlatform(
      't_1',
      {
        template: 'mysql -h db -u root -p{{DB_PASSWORD}}',
        variables: [{ name: 'DB_PASSWORD', secret: true }],
        reason: '导出订单表',
      },
      { agentId: 'a_1', onSecretResolved: hook },
    );
    const logged: string[] = [];
    const errSpy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
        return undefined;
      });

    const dto = await service.reply(
      'aq_secret_1',
      { secrets: { DB_PASSWORD: SENTINEL } } as ReplyQuestionDto,
      'u_1',
    );

    console.log('===HOOK_ERROR_RAW_(simulated)===');
    console.log(new Error(`worker failed: ${SENTINEL}`).message);
    console.log('===CAPTURED_LOGGER_ERROR_OUTPUT===');
    console.log(logged.join('\n'));
    console.log('===LOGGER_SENTINEL_SCAN===');
    console.log(`logger.error sentinel_hits=${logged.join('\n').split(SENTINEL).length - 1}`);
    console.log(`redaction_marker_present=${logged.join('\n').includes('***')}`);
    console.log(
      `dto.status=${dto.status} emit_calls=${realtime.emit.mock.calls.length} questionReply_calls=0`,
    );
    console.log(
      `emit_sentinel_hits=${JSON.stringify(realtime.emit.mock.calls).split(SENTINEL).length - 1}`,
    );

    expect(logged).toHaveLength(1);
    expect(logged.join('\n')).toContain('***');
    expect(logged.join('\n')).not.toContain(SENTINEL);
    expect(dto.status).toBe('resolved');
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
