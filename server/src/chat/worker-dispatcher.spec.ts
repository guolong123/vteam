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
import { ROLE_BOUNDARIES } from '../common/constants/agent.constants';
import {
  ExecutionPolicyService,
  resolveConstantPolicySource,
  type ResolvedExecutionPolicy,
} from '../execution-policies/execution-policy.service';
import {
  loadAgentPoliciesBaseline,
  loadBoundaryBaseline,
} from '../execution-policies/__fixtures__/policy-fixtures';
import { TRIGGER_KIND } from '../common/constants/trigger.constants';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import {
  WorkerClient,
  WorkerUnavailableException,
} from '../workers/worker.client';
import { WorkerEventIngress } from '../workers/worker-event.ingress';
import { WorkersService } from '../workers/workers.service';
import {
  AgentIdentityInfo,
  agentKeyToVteamAgentName,
  buildSystemInstructions,
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  DEFAULT_CHAT_HISTORY_MAX_BYTES,
  DEFAULT_DOCLIB_MAX_BYTES,
  DEFAULT_SILENT_SESSION_WAKE_MS,
  DISPATCH_TIMEOUT_MS,
  IDLE_SCAN_INTERVAL_MS,
  MAX_SILENT_WAKE_ATTEMPTS,
  escapeXml,
  extractArtifacts,
  extractGroupPost,
  stripGroupPostDeclarations,
  GLOBAL_SYSTEM_INSTRUCTIONS,
  GROUP_TRIGGER_INSTRUCTION,
  isVteamAgentName,
  roleNeedsIssueDetail,
  MAIN_AGENT_INSTRUCTION,
  MEMORY_INSTRUCTION,
  PENDING_INSTANCE_REF,
  parseTimeoutMs,
  renderBoundarySection,
  resolvePolicyAgentCandidate,
  roleLabelOfAgentKey,
  ARTIFACT_SUBMISSION_INSTRUCTION,
  ISSUE_FULL_INSTRUCTION,
  TASK_TRANSITION_INSTRUCTION,
  HOSTED_CONFIRM_INSTRUCTION,
  NON_MAIN_AGENT_NOTE,
  WECOM_SYSTEM_INSTRUCTION,
  TEAM_COLLABORATION_CHARTER_INSTRUCTION,
  AGENT_RECEIPT_IRON_LAW_INSTRUCTION,
  TEAM_GROUP_TRIGGER_INSTRUCTION,
  TEAM_SYSTEM_RECEPTION_INSTRUCTION,
  WECOM_TRIGGER_INSTRUCTION,
  toExecutionScope,
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
    session: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
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
  };
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let workersService: { assignWorker: jest.Mock };
  let workerClient: {
    createSession: jest.Mock;
    promptAsync: jest.Mock;
    getMessages: jest.Mock;
    execute: jest.Mock;
    abort: jest.Mock;
  };
  let sessionLifecycle: {
    bindSessionToWorker: jest.Mock;
    unbindSession: jest.Mock;
  };
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
    teamId: 'tm_0000000001',
    taskContext: { taskId: 't_0000000001' },
    text: '你好，请处理',
    targets: [
      {
        agentId: 'a_product',
        instanceId: 'tmm_0000000001',
        sessionId: 's_0000000001',
      },
    ],
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

  /** 名册行（默认即 dispatch 目标 tmm_0000000001）：role 非空时提供岗位策略解析输入。 */
  const memberRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'tmm_0000000001',
    agentId: 'a_product',
    alias: '产品经理-1',
    seq: 1,
    agent: { id: 'a_product', name: '产品经理', agentKey: 'product' },
    role: null as
      | {
          id?: string | null;
          key?: string | null;
          capabilities?: Record<string, boolean> | null;
          rolePrompt?: string | null;
        }
      | null,
    ...overrides,
  });

  type PolicyResolverStub = {
    resolveByRole: jest.Mock;
    resolveByAgent?: jest.Mock;
  };

  const createDispatcher = (policyService?: PolicyResolverStub) =>
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
      policyService as unknown as ExecutionPolicyService,
    );

  beforeEach(() => {
    prisma = {
      session: {
        findUnique: jest.fn(),
        // FR-13：dispatchAgentMention 查目标 agent 会话（uk_sessions_task_agent）
        findFirst: jest.fn(),
        // todo-7：空闲扫描 DB 侧检出（status=running AND lastActivityAt<cutoff）；默认无
        findMany: jest.fn().mockResolvedValue([]),
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
      // 单团队入口（Todo 1）：分派统一走团队会话/名册；默认空名册 + 无主成员，
      // 需要团队数据的用例单独覆盖。
      ...({
        teamMember: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        team: {
          findUnique: jest.fn().mockResolvedValue({ mainAgentMemberId: null }),
        },
      } as any),
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
      // abort-before-restart：空闲判死 stop-first 中止 stuck worker 会话（默认成功）
      abort: jest.fn().mockResolvedValue(undefined),
    };
    sessionLifecycle = {
      bindSessionToWorker: jest.fn(),
      unbindSession: jest
        .fn()
        .mockResolvedValue({ sessionId: 's_0000000001', unbound: true }),
    };
    artifactsService = {
      onArtifactSubmitted: jest.fn().mockResolvedValue({ status: 'archived' }),
    };
    // F3 MINOR-3：WORK_DIR 指向独立临时根（dispatch 会真实 mkdir 任务目录，隔离系统目录）
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keta-wd-'));
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
      // 判死 watchdog：ingress 活动事件通知回调（滑动重武装静默窗口 + 刷新 idle 计时）
      expect(ingress.onSessionActivity).toHaveBeenCalledTimes(1);
    });

    it('ingress 触发 task.completed 回调 → 回流落库+广播+emitFinal（D5 归 WorkerDispatcher）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(null);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      prisma.message.create.mockResolvedValue(messageRow());
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_product',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      // 回调为 fire-and-forget（void handleTaskCompleted），直接调内部回流处理断言
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '完成',
      });

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            senderId: 'a_product',
            senderType: 'agent',
          }),
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
      expect(() =>
        cb({ taskId: request.taskId, agentId: 'a_product', text: 'x' }),
      ).not.toThrow();
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
          prompt: [
            { type: 'text', text: expect.stringContaining(request.text) },
          ],
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

    it('群聊触发（task_group）：单触发器走任务段 + 任务版群聊指令，任务经 taskContext 进 execute', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: request.channelId,
        type: 'task_group',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const prompt = workerClient.execute.mock.calls[0][1].prompt[0]
        .text as string;
      expect(prompt).toContain('【任务上下文】');
      expect(prompt).toContain(request.taskContext.taskId);
      expect(prompt).toContain(request.text);
      expect(prompt).toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).not.toContain(TEAM_GROUP_TRIGGER_INSTRUCTION);
      expect(workerClient.execute.mock.calls[0][1].taskId).toBe(request.taskId);
    });

    it('私聊触发：prompt 不注入群聊指令（保持私密独白），任务段保留', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: request.channelId,
        type: 'private',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const prompt = workerClient.execute.mock.calls[0][1].prompt[0]
        .text as string;
      expect(prompt).not.toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).not.toContain(TEAM_GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).toContain('【任务上下文】');
      expect(prompt).toContain(request.text);
    });

    it('单触发器：任务模式走任务段 + 任务版指令，团队直聊走团队段 + TEAM 版指令（无双触发器）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: request.channelId,
        type: 'task_group',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const prompt = workerClient.execute.mock.calls[0][1].prompt[0]
        .text as string;
      expect(prompt).toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).not.toContain(TEAM_GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).toContain('【任务上下文】');
      expect(prompt).toContain(request.text);
    });

    it('P0 互斥（wecom 优先）：企微触发 → prompt 注入企微指令且不注入 GROUP 指令，system 注入企微段', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: request.channelId,
        type: 'task_group',
      });
      const d = createDispatcher();
      await d.dispatch({
        ...request,
        text: '[WeCom:GuoLong] 请帮我看看进度',
      });

      const prompt = workerClient.execute.mock.calls[0][1].prompt[0]
        .text as string;
      expect(prompt).toContain('【企微消息】');
      expect(prompt).toContain('vteam_wecom_reply');
      expect(prompt).not.toContain(GROUP_TRIGGER_INSTRUCTION);
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).toContain(WECOM_SYSTEM_INSTRUCTION);
    });

    it('P0 默认不注入企微：非企微群聊触发 → prompt 注入 GROUP 指令，system 无企微段', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: request.channelId,
        type: 'task_group',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const prompt = workerClient.execute.mock.calls[0][1].prompt[0]
        .text as string;
      expect(prompt).toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).not.toContain('【企微消息】');
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).not.toContain(WECOM_SYSTEM_INSTRUCTION);
    });

    it('system 注入 Agent 完整身份（buildSystemInstructions 含 id/name/角色key/prompt + selfInstanceId 引导）', async () => {
      // 行形状 = 迁移期真实 DB 行（模板行 agent_key = role）；todo 10 起身份段
      // 『角色』由 agentKey 派生，值仍是 key（product），不是展示名。
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理助手',
        role: 'product',
        agentKey: 'product',
        prompt: '你是产品需求分析专家，负责梳理需求并输出方案。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(execArgs.system).toContain(GLOBAL_SYSTEM_INSTRUCTIONS);
      expect(execArgs.system).toContain('vteam_issue_create');
      // 单入口：目标实例即团队成员 → 身份段实例 id 为 tmm_（会话 teamMemberId）
      expect(execArgs.system).toContain(
        '你是本任务的 产品经理助手（实例 id: tmm_0000000001，角色: product）',
      );
      expect(execArgs.system).toContain(
        '【职责】你是产品需求分析专家，负责梳理需求并输出方案。',
      );
      expect(execArgs.system).toContain('selfInstanceId');
    });

    it('todo 5：成员行 roleId→AgentRole.rolePrompt 连接 → system 注入【岗位职责】（真实来源，非 agent.role）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        agentKey: 'product',
        prompt: '负责需求拆解。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const rolePrompt =
        '# 角色：产品经理\n你是任务虚拟团队中的产品经理 Agent，负责定义问题与验收标准。';
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
          agent: {
            id: 'a_product',
            name: '产品经理',
            role: 'product',
            agentKey: 'product',
          },
          role: { rolePrompt },
        },
      ]);
      (prisma as any).team.findUnique = jest
        .fn()
        .mockResolvedValue({ mainAgentMemberId: null });
      const d = createDispatcher();
      await d.dispatch(request);

      const system = workerClient.execute.mock.calls[0][1].system as string;
      const count = (haystack: string, needle: string): number =>
        haystack.split(needle).length - 1;
      // 岗位段来自 TeamMember.roleId 连接（agent.role 只是标签 key，无 rolePrompt）
      expect(count(system, '【岗位职责】')).toBe(1);
      expect(count(system, rolePrompt)).toBe(1);
      expect(count(system, '【职责】负责需求拆解。')).toBe(1);
      expect(system.indexOf('【岗位职责】')).toBeLessThan(
        system.indexOf('【职责】'),
      );
      // 连接查询确实 include 了 role.rolePrompt
      expect((prisma as any).teamMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            role: {
              select: {
                id: true,
                key: true,
                capabilities: true,
                rolePrompt: true,
              },
            },
          }),
        }),
      );
    });

    it('todo 5：成员行未绑角色（role=null）→ 无【岗位职责】，agent 段照常，不抛错', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        agentKey: 'product',
        prompt: '负责需求拆解。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
          agent: {
            id: 'a_product',
            name: '产品经理',
            role: 'product',
            agentKey: 'product',
          },
          role: null,
        },
      ]);
      (prisma as any).team.findUnique = jest
        .fn()
        .mockResolvedValue({ mainAgentMemberId: null });
      const d = createDispatcher();
      await d.dispatch(request);

      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).not.toContain('【岗位职责】');
      expect(system).toContain('【职责】负责需求拆解。');
    });

    it('agent 行不存在：buildSystemInstructions 降级注入 agentId（name 回退 id，无【职责】，不阻断 dispatch）', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(execArgs.system).toContain(
        '你是本任务的 a_product（实例 id: tmm_0000000001，角色: ）',
      );
      expect(execArgs.system).not.toContain('【职责】');
      expect(execArgs.system).not.toContain('【岗位职责】');
      expect(execArgs.system).toContain('selfInstanceId');
    });

    it('plan 目标：dispatch 按 agentKey 推导策略/职责 → system 无【记忆管理】段（guard 不拒）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_plan',
        name: '计划员',
        role: 'plan',
        agentKey: 'plan',
        prompt: '负责计划编制。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_plan',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(execArgs.system).not.toContain('【记忆管理】');
      expect(execArgs.system).not.toContain('vteam_memory_search');
      expect(execArgs.system).not.toContain('vteam_memory_save');
      // 非记忆段不受影响
      expect(execArgs.system).toContain('【持久化目录】');
      // 产出物段 plan-aware：plan 无 submit_artifact（落盘即交付），dispatch 同样跳过
      expect(execArgs.system).not.toContain('【公开与归档】');
      expect(execArgs.system).not.toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      expect(execArgs.system).not.toContain('vteam_submit_artifact');
    });

    it('Todo 4：角色已知的目标 Agent → system 注入【职责边界】+ 角色 scopeSummary', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理助手',
        role: 'product',
        agentKey: 'product',
        prompt: '负责需求拆解。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(execArgs.system).toContain('【职责边界】');
      expect(execArgs.system).toContain(
        ROLE_BOUNDARIES['vteam-product'].scopeSummary,
      );
      expect(execArgs.system).toContain('越界处理：');
    });

    it('Todo 4：角色未知（未绑定）目标 → 不注入【职责边界】，与基线构造逐字节一致', async () => {
      // 默认 mock agent 无 agentKey → agentKeyToVteamAgentName 返回 null → 省略 boundarySection
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(execArgs.system).not.toContain('【职责边界】');
      // review fix M8：用显式有序 index 断言替代自证式 expected（buildSystemInstructions
      // 生成 expected 与自身比较两侧同动，永远抓不到装配回归）。
      const system = execArgs.system;
      const iGlobal = system.indexOf(GLOBAL_SYSTEM_INSTRUCTIONS);
      const iIdentity = system.indexOf(
        '你是本任务的 a_product（实例 id: tmm_0000000001，角色: ）',
      );
      const iNonMain = system.indexOf(NON_MAIN_AGENT_NOTE);
      const iCharter = system.indexOf(TEAM_COLLABORATION_CHARTER_INSTRUCTION);
      const iReceipt = system.indexOf(AGENT_RECEIPT_IRON_LAW_INSTRUCTION);
      const iArtifact = system.indexOf(ARTIFACT_SUBMISSION_INSTRUCTION);
      expect(iGlobal).toBe(0);
      expect(iIdentity).toBeGreaterThan(iGlobal);
      expect(iNonMain).toBeGreaterThan(iIdentity);
      expect(iCharter).toBeGreaterThan(iNonMain);
      expect(iReceipt).toBeGreaterThan(iCharter);
      expect(iArtifact).toBeGreaterThan(iReceipt);
      // 无角色绑定 + 无 agent prompt → 两个职责标题都不出现（无空标题）
      expect(system).not.toContain('【岗位职责】');
      expect(system).not.toContain('【职责】');
    });

    it('todo 10：装配来源是 agentKey 而非 role 列——role 列值不同也不进入身份段/issue 判据（突变检测器）', async () => {
      // 鉴别性夹具：DB role 列故意放中文展示名（若代码回退读 agent.role，
      // 身份段会渲染 `产品经理` 且 issueDetail 命中「产品」子串 → 测试失败）。
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_myagent',
        name: '自定义助手',
        role: '产品经理',
        agentKey: 'myagent',
        prompt: '负责专项。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_myagent',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).toContain('角色: ）');
      expect(system).not.toContain('角色: 产品经理');
      expect(system).not.toContain(ISSUE_FULL_INSTRUCTION);
    });

    it('todo 10：identity/roster 标签不泄漏自定义 agentKey（dispatch 装配：role 段为空串）', async () => {
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_myagent',
          alias: '自定义-1',
          seq: 1,
          agent: {
            id: 'a_myagent',
            name: '自定义助手',
            role: null,
            agentKey: 'myagent',
          },
        },
      ]);
      (prisma as any).team.findUnique = jest
        .fn()
        .mockResolvedValue({ mainAgentMemberId: null });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_myagent',
        name: '自定义助手',
        role: null,
        agentKey: 'myagent',
        prompt: '负责专项。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_myagent',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).toContain(
        '你是本任务的 自定义-1（实例 id: tmm_0000000001，角色: ）',
      );
      expect(system).toContain('自定义-1（实例 id: tmm_0000000001，角色: ）');
      expect(system).not.toContain('角色: myagent');
    });

    it('todo 10：issue 完整版判据改由 agentKey 驱动——product 注入完整版、自定义 agentKey 只收一句版', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        agentKey: 'product',
        prompt: '负责需求。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch(request);
      const productSystem = workerClient.execute.mock.calls[0][1]
        .system as string;
      expect(productSystem).toContain(ISSUE_FULL_INSTRUCTION);

      workerClient.execute.mockClear();
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_myagent',
        name: '自定义助手',
        role: null,
        agentKey: 'myagent',
        prompt: '负责专项。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_myagent',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });
      const customSystem = workerClient.execute.mock.calls[0][1]
        .system as string;
      expect(customSystem).toContain('【Issue协作】');
      expect(customSystem).not.toContain(ISSUE_FULL_INSTRUCTION);
      expect(customSystem).not.toContain('vteam_issue_create');
    });

    it('slice 3：岗位策略 correction → system 注入【职责边界】（解析键为 role.key，非 agentKey）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_demo',
        name: '示例助手',
        role: null,
        prompt: '示例职责。',
        agentKey: 'demo-agent',
        policyId: 'ep_agent_deny',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        memberRow({
          role: {
            id: 'ar_demo',
            key: 'demo-role',
            capabilities: {},
            rolePrompt: null,
          },
        }),
      ]);
      const policyService = {
        resolveByRole: jest.fn().mockResolvedValue({
          policyId: 'ep_custom_demo',
          policyName: '示例策略',
          agentName: 'vteam-demo-agent',
          permission: {},
          tools: {},
          bashDeny: [],
          correction: {
            scopeSummary: '示例自定义职责：只做只读核对。',
            handoff: { review: 'vteam-tester' },
            denyTemplate: '【越界拦截】',
          },
          serverGated: [],
        } as ResolvedExecutionPolicy),
        resolveByAgent: jest.fn(),
      };
      const d = createDispatcher(policyService);
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_demo',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(policyService.resolveByRole).toHaveBeenCalledWith({
        roleKey: 'demo-role',
      });
      expect(policyService.resolveByAgent).not.toHaveBeenCalled();
      expect(execArgs.system).toContain(
        '【职责边界】示例自定义职责：只做只读核对。',
      );
      expect(execArgs.system).toContain('review→vteam-tester');
    });

    it('todo 2：dispatch 用岗位策略 tools 驱动记忆/产出物段（缺工具 → 屏蔽）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_demo',
        name: '示例助手',
        role: 'plan',
        prompt: '示例职责。',
        agentKey: 'demo-agent',
        policyId: 'ep_agent_deny',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        memberRow({
          role: {
            id: 'ar_demo',
            key: 'demo-role',
            // 显式拒绝 memory.save/doc.submit → 两段都屏蔽（与 role='plan' 无关，纯能力点判定）
            capabilities: { 'memory.save': false, 'doc.submit': false },
            rolePrompt: null,
          },
        }),
      ]);
      const policyService = {
        resolveByRole: jest.fn().mockResolvedValue({
          policyId: 'ep_custom_demo',
          policyName: '示例策略',
          agentName: 'vteam-demo-agent',
          permission: {},
          tools: { vteam_group_post: 'allow' },
          bashDeny: [],
          correction: { scopeSummary: '示例职责。', handoff: {} },
          serverGated: [],
        } as ResolvedExecutionPolicy),
        resolveByAgent: jest.fn(),
      };
      const d = createDispatcher(policyService);
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_demo',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });

      const system = (
        workerClient.execute.mock.calls[0][1] as {
          system: string;
        }
      ).system;
      expect(policyService.resolveByRole).toHaveBeenCalledTimes(1);
      expect(policyService.resolveByAgent).not.toHaveBeenCalled();
      expect(system).not.toContain('【记忆管理】');
      expect(system).not.toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
    });

    it('todo 2：dispatch 用岗位策略 tools 驱动（持有工具 → 两段照常注入，即使 role=plan）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_demo',
        name: '示例助手',
        role: 'plan',
        prompt: '示例职责。',
        agentKey: 'demo-agent',
        policyId: 'ep_agent_deny',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        memberRow({
          role: {
            id: 'ar_demo',
            key: 'demo-role',
            // 显式允许 memory.save/doc.submit → 两段照常注入（即使 agent 的 role='plan'）。
            capabilities: { 'memory.save': true, 'doc.submit': true },
            rolePrompt: null,
          },
        }),
      ]);
      const policyService = {
        resolveByRole: jest.fn().mockResolvedValue({
          policyId: 'ep_custom_demo',
          policyName: '示例策略',
          agentName: 'vteam-demo-agent',
          permission: {},
          tools: {
            vteam_memory_save: 'allow',
            vteam_submit_artifact: 'allow',
          },
          bashDeny: [],
          correction: { scopeSummary: '示例职责。', handoff: {} },
          serverGated: [],
        } as ResolvedExecutionPolicy),
        resolveByAgent: jest.fn(),
      };
      const d = createDispatcher(policyService);
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_demo',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });

      const system = (
        workerClient.execute.mock.calls[0][1] as {
          system: string;
        }
      ).system;
      expect(policyService.resolveByRole).toHaveBeenCalledTimes(1);
      // correction 仍只认岗位 roleKey（显式钉死键集合，防未来 refactor 把 agentKey 混回）。
      expect(
        Object.keys(
          policyService.resolveByRole.mock.calls[0][0] as object,
        ).sort(),
      ).toEqual(['roleKey']);
      expect(policyService.resolveByAgent).not.toHaveBeenCalled();
      expect(system).toContain('【记忆管理】');
      expect(system).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
    });

    it('slice 3：岗位策略 correction 清空 scopeSummary → 不注入【职责边界】', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_demo',
        name: '示例助手',
        role: null,
        prompt: '示例职责。',
        agentKey: 'demo-agent',
        policyId: 'ep_agent_deny',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        memberRow({
          role: {
            id: 'ar_demo',
            key: 'demo-role',
            capabilities: {},
            rolePrompt: null,
          },
        }),
      ]);
      const policyService = {
        resolveByRole: jest.fn().mockResolvedValue({
          policyId: 'ep_custom_demo',
          policyName: '示例策略',
          agentName: 'vteam-demo-agent',
          permission: {},
          tools: {},
          bashDeny: [],
          correction: { scopeSummary: '', handoff: {} },
          serverGated: [],
        } as ResolvedExecutionPolicy),
        resolveByAgent: jest.fn(),
      };
      const d = createDispatcher(policyService);
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_demo',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(policyService.resolveByRole).toHaveBeenCalledTimes(1);
      expect(execArgs.system).not.toContain('【职责边界】');
    });

    it('slice 3 突变检测：岗位策略与执行 Agent 策略冲突 → 岗位决定 correction/tools（不读 Agent 策略）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_demo',
        name: '示例助手',
        role: null,
        prompt: '示例职责。',
        agentKey: 'demo-agent',
        // 执行 Agent 策略：另一套 correction + 空 tools（若被读取 → 边界与屏蔽全错）
        policyId: 'ep_agent_deny',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        memberRow({
          role: {
            id: 'ar_demo',
            key: 'demo-role',
            capabilities: { 'memory.save': true, 'doc.submit': true },
            rolePrompt: null,
          },
        }),
      ]);
      const policyService = {
        resolveByRole: jest.fn().mockResolvedValue({
          policyId: 'ep_role_ok',
          policyName: '岗位策略',
          agentName: 'vteam-demo-agent',
          permission: {},
          tools: {
            vteam_memory_save: 'allow',
            vteam_submit_artifact: 'allow',
          },
          bashDeny: [],
          correction: { scopeSummary: '岗位边界：听岗位的。', handoff: {} },
          serverGated: [],
        } as ResolvedExecutionPolicy),
        resolveByAgent: jest.fn().mockResolvedValue({
          policyId: 'ep_agent_deny',
          policyName: '执行者策略',
          agentName: 'vteam-demo-agent',
          permission: {},
          tools: {},
          bashDeny: [],
          correction: { scopeSummary: '执行者边界：听执行者的。', handoff: {} },
          serverGated: [],
        } as ResolvedExecutionPolicy),
      };
      const d = createDispatcher(policyService);
      await d.dispatch({
        ...request,
        targets: [
          {
            agentId: 'a_demo',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });

      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(policyService.resolveByRole).toHaveBeenCalledWith({
        roleKey: 'demo-role',
      });
      expect(policyService.resolveByAgent).not.toHaveBeenCalled();
      expect(system).toContain('【职责边界】岗位边界：听岗位的。');
      expect(system).not.toContain('执行者边界');
      // 工具屏蔽同样取岗位能力矩阵：allow ⇒ 记忆/产出物两段照常注入（Agent 空 tools 会屏蔽）
      expect(system).toContain('【记忆管理】');
      expect(system).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
    });

    it('slice 3：岗位策略解析异常 → 不阻断分派，回退岗位常量边界', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: '负责需求拆解。',
        agentKey: 'product',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        memberRow({
          role: {
            id: 'ar_product',
            key: 'product',
            capabilities: {},
            rolePrompt: null,
          },
        }),
      ]);
      const policyService = {
        resolveByRole: jest
          .fn()
          .mockRejectedValue(new Error('execution_policies 查询失败')),
        resolveByAgent: jest.fn(),
      };
      const d = createDispatcher(policyService);
      await d.dispatch(request);

      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(policyService.resolveByRole).toHaveBeenCalledTimes(1);
      expect(system).toContain(ROLE_BOUNDARIES['vteam-product'].scopeSummary);
    });

    it('slice 3：成员未绑角色 → 不读 Agent 策略，回退 agentKey 常量（存量路径）', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: '负责需求拆解。',
        agentKey: 'product',
        policyId: 'ep_agent_deny',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      (prisma as any).teamMember.findMany = jest
        .fn()
        .mockResolvedValue([memberRow({ role: null })]);
      const policyService = {
        resolveByRole: jest.fn(),
        resolveByAgent: jest.fn(),
      };
      const d = createDispatcher(policyService);
      await d.dispatch(request);

      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(policyService.resolveByRole).not.toHaveBeenCalled();
      expect(policyService.resolveByAgent).not.toHaveBeenCalled();
      expect(system).toContain(ROLE_BOUNDARIES['vteam-product'].scopeSummary);
    });

    it('主成员目标：system 注入主 Agent 职责段 + 团队成员段（mainAgentMemberId 判定，TeamMember 组装）', async () => {
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
          agent: {
            id: 'a_product',
            name: '产品经理',
            role: 'product',
            agentKey: 'product',
          },
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_architect',
          alias: '架构师-1',
          seq: 1,
          agent: {
            id: 'a_architect',
            name: '架构师',
            role: 'architect',
            agentKey: 'architect',
          },
        },
      ]);
      (prisma as any).team.findUnique = jest
        .fn()
        .mockResolvedValue({ mainAgentMemberId: 'tmm_0000000001' });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        agentKey: 'product',
        prompt: '负责需求拆解。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      // 单入口主门唯一来源 team.mainAgentMemberId；任务侧主映射归 Todo 5 删除
      expect((prisma as any).team.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: request.teamId } }),
      );
      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      // 当前成员是主成员 → 追加主 Agent 职责段；身份段含成员别名+成员 id
      expect(execArgs.system).toContain(MAIN_AGENT_INSTRUCTION);
      expect(execArgs.system).toContain('【主 Agent 职责】');
      expect(execArgs.system).toContain(
        '你是本任务的 产品经理-1（实例 id: tmm_0000000001，角色: product）',
      );
      // 团队段：全部成员 + 主成员标注（按 instanceId 匹配）
      expect(execArgs.system).toContain('【团队成员】');
      expect(execArgs.system).toContain(
        '产品经理-1（实例 id: tmm_0000000001，角色: product） —— 主 Agent',
      );
      expect(execArgs.system).toContain(
        '架构师-1（实例 id: tmm_0000000002，角色: architect）',
      );
    });

    it('非主成员目标：system 含团队成员段（标注主成员）但不含主 Agent 职责段', async () => {
      (prisma as any).teamMember.findMany = jest.fn().mockResolvedValue([
        {
          id: 'tmm_0000000001',
          agentId: 'a_product',
          alias: '产品经理-1',
          seq: 1,
          agent: {
            id: 'a_product',
            name: '产品经理',
            role: 'product',
            agentKey: 'product',
          },
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_project_manager',
          alias: '项目经理-1',
          seq: 1,
          agent: {
            id: 'a_project_manager',
            name: '项目经理',
            role: 'project_manager',
            agentKey: 'project_manager',
          },
        },
      ]);
      (prisma as any).team.findUnique = jest
        .fn()
        .mockResolvedValue({ mainAgentMemberId: 'tmm_0000000002' });
      // 目标会话绑非主成员（产品经理-1）
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        agentKey: 'product',
        prompt: '负责需求拆解。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(execArgs.system).not.toContain(MAIN_AGENT_INSTRUCTION);
      expect(execArgs.system).toContain('【团队成员】');
      expect(execArgs.system).toContain(
        '项目经理-1（实例 id: tmm_0000000002，角色: project_manager） —— 主 Agent',
      );
    });

    it('双开发者成员：身份段别名（开发者-1/开发者-2）按各自会话注入，团队段含成员 id+别名+主标注', async () => {
      const teamRows = [
        {
          id: 'tmm_0000000001',
          agentId: 'a_project_manager',
          alias: '项目经理-1',
          seq: 1,
          agent: {
            id: 'a_project_manager',
            name: '项目经理',
            role: 'project_manager',
            agentKey: 'project_manager',
          },
        },
        {
          id: 'tmm_0000000002',
          agentId: 'a_developer',
          alias: '开发者-1',
          seq: 1,
          agent: {
            id: 'a_developer',
            name: '开发者',
            role: 'developer',
            agentKey: 'developer',
          },
        },
        {
          id: 'tmm_0000000003',
          agentId: 'a_developer',
          alias: '开发者-2',
          seq: 2,
          agent: {
            id: 'a_developer',
            name: '开发者',
            role: 'developer',
            agentKey: 'developer',
          },
        },
      ];
      (prisma as any).teamMember.findMany = jest
        .fn()
        .mockResolvedValue(teamRows);
      (prisma as any).team.findUnique = jest
        .fn()
        .mockResolvedValue({ mainAgentMemberId: 'tmm_0000000001' });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_developer',
        name: '开发者',
        role: 'developer',
        agentKey: 'developer',
        prompt: '负责编码实现。',
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });
      // 目标 = 开发者-1 成员（tmm_0000000002）的会话
      prisma.session.findUnique.mockResolvedValue({
        id: 's_dev_1',
        workerId: null,
        instanceRef: null,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000002',
      });
      const devRequest = {
        ...request,
        targets: [
          {
            agentId: 'a_developer',
            instanceId: 'tmm_0000000002',
            sessionId: 's_dev_1',
          },
        ],
      };
      const d = createDispatcher();
      await d.dispatch(devRequest);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      // 身份段：别名 开发者-1 + 成员 id tmm_0000000002（非主成员 → 无主 Agent 职责段）
      expect(execArgs.system).toContain(
        '你是本任务的 开发者-1（实例 id: tmm_0000000002，角色: developer）',
      );
      expect(execArgs.system).not.toContain(MAIN_AGENT_INSTRUCTION);
      // 团队段：三成员（别名+成员 id），主标注在 项目经理-1
      expect(execArgs.system).toContain('【团队成员】');
      expect(execArgs.system).toContain(
        '项目经理-1（实例 id: tmm_0000000001，角色: project_manager） —— 主 Agent',
      );
      expect(execArgs.system).toContain(
        '开发者-1（实例 id: tmm_0000000002，角色: developer）',
      );
      expect(execArgs.system).toContain(
        '开发者-2（实例 id: tmm_0000000003，角色: developer）',
      );
      // 同 agent 双成员的 seq 不混（团队段不把 开发者-2 当 开发者-1）
      expect(execArgs.system).not.toContain(
        '开发者-1（实例 id: tmm_0000000003',
      );

      // 开发者-2 独立 dispatch：身份段换 开发者-2/tmm_0000000003
      prisma.session.findUnique.mockResolvedValue({
        id: 's_dev_2',
        workerId: null,
        instanceRef: null,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000003',
      });
      await d.dispatch({
        ...devRequest,
        targets: [
          {
            agentId: 'a_developer',
            instanceId: 'tmm_0000000003',
            sessionId: 's_dev_2',
          },
        ],
      });
      const dev2Args = workerClient.execute.mock.calls[1][1] as {
        system: string;
      };
      expect(dev2Args.system).toContain(
        '你是本任务的 开发者-2（实例 id: tmm_0000000003，角色: developer）',
      );
      expect(dev2Args.system).not.toContain(MAIN_AGENT_INSTRUCTION);
    });

    it('团队行缺失/空名册：system 降级为纯身份 + 接待段，不阻断 dispatch', async () => {
      const d = createDispatcher();
      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        system: string;
      };
      expect(execArgs.system).not.toContain(MAIN_AGENT_INSTRUCTION);
      expect(execArgs.system).not.toContain('【团队成员】');
      expect(execArgs.system).toContain(
        '你是本任务的 a_product（实例 id: tmm_0000000001，角色: ）',
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
        ['thinking', { type: 'team', id: request.teamId }],
        ['operating', { type: 'team', id: request.teamId }],
      ]);
      expect(loading).toEqual([
        {
          taskId: 'team:tm_0000000001',
          agentId: 'a_product',
          instanceId: 'tmm_0000000001',
          sessionId: 's_0000000001',
          phase: 'thinking',
        },
        {
          taskId: 'team:tm_0000000001',
          agentId: 'a_product',
          instanceId: 'tmm_0000000001',
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
          taskId: 'team:tm_0000000001',
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'online',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      // 第一次查询命中绑定 worker（offline）→ 触发解绑重分配；第二次查询返回新 worker
      prisma.worker.findUnique
        .mockResolvedValueOnce({
          id: 'w_offline',
          status: 'offline',
          capabilities: {},
        })
        .mockResolvedValueOnce({
          id: 'w_online',
          status: 'online',
          capabilities: {},
        });
      workersService.assignWorker.mockResolvedValue('w_online');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession.mockResolvedValue({ sessionID: 'ses_online' });
      const d = createDispatcher();

      await d.dispatch(request);

      // 解绑被调用（释放离线 worker 绑定，Session 恢复 created）
      expect(sessionLifecycle.unbindSession).toHaveBeenCalledWith(
        's_0000000001',
      );
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'w_online',
          status: 'online',
          capabilities: {},
        });
      workersService.assignWorker.mockResolvedValue('w_online');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession.mockResolvedValue({ sessionID: 'ses_online' });
      const d = createDispatcher();

      await d.dispatch(request);

      expect(sessionLifecycle.unbindSession).toHaveBeenCalledWith(
        's_0000000001',
      );
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

      await d.dispatch({
        ...request,
        targets: [{ agentId: 'a_product', sessionId: null }],
      });

      expect(errors).toHaveLength(1);
      expect(workersService.assignWorker).not.toHaveBeenCalled();
      expect(prisma.session.findUnique).not.toHaveBeenCalled();
    });

    it('createSession 失败：emitError + 广播 agent.error，返回空 replies', async () => {
      workerClient.createSession.mockRejectedValue(
        new WorkerUnavailableException(
          'w_0000000001',
          'createSession HTTP 503',
        ),
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
        expect.objectContaining({
          level: 'message',
          errorType: 'dispatch_failed',
        }),
      );
    });

    it('F2 M5：createSession 失败 → 回滚绑定（unbindSession）防 Session 绑坏 worker', async () => {
      workerClient.createSession.mockRejectedValue(
        new WorkerUnavailableException(
          'w_0000000001',
          'createSession HTTP 503',
        ),
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      workersService.assignWorker.mockResolvedValue('w_fresh');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_fresh',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
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
          {
            agentId: 'a_product',
            instanceId: 'tmm_0000000001',
            sessionId: 's_1',
          },
          {
            agentId: 'a_developer',
            instanceId: 'tmm_0000000001',
            sessionId: 's_2',
          },
        ],
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(
        expect.objectContaining({ agentId: 'a_product' }),
      );
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
      agentKey: null,
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
      expect(s).toContain(
        `你是本任务的 ${agent.name}（实例 id: ${agent.id}，角色: product）`,
      );
      expect(s).toContain('【职责】负责需求拆解与文档化。');
      expect(s).not.toContain(MAIN_AGENT_INSTRUCTION);
      expect(s).not.toContain('【团队成员】');
    });

    it('身份段实例语义：selfInstanceId/selfAlias 注入实例身份（实例 id: ta_…，别名优先）', () => {
      const s = buildSystemInstructions(agent, {
        selfInstanceId: 'ta_product_1',
        selfAlias: '产品经理-1',
      });
      expect(s).toContain(
        '你是本任务的 产品经理-1（实例 id: ta_product_1，角色: product）',
      );
      // selfAlias 缺省（存量会话未解析别名）→ 回退 agent.name，实例 id 仍用 selfInstanceId
      const s2 = buildSystemInstructions(agent, {
        selfInstanceId: 'ta_product_1',
      });
      expect(s2).toContain(
        '你是本任务的 产品经理（实例 id: ta_product_1，角色: product）',
      );
    });

    it('双维度身份：selfInstanceId 为团队成员 id（tmm_）时并列任务实例 id（ta_），工具填写以后者为准', () => {
      const s = buildSystemInstructions(agent, {
        selfInstanceId: 'tmm_0000000002',
        selfAlias: '产品经理-1',
        taskInstanceId: 'ta_0000000004',
      });
      expect(s).toContain(
        '你是本任务的 产品经理-1（团队成员 id: tmm_0000000002，任务实例 id: ta_0000000004，角色: product）',
      );
      expect(s).toContain(
        'selfInstanceId 参数必须填写你的任务实例 id（ta_0000000004）',
      );
      // 一致时不画蛇添足：仍为单 id 形态
      const s2 = buildSystemInstructions(agent, {
        selfInstanceId: 'ta_0000000004',
        taskInstanceId: 'ta_0000000004',
      });
      expect(s2).toContain(
        '你是本任务的 产品经理（实例 id: ta_0000000004，角色: product）',
      );
      expect(s2).not.toContain('团队成员 id:');
    });

    it('isMainAgent=true：追加主 Agent 职责段（牵头分工/协调衔接/群聊进度/@ 成员/汇总验收）', () => {
      const s = buildSystemInstructions(agent, { isMainAgent: true });
      expect(s).toContain(MAIN_AGENT_INSTRUCTION);
      expect(s).toContain('【主 Agent 职责】');
      expect(s).toContain('牵头拆解工作并分派');
      expect(s).toContain('群聊提示进度');
      expect(s).toContain('vteam_notify_agent');
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
      expect(s).toContain(
        '架构师（实例 id: ta_architect_1，角色: architect） —— 主 Agent',
      );
      expect(s).not.toContain(
        '产品经理-1（实例 id: ta_product_1，角色: product） —— 主 Agent',
      );
    });

    it('带团队但主实例为 null（任务未确定主实例）：团队成员段无任何标注', () => {
      const s = buildSystemInstructions(agent, {
        team,
        mainAgentInstanceId: null,
      });
      expect(s).toContain('【团队成员】');
      expect(s).not.toContain(' —— 主 Agent');
    });

    it('GLOBAL 常量含压缩【持久化目录】段：一句话、以【运行时工作目录】注入实际路径为准（纯用户语言，无代码味）', () => {
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('【持久化目录】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain(
        '唯一持久化位置以【运行时工作目录】注入的实际路径为准',
      );
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('仅该目录重启后保留');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain(
        'opts.persistentWorkDir',
      );
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('work-dir.util');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('taskDirOf');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('<WORK_DIR');
      // P0：消除“/data/vteam-worker/<agent名称> vs /data/vteam-worker/tasks/<taskId>”二义性
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('<agent名称>');
      // P0：fileRef 示例不再用 /tmp（与持久化语义矛盾），改用工作目录下路径示例
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('/tmp');
      // P1：产出物详版下沉为 ARTIFACT_SUBMISSION_INSTRUCTION（【公开与归档】唯一详版），GLOBAL 不再留引用句
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('【公开与归档】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain(
        '详见本次分派注入的产出物指引段',
      );
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('【产出物声明】');
      expect(ARTIFACT_SUBMISSION_INSTRUCTION).toContain('text/doc/file 三类');
      expect(ARTIFACT_SUBMISSION_INSTRUCTION).toContain('自动拉取归档');
    });

    it('GLOBAL 工具名统一为真实暴露名（与 VTEAM_MCP_TOOL_NAMES 一致，无短名混用）', () => {
      for (const name of [
        'vteam_group_post',
        'vteam_notify_agent',
        'vteam_issue_*',
        'vteam_memory_search',
        'vteam_memory_save',
      ]) {
        expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain(name);
      }
      // 【公开与归档】引用行已删：GLOBAL 不再提 submit，唯一详版在 ARTIFACT 段
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('vteam_submit_artifact');
      expect(ARTIFACT_SUBMISSION_INSTRUCTION).toContain(
        'vteam_submit_artifact',
      );
      // P1：issue 完整版下沉为 ISSUE_FULL_INSTRUCTION（仅 product/tester/developer 注入），GLOBAL 只留一句版
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('【Issue协作】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('【Issue 管理】');
      for (const name of [
        'vteam_issue_create',
        'vteam_issue_list',
        'vteam_issue_get',
        'vteam_issue_update',
        'vteam_issue_transition',
      ]) {
        expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain(name);
        expect(ISSUE_FULL_INSTRUCTION).toContain(name);
      }
      // P0：条件段已下沉为独立常量，不再出现在 GLOBAL
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('【任务状态】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('【托管模式】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('【企业微信】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('task_transition');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('question_confirm');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('wecom_reply');
    });

    it('GLOBAL 常量含【记忆管理】段：引导经 memory_search/memory_save 按需存取记忆（21 篇按需注入哲学）', () => {
      // 三个 sentinel 全部在 join 后的 GLOBAL prompt 中（机器可断言，非"模型会调用工具"行为）
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('【记忆管理】');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('vteam_memory_search');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('vteam_memory_save');
      // P1：压缩为 2 行（只存可复用经验 howto/pitfall/constraint + 存取调用一句，limit≤5）
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('只存可复用经验');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('howto');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('pitfall');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('constraint');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain(
        '调 vteam_memory_search 检索，沉淀时调 vteam_memory_save 保存',
      );
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('参数细节查工具 schema');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('{taskId, query?');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain(
        '{taskId, selfInstanceId',
      );
      // P1：禁存清单/翻页/tags 精搜等细节已删（移到 task_context/doclib 按需查，注释注明去向）
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('禁存');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('翻页');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('精搜');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('task_context');
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('doclib');
      // 既有段不被改动（顺序保留：记忆管理段追加在【持久化目录】之后；
      // P0：【托管模式】已下沉为 HOSTED_CONFIRM_INSTRUCTION，仅主 Agent 条件注入）
      expect(
        GLOBAL_SYSTEM_INSTRUCTIONS.indexOf('【记忆管理】'),
      ).toBeGreaterThan(GLOBAL_SYSTEM_INSTRUCTIONS.indexOf('【持久化目录】'));
      expect(HOSTED_CONFIRM_INSTRUCTION).toContain('vteam_question_confirm');
      expect(TASK_TRANSITION_INSTRUCTION).toContain('vteam_task_transition');
      expect(WECOM_SYSTEM_INSTRUCTION).toContain('vteam_wecom_reply');
    });

    it('去参数化：核心提示词正文不含行内工具参数 JSON，工具名与硬约束保留', () => {
      const paramJson = /\{(taskId|type:|teamId|selfInstanceId)/;
      for (const text of [
        GLOBAL_SYSTEM_INSTRUCTIONS,
        MEMORY_INSTRUCTION,
        ARTIFACT_SUBMISSION_INSTRUCTION,
        GROUP_TRIGGER_INSTRUCTION,
        TEAM_GROUP_TRIGGER_INSTRUCTION,
        WECOM_SYSTEM_INSTRUCTION,
        WECOM_TRIGGER_INSTRUCTION,
        TASK_TRANSITION_INSTRUCTION,
        HOSTED_CONFIRM_INSTRUCTION,
        TEAM_SYSTEM_RECEPTION_INSTRUCTION,
      ]) {
        expect(text).not.toMatch(paramJson);
      }
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain('vteam_notify_agent');
      expect(TASK_TRANSITION_INSTRUCTION).toContain('vteam_task_transition');
      expect(TASK_TRANSITION_INSTRUCTION).toContain('403');
      expect(TASK_TRANSITION_INSTRUCTION).toContain('仅人类用户');
      expect(TASK_TRANSITION_INSTRUCTION).toContain('等待人工验收');
      expect(HOSTED_CONFIRM_INSTRUCTION).toContain('vteam_question_confirm');
      expect(HOSTED_CONFIRM_INSTRUCTION).toContain('仅主实例可调用');
      expect(TEAM_GROUP_TRIGGER_INSTRUCTION).toContain('禁止传递 taskId 参数');
      expect(TEAM_GROUP_TRIGGER_INSTRUCTION).toContain('tmm_ 前缀');
      expect(ARTIFACT_SUBMISSION_INSTRUCTION).toContain(
        'vteam_submit_artifact',
      );
      expect(GROUP_TRIGGER_INSTRUCTION).toContain('vteam_group_post');
      expect(GROUP_TRIGGER_INSTRUCTION).toContain('自动归档为产出物');
    });

    it('todo 5：rolePrompt 非空 → 【岗位职责】(角色) + 【职责】(agent) + 平台块各恰好一次，顺序 role→agent→platform', () => {
      const rolePrompt =
        '# 角色：产品经理\n你是任务虚拟团队中的产品经理 Agent，负责需求。';
      const s = buildSystemInstructions(agent, { rolePrompt });
      const count = (haystack: string, needle: string): number =>
        haystack.split(needle).length - 1;
      expect(count(s, '【岗位职责】')).toBe(1);
      expect(count(s, rolePrompt)).toBe(1);
      expect(count(s, '【职责】')).toBe(1);
      expect(count(s, TEAM_COLLABORATION_CHARTER_INSTRUCTION)).toBe(1);
      expect(count(s, AGENT_RECEIPT_IRON_LAW_INSTRUCTION)).toBe(1);
      const iRole = s.indexOf('【岗位职责】');
      const iAgent = s.indexOf('【职责】');
      const iCharter = s.indexOf(TEAM_COLLABORATION_CHARTER_INSTRUCTION);
      const iReceipt = s.indexOf(AGENT_RECEIPT_IRON_LAW_INSTRUCTION);
      expect(iRole).toBeGreaterThan(0);
      expect(iAgent).toBeGreaterThan(iRole);
      expect(iCharter).toBeGreaterThan(iAgent);
      expect(iReceipt).toBeGreaterThan(iCharter);
      expect(s).toContain(`【岗位职责】${rolePrompt}`);
      expect(s).toContain(`【职责】${agent.prompt}`);
    });

    it('todo 5：rolePrompt 空串/null/缺省 → 无【岗位职责】标题（agent-only 装配，与无该字段逐字节一致）', () => {
      const withNull = buildSystemInstructions(agent, { rolePrompt: null });
      const withUndefined = buildSystemInstructions(agent, {
        rolePrompt: undefined,
      });
      expect(buildSystemInstructions(agent)).toBe(withNull);
      expect(withNull).toBe(withUndefined);
      for (const s of [
        withNull,
        withUndefined,
        buildSystemInstructions(agent),
      ]) {
        expect(s).not.toContain('【岗位职责】');
        expect(s).toContain(`【职责】${agent.prompt}`);
      }
      const empty = buildSystemInstructions(agent, { rolePrompt: '' });
      expect(empty).not.toContain('【岗位职责】');
      expect(empty).toBe(buildSystemInstructions(agent));
    });

    it('记忆段屏蔽由已解析策略 tools 驱动：缺 vteam_memory_save → 不注入【记忆管理】2行', () => {
      const plan: AgentIdentityInfo = {
        id: 'a_plan',
        name: '计划员',
        role: 'plan',
        prompt: null,
        persona: null,
        agentKey: null,
      };
      // 出厂 plan 策略 tools 无 memory_save / submit_artifact → 两段都屏蔽。
      const planTools = resolveConstantPolicySource('vteam-plan')!.config.tools;
      const s = buildSystemInstructions(plan, { resolvedTools: planTools });
      expect(s).not.toContain(MEMORY_INSTRUCTION);
      expect(s).not.toContain('【记忆管理】');
      expect(s).not.toContain('vteam_memory_search');
      expect(s).not.toContain('vteam_memory_save');
      // 非记忆段不受影响
      expect(s).toContain('【持久化目录】');
      // 产出物段同判据：缺 submit_artifact 同样跳过
      expect(s).not.toContain('【公开与归档】');
      expect(s).not.toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      expect(s).not.toContain('vteam_submit_artifact');
      // resolvedTools 缺省 → 不屏蔽（存量/未知调用者行为逐字节不变）
      expect(buildSystemInstructions(plan)).toContain('【记忆管理】');
    });

    describe('指令屏蔽由 resolved tools 驱动（todo 2：与 plan-mode 推导解耦）', () => {
      const identity: AgentIdentityInfo = {
        id: 'a_plan',
        name: '计划员',
        role: 'plan',
        prompt: null,
        persona: null,
        agentKey: null,
      };
      const withTools = (tools: Record<string, 'allow' | 'ask' | 'deny'>) =>
        buildSystemInstructions(identity, { resolvedTools: tools });

      it('(a) 计划员持有 vteam_memory_save → 仍注入【记忆管理】（判据是工具，不是 duty/角色名）', () => {
        const s = withTools({
          vteam_memory_save: 'allow',
          vteam_submit_artifact: 'allow',
        });
        expect(s).toContain(MEMORY_INSTRUCTION);
        expect(s).toContain('【记忆管理】');
        expect(s).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      });

      it('(b) 缺 vteam_memory_save 的非计划员 → 屏蔽【记忆管理】', () => {
        const s = buildSystemInstructions(
          { ...identity, role: 'developer' },
          { resolvedTools: { vteam_submit_artifact: 'allow' } },
        );
        expect(s).not.toContain('【记忆管理】');
        expect(s).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      });

      it('(e) 产出物段：allow → 注入；缺项/deny → 屏蔽（双向）', () => {
        expect(
          withTools({
            vteam_memory_save: 'allow',
            vteam_submit_artifact: 'allow',
          }),
        ).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
        expect(withTools({ vteam_memory_save: 'allow' })).not.toContain(
          ARTIFACT_SUBMISSION_INSTRUCTION,
        );
        expect(
          withTools({
            vteam_memory_save: 'allow',
            vteam_submit_artifact: 'deny',
          }),
        ).not.toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      });

      it('ask 视为放行（与 worker guard isToolAllowed 同口径）', () => {
        const s = withTools({
          vteam_memory_save: 'ask',
          vteam_submit_artifact: 'ask',
        });
        expect(s).toContain('【记忆管理】');
        expect(s).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      });

      it('resolvedTools null/undefined → 不屏蔽（存量调用字节不变）', () => {
        expect(withTools(undefined as never)).toContain('【记忆管理】');
        expect(
          buildSystemInstructions(identity, { resolvedTools: null }),
        ).toContain('【记忆管理】');
        expect(buildSystemInstructions(identity)).toContain('【记忆管理】');
      });
    });

    it('product 有记忆段（tools 放行 memory_save/artifact，非计划员照常注入）', () => {
      const product: AgentIdentityInfo = {
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: null,
        persona: null,
        agentKey: null,
      };
      const productTools =
        resolveConstantPolicySource('vteam-product')!.config.tools;
      const s = buildSystemInstructions(product, {
        resolvedTools: productTools,
      });
      expect(s).toContain(MEMORY_INSTRUCTION);
      expect(s).toContain('【记忆管理】');
      expect(s).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      // GLOBAL 导出值不变（MEMORY 拆分前后逐字一致）
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).toContain(MEMORY_INSTRUCTION);
      // 语义变更（todo 2）：判据换成工具——role='plan' 但 tools 放行 memory_save → 照常注入
      const planByRole = buildSystemInstructions(
        { ...product, role: 'plan' },
        { resolvedTools: productTools },
      );
      expect(planByRole).toContain('【记忆管理】');
      // 反之 role 非 plan 但 tools 缺该工具 → 屏蔽
      const noTool = buildSystemInstructions(product, {
        resolvedTools: { vteam_submit_artifact: 'allow' },
      });
      expect(noTool).not.toContain('【记忆管理】');
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

    it('persistentWorkDir 缺省：仅静态【持久化目录】段，不注入动态分配路径句（向后兼容）', () => {
      const s = buildSystemInstructions(agent);
      expect(s).not.toContain('本任务为你分配的实际持久化工作目录为');
      expect(s).toContain('【持久化目录】');
    });

    it('Todo 11：boundarySection 非空 → 追加【职责边界】段（scopeSummary + 越界处理）', () => {
      const section = renderBoundarySection(
        resolveConstantPolicySource('vteam-product')?.config.correction,
      );
      expect(section).toContain('【职责边界】');
      expect(section).toContain(ROLE_BOUNDARIES['vteam-product'].scopeSummary);
      expect(section).toContain('越界处理：');

      const s = buildSystemInstructions(agent, { boundarySection: section });
      expect(s).toContain('【职责边界】');
      expect(s).toContain(ROLE_BOUNDARIES['vteam-product'].scopeSummary);
    });

    it('Todo 4：boundarySection 缺省/空串 → 与基线输出逐字节一致（不新增段）', () => {
      const baseline = buildSystemInstructions(agent);
      expect(baseline).not.toContain('【职责边界】');
      expect(buildSystemInstructions(agent, { boundarySection: '' })).toBe(
        baseline,
      );
      expect(
        buildSystemInstructions(agent, { boundarySection: undefined }),
      ).toBe(baseline);
    });

    it('Todo 11：renderBoundarySection correction 为空/无 scopeSummary → 空串（不注入）', () => {
      expect(renderBoundarySection(null)).toBe('');
      expect(renderBoundarySection(undefined)).toBe('');
      expect(renderBoundarySection({})).toBe('');
      expect(
        renderBoundarySection({ handoff: { code: 'vteam-developer' } }),
      ).toBe('');
      expect(renderBoundarySection({ scopeSummary: '' })).toBe('');
      expect(renderBoundarySection({ scopeSummary: 42 })).toBe('');
    });

    it('Todo 4：agentKeyToVteamAgentName / isVteamAgentName 映射（agentKey → vteam-<key>）', () => {
      expect(agentKeyToVteamAgentName('product')).toBe('vteam-product');
      expect(agentKeyToVteamAgentName('project_manager')).toBe(
        'vteam-project_manager',
      );
      expect(agentKeyToVteamAgentName('unknown')).toBeNull();
      expect(agentKeyToVteamAgentName('')).toBeNull();
      expect(agentKeyToVteamAgentName(null)).toBeNull();
      expect(isVteamAgentName('vteam-developer')).toBe(true);
      expect(isVteamAgentName('vteam-plan')).toBe(true);
      expect(isVteamAgentName('developer')).toBe(false);
      expect(isVteamAgentName(null)).toBe(false);
    });

    it('todo 10：resolvePolicyAgentCandidate 只认 agentKey（规则 4 收窄：无 key 无候选，角色回退已移除）', () => {
      // 自定义 agent：agentKey 有效 → 直接命中（不再有 role 键参与）
      expect(resolvePolicyAgentCandidate({ agentKey: 'demo-agent' })).toBe(
        'vteam-demo-agent',
      );
      // 模板行 agentKey = role → 与 agentKeyToVteamAgentName 同值
      expect(resolvePolicyAgentCandidate({ agentKey: 'product' })).toBe(
        'vteam-product',
      );
      // 规则 4：agentKey 缺席 → 无候选（旧实现回退 vteam-developer，已收窄）
      expect(resolvePolicyAgentCandidate({ agentKey: null })).toBeNull();
      // 非法 key 视为缺席 → 无候选（绝不拼出非法 agent 名）
      expect(resolvePolicyAgentCandidate({ agentKey: 'Bad-Key' })).toBeNull();
      expect(resolvePolicyAgentCandidate(null)).toBeNull();
      // 运行时旧形状（role 键由未迁移调用方传入；编译期签名已不含该键）：
      // role 一律忽略——缺席 key 仍 null，非法 key 仍 null。
      expect(
        resolvePolicyAgentCandidate({
          agentKey: null,
          role: 'developer',
        } as never),
      ).toBeNull();
      expect(
        resolvePolicyAgentCandidate({
          agentKey: 'Bad-Key',
          role: 'product',
        } as never),
      ).toBeNull();
    });

    it('Todo 11：自定义 agent 的 correction → 有【职责边界】段（不再按名 gating）', () => {
      const section = renderBoundarySection({
        scopeSummary: '自定义职责：只做示例分析。',
        handoff: { review: 'vteam-tester' },
      });
      expect(section).toContain('【职责边界】自定义职责：只做示例分析。');
      expect(section).toContain('review→vteam-tester');
      expect(section).toContain('vteam_notify_agent');
    });

    it('todo 10：roleLabelOfAgentKey——内置 key 原样、自定义/缺席/非法为空串（装配标签的唯一来源）', () => {
      for (const key of [
        'product',
        'project_manager',
        'architect',
        'developer',
        'tester',
        'plan',
        'librarian',
      ]) {
        expect(roleLabelOfAgentKey(key)).toBe(key);
      }
      expect(roleLabelOfAgentKey('myagent')).toBe('');
      expect(roleLabelOfAgentKey('t4-dev-t4-mu8fnf18')).toBe('');
      expect(roleLabelOfAgentKey('Bad-Key')).toBe('');
      expect(roleLabelOfAgentKey('')).toBe('');
      expect(roleLabelOfAgentKey(null)).toBe('');
      expect(roleLabelOfAgentKey(undefined)).toBe('');
    });

    it('todo 10：身份段『角色』值由 agentKey 派生——模板注入 key（product），与旧 Agent.role 逐字节一致', () => {
      const template: AgentIdentityInfo = {
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: null,
        persona: null,
        agentKey: 'product',
      };
      const s = buildSystemInstructions(template);
      expect(s).toContain(
        '你是本任务的 产品经理（实例 id: a_product，角色: product）',
      );
      // 双维度形态（团队成员 id + 任务实例 id）同样注入 key
      const s2 = buildSystemInstructions(template, {
        selfInstanceId: 'tmm_0000000001',
        selfAlias: '产品经理-1',
        taskInstanceId: 'ta_0000000001',
      });
      expect(s2).toContain(
        '你是本任务的 产品经理-1（团队成员 id: tmm_0000000001，任务实例 id: ta_0000000001，角色: product）',
      );
      for (const key of [
        'product',
        'project_manager',
        'architect',
        'developer',
        'tester',
        'plan',
        'librarian',
      ]) {
        expect(
          buildSystemInstructions({ ...template, role: key, agentKey: key }),
        ).toContain(`角色: ${key}）`);
      }
    });

    it('todo 10：身份段『角色』对自定义 agent 保持空串（旧 agent.role=null 为空，不泄漏 myagent）', () => {
      const custom: AgentIdentityInfo = {
        id: 'a_myagent',
        name: '自定义助手',
        role: '',
        prompt: null,
        persona: null,
        agentKey: 'myagent',
      };
      const s = buildSystemInstructions(custom);
      expect(s).toContain(
        '你是本任务的 自定义助手（实例 id: a_myagent，角色: ）',
      );
      expect(s).not.toContain('角色: myagent');
    });

    it('todo 10：名册行『角色』对自定义成员同样为空串（roster 行与身份行同源）', () => {
      const team: TeamMemberInfo[] = [
        {
          id: 'a_product',
          name: '产品经理',
          role: 'product',
          instanceId: 'tmm_0000000001',
          alias: '产品经理-1',
          seq: 1,
        },
        {
          id: 'a_myagent',
          name: '自定义助手',
          role: '',
          instanceId: 'tmm_0000000002',
          alias: '自定义-1',
          seq: 1,
        },
      ];
      const s = buildSystemInstructions(agent, { team });
      expect(s).toContain(
        '产品经理-1（实例 id: tmm_0000000001，角色: product）',
      );
      expect(s).toContain('自定义-1（实例 id: tmm_0000000002，角色: ）');
      expect(s).not.toContain('角色: myagent');
    });

    it('todo 10：roleNeedsIssueDetail 与旧结果一致——7 内置 key 逐一对齐（product/tester/developer 真）', () => {
      for (const key of ['product', 'tester', 'developer']) {
        expect(roleNeedsIssueDetail(key)).toBe(true);
      }
      for (const key of ['project_manager', 'architect', 'plan', 'librarian']) {
        expect(roleNeedsIssueDetail(key)).toBe(false);
      }
      // 自定义 agentKey 永不命中中文子串检查 → 与旧 null 输入同为 false
      expect(roleNeedsIssueDetail('myagent')).toBe(false);
      expect(roleNeedsIssueDetail('t4-dev-t4-mu8fnf18')).toBe(false);
    });

    it('Todo 11：7 内置出厂 correction → boundary 与变更前冻结基线逐字节一致', () => {
      const fixture = loadBoundaryBaseline();
      for (const [name, expected] of Object.entries(fixture.sections)) {
        const correction = resolveConstantPolicySource(name)?.config.correction;
        expect(renderBoundarySection(correction)).toBe(expected);
      }
    });

    it('guard.roles[*] 不再携带 correction（todo 5 死载荷删除）；boundary 改走常量源且逐字节一致', () => {
      // opencode-native-permissions-and-fixes todo 5: the worker guard that consumed
      // `guard.roles[*].correction` is deleted, so the payload no longer emits it.
      // The boundary text itself is still produced by the dispatcher from the DB
      // policy row / constant source and must stay byte-identical to the baseline.
      const baseline = loadAgentPoliciesBaseline();
      const boundary = loadBoundaryBaseline();
      for (const [name, expected] of Object.entries(boundary.sections)) {
        const role = baseline.guard.roles[name];
        expect(role).toBeDefined();
        expect(Object.keys(role)).toEqual(['permission']);
        expect(role).not.toHaveProperty('correction');
        const correction = resolveConstantPolicySource(name)?.config.correction;
        expect(renderBoundarySection(correction)).toBe(expected);
      }
    });

    it('persona 拼接：agent.persona=strict 时注入【性格】段（含安全阀文案），不改写 prompt', () => {
      const s = buildSystemInstructions({ ...agent, persona: 'strict' });
      expect(s).toContain('【性格】');
      expect(s).toContain('附改进建议');
      expect(s).toContain('【职责】负责需求拆解与文档化。'); // prompt 原样保留，未被性格污染
    });

    it('persona 为 null：不注入【性格】段（缺省/存量 agent 无性格，向后兼容）', () => {
      const s = buildSystemInstructions(agent);
      expect(s).not.toContain('【性格】');
    });

    it('persona 未知 key：renderPersonaSection 返回空串 → 不注入【性格】段且不抛错', () => {
      const s = buildSystemInstructions({ ...agent, persona: 'unknown-key' });
      expect(s).not.toContain('【性格】');
      expect(s).toContain('【职责】负责需求拆解与文档化。');
    });

    it('计划指令已下线：buildSystemInstructions 任何调用都不含计划段（平台不再代控计划模式）', () => {
      const s = buildSystemInstructions(agent);
      const mainS = buildSystemInstructions(agent, { isMainAgent: true });
      for (const text of [s, mainS]) {
        expect(text).not.toContain('【计划编制】');
        expect(text).not.toContain('【计划评审】');
        expect(text).not.toContain('plan-creation');
        expect(text).not.toContain('vteam_plan_review');
      }
    });

    it('产出物提交引导：非 plan 恒注入 submit_artifact 用法；plan 跳过（无该工具，落盘即交付）', () => {
      const s = buildSystemInstructions(agent);
      expect(s).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      expect(s).toContain('vteam_submit_artifact');
      expect(s).toContain('text/doc/file 三类');
      expect(s).toContain('自动拉取归档');
      expect(s).toContain('vteam_group_post');
      // 自造计划域已下线：不再注入 plan_submit / plan_review 等提示词
      expect(s).not.toContain('plan_submit');
      expect(s).not.toContain('plan_review');
      expect(s).not.toContain('【计划工作流】');
      // 既有段不受影响
      expect(s).toContain(GLOBAL_SYSTEM_INSTRUCTIONS);
      // plan-aware：缺 submit_artifact 的 tools → 不注入该段（判据是工具，非角色名）
      const planTools = resolveConstantPolicySource('vteam-plan')!.config.tools;
      const planS = buildSystemInstructions(
        { ...agent, role: 'plan' },
        { resolvedTools: planTools },
      );
      expect(planS).not.toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      expect(planS).not.toContain('【公开与归档】');
      expect(planS).not.toContain('vteam_submit_artifact');
    });

    it('短工具名批量改真实名：面向模型的自然语言指引无裸短名（协议/注释除外）', () => {
      const noBareShort =
        /(?<!vteam_)(group_post|notify_agent|chat_history|wecom_reply|submit_artifact|task_context|task_transition|question_confirm|task_create|memory_search|memory_save|team_view|my_profile|doclib|issue_create|issue_list|issue_get|issue_update|issue_transition)/;
      for (const text of [
        GROUP_TRIGGER_INSTRUCTION,
        TEAM_GROUP_TRIGGER_INSTRUCTION,
        WECOM_TRIGGER_INSTRUCTION,
        MAIN_AGENT_INSTRUCTION,
      ]) {
        expect(text).not.toMatch(noBareShort);
      }
      expect(GROUP_TRIGGER_INSTRUCTION).toContain('vteam_group_post');
      expect(TEAM_GROUP_TRIGGER_INSTRUCTION).toContain('vteam_group_post');
      expect(TEAM_GROUP_TRIGGER_INSTRUCTION).toContain('vteam_notify_agent');
      expect(TEAM_GROUP_TRIGGER_INSTRUCTION).toContain('vteam_chat_history');
      expect(TEAM_GROUP_TRIGGER_INSTRUCTION).toContain('vteam_task_create');
      expect(WECOM_TRIGGER_INSTRUCTION).toContain('vteam_wecom_reply');
      expect(WECOM_TRIGGER_INSTRUCTION).toContain('vteam_group_post');
      expect(MAIN_AGENT_INSTRUCTION).toContain('vteam_notify_agent');
      expect(MAIN_AGENT_INSTRUCTION).not.toContain('vteam_question_confirm');
    });

    it('P0 条件注入：isMainAgent=true 注入【任务状态】+【托管模式】工具段（含真实名）', () => {
      const s = buildSystemInstructions(agent, { isMainAgent: true });
      expect(s).toContain(TASK_TRANSITION_INSTRUCTION);
      expect(s).toContain(HOSTED_CONFIRM_INSTRUCTION);
      expect(s).toContain('vteam_task_transition');
      expect(s).toContain('vteam_question_confirm');
      expect(s).not.toContain(NON_MAIN_AGENT_NOTE);
    });

    it('P0 条件注入：非主/缺省仅注协作指引一句，不教必 403 工具', () => {
      for (const opts of [undefined, {}, { isMainAgent: false }] as const) {
        const s = buildSystemInstructions(agent, opts);
        expect(s).toContain(NON_MAIN_AGENT_NOTE);
        expect(s).toContain('状态流转/托管确认由主Agent操作，有事@主Agent');
        expect(s).toContain('定向通知仅可直达主Agent');
        expect(s).toContain('请主Agent中转');
        expect(s).not.toContain(TASK_TRANSITION_INSTRUCTION);
        expect(s).not.toContain(HOSTED_CONFIRM_INSTRUCTION);
        expect(s).not.toContain('【任务状态】');
        expect(s).not.toContain('【托管模式】');
      }
    });

    it('复读消除：全文【公开与归档】仅一处（ARTIFACT 完整版，GLOBAL 无引用行）', () => {
      const s = buildSystemInstructions(agent, { isMainAgent: true });
      const occurrences = s.split('【公开与归档】').length - 1;
      expect(occurrences).toBe(1);
      expect(s).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      expect(GLOBAL_SYSTEM_INSTRUCTIONS).not.toContain('【公开与归档】');
    });

    it('复读消除：MAIN 不含托管句但主仍有 HOSTED 全版（非主走协作指引不受影响）', () => {
      expect(MAIN_AGENT_INSTRUCTION).not.toContain('任务开启托管模式时');
      expect(MAIN_AGENT_INSTRUCTION).not.toContain('vteam_question_confirm');
      const main = buildSystemInstructions(agent, { isMainAgent: true });
      expect(main).toContain(MAIN_AGENT_INSTRUCTION);
      expect(main).toContain(HOSTED_CONFIRM_INSTRUCTION);
      expect(main).toContain('【托管模式】');
      const nonMain = buildSystemInstructions(agent, { isMainAgent: false });
      expect(nonMain).toContain(NON_MAIN_AGENT_NOTE);
      expect(nonMain).not.toContain(HOSTED_CONFIRM_INSTRUCTION);
      expect(nonMain).not.toContain(MAIN_AGENT_INSTRUCTION);
    });

    it('P0 漏网：boundary 越界句用真实暴露名 vteam_notify_agent', () => {
      const section = renderBoundarySection(
        resolveConstantPolicySource('vteam-product')?.config.correction,
      );
      expect(section).toContain('vteam_notify_agent');
      expect(section).not.toMatch(/(?<!vteam_)notify_agent/);
    });

    it('性格段前空行：plan 外角色性格段前有空行分隔', () => {
      const s = buildSystemInstructions({ ...agent, persona: 'steady' });
      expect(s).toContain('\n\n【性格】\n');
    });

    it('段落分隔：协议段/身份/职责/性格之间均为空行分隔，且全文无三换行及以上', () => {
      const s = buildSystemInstructions({ ...agent, persona: 'steady' });
      // GLOBAL 内【群聊通知】与【@定向机制】之间空行分隔
      expect(s).toContain('vteam_group_post 发布。\n\n【@ 定向机制】');
      // GLOBAL 内【@定向机制】与【@用户】之间空行分隔
      expect(s).toContain('定向回复特定成员。\n\n【@用户】');
      // 【你的身份】与【职责】之间空行分隔
      expect(s).toContain('必须填写你的实例 id（a_product）。\n\n【职责】');
      // 性格段前为空行分隔
      expect(s).toContain('\n\n【性格】\n');
      // 全文无三换行及以上（join 与段首前导换行不得叠出多余空行）
      expect(s).not.toMatch(/\n{3,}/);
    });

    it('P0 条件注入：isWecomChannel=true 才注入【企业微信】段，缺省不注入', () => {
      expect(buildSystemInstructions(agent)).not.toContain(
        WECOM_SYSTEM_INSTRUCTION,
      );
      expect(
        buildSystemInstructions(agent, { isWecomChannel: false }),
      ).not.toContain(WECOM_SYSTEM_INSTRUCTION);
      const s = buildSystemInstructions(agent, { isWecomChannel: true });
      expect(s).toContain(WECOM_SYSTEM_INSTRUCTION);
      expect(s).toContain('vteam_wecom_reply');
      expect(s).toContain('【企业微信】');
    });

    it('P0 去重 selfInstanceId：身份段只保留一处指引，无复读句', () => {
      const s = buildSystemInstructions(agent);
      expect(s).not.toContain('落库类工具');
      expect(s).toContain('selfInstanceId 参数必须填写你的实例 id');
      const s2 = buildSystemInstructions(agent, {
        selfInstanceId: 'tmm_0000000002',
        selfAlias: '产品经理-1',
        taskInstanceId: 'ta_0000000004',
      });
      expect(s2).not.toContain('落库类工具');
      expect(s2).toContain(
        'selfInstanceId 参数必须填写你的任务实例 id（ta_0000000004）',
      );
    });

    it('P1 issue 按角色裁剪：product 显式 issueDetail=true 收完整版（含创建+指派+流转 action）', () => {
      const product: AgentIdentityInfo = {
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: null,
        persona: null,
        agentKey: null,
      };
      expect(roleNeedsIssueDetail(product.role)).toBe(true);
      const s = buildSystemInstructions(product, { issueDetail: true });
      expect(s).toContain(ISSUE_FULL_INSTRUCTION);
      expect(s).toContain('vteam_issue_create');
      expect(s).toContain('vteam_issue_transition');
      expect(s).toContain('action: start/resolve/close/reopen/reject');
      expect(s).toContain('assigneeInstanceId');
      // 一句版仍在（GLOBAL 恒带）
      expect(s).toContain('【Issue协作】');
    });

    it('P1 issue 按角色裁剪：architect 缺省只收一句版，不收完整版', () => {
      const architect: AgentIdentityInfo = {
        id: 'a_architect',
        name: '架构师',
        role: 'architect',
        prompt: null,
        persona: null,
        agentKey: null,
      };
      expect(roleNeedsIssueDetail(architect.role)).toBe(false);
      for (const opts of [undefined, {}, { issueDetail: false }] as const) {
        const s = buildSystemInstructions(architect, opts);
        expect(s).toContain('【Issue协作】');
        expect(s).not.toContain(ISSUE_FULL_INSTRUCTION);
        expect(s).not.toContain('vteam_issue_create');
        expect(s).not.toContain('action: start/resolve/close/reopen/reject');
      }
    });

    it('P1 issue 角色判定：tester/developer（含中文名）收完整版，project_manager/plan/未知只收一句版', () => {
      for (const role of [
        'product',
        'tester',
        'developer',
        '产品经理',
        '测试',
        '开发者',
      ]) {
        expect(roleNeedsIssueDetail(role)).toBe(true);
      }
      for (const role of [
        'architect',
        'project_manager',
        'plan',
        '架构师',
        '项目经理',
        null,
        undefined,
      ]) {
        expect(roleNeedsIssueDetail(role)).toBe(false);
      }
      // 缺省不注入完整版（兼容存量调用）：product 裸调也只收一句版
      const s = buildSystemInstructions({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: null,
        persona: null,
        agentKey: null,
      });
      expect(s).toContain('【Issue协作】');
      expect(s).not.toContain(ISSUE_FULL_INSTRUCTION);
    });
  });

  // ------------------------------------------------------------------
  // 平台共享块注入（agent-role-entity todo 3）：团队协作规约 + 回执铁律
  // 对全部 7 个内置 Agent 无条件注入，无 name/role 分支。
  // ------------------------------------------------------------------
  describe('平台共享块注入（team charter + receipt iron law，全 7 内置无条件）', () => {
    const count = (haystack: string, needle: string): number =>
      haystack.split(needle).length - 1;
    const BUILTIN_IDENTITIES: AgentIdentityInfo[] = [
      {
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: null,
        persona: null,
        agentKey: null,
      },
      {
        id: 'a_project_manager',
        name: '项目经理',
        role: 'project_manager',
        prompt: null,
        persona: null,
        agentKey: null,
      },
      {
        id: 'a_architect',
        name: '架构师',
        role: 'architect',
        prompt: null,
        persona: null,
        agentKey: null,
      },
      {
        id: 'a_developer',
        name: '开发者',
        role: 'developer',
        prompt: null,
        persona: null,
        agentKey: null,
      },
      {
        id: 'a_tester',
        name: '测试',
        role: 'tester',
        prompt: null,
        persona: null,
        agentKey: null,
      },
      {
        id: 'a_plan',
        name: '计划员',
        role: 'plan',
        prompt: null,
        persona: null,
        agentKey: null,
      },
      {
        id: 'a_librarian',
        name: '知识管理员',
        role: 'librarian',
        prompt: null,
        persona: null,
        agentKey: null,
      },
    ];

    it('团队协作规约块对全部 7 个内置 Agent 各出现恰好一次（常量字节注入）', () => {
      expect(BUILTIN_IDENTITIES).toHaveLength(7);
      for (const identity of BUILTIN_IDENTITIES) {
        const s = buildSystemInstructions(identity);
        expect(count(s, TEAM_COLLABORATION_CHARTER_INSTRUCTION)).toBe(1);
        expect(count(s, '团队协作规约（全文见')).toBe(1);
      }
    });

    it('回执铁律块对全部 7 个内置 Agent 各出现恰好一次（含 PM/plan/librarian 的刻意扩展）', () => {
      for (const identity of BUILTIN_IDENTITIES) {
        const s = buildSystemInstructions(identity);
        expect(count(s, AGENT_RECEIPT_IRON_LAW_INSTRUCTION)).toBe(1);
        expect(count(s, '## 回执铁律')).toBe(1);
      }
      // 扩展的三角色此前无回执铁律，现必须收到（若引入 name/role 条件分支即在此红）
      for (const id of ['a_project_manager', 'a_plan', 'a_librarian']) {
        const identity = BUILTIN_IDENTITIES.find((a) => a.id === id)!;
        expect(buildSystemInstructions(identity)).toContain(
          AGENT_RECEIPT_IRON_LAW_INSTRUCTION,
        );
      }
    });

    it('两个平台常量文本字节与 seed 原文一致（不可改写/换行）', () => {
      expect(TEAM_COLLABORATION_CHARTER_INSTRUCTION.split('\n')).toHaveLength(
        5,
      );
      expect(AGENT_RECEIPT_IRON_LAW_INSTRUCTION.split('\n')).toHaveLength(4);
      expect(TEAM_COLLABORATION_CHARTER_INSTRUCTION).toContain(
        'docs/agent-platform/30-团队协作规约.md',
      );
      expect(AGENT_RECEIPT_IRON_LAW_INSTRUCTION).toContain('- 回执必@派发人：');
    });
  });

  // ------------------------------------------------------------------
  // FR-13 dispatchAgentMention：agent 互 @ 触发（复用 dispatch 全链路）
  // ------------------------------------------------------------------

  describe('dispatchAgentMention：agent 互 @ 触发（按实例定位会话）', () => {
    const mention = {
      taskId: request.taskId,
      channelId: request.channelId,
      text: '@tmm_tester 请查看这个文件',
      targetInstanceId: 'tmm_tester',
    };

    it('目标实例有团队会话 → 构造 DispatchRequest 调 dispatch（agentId 从 session 行取）', async () => {
      (sessionLifecycle as any).ensureTeamSession = jest
        .fn()
        .mockResolvedValue({
          id: 's_tester',
          agentId: 'a_tester',
          reused: true,
        });
      (prisma.task as any).findUnique = jest
        .fn()
        .mockResolvedValue({ teamId: 'tm_0000000001' });
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention(mention);

      // team-only：任务归属 teamId + teamMemberId 经 ensureTeamSession 即建即得复用
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledTimes(
        1,
      );
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_tester',
      );
      expect(idGen.nextId).toHaveBeenCalledWith('m');
      expect(dispatchSpy).toHaveBeenCalledWith({
        messageId: 'm_0000000002',
        channelId: request.channelId,
        taskId: request.taskId,
        teamId: 'tm_0000000001',
        taskContext: { taskId: request.taskId },
        text: mention.text,
        targets: [
          {
            agentId: 'a_tester',
            instanceId: 'tmm_tester',
            sessionId: 's_tester',
          },
        ],
      });
    });

    it('契约：返回被分派会话主键（wake 失败记录关联用；其余调用方忽略）+ 可选 issueId 透传不破坏既有调用', async () => {
      (sessionLifecycle as any).ensureTeamSession = jest
        .fn()
        .mockResolvedValue({
          id: 's_tester',
          agentId: 'a_tester',
          reused: true,
        });
      (prisma.task as any).findUnique = jest
        .fn()
        .mockResolvedValue({ teamId: 'tm_0000000001' });
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });
      const withIssue = { ...mention, issueId: 'is_0000000001' };

      const ret = await d.dispatchAgentMention(withIssue);

      expect(ret).toBe('s_tester');
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
    });

    it('目标实例无团队会话行 → ensureTeamSession 即建后 dispatch（首触可达）', async () => {
      (sessionLifecycle as any).ensureTeamSession = jest
        .fn()
        .mockResolvedValue({
          id: 's_tester_new',
          agentId: 'a_tester',
          reused: false,
        });
      (prisma.task as any).findUnique = jest
        .fn()
        .mockResolvedValue({ teamId: 'tm_0000000001' });
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention(mention);

      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_tester',
      );
      expect(dispatchSpy).toHaveBeenCalledWith({
        messageId: 'm_0000000002',
        channelId: request.channelId,
        taskId: request.taskId,
        teamId: 'tm_0000000001',
        taskContext: { taskId: request.taskId },
        text: mention.text,
        targets: [
          {
            agentId: 'a_tester',
            instanceId: 'tmm_tester',
            sessionId: 's_tester_new',
          },
        ],
      });
      expect(idGen.nextId).toHaveBeenCalledWith('m');
    });

    it('任务无团队归属（teamId 缺失）→ 抛错（不调 dispatch）', async () => {
      (sessionLifecycle as any).ensureTeamSession = jest.fn();
      (prisma.task as any).findUnique = jest
        .fn()
        .mockResolvedValue({ teamId: null });
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await expect(d.dispatchAgentMention(mention)).rejects.toThrow(
        /实例 tmm_tester 无团队会话/,
      );
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(idGen.nextId).not.toHaveBeenCalled();
      expect(
        (sessionLifecycle as any).ensureTeamSession,
      ).not.toHaveBeenCalled();
    });

    it('团队维度（taskId 缺省、teamId 直传）→ 跳过任务查表，ensureTeamSession 即建后 dispatch（taskId 置空、无 taskContext）', async () => {
      (sessionLifecycle as any).ensureTeamSession = jest
        .fn()
        .mockResolvedValue({
          id: 's_dev_new',
          agentId: 'a_developer',
          reused: false,
        });
      (prisma.task as any).findUnique = jest.fn();
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await d.dispatchAgentMention({
        teamId: 'tm_0000000002',
        channelId: request.channelId,
        text: '@tmm_0000000009 请处理',
        targetInstanceId: 'tmm_0000000009',
      });

      expect((prisma.task as any).findUnique).not.toHaveBeenCalled();
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledWith(
        'tm_0000000002',
        'tmm_0000000009',
      );
      expect(dispatchSpy).toHaveBeenCalledWith({
        messageId: 'm_0000000002',
        channelId: request.channelId,
        taskId: '',
        teamId: 'tm_0000000002',
        text: '@tmm_0000000009 请处理',
        targets: [
          {
            agentId: 'a_developer',
            instanceId: 'tmm_0000000009',
            sessionId: 's_dev_new',
          },
        ],
      });
    });

    it('双空（无 taskId 无 teamId）→ 抛错（不调 dispatch）', async () => {
      (sessionLifecycle as any).ensureTeamSession = jest.fn();
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });

      await expect(
        d.dispatchAgentMention({
          channelId: request.channelId,
          text: 'x',
          targetInstanceId: 'tmm_tester',
        } as any),
      ).rejects.toThrow(/无团队会话/);
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(
        (sessionLifecycle as any).ensureTeamSession,
      ).not.toHaveBeenCalled();
    });

    it('dispatch 单目标失败仍返回（emitError 由 dispatch 内部处理，不向上抛）', async () => {
      (sessionLifecycle as any).ensureTeamSession = jest
        .fn()
        .mockResolvedValue({
          id: 's_tester',
          agentId: 'a_tester',
          reused: true,
        });
      (prisma.task as any).findUnique = jest
        .fn()
        .mockResolvedValue({ teamId: 'tm_0000000001' });
      // 真实 dispatch 全链路：目标会话行缺失 → 团队入口严格校验抛错 → dispatch 内
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
        realtime.broadcast.mock.calls.some(
          (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
        ),
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique
        .mockResolvedValueOnce({
          id: 'w_offline',
          status: 'offline',
          capabilities: {},
        })
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
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
        {
          artifactId: 'art_1',
          contentRef: '需求正文 v3',
          authorAgentId: 'a_product',
        },
      ]);
      const d = createDispatcher();

      await d.dispatch(request);

      const promptText = (
        workerClient.execute.mock.calls[0][1] as {
          prompt: Array<{ text: string }>;
        }
      ).prompt[0].text;
      // 不再自动注入 doclib 产出物正文
      expect(promptText).not.toContain('<doclib>');
      expect(promptText).not.toContain('需求正文 v3');
      // 单触发器任务段（任务上下文行 + 当前消息）
      expect(promptText).toContain('【任务上下文】');
      expect(promptText).toContain('vteam_chat_history');
      expect(promptText).toContain(request.text);
    });

    it('任务无产出物：prompt 仅团队上下文行 + request.text（无 doclib 块）', async () => {
      const d = createDispatcher();

      await d.dispatch(request);

      const promptText = (
        workerClient.execute.mock.calls[0][1] as {
          prompt: Array<{ text: string }>;
        }
      ).prompt[0].text;
      expect(promptText).not.toContain('<doclib>');
      expect(promptText).toContain('【任务上下文】');
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

      const ctx = await (
        d as unknown as {
          buildDoclibContext(taskId: string): Promise<string>;
        }
      ).buildDoclibContext(request.taskId);

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
      // Todo7 team-only：回流默认走团队会话归属（单测按需覆盖无团队/多实例变体）
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_product',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
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
          content: {
            text: '已完成',
            parts: [{ type: 'text', text: '已完成' }],
          },
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
      // Todo7：emitFinal taskId 承载 team scope 串（前端 scope 兼容），任务只归因
      expect(finals).toEqual([
        {
          taskId: 'team:tm_0000000001',
          agentId: 'a_product',
          messageId: 'm_0000000002',
          text: '已完成',
        },
      ]);
    });

    it('payload 无 agentId：经 sessionId 反查 Session.agentId 定位发件人', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_architect',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
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

    it('Todo7 同成员多实例按 teamMemberId 精确匹配各自私聊频道（F3 P1 团队语义）', async () => {
      // 开发者-2 团队成员 tmm_dev_2：终态回复必须落开发者-2 私聊频道，不得按 agentId
      // 命中开发者-1 频道（F3 实测串扰缺陷根因，团队语义下按成员定位）
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_developer',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_dev_2',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_dev2',
        type: 'private',
      });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_developer',
        sessionId: 's_dev2',
        text: '开发者-2 总结',
      });

      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_0000000001', teamMemberId: 'tmm_dev_2' },
        select: { id: true, type: true },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dev2',
            senderId: 'a_developer',
            senderInstanceId: 'tmm_dev_2',
          }),
        }),
      );
    });

    it('Todo7 会话无团队归属（存量任务会话）→ 跳过落库并 emitError（不静默丢失）', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_developer',
        teamMemberId: null,
      });
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_legacy',
        type: 'private',
      });
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_developer',
        sessionId: 's_legacy',
        text: '存量任务回复',
      });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
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
        realtime.broadcast.mock.calls.some(
          (c) => c[0] === EVENT_TYPES.ARTIFACT_SUBMITTED,
        ),
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

    it('频道定位：成员私聊频道（teamId+teamMemberId）优先，群聊频道回退', async () => {
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_dm' });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '私聊回复',
      });

      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_0000000001', teamMemberId: 'tmm_0000000001' },
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

    it('payload 无 sessionId（dispatcher 内部回流）→ 团队会话直查 DM 落库（任务只归因）', async () => {
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.teamMemberId)
          return Promise.resolve({ id: 'c_dm', type: 'private' });
        return Promise.resolve(null);
      });
      const d = createDispatcher();

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
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
        content: {
          text: '部分',
          parts: [{ type: 'text', text: '部分', synthetic: false }],
        },
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
        data: expect.objectContaining({
          content: { text: '最终', parts: [{ type: 'text', text: '最终' }] },
          status: MESSAGE_STATUS.sent,
        }),
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
          taskId: 'team:tm_0000000001',
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
          {
            type: 'tool',
            name: 'read',
            input: 'x',
            output: 'y',
            synthetic: true,
          },
        ],
      });

      // 群聊只收 ACK + MCP group_post 工具直发：无 private 频道回退群聊时
      // groupFallback 跳过正文落库（仅幂等标记 + emitFinal）
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(finals).toHaveLength(1);
    });

    it('F3 缺陷①：team_group 终态化（groupFallback）→ 全文含 reasoning 不漏进群聊', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue(null);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: request.channelId,
        type: CHANNEL_TYPE.team_group,
      });
      prisma.message.create.mockResolvedValue(messageRow());
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '让我先查一下成员是否有模型配置',
        parts: [
          { type: 'text', text: '让我先查一下成员是否有模型配置' },
          { type: 'reasoning', text: '内心独白', synthetic: true },
          {
            type: 'tool',
            name: 'read',
            input: 'x',
            output: 'y',
            synthetic: true,
          },
        ],
      });

      // 一团队一群复用下 resolveChannel 回退 team_group：与 task_group 同语义，
      // 正文独白不落群聊（结论经 group_post 工具直发），仅幂等标记 + emitFinal
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
          {
            type: 'tool',
            name: 'read',
            input: 'x',
            output: 'y',
            synthetic: true,
          },
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
              {
                type: 'tool',
                name: 'read',
                input: 'x',
                output: 'y',
                synthetic: true,
              },
            ],
          },
        }),
      });
    });
  });

  // ------------------------------------------------------------------
  // handleAgentStatus：agent.loading / agent.error 本地回调映射
  // ------------------------------------------------------------------

  describe('handleAgentStatus 团队归一（Todo10：fail/resolve 全走 resolveTeamChannel）', () => {
    const teamSession = {
      id: 's_0000000001',
      teamId: 'tm_0000000001',
      teamMemberId: 'tmm_0000000001',
      agentId: 'a_product',
    };
    const SCOPE = 'team:tm_0000000001';

    it('phase=thinking（有 session，经会话反查团队维度）→ emitLoading 走团队 scope', async () => {
      prisma.session.findUnique.mockResolvedValue(teamSession);
      const d = createDispatcher();
      const loading: unknown[] = [];
      d.onLoading((e) => loading.push(e));

      await d.handleAgentStatus({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        phase: 'thinking',
      });

      expect(prisma.session.findUnique).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        select: { teamId: true, teamMemberId: true, agentId: true },
      });
      expect(loading).toEqual([
        {
          taskId: SCOPE,
          agentId: 'a_product',
          sessionId: 's_0000000001',
          phase: 'thinking',
        },
      ]);
      // 不重复广播（防双写，T9 已 emit SSE）
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('phase=operating（无 session，经任务归属 teamId + 成员定位）→ emitLoading 团队 scope', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      (prisma as any).teamMember.findFirst.mockResolvedValue({
        id: 'tmm_0000000001',
      });
      const d = createDispatcher();
      const loading: unknown[] = [];
      d.onLoading((e) => loading.push(e));

      await d.handleAgentStatus({
        taskId: request.taskId,
        agentId: 'a_product',
        phase: 'operating',
      });

      expect(loading).toEqual([
        {
          taskId: SCOPE,
          agentId: 'a_product',
          sessionId: null,
          phase: 'operating',
        },
      ]);
    });

    it('status=error / 带 error（无 session）→ emitError 走团队 scope', async () => {
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      (prisma as any).teamMember.findFirst.mockResolvedValue({
        id: 'tmm_0000000001',
      });
      prisma.chatChannel.findFirst.mockResolvedValue(null);
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
          taskId: SCOPE,
          agentId: 'a_product',
          error: 'worker 无响应',
        },
      ]);
    });

    it('Todo10 happy：error 回流 → 团队频道 processing 消息标记 failed + 错误内容广播', async () => {
      prisma.session.findUnique.mockResolvedValue(teamSession);
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if (where?.teamId === 'tm_0000000001' && where?.teamMemberId) {
          return Promise.resolve({ id: 'c_team_dm', type: 'private' });
        }
        return Promise.resolve(null);
      });
      prisma.message.findFirst.mockResolvedValue({
        id: 'm_proc',
        channelId: 'c_team_dm',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_product',
        content: { text: '旧流式内容', parts: [] },
        status: MESSAGE_STATUS.processing,
      });
      const updatedRow = {
        id: 'm_proc',
        channelId: 'c_team_dm',
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
        channelId: 'c_team_dm',
        status: 'error',
        error: '执行失败：worker 无响应',
      });

      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'm_proc' },
        data: expect.objectContaining({
          content: { text: '执行失败：worker 无响应', parts: [] },
          status: MESSAGE_STATUS.failed,
        }),
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        {
          message: expect.objectContaining({
            id: 'm_proc',
            status: MESSAGE_STATUS.failed,
          }),
        },
        { type: 'channel', id: 'c_team_dm' },
      );
      expect(errors).toEqual([
        {
          taskId: SCOPE,
          agentId: 'a_product',
          error: '执行失败：worker 无响应',
        },
      ]);
    });

    it('Todo10 happy：error 回流且无 processing 消息 → 新建 failed 消息（含 senderInstanceId=tmm）', async () => {
      prisma.session.findUnique.mockResolvedValue(teamSession);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_team_dm',
        type: 'private',
      });
      // findFirst 默认 null（无 processing 消息）
      const createdRow = {
        id: 'm_new_fail',
        channelId: 'c_team_dm',
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
        sessionId: 's_0000000001',
        channelId: 'c_team_dm',
        status: 'error',
      });

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          channelId: 'c_team_dm',
          senderId: 'a_product',
          senderInstanceId: 'tmm_0000000001',
          status: MESSAGE_STATUS.failed,
          content: { text: 'agent 处理失败', parts: [] },
        }),
      });
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        { message: expect.objectContaining({ id: 'm_new_fail' }) },
        { type: 'channel', id: 'c_team_dm' },
      );
    });

    it('Todo10 failure：未知 channel → 跳过落库不抛错（失败回调仍通知）', async () => {
      prisma.session.findUnique.mockResolvedValue(teamSession);
      prisma.chatChannel.findFirst.mockResolvedValue(null);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await expect(
        d.handleAgentStatus({
          taskId: request.taskId,
          agentId: 'a_product',
          sessionId: 's_0000000001',
          status: 'error',
          error: '执行失败',
        }),
      ).resolves.toBeUndefined();

      expect(prisma.message.findFirst).not.toHaveBeenCalled();
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(errors).toEqual([
        { taskId: SCOPE, agentId: 'a_product', error: '执行失败' },
      ]);
    });

    it('缺维度：无 session 无 task → 忽略', async () => {
      const d = createDispatcher();
      const loading: unknown[] = [];
      const errors: unknown[] = [];
      d.onLoading((e) => loading.push(e)).onError((e) => errors.push(e));

      await d.handleAgentStatus({ phase: 'thinking' });

      expect(loading).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it('会话无团队维度 → 忽略（不落库不回调）', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        teamId: null,
        teamMemberId: null,
        agentId: 'a_product',
      });
      const d = createDispatcher();
      const loading: unknown[] = [];
      const errors: unknown[] = [];
      d.onLoading((e) => loading.push(e)).onError((e) => errors.push(e));

      await d.handleAgentStatus({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        status: 'error',
        error: '执行失败',
      });

      expect(loading).toHaveLength(0);
      expect(errors).toHaveLength(0);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // 判死 watchdog（事件静默 600s 滑动自愈 + 空闲判死）
  // ------------------------------------------------------------------

  describe('判死 watchdog（事件静默 600s + 空闲判死 30min）', () => {
    const dispatchSetup = () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
    };

    it('dispatch 后静默 4×600s（3 次唤醒耗尽）→ emitError「无响应（心跳正常）」+ 广播 agent.error（silent_session_timeout）', async () => {
      jest.useFakeTimers();
      dispatchSetup();
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        status: 'in_progress',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);

      await d.dispatch(request);
      expect(errors).toHaveLength(0);

      // 每个 600s 静默窗口到期即唤醒一次并重武装；3 次唤醒后第 4 个窗口到期才走失败路径
      for (
        let attempt = 0;
        attempt < MAX_SILENT_WAKE_ATTEMPTS;
        attempt++
      ) {
        await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS);
        await jest.advanceTimersByTimeAsync(0);
        expect(wakeSpy).toHaveBeenCalledTimes(attempt + 1);
        expect(errors).toHaveLength(0);
      }
      await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS);
      await jest.advanceTimersByTimeAsync(0);

      expect(errors).toEqual([
        {
          taskId: 'team:tm_0000000001',
          agentId: 'a_product',
          error: expect.stringMatching(/无响应/),
        },
      ]);
      // 耗尽文案声明唤醒次数
      expect(errors[0]).toEqual(
        expect.objectContaining({
          error: expect.stringMatching(
            new RegExp(`${MAX_SILENT_WAKE_ATTEMPTS} 次自动唤醒`),
          ),
        }),
      );
      expect(wakeSpy).toHaveBeenCalledTimes(MAX_SILENT_WAKE_ATTEMPTS);
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({
          level: 'retry',
          errorType: 'silent_session_timeout',
        }),
      );
      jest.useRealTimers();
    });

    it('唤醒重试后活动到达：滑动重武装保留 pending + 计数不清（完成/判败才清零）', async () => {
      jest.useFakeTimers();
      dispatchSetup();
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        status: 'in_progress',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);

      await d.dispatch(request);
      await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(wakeSpy).toHaveBeenCalledTimes(1);
      expect((d as any).silentWakeAttempts.get('s_0000000001')).toBe(1);

      // 活动到达：取消 pending 重试并复零
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({
        type: 'session.updated',
        sessionId: 's_0000000001',
        status: 'running',
      });
      // 滑动语义：事件重武装（不清 pending），唤醒计数保留（清零仅在完成/判败/换会话）
      expect((d as any).isSessionPending('s_0000000001')).toBe(true);
      expect((d as any).silentWakeAttempts.get('s_0000000001')).toBe(1);

      // 再次静默：窗口自事件重算，到期续第 2 次唤醒（计数续算），全程无失败报错
      await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(wakeSpy).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(0);
      jest.useRealTimers();
    });

    it('窗口内收到 session.updated(running) → 滑动重武装，不再 emitError', async () => {
      jest.useFakeTimers();
      dispatchSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request); // 启动静默 watchdog
      // ingress 活动回调：session.updated(running) 到达（模型已开始产出）
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({
        type: 'session.updated',
        sessionId: 's_0000000001',
        status: 'running',
      });
      // 滑动语义：事件重武装窗口；到期只会唤醒（1 次 < 上限），不 emitError
      await jest.advanceTimersByTimeAsync(
        DEFAULT_SILENT_SESSION_WAKE_MS + 1000,
      );
      await jest.advanceTimersByTimeAsync(0);

      expect(errors).toHaveLength(0);
      jest.useRealTimers();
    });

    it('回流成功（task.completed）：终态清除静默 watchdog，不再 emitError', async () => {
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
        sessionId: 's_0000000001',
        text: '已完成',
      });
      // ingress 在 task.completed 时双通知：sessionActivity（带归一 sessionId）→
      // 按会话清除首字 watchdog；(taskId,agentId) 键清除的团队统一归 Todo 3
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({ type: 'task.completed', sessionId: 's_0000000001' });
      await jest.advanceTimersByTimeAsync(
        DEFAULT_SILENT_SESSION_WAKE_MS + 1000,
      );

      expect(errors).toHaveLength(0);
      jest.useRealTimers();
    });

    it('running 后空闲 30min（无 delta）→ 判死：session failed + agent.error', async () => {
      jest.useFakeTimers();
      // dispatch 的会话查询（workerId/instanceRef + 团队归属校验）
      prisma.session.findUnique
        .mockResolvedValueOnce({
          id: 's_0000000001',
          workerId: 'w_0000000001',
          instanceRef: 'ses_0001',
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
        })
        // 空闲判死扫描的状态查询（running，团队维度）
        .mockResolvedValue({
          id: 's_0000000001',
          status: 'running',
          taskId: request.taskId,
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
          agentId: 'a_product',
        });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      // 首个事件：session.updated(running) 清除首字 watchdog，进入空闲判死追踪
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({
        type: 'session.updated',
        sessionId: 's_0000000001',
        status: 'running',
      });
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
          // Todo10：空闲判死统一走团队 scope
          taskId: 'team:tm_0000000001',
          agentId: 'a_product',
          error: expect.stringMatching(/已判死/),
        },
      ]);
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({
          level: 'retry',
          errorType: 'agent_idle_timeout',
        }),
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
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
        })
        .mockResolvedValue({
          id: 's_0000000001',
          status: 'running',
          taskId: request.taskId,
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
          agentId: 'a_product',
        });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.dispatch(request);
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({
        type: 'session.updated',
        sessionId: 's_0000000001',
        status: 'running',
      });

      // 推进接近 idle 超时（未到）
      await jest.advanceTimersByTimeAsync(DEFAULT_AGENT_IDLE_TIMEOUT_MS - 5000);
      // 中途 delta 到达 → 刷新 lastActivityAt（有活动不误杀）
      activityCb({ type: 'message.part.delta', sessionId: 's_0000000001' });
      // 再推进一个扫描周期（此时距 delta 仅 65s，远未到 30min）
      await jest.advanceTimersByTimeAsync(IDLE_SCAN_INTERVAL_MS + 5000);
      await jest.advanceTimersByTimeAsync(0);

      // todo-7 双写：activity 刷新会 update(lastActivityAt)，此处只断言无判死标记
      const failedMarks = prisma.session.update.mock.calls.filter(
        (c: unknown[]) =>
          (c[0] as { data?: { status?: string } })?.data?.status === 'failed',
      );
      expect(failedMarks).toHaveLength(0);
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
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        status: 'in_progress',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      jest.spyOn(d as any, 'tryAutoRestart').mockResolvedValue(undefined);

      await d.dispatch(request);
      // 3 次唤醒窗口 + 1 个耗尽窗口（每窗 600s）
      await jest.advanceTimersByTimeAsync(
        DEFAULT_SILENT_SESSION_WAKE_MS * (MAX_SILENT_WAKE_ATTEMPTS + 1),
      );
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
  // 事件静默自愈（SILENT_SESSION_WAKE_MS 滑动窗口 ×3 + 心跳快速失败）
  // 三路径：worker 首字 300s · server 静默 600s 滑动 ×3 · 心跳 10s/30s
  // ------------------------------------------------------------------

  describe('事件静默自愈 SILENT_SESSION_WAKE_MS（滑动窗口 + 心跳快速失败）', () => {
    const silenceSetup = () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'online',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
    };

    it('默认值锁定：窗口 600000 > worker 首字 300000（不抢跑）且唤醒上限 3', () => {
      expect(DEFAULT_SILENT_SESSION_WAKE_MS).toBe(600_000);
      expect(DEFAULT_SILENT_SESSION_WAKE_MS).toBeGreaterThan(300_000);
      expect(MAX_SILENT_WAKE_ATTEMPTS).toBe(3);
    });

    it('窗口未满不唤醒：推进 DEFAULT_SILENT_SESSION_WAKE_MS - 1 → 0 次 wake、pending 保持', async () => {
      jest.useFakeTimers();
      silenceSetup();
      const d = createDispatcher();
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);
      await d.dispatch(request);
      await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS - 1);
      await jest.advanceTimersByTimeAsync(0);
      expect(wakeSpy).not.toHaveBeenCalled();
      expect(d.isSessionPending('s_0000000001')).toBe(true);
      jest.useRealTimers();
    });

    it('滑动窗口：事件在 T 重武装 → 直到 T + 600s 才唤醒（事件前已流逝时间不计入）', async () => {
      jest.useFakeTimers();
      silenceSetup();
      const d = createDispatcher();
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);
      await d.dispatch(request);
      // 消耗掉原窗口一半，然后事件到达（滑动重武装 → 计时从事件重新起算）
      await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS / 2);
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({ type: 'message.part.delta', sessionId: 's_0000000001' });
      // 已越过原 dispatch 窗口（t0+600s），但距事件仅 599.999s → 滑动后仍未满窗
      await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS - 1);
      await jest.advanceTimersByTimeAsync(0);
      expect(wakeSpy).not.toHaveBeenCalled();
      // 事件后满 600s → 恰唤醒一次
      await jest.advanceTimersByTimeAsync(2);
      await jest.advanceTimersByTimeAsync(0);
      expect(wakeSpy).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('3 次唤醒耗尽 → 新失败文案（600s 无事件回流 + worker 心跳正常 + 已尝试 3 次）+ silent_session_timeout', async () => {
      jest.useFakeTimers();
      silenceSetup();
      prisma.task.findUnique.mockResolvedValue({
        id: request.taskId,
        status: 'in_progress',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);
      await d.dispatch(request);
      for (let i = 0; i < MAX_SILENT_WAKE_ATTEMPTS + 1; i++) {
        await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS);
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(wakeSpy).toHaveBeenCalledTimes(MAX_SILENT_WAKE_ATTEMPTS);
      expect(errors).toHaveLength(1);
      expect((errors[0] as { error: string }).error).toMatch(
        /无响应（600s 无事件回流，worker 心跳正常），已尝试 3 次自动唤醒仍未恢复/,
      );
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({ errorType: 'silent_session_timeout' }),
      );
      jest.useRealTimers();
    });

    it('worker 心跳已离线 → 到期立即失败，tryAutoRestart 不被调用', async () => {
      jest.useFakeTimers();
      silenceSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);
      await d.dispatch(request);
      // 到期前心跳判定 offline（HealthChecker 30s 语义下的状态翻转）
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'offline',
      });
      await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS);
      await jest.advanceTimersByTimeAsync(0);
      expect(wakeSpy).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect((errors[0] as { error: string }).error).toMatch(/心跳已离线/);
      expect((d as any).failedSessions.has('s_0000000001')).toBe(true);
      expect((d as any).isSessionPending('s_0000000001')).toBe(false);
      jest.useRealTimers();
    });

    it('不抢跑 worker 300s 首字窗口：推进 300000ms 时 server 零动作，满 600000ms 才唤醒', async () => {
      jest.useFakeTimers();
      silenceSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);
      await d.dispatch(request);
      await jest.advanceTimersByTimeAsync(300_000); // worker 自有首字窗口长度
      await jest.advanceTimersByTimeAsync(0);
      expect(wakeSpy).not.toHaveBeenCalled();
      expect(errors).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(
        DEFAULT_SILENT_SESSION_WAKE_MS - 300_000,
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(wakeSpy).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('grep 锁：src 内旧首字 watchdog 符号零命中（拼接构造 pattern，避免自匹配）', () => {
      // 拼接字符串使本文件源码不含连续旧符号（否则锁扫描命中自身）
      const patterns = [
        new RegExp('(?<!WORKER_)' + 'FIRST_TOKEN' + '_TIMEOUT_MS'),
        new RegExp('DEFAULT_' + 'FIRST_TOKEN' + '_TIMEOUT_MS'),
        new RegExp('MAX_FIRST_' + 'TOKEN_WAKE_ATTEMPTS'),
      ];
      const srcRoot = path.resolve(__dirname, '..'); // server/src
      const hits: string[] = [];
      const walk = (dir: string): void => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          if (fs.statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          if (!full.endsWith('.ts')) continue;
          const text = fs.readFileSync(full, 'utf8');
          for (const p of patterns) {
            const matches = text.match(new RegExp(p.source, 'g'));
            if (matches) {
              hits.push(`${path.relative(srcRoot, full)} × ${matches.length} (${p})`);
            }
          }
        }
      };
      walk(srcRoot);
      expect(hits).toEqual([]);
    });
  });

  describe('空闲判死 abort-before-restart（stop-first 恢复链）', () => {
    const idleDeadRow = (overrides: Record<string, unknown> = {}) => ({
      status: 'running',
      taskId: request.taskId,
      teamId: 'tm_0000000001',
      teamMemberId: 'tmm_0000000001',
      agentId: 'a_product',
      workerId: 'w_0000000001',
      instanceRef: 'ses_0001',
      ...overrides,
    });
    const idleDeadSetup = () => {
      prisma.session.findUnique.mockResolvedValue(idleDeadRow());
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: { baseUrl: 'http://w1:8080' },
      });
    };

    it('plain idle 分支：先 abort（ref+ses_ id）再自动拉起，failed 标记不变', async () => {
      idleDeadSetup();
      workerClient.getMessages.mockResolvedValue([]);
      const d = createDispatcher();
      const restartSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);

      await (d as any).markSessionIdleDead('s_0000000001');

      expect(workerClient.abort).toHaveBeenCalledWith(
        { id: 'w_0000000001', capabilities: { baseUrl: 'http://w1:8080' } },
        'ses_0001',
      );
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: { status: 'failed' },
      });
      expect(restartSpy).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000001',
        request.taskId,
      );
      expect(workerClient.abort.mock.invocationCallOrder[0]).toBeLessThan(
        restartSpy.mock.invocationCallOrder[0],
      );
    });

    it('abort 失败（reject）：仅记 warn，failed 标记 + 广播 + 自动拉起照常', async () => {
      idleDeadSetup();
      workerClient.getMessages.mockResolvedValue([]);
      workerClient.abort.mockRejectedValueOnce(new Error('worker down'));
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      const restartSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);

      await (d as any).markSessionIdleDead('s_0000000001');

      expect(workerClient.abort).toHaveBeenCalledTimes(1);
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: { status: 'failed' },
      });
      expect(errors).toEqual([
        expect.objectContaining({ error: expect.stringMatching(/已判死/) }),
      ]);
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({ errorType: 'agent_idle_timeout' }),
      );
      expect(restartSpy).toHaveBeenCalledTimes(1);
    });

    it('无 workerId/instanceRef：跳过 abort（含 capabilities 查询），自动拉起照常', async () => {
      prisma.session.findUnique.mockResolvedValue(
        idleDeadRow({ workerId: null, instanceRef: null }),
      );
      workerClient.getMessages.mockResolvedValue([]);
      const d = createDispatcher();
      const restartSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);

      await (d as any).markSessionIdleDead('s_0000000001');

      expect(workerClient.abort).not.toHaveBeenCalled();
      expect(prisma.worker.findUnique).not.toHaveBeenCalled();
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: { status: 'failed' },
      });
      expect(restartSpy).toHaveBeenCalledTimes(1);
    });

    it('quota 分支：中止 stuck 运行但不自动拉起，广播 quota_exceeded', async () => {
      idleDeadSetup();
      workerClient.getMessages.mockResolvedValue([
        {
          info: { role: 'assistant' },
          parts: [
            {
              type: 'step-finish',
              reason: 'error',
              error: { message: 'insufficient quota, billing required' },
            },
          ],
        },
      ]);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      const restartSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);

      await (d as any).markSessionIdleDead('s_0000000001');

      expect(workerClient.abort).toHaveBeenCalledWith(
        { id: 'w_0000000001', capabilities: { baseUrl: 'http://w1:8080' } },
        'ses_0001',
      );
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: { status: 'failed' },
      });
      expect(errors).toEqual([
        expect.objectContaining({ error: expect.stringMatching(/额度不足/) }),
      ]);
      const agentError = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.AGENT_ERROR,
      );
      expect(agentError?.[1]).toEqual(
        expect.objectContaining({ errorType: 'quota_exceeded' }),
      );
      expect(restartSpy).not.toHaveBeenCalled();
    });
  });

  describe('todo-7 双写 + DB 侧空闲检出（重启安全）', () => {
    const staleRow = (overrides: Record<string, unknown> = {}) => ({
      status: 'running',
      taskId: null,
      teamId: null,
      teamMemberId: null,
      agentId: 'a_product',
      workerId: null,
      instanceRef: null,
      ...overrides,
    });

    it('activity 刷新双写 DB：handleSessionActivity → update(lastActivityAt)', async () => {
      const d = createDispatcher();
      const activityCb = ingress.onSessionActivity.mock.calls[0][0];
      activityCb({ type: 'message.part.delta', sessionId: 's_0000000001' });

      await new Promise((r) => setTimeout(r, 0));
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: { lastActivityAt: expect.any(Date) },
      });
      expect(d.getLastActivityAt('s_0000000001')).toBeDefined();
    });

    it('watchdog 起点双写 DB：startPendingWatchdog → update(lastActivityAt)', async () => {
      const d = createDispatcher();

      (d as any).startPendingWatchdog(
        'team:tm_0000000001',
        'a_product',
        's_0000000001',
        'w_0000000001',
        'tmm_0000000001',
      );

      await new Promise((r) => setTimeout(r, 0));
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_0000000001' },
        data: { lastActivityAt: expect.any(Date) },
      });
      expect(d.getLastActivityAt('s_0000000001')).toBeDefined();
    });

    it('DB 侧检出：内存 map 为空（重启后）但 DB 有 stale running → 判死', async () => {
      const d = createDispatcher();
      expect(d.getLastActivityAt('s_stale_1')).toBeUndefined();
      prisma.session.findMany.mockResolvedValue([{ id: 's_stale_1' }]);
      prisma.session.findUnique.mockResolvedValue(staleRow());
      workerClient.getMessages.mockResolvedValue([]);

      await (d as any).scanIdleSessions();

      expect(prisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'running',
            lastActivityAt: { lt: expect.any(Date) },
          },
        }),
      );
      expect(prisma.session.update).toHaveBeenCalledWith({
        where: { id: 's_stale_1' },
        data: { status: 'failed' },
      });
    });

    it('DB 侧检出 + 首事件等待否决：pending 且 activitySeen=false 的会话不判死', async () => {
      const d = createDispatcher();
      (d as any).startPendingWatchdog(
        'team:tm_0000000001',
        'a_product',
        's_0000000001',
        'w_0000000001',
        'tmm_0000000001',
      );
      expect(d.isSessionPending('s_0000000001')).toBe(true);
      prisma.session.findMany.mockResolvedValue([{ id: 's_0000000001' }]);

      await (d as any).scanIdleSessions();

      const failedMarks = prisma.session.update.mock.calls.filter(
        (c: unknown[]) =>
          (c[0] as { data?: { status?: string } })?.data?.status === 'failed',
      );
      expect(failedMarks).toHaveLength(0);
    });

    it('activeExecutions 否决：轮中成员的 stale 会话跳过判死', async () => {
      const d = createDispatcher();
      (d as any).registerExecution('w_1', 'team:tm_1', 'tmm_1');
      prisma.session.findUnique.mockResolvedValue(
        staleRow({ workerId: 'w_1', teamId: 'tm_1', teamMemberId: 'tmm_1' }),
      );

      await (d as any).markSessionIdleDead('s_veto_1');

      expect(prisma.session.update).not.toHaveBeenCalledWith({
        where: { id: 's_veto_1' },
        data: { status: 'failed' },
      });
    });

    it('DB 检出 fail-open：findMany 抛错 → 扫描不抛，内存侧照常', async () => {
      const d = createDispatcher();
      prisma.session.findMany.mockRejectedValueOnce(new Error('db down'));

      await expect((d as any).scanIdleSessions()).resolves.toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // trigger-unification todo-9：首字 deadline durable 化（TriggerService 侧车）
  // ------------------------------------------------------------------

  describe('todo-9：首字 deadline durable 行', () => {
    const makeTriggers = () => ({
      registerHandler: jest.fn(),
      schedule: jest.fn().mockResolvedValue({ id: 'tmr_0000000001' }),
      cancel: jest.fn().mockResolvedValue({ id: 'tmr_0000000001' }),
    });
    const createDispatcherWithTriggers = (triggers: unknown) =>
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
        undefined as any,
        triggers as any,
      );
    const startWatchdog = (d: any) =>
      (d as any).startPendingWatchdog(
        'team:tm_0000000001',
        'a_product',
        's_0000000001',
        'w_0000000001',
        'tmm_0000000001',
      );
    const fireCtx = (payload: unknown) => ({
      id: 'tmr_0000000001',
      kind: TRIGGER_KIND.SESSION_IDLE_SCAN,
      payload,
    });

    it('构造即注册 SESSION_IDLE_SCAN handler（TriggerService 缺席时不抛）', () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      expect(d).toBeDefined();
      expect(triggers.registerHandler).toHaveBeenCalledWith(
        TRIGGER_KIND.SESSION_IDLE_SCAN,
        expect.any(Function),
      );
      // 旧装配（无 triggers）构造不抛，内存 watchdog 照常
      expect(() => createDispatcher()).not.toThrow();
    });

    it('watchdog 注册即落 durable 行（kind 复用 session_idle_scan，due=注册+静默窗口）', async () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      const before = Date.now();
      startWatchdog(d);
      await new Promise((r) => setTimeout(r, 0));
      expect(triggers.schedule).toHaveBeenCalledTimes(1);
      const [kind, dueAt, payload, dedupKey] = triggers.schedule.mock.calls[0];
      expect(kind).toBe(TRIGGER_KIND.SESSION_IDLE_SCAN);
      expect((dueAt as Date).getTime()).toBeGreaterThanOrEqual(
        before + (d as any).silentSessionWakeMs,
      );
      expect(payload).toMatchObject({
        reason: 'silent-session',
        dueAt: expect.any(Number),
        sessionId: 's_0000000001',
        workerId: 'w_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      expect(typeof dedupKey).toBe('string');
      // veto 语义不变：pendingBySession 仍命中
      expect((d as any).isSessionPending('s_0000000001')).toBe(true);
    });

    it('终态清除内存 timer 的同时取消 durable 行（防误收割）', async () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      startWatchdog(d);
      await new Promise((r) => setTimeout(r, 0));
      const dedupKey = triggers.schedule.mock.calls[0][3];
      (d as any).clearPendingWatchdogBySession('s_0000000001');
      await new Promise((r) => setTimeout(r, 0));
      expect(triggers.cancel).toHaveBeenCalledWith(dedupKey);
      expect((d as any).isSessionPending('s_0000000001')).toBe(false);
    });

    it('同键重注册取消旧 durable 行（防旧行误收割新一轮）', async () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      startWatchdog(d);
      await new Promise((r) => setTimeout(r, 0));
      const firstKey = triggers.schedule.mock.calls[0][3];
      startWatchdog(d);
      await new Promise((r) => setTimeout(r, 0));
      expect(triggers.cancel).toHaveBeenCalledWith(firstKey);
      expect(triggers.schedule).toHaveBeenCalledTimes(2);
      expect(triggers.schedule.mock.calls[1][3]).not.toBe(firstKey);
    });

    it('handler：本进程窗口到期（worker 在线）→ 复刻 deadline 行为（唤醒 + 重武装，未耗尽不失败）', async () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'online',
      });
      prisma.session.findUnique.mockResolvedValue({
        taskId: request.taskId,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      startWatchdog(d);
      await new Promise((r) => setTimeout(r, 0));
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);
      const handler = triggers.registerHandler.mock.calls[0][1];
      // 用实际落库的 payload（dispatchedAt 与内存条目同世代）触发 firing
      const payload = triggers.schedule.mock.calls[0][2];
      const out = await handler(fireCtx(payload));
      expect(out).toEqual({ done: true });
      // 第 1 次静默：唤醒 + 重武装（仍未失败、仍等待首字）
      expect(wakeSpy).toHaveBeenCalledTimes(1);
      await new Promise((r) => setTimeout(r, 0));
      expect((d as any).failedSessions.has('s_0000000001')).toBe(false);
      expect((d as any).isSessionPending('s_0000000001')).toBe(true);
      // 重武装落新 durable 行（新 dedupKey）
      expect(triggers.schedule).toHaveBeenCalledTimes(2);
      expect(triggers.schedule.mock.calls[1][3]).not.toBe(
        triggers.schedule.mock.calls[0][3],
      );
      expect(
        (d as any).silentWakeAttempts.get('s_0000000001'),
      ).toBe(1);
    });

    it('handler：唤醒耗尽（第 4 次到期，worker 在线）→ 失败路径（failed 标记 + 注销 + 广播）', async () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'online',
      });
      prisma.session.findUnique.mockResolvedValue({
        taskId: request.taskId,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      startWatchdog(d);
      await new Promise((r) => setTimeout(r, 0));
      jest.spyOn(d as any, 'tryAutoRestart').mockResolvedValue(undefined);
      (d as any).silentWakeAttempts.set(
        's_0000000001',
        MAX_SILENT_WAKE_ATTEMPTS,
      );
      const handler = triggers.registerHandler.mock.calls[0][1];
      const payload = triggers.schedule.mock.calls[0][2];
      const out = await handler(fireCtx(payload));
      expect(out).toEqual({ done: true });
      expect((d as any).failedSessions.has('s_0000000001')).toBe(true);
      expect((d as any).isSessionPending('s_0000000001')).toBe(false);
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_ERROR,
        expect.objectContaining({ errorType: 'silent_session_timeout' }),
        expect.anything(),
      );
    });

    it('handler：重启后内存全空 + DB 行超窗（>600s 无活动）→ 照样唤醒重试（未耗尽不失败）', async () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      const handler = triggers.registerHandler.mock.calls[0][1];
      const dispatchedAt = Date.now() - DEFAULT_SILENT_SESSION_WAKE_MS - 1_000;
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'online',
      });
      prisma.session.findUnique.mockResolvedValue({
        status: 'running',
        lastActivityAt: new Date(dispatchedAt),
      });
      // 重启后内存全空：唤醒目标解析按会话归属
      prisma.session.findUnique
        .mockResolvedValueOnce({
          status: 'running',
          lastActivityAt: new Date(dispatchedAt),
        })
        .mockResolvedValue({
          taskId: request.taskId,
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
        });
      const wakeSpy = jest
        .spyOn(d as any, 'tryAutoRestart')
        .mockResolvedValue(undefined);
      const out = await handler(
        fireCtx({
          reason: 'silent-session',
          scope: 'team:tm_0000000001',
          agentId: 'a_product',
          sessionId: 's_restart_1',
          workerId: 'w_0000000001',
          teamMemberId: 'tmm_0000000001',
          dispatchedAt,
        }),
      );
      expect(out).toEqual({ done: true });
      expect(prisma.session.findUnique).toHaveBeenCalledWith({
        where: { id: 's_restart_1' },
        select: { status: true, lastActivityAt: true },
      });
      // 静默窗口 #1：唤醒重试 + 重武装，尚未失败
      expect(wakeSpy).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000001',
        request.taskId,
      );
      expect((d as any).failedSessions.has('s_restart_1')).toBe(false);
      // 重武装后再次命中该会话的 durable 行 → 累计到上限时失败
      (d as any).silentWakeAttempts.set(
        's_restart_1',
        MAX_SILENT_WAKE_ATTEMPTS,
      );
      await new Promise((r) => setTimeout(r, 0));
      const rearmedPayload = triggers.schedule.mock.calls[0][2];
      await handler(fireCtx(rearmedPayload));
      expect((d as any).failedSessions.has('s_restart_1')).toBe(true);
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.AGENT_ERROR,
        expect.objectContaining({ errorType: 'silent_session_timeout' }),
        expect.anything(),
      );
    });

    it('handler：重启后事件在窗口内（lastActivityAt 新于 dispatchedAt 且未超窗）→ 顺延不误杀', async () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      const handler = triggers.registerHandler.mock.calls[0][1];
      const dispatchedAt = Date.now() - 61_000;
      prisma.session.findUnique.mockResolvedValue({
        status: 'running',
        lastActivityAt: new Date(dispatchedAt + 5_000),
      });
      const out = await handler(
        fireCtx({
          reason: 'silent-session',
          scope: 'team:tm_0000000001',
          agentId: 'a_product',
          sessionId: 's_arrived_1',
          workerId: 'w_0000000001',
          teamMemberId: 'tmm_0000000001',
          dispatchedAt,
        }),
      );
      expect(out).toEqual({ done: true });
      expect((d as any).failedSessions.has('s_arrived_1')).toBe(false);
      expect(realtime.broadcast).not.toHaveBeenCalled();
    });

    it('handler：非静默载荷（同 kind 它用）→ no-op；DB 异常 fail-open 不收割', async () => {
      const triggers = makeTriggers();
      const d = createDispatcherWithTriggers(triggers);
      const handler = triggers.registerHandler.mock.calls[0][1];
      await expect(handler(fireCtx({ reason: 'idle-scan' }))).resolves.toEqual({
        done: true,
      });
      expect(prisma.session.findUnique).not.toHaveBeenCalled();
      prisma.session.findUnique.mockRejectedValueOnce(new Error('db down'));
      await expect(
        handler(
          fireCtx({
            reason: 'silent-session',
            scope: 'team:tm_0000000001',
            agentId: 'a_product',
            sessionId: 's_dbdown_1',
            workerId: 'w_0000000001',
            teamMemberId: 'tmm_0000000001',
            dispatchedAt: Date.now() - 61_000,
          }),
        ),
      ).resolves.toEqual({ done: true });
      expect((d as any).failedSessions.has('s_dbdown_1')).toBe(false);
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
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
          taskId: 'team:tm_0000000001',
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
            parts: [
              { type: 'step-finish', reason: 'stop', tokens: {}, cost: 0 },
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

    it('静默超窗无 step-finish：静默 watchdog emitError；迟到回流跳过落库', async () => {
      jest.useFakeTimers();
      pollSetup();
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      jest.spyOn(d as any, 'tryAutoRestart').mockResolvedValue(undefined);

      await d.dispatch(request);
      // 3 次唤醒窗口 + 1 个耗尽窗口（每窗 600s）
      await jest.advanceTimersByTimeAsync(
        DEFAULT_SILENT_SESSION_WAKE_MS * (MAX_SILENT_WAKE_ATTEMPTS + 1),
      );
      await jest.advanceTimersByTimeAsync(0);

      // 静默 watchdog emitError（600s 无事件回流）
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
      // watchdog 已清除——再推静默窗口时长不重复 emitError（无双报错）
      await jest.advanceTimersByTimeAsync(DEFAULT_SILENT_SESSION_WAKE_MS);
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
        expect.objectContaining({
          error: expect.stringMatching(/provider 请求失败/),
        }),
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
          return Promise.resolve({
            id: where.id,
            taskId: request.taskId,
            type: 'task_group',
          });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId)
          return Promise.resolve({ id: 'c_dm', type: 'private' });
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
      const creates = prisma.message.create.mock.calls.map(
        (c: any) => c[0].data.channelId,
      );
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
      // Todo7 团队唯一频道定位：按（团队，成员）查成员私聊 DM
      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_0000000001', teamMemberId: 'tmm_0000000001' },
        select: { id: true, type: true },
      });
      jest.useRealTimers();
    });

    it('群聊触发：回复无 group_post 声明 → 不兜底转发（仅落 private 独白）', async () => {
      jest.useFakeTimers();
      pollSetup();
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({
            id: where.id,
            taskId: request.taskId,
            type: 'task_group',
          });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId)
          return Promise.resolve({ id: 'c_dm', type: 'private' });
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
      const creates = prisma.message.create.mock.calls.map(
        (c: any) => c[0].data.channelId,
      );
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
        if ((where as any)?.teamMemberId)
          return Promise.resolve({ id: 'c_dm', type: 'private' });
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
      const creates = prisma.message.create.mock.calls.map(
        (c: any) => c[0].data.channelId,
      );
      expect(creates).toEqual(['c_dm']);
      jest.useRealTimers();
    });

    it('群聊触发：parts 含 group_post 工具调用且 completed → 跳过 forwardToGroup（防双通道双发）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // resolveChannel：DM 反查命中 private 独白频道；groupTrigger：来源频道 type=task_group
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({
            id: where.id,
            taskId: request.taskId,
            type: 'task_group',
          });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId)
          return Promise.resolve({ id: 'c_dm', type: 'private' });
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
      const creates = prisma.message.create.mock.calls.map(
        (c: any) => c[0].data.channelId,
      );
      expect(creates).toEqual(['c_dm']);
      jest.useRealTimers();
    });

    it('群聊触发：parts 含 group_post 工具调用但 status 非 completed → 不兜底转发（工具直发才入群聊）', async () => {
      jest.useFakeTimers();
      pollSetup();
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({
            id: where.id,
            taskId: request.taskId,
            type: 'task_group',
          });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId)
          return Promise.resolve({ id: 'c_dm', type: 'private' });
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
      const creates = prisma.message.create.mock.calls.map(
        (c: any) => c[0].data.channelId,
      );
      expect(creates).toEqual(['c_dm']);
      jest.useRealTimers();
    });

    it('群聊触发：parts 不含 group_post 工具调用 → 不兜底转发（仅落 private 独白）', async () => {
      jest.useFakeTimers();
      pollSetup();
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({
            id: where.id,
            taskId: request.taskId,
            type: 'task_group',
          });
        return Promise.resolve(null);
      });
      prisma.chatChannel.findFirst.mockImplementation(({ where }: any) => {
        if ((where as any)?.teamMemberId)
          return Promise.resolve({ id: 'c_dm', type: 'private' });
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
      const creates = prisma.message.create.mock.calls.map(
        (c: any) => c[0].data.channelId,
      );
      expect(creates).toEqual(['c_dm']);
      jest.useRealTimers();
    });

    it('无 private DM 频道 → 正文独白不落群聊（groupFallback 跳过落库，仅 emitFinal）', async () => {
      jest.useFakeTimers();
      pollSetup();
      // DM 不存在（null）；群聊频道存在（findFirst 命中）
      prisma.chatChannel.findUnique.mockImplementation(({ where }: any) => {
        if (where?.id)
          return Promise.resolve({
            id: where.id,
            taskId: request.taskId,
            type: 'task_group',
          });
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
        where: { teamId: 'tm_0000000001', teamMemberId: 'tmm_0000000001' },
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
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
          {
            info: { role: 'user', id: 'msg_0' },
            parts: [{ type: 'text', text: '上次用户' }],
          },
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
          {
            info: { role: 'user', id: 'msg_2' },
            parts: [{ type: 'text', text: '本次用户' }],
          },
          {
            info: { role: 'assistant', id: 'msg_3' },
            parts: [
              { type: 'text', text: '本次回复', time: { start: 1 } },
              {
                type: 'step-finish',
                reason: 'stop',
                tokens: { total: 5 },
                cost: 0.01,
              },
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
      workerClient.getMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([
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
          {
            info: { role: 'user', id: 'msg_2' },
            parts: [{ type: 'text', text: '第二轮用户' }],
          },
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
          {
            info: { role: 'user', id: 'msg_2' },
            parts: [{ type: 'text', text: '本次用户' }],
          },
          { info: { role: 'assistant', id: 'msg_3' }, parts: [] },
        ])
        // poll 第2轮：占位填充完成（text + step-finish）
        .mockResolvedValueOnce([
          { info: { role: 'user', id: 'msg_0' }, parts: [] },
          {
            info: { role: 'assistant', id: 'msg_1' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
          {
            info: { role: 'user', id: 'msg_2' },
            parts: [{ type: 'text', text: '本次用户' }],
          },
          {
            info: { role: 'assistant', id: 'msg_3' },
            parts: [
              { type: 'text', text: '本次回复', time: { start: 1 } },
              {
                type: 'step-finish',
                reason: 'stop',
                tokens: { total: 5 },
                cost: 0.01,
              },
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
          {
            info: { role: 'user', id: 'msg_1' },
            parts: [{ type: 'text', text: '首次用户' }],
          },
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      prisma.chatChannel.findFirst.mockResolvedValue({ id: request.channelId });
      prisma.message.create.mockResolvedValue(messageRow());
    };

    it('回复含产出物声明（[artifact] JSON）→ onArtifactSubmitted 收到正确 payload', async () => {
      jest.useFakeTimers();
      pollSetup();
      workerClient.getMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([
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
      workerClient.getMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          info: { role: 'assistant', id: 'msg_1' },
          parts: [
            {
              type: 'text',
              text: '这是普通回复，没有产出物声明',
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

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(artifactsService.onArtifactSubmitted).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('F3 MINOR-3：任务工作目录隔离 + 超时可配', () => {
    it('Todo3 任务目录：taskContext 有 taskId → directory 用 tasks/<taskId> 且目录存在（任务隔离保留）', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        directory: string;
      };
      const expectedDir = path.join(workRoot, 'tasks', 't_0000000001');
      expect(execArgs.directory).toBe(expectedDir);
      expect(fs.existsSync(expectedDir)).toBe(true);
    });

    it('Todo3 任务实例 work_dir 不再读取：ta_ 快照忽略，directory 用 tasks/<taskId>', async () => {
      const workDir = path.join(workRoot, 'worker', '产品经理');
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_0001',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });

      prisma.artifact.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      await d.dispatch(request);

      const execArgs = workerClient.execute.mock.calls[0][1] as {
        directory: string;
      };
      expect(execArgs.directory).toBe(
        path.join(workRoot, 'tasks', 't_0000000001'),
      );
      expect(execArgs.directory).not.toBe(workDir);
    });

    it('DISPATCH_TIMEOUT_MS 默认 120s（复杂任务多轮 tool 调用放宽），env 可配', async () => {
      expect(DISPATCH_TIMEOUT_MS).toBe(120_000);
      // 默认（config 无 DISPATCH_TIMEOUT_MS）→ 120s
      const d = createDispatcher();
      expect(d.dispatchTimeoutMs).toBe(DISPATCH_TIMEOUT_MS);
      // env 可配 → 覆盖默认
      config.get.mockImplementation((key: string) =>
        key === 'DISPATCH_TIMEOUT_MS'
          ? 30_000
          : key === 'WORK_DIR'
            ? workRoot
            : undefined,
      );
      const configured = createDispatcher();
      expect(configured.dispatchTimeoutMs).toBe(30_000);
    });

    it('判死超时默认值：事件静默 600s / 空闲 30min，env SILENT_SESSION_WAKE_MS / AGENT_IDLE_TIMEOUT_MS 可配（STRING env 解析）', async () => {
      expect(DEFAULT_SILENT_SESSION_WAKE_MS).toBe(600_000);
      expect(DEFAULT_AGENT_IDLE_TIMEOUT_MS).toBe(30 * 60_000);
      // 默认
      const d = createDispatcher();
      expect(d.silentSessionWakeMs).toBe(DEFAULT_SILENT_SESSION_WAKE_MS);
      expect(d.agentIdleTimeoutMs).toBe(DEFAULT_AGENT_IDLE_TIMEOUT_MS);
      // env 可配 → 覆盖默认（plain ConfigModule 读到的是 STRING）
      config.get.mockImplementation((key: string) =>
        key === 'SILENT_SESSION_WAKE_MS'
          ? '10000'
          : key === 'AGENT_IDLE_TIMEOUT_MS'
            ? String(5 * 60_000)
            : key === 'WORK_DIR'
              ? workRoot
              : undefined,
      );
      const configured = createDispatcher();
      expect(configured.silentSessionWakeMs).toBe(10_000);
      expect(configured.agentIdleTimeoutMs).toBe(5 * 60_000);
    });

    it('超时 env 解析：parse("0") → disabled；"600000" → 600000；未设/垃圾 → 600000；idle 同理', async () => {
      // parse("600000") → 600000
      config.get.mockImplementation((key: string) =>
        key === 'SILENT_SESSION_WAKE_MS'
          ? '600000'
          : key === 'WORK_DIR'
            ? workRoot
            : undefined,
      );
      expect(createDispatcher().silentSessionWakeMs).toBe(600_000);
      // parse("0") → disabled 路径（watchdog 不注册）
      config.get.mockImplementation((key: string) =>
        key === 'SILENT_SESSION_WAKE_MS'
          ? '0'
          : key === 'WORK_DIR'
            ? workRoot
            : undefined,
      );
      expect(createDispatcher().silentSessionWakeMs).toBe(0);
      // 垃圾/空 → 回落默认 600000
      for (const garbage of ['garbage', '', '   ', '-5', '12.5', '0x10']) {
        config.get.mockImplementation((key: string) =>
          key === 'SILENT_SESSION_WAKE_MS'
            ? garbage
            : key === 'WORK_DIR'
              ? workRoot
              : undefined,
        );
        expect(createDispatcher().silentSessionWakeMs).toBe(600_000);
      }
      // 未设 → 回落默认 600000
      config.get.mockImplementation((key: string) =>
        key === 'WORK_DIR' ? workRoot : undefined,
      );
      expect(createDispatcher().silentSessionWakeMs).toBe(600_000);
      // idle 同理：STRING "0" → disabled；垃圾 → 默认 30min
      config.get.mockImplementation((key: string) =>
        key === 'AGENT_IDLE_TIMEOUT_MS'
          ? '0'
          : key === 'WORK_DIR'
            ? workRoot
            : undefined,
      );
      expect(createDispatcher().agentIdleTimeoutMs).toBe(0);
      config.get.mockImplementation((key: string) =>
        key === 'AGENT_IDLE_TIMEOUT_MS'
          ? 'oops'
          : key === 'WORK_DIR'
            ? workRoot
            : undefined,
      );
      expect(createDispatcher().agentIdleTimeoutMs).toBe(
        DEFAULT_AGENT_IDLE_TIMEOUT_MS,
      );
    });

    it('parseTimeoutMs 单元：数字/字符串/非法输入归一', () => {
      expect(parseTimeoutMs('300000', 300_000)).toBe(300_000);
      expect(parseTimeoutMs('0', 300_000)).toBe(0);
      expect(parseTimeoutMs('  10000  ', 300_000)).toBe(10_000);
      expect(parseTimeoutMs(10_000, 300_000)).toBe(10_000);
      expect(parseTimeoutMs(undefined, 300_000)).toBe(300_000);
      expect(parseTimeoutMs(null, 300_000)).toBe(300_000);
      expect(parseTimeoutMs('', 300_000)).toBe(300_000);
      expect(parseTimeoutMs('garbage', 300_000)).toBe(300_000);
      expect(parseTimeoutMs('-5', 300_000)).toBe(300_000);
      expect(parseTimeoutMs('12.5', 300_000)).toBe(300_000);
      expect(parseTimeoutMs(NaN, 300_000)).toBe(300_000);
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
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      });
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      });
      prisma.artifact.findMany.mockResolvedValue([]);
    };

    const dispatchedPrompt = (): string => {
      const args = workerClient.execute.mock.calls[0][1] as {
        prompt: Array<{ type: string; text: string }>;
      };
      return args.prompt[0].text;
    };

    it('群聊历史不再自动注入：prompt 不含 [群聊历史消息] 块，仅团队上下文行 + request.text', async () => {
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
      // 含任务上下文行 + 当前消息
      expect(prompt).toContain('【任务上下文】');
      expect(prompt).toContain('vteam_chat_history');
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

      const ctx = await (
        d as unknown as {
          buildChatHistoryContext(
            channelId: string,
            excludeMessageId: string,
          ): Promise<string>;
        }
      ).buildChatHistoryContext(request.channelId, request.messageId);

      expect(ctx).toContain('[群聊历史消息]');
      expect(ctx).toContain('Agent: agent 之前的结论');
      expect(ctx).toContain('用户: 正常历史消息');
      expect(ctx).not.toContain('触发消息内容'); // 当前触发消息被排除
    });

    it('方法保留：buildChatHistoryContext 空历史 → 返回空串', async () => {
      prisma.message.findMany.mockResolvedValue([]);
      const d = createDispatcher();

      const ctx = await (
        d as unknown as {
          buildChatHistoryContext(
            channelId: string,
            excludeMessageId: string,
          ): Promise<string>;
        }
      ).buildChatHistoryContext(request.channelId, request.messageId);

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
        key === 'CHAT_HISTORY_MAX_BYTES'
          ? 100
          : key === 'WORK_DIR'
            ? workRoot
            : undefined,
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

      const ctx = await (
        d as unknown as {
          buildChatHistoryContext(
            channelId: string,
            excludeMessageId: string,
          ): Promise<string>;
        }
      ).buildChatHistoryContext(request.channelId, request.messageId);

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

      const ctx = await (
        d as unknown as {
          buildChatHistoryContext(
            channelId: string,
            excludeMessageId: string,
          ): Promise<string>;
        }
      ).buildChatHistoryContext(request.channelId, request.messageId);

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
      expect(escapeXml('<a b="c" & d>')).toBe(
        '&lt;a b=&quot;c&quot; &amp; d&gt;',
      );
    });

    it('findFinish：仅 assistant 消息 + reason=stop 命中；user/error reason 不算', () => {
      // user 消息带 step-finish 不算
      expect(
        findFinish([
          {
            info: { role: 'user' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
        ]),
      ).toBeUndefined();
      // reason=error 不算
      expect(
        findFinish([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'step-finish', reason: 'error' }],
          },
        ]),
      ).toBeUndefined();
      expect(
        findFinish([
          {
            info: { role: 'assistant' },
            parts: [
              { type: 'step-finish', reason: 'stop', tokens: { total: 1 } },
            ],
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
          {
            info: { role: 'user' },
            parts: [{ type: 'step-finish', reason: 'error' }],
          },
        ]),
      ).toBeUndefined();
      // reason=stop 不算
      expect(
        findError([
          {
            info: { role: 'assistant' },
            parts: [{ type: 'step-finish', reason: 'stop' }],
          },
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
            {
              type: 'text',
              text: '工具占位',
              synthetic: true,
              time: { start: 15 },
            },
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
        extractArtifacts(
          '产出设计文档：{"type":"doc","title":"设计文档","fileRef":"file://x"}',
        ),
      ).toEqual([{ type: 'doc', title: '设计文档', fileRef: 'file://x' }]);
      // ③ [artifact] 包裹 JSON
      expect(
        extractArtifacts(
          '[artifact]{"type":"text","title":"说明","content":"内容"}[/artifact]',
        ),
      ).toEqual([{ type: 'text', title: '说明', content: '内容' }]);
      // 普通文本无声明 → 空数组（不误报）
      expect(extractArtifacts('这是普通回复，没有产出物')).toEqual([]);
      // 非法声明（doc 缺 fileRef / type 非三态枚举）→ 过滤
      expect(
        extractArtifacts('<artifact type="doc" title="缺引用">正文</artifact>'),
      ).toEqual([]);
      expect(
        extractArtifacts('{"type":"other","title":"x","content":"y"}'),
      ).toEqual([]);
    });

    it('extractGroupPost：JSON/<group_post> 声明提取 {content,fileRef?}；无声明/空内容 → null', () => {
      expect(
        extractGroupPost(
          '结论。{"type":"group_post","content":"要向群里说的话"}',
        ),
      ).toEqual({ content: '要向群里说的话' });
      expect(
        extractGroupPost('结论。<group_post>要向群里说的话</group_post>'),
      ).toEqual({
        content: '要向群里说的话',
      });
      // 携带 fileRef（群聊附件）：JSON 与标签两种格式
      expect(
        extractGroupPost(
          '{"type":"group_post","content":"文档已生成","fileRef":"docs/a.md"}',
        ),
      ).toEqual({ content: '文档已生成', fileRef: 'docs/a.md' });
      expect(
        extractGroupPost(
          '<group_post fileRef="docs/a.md">文档已生成</group_post>',
        ),
      ).toEqual({
        content: '文档已生成',
        fileRef: 'docs/a.md',
      });
      expect(extractGroupPost('普通回复，不公开')).toBeNull();
      expect(
        extractGroupPost('{"type":"group_post","content":"  "}'),
      ).toBeNull();
    });

    it('stripGroupPostDeclarations：移除 group_post 声明块，保留正文', () => {
      expect(
        stripGroupPostDeclarations('结论。{"type":"group_post","content":"x"}'),
      ).toBe('结论。');
      expect(
        stripGroupPostDeclarations('结论。<group_post>x</group_post>'),
      ).toBe('结论。');
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

  describe('WeCom directed reply (group @user + mirror to task_group)', () => {
    const basePayload = {
      taskId: 't_0000000001',
      agentId: 'a_product',
      sessionId: 's_0000000001',
      text: 'model reply text',
      parts: [{ type: 'text', text: 'model reply text' }],
    };

    function setupWecomBridge(opts: {
      chattype: string;
      fromUserName: string;
    }) {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        agentId: 'a_product',
        teamMemberId: 'tmm_1',
      });
      (prisma as any).taskMessageChannel = {
        findMany: jest
          .fn()
          .mockResolvedValue([{ messageChannelId: 'mc_wecom' }]),
      };
      (prisma as any).messageChannel = {
        findUnique: jest.fn().mockImplementation((q: any) => {
          if (q?.where?.id === 'mc_wecom') {
            return Promise.resolve({ id: 'mc_wecom', type: 'wecom_aibot' });
          }
          return Promise.resolve(null);
        }),
      };
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_group' } as any);
      prisma.chatChannel.findUnique.mockResolvedValue(null);
      prisma.message.findFirst.mockResolvedValue({
        id: 'm_ext_1',
        content: { text: '[WeCom:GuoLong] hi' },
      } as any);
      prisma.message.create.mockResolvedValue({
        id: 'm_mirror_1',
        channelId: 'c_group',
        senderType: SENDER_TYPE.agent,
        senderId: 'a_product',
        content: { text: 'mirror' },
        mentions: null,
        status: MESSAGE_STATUS.sent,
        createdAt: new Date(),
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      const mockAdapter: any = {
        finishStream: jest.fn().mockResolvedValue(true),
        sendFallbackMessage: jest.fn().mockResolvedValue(true),
        getStream: jest.fn().mockReturnValue({
          fromUserId: 'GuoLong',
          fromUserName: opts.fromUserName,
          chattype: opts.chattype,
        }),
        getPendingUser: jest.fn().mockReturnValue({
          fromUserId: 'GuoLong',
          fromUserName: opts.fromUserName,
          chattype: opts.chattype,
        }),
      };
      const d = new WorkerDispatcher(
        prisma as any,
        idGen as any,
        realtime as any,
        workersService as any,
        workerClient as any,
        sessionLifecycle as any,
        artifactsService as any,
        config as any,
        ingress as any,
        { get: jest.fn().mockReturnValue(mockAdapter) } as any,
      );
      return { d, mockAdapter };
    }

    it('group chattype: WeCom finishStream with @name and mirror also with @name', async () => {
      const { d, mockAdapter } = setupWecomBridge({
        chattype: 'group',
        fromUserName: 'GuoLong',
      });
      await d.handleTaskCompleted(basePayload as any);
      expect(mockAdapter.finishStream).toHaveBeenCalledWith(
        'm_ext_1',
        '@GuoLong model reply text',
      );
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_group',
            content: expect.objectContaining({
              text: '@GuoLong model reply text',
            }),
          }),
        }),
      );
    });

    it('single chattype: WeCom plain, mirror with @name', async () => {
      const { d, mockAdapter } = setupWecomBridge({
        chattype: 'single',
        fromUserName: 'Alice',
      });
      await d.handleTaskCompleted(basePayload as any);
      expect(mockAdapter.finishStream).toHaveBeenCalledWith(
        'm_ext_1',
        'model reply text',
      );
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: expect.objectContaining({
              text: '@Alice model reply text',
            }),
          }),
        }),
      );
    });
  });

  // ------------------------------------------------------------------
  // Task9: TeamMember 维度（WorkerDispatcher team 段 + dispatchAgentMention + session 复用）
  // ------------------------------------------------------------------

  describe('Task9 TeamMember 维度 (team 注入/别名 seq/复用/mention)', () => {
    const teamSetup = () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: null,
        instanceRef: null,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      } as any);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
        status: 'online',
      } as any);
      workersService.assignWorker.mockResolvedValue('w_0000000001');
      workerClient.createSession.mockResolvedValue({
        sessionID: 'ses_team_001',
      });
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        agentKey: 'product',
        prompt: '负责需求。',
        persona: null,
        defaultModelId: null,
      } as any);
    };

    it('dispatch team 注入从 TeamMember 组装：system team 段显示别名/seq 正确（tmm_ 前缀）', async () => {
      teamSetup();
      (prisma as any).team = {
        findUnique: jest
          .fn()
          .mockResolvedValue({ mainAgentMemberId: 'tmm_0000000001' }),
      };
      (prisma as any).task = {
        findUnique: jest.fn().mockImplementation(({ select }: any) => {
          if (select?.teamId) {
            return Promise.resolve({
              teamId: 'tm_0000000001',
              mainAgentInstanceId: 'tmm_0000000001',
              executionMode: 'direct',
            });
          }
          return Promise.resolve(null);
        }),
      };
      (prisma as any).teamMember = {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'tmm_0000000001',
            teamId: 'tm_0000000001',
            agentId: 'a_product',
            alias: '产品经理-1',
            seq: 1,
            agent: {
              id: 'a_product',
              name: '产品经理',
              role: 'product',
              agentKey: 'product',
            },
          },
          {
            id: 'tmm_0000000002',
            teamId: 'tm_0000000001',
            agentId: 'a_developer',
            alias: '开发者-1',
            seq: 1,
            agent: {
              id: 'a_developer',
              name: '开发者',
              role: 'developer',
              agentKey: 'developer',
            },
          },
          {
            id: 'tmm_0000000003',
            teamId: 'tm_0000000001',
            agentId: 'a_developer',
            alias: '开发者-2',
            seq: 2,
            agent: {
              id: 'a_developer',
              name: '开发者',
              role: 'developer',
              agentKey: 'developer',
            },
          },
        ]),
      };

      const d = createDispatcher();
      await d.dispatch(request);

      const sys = (workerClient.execute.mock.calls[0][1] as any)
        .system as string;
      expect(sys).toContain('【团队成员】');
      expect(sys).toContain('产品经理-1（实例 id: tmm_0000000001');
      expect(sys).toContain('开发者-1（实例 id: tmm_0000000002');
      expect(sys).toContain('开发者-2（实例 id: tmm_0000000003');
      expect(sys).toContain(' —— 主 Agent');
      // 单入口身份段为团队维度（tmm_）；任务实例双维度映射归 Todo 5
      expect(sys).toContain(
        '你是本任务的 产品经理-1（实例 id: tmm_0000000001，角色: product）',
      );
    });

    it('二次 @ 复用同一 opencode sessionId：已绑 session 不重建 TaskGroupInstance（bind 仅 pending 占位一次后复用）', async () => {
      // 已绑 session：workerId + instanceRef 已存在 → dispatch 复用，不 createSession
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: 'w_0000000001',
        instanceRef: 'ses_team_001',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      } as any);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'online',
        capabilities: {},
      } as any);
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: null,
        defaultModelId: null,
      } as any);

      (prisma as any).task = {
        findUnique: jest.fn().mockResolvedValue({
          teamId: 'tm_0000000001',
          mainAgentInstanceId: 'tmm_0000000001',
          executionMode: 'direct',
        }),
      };
      (prisma as any).teamMember = {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'tmm_0000000001',
            alias: '产品经理-1',
            seq: 1,
            agent: {
              id: 'a_product',
              name: '产品经理',
              role: 'product',
              agentKey: 'product',
            },
          },
        ]),
      };
      const d = createDispatcher();
      await d.dispatch(request);
      expect(workerClient.createSession).not.toHaveBeenCalled();
      expect(sessionLifecycle.bindSessionToWorker).not.toHaveBeenCalled();
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sessionId: 'ses_team_001' }),
      );
      // 第二次 dispatch 同一 sessionId 仍复用
      await d.dispatch(request);
      expect(workerClient.createSession).not.toHaveBeenCalled();
      expect(workerClient.execute).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ sessionId: 'ses_team_001' }),
      );
    });

    it('Todo5 dispatchAgentMention 团队直查：命中 team 会话 dispatch；未知成员即建后 dispatch', async () => {
      const d = createDispatcher();
      const dispatchSpy = jest
        .spyOn(d, 'dispatch')
        .mockResolvedValue({ replies: [] });
      (prisma as any).task = {
        findUnique: jest.fn().mockResolvedValue({ teamId: 'tm_0000000001' }),
      };
      (sessionLifecycle as any).ensureTeamSession = jest
        .fn()
        .mockResolvedValueOnce({
          id: 's_tmm_1',
          agentId: 'a_developer',
          reused: true,
        })
        .mockResolvedValueOnce({
          id: 's_ghost_new',
          agentId: 'a_ghost',
          reused: false,
        });
      await d.dispatchAgentMention({
        taskId: 't_0000000001',
        channelId: 'c_1',
        text: '@tmm',
        targetInstanceId: 'tmm_0000000002',
      });
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledTimes(
        1,
      );
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000002',
      );
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          targets: [
            {
              agentId: 'a_developer',
              instanceId: 'tmm_0000000002',
              sessionId: 's_tmm_1',
            },
          ],
        }),
      );
      await d.dispatchAgentMention({
        taskId: 't_0000000001',
        channelId: 'c_1',
        text: '@ta',
        targetInstanceId: 'tmm_ghost',
      });
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_ghost',
      );
      expect(dispatchSpy).toHaveBeenCalledTimes(2);
      expect(dispatchSpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          targets: [
            {
              agentId: 'a_ghost',
              instanceId: 'tmm_ghost',
              sessionId: 's_ghost_new',
            },
          ],
        }),
      );
    });

    it('reuse=true 场景不重建 TaskGroupInstance：bind 幂等复用（现有行则复用不 create）', async () => {
      teamSetup();

      (prisma as any).task = {
        findUnique: jest.fn().mockResolvedValue({
          teamId: 'tm_0000000001',
          mainAgentInstanceId: null,
          executionMode: 'direct',
        }),
      };
      (prisma as any).teamMember = {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'tmm_0000000001',
            alias: '产品经理-1',
            seq: 1,
            agent: {
              id: 'a_product',
              name: '产品经理',
              role: 'product',
              agentKey: 'product',
            },
          },
        ]),
      };
      const d = createDispatcher();
      await d.dispatch(request);
      expect(sessionLifecycle.bindSessionToWorker).toHaveBeenCalledTimes(2);
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
        'ses_team_001',
      );
    });
  });

  describe('补充覆盖：并发 seq/version 与团队复用分支', () => {
    it('多目标中 sessionId null 直接跳过 worker 链路，emitError 聚合', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: null,
        instanceRef: null,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      } as any);
      workersService.assignWorker.mockResolvedValue('w_0000000001');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        capabilities: {},
      } as any);
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      } as any);
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession.mockResolvedValue({
        sessionID: 'ses_1',
      } as any);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      await d.dispatch({
        messageId: 'm_1',
        channelId: 'c_1',
        taskId: 't_1',
        teamId: 'tm_0000000001',
        text: 'hi',
        targets: [
          { agentId: 'a_product', sessionId: null },
          {
            agentId: 'a_developer',
            instanceId: 'tmm_0000000001',
            sessionId: 's_0000000001',
          },
        ],
      });
      expect(errors).toHaveLength(1);
      expect(workerClient.execute).toHaveBeenCalledTimes(1);
    });

    it('无 sessionId 回流不进幂等门：任务归属兜底团队定位，两次各落库+广播', async () => {
      // 无 session 时经任务归属反查团队 + agent 反查成员（兜底不断流）；幂等门按
      // sessionId 生效，无 sessionId 的回流每次独立落库
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_0000000001' });
      (prisma as any).teamMember.findFirst.mockResolvedValue({
        id: 'tmm_0000000001',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_0000000001',
      } as any);
      prisma.message.create.mockResolvedValue(messageRow() as any);
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '第一次',
      });
      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        text: '第二次',
      });
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      expect(finals).toHaveLength(2);
    });

    it('createSession 抢占失败回退 unbind：第二次 dispatch 复用新 worker', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's_0000000001',
        workerId: null,
        instanceRef: null,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      } as any);
      workersService.assignWorker
        .mockResolvedValueOnce('w_0000000001')
        .mockResolvedValueOnce('w_0000000002');
      prisma.worker.findUnique
        .mockResolvedValueOnce({ id: 'w_0000000001', capabilities: {} } as any)
        .mockResolvedValueOnce({ id: 'w_0000000002', capabilities: {} } as any);
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        defaultModelId: null,
      } as any);
      prisma.artifact.findMany.mockResolvedValue([]);
      workerClient.createSession
        .mockRejectedValueOnce(
          new WorkerUnavailableException('w_0000000001', '503'),
        )
        .mockResolvedValueOnce({ sessionID: 'ses_2' } as any);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      await d.dispatch(request);
      expect(sessionLifecycle.unbindSession).toHaveBeenCalledWith(
        's_0000000001',
      );
      expect(errors).toHaveLength(1);
      await d.dispatch(request);
      expect(workerClient.createSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('buildSystemInstructions team-mode 接待段', () => {
    const agent: AgentIdentityInfo = {
      id: 'a_product',
      name: '产品经理',
      role: 'product',
      prompt: '负责需求',
      persona: null,
      agentKey: null,
    };

    it('teamMode=true → 追加【团队接待】段（task_create 直接建任务，已删项目发现，禁 QuestionModal）', () => {
      const out = buildSystemInstructions(agent, { teamMode: true });
      expect(out).toContain(TEAM_SYSTEM_RECEPTION_INSTRUCTION);
      expect(out).toContain('task_create');
      expect(out).not.toContain('my_projects');
      expect(out).toMatch(/禁止.*QuestionModal/);
    });

    it('显式 taskId 空串 → 同样触发接待段（分派侧 teamMode 传值方式）', () => {
      const out = buildSystemInstructions(agent, { taskId: '' });
      expect(out).toContain(TEAM_SYSTEM_RECEPTION_INSTRUCTION);
    });

    it('task-mode 文本字节不变：不传 teamMode/taskId 时接待段精确缺席且其余字节与接待插入前一致', () => {
      const base = buildSystemInstructions(agent);
      const teamOut = buildSystemInstructions(agent, { teamMode: true });
      expect(base).not.toContain('团队接待');
      expect(teamOut).toBe(
        base.replace(
          TEAM_COLLABORATION_CHARTER_INSTRUCTION,
          `${TEAM_SYSTEM_RECEPTION_INSTRUCTION}\n\n${TEAM_COLLABORATION_CHARTER_INSTRUCTION}`,
        ),
      );
    });

    it('task-mode 全选项文本字节不变：isMainAgent/team/memory 下接待段缺席', () => {
      const team: TeamMemberInfo[] = [
        {
          id: 'a_product',
          name: '产品经理',
          role: 'product',
          instanceId: 'tmm_0000000001',
          alias: '产品经理-1',
          seq: 1,
        },
      ];
      const out = buildSystemInstructions(agent, {
        isMainAgent: true,
        mainAgentInstanceId: 'tmm_0000000001',
        team,
        selfInstanceId: 'tmm_0000000001',
        selfAlias: '产品经理-1',
        persistentWorkDir: '/data/vteam-worker/tasks/t_1',
        memoryIndex: '【可用记忆索引】',
      });
      expect(out).not.toContain('团队接待');
      expect(out).toContain(MAIN_AGENT_INSTRUCTION);
      expect(out).toContain('【团队成员】');
    });
  });

  describe('dispatch team-mode（无任务团队直聊）', () => {
    const teamRequest = (overrides: Record<string, unknown> = {}) => ({
      messageId: 'm_0000000001',
      channelId: 'c_0000000001',
      taskId: '',
      teamId: 'tm_0000000001',
      text: '你好，请帮忙看看',
      targets: [
        { agentId: 'a_product', instanceId: 'tmm_0000000001', sessionId: null },
      ],
      ...overrides,
    });

    beforeEach(() => {
      (sessionLifecycle as any).ensureTeamSession = jest
        .fn()
        .mockResolvedValue({
          id: 's_team_0000000001',
          teamId: 'tm_0000000001',
          teamMemberId: 'tmm_0000000001',
          agentId: 'a_product',
          reused: false,
        });
      prisma.session.findUnique.mockResolvedValue({
        id: 's_team_0000000001',
        workerId: null,
        instanceRef: null,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      } as any);
      workersService.assignWorker.mockResolvedValue('w_0000000001');
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: 'online',
        capabilities: { maxInstances: 1 },
        defaultModelId: null,
      } as any);
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        agentKey: 'product',
        prompt: '负责需求',
        persona: null,
        defaultModelId: null,
      } as any);
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_0000000001',
        type: 'team_group',
      } as any);
      prisma.chatChannel.findFirst.mockResolvedValue(null as any);
      (prisma as any).teamMember = {
        findMany: jest.fn().mockResolvedValue([]),
        // 默认未选择 opencode agent / 无覆盖模型（零回归基线）；
        // 相关用例按 select 字段覆盖 mockImplementation。
        findFirst: jest.fn().mockResolvedValue(null),
      };
      (prisma as any).team = {
        findUnique: jest.fn().mockResolvedValue({ mainAgentMemberId: null }),
      };
      workerClient.createSession.mockResolvedValue({
        sessionID: 'ses_team_1',
      } as any);
    });

    it('无 session 目标 → ensureTeamSession 即建（teamId/teamMemberId），execute 用 teams/<teamId> 目录 + 接待 system', async () => {
      const d = createDispatcher();
      const result = await d.dispatch(teamRequest() as any);

      expect(result).toEqual({ replies: [] });
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000001',
      );
      expect(prisma.task.findUnique).not.toHaveBeenCalled();
      const expectedDir = path.join(workRoot, 'teams', 'tm_0000000001');
      expect(workerClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'w_0000000001' }),
        expect.objectContaining({
          directory: expectedDir,
          agentId: 'a_product',
          channelId: 'c_0000000001',
          sessionId: 'ses_team_1',
        }),
      );
      expect(fs.existsSync(expectedDir)).toBe(true);
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).toContain(TEAM_SYSTEM_RECEPTION_INSTRUCTION);
      expect(system).toContain('task_create');
      expect(system).not.toContain('my_projects');
      expect(system).toMatch(/禁止.*QuestionModal/);
      // 任务只作数据：execute 保留 taskId 键（无任务时 ''；worker 侧 falsy 省略，
      // 回流经 session 反查走团队路径）
      expect(workerClient.execute.mock.calls[0][1].taskId).toBe('');
    });

    it('主成员分派 → system 含主 Agent 职责段；非主成员 → 不含（门 = teamMember == mainAgentMemberId）', async () => {
      (prisma as any).team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_0000000001',
      });
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      expect(workerClient.execute.mock.calls[0][1].system).toContain(
        MAIN_AGENT_INSTRUCTION,
      );

      workerClient.execute.mockClear();
      prisma.session.findUnique.mockResolvedValue({
        id: 's_team_0000000001',
        workerId: null,
        instanceRef: null,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000002',
      } as any);
      await d.dispatch(
        teamRequest({
          targets: [
            {
              agentId: 'a_developer',
              instanceId: 'tmm_0000000002',
              sessionId: null,
            },
          ],
        }) as any,
      );
      expect(
        (sessionLifecycle as any).ensureTeamSession,
      ).toHaveBeenLastCalledWith('tm_0000000001', 'tmm_0000000002');
      expect(workerClient.execute.mock.calls[0][1].system).not.toContain(
        MAIN_AGENT_INSTRUCTION,
      );
    });

    it('执行键隔离：team: 作用域注册可查，task 作用域不可见（key 碰撞即 bug）', async () => {
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      expect(d.isAgentExecuting('w_0000000001', 'team:tm_0000000001')).toEqual(
        new Set(['tmm_0000000001']),
      );
      expect(d.isAgentExecuting('w_0000000001', 'tm_0000000001')).toBeNull();
    });

    it('toExecutionScope：taskId 非空走 taskId，为空走 team:<teamId>', () => {
      expect(toExecutionScope('t_0000000001', 'tm_0000000001')).toBe(
        't_0000000001',
      );
      expect(toExecutionScope('', 'tm_0000000001')).toBe('team:tm_0000000001');
      expect(toExecutionScope(null, 'tm_0000000001')).toBe(
        'team:tm_0000000001',
      );
    });

    it('taskContext 透传：taskId 进 execute（任务只作数据，仍走团队会话/作用域）', async () => {
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      const execArg = workerClient.execute.mock.calls[0][1] as {
        taskId?: string;
      };
      // 任务只作数据：execute 携带 taskId，但会话/注册仍走团队维度
      expect(execArg.taskId).toBe('t_0000000001');
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000001',
      );
      expect(d.isAgentExecuting('w_0000000001', 'team:tm_0000000001')).toEqual(
        new Set(['tmm_0000000001']),
      );
    });

    it('Todo3 任务目录：taskContext 有 taskId → directory 用 tasks/<taskId>（任务隔离保留，注册仍走团队域）', async () => {
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      const execArg = workerClient.execute.mock.calls[0][1] as {
        directory: string;
      };
      const expectedDir = path.join(workRoot, 'tasks', 't_0000000001');
      expect(execArg.directory).toBe(expectedDir);
      expect(fs.existsSync(expectedDir)).toBe(true);
      expect(d.isAgentExecuting('w_0000000001', 'team:tm_0000000001')).toEqual(
        new Set(['tmm_0000000001']),
      );
    });

    it('Todo3 同成员二次分派键复用：register ref 恒 teamMemberId（set 去重，裸 task 键不可见）', async () => {
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      await d.dispatch(teamRequest() as any);
      expect(d.isAgentExecuting('w_0000000001', 'team:tm_0000000001')).toEqual(
        new Set(['tmm_0000000001']),
      );
      expect(d.isAgentExecuting('w_0000000001', 't_0000000001')).toBeNull();
      expect(d.isAgentExecuting('w_0000000001', 'tm_0000000001')).toBeNull();
    });

    it('Todo3 双分派键隔离冒烟：不同成员 refs 共存，注销互不干扰', async () => {
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      (prisma.session.findUnique as jest.Mock).mockResolvedValue({
        id: 's_team_0000000002',
        workerId: null,
        instanceRef: null,
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000002',
      } as any);
      await d.dispatch(
        teamRequest({
          targets: [
            {
              agentId: 'a_developer',
              instanceId: 'tmm_0000000002',
              sessionId: null,
            },
          ],
        }) as any,
      );
      expect(d.isAgentExecuting('w_0000000001', 'team:tm_0000000001')).toEqual(
        new Set(['tmm_0000000001', 'tmm_0000000002']),
      );
      d.unregisterExecution(
        'w_0000000001',
        'team:tm_0000000001',
        'tmm_0000000001',
      );
      expect(d.isAgentExecuting('w_0000000001', 'team:tm_0000000001')).toEqual(
        new Set(['tmm_0000000002']),
      );
    });

    it('Todo2 单触发器：taskContext 有 taskId → prompt 含任务段 + 任务版群聊指令（无团队直聊段/TEAM 指令，system 无接待段）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_0000000001',
        type: 'team_group',
      } as any);
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      const execArg = workerClient.execute.mock.calls[0][1] as {
        prompt: Array<{ text: string }>;
        system: string;
      };
      const prompt = execArg.prompt.map((p) => p.text).join('\n\n');
      expect(prompt).toContain('【任务上下文】你的当前任务 ID：t_0000000001');
      expect(prompt).toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).not.toContain('无任务');
      expect(prompt).not.toContain(TEAM_GROUP_TRIGGER_INSTRUCTION);
      expect(execArg.system).not.toContain(TEAM_SYSTEM_RECEPTION_INSTRUCTION);
    });

    it('Todo2 单触发器：无 taskContext → prompt 走团队直聊段 + TEAM 指令（任务段/任务版指令缺席）', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_0000000001',
        type: 'team_group',
      } as any);
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      const execArg = workerClient.execute.mock.calls[0][1] as {
        prompt: Array<{ text: string }>;
      };
      const prompt = execArg.prompt.map((p) => p.text).join('\n\n');
      expect(prompt).toContain('无任务');
      expect(prompt).toContain(TEAM_GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).not.toContain('【任务上下文】');
      expect(prompt).not.toContain(GROUP_TRIGGER_INSTRUCTION);
    });

    it('Todo2 overrideModel：taskContext.overrideModelId 覆盖 agent 默认模型；缺省回退 agent 链', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        prompt: null,
        persona: null,
        defaultModelId: 'agentprov/agentmodel',
        baseAgentId: null,
        type: 'custom',
      } as any);
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({
          taskContext: {
            taskId: 't_0000000001',
            overrideModelId: 'overprov/overmodel',
          },
        }) as any,
      );
      expect(workerClient.execute.mock.calls[0][1].model).toEqual({
        providerID: 'overprov',
        modelID: 'overmodel',
      });

      workerClient.execute.mockClear();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      expect(workerClient.execute.mock.calls[0][1].model).toEqual({
        providerID: 'agentprov',
        modelID: 'agentmodel',
      });
    });

    it('opencode agent：成员选了 opencodeAgentName → execute 收到 agent 字段（透传给 opencode 内核执行）', async () => {
      // 两个 resolver（overrideModelId / opencodeAgentName）各查一次同表：
      // 按 select 字段返回，避免互相覆盖。
      (prisma as any).teamMember.findFirst.mockImplementation(async (q: any) =>
        q?.select?.opencodeAgentName !== undefined
          ? { opencodeAgentName: 'plan' }
          : { overrideModelId: null },
      );
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      expect(workerClient.execute.mock.calls[0][1].agent).toBe('plan');
    });

    it('opencode agent 零回归：opencodeAgentName 为 null → execute 不含 agent 键（行为与引入前逐字节一致）', async () => {
      // 默认 mock：teamMember.findFirst → null（未选择任何 opencode agent）
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      // 必须"不含该键"而非"值为 undefined"——worker 侧以 key 存在与否决定是否下发 agent
      expect(
        Object.prototype.hasOwnProperty.call(
          workerClient.execute.mock.calls[0][1],
          'agent',
        ),
      ).toBe(false);
    });

    it('opencode agent：查询异常不阻断分派（回退不带 agent 字段）', async () => {
      // 仅让 opencodeAgentName 那次查询失败，验证其 try/catch 容错
      (prisma as any).teamMember.findFirst.mockImplementation(
        async (q: any) => {
          if (q?.select?.opencodeAgentName !== undefined) {
            throw new Error('db down');
          }
          return { overrideModelId: null };
        },
      );
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      expect(
        Object.prototype.hasOwnProperty.call(
          workerClient.execute.mock.calls[0][1],
          'agent',
        ),
      ).toBe(false);
    });

    it('计划指令已下线：dispatch 的系统提示不含【计划编制】/【计划评审】', async () => {
      (prisma as any).team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_0000000001',
      });
      (prisma as any).teamMember.findFirst.mockImplementation(async (q: any) =>
        q?.select?.opencodeAgentName !== undefined
          ? { opencodeAgentName: 'Prometheus - Plan Builder' }
          : { overrideModelId: null },
      );
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).not.toContain('【计划编制】');
      expect(system).not.toContain('【计划评审】');
    });

    it('计划域已下线：dispatch 不再注入 plan_submit/plan_review 提示词，改注入产出物引导', async () => {
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({
          taskContext: { taskId: 't_0000000001' },
        }) as any,
      );
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).toContain(ARTIFACT_SUBMISSION_INSTRUCTION);
      expect(system).toContain('vteam_submit_artifact');
      expect(system).not.toContain('plan_submit');
      expect(system).not.toContain('plan_review');
      expect(system).not.toContain('【计划工作流】');
    });

    it('Todo9 memoryIndex：team+global 计数 + 最近条目进 system（任务级记忆已删除，prompt hint 富集）', async () => {
      (prisma as any).memory = {
        count: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(3),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'me_2',
            level: 'team',
            description: '团队经验摘要',
            content: '团队经验正文',
            tags: ['pitfall'],
          },
        ]),
      };
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).toContain('【可用记忆索引');
      expect(system).not.toContain('本任务可见 task:');
      expect(system).toContain('team:1');
      expect(system).toContain('global:3');
      expect(system).toContain('团队经验摘要');
      expect((prisma as any).memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { level: 'team', teamId: expect.any(String) },
              { level: 'global' },
            ],
          }),
        }),
      );
      workerClient.execute.mockClear();
      delete (prisma as any).memory;
      await d.dispatch(teamRequest() as any);
      expect(
        workerClient.execute.mock.calls[0][1].system as string,
      ).not.toContain('【可用记忆索引');
    });

    it('Todo2 主门唯一来源 team.mainAgentMemberId；dispatch 不再读取 task 表', async () => {
      (prisma as any).team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_0000000001',
      });
      const d = createDispatcher();
      await d.dispatch(
        teamRequest({ taskContext: { taskId: 't_0000000001' } }) as any,
      );
      expect(workerClient.execute.mock.calls[0][1].system).toContain(
        MAIN_AGENT_INSTRUCTION,
      );
      // 计划模式指令注入已下线 → dispatch 零 task 表读取（主门判定只看 team 表）
      expect(prisma.task.findUnique).not.toHaveBeenCalled();
    });

    describe('Todo 13 dispatch 优先级：外部绑定 > 能力位门控的内部候选 > 省略（引擎默认）', () => {
      const capsWith = (enabled: boolean, names: string[]) => {
        prisma.worker.findUnique.mockResolvedValue({
          id: 'w_0000000001',
          status: 'online',
          capabilities: {
            maxInstances: 1,
            agentPolicies: { enabled, names },
          },
          defaultModelId: null,
        } as any);
      };
      const selectMemberAgent = (name: string | null) => {
        (prisma as any).teamMember.findFirst.mockImplementation(
          async (q: any) =>
            q?.select?.opencodeAgentName !== undefined
              ? { opencodeAgentName: name }
              : { overrideModelId: null },
        );
      };
      const execPayload = () => workerClient.execute.mock.calls[0][1] as any;
      const withTask = (extra: Record<string, unknown> = {}) =>
        teamRequest({
          taskContext: { taskId: 't_0000000001', ...extra },
        }) as any;

      it('门真（enabled+names 含候选）→ 下发 vteam-<role>（目标角色 product，无显式选择）', async () => {
        capsWith(true, ['vteam-product', 'vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('vteam-product');
      });

      it('门真时成员显式外部绑定胜出 → 下发 opencodeAgentName（内部候选仅作回退）', async () => {
        capsWith(true, ['vteam-product', 'vteam-plan']);
        selectMemberAgent('plan');
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('plan');
      });

      it('外部绑定 build + 门真 → 下发 build（绑定优先于内部候选）', async () => {
        capsWith(true, ['vteam-plan', 'vteam-product']);
        selectMemberAgent('build');
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('build');
      });

      it('能力位假 → 回退现状（显式选择透传 plan）', async () => {
        capsWith(false, ['vteam-product']);
        selectMemberAgent('plan');
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('plan');
      });

      it('能力位假 + 无显式选择 → 省略 agent 键（与引入前基线一致）', async () => {
        capsWith(false, []);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(
          Object.prototype.hasOwnProperty.call(execPayload(), 'agent'),
        ).toBe(false);
      });

      it('名称不在清单 → 回退现状（显式选择透传，不下发候选）', async () => {
        capsWith(true, ['vteam-plan']);
        selectMemberAgent('plan');
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('plan');
      });

      it('角色未知（无候选）→ 回退现状，且 payload 与同角色基线逐字节一致', async () => {
        prisma.agent.findUnique.mockResolvedValue({
          id: 'a_product',
          name: '神秘角色',
          role: 'mystery',
          prompt: '负责未知',
          persona: null,
          defaultModelId: null,
        } as any);
        selectMemberAgent(null);
        // 门其他条件为真（enabled+含 vteam-plan）但角色无映射 → 无候选 → 回退
        capsWith(true, ['vteam-plan', 'vteam-product']);
        const d = createDispatcher();
        await d.dispatch(withTask());
        const gated = execPayload();
        expect(Object.prototype.hasOwnProperty.call(gated, 'agent')).toBe(
          false,
        );
        // 同角色、无能力位字段的基线 payload 必须逐字节一致
        workerClient.execute.mockClear();
        prisma.worker.findUnique.mockResolvedValue({
          id: 'w_0000000001',
          status: 'online',
          capabilities: { maxInstances: 1 },
          defaultModelId: null,
        } as any);
        await d.dispatch(withTask());
        expect(execPayload()).toEqual(gated);
      });

      it('门假时 payload 与基线逐字节一致（enabled:false vs 无能力位字段）', async () => {
        selectMemberAgent(null);
        capsWith(false, []);
        const d = createDispatcher();
        await d.dispatch(withTask());
        const fallback = execPayload();
        expect(Object.prototype.hasOwnProperty.call(fallback, 'agent')).toBe(
          false,
        );
        workerClient.execute.mockClear();
        prisma.worker.findUnique.mockResolvedValue({
          id: 'w_0000000001',
          status: 'online',
          capabilities: { maxInstances: 1 },
          defaultModelId: null,
        } as any);
        await d.dispatch(withTask());
        expect(execPayload()).toEqual(fallback);
      });

      it('绑定候选不在能力位 + 外部绑定 build → 下发 build（外部绑定不依赖能力位）', async () => {
        // names 含 vteam-plan 但不含绑定的 product 候选 → 内部候选未声明，外部绑定胜出。
        capsWith(true, ['vteam-plan']);
        selectMemberAgent('build');
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('build');
      });

      it('绑定候选不在能力位 + 无外部绑定 → 省略 agent 键（内部候选受能力位门控）', async () => {
        capsWith(true, ['vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(
          Object.prototype.hasOwnProperty.call(execPayload(), 'agent'),
        ).toBe(false);
      });

      it('门假 + 无外部绑定 → 省略 agent 键', async () => {
        capsWith(false, ['vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(
          Object.prototype.hasOwnProperty.call(execPayload(), 'agent'),
        ).toBe(false);
      });
    });

    describe('Todo custom-agent dispatch：agentKey → vteam-<agentKey>（能力位门控不绕过）', () => {
      const capsWith = (enabled: boolean, names: string[]) => {
        prisma.worker.findUnique.mockResolvedValue({
          id: 'w_0000000001',
          status: 'online',
          capabilities: {
            maxInstances: 1,
            agentPolicies: { enabled, names },
          },
          defaultModelId: null,
        } as any);
      };
      const selectMemberAgent = (name: string | null) => {
        (prisma as any).teamMember.findFirst.mockImplementation(
          async (q: any) =>
            q?.select?.opencodeAgentName !== undefined
              ? { opencodeAgentName: name }
              : { overrideModelId: null },
        );
      };
      const mockAgentRow = (row: Record<string, unknown>) => {
        prisma.agent.findUnique.mockResolvedValue({
          id: 'a_custom',
          name: '自定义 Agent',
          role: null,
          prompt: '负责专项',
          persona: null,
          agentKey: null,
          defaultModelId: null,
          ...row,
        } as any);
      };
      const execPayload = () => workerClient.execute.mock.calls[0][1] as any;
      const withTask = (extra: Record<string, unknown> = {}) =>
        teamRequest({
          taskContext: { taskId: 't_0000000001', ...extra },
        }) as any;

      it('(a) 自定义 agent + 能力位含 vteam-demo-agent → 下发 vteam-demo-agent', async () => {
        mockAgentRow({ agentKey: 'demo-agent', role: null });
        capsWith(true, ['vteam-demo-agent', 'vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('vteam-demo-agent');
      });

      it('(b) 自定义 agent + 能力位不含候选 → 省略 agent 键（不绕过门控）', async () => {
        mockAgentRow({ agentKey: 'demo-agent', role: null });
        capsWith(true, ['vteam-product']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(
          Object.prototype.hasOwnProperty.call(execPayload(), 'agent'),
        ).toBe(false);
      });

      it('(c) 内置角色 agent（agentKey=role）→ 下发 vteam-<role>（与引入前一致）', async () => {
        mockAgentRow({ agentKey: 'product', role: 'product' });
        capsWith(true, ['vteam-product', 'vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('vteam-product');
      });

      it('(d) 无外部绑定时执行 agent 取内部候选：自定义 agent + 门真 → 仍下发 vteam-demo-agent', async () => {
        mockAgentRow({ agentKey: 'demo-agent', role: null });
        capsWith(true, ['vteam-plan', 'vteam-demo-agent']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('vteam-demo-agent');
      });

      it("(e) 非法 agentKey（'Bad-Key'）→ 不拼出 agent 名（即使能力位含该名也省略）", async () => {
        mockAgentRow({ agentKey: 'Bad-Key', role: null });
        capsWith(true, ['vteam-Bad-Key', 'vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(
          Object.prototype.hasOwnProperty.call(execPayload(), 'agent'),
        ).toBe(false);
      });

      it('(f) 无外部绑定 + agentKey=plan → 下发 vteam-plan（内部候选由绑定角色决定）', async () => {
        mockAgentRow({ agentKey: 'plan', role: null });
        capsWith(true, ['vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('vteam-plan');
      });
    });

    // agent-selection 新契约（本次变更，取代旧 4 条规范契约）：
    // (1) 成员显式外部绑定 opencodeAgentName 恒胜出；
    // (2) 无外部绑定时取内部策略候选 vteam-<agentKey>，须被 worker 能力位声明；
    // (3) 两者皆无 → 省略 agent 键（引擎默认）。
    describe('agent-selection precedence（3 条规范契约：外部绑定 > 内部候选 > 省略）', () => {
      const capsWith = (enabled: boolean, names: string[]) => {
        prisma.worker.findUnique.mockResolvedValue({
          id: 'w_0000000001',
          status: 'online',
          capabilities: {
            maxInstances: 1,
            agentPolicies: { enabled, names },
          },
          defaultModelId: null,
        } as any);
      };
      const selectMemberAgent = (name: string | null) => {
        (prisma as any).teamMember.findFirst.mockImplementation(
          async (q: any) =>
            q?.select?.opencodeAgentName !== undefined
              ? { opencodeAgentName: name }
              : { overrideModelId: null },
        );
      };
      const mockAgentRow = (row: Record<string, unknown>) => {
        prisma.agent.findUnique.mockResolvedValue({
          id: 'a_product',
          name: '产品经理',
          role: 'product',
          prompt: '负责需求',
          persona: null,
          defaultModelId: null,
          ...row,
        } as any);
      };
      const execPayload = () => workerClient.execute.mock.calls[0][1] as any;
      const withTask = (extra: Record<string, unknown> = {}) =>
        teamRequest({
          taskContext: { taskId: 't_0000000001', ...extra },
        }) as any;

      it('rule 4 (pure)：agentKey 缺席 → 无候选（resolvePolicyAgentCandidate 返回 null）', () => {
        expect(resolvePolicyAgentCandidate({ agentKey: null })).toBeNull();
      });

      it('rule 1：成员外部绑定 "Sisyphus - ultraworker" 胜出——即使内部候选被 worker 支持', async () => {
        mockAgentRow({ agentKey: 'demo-agent', role: null });
        capsWith(true, ['vteam-demo-agent', 'vteam-plan']);
        selectMemberAgent('Sisyphus - ultraworker');
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('Sisyphus - ultraworker');
      });

      it('rule 2：无外部绑定 + 候选被 worker 支持 → 内部候选胜出', async () => {
        mockAgentRow({ agentKey: 'demo-agent', role: null });
        capsWith(true, ['vteam-demo-agent', 'vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('vteam-demo-agent');
      });

      it('rule 2b：外部绑定 + 候选未被 worker 支持 → 外部绑定胜出', async () => {
        mockAgentRow({ agentKey: 'demo-agent', role: null });
        capsWith(false, ['vteam-demo-agent']);
        selectMemberAgent('plan');
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('plan');
      });

      it('rule 3：无外部绑定 + 候选未被 worker 支持 → 省略 agent 键（引擎默认）', async () => {
        mockAgentRow({ agentKey: 'demo-agent', role: null });
        capsWith(true, ['vteam-product']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(
          Object.prototype.hasOwnProperty.call(execPayload(), 'agent'),
        ).toBe(false);
      });

      it('rule 3b：候选缺席（agentKey 空）+ 无外部绑定 → 省略 agent 键（引擎默认）', async () => {
        mockAgentRow({ agentKey: null, role: null });
        capsWith(true, ['vteam-product', 'vteam-plan']);
        selectMemberAgent(null);
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(
          Object.prototype.hasOwnProperty.call(execPayload(), 'agent'),
        ).toBe(false);
      });

      it('rule 3c：候选缺席（agentKey 空）+ 外部绑定 → 外部绑定胜出', async () => {
        mockAgentRow({ agentKey: null, role: null });
        capsWith(true, ['vteam-product', 'vteam-plan']);
        selectMemberAgent('plan');
        const d = createDispatcher();
        await d.dispatch(withTask());
        expect(execPayload().agent).toBe('plan');
      });
    });

    it('缺 teamId → throw 400 TEAM_SESSION_MISSING_DIMENSION（不触碰 worker 链路）', async () => {
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      let caught: unknown = null;
      try {
        await d.dispatch({
          messageId: 'm_1',
          channelId: 'c_1',
          taskId: '',
          text: 'hi',
          targets: [
            {
              agentId: 'a_product',
              instanceId: 'tmm_0000000001',
              sessionId: null,
            },
          ],
        } as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect((caught as any)?.response?.code).toBe(
        'TEAM_SESSION_MISSING_DIMENSION',
      );
      expect((caught as any)?.status).toBe(400);
      expect(workerClient.execute).not.toHaveBeenCalled();
      expect(
        (sessionLifecycle as any).ensureTeamSession,
      ).not.toHaveBeenCalled();
    });

    it('缺 target.instanceId → 报错（teamMemberId 无回退），不建会话', async () => {
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));
      await d.dispatch(
        teamRequest({
          targets: [{ agentId: 'a_product', sessionId: null }],
        }) as any,
      );
      expect(errors).toHaveLength(1);
      expect(
        (sessionLifecycle as any).ensureTeamSession,
      ).not.toHaveBeenCalled();
      expect(workerClient.execute).not.toHaveBeenCalled();
    });

    it('resolveTeamMainMember：mainAgentMemberId → 该成员，否则首位（seq 升序）；空名册/无团队 → null', async () => {
      const d = createDispatcher();
      (prisma as any).team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      (prisma as any).teamMember.findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'tmm_main', agentId: 'a_product' });
      expect(await d.resolveTeamMainMember('tm_0000000001')).toEqual({
        memberId: 'tmm_main',
        agentId: 'a_product',
      });

      (prisma as any).team.findUnique.mockResolvedValue({
        mainAgentMemberId: null,
      });
      (prisma as any).teamMember.findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'tmm_first', agentId: 'a_developer' });
      expect(await d.resolveTeamMainMember('tm_0000000001')).toEqual({
        memberId: 'tmm_first',
        agentId: 'a_developer',
      });
      expect((prisma as any).teamMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ seq: 'asc' }, { id: 'asc' }] }),
      );

      (prisma as any).team.findUnique.mockResolvedValue(null);
      expect(await d.resolveTeamMainMember('tm_missing')).toBeNull();
    });

    it('buildTeamMainTrigger：主成员 + 即建会话，会话 id 回填触发目标', async () => {
      const d = createDispatcher();
      (prisma as any).team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_0000000001',
      });
      (prisma as any).teamMember.findFirst = jest
        .fn()
        .mockResolvedValue({ id: 'tmm_0000000001', agentId: 'a_product' });
      expect(await d.buildTeamMainTrigger('tm_0000000001')).toEqual({
        agentId: 'a_product',
        instanceId: 'tmm_0000000001',
        sessionId: 's_team_0000000001',
      });
      expect((sessionLifecycle as any).ensureTeamSession).toHaveBeenCalledWith(
        'tm_0000000001',
        'tmm_0000000001',
      );
    });

    it('team task.completed 回流：私聊频道落库（taskId 空 + senderInstanceId=成员），team: 作用域注销', async () => {
      const d = createDispatcher();
      d.registerExecution(
        'w_0000000001',
        'team:tm_0000000001',
        'tmm_0000000001',
      );
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_product',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      } as any);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_dm_team',
        type: 'private',
      } as any);
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.message.create.mockResolvedValue(
        messageRow({ channelId: 'c_dm_team' }) as any,
      );
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      await d.handleTaskCompleted({
        sessionId: 's_team_0000000001',
        agentId: 'a_product',
        workerId: 'w_0000000001',
        text: '团队直聊回复',
      } as any);

      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dm_team',
            taskId: null,
            senderId: 'a_product',
            senderInstanceId: 'tmm_0000000001',
          }),
        }),
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'channel', id: 'c_dm_team' },
      );
      expect(finals).toHaveLength(1);
      expect(
        d.isAgentExecuting('w_0000000001', 'team:tm_0000000001'),
      ).toBeNull();
    });

    it('team_group 触发：prompt 注入 TEAM 指令（含 teamId 传参与 taskId 禁令），不含任务版 GROUP_TRIGGER', async () => {
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      const prompt = workerClient.execute.mock.calls[0][1].prompt[0]
        .text as string;
      expect(prompt).toContain(TEAM_GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).toContain('禁止传递 taskId 参数');
      expect(prompt).not.toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).not.toContain(
        'vteam_chat_history / vteam_doclib / vteam_task_context',
      );
    });

    it('触发消息带图片附件 → execute 携带 attachments + prompt 追加图片指引', async () => {
      (prisma.message as any).findUnique = jest.fn().mockResolvedValue({
        attachmentUrl: '/uploads/uuid-1.png',
        attachmentName: 'shot.png',
        attachmentType: 'png',
      } as any);
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      const execArgs = workerClient.execute.mock.calls[0][1] as {
        prompt: Array<{ text: string }>;
        attachments?: unknown;
      };
      expect(execArgs.attachments).toEqual([
        { url: '/uploads/uuid-1.png', mime: 'image/png', filename: 'shot.png' },
      ]);
      expect(execArgs.prompt[0].text).toContain('【附件图片】');
      expect(execArgs.prompt[0].text).toContain('shot.png');
    });

    it('触发消息带非图片附件（pdf）→ 不携带 attachments，纯文本分派不变', async () => {
      (prisma.message as any).findUnique = jest.fn().mockResolvedValue({
        attachmentUrl: '/uploads/uuid-2.pdf',
        attachmentName: 'doc.pdf',
        attachmentType: 'pdf',
      } as any);
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      const execArgs = workerClient.execute.mock.calls[0][1] as {
        prompt: Array<{ text: string }>;
        attachments?: unknown;
      };
      expect(execArgs.attachments).toBeUndefined();
      expect(execArgs.prompt[0].text).not.toContain('【附件图片】');
    });

    it('team-mode 团队上下文行：chat_history 与 group_post 均传 teamId', async () => {
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      const prompt = workerClient.execute.mock.calls[0][1].prompt[0]
        .text as string;
      expect(prompt).toContain(
        '需要群聊历史时调用 vteam_chat_history（传 teamId）；需要向群聊发布时调用 vteam_group_post（传 teamId）',
      );
    });

    it('team-mode 私聊触发：不注入 TEAM 群聊指令，但保留团队上下文行', async () => {
      prisma.chatChannel.findUnique.mockResolvedValue({
        id: 'c_0000000001',
        type: 'private',
      } as any);
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      const prompt = workerClient.execute.mock.calls[0][1].prompt[0]
        .text as string;
      expect(prompt).not.toContain(TEAM_GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).not.toContain(GROUP_TRIGGER_INSTRUCTION);
      expect(prompt).toContain('【团队上下文】');
    });

    it('team-mode system 参数规则：5 个 team-free 工具传 teamId、禁 taskId，selfInstanceId 为 tmm_ 成员 id', async () => {
      const d = createDispatcher();
      await d.dispatch(teamRequest() as any);
      const system = workerClient.execute.mock.calls[0][1].system as string;
      expect(system).toContain(TEAM_SYSTEM_RECEPTION_INSTRUCTION);
      expect(system).toContain('绝不传 taskId');
      expect(system).toContain('tmm_ 前缀');
    });
  });

  describe('Todo7 finalize 收敛 team-only（任务终态分支删除）', () => {
    it('任务归因回流走团队唯一路径：团队会话 + taskId 归因 → 落成员 DM（taskId 照写）+ emitFinal scope=team', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_product',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      } as any);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_dm_team',
        type: 'private',
      } as any);
      prisma.message.create.mockResolvedValue(
        messageRow({ channelId: 'c_dm_team' }) as any,
      );
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '任务完成',
        parts: [{ type: 'text', text: '任务完成' }],
      });

      expect(prisma.chatChannel.findFirst).toHaveBeenCalledWith({
        where: { teamId: 'tm_0000000001', teamMemberId: 'tmm_0000000001' },
        select: { id: true, type: true },
      });
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channelId: 'c_dm_team',
            taskId: request.taskId,
            senderInstanceId: 'tmm_0000000001',
          }),
        }),
      );
      expect(realtime.broadcast).toHaveBeenCalledWith(
        EVENT_TYPES.CHAT_MESSAGE_NEW,
        expect.anything(),
        { type: 'channel', id: 'c_dm_team' },
      );
      expect(finals).toEqual([
        {
          taskId: 'team:tm_0000000001',
          agentId: 'a_product',
          messageId: 'm_0000000002',
          text: '任务完成',
        },
      ]);
    });

    it('team_group 回退保留：任务归因 + team_group 频道 → 跳过落库 + emitFinal scope=team', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_product',
        teamId: 'tm_0000000001',
        teamMemberId: 'tmm_0000000001',
      } as any);
      prisma.chatChannel.findFirst.mockResolvedValue({
        id: 'c_tgroup',
        type: 'team_group',
      } as any);
      const d = createDispatcher();
      const finals: unknown[] = [];
      d.onFinal((e) => finals.push(e));

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_0000000001',
        text: '结论',
      });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(finals).toEqual([
        {
          taskId: 'team:tm_0000000001',
          agentId: 'a_product',
          messageId: '',
          text: '结论',
        },
      ]);
    });

    it('会话无团队归属 → 跳过落库并 emitError（不静默丢失）', async () => {
      prisma.session.findUnique.mockResolvedValue({
        agentId: 'a_product',
        teamMemberId: null,
      } as any);
      const d = createDispatcher();
      const errors: unknown[] = [];
      d.onError((e) => errors.push(e));

      await d.handleTaskCompleted({
        taskId: request.taskId,
        agentId: 'a_product',
        sessionId: 's_legacy',
        text: '存量任务回复',
      });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
    });
  });
});
