/**
 * sensitive-command-tool todo 6 手工 QA：同步钩子注入跑通 secret_command 阻塞式
 * 处理器全链路（happy / worker 非零 / secrets:null / 输入超预算 / 并发 409 / 客户端断开）。
 *
 * 运行方式（jest rootDir=src，故须临时放进产品目录）：
 *   cp .omo/evidence/sensitive-command-tool/task-6-manual-qa.spec.ts server/src/platform-mcp/
 *   cd server && npx jest src/platform-mcp/task-6-manual-qa.spec.ts --runInBand
 *   rm server/src/platform-mcp/task-6-manual-qa.spec.ts
 * 原始输出由外层 shell 重定向进 task-6-mcp-handler.txt；本文件不提交（evidence 目录）。
 * import 保持运行时的相对路径（../common/... 等，与 task-2 手工 QA harness 同约定）。
 */
import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { WorkerClient } from '../workers/worker.client';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { IssuesService } from '../issues/issues.service';
import { TasksService } from '../tasks/tasks.service';
import { QuestionsService } from '../questions/questions.service';
import { GitReposService } from '../git-repos/git-repos.service';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';
import { PlatformMcpService } from './platform-mcp.service';

const SENTINEL = 's3cr3t-A9f';
const TASK_ID = 't_0000000001';
const WORKER_ID = 'w_0000000001';
const INSTANCE_ID = 'tmm_sender';

describe('TASK6_MANUAL_QA secret_command 阻塞式处理器全链路', () => {
  let service: PlatformMcpService;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let workerClient: { runSecretCommand: jest.Mock };
  let workerDispatcher: {
    keepAliveSession: jest.Mock;
    isAgentExecuting: jest.Mock;
  };
  let questionsService: {
    createSecretForPlatform: jest.Mock;
    reply: jest.Mock;
  };

  const ctx = { workerId: WORKER_ID };
  const captured: string[] = [];

  const args = (overrides: Record<string, unknown> = {}) => ({
    taskId: TASK_ID,
    selfInstanceId: INSTANCE_ID,
    command:
      'curl -s -H "Authorization: Bearer {{TOKEN}}" https://example.internal/deploy',
    variables: [
      { name: 'TOKEN', label: '部署 Token', secret: true, required: true },
    ],
    ...overrides,
  });

  const workerOk = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'secmd_qa',
    status: 'succeeded',
    exitCode: 0,
    durationMs: 17,
    stdout: 'deployed\n',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  });

  const hits = (value: unknown) =>
    JSON.stringify(value).split(SENTINEL).length - 1;

  const report = (
    scenario: string,
    extra: {
      envelope: { status: string };
      workerCalls: number;
      replyCalls?: number;
      keepalive?: number;
      lines?: string[];
    },
  ) => {
    const json = JSON.stringify(extra.envelope);
    const line = [
      `--- ${scenario} ---`,
      `STATUS=${extra.envelope.status}`,
      `WORKER_CALLS=${extra.workerCalls}`,
      `REPLY_CALLS=${extra.replyCalls ?? 0}`,
      `KEEPALIVE_CALLS=${extra.keepalive ?? 0}`,
      `ENVELOPE_JSON=${json}`,
      `ENVELOPE_SENTINEL_HITS=${json.split(SENTINEL).length - 1}`,
    ];
    for (const entry of extra.lines ?? []) {
      line.push(entry);
    }
    const text = line.join('\n');
    captured.push(text);
    console.log(text);
    return json;
  };

  beforeAll(async () => {
    prisma = {
      task: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
      team: { findUnique: jest.fn() },
      session: { findFirst: jest.fn(), findMany: jest.fn() },
      worker: { findUnique: jest.fn() },
    };
    prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
    prisma.team.findUnique.mockResolvedValue(null);
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: 'a_sender',
      teamMemberId: INSTANCE_ID,
      instanceRef: 'ses_0001',
    });
    prisma.worker.findUnique.mockResolvedValue({
      id: WORKER_ID,
      capabilities: { execBaseUrl: 'http://w1:4198' },
    });
    workerClient = { runSecretCommand: jest.fn() };
    workerDispatcher = {
      keepAliveSession: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };
    questionsService = {
      createSecretForPlatform: jest.fn(),
      reply: jest.fn().mockResolvedValue({ id: 'aq_1', status: 'rejected' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
        { provide: WorkerClient, useValue: workerClient },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ArtifactsService, useValue: {} },
        { provide: IssuesService, useValue: {} },
        { provide: TasksService, useValue: {} },
        { provide: QuestionsService, useValue: questionsService },
        { provide: GitReposService, useValue: {} },
      ],
    }).compile();
    service = module.get(PlatformMcpService);
  });

  beforeEach(() => {
    workerClient.runSecretCommand.mockReset().mockResolvedValue(workerOk());
    workerDispatcher.keepAliveSession.mockClear();
    questionsService.createSecretForPlatform.mockReset();
    questionsService.reply.mockClear();
    prisma.team.findUnique.mockResolvedValue(null);
  });

  afterAll(() => {
    console.log(
      `SENTINEL_SCAN_ALL_ENVELOPES=${captured.join('\n').split(SENTINEL).length - 1}`,
    );
  });

  it('1. happy：同步钩子提供 secret → succeeded，envelope 无明文 secret/无渲染命令', async () => {
    questionsService.createSecretForPlatform.mockImplementation(
      (_taskId: string, _input: unknown, options: {
        onSecretResolved: (a: unknown) => void;
      }) => {
        options.onSecretResolved({
          outcome: 'provided',
          secrets: { TOKEN: SENTINEL },
          actor: { type: 'user', id: 'u_1' },
        });
        return { id: 'aq_1', requestId: 'que_platform_1' };
      },
    );

    const envelope = await service.secretCommand(ctx, args({ cwd: 'deploy' }));
    const call = workerClient.runSecretCommand.mock.calls[0];
    expect(envelope.status).toBe('succeeded');
    expect(hits(envelope)).toBe(0);
    expect(JSON.stringify(envelope)).not.toContain('"cwd"');
    expect(call[1].secrets.TOKEN).toBe(SENTINEL);
    expect(call[1].timeoutMs).toBe(65_000);

    report('1 happy provided -> succeeded', {
      envelope,
      workerCalls: workerClient.runSecretCommand.mock.calls.length,
      replyCalls: questionsService.reply.mock.calls.length,
      keepalive: workerDispatcher.keepAliveSession.mock.calls.length,
      lines: [
        `WORKER_TIMEOUT_MS=${call[1].timeoutMs}`,
        `WORKER_RECEIVED_SECRET_VALUE=${call[1].secrets.TOKEN === SENTINEL}`,
        `WORKER_TEMPLATE_UNRENDERED=${call[1].commandTemplate.includes('{{TOKEN}}')}`,
        `CWD_IN_ENVELOPE=${JSON.stringify(envelope).includes('"cwd"')}`,
      ],
    });
  });

  it('2. worker 非零退出 → failed', async () => {
    questionsService.createSecretForPlatform.mockImplementation(
      (_taskId: string, _input: unknown, options: {
        onSecretResolved: (a: unknown) => void;
      }) => {
        options.onSecretResolved({
          outcome: 'provided',
          secrets: { TOKEN: SENTINEL },
          actor: { type: 'user', id: 'u_1' },
        });
        return { id: 'aq_1', requestId: 'que_platform_1' };
      },
    );
    workerClient.runSecretCommand.mockResolvedValue(
      workerOk({ status: 'failed', exitCode: 2, stderr: 'boom\n' }),
    );

    const envelope = await service.secretCommand(ctx, args());
    expect(envelope.status).toBe('failed');
    expect(envelope.exitCode).toBe(2);
    expect(hits(envelope)).toBe(0);
    report('2 worker exit 2 -> failed', {
      envelope,
      workerCalls: workerClient.runSecretCommand.mock.calls.length,
      replyCalls: questionsService.reply.mock.calls.length,
    });
  });

  it('3. secrets:null → cancelled，且 worker 零调用', async () => {
    questionsService.createSecretForPlatform.mockImplementation(
      (_taskId: string, _input: unknown, options: {
        onSecretResolved: (a: unknown) => void;
      }) => {
        options.onSecretResolved({
          outcome: 'cancelled',
          secrets: null,
          actor: { type: 'user', id: 'u_1' },
        });
        return { id: 'aq_1', requestId: 'que_platform_1' };
      },
    );

    const envelope = await service.secretCommand(ctx, args());
    expect(envelope.status).toBe('cancelled');
    expect(workerClient.runSecretCommand).not.toHaveBeenCalled();
    expect(hits(envelope)).toBe(0);
    report('3 secrets:null -> cancelled (worker not called)', {
      envelope,
      workerCalls: workerClient.runSecretCommand.mock.calls.length,
      replyCalls: questionsService.reply.mock.calls.length,
    });
  });

  it('4. 同会话并发第二次 → 409 SECRET_COMMAND_CONFLICT', async () => {
    let fireHook:
      | ((a: unknown) => Promise<void> | void)
      | undefined;
    questionsService.createSecretForPlatform.mockImplementation(
      (_taskId: string, _input: unknown, options: {
        onSecretResolved: (a: unknown) => void;
      }) => {
        fireHook = options.onSecretResolved;
        return { id: 'aq_1', requestId: 'que_platform_1' };
      },
    );

    const first = service.secretCommand(ctx, args());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await service.secretCommand(ctx, args()).then(
      () => 'no-conflict',
      (err: unknown) =>
        err instanceof ConflictException
          ? String(
              (err.getResponse() as { code?: string }).code,
            )
          : `unexpected:${String(err)}`,
    );
    await fireHook?.({
      outcome: 'cancelled',
      secrets: null,
      actor: { type: 'user', id: 'u_1' },
    });
    const firstEnvelope = await first;

    expect(second).toBe(PLATFORM_MCP_ERRORS.SECRET_COMMAND_CONFLICT);
    expect(questionsService.createSecretForPlatform).toHaveBeenCalledTimes(1);
    report('4 concurrent second call -> 409', {
      envelope: firstEnvelope,
      workerCalls: workerClient.runSecretCommand.mock.calls.length,
      replyCalls: questionsService.reply.mock.calls.length,
      lines: [`SECOND_CALL_RESULT=${second}`],
    });
  });

  it('5. 客户端断开（AbortSignal）→ 取消 pending 问题、worker 零调用', async () => {
    let fireHook:
      | ((a: unknown) => Promise<void> | void)
      | undefined;
    questionsService.createSecretForPlatform.mockImplementation(
      (_taskId: string, _input: unknown, options: {
        onSecretResolved: (a: unknown) => void;
      }) => {
        fireHook = options.onSecretResolved;
        return { id: 'aq_1', requestId: 'que_platform_1' };
      },
    );
    const controller = new AbortController();

    const pending = service.secretCommand(ctx, args(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const envelope = await pending;

    expect(envelope.status).toBe('cancelled');
    expect(questionsService.reply).toHaveBeenCalledWith('aq_1', {
      secrets: null,
    });
    expect(workerClient.runSecretCommand).not.toHaveBeenCalled();

    await fireHook?.({
      outcome: 'provided',
      secrets: { TOKEN: SENTINEL },
      actor: { type: 'user', id: 'u_1' },
    });
    expect(workerClient.runSecretCommand).not.toHaveBeenCalled();
    expect(hits(envelope)).toBe(0);
    report('5 client abort -> cancelled pending question, no execution', {
      envelope,
      workerCalls: workerClient.runSecretCommand.mock.calls.length,
      replyCalls: questionsService.reply.mock.calls.length,
      lines: [
        `CANCEL_REPLY_PAYLOAD=${JSON.stringify(questionsService.reply.mock.calls[0]?.[1])}`,
        `LATE_SUBMIT_EXECUTED=${workerClient.runSecretCommand.mock.calls.length > 0}`,
      ],
    });
  });

  it('6. 输入超预算 540s → input_timeout + 取消 pending 问题（keepalive 每 60s）', async () => {
    jest.useFakeTimers();
    try {
      questionsService.createSecretForPlatform.mockImplementation(
        (_taskId: string, _input: unknown, _options: unknown) => ({
          id: 'aq_1',
          requestId: 'que_platform_1',
        }),
      );
      const pending = service.secretCommand(ctx, args());
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(539_999);
      const keepaliveBeforeExpiry =
        workerDispatcher.keepAliveSession.mock.calls.length;
      await jest.advanceTimersByTimeAsync(2);
      const envelope = await pending;

      expect(envelope.status).toBe('input_timeout');
      expect(workerClient.runSecretCommand).not.toHaveBeenCalled();
      expect(questionsService.reply).toHaveBeenCalledWith('aq_1', {
        secrets: null,
      });
      expect(hits(envelope)).toBe(0);
      report('6 input expiry 540s -> input_timeout', {
        envelope,
        workerCalls: workerClient.runSecretCommand.mock.calls.length,
        replyCalls: questionsService.reply.mock.calls.length,
        keepalive: workerDispatcher.keepAliveSession.mock.calls.length,
        lines: [
          `KEEPALIVE_BEFORE_EXPIRY=${keepaliveBeforeExpiry}`,
          `KEEPALIVE_INTERVAL_MS=60000`,
          `INPUT_BUDGET_MS=540000`,
        ],
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
