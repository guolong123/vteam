import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { WorkerDispatcher } from './worker-dispatcher';
import {
  DISPATCH_SNAPSHOT_TTL_MS,
  FALLBACK_WAKE_TEXT,
  dispatchSnapshotKey,
} from './worker-dispatcher';

/**
 * is_7 会话故障恢复重放原始分派快照：
 * dispatch 202 受理后暂存 → tryAutoRestart 重放 → 首字活动/完成清除 → 无快照回退通用语。
 */
describe('WorkerDispatcher dispatch snapshot (is_7)', () => {
  let prisma: any;
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workersService: { assignWorker: jest.Mock };
  let workerClient: {
    createSession: jest.Mock;
    execute: jest.Mock;
    abort: jest.Mock;
    getMessages: jest.Mock;
  };
  let sessionLifecycle: {
    bindSessionToWorker: jest.Mock;
    unbindSession: jest.Mock;
    ensureTeamSession: jest.Mock;
  };
  let artifactsService: { onArtifactSubmitted: jest.Mock };
  let config: { get: jest.Mock };
  let ingress: {
    onTaskCompleted: jest.Mock;
    onAgentStatus: jest.Mock;
    onSessionActivity: jest.Mock;
  };
  let workRoot: string;

  const request = {
    messageId: 'm_0000000001',
    channelId: 'c_0000000001',
    taskId: 't_0000000001',
    teamId: 'tm_0000000001',
    taskContext: { taskId: 't_0000000001' },
    text: '请把登录接口的空指针修了，回归冒烟用例',
    targets: [
      {
        agentId: 'a_product',
        instanceId: 'tmm_0000000001',
        sessionId: 's_0000000001',
      },
    ],
  };

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
    );

  const mockDispatchChain = () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 's_0000000001',
      workerId: null,
      instanceRef: null,
      teamId: 'tm_0000000001',
      teamMemberId: 'tmm_0000000001',
    });
    workersService.assignWorker.mockResolvedValue('w_0000000001');
    prisma.worker.findUnique.mockResolvedValue({
      id: 'w_0000000001',
      capabilities: { maxInstances: 1 },
    });
    prisma.agent.findUnique.mockResolvedValue({
      id: 'a_product',
      name: '产品经理',
      prompt: null,
      persona: null,
      agentKey: 'product',
    });
    workerClient.createSession.mockResolvedValue({ sessionID: 'ses_0001' });
  };

  beforeEach(() => {
    prisma = {
      session: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 's_0000000001' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      worker: { findUnique: jest.fn() },
      agent: { findUnique: jest.fn() },
      artifact: { findMany: jest.fn().mockResolvedValue([]) },
      artifactVersion: { findMany: jest.fn().mockResolvedValue([]) },
      message: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      chatChannel: { findUnique: jest.fn(), findFirst: jest.fn() },
      task: { findUnique: jest.fn() },
      teamMember: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
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
      execute: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn().mockResolvedValue(undefined),
      getMessages: jest.fn().mockResolvedValue([]),
    };
    sessionLifecycle = {
      bindSessionToWorker: jest.fn(),
      unbindSession: jest.fn().mockResolvedValue({ unbound: true }),
      ensureTeamSession: jest.fn().mockResolvedValue({
        id: 's_0000000001',
        agentId: 'a_product',
      }),
    };
    artifactsService = {
      onArtifactSubmitted: jest.fn().mockResolvedValue({ status: 'archived' }),
    };
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-snap-'));
    config = {
      get: jest.fn((key: string) =>
        key === 'WORK_DIR' ? workRoot : undefined,
      ),
    };
    ingress = {
      onTaskCompleted: jest.fn().mockReturnThis(),
      onAgentStatus: jest.fn().mockReturnThis(),
      onSessionActivity: jest.fn().mockReturnThis(),
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(workRoot, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败忽略
    }
  });

  it('dispatch 202 受理后暂存原始 payload 快照', async () => {
    mockDispatchChain();
    const d = createDispatcher();

    await d.dispatch(request);

    expect(workerClient.execute).toHaveBeenCalledTimes(1);
    const snap = (d as any).peekDispatchSnapshot(
      'tm_0000000001',
      'tmm_0000000001',
    );
    expect(snap).toEqual(
      expect.objectContaining({
        text: request.text,
        messageId: request.messageId,
        channelId: request.channelId,
        taskId: request.taskId,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
        agentId: 'a_product',
      }),
    );
  });

  it('execute 失败（未 202）时不暂存快照', async () => {
    mockDispatchChain();
    workerClient.execute.mockRejectedValueOnce(new Error('worker down'));
    const d = createDispatcher();

    await d.dispatch(request);

    expect((d as any).peekDispatchSnapshot('tm_0000000001', 'tmm_0000000001'))
      .toBeUndefined();
  });

  it('tryAutoRestart 有快照时重放原始任务（通用语 + 原始文本）', async () => {
    const d = createDispatcher();
    (d as any).saveDispatchSnapshot({
      text: request.text,
      messageId: request.messageId,
      channelId: request.channelId,
      taskId: request.taskId,
      teamId: 'tm_0000000001',
      teamMemberId: 'tmm_0000000001',
      agentId: 'a_product',
      createdAt: Date.now(),
    });
    prisma.task.findUnique.mockResolvedValue({ status: 'in_progress' });
    prisma.chatChannel.findFirst.mockResolvedValue({
      id: 'c_0000000001',
      type: 'team_group',
    });
    const mentionSpy = jest
      .spyOn(d, 'dispatchAgentMention')
      .mockResolvedValue('s_0000000001');

    await (d as any).tryAutoRestart(
      'tm_0000000001',
      'tmm_0000000001',
      't_0000000001',
    );

    expect(mentionSpy).toHaveBeenCalledTimes(1);
    const text = mentionSpy.mock.calls[0][0].text as string;
    expect(text).toContain(FALLBACK_WAKE_TEXT);
    expect(text).toContain('【原始任务重放】');
    expect(text).toContain(request.text);
    expect(mentionSpy.mock.calls[0][0].kind).toBe('wake');
  });

  it('tryAutoRestart 无快照时回退通用唤醒语（字节一致）', async () => {
    const d = createDispatcher();
    prisma.task.findUnique.mockResolvedValue({ status: 'in_progress' });
    prisma.chatChannel.findFirst.mockResolvedValue({
      id: 'c_0000000001',
      type: 'team_group',
    });
    const mentionSpy = jest
      .spyOn(d, 'dispatchAgentMention')
      .mockResolvedValue('s_0000000001');

    await (d as any).tryAutoRestart(
      'tm_0000000001',
      'tmm_0000000001',
      't_0000000001',
    );

    expect(mentionSpy).toHaveBeenCalledTimes(1);
    expect(mentionSpy.mock.calls[0][0].text).toBe(FALLBACK_WAKE_TEXT);
  });

  it('tryAutoRestart：pending_review（任务未结束）允许恢复——原 in_progress 前置已放宽', async () => {
    const d = createDispatcher();
    prisma.task.findUnique.mockResolvedValue({ status: 'pending_review' });
    prisma.chatChannel.findFirst.mockResolvedValue({
      id: 'c_0000000001',
      type: 'team_group',
    });
    const mentionSpy = jest
      .spyOn(d, 'dispatchAgentMention')
      .mockResolvedValue('s_0000000001');

    await (d as any).tryAutoRestart(
      'tm_0000000001',
      'tmm_0000000001',
      't_0000000001',
    );

    expect(mentionSpy).toHaveBeenCalledTimes(1);
    expect(mentionSpy.mock.calls[0][0].kind).toBe('wake');
  });

  it.each(['completed', 'archived'])(
    'tryAutoRestart：终态 %s 不恢复（与 dispatchAgentMention 的 wake 终态门禁同口径）',
    async (status) => {
      const d = createDispatcher();
      prisma.task.findUnique.mockResolvedValue({ status });
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_0000000001',
        type: 'team_group',
      });
      const mentionSpy = jest
        .spyOn(d, 'dispatchAgentMention')
        .mockResolvedValue('s_0000000001');

      await (d as any).tryAutoRestart(
        'tm_0000000001',
        'tmm_0000000001',
        't_0000000001',
      );

      expect(mentionSpy).not.toHaveBeenCalled();
    },
  );

  it('tryAutoRestart：无 taskId（纯团队直聊）走团队维度恢复，不查任务表', async () => {
    const d = createDispatcher();
    prisma.chatChannel.findFirst.mockResolvedValue({
      id: 'c_0000000001',
      type: 'team_group',
    });
    const mentionSpy = jest
      .spyOn(d, 'dispatchAgentMention')
      .mockResolvedValue('s_0000000001');

    await (d as any).tryAutoRestart('tm_0000000001', 'tmm_0000000001', null);

    expect(prisma.task.findUnique).not.toHaveBeenCalled();
    expect(mentionSpy).toHaveBeenCalledTimes(1);
    const arg = mentionSpy.mock.calls[0][0];
    expect(arg.taskId).toBeNull();
    expect(arg.teamId).toBe('tm_0000000001');
    expect(arg.kind).toBe('wake');
  });

  it('tryAutoRestart：任务行不存在 → 跳过（不误唤醒）', async () => {
    const d = createDispatcher();
    prisma.task.findUnique.mockResolvedValue(null);
    const mentionSpy = jest
      .spyOn(d, 'dispatchAgentMention')
      .mockResolvedValue('s_0000000001');

    await (d as any).tryAutoRestart(
      'tm_0000000001',
      'tmm_0000000001',
      't_0000000001',
    );

    expect(mentionSpy).not.toHaveBeenCalled();
  });

  it('wake 重放文本自身不覆盖原始快照', async () => {
    const d = createDispatcher();
    (d as any).saveDispatchSnapshot({
      text: request.text,
      messageId: request.messageId,
      channelId: request.channelId,
      taskId: request.taskId,
      teamId: 'tm_0000000001',
      teamMemberId: 'tmm_0000000001',
      agentId: 'a_product',
      createdAt: Date.now(),
    });

    (d as any).saveDispatchSnapshot({
      text: `${FALLBACK_WAKE_TEXT}，继续执行以下原始任务：\n\n【原始任务重放】${request.text}`,
      messageId: 'm_0000000009',
      channelId: 'c_0000000001',
      taskId: request.taskId,
      teamId: 'tm_0000000001',
      teamMemberId: 'tmm_0000000001',
      agentId: 'a_product',
      createdAt: Date.now(),
    });

    expect(
      (d as any).peekDispatchSnapshot('tm_0000000001', 'tmm_0000000001').text,
    ).toBe(request.text);
  });

  it('首个非终态活动（首字成功）后清除快照', async () => {
    mockDispatchChain();
    const d = createDispatcher();
    await d.dispatch(request);
    expect(
      (d as any).peekDispatchSnapshot('tm_0000000001', 'tmm_0000000001'),
    ).toBeDefined();

    (d as any).handleSessionActivity({
      type: 'session.updated',
      sessionId: 's_0000000001',
      status: 'running',
    });

    expect((d as any).peekDispatchSnapshot('tm_0000000001', 'tmm_0000000001'))
      .toBeUndefined();
  });

  it('task.completed 落库成功后清除快照', async () => {
    mockDispatchChain();
    const d = createDispatcher();
    await d.dispatch(request);
    expect(
      (d as any).peekDispatchSnapshot('tm_0000000001', 'tmm_0000000001'),
    ).toBeDefined();

    prisma.chatChannel.findUnique.mockResolvedValue(null);
    prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
    prisma.message.create.mockResolvedValue({
      id: 'm_0000000002',
      channelId: request.channelId,
      senderType: SENDER_TYPE.agent,
      senderId: 'a_product',
      content: { text: '已完成', parts: [] },
      mentions: null,
      status: MESSAGE_STATUS.sent,
      createdAt: new Date('2026-08-07T00:00:00Z'),
    });
    prisma.session.findUnique.mockResolvedValue({
      agentId: 'a_product',
      teamId: 'tm_0000000001',
      teamMemberId: 'tmm_0000000001',
    });

    await d.handleTaskCompleted({
      taskId: request.taskId,
      agentId: 'a_product',
      sessionId: 's_0000000001',
      text: '已完成',
    });

    expect((d as any).peekDispatchSnapshot('tm_0000000001', 'tmm_0000000001'))
      .toBeUndefined();
  });

  it('过期快照视为无快照（回退通用语）', async () => {
    const d = createDispatcher();
    (d as any).saveDispatchSnapshot({
      text: request.text,
      messageId: request.messageId,
      channelId: request.channelId,
      taskId: request.taskId,
      teamId: 'tm_0000000001',
      teamMemberId: 'tmm_0000000001',
      agentId: 'a_product',
      createdAt: Date.now(),
    });
    // 人为推前创建时间，模拟 TTL 过期
    const key = dispatchSnapshotKey('tm_0000000001', 'tmm_0000000001');
    const stored = (d as any).dispatchSnapshots.get(key);
    stored.createdAt = Date.now() - DISPATCH_SNAPSHOT_TTL_MS - 1000;

    prisma.task.findUnique.mockResolvedValue({ status: 'in_progress' });
    prisma.chatChannel.findFirst.mockResolvedValue({
      id: 'c_0000000001',
      type: 'team_group',
    });
    const mentionSpy = jest
      .spyOn(d, 'dispatchAgentMention')
      .mockResolvedValue('s_0000000001');

    await (d as any).tryAutoRestart(
      'tm_0000000001',
      'tmm_0000000001',
      't_0000000001',
    );

    expect(mentionSpy.mock.calls[0][0].text).toBe(FALLBACK_WAKE_TEXT);
  });
});
