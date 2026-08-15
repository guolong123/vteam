/**
 * 方案 A wave1 汇总对齐：dispatch → execute → ingress 回流 → 落库/广播 端到端链路集成测试。
 *
 * 使用「真实 WorkerEventIngress + 真实 WorkerDispatcher」（dispatch 构造时向 ingress
 * 注册 onTaskCompleted/onAgentStatus/onSessionActivity 回调），mock 仅 Prisma/Realtime/
 * WorkerClient 等基础设施——验证方案 A 主链路在接口层面无缝：
 *
 *   dispatch → workerClient.execute(prompt/sessionId/taskId/agentId/channelId)
 *   → worker 回流（sessionId=opencode 会话 id `ses_` 前缀）→ ingress instanceRef 反查
 *     平台 Session 主键（s_ 前缀）→ session.updated(running) 落库+emit+判死活动
 *   → message.part.delta 落库 processing + 广播 MESSAGE_PART_DELTA
 *   → task.completed 终态化 sent + 广播 chat.message.new + emitFinal
 *   → session.updated(idle) 落库+emit
 *   → 首字 watchdog 清除（running 回流不再 emitError）
 *
 * 覆盖 wave1 修复的 2 个接口不一致：
 * 1. execute 请求契约（server 发 prompt 对齐 worker ExecuteRequestPayload.prompt）；
 * 2. sessionId 域一致（worker 上送 ses_ → ingress 反查 s_ → 判死 watchdog 匹配）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { WorkerClient } from '../workers/worker.client';
import { WorkerEventDto } from '../workers/dto/worker-event.dto';
import { WorkerEventIngress } from '../workers/worker-event.ingress';
import { WorkersService } from '../workers/workers.service';
import { WorkerDispatcher } from './worker-dispatcher';

/** 构造 WorkerEventDto（协议形状与 DTO 字段一致，eventId 唯一防去重）。 */
function event(
  type: WorkerEventDto['type'],
  payload: Record<string, unknown>,
  eventId: string,
): WorkerEventDto {
  return { workerId: 'w_0000000001', eventId, type, payload, seq: 0 } as WorkerEventDto;
}

/** 等待 dispatcher fire-and-forget 回调（task.completed 落库异步执行）落定。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('WorkerDispatcher × WorkerEventIngress 集成（方案 A 主链路）', () => {
  let prisma: {
    session: { findUnique: jest.Mock; findFirst: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
    worker: { findUnique: jest.Mock };
    agent: { findUnique: jest.Mock };
    artifact: { findMany: jest.Mock };
    artifactVersion: { findMany: jest.Mock };
    message: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    chatChannel: { findUnique: jest.Mock; findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    taskAgent: { findUnique: jest.Mock };
  };
  let realtime: { emit: jest.Mock; broadcast: jest.Mock };
  let idGen: { nextId: jest.Mock };
  let workersService: { assignWorker: jest.Mock };
  let workerClient: {
    createSession: jest.Mock;
    promptAsync: jest.Mock;
    getMessages: jest.Mock;
    execute: jest.Mock;
  };
  let sessionLifecycle: { bindSessionToWorker: jest.Mock; unbindSession: jest.Mock };
  let artifactsService: { onArtifactSubmitted: jest.Mock };
  let config: { get: jest.Mock };
  let ingress: WorkerEventIngress;
  let dispatcher: WorkerDispatcher;
  let workRoot: string;

  const request = {
    messageId: 'm_0000000001',
    channelId: 'c_0000000001',
    taskId: 't_0000000001',
    text: '你好，请处理',
    targets: [{ agentId: 'a_product', sessionId: 's_0000000001' }],
  };

  /** private 频道 processing 流式消息行（delta 落库 + completed 终态化定位）。 */
  const streamRow = {
    id: 'm_stream',
    channelId: request.channelId,
    senderType: SENDER_TYPE.agent,
    senderId: 'a_product',
    content: {
      text: '最终结论',
      parts: [{ type: 'text', text: '最终结论', synthetic: false }],
    },
    mentions: null,
    status: MESSAGE_STATUS.sent,
    createdAt: new Date('2026-08-10T00:00:00Z'),
  };

  beforeEach(() => {
    // dispatch：已绑 worker（复用，不 assignWorker/createSession）
    prisma = {
      session: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            id: 's_0000000001',
            workerId: 'w_0000000001',
            instanceRef: 'ses_0001',
            taskAgentId: 'ta_0000000001',
          }),
        // instanceRef 反查：ses_ 前缀 → 平台 s_ 主键（wave1 对齐链路）
        findFirst: jest.fn().mockResolvedValue({ id: 's_0000000001' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({ id: 's_0000000001' }),
      },
      worker: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'w_0000000001',
          status: 'online',
          capabilities: {},
          defaultModelId: null,
        }),
      },
      agent: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'a_product', defaultModelId: null, baseAgentId: null }),
      },
      task: {
        findUnique: jest.fn().mockResolvedValue({
          id: request.taskId,
          mainAgentInstanceId: 'ta_0000000001',
          taskAgents: [
            {
              id: 'ta_0000000001',
              agentId: 'a_product',
              seq: 1,
              alias: '产品经理-1',
              removedAt: null,
              agent: { id: 'a_product', name: '产品经理', role: 'product' },
            },
          ],
        }),
      },
      artifact: { findMany: jest.fn().mockResolvedValue([]) },
      artifactVersion: { findMany: jest.fn().mockResolvedValue([]) },
      taskAgent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ta_0000000001',
          workDir: null,
          seq: 1,
          agent: { id: 'a_product', name: '产品经理' },
        }),
      },
      message: {
        create: jest.fn(),
        // 空历史（群聊历史查询）
        findMany: jest.fn().mockResolvedValue([]),
        // 默认无 processing 流式消息；用例内按 delta/completed 顺序 mockResolvedValueOnce 链
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        // dispatch 前清理目标频道残留 processing（无残留 count=0）
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      chatChannel: {
        // resolveChannel 用 findFirst；delta 需要 type/taskId——一个行对象满足两者
        findUnique: jest.fn().mockResolvedValue({ id: request.channelId, type: 'private', taskId: request.taskId }),
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: request.channelId, type: 'private', taskId: request.taskId }),
      },
    };
    realtime = {
      emit: jest.fn().mockResolvedValue({ id: 'ev_1' }),
      broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }),
    };
    idGen = { nextId: jest.fn().mockResolvedValue('m_0000000002') };
    workersService = { assignWorker: jest.fn().mockResolvedValue('w_0000000001') };
    workerClient = {
      createSession: jest.fn(),
      promptAsync: jest.fn().mockResolvedValue(undefined),
      getMessages: jest.fn().mockResolvedValue([]),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    sessionLifecycle = { bindSessionToWorker: jest.fn(), unbindSession: jest.fn() };
    artifactsService = { onArtifactSubmitted: jest.fn().mockResolvedValue({ status: 'archived' }) };
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-int-'));
    config = {
      get: jest.fn((key: string) => (key === 'WORK_DIR' ? workRoot : undefined)),
    };

    // 真实 ingress + 真实 dispatcher（构造即接线回流回调）
    ingress = new WorkerEventIngress(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      idGen as unknown as IdGeneratorService,
    );
    dispatcher = new WorkerDispatcher(
      prisma as unknown as PrismaService,
      idGen as unknown as IdGeneratorService,
      realtime as unknown as RealtimeService,
      workersService as unknown as WorkersService,
      workerClient as unknown as WorkerClient,
      sessionLifecycle as unknown as SessionLifecycleService,
      artifactsService as unknown as ArtifactsService,
      config as unknown as ConfigService,
      ingress as unknown as WorkerEventIngress,
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(workRoot, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败忽略
    }
  });

  it('端到端主链路：execute(prompt/sessionId/taskId/agentId/channelId) → running → delta → completed 终态化 → idle', async () => {
    // delta 处理：无 processing 流式消息 → 新建（private 全量 parts）
    prisma.message.findFirst
      .mockResolvedValueOnce(null) // delta：新建 processing
      .mockResolvedValueOnce({ id: 'm_stream' }); // task.completed：定位 processing 行终态化
    prisma.message.create.mockResolvedValue({
      ...streamRow,
      status: MESSAGE_STATUS.processing,
      content: {
        text: '中间态',
        parts: [{ type: 'text', text: '中间态', synthetic: false }],
      },
    });
    prisma.message.update.mockResolvedValue(streamRow);

    // 1. dispatch → workerClient.execute 被调用（fire-and-forget，202 即成功）
    await dispatcher.dispatch(request);
    expect(workerClient.execute).toHaveBeenCalledTimes(1);
    const execOpts = workerClient.execute.mock.calls[0][1];
    // wave1 对齐：execute 请求契约 = worker ExecuteRequestPayload（prompt 字段）
    // 阶段 3 按需注入：prompt = 动态任务上下文指令（taskId + MCP 工具引导）+ request.text
    expect(execOpts).toMatchObject({
      prompt: [{ type: 'text', text: expect.stringContaining(request.text) }],
      taskId: request.taskId,
      agentId: 'a_product',
      channelId: request.channelId,
      sessionId: 'ses_0001',
    });
    const execPrompt = execOpts.prompt[0].text as string;
    expect(execPrompt).toContain(`任务 ID：${request.taskId}`);
    expect(execPrompt).toContain('keta-platform');

    // 2. session.updated(running)：worker 上送 opencode 会话 id（ses_ 前缀）→ ingress
    //    反查平台 Session 主键（s_ 前缀）→ updateMany 落库 + emit session.updated
    await ingress.handleEvent(
      event(
        'session.updated',
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 'ses_0001',
          status: 'running',
        },
        'evw_1',
      ),
    );
    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: { instanceRef: 'ses_0001' },
      select: { id: true },
    });
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's_0000000001', status: { not: 'running' } },
      data: { status: 'running' },
    });
    expect(realtime.emit).toHaveBeenCalledWith(
      EVENT_TYPES.SESSION_UPDATED,
      { sessionId: 's_0000000001', status: 'running', workerId: 'w_0000000001' },
      { type: 'task', id: request.taskId },
    );

    // 3. message.part.delta：private 全量 parts 落库 processing + 广播 MESSAGE_PART_DELTA
    const deltaParts = [
      { type: 'reasoning', text: '思考中' },
      { type: 'text', text: '中间态', synthetic: false },
    ];
    await ingress.handleEvent(
      event(
        'message.part.delta',
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 'ses_0001',
          channelId: request.channelId,
          parts: deltaParts,
          status: 'streaming',
        },
        'evw_2',
      ),
    );
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channelId: request.channelId,
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          status: MESSAGE_STATUS.processing,
          content: { text: '中间态', parts: deltaParts },
        }),
      }),
    );
    expect(realtime.emit).toHaveBeenCalledWith(
      EVENT_TYPES.MESSAGE_PART_DELTA,
      expect.objectContaining({
        message: expect.objectContaining({ status: MESSAGE_STATUS.processing }),
        delta: deltaParts,
      }),
      { type: 'channel', id: request.channelId },
    );

    // 4. task.completed：终态化 processing → sent + 广播 chat.message.new + emitFinal
    const finals: unknown[] = [];
    dispatcher.onFinal((e) => finals.push(e));
    await ingress.handleEvent(
      event(
        'task.completed',
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 'ses_0001',
          channelId: request.channelId,
          text: '最终结论',
          parts: [{ type: 'text', text: '最终结论', synthetic: false }],
          tokens: { total: 100, input: 40, output: 60 },
          cost: 0.5,
        },
        'evw_3',
      ),
    );
    await flush();
    // 架构：agent 最终回复落 private 会话频道（resolveChannel 固定 private 反查）；
    // F3 P1 修复：session 绑实例 → 按 taskAgentId 精确匹配（同 agent 多实例各自频道）
    expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
      where: { taskId: request.taskId, taskAgentId: 'ta_0000000001' },
      select: { id: true, type: true },
    });
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm_stream' },
      data: {
        content: {
          text: '最终结论',
          parts: [{ type: 'text', text: '最终结论', synthetic: false }],
        },
        status: MESSAGE_STATUS.sent,
      },
    });
    expect(realtime.broadcast).toHaveBeenCalledWith(
      EVENT_TYPES.CHAT_MESSAGE_NEW,
      expect.objectContaining({ message: expect.objectContaining({ status: MESSAGE_STATUS.sent }) }),
      { type: 'channel', id: request.channelId },
    );
    expect(finals).toHaveLength(1);
    expect(finals[0]).toEqual(
      expect.objectContaining({ taskId: request.taskId, agentId: 'a_product', text: '最终结论' }),
    );

    // 5. session.updated(idle)：反查 s_ 主键落库 + emit
    await ingress.handleEvent(
      event(
        'session.updated',
        { taskId: request.taskId, sessionId: 'ses_0001', status: 'idle' },
        'evw_4',
      ),
    );
    expect(prisma.session.updateMany).toHaveBeenLastCalledWith({
      where: { id: 's_0000000001', status: { not: 'idle' } },
      data: { status: 'idle' },
    });
  });

  it('判死链路：session.updated(running) 经 ingress 完整回流（ses_ → s_）→ 首字 watchdog 清除，60s 后不 emitError', async () => {
    jest.useFakeTimers();
    const errors: unknown[] = [];
    dispatcher.onError((e) => errors.push(e));

    await dispatcher.dispatch(request); // 启动首字 watchdog（注册键 = 平台 s_ 主键）
    // worker 回流 running（sessionId=ses_0001）→ ingress 反查 s_0000000001 → activity
    // 通知 dispatcher → clearPendingWatchdogBySession(s_0000000001) 命中并清除
    await ingress.handleEvent(
      event(
        'session.updated',
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 'ses_0001',
          status: 'running',
        },
        'evw_1',
      ),
    );

    await jest.advanceTimersByTimeAsync(60_000 + 1000);
    await jest.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(0);
    expect(
      realtime.broadcast.mock.calls.some((c) => c[0] === EVENT_TYPES.AGENT_ERROR),
    ).toBe(false);
    jest.useRealTimers();
  });

  it('判死链路：dispatch 后 60s 无任何回流 → 首字 watchdog emitError + agent.error（回归基线）', async () => {
    jest.useFakeTimers();
    const errors: unknown[] = [];
    dispatcher.onError((e) => errors.push(e));

    await dispatcher.dispatch(request);
    await jest.advanceTimersByTimeAsync(60_000 + 1000);
    await jest.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([
      {
        taskId: request.taskId,
        agentId: 'a_product',
        error: expect.stringMatching(/无响应/),
      },
    ]);
    const agentError = realtime.broadcast.mock.calls.find(
      (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
    );
    expect(agentError?.[1]).toEqual(
      expect.objectContaining({ level: 'retry', errorType: 'first_token_timeout' }),
    );
    jest.useRealTimers();
  });
});
