import { Logger } from '@nestjs/common';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import {
  WorkerDispatcher,
  MAX_SILENT_WAKE_ATTEMPTS,
} from './worker-dispatcher';

/**
 * 缺陷 5：成员会话异常终止无感知 —— 派发后无产出、状态变 idle/failed，
 * 全程没有任何失败推送（只有一条不落库的 SSE agent.error，用户与主 Agent 都看不到）。
 *
 * 修复：异常终止（执行失败 / 权限被拒 / 事件静默判败 / 空闲判死）时主动在
 * **团队群聊**落一条系统通知（带终止原因 + sessionId），有任务时另落一条 task_event。
 *
 * 本 spec 断言的可观察属性：
 * ① 一次异常终止 → **恰好一条**可见通知，且带原因与 sessionId；
 * ② 同一终止重复投递 → 不产生第二条；
 * ③ 正常完成 → **不产生**这类通知（不与回执重复通知）。
 */
describe('WorkerDispatcher 异常终止通知（缺陷 5）', () => {
  let prisma: any;
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workersService: { assignWorker: jest.Mock };
  let workerClient: any;
  let sessionLifecycle: any;
  let artifactsService: any;
  let config: { get: jest.Mock };
  let ingress: any;

  const teamId = 'tm_0000000001';
  const teamMemberId = 'tmm_0000000001';
  const agentId = 'a_product';
  const sessionId = 's_0000000001';
  const groupChannelId = 'c_group';
  const dmChannelId = 'c_dm';

  const sessionRow = (overrides: Record<string, unknown> = {}) => ({
    id: sessionId,
    taskId: 't_0000000001',
    teamId,
    teamMemberId,
    agentId,
    workerId: 'w_0000000001',
    instanceRef: 'ses_0001',
    status: 'running',
    ...overrides,
  });

  const createDispatcher = () =>
    new WorkerDispatcher(
      prisma as any,
      idGen as any,
      realtime as any,
      workersService as any,
      workerClient as any,
      sessionLifecycle as any,
      artifactsService as any,
      config as any,
      ingress as any,
      undefined,
      undefined,
      undefined,
      undefined,
    );

  /** 已落库的「异常终止通知」行（按 channelId + 正文文本收集）。 */
  const notices = () =>
    (
      prisma.message.create.mock.calls as Array<
        [
          {
            data: {
              channelId: string;
              senderType: string;
              content: { text: string };
            };
          },
        ]
      >
    )
      .map((c) => c[0].data)
      .filter((d) => d.content.text.includes('【成员会话异常终止】'));

  beforeEach(() => {
    prisma = {
      session: {
        findUnique: jest.fn().mockResolvedValue(sessionRow()),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: sessionId }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      worker: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'w_0000000001', capabilities: {} }),
      },
      agent: { findUnique: jest.fn() },
      artifact: { findMany: jest.fn() },
      artifactVersion: { findMany: jest.fn() },
      message: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            ...data,
            createdAt: new Date('2026-08-07T00:00:00Z'),
          }),
        ),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      agentQuestion: { findFirst: jest.fn().mockResolvedValue(null) },
      chatChannel: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockImplementation(({ where }: any) => {
          if (where?.teamMemberId) {
            return Promise.resolve({
              id: dmChannelId,
              type: CHANNEL_TYPE.private,
            });
          }
          if (where?.type === CHANNEL_TYPE.team_group) {
            return Promise.resolve({
              id: groupChannelId,
              type: CHANNEL_TYPE.team_group,
            });
          }
          return Promise.resolve(null);
        }),
      },
      messageChannel: { findUnique: jest.fn().mockResolvedValue(null) },
      taskMessageChannel: { findMany: jest.fn().mockResolvedValue([]) },
      memory: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      task: { findUnique: jest.fn() },
      taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
      modelUsage: { create: jest.fn().mockResolvedValue({ id: 'us_x' }) },
      teamMember: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({
          alias: '产品经理-1',
          agent: { name: '产品经理' },
        }),
      },
      team: {
        findUnique: jest.fn().mockResolvedValue({ mainAgentMemberId: null }),
      },
    };
    idGen = { nextId: jest.fn().mockResolvedValue('m_0000000002') };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workersService = { assignWorker: jest.fn() };
    workerClient = {
      createSession: jest.fn(),
      promptSession: jest.fn().mockResolvedValue(undefined),
      getMessages: jest.fn().mockResolvedValue([]),
      execute: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
    };
    sessionLifecycle = {
      bindSessionToWorker: jest.fn(),
      unbindSession: jest.fn().mockResolvedValue({ sessionId }),
    };
    artifactsService = {
      onArtifactSubmitted: jest.fn().mockResolvedValue({ status: 'archived' }),
    };
    config = { get: jest.fn().mockReturnValue(undefined) };
    ingress = {
      onTaskCompleted: jest.fn().mockReturnThis(),
      onAgentStatus: jest.fn().mockReturnThis(),
      onSessionActivity: jest.fn().mockReturnThis(),
      invalidateDeltaStream: jest.fn(),
    };
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((() => undefined) as unknown as jest.Mock);
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((() => undefined) as unknown as jest.Mock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('执行失败（v2 session.execution.failed → agent.status{error}）→ 群聊恰好一条通知，带原因与 sessionId', async () => {
    const d = createDispatcher();

    await d.handleAgentStatus({
      taskId: 'team:tm_0000000001',
      agentId,
      sessionId,
      status: 'error',
      error: '执行失败：权限被拒绝（permission denied）',
    });

    const rows = notices();
    expect(rows).toHaveLength(1);
    expect(rows[0].channelId).toBe(groupChannelId);
    expect(rows[0].senderType).toBe(SENDER_TYPE.system);
    expect(rows[0].content.text).toContain('session s_0000000001');
    expect(rows[0].content.text).toContain('权限被拒绝');
    expect(rows[0].content.text).toContain('产品经理-1');
    // 群聊广播（用户侧实时可见）
    expect(
      realtime.broadcast.mock.calls.some(
        (c: any[]) =>
          c[0] === EVENT_TYPES.CHAT_MESSAGE_NEW && (c[1] as any)?.message?.id,
      ),
    ).toBe(true);
    // 有任务 → 另落一条 task_event（可按任务追溯）
    expect(prisma.taskEvent.create).toHaveBeenCalledTimes(1);
    const eventData = prisma.taskEvent.create.mock.calls[0][0].data;
    expect(eventData.eventType).toBe('session.terminated');
    expect(eventData.taskId).toBe('t_0000000001');
    expect(eventData.metadata).toEqual(
      expect.objectContaining({
        sessionId,
        reasonType: 'agent_error',
        reason: expect.stringContaining('权限被拒绝'),
      }),
    );
  });

  it('同一终止重复投递 → 不产生第二条通知（幂等）', async () => {
    const d = createDispatcher();
    const payload = {
      taskId: 'team:tm_0000000001',
      agentId,
      sessionId,
      status: 'error' as const,
      error: '执行失败：模型不可用',
    };

    await d.handleAgentStatus(payload);
    await d.handleAgentStatus(payload);

    expect(notices()).toHaveLength(1);
  });

  it('进程重启后（内存去重失效）群聊内已有同标记通知 → 仍不重复发', async () => {
    // 模拟重启后：群聊里已有同 (sessionId, 终止类型) 的通知行
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'm_old',
        content: {
          text: '【成员会话异常终止】产品经理-1（session s_0000000001，终止类型 agent_error）：旧原因。',
          parts: [],
        },
      },
    ]);
    const d = createDispatcher();

    await d.handleAgentStatus({
      taskId: 'team:tm_0000000001',
      agentId,
      sessionId,
      status: 'error',
      error: '执行失败：模型不可用',
    });

    expect(notices()).toHaveLength(0);
  });

  it('正常完成（task.completed）→ 不产生异常终止通知（不与回执重复通知）', async () => {
    prisma.chatChannel.findFirst.mockResolvedValue({ id: groupChannelId });
    const d = createDispatcher();

    await d.handleTaskCompleted({
      taskId: 't_0000000001',
      agentId,
      sessionId,
      text: '正常完成',
    });

    expect(notices()).toHaveLength(0);
    expect(prisma.taskEvent.create).not.toHaveBeenCalled();
  });

  it('空闲判死 → 群聊一条通知，带判死原因与 sessionId', async () => {
    const d = createDispatcher();
    jest.spyOn(d as any, 'tryAutoRestart').mockResolvedValue(undefined);

    await (d as any).markSessionIdleDead(sessionId);

    const rows = notices();
    expect(rows).toHaveLength(1);
    expect(rows[0].channelId).toBe(groupChannelId);
    expect(rows[0].content.text).toContain('session s_0000000001');
    expect(rows[0].content.text).toContain('长时间无活动');
    expect(rows[0].content.text).toContain('终止类型 agent_idle_timeout');
  });

  it('事件静默判败 → 群聊一条通知（此前只有不落库的 SSE agent.error）', async () => {
    const d = createDispatcher();
    jest.spyOn(d as any, 'tryAutoRestart').mockResolvedValue(undefined);
    prisma.worker.findUnique.mockResolvedValue({
      id: 'w_0000000001',
      status: 'online',
    });
    // 静默唤醒次数已耗尽 → 本次收割直接走失败路径（否则只是再唤醒一轮）
    (d as any).silentWakeAttempts.set(sessionId, MAX_SILENT_WAKE_ATTEMPTS);

    await (d as any).reapSilenceDeadline({
      scope: `team:${teamId}`,
      agentId,
      sessionId,
      workerId: 'w_0000000001',
      teamMemberId,
    });

    const rows = notices();
    expect(rows).toHaveLength(1);
    expect(rows[0].content.text).toContain('session s_0000000001');
    expect(rows[0].content.text).toContain('终止类型 silent_session_timeout');
  });
});
