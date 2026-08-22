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
  AgentIdentityInfo,
  buildSystemInstructions,
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  DEFAULT_CHAT_HISTORY_MAX_BYTES,
  DEFAULT_DOCLIB_MAX_BYTES,
  DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  DISPATCH_TIMEOUT_MS,
  IDLE_SCAN_INTERVAL_MS,
  escapeXml,
  extractArtifacts,
  extractGroupPost,
  stripGroupPostDeclarations,
  GLOBAL_SYSTEM_INSTRUCTIONS,
  GROUP_TRIGGER_INSTRUCTION,
  MAIN_AGENT_INSTRUCTION,
  PENDING_INSTANCE_REF,
  PLAN_CAPABILITY_INSTRUCTION,
  PLAN_WORKFLOW_INSTRUCTION,
  POLL_INTERVAL_MS,
  aggregateText,
  findError,
  findFinish,
  truncateUtf8,
  TeamMemberInfo,
  WorkerDispatcher,
} from './worker-dispatcher';

describe('WorkerDispatcher', () => {
  let prisma: {
    session: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    worker: { findUnique: jest.Mock };
    agent: { findUnique: jest.Mock };
    artifact: { findMany: jest.Mock };
    artifactVersion: { findMany: jest.Mock };
    message: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    chatChannel: { findUnique: jest.Mock; findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    taskAgent: { findUnique: jest.Mock };
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
        // FR-13：dispatchAgentMention 查目标 agent 会话（uk_sessions_task_agent）
        findFirst: jest.fn(),
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
        // dm-sse-no-refresh：dispatch 前清理目标频道残留 processing（无残留时 count=0）
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      chatChannel: { findUnique: jest.fn(), findFirst: jest.fn() },
      // 主 Agent/团队成员注入：默认无 task 行 → isMainAgent=false + team=[]（既有断言
      // system 不含主 Agent/团队段，回归现状）；需要注入的用例单独 mockResolvedValue。
      task: { findUnique: jest.fn() },
      // is_0000000010：默认无实例行 → resolveAgentWorkDir 走 agent 名称兜底目录（回归既有
      // 任务级/agent 兜底行为）；需要验证 work_dir 的用例单独 mockResolvedValue。
      taskAgent: { findUnique: jest.fn() },
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
          prompt: [{ type: 'text', text: expect.stringContaining(request.text) }],
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

    it('群聊触发：prompt 注入 GROUP_TRIGGER_INSTRUCTION（默认公开回复到群聊）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: request.channelId,
        type: 'task_group',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const prompt = workerClient.execute.mock.calls[0][1].prompt[0].text as string;
      expect(prompt).toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).toContain(`任务 ID：${request.taskId}`);
      expect(prompt).toContain(request.text);
    });

    it('私聊触发：prompt 不注入群聊指令（保持私密独白）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: request.channelId,
        type: 'private',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const prompt = workerClient.execute.mock.calls[0][1].prompt[0].text as string;
      expect(prompt).not.toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).toContain(`任务 ID：${request.taskId}`);
      expect(prompt).toContain(request.text);
    });

    it('system 注入 Agent 完整身份（buildSystemInstructions 含 id/name/role/prompt + selfInstanceId 引导）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理助手',
        role: '产品经理',
        prompt: '你是产品需求分析专家，负责梳理需求并输出方案。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as { system: string };
      expect(execArgs.system).toContain(GLOBAL_SYSTEM_INSTRUCTIONS);
      expect(execArgs.system).toContain('issue_create');
      // 存量会话（session.taskAgentId 缺省）→ 身份段回退 agent 语义（实例 id = agent id）
      expect(execArgs.system).toContain(
        `你是本任务的 产品经理助手（实例 id: ${request.targets[0].agentId}，角色: 产品经理）`,
      );
      expect(execArgs.system).toContain('【职责】你是产品需求分析专家，负责梳理需求并输出方案。');
      expect(execArgs.system).toContain('selfInstanceId');
    });

    it('agent 行不存在：buildSystemInstructions 降级注入 agentId（name 回退 id，无【职责】，不阻断 dispatch）', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as { system: string };
      expect(execArgs.system).toContain(
        `你是本任务的 ${request.targets[0].agentId}（实例 id: ${request.targets[0].agentId}，角色: ）`,
      );
      expect(execArgs.system).not.toContain('【职责】');
      expect(execArgs.system).toContain('selfInstanceId');
    });

    it('主实例目标：system 注入主 Agent 职责段 + 团队成员段（mainAgentInstanceId 判定，taskAgents 提取实例团队）', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        mainAgentInstanceId: 'ta_product_1',
        taskAgents: [
          { id: 'ta_product_1', agentId: 'a_product', seq: 1, alias: '产品经理-1', removedAt: null, agent: { id: 'a_product', name: '产品经理', role: 'product' } },
          { id: 'ta_architect_1', agentId: 'a_architect', seq: 1, alias: '架构师-1', removedAt: null, agent: { id: 'a_architect', name: '架构师', role: 'architect' } },
        ],
      });
      // 目标会话绑主实例（session.taskAgentId = mainAgentInstanceId）
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: null,
        instanceRef: null,
        taskAgentId: 'ta_product_1',
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: '负责需求拆解。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      // hot path：task 查询只 select mainAgentInstanceId + executionMode + taskAgents.agent 三字段
      expect(prisma.task.findUnique).toHaveBeenCalledWith({
        where: { id: request.taskId },
        select: {
          mainAgentInstanceId: true,
          executionMode: true,
          taskAgents: {
            include: { agent: { select: { id: true, name: true, role: true } } },
          },
        },
      });
      const execArgs = workerClient.execute.mock.calls[0][1] as { system: string };
      // 当前实例是主实例 → 追加主 Agent 职责段；身份段含实例别名+实例 id
      expect(execArgs.system).toContain(MAIN_AGENT_INSTRUCTION);
      expect(execArgs.system).toContain('【主 Agent 职责】');
      expect(execArgs.system).toContain('你是本任务的 产品经理-1（实例 id: ta_product_1，角色: product）');
      // 团队段：全部成员 + 主实例标注（按 instanceId 匹配）
      expect(execArgs.system).toContain('【团队成员】');
      expect(execArgs.system).toContain('产品经理-1（实例 id: ta_product_1，角色: product） —— 主 Agent');
      expect(execArgs.system).toContain('架构师-1（实例 id: ta_architect_1，角色: architect）');
    });

    it('非主实例目标：system 含团队成员段（标注主实例）但不含主 Agent 职责段', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        mainAgentInstanceId: 'ta_pm_1',
        taskAgents: [
          { id: 'ta_product_1', agentId: 'a_product', seq: 1, alias: '产品经理-1', removedAt: null, agent: { id: 'a_product', name: '产品经理', role: 'product' } },
          { id: 'ta_pm_1', agentId: 'a_project_manager', seq: 1, alias: '项目经理-1', removedAt: null, agent: { id: 'a_project_manager', name: '项目经理', role: 'project_manager' } },
        ],
      });
      // 目标会话绑非主实例（产品经理-1）
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: null,
        instanceRef: null,
        taskAgentId: 'ta_product_1',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as { system: string };
      expect(execArgs.system).not.toContain(MAIN_AGENT_INSTRUCTION);
      expect(execArgs.system).toContain('【团队成员】');
      expect(execArgs.system).toContain(
        '项目经理-1（实例 id: ta_pm_1，角色: project_manager） —— 主 Agent',
      );
    });

    it('双开发者实例：身份段别名（开发者-1/开发者-2）按各自会话注入，团队段含实例 id+别名+主标注', async () => {
      const taskAgents = [
        { id: 'ta_pm_1', agentId: 'a_project_manager', seq: 1, alias: '项目经理-1', removedAt: null, agent: { id: 'a_project_manager', name: '项目经理', role: 'project_manager' } },
        { id: 'ta_dev_1', agentId: 'a_developer', seq: 1, alias: '开发者-1', removedAt: null, agent: { id: 'a_developer', name: '开发者', role: 'developer' } },
        { id: 'ta_dev_2', agentId: 'a_developer', seq: 2, alias: '开发者-2', removedAt: null, agent: { id: 'a_developer', name: '开发者', role: 'developer' } },
      ];
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        mainAgentInstanceId: 'ta_pm_1',
        taskAgents,
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_developer',
        name: '开发者',
        role: 'developer',
        prompt: '负责编码实现。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      // 目标 = 开发者-1 实例（ta_dev_1）的会话
      prisma.session.findUnique.mockResolvedValue({
        id: 's_dev_1',
        workerId: null,
        instanceRef: null,
        taskAgentId: 'ta_dev_1',
      });
      const devRequest = {
        ...request,
        targets: [{ agentId: 'a_developer', sessionId: 's_dev_1' }],
      };
      const d = createDispatcher();
      await d.dispatch(devRequest);

      const execArgs = workerClient.execute.mock.calls[0][1] as { system: string };
      // 身份段：别名 开发者-1 + 实例 id ta_dev_1（非主实例 → 无主 Agent 职责段）
      expect(execArgs.system).toContain('你是本任务的 开发者-1（实例 id: ta_dev_1，角色: developer）');
      expect(execArgs.system).not.toContain(MAIN_AGENT_INSTRUCTION);
      // 团队段：三实例（别名+实例 id），主标注在 项目经理-1
      expect(execArgs.system).toContain('【团队成员】');
      expect(execArgs.system).toContain('项目经理-1（实例 id: ta_pm_1，角色: project_manager） —— 主 Agent');
      expect(execArgs.system).toContain('开发者-1（实例 id: ta_dev_1，角色: developer）');
      expect(execArgs.system).toContain('开发者-2（实例 id: ta_dev_2，角色: developer）');
      // 同 agent 双实例的 seq 不混（团队段不把 开发者-2 当 开发者-1）
      expect(execArgs.system).not.toContain('开发者-1（实例 id: ta_dev_2');

      // 开发者-2 独立 dispatch：身份段换 开发者-2/ta_dev_2
      prisma.session.findUnique.mockResolvedValue({
        id: 's_dev_2',
        workerId: null,
        instanceRef: null,
        taskAgentId: 'ta_dev_2',
      });
      await d.dispatch({ ...devRequest, targets: [{ agentId: 'a_developer', sessionId: 's_dev_2' }] });
      const dev2Args = workerClient.execute.mock.calls[1][1] as { system: string };
      expect(dev2Args.system).toContain('你是本任务的 开发者-2（实例 id: ta_dev_2，角色: developer）');
      expect(dev2Args.system).not.toContain(MAIN_AGENT_INSTRUCTION);
    });

    it('主实例（session.taskAgentId === mainAgentInstanceId）：注入主 Agent 职责段，身份段为主实例别名', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        mainAgentInstanceId: 'ta_pm_1',
        taskAgents: [
          { id: 'ta_pm_1', agentId: 'a_project_manager', seq: 1, alias: '项目经理-1', removedAt: null, agent: { id: 'a_project_manager', name: '项目经理', role: 'project_manager' } },
        ],
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_project_manager',
        name: '项目经理',
        role: 'project_manager',
        prompt: '牵头分工。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      prisma.session.findUnique.mockResolvedValue({
        id: 's_pm_1',
        workerId: null,
        instanceRef: null,
        taskAgentId: 'ta_pm_1',
      });
      const pmRequest = {
        ...request,
        targets: [{ agentId: 'a_project_manager', sessionId: 's_pm_1' }],
      };
      const d = createDispatcher();
      await d.dispatch(pmRequest);

      const execArgs = workerClient.execute.mock.calls[0][1] as { system: string };
      expect(execArgs.system).toContain(MAIN_AGENT_INSTRUCTION);
      expect(execArgs.system).toContain('你是本任务的 项目经理-1（实例 id: ta_pm_1，角色: project_manager）');
      expect(execArgs.system).toContain('项目经理-1（实例 id: ta_pm_1，角色: project_manager） —— 主 Agent');
    });

    it('存量会话 taskAgentId=NULL：降级不炸（isMainAgent=false、身份段回退 agentId 语义）', async () => {
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        mainAgentInstanceId: 'ta_pm_1',
        taskAgents: [
          { id: 'ta_pm_1', agentId: 'a_project_manager', seq: 1, alias: '项目经理-1', removedAt: null, agent: { id: 'a_project_manager', name: '项目经理', role: 'project_manager' } },
        ],
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: null,
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      // 存量 session 未绑实例（taskAgentId NULL）
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: null,
        instanceRef: null,
        taskAgentId: null,
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as { system: string };
      // 存量会话未绑实例 → isMainAgent=false（不注入主 Agent 职责段）
      expect(execArgs.system).not.toContain(MAIN_AGENT_INSTRUCTION);
      // selfInstanceId 回退 agent.id；selfAlias 回退 agent.name（团队中无该实例）
      expect(execArgs.system).toContain('你是本任务的 产品经理（实例 id: a_product，角色: product）');
      // 团队段仍正常注入且标注主实例（团队信息与当前会话是否绑实例无关）
      expect(execArgs.system).toContain('【团队成员】');
      expect(execArgs.system).toContain('项目经理-1（实例 id: ta_pm_1，角色: project_manager） —— 主 Agent');
    });

    it('task 行不存在：system 不含主 Agent/团队成员段（降级为纯身份，不阻断 dispatch）', async () => {
      prisma.task.findUnique.mockResolvedValue(null);
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as { system: string };
      expect(execArgs.system).not.toContain(MAIN_AGENT_INSTRUCTION);
      expect(execArgs.system).not.toContain('【团队成员】');
      expect(execArgs.system).toContain(
        `你是本任务的 ${request.targets[0].agentId}（实例 id: ${request.targets[0].agentId}，角色: ）`,
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
          instanceId: null,
          sessionId: 's_0000000001',
          phase: 'thinking',
        },
        {
          taskId: request.taskId,
          agentId: 'a_product',
          instanceId: null,
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
  // buildSystemInstructions：主 Agent/团队成员动态注入（模板不写死，运行时判定）
  // ------------------------------------------------------------------

  describe('buildSystemInstructions 主 Agent/团队动态注入', () => {
    const agent: AgentIdentityInfo = {
      id: 'a_product',
      name: '产品经理',
      role: 'product',
      prompt: '负责需求拆解与文档化。',
      persona: null,
    };
    const team: TeamMemberInfo[] = [
      {
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        instanceId: 'ta_product_1',
        alias: '产品经理-1',
        seq: 1,
      },
      {
        id: 'a_architect',
        name: '架构师',
        role: 'architect',
        instanceId: 'ta_architect_1',
        alias: null,
        seq: 1,
      },
    ];

    it('普通（单参调用）：仅身份段（agent 语义回退），不含主 Agent 职责段与团队成员段（向后兼容）', () => {
      const s = buildSystemInstructions(agent);
      expect(s).toContain(GLOBAL_SYSTEM_INSTRUCTIONS);
      expect(s).toContain(`你是本任务的 ${agent.name}（实例 id: ${agent.id}，角色: product）`);
      expect(s).toContain('【职责】负责需求拆解与文档化。');
      expect(s).not.toContain(MAIN_AGENT_INSTRUCTION);
      expect(s).not.toContain('【团队成员】');
    });

    it('身份段实例语义：selfInstanceId/selfAlias 注入实例身份（实例 id: ta_…，别名优先）', () => {
      const s = buildSystemInstructions(agent, {
        selfInstanceId: 'ta_product_1',
        selfAlias: '产品经理-1',
      });
      expect(s).toContain('你是本任务的 产品经理-1（实例 id: ta_product_1，角色: product）');
      // selfAlias 缺省（存量会话未解析别名）→ 回退 agent.name，实例 id 仍用 selfInstanceId
      const s2 = buildSystemInstructions(agent, { selfInstanceId: 'ta_product_1' });
      expect(s2).toContain('你是本任务的 产品经理（实例 id: ta_product_1，角色: product）');
    });

    it('isMainAgent=true：追加主 Agent 职责段（牵头分工/协调衔接/群聊进度/@ 成员/汇总验收）', () => {
      const s = buildSystemInstructions(agent, { isMainAgent: true });
      expect(s).toContain(MAIN_AGENT_INSTRUCTION);
      expect(s).toContain('【主 Agent 职责】');
      expect(s).toContain('牵头拆解工作并分派');
      expect(s).toContain('群聊提示进度');
      expect(s).toContain('notify_agent');
      expect(s).toContain('汇总各角色产出与验收材料');
    });

    it('带团队：注入【团队成员】段（实例别名/实例 id/角色 + 主实例标注按 instanceId），非主实例无标注', () => {
      const s = buildSystemInstructions(agent, {
        team,
        mainAgentInstanceId: 'ta_architect_1',
      });
      expect(s).toContain('【团队成员】');
      expect(s).toContain('产品经理-1（实例 id: ta_product_1，角色: product）');
      // alias 缺省（ta_architect_1）→ 回退 name，主实例标注按 instanceId 匹配
      expect(s).toContain('架构师（实例 id: ta_architect_1，角色: architect） —— 主 Agent');
      expect(s).not.toContain('产品经理-1（实例 id: ta_product_1，角色: product） —— 主 Agent');
    });

    it('带团队但主实例为 null（任务未确定主实例）：团队成员段无任何标注', () => {
      const s = buildSystemInstructions(agent, { team, mainAgentInstanceId: null });
      expect(s).toContain('【团队成员】');
      expect(s).not.toContain(' —— 主 Agent');
    });

    it('GLOBAL 常量含静态【持久化目录】段：约定默认 /data/vteam-worker/<agent名称> + 重启保留语义 + 写入指引', () => {
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('【持久化目录】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('/data/vteam-worker/<agent名称>');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('容器重启后保留');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('fileRef 应指向该目录内的文件');
    });

    it('GLOBAL 常量含【记忆管理】段：引导经 memory_search/memory_save 按需存取记忆（21 篇按需注入哲学）', () => {
      // 三个 sentinel 全部在 join 后的 GLOBAL prompt 中（机器可断言，非"模型会调用工具"行为）
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('【记忆管理】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('memory_search');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('memory_save');
      // 工具参数契约完整（含自检索/沉淀的 level 语义）
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('{taskId, query?, level?, tags?, limit?}');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('{taskId, selfInstanceId, level: "task"|"project"|"global", content, tags?}');
      // 既有段不被改动（顺序保留：记忆管理段追加在【托管模式】之后）
      expect(GLOBAL_SYSTEM_INSTRUCTIONS.indexOf('【记忆管理】')).toBeGreaterThan(
        GLOBAL_SYSTEM_INSTRUCTIONS.indexOf('【托管模式】'),
      );
    });

    it('persistentWorkDir 注入：提示词含动态【运行时工作目录】段（实际解析路径）', () => {
      const s = buildSystemInstructions(agent, {
        persistentWorkDir: '/data/vteam-worker/开发者-1',
      });
      expect(s).toContain('【运行时工作目录】');
      expect(s).toContain('/data/vteam-worker/开发者-1');
      expect(s).toContain('fileRef 使用该目录下的路径');
      // 静态段仍保留（默认约定），动态段给出本任务实际目录
      expect(s).toContain('【持久化目录】');
    });

    it('persistentWorkDir 缺省：仅静态【持久化目录】段，不注入动态【运行时工作目录】段（向后兼容）', () => {
      const s = buildSystemInstructions(agent);
      expect(s).not.toContain('【运行时工作目录】');
      expect(s).toContain('【持久化目录】');
    });

    it('persona 拼接：agent.persona=strict 时注入【性格】段（含安全阀文案），不改写 prompt', () => {
      const s = buildSystemInstructions({ ...agent, persona: 'strict' });
      expect(s).toContain('## 性格');
      expect(s).toContain('附改进建议');
      expect(s).toContain('【职责】负责需求拆解与文档化。'); // prompt 原样保留，未被性格污染
    });

    it('persona 为 null：不注入【性格】段（缺省/存量 agent 无性格，向后兼容）', () => {
      const s = buildSystemInstructions(agent);
      expect(s).not.toContain('## 性格');
      expect(s).not.toContain('【性格】');
    });

    it('persona 未知 key：renderPersonaSection 返回空串 → 不注入【性格】段且不抛错', () => {
      const s = buildSystemInstructions({ ...agent, persona: 'unknown-key' });
      expect(s).not.toContain('## 性格');
      expect(s).toContain('【职责】负责需求拆解与文档化。');
    });

    it('executionMode=plan：追加轻量能力引导 + 完整【计划工作流】两段（含 plan_submit/plan_task_transition 工具名）', () => {
      const s = buildSystemInstructions(agent, { executionMode: 'plan' });
      expect(s).toContain(PLAN_CAPABILITY_INSTRUCTION);
      expect(s).toContain('【执行计划】');
      expect(s).toContain(PLAN_WORKFLOW_INSTRUCTION);
      expect(s).toContain('【计划工作流】');
      expect(s).toContain('本任务执行模式=plan');
      expect(s).toContain('plan_submit');
      expect(s).toContain('plan_review');
      expect(s).toContain('plan_task_transition');
      expect(s).toContain('task_transition mark-pending-review');
    });

    it('executionMode 非 plan（direct/缺省）：注入轻量【执行计划】引导、不注入完整【计划工作流】段', () => {
      const s = buildSystemInstructions(agent, { executionMode: 'direct' });
      expect(s).toContain(PLAN_CAPABILITY_INSTRUCTION);
      expect(s).toContain('【执行计划】');
      expect(s).not.toContain('【计划工作流】');
      expect(s).not.toContain(PLAN_WORKFLOW_INSTRUCTION);
      // 缺省（存量调用未传 executionMode）同样只注入轻量引导——向后兼容
      const s2 = buildSystemInstructions(agent);
      expect(s2).toContain(PLAN_CAPABILITY_INSTRUCTION);
      expect(s2).not.toContain('【计划工作流】');
      // 既有段不受影响
      expect(s).toContain(GLOBAL_SYSTEM_INSTRUCTIONS);
    });
  });

  // ------------------------------------------------------------------
  // FR-13 dispatchAgentMention：agent 互 @ 触发（复用 dispatch 全链路）
  // ------------------------------------------------------------------

  describe('dispatchAgentMention：agent 互 @ 触发（按实例定位会话）', () => {
    const mention = {
      taskId: request.taskId,
      channelId: request.channelId,
      text: '@ta_tester 请查看这个文件',
      targetInstanceId: 'ta_tester',
    };

    it('目标实例有会话 → 构造 DispatchRequest 调 dispatch（agentId 从 session 行取）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_tester',
        agentId: 'a_tester',
      });
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention(mention);

      expect(prisma.session.findFirst).toHaveBeenCalledWith({
        where: { taskId: request.taskId, taskAgentId: 'ta_tester' },
        select: { id: true, agentId: true },
      });
      expect(idGen.nextId).toHaveBeenCalledWith('m');
      expect(dispatchSpy).toHaveBeenCalledWith({
        messageId: 'm_0000000002',
        channelId: request.channelId,
        taskId: request.taskId,
        text: mention.text,
        targets: [{ agentId: 'a_tester', instanceId: 'ta_tester', sessionId: 's_tester' }],
      });
    });

    it('目标实例无会话 → 抛错（不调 dispatch）', async () => {
      prisma.session.findFirst.mockResolvedValue(null);
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await expect(d.dispatchAgentMention(mention)).rejects.toThrow(
        /实例 ta_tester 无会话/,
      );
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(idGen.nextId).not.toHaveBeenCalled();
    });

    it('dispatch 单目标失败仍返回（emitError 由 dispatch 内部处理，不向上抛）', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's_tester',
        agentId: 'a_tester',
      });
      // 真实 dispatch 全链路：目标会话行缺失 → dispatchForTarget 抛错 → dispatch 内
      // emitError + 广播 agent.error，dispatchAgentMention 正常 resolve
      prisma.session.findUnique.mockResolvedValue(null);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatchAgentMention(mention);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({ agentId: 'a_tester' }),
      );
      expect(
        realtime.broadcast.mock.calls.some((c) => c[0] === EVENT_TYPES.AGENT_ERROR),
      ).toBe(true);
      expect(workersService.assignWorker).not.toHaveBeenCalled();
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
  // dispatch：按需注入（阶段 3 移除自动 doclib 注入，模型经 MCP 工具自主拉取）
  // ------------------------------------------------------------------

  describe('dispatch：按需注入（移除自动 doclib 注入）', () => {
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
      prisma.artifact.findMany.mockResolvedValue([]);
    });

    it('任务有产出物：prompt 不再注入 <doclib> 块（模型经 vteam doclib 工具自主拉取）', async () => {
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

      const promptText = (
        workerClient.execute.mock.calls[0][1] as { prompt: Array<{ text: string }> }
      ).prompt[0].text;
      // 不再自动注入 doclib 产出物正文
      expect(promptText).not.toContain('<doclib>');
      expect(promptText).not.toContain('需求正文 v3');
      // 含动态任务上下文指令（taskId + MCP 工具引导）+ 当前消息
      expect(promptText).toContain(`任务 ID：${request.taskId}`);
      expect(promptText).toContain('vteam');
      expect(promptText).toContain('chat_history / doclib / task_context');
      expect(promptText).toContain(request.text);
    });

    it('任务无产出物：prompt 仅任务上下文指令 + request.text（无 doclib 块）', async () => {
      const d = createDispatcher();

      await d.dispatch(request);

      const promptText = (
        workerClient.execute.mock.calls[0][1] as { prompt: Array<{ text: string }> }
      ).prompt[0].text;
      expect(promptText).toContain(`任务 ID：${request.taskId}`);
      expect(promptText).not.toContain('<doclib>');
      expect(promptText).toContain(request.text);
    });

    it('方法保留：buildDoclibContext 仍可组装 <doclib> 块（最新版本正文 + 总量截断补闭合标签）', async () => {
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

      const ctx = await (d as unknown as {
        buildDoclibContext(taskId: string): Promise<string>;
      }).buildDoclibContext(request.taskId);

      expect(ctx).toContain('<doclib>');
      // 截断后补 </doclib> 闭合标签（防切裂结尾）
      expect(ctx).toMatch(/<\/doclib>\s*$/);
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

    it('F3 P1：session 绑实例 → resolveChannel 按 taskAgentId 精确匹配（同 agent 多实例各自频道）', async () => {
      // 开发者-2 会话绑实例 ta_dev_2：终态回复必须落开发者-2 私聊频道，不得按 agentId
      // findFirst 命中开发者-1 频道（F3 实测串扰缺陷根因）
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_developer',
        taskAgentId: 'ta_dev_2',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_dev2', type: 'private' });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_developer',
        sessionId: 's_dev2',
        text: '开发者-2 总结',
      });

      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { taskId: request.taskId, taskAgentId: 'ta_dev_2' },
        select: { id: true, type: true },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dev2',
            senderId: 'a_developer',
            senderInstanceId: 'ta_dev_2',
          }),
        }),
      );
    });

    it('F3 P1：存量会话 taskAgentId NULL → resolveChannel 回退 agentId 首实例（存量兼容）', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_developer',
        taskAgentId: null,
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_legacy', type: 'private' });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_developer',
        sessionId: 's_legacy',
        text: '存量任务回复',
      });

      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { taskId: request.taskId, agentId: 'a_developer' },
        select: { id: true, type: true },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_legacy',
            senderId: 'a_developer',
            senderInstanceId: 'a_developer',
          }),
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

    it('artifacts 归档成功 → 广播 artifact.submitted（task scope，前端产出物列表实时刷新）', async () => {
      artifactsService.onArtifactSubmitted.mockResolvedValue({
        status: 'archived',
        artifact: { id: 'art_0000000001', currentVersion: 1 },
      });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '产出需求文档',
        artifacts: [{ type: 'text', title: '需求说明', content: '内容一' }],
      });

      expect(artifactsService.onArtifactSubmitted).toHaveBeenCalledTimes(1);
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.ARTIFACT_SUBMITTED,
        {
          taskId: request.taskId,
          artifactId: 'art_0000000001',
          version: 1,
          type: 'text',
          title: '需求说明',
          agentId: 'a_product',
        },
        { type: 'task', id: request.taskId },
      );
    });

    it('artifacts 声明非法（invalid）→ 不广播 artifact.submitted', async () => {
      artifactsService.onArtifactSubmitted.mockResolvedValue({
        status: 'invalid',
        reason: '缺少 type',
      });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '产出需求文档',
        artifacts: [{ title: '需求说明', content: '内容一' }],
      });

      expect(artifactsService.onArtifactSubmitted).toHaveBeenCalledTimes(1);
      expect(
        realtime.broadcast.mock.calls.some((c) => c[0] === EVENT_TYPES.ARTIFACT_SUBMITTED),
      ).toBe(false);
    });

    it('P3：无 payload.artifacts（方案 A worker 不上送）→ 从回复 text 提取声明归档', async () => {
      const d = createDispatcher();
      const text =
        '产出完成。' +
        '{"type":"doc","title":"端到端文档测试","fileRef":"/tmp/opencode/e2e-doc.md"}' +
        ' [artifact]{"type":"text","title":"要点","content":"内容"}[/artifact]';

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text,
      });

      expect(artifactsService.onArtifactSubmitted).toHaveBeenCalledTimes(2);
      expect(artifactsService.onArtifactSubmitted).toHaveBeenNthCalledWith(1, {
        taskId: request.taskId,
        type: 'doc',
        title: '端到端文档测试',
        content: '',
        fileRef: '/tmp/opencode/e2e-doc.md',
      });
      expect(artifactsService.onArtifactSubmitted).toHaveBeenNthCalledWith(2, {
        taskId: request.taskId,
        type: 'text',
        title: '要点',
        content: '内容',
      });
    });

    it('P3：payload.artifacts 与 text 提取重复声明 → 去重归档一次', async () => {
      const d = createDispatcher();
      const decl = {
        type: 'doc',
        title: '重复声明',
        content: '',
        fileRef: '/tmp/opencode/dup.md',
      };

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: `完成 ${JSON.stringify(decl)}`,
        artifacts: [decl],
      });

      expect(artifactsService.onArtifactSubmitted).toHaveBeenCalledTimes(1);
      expect(artifactsService.onArtifactSubmitted).toHaveBeenCalledWith({
        taskId: request.taskId,
        type: 'doc',
        title: '重复声明',
        content: '',
        fileRef: '/tmp/opencode/dup.md',
      });
    });

    it('频道定位：私聊频道（taskId+agentId）优先，群聊频道回退', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_dm' });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '私聊回复',
      });

      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { taskId: request.taskId, agentId: 'a_product' },
        select: { id: true, type: true },
      });
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
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.agentId) return Promise.resolve({ id: 'c_dm' });
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

    it('F3 缺陷①：task_group 终态化（groupFallback）→ 正文独白不落群聊，跳过落库', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(null);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: request.channelId,
        type: CHANNEL_TYPE.task_group,
      });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

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

      // 群聊只收 ACK + MCP group_post 工具直发：无 private 频道回退群聊时
      // groupFallback 跳过正文落库（仅幂等标记 + emitFinal）
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(finals).toHaveLength(1);
    });

    it('F3 缺陷①：private 终态化 → parts 全量保留（reasoning/tool 前端折叠展示）', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue({
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

    it('P4：error 回流 → processing 消息标记 failed + 错误内容广播（用户可见失败提示）', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_group',
        taskId: request.taskId,
        type: 'task_group',
      });
      prisma.message.findFirst.mockResolvedValue({
        id: 'm_proc',
        channelId: 'c_group',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_product',
        content: { text: '旧流式内容', parts: [] },
        status: MESSAGE_STATUS.processing,
      });
      const updatedRow = {
        id: 'm_proc',
        channelId: 'c_group',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_product',
        content: { text: '执行失败：worker 无响应', parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.failed,
        createdAt: new Date('2026-08-07T00:00:00Z'),
      };
      prisma.message.update.mockResolvedValue(updatedRow);

      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.handleAgentStatus({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: 'c_group',
        status: 'error',
        error: '执行失败：worker 无响应',
      });

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_proc' },
        data: {
          content: { text: '执行失败：worker 无响应', parts: [] },
          status: MESSAGE_STATUS.failed,
        },
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ id: 'm_proc', status: MESSAGE_STATUS.failed }) },
        { type: 'channel', id: 'c_group' },
      );
      expect(errors).toEqual([
        { taskId: request.taskId, agentId: 'a_product', error: '执行失败：worker 无响应' },
      ]);
    });

    it('P4：error 回流且无 processing 消息 → 新建 failed 消息', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_group',
        taskId: request.taskId,
        type: 'task_group',
      });
      // findFirst 返回 null（无 processing 消息）
      const createdRow = {
        id: 'm_new_fail',
        channelId: 'c_group',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_product',
        content: { text: 'agent 处理失败', parts: [] },
        mentions: null,
        status: MESSAGE_STATUS.failed,
        createdAt: new Date('2026-08-07T00:00:00Z'),
      };
      prisma.message.create.mockResolvedValue(createdRow);

      const d = createDispatcher();
      await d.handleAgentStatus({
        taskId: request.taskId,
        agentId: 'a_product',
        channelId: 'c_group',
        status: 'error',
      });

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'c_group',
          senderId: 'a_product',
          status: MESSAGE_STATUS.failed,
          content: { text: 'agent 处理失败', parts: [] },
        }),
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ id: 'm_new_fail' }) },
        { type: 'channel', id: 'c_group' },
      );
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

    it('群聊触发：回复含 group_post 声明 → 仅落 private 独白（剥离标签），群聊不转发（工具直发）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // 群聊频道（request.channelId）type=task_group；DM 频道（c_dm）type=private
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: where.id, taskId: request.taskId, type: 'task_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.agentId) return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve({ id: request.channelId, type: 'task_group' });
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
              {
                type: 'text',
                text:
                  '已完成需求分析。' +
                  '{"type":"group_post","content":"需求分析完成，结论已同步"}',
                time: { start: 1 },
              },
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

      // 架构：回复仅落 private DM（内心独白，文本剥离 group_post 标签）；群聊回复只经
      // MCP group_post 工具直发——不再有任何正文兜底转发（曾致群聊每人 3 条）
      const creates = prisma.message.create.mock.calls.map((c: any) => c[0].data.channelId);
      expect(creates).toEqual(['c_dm']);
      expect(creates).not.toContain(request.channelId);
      // 私聊独白文本不含协议标签
      expect(prisma.message.create.mock.calls[0][0].data.content.text).toBe(
        '已完成需求分析。',
      );
      // 广播仅 private 频道；群聊不再收到转发广播
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'channel', id: 'c_dm' },
      );
      expect(realtime.broadcast).not.toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'channel', id: request.channelId },
      );
      // resolveChannel 固定 private：taskId+agentId DM 查询命中
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { taskId: request.taskId, agentId: 'a_product' },
        select: { id: true, type: true },
      });
      jest.useRealTimers();
    });

    it('群聊触发：回复无 group_post 声明 → 不兜底转发（仅落 private 独白）', async () => {
      jest.useFakeTimers();
      pollSetup();
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: where.id, taskId: request.taskId, type: 'task_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.agentId) return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve({ id: request.channelId, type: 'task_group' });
      });
      workerClient.getMessages.mockResolvedValue([
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: '普通回复，未声明 group_post',
              time: { start: 1 },
            },
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

      // 群聊触发（来源 task_group）→ 未声明也不兜底转发；正文独白仅落 private
      const creates = prisma.message.create.mock.calls.map((c: any) => c[0].data.channelId);
      expect(creates).toEqual(['c_dm']);
      expect(creates).not.toContain(request.channelId);
      jest.useRealTimers();
    });

    it('私聊触发：回复无 group_post 声明 → 仅落 private 独白，不转发群聊', async () => {
      jest.useFakeTimers();
      pollSetup();
      // 来源频道是私聊（c_dm）→ 群聊触发判定 false；DM 反查同 c_dm
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id) return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.agentId) return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve({ id: request.channelId, type: 'task_group' });
      });
      workerClient.getMessages.mockResolvedValue([
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'text',
              text: '私聊回复，不公开',
              time: { start: 1 },
            },
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

      void d['pollForCompletion']({
        worker: { id: 'w_0000000001', capabilities: {} },
        opencodeSessionId: 'ses_0001',
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: 'c_dm',
        startedAt: Date.now(),
        baselineCursor: null,
      });
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await jest.advanceTimersByTimeAsync(0);

      // 私聊触发且未声明 → 仅 private 独白，不转发群聊
      const creates = prisma.message.create.mock.calls.map((c: any) => c[0].data.channelId);
      expect(creates).toEqual(['c_dm']);
      jest.useRealTimers();
    });

    it('群聊触发：parts 含 group_post 工具调用且 completed → 跳过 forwardToGroup（防双通道双发）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // resolveChannel：DM 反查命中 private 独白频道；groupTrigger：来源频道 type=task_group
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: where.id, taskId: request.taskId, type: 'task_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.agentId) return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve({ id: 'c_group', type: 'task_group' });
      });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();
      const fwd = jest.spyOn(d as any, 'forwardToGroup');

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        text: '已通过工具发布群聊',
        parts: [
          { type: 'text', text: '已通过工具发布群聊' },
          {
            type: 'tool',
            tool: 'vteam_group_post',
            state: {
              status: 'completed',
              input: { content: '结论已同步' },
              output: '{"ok":true,"messageId":"m_0000000016"}',
            },
          },
        ],
      });

      // 工具已直发群聊 → 兜底转发被跳过（防双发）
      expect(fwd).not.toHaveBeenCalled();
      const creates = prisma.message.create.mock.calls.map((c: any) => c[0].data.channelId);
      expect(creates).toEqual(['c_dm']);
      jest.useRealTimers();
    });

    it('群聊触发：parts 含 group_post 工具调用但 status 非 completed → 不兜底转发（工具直发才入群聊）', async () => {
      jest.useFakeTimers();
      pollSetup();
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: where.id, taskId: request.taskId, type: 'task_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.agentId) return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve({ id: 'c_group', type: 'task_group' });
      });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();
      const fwd = jest.spyOn(d as any, 'forwardToGroup');

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        text: '普通回复',
        parts: [
          { type: 'text', text: '普通回复' },
          {
            type: 'tool',
            tool: 'vteam_group_post',
            state: { status: 'running', input: {} },
          },
        ],
      });

      // 工具未完成也不兜底转发：群聊内容只能由 group_post 工具直发产生
      expect(fwd).not.toHaveBeenCalled();
      const creates = prisma.message.create.mock.calls.map((c: any) => c[0].data.channelId);
      expect(creates).toEqual(['c_dm']);
      jest.useRealTimers();
    });

    it('群聊触发：parts 不含 group_post 工具调用 → 不兜底转发（仅落 private 独白）', async () => {
      jest.useFakeTimers();
      pollSetup();
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: where.id, taskId: request.taskId, type: 'task_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.agentId) return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve({ id: 'c_group', type: 'task_group' });
      });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();
      const fwd = jest.spyOn(d as any, 'forwardToGroup');

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        channelId: request.channelId,
        text: '普通回复，未走工具',
        parts: [{ type: 'text', text: '普通回复，未走工具' }],
      });

      // 无工具直发也不兜底转发完整回复；正文独白仅落 private
      expect(fwd).not.toHaveBeenCalled();
      const creates = prisma.message.create.mock.calls.map((c: any) => c[0].data.channelId);
      expect(creates).toEqual(['c_dm']);
      jest.useRealTimers();
    });

    it('无 private DM 频道 → 正文独白不落群聊（groupFallback 跳过落库，仅 emitFinal）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // DM 不存在（null）；群聊频道存在（findFirst 命中）
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({ id: where.id, taskId: request.taskId, type: 'task_group' });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: request.channelId,
        type: 'task_group',
      });
      workerClient.getMessages.mockResolvedValue([
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

      // 群聊回退（无该 agent private 频道）：正文独白不落群聊（结论经 group_post 工具
      // 直发），仅完成幂等标记 + emitFinal（前端 loading 收尾）
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(finals).toHaveLength(1);
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { taskId: request.taskId, agentId: 'a_product' },
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
    it('dispatch 传 agent 兜底工作目录（未绑实例 → /data/vteam-worker/<agentName>，与 tasks.service 同根）且目录存在', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      // 存量会话未绑实例（taskAgentId NULL）：agent 名称兜底目录（/data/vteam-worker 根）
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as { directory: string };
      const expectedDir = '/data/vteam-worker/产品经理';
      expect(execArgs.directory).toBe(expectedDir);
      // mkdir -p 已保证目录存在
      expect(fs.existsSync(expectedDir)).toBe(true);
    });

    it('dispatch 绑实例且 task_agents.work_dir 存在：directory 用实例独立工作目录', async () => {
      const workDir = path.join(workRoot, 'worker', '产品经理');
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
        taskAgentId: 'ta_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001', capabilities: {} });
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_product', defaultModelId: null });
      prisma.taskAgent.findUnique.mockResolvedValue({
        id: 'ta_0000000001',
        workDir,
        seq: 1,
        agent: { id: 'a_product', name: '产品经理' },
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as { directory: string };
      expect(execArgs.directory).toBe(workDir);
      // server 侧 mkdir -p 已保证存在
      expect(fs.existsSync(workDir)).toBe(true);
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
  // F5 按需注入：移除自动群聊历史注入（模型经 vteam chat_history 工具自主拉取）
  // ------------------------------------------------------------------

  describe('F5：按需注入（移除自动群聊历史注入）', () => {
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

    it('群聊历史不再自动注入：prompt 不含 [群聊历史消息] 块，仅任务上下文指令 + request.text', async () => {
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
      ]);
      dispatchSetup();
      const d = createDispatcher();

      await d.dispatch(request);

      const prompt = dispatchedPrompt();
      expect(prompt).not.toContain('[群聊历史消息]');
      expect(prompt).not.toContain('群聊里聊过需求细节');
      // 含任务上下文指令（taskId + MCP 工具引导）+ 当前消息
      expect(prompt).toContain(`任务 ID：${request.taskId}`);
      expect(prompt).toContain('chat_history');
      expect(prompt).toContain(request.text);
    });

    it('方法保留：buildChatHistoryContext 排除当前触发消息 + 按时间序组装发言者标注', async () => {
      prisma.message.findMany.mockResolvedValue([
        {
          id: request.messageId,
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: { text: '触发消息内容', parts: [] },
          createdAt: new Date('2026-08-07T00:00:01Z'),
        },
        {
          id: 'm_0000000003',
          senderType: SENDER_TYPE.agent,
          senderId: 'a_product',
          content: { text: 'agent 之前的结论', parts: [] },
          createdAt: new Date('2026-08-07T00:00:02Z'),
        },
        {
          id: 'm_0000000004',
          senderType: SENDER_TYPE.user,
          senderId: 'u_0000000001',
          content: { text: '正常历史消息', parts: [] },
          createdAt: new Date('2026-08-07T00:00:03Z'),
        },
      ]);
      const d = createDispatcher();

      const ctx = await (d as unknown as {
        buildChatHistoryContext(channelId: string, excludeMessageId: string): Promise<string>;
      }).buildChatHistoryContext(request.channelId, request.messageId);

      expect(ctx).toContain('[群聊历史消息]');
      expect(ctx).toContain('Agent: agent 之前的结论');
      expect(ctx).toContain('用户: 正常历史消息');
      expect(ctx).not.toContain('触发消息内容'); // 当前触发消息被排除
    });

    it('方法保留：buildChatHistoryContext 空历史 → 返回空串', async () => {
      prisma.message.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      const ctx = await (d as unknown as {
        buildChatHistoryContext(channelId: string, excludeMessageId: string): Promise<string>;
      }).buildChatHistoryContext(request.channelId, request.messageId);

      expect(ctx).toBe('');
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
    });

    it('方法保留：buildChatHistoryContext 超长历史按 chatHistoryMaxBytes 总量截断（保前缀）', async () => {
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
      const d = createDispatcher();

      const ctx = await (d as unknown as {
        buildChatHistoryContext(channelId: string, excludeMessageId: string): Promise<string>;
      }).buildChatHistoryContext(request.channelId, request.messageId);

      expect(ctx).toContain('用户: ' + 'A'.repeat(50));
      expect(ctx).not.toContain('B'.repeat(50));
      expect(DEFAULT_CHAT_HISTORY_MAX_BYTES).toBe(32 * 1024);
    });

    it('方法保留：buildChatHistoryContext 结构异常消息跳过（不抛错，正常消息仍组装）', async () => {
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
      const d = createDispatcher();

      const ctx = await (d as unknown as {
        buildChatHistoryContext(channelId: string, excludeMessageId: string): Promise<string>;
      }).buildChatHistoryContext(request.channelId, request.messageId);

      expect(ctx).toContain('用户: 正常消息');
      expect(ctx).not.toContain('agent 之前'); // 异常条目不组装
      expect(ctx).not.toContain('42');
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

    it('extractGroupPost：JSON/<group_post> 声明提取 {content,fileRef?}；无声明/空内容 → null', () => {
      expect(
        extractGroupPost('结论。{"type":"group_post","content":"要向群里说的话"}'),
      ).toEqual({ content: '要向群里说的话' });
      expect(extractGroupPost('结论。<group_post>要向群里说的话</group_post>')).toEqual({
        content: '要向群里说的话',
      });
      // 携带 fileRef（群聊附件）：JSON 与标签两种格式
      expect(
        extractGroupPost('{"type":"group_post","content":"文档已生成","fileRef":"docs/a.md"}'),
      ).toEqual({ content: '文档已生成', fileRef: 'docs/a.md' });
      expect(extractGroupPost('<group_post fileRef="docs/a.md">文档已生成</group_post>')).toEqual({
        content: '文档已生成',
        fileRef: 'docs/a.md',
      });
      expect(extractGroupPost('普通回复，不公开')).toBeNull();
      expect(extractGroupPost('{"type":"group_post","content":"  "}')).toBeNull();
    });

    it('stripGroupPostDeclarations：移除 group_post 声明块，保留正文', () => {
      expect(
        stripGroupPostDeclarations('结论。{"type":"group_post","content":"x"}'),
      ).toBe('结论。');
      expect(stripGroupPostDeclarations('结论。<group_post>x</group_post>')).toBe('结论。');
      expect(stripGroupPostDeclarations('无声明文本')).toBe('无声明文本');
    });

    it('真实场景：artifact + group_post 多声明并存（跨对象解析修复）', () => {
      const text =
        '文档已确认读取成功。' +
        '[artifact]{"type":"doc","title":"新会话文档测试","fileRef":"/tmp/opencode/e2e-new-doc.md"}[/artifact]' +
        '{"type":"group_post","content":"@开发者 文档已创建并确认成功。之前群里问到“当前上下文有哪些”，现在补答：本会话上下文包含该文档引用，暂无其他附加文件。","fileRef":"/tmp/opencode/e2e-new-doc.md"}';
      // group_post 从混合串中准确定位（旧正则会跨 artifact 匹配导致解析失败）
      const gp = extractGroupPost(text);
      expect(gp).not.toBeNull();
      expect(gp?.content).toContain('文档已创建并确认成功');
      expect(gp?.fileRef).toBe('/tmp/opencode/e2e-new-doc.md');
      // 私聊独白剥离 group_post 标签，保留 artifact 产出物声明
      const stripped = stripGroupPostDeclarations(text);
      expect(stripped).not.toContain('group_post');
      expect(stripped).toContain('[artifact]');
      // 产出物声明按文本顺序提取（doc 在前）
      const arts = extractArtifacts(text);
      expect(arts[0]).toEqual(
        expect.objectContaining({ type: 'doc', title: '新会话文档测试' }),
      );
    });
  });
});
