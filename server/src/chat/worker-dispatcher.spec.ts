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
  DEFAULT_DOCLIB_MAX_BYTES,
  DISPATCH_TIMEOUT_MS,
  escapeXml,
  extractArtifacts,
  PENDING_INSTANCE_REF,
  POLL_INTERVAL_MS,
  aggregateText,
  findFinish,
  truncateUtf8,
  WorkerDispatcher,
} from './worker-dispatcher';

describe('WorkerDispatcher', () => {
  let prisma: {
    session: { findUnique: jest.Mock };
    worker: { findUnique: jest.Mock };
    agent: { findUnique: jest.Mock };
    artifact: { findMany: jest.Mock };
    artifactVersion: { findMany: jest.Mock };
    message: { create: jest.Mock };
    chatChannel: { findUnique: jest.Mock; findFirst: jest.Mock };
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workersService: { assignWorker: jest.Mock };
  let workerClient: {
    createSession: jest.Mock;
    promptAsync: jest.Mock;
    getMessages: jest.Mock;
  };
  let sessionLifecycle: { bindSessionToWorker: jest.Mock; unbindSession: jest.Mock };
  let artifactsService: { onArtifactSubmitted: jest.Mock };
  let config: { get: jest.Mock };
  let ingress: { onTaskCompleted: jest.Mock; onAgentStatus: jest.Mock };
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
      session: { findUnique: jest.fn() },
      worker: { findUnique: jest.fn() },
      agent: { findUnique: jest.fn() },
      artifact: { findMany: jest.fn() },
      artifactVersion: { findMany: jest.fn() },
      message: { create: jest.fn() },
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
    it('注册 onTaskCompleted + onAgentStatus', () => {
      createDispatcher();
      expect(ingress.onTaskCompleted).toHaveBeenCalledTimes(1);
      expect(ingress.onAgentStatus).toHaveBeenCalledTimes(1);
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
      // 下发 prompt（parts text）
      expect(workerClient.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        'ses_0001',
        expect.objectContaining({
          model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
          parts: [{ type: 'text', text: request.text }],
        }),
      );
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
      expect(workerClient.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        'ses_0001',
        expect.anything(),
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
      expect(workerClient.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_fresh' }),
        'ses_fresh',
        expect.anything(),
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
      expect(workerClient.promptAsync).toHaveBeenCalledTimes(1);
      expect(workerClient.promptAsync).toHaveBeenCalledWith(
        expect.anything(),
        'ses_0001',
        expect.anything(),
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

      const promptArgs = workerClient.promptAsync.mock.calls[0][2];
      const promptText = promptArgs.parts[0].text as string;
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

      const promptText = workerClient.promptAsync.mock.calls[0][2].parts[0].text;
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

      const promptText = workerClient.promptAsync.mock.calls[0][2].parts[0].text as string;
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
        select: { id: true },
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

    it('缺少 taskId/agentId：不落库不崩溃', async () => {
      const d = createDispatcher();

      await d.handleTaskCompleted({ text: '无归属回复' });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.session.findUnique).not.toHaveBeenCalled();
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
  // 超时 watchdog（D8：60s 无回流 → emitError）
  // ------------------------------------------------------------------

  describe('回流超时 watchdog', () => {
    it('60s 无回流：emitError + 广播 agent.error（retry 层）', async () => {
      jest.useFakeTimers();
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      expect(errors).toHaveLength(0);

      await jest.advanceTimersByTimeAsync(DISPATCH_TIMEOUT_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(errors).toEqual([
        {
          taskId: request.taskId,
          agentId: 'a_product',
          error: expect.stringMatching(/超时/),
        },
      ]);
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({ level: 'retry', errorType: 'dispatch_timeout' }),
      );
      jest.useRealTimers();
    });

    it('回流成功：清除 60s 超时 watchdog，不再 emitError', async () => {
      jest.useFakeTimers();
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
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request); // 启动 watchdog
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '已完成',
      });
      await jest.advanceTimersByTimeAsync(DISPATCH_TIMEOUT_MS + 1000);

      expect(errors).toHaveLength(0);
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

      await d.dispatch(request);
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

      await d.dispatch(request);
      // ingress 通道先回流落库（poll 尚在 sleep 等待下一轮）
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: 'ingress 先到',
      });
      expect(prisma.message.create).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 轮询次轮命中 finish → completedSessions 已含该会话 → 跳过
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('60s 无 step-finish：轮询超时标记失败；watchdog emitError；迟到回流跳过落库', async () => {
      jest.useFakeTimers();
      pollSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      await jest.advanceTimersByTimeAsync(DISPATCH_TIMEOUT_MS + 1000);
      await jest.advanceTimersByTimeAsync(0);

      // watchdog emitError（轮询不重复 emit）
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({ error: expect.stringMatching(/超时/) }),
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

      await d.dispatch(request);
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

      await d.dispatch(request);
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);

      // 第二轮：复用同一 sessionId（completedSessions 已含 s_0000000001）。
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

      await d.dispatch(request);
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

      await d.dispatch(request);
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

      await d.dispatch(request);
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

      await d.dispatch(request);
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

      const promptArgs = workerClient.promptAsync.mock.calls[0][2];
      const expectedDir = path.join(workRoot, 'tasks', request.taskId);
      expect(promptArgs.directory).toBe(expectedDir);
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
