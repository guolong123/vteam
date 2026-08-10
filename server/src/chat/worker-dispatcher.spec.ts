import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CHANNEL_TYPE,
  EVENT_TYPES,
  MESSAGE_STATUS,
  SENDER_TYPE,
} from '../common/constants/event.constants';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { WorkerClient, WorkerUnavailableException } from '../workers/worker.client';
import { WorkerEventIngress } from '../workers/worker-event.ingress';
import { WorkersService } from '../workers/workers.service';
import {
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  DEFAULT_CHAT_HISTORY_MAX_BYTES,
  DEFAULT_DOCLIB_MAX_BYTES,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DISPATCH_TIMEOUT_MS,
  IDLE_SCAN_INTERVAL_MS,
  escapeXml,
  extractArtifacts,
  PENDING_INSTANCE_REF,
  POLL_INTERVAL_MS,
  aggregateText,
  findError,
  findFinish,
  truncateUtf8,
  WorkerDispatcher,
} from './worker-dispatcher';

describe('WorkerDispatcher', () => {
  let prisma: {
    session: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    worker: { findUnique: jest.Mock };
    agent: { findUnique: jest.Mock };
    artifact: { findMany: jest.Mock };
    artifactVersion: { findMany: jest.Mock };
    message: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    chatChannel: { findUnique: jest.Mock; findFirst: jest.Mock };
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
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
  let ingress: {
    onTaskCompleted: jest.Mock;
    onAgentStatus: jest.Mock;
    onSessionActivity: jest.Mock;
  };
  /** F3 MINOR-3：每次测试独立的临时任务工作目录根（config WORK_DIR 指向），afterEach 清理。 */
  let workRoot: string;

  const request = {
    messageId: 'm_0000000001',
    channelId: 'c_0000000001',
    taskId: 't_0000000001',
    text: '你好，请处理',
    targets: [{ agentId: 'a_product', sessionId: 's_0000000001' }],
  };

  const messageRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'm_0000000002',
    channelId: request.channelId,
    senderType: SENDER_TYPE.agent,
    senderId: 'a_product',
    content: { text: '已完成', parts: [] },
    mentions: null,
    status: MESSAGE_STATUS.sent,
    createdAt: new Date('2026-08-07T00:00:00Z'),
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
    );

  beforeEach(() => {
    prisma = {
      session: {
        findUnique: jest.fn(),
        // 空闲判死路径（scanIdleSessions）会 update(status=failed)；默认未触发
        update: jest.fn().mockResolvedValue({ id: 's_0000000001' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      worker: { findUnique: jest.fn() },
      agent: { findUnique: jest.fn() },
      artifact: { findMany: jest.fn() },
      artifactVersion: { findMany: jest.fn() },
      // 默认空历史（dispatch 新增群聊历史查询；未注入 → 既有测试 prompt 行为不变）
      message: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        // 默认无 processing 流式消息 → handleTaskCompleted 走 create 落库路径（兼容既有测试）
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      chatChannel: { findUnique: jest.fn(), findFirst: jest.fn() },
    };
    idGen = { nextId: jest.fn().mockResolvedValue('m_0000000002') };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    workersService = { assignWorker: jest.fn() };
    workerClient = {
      createSession: jest.fn(),
      promptAsync: jest.fn().mockResolvedValue(undefined),
      // F2 C1：dispatch 启动自持轮询（后台），默认永不完成（[]）→ 超时路径不进断言
      getMessages: jest.fn().mockResolvedValue([]),
      // 方案 A：dispatch 调 worker 执行端点 POST /execute（202 即成功，fire-and-forget）
      execute: jest.fn().mockResolvedValue(undefined),
    };
    sessionLifecycle = {
      bindSessionToWorker: jest.fn(),
      unbindSession: jest.fn().mockResolvedValue({ sessionId: 's_0000000001', unbound: true }),
    };
    artifactsService = { onArtifactSubmitted: jest.fn().mockResolvedValue({ status: 'archived' }) };
    // F3 MINOR-3：WORK_DIR 指向独立临时根（dispatch 会真实 mkdir 任务目录，隔离系统目录）
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-wd-'));
    config = {
      get: jest.fn((key: string) => (key === 'WORK_DIR' ? workRoot : undefined)),
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
      // 清理失败忽略（临时目录，不影响断言）
    }
  });

  // ------------------------------------------------------------------
  // T9 接线：构造时注册回流回调
  // ------------------------------------------------------------------

  describe('构造时向 WorkerEventIngress 注册回流回调（T9 接线）', () => {
    it('注册 onTaskCompleted + onAgentStatus + onSessionActivity', () => {
      createDispatcher();
      expect(ingress.onTaskCompleted).toHaveBeenCalledTimes(1);
      expect(ingress.onAgentStatus).toHaveBeenCalledTimes(1);
      // 判死 watchdog：ingress 活动事件通知回调（清除首字 watchdog + 刷新 idle 计时）
      expect(ingress.onSessionActivity).toHaveBeenCalledTimes(1);
    });

    it('ingress 触发 task.completed 回调 → 回流落库+广播+emitFinal（D5 归 WorkerDispatcher）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(null);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      // 回调为 fire-and-forget（void handleTaskCompleted），直接调内部回流处理断言
      await d.handleTaskCompleted({ taskId: request.taskId, agentId: 'a_product', text: '完成' });

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ senderId: 'a_product', senderType: 'agent' }),
        }),
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'channel', id: request.channelId },
      );
      expect(finals).toHaveLength(1);
      // 注册的回调触发不抛错（ingress notify 吞异常语义）
      const cb = ingress.onTaskCompleted.mock.calls[0][0];
      expect(() => cb({ taskId: request.taskId, agentId: 'a_product', text: 'x' })).not.toThrow();
    });
  });

  // ------------------------------------------------------------------
  // dispatch：定位/分配 worker → 下发
  // ------------------------------------------------------------------

  describe('dispatch：分配 worker 全链', () => {
    beforeEach(() => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: null,
        instanceRef: null,
      });
      workersService.assignWorker.mockResolvedValue('w_0000000001');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: { maxInstances: 1 },
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession.mockResolvedValue({ sessionID: 'ses_0001' });
    });

    it('未绑 session：assignWorker → bind(pending) → createSession → bind(真实) → promptAsync 全链', async () => {
      const d = createDispatcher();
      const result = await d.dispatch(request);

      expect(result).toEqual({ replies: [] });
      // 分配 worker + 两次 bind（占位 → 真实 instanceRef）
      expect(workersService.assignWorker).toHaveBeenCalledTimes(1);
      expect(sessionLifecycle.bindSessionToWorker).toHaveBeenNthCalledWith(
        1,
        's_0000000001',
        'w_0000000001',
        PENDING_INSTANCE_REF,
      );
      expect(sessionLifecycle.bindSessionToWorker).toHaveBeenNthCalledWith(
        2,
        's_0000000001',
        'w_0000000001',
        'ses_0001',
      );
      // 创建会话（携带 defaultModelId 拆分后的模型）
      expect(workerClient.createSession).toHaveBeenCalledWith(
        { id: 'w_0000000001', capabilities: { maxInstances: 1 } },
        { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      );
      // 下发执行（方案 A：POST /execute，fire-and-forget，202 即成功；不再自持轮询）
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        expect.objectContaining({
          model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
          prompt: [{ type: 'text', text: request.text }],
          taskId: request.taskId,
          agentId: 'a_product',
          channelId: request.channelId,
          sessionId: 'ses_0001',
        }),
      );
      // 方案 A：dispatch 不再直连 serve（promptAsync 停用），不启动自持轮询
      expect(workerClient.promptAsync).not.toHaveBeenCalled();
      expect(workerClient.getMessages).not.toHaveBeenCalled();
    });

    it('loading 时序：thinking → operating 两阶段广播 + onLoading 回调', async () => {
      const d = createDispatcher();
      const loading: unknown[] = [];
      d.onLoading((e) => loading.push(e));

      await d.dispatch(request);

      expect(
        realtime.broadcast.mock.calls
          .filter((c) => c[0] === EVENT_TYPES.AGENT_LOADING)
          .map((c) => [c[1].phase, c[2]]),
      ).toEqual([
        ['thinking', { type: 'task', id: request.taskId }],
        ['operating', { type: 'task', id: request.taskId }],
      ]);
      expect(loading).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 's_0000000001',
          phase: 'thinking',
        },
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 's_0000000001',
          phase: 'operating',
        },
      ]);
    });

    it('无可用 worker：emitError + 广播 agent.error，不创建会话（D3 报错不降级）', async () => {
      workersService.assignWorker.mockResolvedValue(null);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);

      expect(errors).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          error: expect.stringMatching(/无可用 worker/),
        },
      ]);
      expect(workerClient.createSession).not.toHaveBeenCalled();
      expect(workerClient.promptAsync).not.toHaveBeenCalled();
      expect(workerClient.execute).not.toHaveBeenCalled();
      expect(
        realtime.broadcast.mock.calls.some(
          (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
        ),
      ).toBe(true);
    });

    it('已绑 worker：复用（不 assignWorker/不 createSession），直接 promptAsync', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      const d = createDispatcher();

      await d.dispatch(request);

      expect(workersService.assignWorker).not.toHaveBeenCalled();
      expect(workerClient.createSession).not.toHaveBeenCalled();
      expect(sessionLifecycle.bindSessionToWorker).not.toHaveBeenCalled();
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        expect.objectContaining({
          sessionId: 'ses_0001',
          taskId: request.taskId,
          agentId: 'a_product',
          channelId: request.channelId,
        }),
      );
    });

    it('回归：绑定在线 worker（status=online）→ 直接复用，不重新分配/不解绑', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'online',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      await d.dispatch(request);

      expect(workersService.assignWorker).not.toHaveBeenCalled();
      expect(sessionLifecycle.unbindSession).not.toHaveBeenCalled();
      expect(sessionLifecycle.bindSessionToWorker).not.toHaveBeenCalled();
      expect(workerClient.createSession).not.toHaveBeenCalled();
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        expect.objectContaining({ sessionId: 'ses_0001' }),
      );
    });

    it('修复：绑定 offline worker → 解绑 + 重新分配在线 worker（不复用离线节点）', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_offline',
        instanceRef: 'ses_stale',
      });
      // 第一次查询命中绑定 worker（offline）→ 触发解绑重分配；第二次查询返回新 worker
      prisma.worker.findUnique
        .mockResolvedValueOnce({ id: 'w_offline', status: 'offline', capabilities: {} })
        .mockResolvedValueOnce({ id: 'w_online', status: 'online', capabilities: {} });
      workersService.assignWorker.mockResolvedValue('w_online');
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession.mockResolvedValue({ sessionID: 'ses_online' });
      const d = createDispatcher();

      await d.dispatch(request);

      // 解绑被调用（释放离线 worker 绑定，Session 恢复 created）
      expect(sessionLifecycle.unbindSession).toHaveBeenCalledWith('s_0000000001');
      // 重新分配在线 worker
      expect(workersService.assignWorker).toHaveBeenCalledTimes(1);
      // 重新绑定（pending → 真实 instanceRef）
      expect(sessionLifecycle.bindSessionToWorker).toHaveBeenNthCalledWith(
        1,
        's_0000000001',
        'w_online',
        PENDING_INSTANCE_REF,
      );
      expect(sessionLifecycle.bindSessionToWorker).toHaveBeenNthCalledWith(
        2,
        's_0000000001',
        'w_online',
        'ses_online',
      );
      // 下发到新 worker 的新会话，不复用离线 worker 的旧会话
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_online' }),
        expect.objectContaining({ sessionId: 'ses_online' }),
      );
      expect(workerClient.execute).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_offline' }),
        expect.anything(),
      );
    });

    it('修复：绑定 worker 行缺失（已删除）→ 解绑 + 重新分配，无可用则报错', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_deleted',
        instanceRef: 'ses_gone',
      });
      prisma.worker.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'w_online', status: 'online', capabilities: {} });
      workersService.assignWorker.mockResolvedValue('w_online');
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession.mockResolvedValue({ sessionID: 'ses_online' });
      const d = createDispatcher();

      await d.dispatch(request);

      expect(sessionLifecycle.unbindSession).toHaveBeenCalledWith('s_0000000001');
      expect(workersService.assignWorker).toHaveBeenCalledTimes(1);
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_online' }),
        expect.objectContaining({ sessionId: 'ses_online' }),
      );
    });

    it('sessionId 为 null：emitError 且不触碰 worker 链路', async () => {
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch({ ...request, targets: [{ agentId: 'a_product', sessionId: null }] });

      expect(errors).toHaveLength(1);
      expect(workersService.assignWorker).not.toHaveBeenCalled();
      expect(prisma.session.findUnique).not.toHaveBeenCalled();
    });

    it('createSession 失败：emitError + 广播 agent.error，返回空 replies', async () => {
      workerClient.createSession.mockRejectedValue(
        new WorkerUnavailableException('w_0000000001', 'createSession HTTP 503'),
      );
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      const result = await d.dispatch(request);

      expect(result).toEqual({ replies: [] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({ agentId: 'a_product' }),
      );
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({ level: 'message', errorType: 'dispatch_failed' }),
      );
    });

    it('F2 M5：createSession 失败 → 回滚绑定（unbindSession）防 Session 绑坏 worker', async () => {
      workerClient.createSession.mockRejectedValue(
        new WorkerUnavailableException('w_0000000001', 'createSession HTTP 503'),
      );
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);

      expect(sessionLifecycle.unbindSession).toHaveBeenCalledWith(
        's_0000000001',
      );
      expect(errors).toHaveLength(1);
      expect(workerClient.promptAsync).not.toHaveBeenCalled();
      expect(workerClient.execute).not.toHaveBeenCalled();
    });

    it('F2 M5：残留 pending 绑定（上次分派中断）→ 视为未绑定重新分配 worker', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_stale',
        instanceRef: PENDING_INSTANCE_REF,
      });
      workersService.assignWorker.mockResolvedValue('w_fresh');
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_fresh', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession.mockResolvedValue({ sessionID: 'ses_fresh' });
      const d = createDispatcher();

      await d.dispatch(request);

      // 重新分配 + 两次 bind（pending → 真实）
      expect(workersService.assignWorker).toHaveBeenCalledTimes(1);
      expect(sessionLifecycle.bindSessionToWorker).toHaveBeenNthCalledWith(
        1,
        's_0000000001',
        'w_fresh',
        PENDING_INSTANCE_REF,
      );
      expect(sessionLifecycle.bindSessionToWorker).toHaveBeenNthCalledWith(
        2,
        's_0000000001',
        'w_fresh',
        'ses_fresh',
      );
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_fresh' }),
        expect.objectContaining({ sessionId: 'ses_fresh' }),
      );
    });

    it('多目标串行：各自 loading/下发，单目标失败不阻塞其他（onError 聚合）', async () => {
      workersService.assignWorker
        .mockResolvedValueOnce(null) // 第一个目标无 worker → 失败
        .mockResolvedValueOnce('w_0000000001'); // 第二个正常
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch({
        ...request,
        targets: [
          { agentId: 'a_product', sessionId: 's_1' },
          { agentId: 'a_developer', sessionId: 's_2' },
        ],
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(expect.objectContaining({ agentId: 'a_product' }));
      // 第二个目标正常下发
      expect(workerClient.execute).toHaveBeenCalledTimes(1);
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessionId: 'ses_0001' }),
      );
    });
  });

  // ------------------------------------------------------------------
  // C7 模型解析优先级链（Agent→模板 baseAgentId 链→worker 默认→null）
  // ------------------------------------------------------------------

  describe('C7 模型解析优先级链', () => {
    beforeEach(() => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: null,
        instanceRef: null,
      });
      workersService.assignWorker.mockResolvedValue('w_0000000001');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: { maxInstances: 1 },
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession.mockResolvedValue({ sessionID: 'ses_0001' });
    });

    it('Agent 显式 defaultModelId：assignWorker 携带 modelId 过滤 + createSession 用拆分模型', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();

      await d.dispatch(request);

      // 阶段 1 解析非空 → assignWorker 按模型过滤
      expect(workersService.assignWorker).toHaveBeenCalledWith({
        modelId: 'opencode-go/deepseek-v4-flash',
      });
      // 阶段 2 最终模型 = Agent 显式模型
      expect(workerClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      );
    });

    it('Agent 未配 → 沿 baseAgentId 链（多层 clone）取最近非空模板默认模型', async () => {
      prisma.agent.findUnique
        .mockResolvedValueOnce({
          id: 'a_clone2',
          defaultModelId: null,
          baseAgentId: 'a_clone1',
          type: 'clone',
        })
        .mockResolvedValueOnce({
          id: 'a_clone1',
          defaultModelId: null,
          baseAgentId: 'a_product',
          type: 'clone',
        })
        .mockResolvedValueOnce({
          id: 'a_product',
          defaultModelId: 'opencode/glm-5.1',
          baseAgentId: null,
          type: 'template',
        });
      const d = createDispatcher();

      await d.dispatch(request);

      expect(workersService.assignWorker).toHaveBeenCalledWith({
        modelId: 'opencode/glm-5.1',
      });
      expect(workerClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        { providerID: 'opencode', modelID: 'glm-5.1' },
      );
    });

    it('Agent/模板均未配 → 跳过过滤 + 用执行 worker 的 defaultModelId 兜底', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
        baseAgentId: null,
        type: 'template',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: { maxInstances: 1 },
        defaultModelId: 'opencode/deepseek-v4-pro',
      });
      const d = createDispatcher();

      await d.dispatch(request);

      // 解析为 null → assignWorker 不过滤（无参调用，回归现状）
      expect(workersService.assignWorker).toHaveBeenCalledWith({});
      // 阶段 2 用 worker 默认模型
      expect(workerClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        { providerID: 'opencode', modelID: 'deepseek-v4-pro' },
      );
    });

    it('全链无模型 + worker 无默认 → 最终模型 null（不指定，serve 默认）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
        baseAgentId: null,
        type: 'template',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: { maxInstances: 1 },
        defaultModelId: null,
      });
      const d = createDispatcher();

      await d.dispatch(request);

      expect(workerClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        null,
      );
    });

    it('回归：绑定 offline worker 重分配时 assignWorker 仍携带模型过滤', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_offline',
        instanceRef: 'ses_stale',
      });
      prisma.worker.findUnique
        .mockResolvedValueOnce({ id: 'w_offline', status: 'offline', capabilities: {} })
        .mockResolvedValueOnce({
          id: 'w_online',
          status: 'online',
          capabilities: {},
          defaultModelId: null,
        });
      workersService.assignWorker.mockResolvedValue('w_online');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      workerClient.createSession.mockResolvedValue({ sessionID: 'ses_online' });
      const d = createDispatcher();

      await d.dispatch(request);

      // 解绑重分配的 assignWorker 同样带 modelId 过滤
      expect(workersService.assignWorker).toHaveBeenCalledTimes(1);
      expect(workersService.assignWorker).toHaveBeenCalledWith({
        modelId: 'opencode-go/deepseek-v4-flash',
      });
      expect(workerClient.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_online' }),
        { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
      );
    });
  });

  // ------------------------------------------------------------------
  // dispatch：doclib 上下文注入（12 篇 §8）
  // ------------------------------------------------------------------

  describe('doclib 上下文注入', () => {
    beforeEach(() => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
    });

    it('任务有产出物：prompt 前缀注入 <doclib> 块（产出物清单 + 最新版本正文）', async () => {
      prisma.artifact.findMany.mockResolvedValue([
        {
          id: 'art_1',
          type: 'doc',
          title: '需求文档',
          currentVersion: 3,
          updatedAt: new Date('2026-08-06T00:00:00Z'),
        },
      ]);
      prisma.artifactVersion.findMany.mockResolvedValue([
        { artifactId: 'art_1', contentRef: '需求正文 v3', authorAgentId: 'a_product' },
      ]);
      const d = createDispatcher();

      await d.dispatch(request);

      const promptArgs = workerClient.execute.mock.calls[0][1] as {
        prompt: Array<{ text: string }>;
      };
      const promptText = promptArgs.prompt[0].text;
      expect(promptText).toContain('<doclib>');
      expect(promptText).toContain('需求文档');
      expect(promptText).toContain('version="v3"');
      expect(promptText).toContain('需求正文 v3');
      // 注入到 prompt 文本前
      expect(promptText).toMatch(/<doclib>[\s\S]*<\/doclib>\n\n你好，请处理/);
    });

    it('任务无产出物：doclib 为空，prompt 原文透传', async () => {
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      await d.dispatch(request);

      const promptText = (
        workerClient.execute.mock.calls[0][1] as { prompt: Array<{ text: string }> }
      ).prompt[0].text;
      expect(promptText).toBe(request.text);
    });

    it('F2 MINOR：doclib 总大小截断后补 </doclib> 闭合标签（防切裂结尾）', async () => {
      prisma.artifact.findMany.mockResolvedValue([
        {
          id: 'art_1',
          type: 'doc',
          title: '大文档',
          currentVersion: 1,
          updatedAt: new Date('2026-08-08T00:00:00Z'),
        },
      ]);
      prisma.artifactVersion.findMany.mockResolvedValue([
        {
          artifactId: 'art_1',
          contentRef: 'x'.repeat(200 * 1024),
          authorAgentId: 'a_product',
        },
      ]);
      const d = createDispatcher();
      d.doclibTotalBytes = 64; // 极小值强制触发整体截断

      await d.dispatch(request);

      const promptText = (
        workerClient.execute.mock.calls[0][1] as { prompt: Array<{ text: string }> }
      ).prompt[0].text;
      expect(promptText).toContain('<doclib>');
      expect(promptText).toMatch(/<\/doclib>\n\n你好，请处理/);
    });
  });

  // ------------------------------------------------------------------
  // handleTaskCompleted：回流处理（落库 + 广播 + emitFinal + 产出物归档）
  // ------------------------------------------------------------------

  describe('handleTaskCompleted 回流处理（D5）', () => {
    beforeEach(() => {
      prisma.chatChannel.findUnique.mockResolvedValue(null);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      prisma.message.create.mockResolvedValue(messageRow());
    });

    it('落库(agent) → 广播 chat.message.new(channel) → emitFinal', async () => {
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '已完成',
        parts: [{ type: 'text', text: '已完成' }],
        tokens: { total: 10 },
        cost: 0.1,
      });

      // 落库：senderType=agent，status=sent，content 含 text+parts
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: 'm_0000000002',
          channelId: request.channelId,
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          content: { text: '已完成', parts: [{ type: 'text', text: '已完成' }] },
          mentions: null,
          status: MESSAGE_STATUS.sent,
        }),
      });
      // 广播：chat.message.new（channel scope）
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ id: 'm_0000000002' }) },
        { type: 'channel', id: request.channelId },
      );
      expect(finals).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          messageId: 'm_0000000002',
          text: '已完成',
        },
      ]);
    });

    it('payload 无 agentId：经 sessionId 反查 Session.agentId 定位发件人', async () => {
      prisma.session.findUnique.mockResolvedValue({ agentId: 'a_architect' });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        sessionId: 's_0000000001',
        text: '架构结论',
      });

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ senderId: 'a_architect' }),
        }),
      );
    });

    it('artifacts 声明 → ArtifactsService.onArtifactSubmitted 归档', async () => {
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '产出需求文档',
        artifacts: [
          { type: 'text', title: '需求说明', content: '内容一' },
          { type: 'doc', title: '设计文档', content: '', fileRef: 'file://x' },
        ],
      });

      expect(artifactsService.onArtifactSubmitted).toHaveBeenCalledTimes(2);
      expect(artifactsService.onArtifactSubmitted).toHaveBeenNthCalledWith(1, {
        taskId: request.taskId,
        type: 'text',
        title: '需求说明',
        content: '内容一',
      });
      expect(artifactsService.onArtifactSubmitted).toHaveBeenNthCalledWith(2, {
        taskId: request.taskId,
        type: 'doc',
        title: '设计文档',
        content: '',
        fileRef: 'file://x',
      });
    });

    it('频道定位：私聊频道（taskId+agentId）优先，群聊频道回退', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({ id: 'c_dm' });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '私聊回复',
      });

      expect(prisma.chatChannel.findUnique).toHaveBeenCalledWith({
        where: {
          taskId_agentId: { taskId: request.taskId, agentId: 'a_product' },
        },
        select: { id: true, type: true },
      });
      expect(prisma.chatChannel.findFirst).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channelId: 'c_dm' }),
        }),
      );
    });

    it('频道不存在：跳过落库但 emitError 提示', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '回复',
      });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
    });

    it('payload 无 channelId（ingress 回调路径）→ 不查 preferred，DM 优先（保持现状）', async () => {
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.taskId_agentId) return Promise.resolve({ id: 'c_dm' });
        return Promise.resolve(null);
      });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: 'ingress 回复',
      });

      // 落 DM（无 preferredChannelId 时 DM 优先，现状不变）
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channelId: 'c_dm' }),
        }),
      );
      // 从未执行 preferred（findUnique by id）查询
      expect(prisma.chatChannel.findUnique.mock.calls.some((c) => c[0]?.where?.id)).toBe(false);
    });

    it('终态化：流式期间存在 processing 消息 → task.completed 更新为 sent（不新建，避免双消息）', async () => {
      prisma.message.findFirst.mockResolvedValue({
        id: 'm_stream_1',
        content: { text: '部分', parts: [{ type: 'text', text: '部分', synthetic: false }] },
      });
      prisma.message.update.mockResolvedValue({
        id: 'm_stream_1',
        channelId: request.channelId,
        senderType: SENDER_TYPE.agent,
        senderId: 'a_product',
        content: { text: '最终', parts: [{ type: 'text', text: '最终' }] },
        mentions: null,
        status: MESSAGE_STATUS.sent,
        createdAt: new Date('2026-08-10T00:00:00Z'),
      });
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '最终',
        parts: [{ type: 'text', text: '最终' }],
      });

      // 不新建：查找 processing 消息 → update 为 sent 终态（内容最终化）
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          channelId: request.channelId,
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          status: MESSAGE_STATUS.processing,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_stream_1' },
        data: {
          content: { text: '最终', parts: [{ type: 'text', text: '最终' }] },
          status: MESSAGE_STATUS.sent,
        },
      });
      // 广播 chat.message.new + emitFinal（用终态化后的消息）
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            id: 'm_stream_1',
            status: MESSAGE_STATUS.sent,
          }),
        },
        { type: 'channel', id: request.channelId },
      );
      expect(finals).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          messageId: 'm_stream_1',
          text: '最终',
        },
      ]);
    });

    it('缺少 taskId/agentId：不落库不崩溃', async () => {
      const d = createDispatcher();

      await d.handleTaskCompleted({ text: '无归属回复' });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.session.findUnique).not.toHaveBeenCalled();
    });

    it('F3 缺陷①：task_group 终态化 → content.parts 只含结论 text（reasoning/tool 被过滤）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(null);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: request.channelId,
        type: CHANNEL_TYPE.task_group,
      });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '结论',
        parts: [
          { type: 'text', text: '结论' },
          { type: 'reasoning', text: '思考过程', synthetic: true },
          { type: 'tool', name: 'read', input: 'x', output: 'y', synthetic: true },
        ],
      });

      // 终态化落库 parts 与 delta 路径（extractConclusionParts）行为一致：reasoning/tool 剔除
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          content: {
            text: '结论',
            parts: [{ type: 'text', text: '结论' }],
          },
          status: MESSAGE_STATUS.sent,
        }),
      });
    });

    it('F3 缺陷①：private 终态化 → parts 全量保留（reasoning/tool 前端折叠展示）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_dm',
        taskId: request.taskId,
        type: CHANNEL_TYPE.private,
      });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '结论',
        parts: [
          { type: 'text', text: '结论' },
          { type: 'reasoning', text: '思考过程', synthetic: true },
          { type: 'tool', name: 'read', input: 'x', output: 'y', synthetic: true },
        ],
      });

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'c_dm',
          content: {
            text: '结论',
            parts: [
              { type: 'text', text: '结论' },
              { type: 'reasoning', text: '思考过程', synthetic: true },
              { type: 'tool', name: 'read', input: 'x', output: 'y', synthetic: true },
            ],
          },
        }),
      });
    });
  });

  // ------------------------------------------------------------------
  // handleAgentStatus：agent.loading / agent.error 本地回调映射
  // ------------------------------------------------------------------

  describe('handleAgentStatus 映射（SSE emit 归 T9，此处仅回调通知）', () => {
    it('phase=thinking → emitLoading（thinking）', async () => {
      const d = createDispatcher();
      const loading: unknown[] = [];
      d.onLoading((e) => loading.push(e));

      await d.handleAgentStatus({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_1',
        phase: 'thinking',
      });

      expect(loading).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 's_1',
          phase: 'thinking',
        },
      ]);
      // 不重复广播（防双写，T9 已 emit SSE）
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('phase=operating/缺省 → emitLoading（operating）', async () => {
      const d = createDispatcher();
      const loading: unknown[] = [];
      d.onLoading((e) => loading.push(e));

      await d.handleAgentStatus({ taskId: request.taskId, agentId: 'a_product', phase: 'operating' });

      expect(loading).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: null,
          phase: 'operating',
        },
      ]);
    });

    it('status=error / 带 error → emitError', async () => {
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.handleAgentStatus({
        taskId: request.taskId,
        agentId: 'a_product',
        status: 'error',
        error: 'worker 无响应',
      });

      expect(errors).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          error: 'worker 无响应',
        },
      ]);
    });

    it('缺 taskId/agentId：忽略', async () => {
      const d = createDispatcher();
      const loading: unknown[] = [];
      const errors: unknown[] = [];
      d.onLoading((e) => loading.push(e)).onError((e) => errors.push(e));

      await d.handleAgentStatus({ phase: 'thinking' });

      expect(loading).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // 判死 watchdog（方案 A：首字超时 + 空闲判死）
  // ------------------------------------------------------------------

  describe('判死 watchdog（首字超时 60s + 空闲判死 30min）', () => {
    const dispatchSetup = () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
    };

    it('dispatch 后 60s 无事件回流 → emitError「无响应」+ 广播 agent.error（first_token_timeout）', async () => {
      jest.useFakeTimers();
      dispatchSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      expect(errors).toHaveLength(0);

      await jest.advanceTimersByTimeAsync(DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
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

    it('60s 内收到 session.updated(running) → 首字 watchdog 清除，不再 emitError', async () => {
      jest.useFakeTimers();
      dispatchSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request); // 启动首字 watchdog
      // ingress 活动回调：session.updated(running) 到达（模型已开始产出）
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({ type: 'session.updated', sessionId: 's_0000000001', status: 'running' });
      await jest.advanceTimersByTimeAsync(DEFAULT_FIRST_TOKEN_TIMEOUT_MS + 1000);
      await jest.advanceTimersByTimeAsync(0);

      expect(errors).toHaveLength(0);
      jest.useRealTimers();
    });

    it('回流成功（task.completed）：清除首字 watchdog，不再 emitError', async () => {
      jest.useFakeTimers();
      dispatchSetup();
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request); // 启动 watchdog
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '已完成',
      });
      await jest.advanceTimersByTimeAsync(DEFAULT_FIRST_TOKEN_TIMEOUT_MS + 1000);

      expect(errors).toHaveLength(0);
      jest.useRealTimers();
    });

    it('running 后空闲 30min（无 delta）→ 判死：session failed + agent.error', async () => {
      jest.useFakeTimers();
      // dispatch 的会话查询（workerId/instanceRef）
      prisma.session.findUnique
        .mockResolvedValueOnce({
          id: 's_0000000001',
          workerId: 'w_0000000001',
          instanceRef: 'ses_0001',
        })
        // 空闲判死扫描的状态查询（running）
        .mockResolvedValue({
          id: 's_0000000001',
          status: 'running',
          taskId: request.taskId,
          agentId: 'a_product',
        });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      // 首个事件：session.updated(running) 清除首字 watchdog，进入空闲判死追踪
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({ type: 'session.updated', sessionId: 's_0000000001', status: 'running' });
      expect(errors).toHaveLength(0);

      // 推进超过 idle 超时 + 一个扫描周期（触发 interval 回调）
      await jest.advanceTimersByTimeAsync(
        DEFAULT_AGENT_IDLE_TIMEOUT_MS + IDLE_SCAN_INTERVAL_MS + 1000,
      );
      await jest.advanceTimersByTimeAsync(0);

      // 判死：session 标 failed
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: { status: 'failed' },
      });
      expect(errors).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          error: expect.stringMatching(/已判死/),
        },
      ]);
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({ level: 'retry', errorType: 'agent_idle_timeout' }),
      );
      jest.useRealTimers();
    });

    it('空闲期间有 delta（有活动）→ 刷新计时，不判死不误杀', async () => {
      jest.useFakeTimers();
      prisma.session.findUnique
        .mockResolvedValueOnce({
          id: 's_0000000001',
          workerId: 'w_0000000001',
          instanceRef: 'ses_0001',
        })
        .mockResolvedValue({
          id: 's_0000000001',
          status: 'running',
          taskId: request.taskId,
          agentId: 'a_product',
        });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({ type: 'session.updated', sessionId: 's_0000000001', status: 'running' });

      // 推进接近 idle 超时（未到）
      await jest.advanceTimersByTimeAsync(DEFAULT_AGENT_IDLE_TIMEOUT_MS - 5000);
      // 中途 delta 到达 → 刷新 lastActivityAt（有活动不误杀）
      activityCb({ type: 'message.part.delta', sessionId: 's_0000000001' });
      // 再推进一个扫描周期（此时距 delta 仅 65s，远未到 30min）
      await jest.advanceTimersByTimeAsync(IDLE_SCAN_INTERVAL_MS + 5000);
      await jest.advanceTimersByTimeAsync(0);

      expect(prisma.session.update).not.toHaveBeenCalled();
      expect(errors).toHaveLength(0);
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError).toBeUndefined();
      jest.useRealTimers();
    });

    it('回归：旧 120s 完成超时语义移除——文案不再含「处理超时（120s」', async () => {
      jest.useFakeTimers();
      dispatchSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      await jest.advanceTimersByTimeAsync(DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({ error: expect.stringMatching(/无响应/) }),
      );
      expect(JSON.stringify(errors)).not.toContain('处理超时（120s');
      jest.useRealTimers();
    });
  });

  // ------------------------------------------------------------------
  // F2 C1：自持轮询完成判定（真实端到端链路心脏修复）
  // ------------------------------------------------------------------

  describe('F2 C1：自持轮询完成判定', () => {
    const pollSetup = () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      prisma.message.create.mockResolvedValue(messageRow());
    };

    it('getMessages 命中 step-finish(reason=stop) → 落库+广播+emitFinal（不依赖 ingress）', async () => {
      jest.useFakeTimers();
      pollSetup();
      workerClient.getMessages
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: '部分', time: { start: 1 } }],
          },
        ])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'text', text: '完整回复', time: { start: 1 } },
              {
                type: 'step-finish',
                reason: 'stop',
                tokens: { total: 10 },
                cost: 0.1,
              },
            ],
          },
        ]);
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(workerClient.getMessages).toHaveBeenCalledTimes(2);
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            senderId: 'a_product',
            content: { text: '完整回复', parts: expect.any(Array) },
          }),
        }),
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'channel', id: request.channelId },
      );
      expect(finals).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          messageId: 'm_0000000002',
          text: '完整回复',
        },
      ]);
      jest.useRealTimers();
    });

    it('幂等：ingress task.completed 先落库 → 轮询完成时跳过（不重复落库）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // 前置基线（promptAsync 前，无历史）→ poll 第1轮无 finish 挂起 → ingress 先落库
      // → poll 次轮命中但 completedSessions 已含该会话 → 跳过（不重复落库）
      workerClient.getMessages
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: '进行中', time: { start: 1 } }],
          },
        ])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'step-finish', reason: 'stop', tokens: {}, cost: 0 }],
          },
        ]);
      const d = createDispatcher();

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      // ingress 通道先回流落库（poll 尚在 sleep 等待下一轮）
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: 'ingress 先到',
      });
      expect(prisma.message.create).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 轮询次轮命中 finish → completedSessions 已含该会话 → 跳过
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('60s 无 step-finish：首字 watchdog emitError；迟到回流跳过落库', async () => {
      jest.useFakeTimers();
      pollSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      await jest.advanceTimersByTimeAsync(DEFAULT_FIRST_TOKEN_TIMEOUT_MS + 1000);
      await jest.advanceTimersByTimeAsync(0);

      // 首字 watchdog emitError（模型无响应）
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({ error: expect.stringMatching(/无响应/) }),
      );
      // 迟到回流（ingress/轮询）跳过落库仅记日志
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '迟到回复',
      });
      expect(prisma.message.create).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('OBS-009：step-finish(reason=error) 快速 fail——emitError+agent.error，不等 120s 超时', async () => {
      jest.useFakeTimers();
      pollSetup();
      workerClient.getMessages
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: '部分', time: { start: 1 } }],
          },
        ])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'text', text: '部分回复', time: { start: 1 } },
              {
                type: 'step-finish',
                reason: 'error',
                error: { name: 'AuthError', message: '401: 模型凭据无效' },
              },
            ],
          },
        ]);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 快速失败：emitError 立即触发（不 advance 到 DISPATCH_TIMEOUT_MS）
      expect(errors).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          error: expect.stringMatching(/401: 模型凭据无效/),
        },
      ]);
      // agent.error 广播（retry / model_error，对齐 watchdog 语义）
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({ level: 'retry', errorType: 'model_error' }),
      );
      // 失败态无回复落库
      expect(prisma.message.create).not.toHaveBeenCalled();
      // watchdog 已清除——再推 60s 不重复 emitError（无双报错）
      await jest.advanceTimersByTimeAsync(DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(errors).toHaveLength(1);
      jest.useRealTimers();
    });

    it('OBS-009：error part 命中同样快速 fail；failedSessions 标记迟到回流跳过落库', async () => {
      jest.useFakeTimers();
      pollSetup();
      workerClient.getMessages.mockResolvedValue([
        {
          info: { role: 'assistant' },
          parts: [{ type: 'error', error: { message: 'provider 请求失败' } }],
        },
      ]);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(errors).toEqual([
        expect.objectContaining({ error: expect.stringMatching(/provider 请求失败/) }),
      ]);
      // failedSessions 已标记——迟到 task.completed 跳过落库
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '迟到回复',
      });
      expect(prisma.message.create).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('群聊场景：request.channelId 为群聊频道且存在 DM → 轮询回流落群聊（preferred 命中 taskId 匹配，不用 taskId_agentId DM）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // 群聊频道（request.channelId）存在且 taskId 匹配；同时存在 DM 频道（c_dm）
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id) return Promise.resolve({ id: where.id, taskId: request.taskId });
        if (where?.taskId_agentId) return Promise.resolve({ id: 'c_dm' });
        return Promise.resolve(null);
      });
      workerClient.getMessages
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: '部分', time: { start: 1 } }],
          },
        ])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'text', text: '完整回复', time: { start: 1 } },
              {
                type: 'step-finish',
                reason: 'stop',
                tokens: { total: 10 },
                cost: 0.1,
              },
            ],
          },
        ]);
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 回复落群聊频道（消息来源频道），而非 DM
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channelId: request.channelId }),
        }),
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'channel', id: request.channelId },
      );
      // preferred 频道命中（taskId 匹配）→ 不执行 taskId_agentId DM 查询
      expect(prisma.chatChannel.findUnique).toHaveBeenCalledWith({
        where: { id: request.channelId },
        select: { id: true, taskId: true, type: true },
      });
      expect(
        prisma.chatChannel.findUnique.mock.calls.some((c) => c[0]?.where?.taskId_agentId),
      ).toBe(false);
      jest.useRealTimers();
    });

    it('防御：preferredChannelId 存在但 taskId 不匹配 → 回退 DM（存在）落 DM', async () => {
      jest.useFakeTimers();
      pollSetup();
      // preferred 频道 taskId 不匹配（t_other）；DM 频道存在 → 回退 DM
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id) return Promise.resolve({ id: where.id, taskId: 't_other' });
        if (where?.taskId_agentId) return Promise.resolve({ id: 'c_dm' });
        return Promise.resolve(null);
      });
      workerClient.getMessages
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: '部分', time: { start: 1 } }],
          },
        ])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'text', text: '完整回复', time: { start: 1 } },
              {
                type: 'step-finish',
                reason: 'stop',
                tokens: { total: 10 },
                cost: 0.1,
              },
            ],
          },
        ]);
      const d = createDispatcher();

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 回退 DM（taskId_agentId 命中）→ 回复落 DM
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ channelId: 'c_dm' }),
        }),
      );
      expect(prisma.chatChannel.findUnique).toHaveBeenCalledWith({
        where: { taskId_agentId: { taskId: request.taskId, agentId: 'a_product' } },
        select: { id: true, type: true },
      });
      jest.useRealTimers();
    });
  });

  // ------------------------------------------------------------------
  // F3 修复：增量 poll（复用会话）+ artifacts 提取 + 工作目录隔离
  // ------------------------------------------------------------------

  describe('F3 MAJOR-1：增量 poll 检测（复用会话不误判历史 step-finish）', () => {
    const pollSetup = () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      prisma.message.create.mockResolvedValue(messageRow());
    };

    it('复用会话：历史含 step-finish 不误判，只检测 cursor 之后的新消息（本次回复回流）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // 复用场景：getMessages 返回整个会话累积历史——首轮基线（最新 id=msg_1）只记录不检测
      workerClient.getMessages
        .mockResolvedValueOnce([
          { info: { role: 'user', id: 'msg_0' }, parts: [{ type: 'text', text: '上次用户' }] },
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [{ type: 'step-finish', reason: 'stop' }], // 上一次会话的历史 step-finish
          },
        ])
        // 次轮：本次 prompt + 回复追加（cursor=msg_1 之后才有本次 step-finish）
        .mockResolvedValueOnce([
          { info: { role: 'user', id: 'msg_0' }, parts: [] },
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
          { info: { role: 'user', id: 'msg_2' }, parts: [{ type: 'text', text: '本次用户' }] },
          {
            info: { role: 'assistant', id: 'msg_3' },
            parts: [
              { type: 'text', text: '本次回复', time: { start: 1 } },
              { type: 'step-finish', reason: 'stop', tokens: { total: 5 }, cost: 0.01 },
            ],
          },
        ]);
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径。
      // baselineCursor='msg_1' 模拟 dispatch 前置基线（历史最后消息 id，见原注释）
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: 'msg_1',
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 只处理 cursor 之后的新消息——文本是本次回复，不是历史聚合
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: expect.objectContaining({ text: '本次回复' }),
          }),
        }),
      );
      expect(finals).toHaveLength(1);
      jest.useRealTimers();
    });

    it('二次 @ 复用会话：dispatch 重置幂等标记，本轮回复重新回流（不静默失败）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // 第一轮：空历史 → 基线后次轮命中 step-finish 落库
      workerClient.getMessages
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [
              { type: 'text', text: '第一轮回复', time: { start: 1 } },
              { type: 'step-finish', reason: 'stop' },
            ],
          },
        ]);
      const d = createDispatcher();

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);

      // 第二轮：复用同一 sessionId（completedSessions 已含 s_0000000001）。
      // dispatch 重置幂等标记（方案 A 主链路只发 execute，回复经事件回流）；
      // poll 首轮（cursor=msg_1 已存在）无新消息 → 次轮出现新回复
      workerClient.getMessages
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
        ])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
          { info: { role: 'user', id: 'msg_2' }, parts: [{ type: 'text', text: '第二轮用户' }] },
          {
            info: { role: 'assistant', id: 'msg_3' },
            parts: [
              { type: 'text', text: '第二轮回复', time: { start: 1 } },
              { type: 'step-finish', reason: 'stop' },
            ],
          },
        ]);
      await d.dispatch(request);
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 本轮回复正常回流（非静默失败）
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const lastContent = prisma.message.create.mock.calls[1][0].data.content;
      expect(lastContent.text).toBe('第二轮回复');
      jest.useRealTimers();
    });

    it('F3 残留：promptAsync 后出现 assistant 占位消息（parts=[]）→ 前置基线仍检测到 step-finish 并回流（不超时）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // 复用会话：前置基线在 promptAsync 前取（历史最后消息 msg_1），此时 serve 尚无本次占位
      workerClient.getMessages
        .mockResolvedValueOnce([
          { info: { role: 'user', id: 'msg_0' }, parts: [] },
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
        ])
        // poll 第1轮：本次 user + assistant 占位（parts=[]）——复现 m_37 超时根因场景
        .mockResolvedValueOnce([
          { info: { role: 'user', id: 'msg_0' }, parts: [] },
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
          { info: { role: 'user', id: 'msg_2' }, parts: [{ type: 'text', text: '本次用户' }] },
          { info: { role: 'assistant', id: 'msg_3' }, parts: [] },
        ])
        // poll 第2轮：占位填充完成（text + step-finish）
        .mockResolvedValueOnce([
          { info: { role: 'user', id: 'msg_0' }, parts: [] },
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
          { info: { role: 'user', id: 'msg_2' }, parts: [{ type: 'text', text: '本次用户' }] },
          {
            info: { role: 'assistant', id: 'msg_3' },
            parts: [
              { type: 'text', text: '本次回复', time: { start: 1 } },
              { type: 'step-finish', reason: 'stop', tokens: { total: 5 }, cost: 0.01 },
            ],
          },
        ]);
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径。
      // baselineCursor='msg_1' 模拟 dispatch 前置基线（历史最后消息 id）
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: 'msg_1',
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 修复后：基线=msg_1（promptAsync 前），messagesAfter 检测到 msg_2/msg_3 → 回流
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: expect.objectContaining({ text: '本次回复' }),
          }),
        }),
      );
      expect(finals).toHaveLength(1);
      jest.useRealTimers();
    });

    it('首次会话回归：新建会话无历史（前置基线 null）→ messagesAfter(null) 返回全部，仍检测 step-finish 回流', async () => {
      jest.useFakeTimers();
      pollSetup();
      workerClient.getMessages
        .mockResolvedValueOnce([]) // 前置基线：新会话无历史消息
        .mockResolvedValueOnce([
          { info: { role: 'user', id: 'msg_1' }, parts: [{ type: 'text', text: '首次用户' }] },
          {
            info: { role: 'assistant', id: 'msg_2' },
            parts: [
              { type: 'text', text: '首次回复', time: { start: 1 } },
              { type: 'step-finish', reason: 'stop' },
            ],
          },
        ]);
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径。
      // baselineCursor=null（新会话无历史，等效 dispatch 前置基线取到 null）
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: expect.objectContaining({ text: '首次回复' }),
          }),
        }),
      );
      expect(finals).toHaveLength(1);
      jest.useRealTimers();
    });
  });

  describe('F3 MAJOR-2：poll 完成路径提取产出物声明并归档', () => {
    const pollSetup = () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      prisma.message.create.mockResolvedValue(messageRow());
    };

    it('回复含产出物声明（[artifact] JSON）→ onArtifactSubmitted 收到正确 payload', async () => {
      jest.useFakeTimers();
      pollSetup();
      workerClient.getMessages
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [
              {
                type: 'text',
                text: '产出需求文档如下：\n[artifact]{"type":"text","title":"需求说明","content":"内容一"}[/artifact]\n请验收。',
                time: { start: 1 },
              },
              { type: 'step-finish', reason: 'stop' },
            ],
          },
        ]);
      const d = createDispatcher();

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(artifactsService.onArtifactSubmitted).toHaveBeenCalledTimes(1);
      expect(artifactsService.onArtifactSubmitted).toHaveBeenCalledWith({
        taskId: request.taskId,
        type: 'text',
        title: '需求说明',
        content: '内容一',
      });
      jest.useRealTimers();
    });

    it('回复无产出物声明 → artifacts 空数组，不触发归档（不误报）', async () => {
      jest.useFakeTimers();
      pollSetup();
      workerClient.getMessages
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [
              { type: 'text', text: '这是普通回复，没有产出物声明', time: { start: 1 } },
              { type: 'step-finish', reason: 'stop' },
            ],
          },
        ]);
      const d = createDispatcher();

      // 方案 A：dispatch 不再启动自持轮询——直接调 pollForCompletion 验证兜底/测试路径
      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(artifactsService.onArtifactSubmitted).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('F3 MINOR-3：任务工作目录隔离 + 超时可配', () => {
    it('dispatch 传独立任务工作目录（promptAsync directory=<WORK_DIR>/tasks/<taskId>）且目录存在', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as { directory: string };
      const expectedDir = path.join(workRoot, 'tasks', request.taskId);
      expect(execArgs.directory).toBe(expectedDir);
      // mkdir -p 已保证目录存在
      expect(fs.existsSync(expectedDir)).toBe(true);
    });

    it('DISPATCH_TIMEOUT_MS 默认 120s（复杂任务多轮 tool 调用放宽），env 可配', async () => {
      expect(DISPATCH_TIMEOUT_MS).toBe(120_000);
      // 默认（config 无 DISPATCH_TIMEOUT_MS）→ 120s
      const d = createDispatcher();
      expect(d.dispatchTimeoutMs).toBe(DISPATCH_TIMEOUT_MS);
      // env 可配 → 覆盖默认
      config.get.mockImplementation((key: string) =>
        key === 'DISPATCH_TIMEOUT_MS' ? 30_000 : key === 'WORK_DIR' ? workRoot : undefined,
      );
      const configured = createDispatcher();
      expect(configured.dispatchTimeoutMs).toBe(30_000);
    });

    it('判死超时默认值：首字 60s / 空闲 30min，env FIRST_TOKEN_TIMEOUT_MS / AGENT_IDLE_TIMEOUT_MS 可配', async () => {
      expect(DEFAULT_FIRST_TOKEN_TIMEOUT_MS).toBe(60_000);
      expect(DEFAULT_AGENT_IDLE_TIMEOUT_MS).toBe(30 * 60_000);
      // 默认
      const d = createDispatcher();
      expect(d.firstTokenTimeoutMs).toBe(DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
      expect(d.agentIdleTimeoutMs).toBe(DEFAULT_AGENT_IDLE_TIMEOUT_MS);
      // env 可配 → 覆盖默认
      config.get.mockImplementation((key: string) =>
        key === 'FIRST_TOKEN_TIMEOUT_MS'
          ? 10_000
          : key === 'AGENT_IDLE_TIMEOUT_MS'
            ? 5 * 60_000
            : key === 'WORK_DIR'
              ? workRoot
              : undefined,
      );
      const configured = createDispatcher();
      expect(configured.firstTokenTimeoutMs).toBe(10_000);
      expect(configured.agentIdleTimeoutMs).toBe(5 * 60_000);
    });
  });

  // ------------------------------------------------------------------
  // 群聊历史注入：@agent 触发时携带来源频道历史（含未 @agent 消息）
  // ------------------------------------------------------------------

  describe('F5：群聊历史注入（@agent 携带频道历史）', () => {
    const dispatchSetup = () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
    };

    const dispatchedPrompt = (): string => {
      const args = workerClient.execute.mock.calls[0][1] as {
        prompt: Array<{ type: string; text: string }>;
      };
      return args.prompt[0].text;
    };

    it('群聊历史注入：用户+agent 历史按时间序随 prompt 下发，当前触发消息内容不重复', async () => {
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm_0000000002',
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: { text: '群聊里聊过需求细节', parts: [] },
          createdAt: new Date('2026-08-07T00:00:01Z'),
        },
        {
          id: 'm_0000000003',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          content: { text: 'agent 之前的结论', parts: [] },
          createdAt: new Date('2026-08-07T00:00:02Z'),
        },
        // 当前触发消息混入历史（mock 不区分，实现需按 request.messageId 排除）
        {
          id: request.messageId,
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: { text: '触发消息内容', parts: [] },
          createdAt: new Date('2026-08-07T00:00:03Z'),
        },
      ]);
      dispatchSetup();
      const d = createDispatcher();

      await d.dispatch(request);

      const prompt = dispatchedPrompt();
      expect(prompt).toContain('[群聊历史消息]');
      expect(prompt).toContain('用户: 群聊里聊过需求细节');
      expect(prompt).toContain('Agent: agent 之前的结论');
      // 当前消息 request.text 在历史块之后
      expect(prompt.indexOf(request.text)).toBeGreaterThan(prompt.indexOf('群聊里聊过需求细节'));
      // 触发消息作为历史被排除，不重复注入
      expect(prompt).not.toContain('触发消息内容');
    });

    it('排除当前消息：历史 mock 含触发消息 → 不注入它', async () => {
      prisma.message.findMany.mockResolvedValue([
        {
          id: request.messageId,
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: { text: '触发消息内容', parts: [] },
          createdAt: new Date('2026-08-07T00:00:01Z'),
        },
        {
          id: 'm_0000000004',
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: { text: '正常历史消息', parts: [] },
          createdAt: new Date('2026-08-07T00:00:02Z'),
        },
      ]);
      dispatchSetup();
      const d = createDispatcher();

      await d.dispatch(request);

      const prompt = dispatchedPrompt();
      expect(prompt).not.toContain('触发消息内容');
      expect(prompt).toContain('用户: 正常历史消息');
    });

    it('空历史：findMany 返回 [] → prompt 保持现状（无历史块，doclib + request.text）', async () => {
      dispatchSetup();
      const d = createDispatcher();

      await d.dispatch(request);

      // 查询条件：来源频道 + sent + 排除当前触发消息，时间升序
      expect(prisma.message.findMany).toHaveBeenCalledWith({
        where: {
          channelId: request.channelId,
          status: MESSAGE_STATUS.sent,
          NOT: { id: request.messageId },
        },
        select: { id: true, senderType: true, content: true },
        orderBy: { createdAt: 'asc' },
      });
      const prompt = dispatchedPrompt();
      expect(prompt).toBe(request.text);
      expect(prompt).not.toContain('[群聊历史消息]');
    });

    it('截断：超长历史按 chatHistoryMaxBytes 总量截断（保前缀，丢弃超限后续条目）', async () => {
      config.get.mockImplementation((key: string) =>
        key === 'CHAT_HISTORY_MAX_BYTES' ? 100 : key === 'WORK_DIR' ? workRoot : undefined,
      );
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm_0000000002',
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: { text: 'A'.repeat(50), parts: [] },
          createdAt: new Date('2026-08-07T00:00:01Z'),
        },
        {
          id: 'm_0000000003',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          content: { text: 'B'.repeat(50), parts: [] },
          createdAt: new Date('2026-08-07T00:00:02Z'),
        },
      ]);
      dispatchSetup();
      const d = createDispatcher();

      await d.dispatch(request);

      const prompt = dispatchedPrompt();
      expect(prompt).toContain('用户: ' + 'A'.repeat(50));
      expect(prompt).not.toContain('B'.repeat(50));
      expect(DEFAULT_CHAT_HISTORY_MAX_BYTES).toBe(32 * 1024);
    });

    it('结构异常消息（content 缺失 text/非对象）→ 跳过不抛错，正常消息仍注入', async () => {
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm_0000000002',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          content: { parts: [] }, // content.text 缺失
          createdAt: new Date('2026-08-07T00:00:01Z'),
        },
        {
          id: 'm_0000000003',
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: 42, // content 非对象
          createdAt: new Date('2026-08-07T00:00:02Z'),
        },
        {
          id: 'm_0000000004',
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: { text: '正常消息', parts: [] },
          createdAt: new Date('2026-08-07T00:00:03Z'),
        },
      ]);
      dispatchSetup();
      const d = createDispatcher();

      await d.dispatch(request);

      const prompt = dispatchedPrompt();
      expect(prompt).toContain('用户: 正常消息');
      expect(prompt).not.toContain('agent 之前'); // 异常条目不注入
      expect(prompt).not.toContain('42');
    });
  });

  // ------------------------------------------------------------------
  // 工具函数
  // ------------------------------------------------------------------

  describe('工具函数', () => {
    it('truncateUtf8：不超限原样返回，超限按 UTF-8 字节截断（不切裂多字节字符）', () => {
      expect(truncateUtf8('hello', 100)).toBe('hello');
      // "你好" = 6 字节；截 6 字节 → "你好"
      expect(truncateUtf8('你好世界', 6)).toBe('你好');
      expect(truncateUtf8('abc', 2)).toBe('ab');
      // 默认 doclib 单文档上限 = 32KB
      expect(DEFAULT_DOCLIB_MAX_BYTES).toBe(32 * 1024);
    });

    it('escapeXml：转义 XML 特殊字符', () => {
      expect(escapeXml('<a b="c" & d>')).toBe('&lt;a b=&quot;c&quot; &amp; d&gt;');
    });

    it('findFinish：仅 assistant 消息 + reason=stop 命中；user/error reason 不算', () => {
      // user 消息带 step-finish 不算
      expect(
        findFinish([
          { info: { role: 'user' }, parts: [{ type: 'step-finish', reason: 'stop' }] },
        ]),
      ).toBeUndefined();
      // reason=error 不算
      expect(
        findFinish([
          { info: { role: 'assistant' }, parts: [{ type: 'step-finish', reason: 'error' }] },
        ]),
      ).toBeUndefined();
      expect(
        findFinish([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'step-finish', reason: 'stop', tokens: { total: 1 } }],
          },
        ]),
      ).toMatchObject({ reason: 'stop', tokens: { total: 1 } });
    });

    it('findError：assistant step-finish(reason=error)/error part 命中；user/stop/无错误返回 undefined', () => {
      // step-finish(reason=error) 携带 error.message → 返回该文案
      expect(
        findError([
          {
            info: { role: 'assistant' },
            parts: [
              {
                type: 'step-finish',
                reason: 'error',
                error: { name: 'AuthError', message: '401: 凭据无效' },
              },
            ],
          },
        ]),
      ).toBe('401: 凭据无效');
      // error part 命中
      expect(
        findError([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'error', error: { message: 'provider 请求失败' } }],
          },
        ]),
      ).toBe('provider 请求失败');
      // 无 error.message → 回退 part.text
      expect(
        findError([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'step-finish', reason: 'error', text: '模型超时' }],
          },
        ]),
      ).toBe('模型超时');
      // user 消息带 error 不算
      expect(
        findError([
          { info: { role: 'user' }, parts: [{ type: 'step-finish', reason: 'error' }] },
        ]),
      ).toBeUndefined();
      // reason=stop 不算
      expect(
        findError([
          { info: { role: 'assistant' }, parts: [{ type: 'step-finish', reason: 'stop' }] },
        ]),
      ).toBeUndefined();
      // 无错误消息 → undefined
      expect(
        findError([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: '正常回复' }],
          },
        ]),
      ).toBeUndefined();
    });

    it('aggregateText：assistant 非 synthetic text 按时间升序串接；排除 user/synthetic', () => {
      const messages = [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: '用户输入', time: { start: 0 } }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: '后半', time: { start: 20 } },
            { type: 'text', text: '前半', time: { start: 10 } },
            { type: 'text', text: '工具占位', synthetic: true, time: { start: 15 } },
          ],
        },
      ];
      expect(aggregateText(messages)).toBe('前半后半');
    });

    it('extractArtifacts：提取 <doclib>/JSON/[artifact] 三类声明，非法/无声明返回空', () => {
      // ① <doclib> 块内 <artifact type title>正文</artifact>（12 篇 §8.2 注入格式对称复用）
      expect(
        extractArtifacts(
          '<doclib>\n<artifact type="text" title="验收结论">通过</artifact>\n</doclib>',
        ),
      ).toEqual([{ type: 'text', title: '验收结论', content: '通过' }]);
      // ② 内嵌 JSON 声明对象（12 篇 §3.1）
      expect(
        extractArtifacts('产出设计文档：{"type":"doc","title":"设计文档","fileRef":"file://x"}'),
      ).toEqual([{ type: 'doc', title: '设计文档', fileRef: 'file://x' }]);
      // ③ [artifact] 包裹 JSON
      expect(
        extractArtifacts('[artifact]{"type":"text","title":"说明","content":"内容"}[/artifact]'),
      ).toEqual([{ type: 'text', title: '说明', content: '内容' }]);
      // 普通文本无声明 → 空数组（不误报）
      expect(extractArtifacts('这是普通回复，没有产出物')).toEqual([]);
      // 非法声明（doc 缺 fileRef / type 非三态枚举）→ 过滤
      expect(extractArtifacts('<artifact type="doc" title="缺引用">正文</artifact>')).toEqual([]);
      expect(extractArtifacts('{"type":"other","title":"x","content":"y"}')).toEqual([]);
    });
  });
});
