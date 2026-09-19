import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ROLE_BOUNDARIES,
  VTEAM_BROWSER_TOOL_NAMES,
  VTEAM_GIT_TOOL_NAMES,
  VTEAM_MCP_TOOL_NAMES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import { TASK_ERRORS } from '../common/constants/task.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { WorkerDispatcher } from '../chat/worker-dispatcher';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { WorkerClient } from '../workers/worker.client';
import { IssuesService } from '../issues/issues.service';
import { QuestionsService } from '../questions/questions.service';
import { GitReposService } from '../git-repos/git-repos.service';
import { SessionLifecycleService } from '../workers/session-lifecycle.service';
import { PlanLifecycleService } from '../tasks/plan-lifecycle.service';
import { TasksService } from '../tasks/tasks.service';
import { ExecutionPolicyService } from '../execution-policies/execution-policy.service';
import {
  evaluateToolCall,
  type EvaluateToolCallParams,
  type RolesDoc,
} from '../../../worker/src/role-guard/policy';
import { PlatformMcpService } from './platform-mcp.service';

/**
 * Todo 9 中央可证伪证明：role×tool authority matrix。
 *
 * 三层证据，全部断言**判定值**（allow/deny），不读日志：
 * ① 259 格 worker-guard 矩阵：rolesDoc 来自真实 `ExecutionPolicyService.buildAgentPolicies()`
 *    （即 `/agent-policies` 下发的 guard 载荷），逐格喂给**真实 worker guard**
 *    `worker/src/role-guard/policy.ts::evaluateToolCall`，expect = `ROLE_BOUNDARIES[*].toolAllows`
 *    成员资格。负格（未授权）显式保留；空集守卫 + allow/deny 双非空防「空转假绿」。
 * ② 非主实例成功：真实 `PlatformMcpService.taskCreate` 与真实 `TasksService.transitionByAgent`
 *    在非主 selfInstanceId 下**不再**抛出 `TASK_STATUS_MAIN_AGENT_ONLY`（身份门已移除）。
 * ③ 主 Agent happy path：经真实 `PlatformMcpService` 依次 create→start→plan_mode→
 *    plan_complete→mark-pending-review，记录每步判定值。
 *
 * 产物 `.omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json` 由本 spec 写入
 * （worker 矩阵 + 服务层断言）；live 真栈 happy path 由 `scripts/e2e-authority-matrix.sh`
 * 运行本 spec 后合并写入同一文件（单一可复现命令）。
 */

const ROLES = Object.keys(ROLE_BOUNDARIES).sort() as VteamAgentName[];
const TOOLS: readonly string[] = [
  ...VTEAM_MCP_TOOL_NAMES,
  ...VTEAM_GIT_TOOL_NAMES,
  ...VTEAM_BROWSER_TOOL_NAMES,
];
const EVIDENCE_FILE = path.resolve(
  __dirname,
  '../../../.omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json',
);

interface MatrixCell {
  agent: string;
  tool: string;
  expect: 'allow' | 'deny';
  actual: 'allow' | 'deny';
  message: string | null;
}

/** 真实 rolesDoc：server 发射的 guard 载荷（与 `/agent-policies` 同一构造路径）。 */
async function buildRealRolesDoc(): Promise<RolesDoc> {
  const svc = new ExecutionPolicyService(
    {
      agent: { findMany: jest.fn().mockResolvedValue([]) },
      executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
    } as never,
    {} as never,
    { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
  );
  const policies = await svc.buildAgentPolicies();
  return {
    enabled: policies.guard.enabled,
    roles: policies.guard.roles,
  } as unknown as RolesDoc;
}

/** 逐格评估：source-derived expect + 真实 guard actual。 */
function evaluateMatrix(rolesDoc: RolesDoc): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const agent of ROLES) {
    const allowed = new Set(Object.keys(ROLE_BOUNDARIES[agent].toolAllows));
    for (const tool of TOOLS) {
      const decision = evaluateToolCall({
        rolesDoc,
        session: { agent, dir: '/data/vteam-worker' },
        tool,
        args: {},
      });
      cells.push({
        agent,
        tool,
        expect: allowed.has(tool) ? 'allow' : 'deny',
        actual: decision.action,
        message: decision.action === 'deny' ? decision.message : null,
      });
    }
  }
  return cells;
}

/** 期望值非空且双向可判别：负格显式存在，杜绝「只断言 allow 格」。 */
function assertDiscriminating(cells: MatrixCell[]): void {
  const expectedCells = ROLES.length * TOOLS.length;
  expect(expectedCells).toBeGreaterThan(0);
  expect(cells).toHaveLength(expectedCells);
  const allow = cells.filter((c) => c.expect === 'allow').length;
  const deny = cells.filter((c) => c.expect === 'deny').length;
  expect(allow).toBeGreaterThan(0);
  expect(deny).toBeGreaterThan(0);
}

describe('role×tool authority matrix (server-gate-removal-tool-authority todo 9)', () => {
  let service: PlatformMcpService;
  let prisma: Record<string, any>;
  let idGen: { nextId: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let tasksService: {
    transitionByAgent: jest.Mock;
    createByAgent: jest.Mock;
    updateTeam: jest.Mock;
  };
  let planLifecycle: { completePlan: jest.Mock; autoEnsureRow: jest.Mock };
  let workerDispatcher: {
    dispatchAgentMention: jest.Mock;
    isAgentExecuting: jest.Mock;
  };

  const taskId = 't_0000000001';
  const workerId = 'w_0000000001';
  const ctx = { workerId };
  const mainId = 'tmm_main';
  const nonMainId = 'tmm_nonmain';

  beforeEach(async () => {
    prisma = {
      session: { findFirst: jest.fn(), findMany: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
      artifact: { findMany: jest.fn().mockResolvedValue([]) },
      artifactVersion: { findMany: jest.fn().mockResolvedValue([]) },
      task: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
      team: { findUnique: jest.fn() },
      teamMember: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
        update: jest.fn(),
      },
      teamUserMember: { findMany: jest.fn() },
      worker: { findUnique: jest.fn() },
      memory: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      agent: { findUnique: jest.fn() },
      agentQuestion: { findMany: jest.fn() },
      plan: { findUnique: jest.fn(), first: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };
    idGen = { nextId: jest.fn() };
    realtime = { broadcast: jest.fn().mockResolvedValue({ id: 'ev_1' }) };
    tasksService = {
      transitionByAgent: jest.fn(),
      createByAgent: jest.fn(),
      updateTeam: jest.fn(),
    };
    planLifecycle = {
      completePlan: jest.fn(),
      autoEnsureRow: jest.fn(),
    };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
      isAgentExecuting: jest.fn().mockReturnValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformMcpService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: RealtimeService, useValue: realtime },
        { provide: WorkerClient, useValue: { fetchFile: jest.fn() } },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: ArtifactsService, useValue: { append: jest.fn() } },
        {
          provide: IssuesService,
          useValue: {
            createByAgent: jest.fn(),
            findAllByAgent: jest.fn(),
            findOneByAgent: jest.fn(),
            updateByAgent: jest.fn(),
            transitionByAgent: jest.fn(),
          },
        },
        { provide: TasksService, useValue: tasksService },
        {
          provide: QuestionsService,
          useValue: { confirmByAgent: jest.fn(), createForPlatform: jest.fn() },
        },
        { provide: GitReposService, useValue: { findAll: jest.fn() } },
        { provide: ExecutionPolicyService, useValue: { resolveByAgent: jest.fn() } },
        { provide: PlanLifecycleService, useValue: planLifecycle },
      ],
    }).compile();
    service = module.get(PlatformMcpService);
  });

  /** 归属校验通过：worker 有任务归属团队会话，绑定指定成员。 */
  const allowWorkerAs = (instanceId: string) => {
    prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
    prisma.session.findFirst.mockResolvedValue({
      id: 's_1',
      agentId: 'a_dev',
      teamMemberId: instanceId,
    });
  };

  describe('① worker-guard 矩阵：每一 role×tool 格的实际判定 === source-derived 期望', () => {
    it('259 格逐格匹配；allow/deny 双非空；负格显式存在；空转守卫记录迭代数', async () => {
      const rolesDoc = await buildRealRolesDoc();
      const cells = evaluateMatrix(rolesDoc);
      assertDiscriminating(cells);

      const mismatches = cells.filter((c) => c.actual !== c.expect);
      expect(mismatches).toEqual([]);

      const allow = cells.filter((c) => c.expect === 'allow').length;
      const deny = cells.filter((c) => c.expect === 'deny').length;
      // 空转证明：矩阵大小必须是 roles×tools 的完整笛卡尔积，不是空集。
      expect(cells.length).toBe(ROLES.length * TOOLS.length);
      expect(cells.length).toBeGreaterThan(0);
      // 逐格断言（失败时给出精确坐标）——不得只断言 allow 格。
      for (const cell of cells) {
        expect(`${cell.agent}|${cell.tool}=${cell.actual}`).toBe(
          `${cell.agent}|${cell.tool}=${cell.expect}`,
        );
      }

      writeEvidence({
        matrix: {
          roles: ROLES,
          tools: TOOLS,
          expectedCellCount: ROLES.length * TOOLS.length,
          iteratedCellCount: cells.length,
          allowCellCount: allow,
          denyCellCount: deny,
          allCellsMatch: mismatches.length === 0,
          cells,
        },
      });
      expect(allow).toBeGreaterThan(0);
      expect(deny).toBeGreaterThan(0);
    });

    it('负对照：任何角色都未列入的 MCP 工具 → deny（不可只靠 allow 格）', async () => {
      const rolesDoc = await buildRealRolesDoc();
      for (const agent of ROLES) {
        const d = evaluateToolCall({
          rolesDoc,
          session: { agent, dir: '/data/vteam-worker' },
          tool: 'vteam_member_remove',
          args: {},
        } as EvaluateToolCallParams);
        expect(d.action).toBe('deny');
        expect((d as { message: string }).message).toContain('越界拦截');
      }
    });

    it('具名负格：未授权角色对 formerly-gated 工具一律 deny（显式断言）', async () => {
      const rolesDoc = await buildRealRolesDoc();
      const negatives: Array<[VteamAgentName, string]> = [
        ['vteam-architect', 'vteam_task_create'],
        ['vteam-architect', 'vteam_plan_mode'],
        ['vteam-developer', 'vteam_plan_mode'],
        ['vteam-developer', 'vteam_task_create'],
        ['vteam-tester', 'vteam_task_transition'],
        ['vteam-librarian', 'vteam_skill_create'],
        ['vteam-plan', 'vteam_task_create'],
        ['vteam-plan', 'vteam_question_confirm'],
        ['vteam-product', 'vteam_plan_complete'],
        ['vteam-product', 'vteam_skill_create'],
      ];
      for (const [agent, tool] of negatives) {
        expect(Object.prototype.hasOwnProperty.call(ROLE_BOUNDARIES[agent].toolAllows, tool)).toBe(false);
        const d = evaluateToolCall({
          rolesDoc,
          session: { agent, dir: '/data/vteam-worker' },
          tool,
          args: {},
        });
        expect(`${agent}/${tool}=${d.action}`).toBe(`${agent}/${tool}=deny`);
      }
    });
  });

  describe('② 非主实例成功：真实服务层不再返回身份拒绝', () => {
    it('非主 task_create 触达 createByAgent（无 TASK_STATUS_MAIN_AGENT_ONLY）', async () => {
      allowWorkerAs(nonMainId);
      tasksService.createByAgent.mockResolvedValue({ id: 't_new', teamId: 'tm_1' });

      const result = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: nonMainId,
        title: '非主建任务',
      });

      expect(result).toEqual({ id: 't_new', teamId: 'tm_1' });
      expect(tasksService.createByAgent).toHaveBeenCalledWith(
        nonMainId,
        expect.objectContaining({ teamId: 'tm_1', title: '非主建任务' }),
      );
    });

    it('非主 task_transition（真实 TasksService）start 成功，绝无 TASK_STATUS_MAIN_AGENT_ONLY', async () => {
      const realTasks = buildRealTasksService(prisma, idGen, realtime);
      prisma.task.findUnique
        .mockResolvedValueOnce({ id: taskId, teamId: 'tm_1' })
        .mockResolvedValueOnce({
          ...taskRow({ status: 'pending', version: 1 }),
        })
        .mockResolvedValue({ ...taskRow({ status: 'in_progress', version: 2 }) });
      prisma.team.findUnique.mockResolvedValue({
        id: 'tm_1',
        mainAgentMemberId: mainId,
        currentTaskId: taskId,
        version: 1,
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      prisma.teamMember.findUnique.mockResolvedValue({
        id: mainId,
        alias: 'PM-1',
        agent: { id: 'a_pm', name: 'PM', role: 'project_manager' },
      });
      const tx = mockTransitionTx(prisma);

      const result = await realTasks.transitionByAgent(taskId, nonMainId, 'start');

      expect(result.status).toBe('in_progress');
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(tx.taskEvent.create).toHaveBeenCalled();
      // 显式负断言：非主调用**不得**出现旧身份拒绝码。
      expect(JSON.stringify(result)).not.toContain(
        TASK_ERRORS.TASK_STATUS_MAIN_AGENT_ONLY,
      );
    });
  });

  describe('③ 主 Agent happy path（经真实 PlatformMcpService 方法，逐 step 记判定值）', () => {
    it('create → start → plan_mode → plan_complete → mark-pending-review 全部成功', async () => {
      const steps: Array<{ step: string; ok: boolean; result: unknown }> = [];

      // 1) task_create
      allowWorkerAs(mainId);
      tasksService.createByAgent.mockResolvedValue({
        id: 't_happy',
        teamId: 'tm_1',
        status: 'pending',
      });
      const created = await service.taskCreate(ctx, {
        taskId,
        selfInstanceId: mainId,
        title: 'happy',
      });
      steps.push({ step: 'task_create', ok: !!created, result: created });

      // 2) task_transition start
      tasksService.transitionByAgent.mockResolvedValueOnce({
        id: 't_happy',
        status: 'in_progress',
      });
      const started = await service.taskTransition(ctx, {
        taskId: 't_happy',
        selfInstanceId: mainId,
        action: 'start',
      });
      steps.push({ step: 'task_transition.start', ok: !!started, result: started });

      // 3) plan_mode
      prisma.task.findUnique.mockResolvedValue({ teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({ mainAgentMemberId: mainId });
      prisma.teamMember.findUnique.mockResolvedValue({ opencodeAgentName: null });
      prisma.task.update.mockResolvedValue({ id: 't_happy', planMode: true });
      const planMode = await service.planMode(ctx, {
        taskId: 't_happy',
        selfInstanceId: mainId,
        enabled: true,
      });
      steps.push({ step: 'plan_mode', ok: planMode.planMode === true, result: planMode });

      // 4) plan_complete
      planLifecycle.completePlan.mockResolvedValue({
        plan: { status: 'completed' },
        idempotent: false,
      });
      const planComplete = await service.planComplete(ctx, {
        taskId: 't_happy',
        selfInstanceId: mainId,
      });
      steps.push({
        step: 'plan_complete',
        ok: planComplete.status === 'completed',
        result: planComplete,
      });

      // 5) mark-pending-review
      tasksService.transitionByAgent.mockResolvedValueOnce({
        id: 't_happy',
        status: 'pending_review',
      });
      const pendingReview = await service.taskTransition(ctx, {
        taskId: 't_happy',
        selfInstanceId: mainId,
        action: 'mark-pending-review',
      });
      steps.push({
        step: 'task_transition.mark-pending-review',
        ok: pendingReview.status === 'pending_review',
        result: pendingReview,
      });

      writeEvidence({ mainHappyPath: { steps, allStepsOk: steps.every((s) => s.ok) } });
      expect(steps.every((s) => s.ok)).toBe(true);
      expect(steps.map((s) => s.step)).toEqual([
        'task_create',
        'task_transition.start',
        'plan_mode',
        'plan_complete',
        'task_transition.mark-pending-review',
      ]);
    });
  });
});

/* ------------------------------------------------------------------ helpers */

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't_0000000001',
    title: '任务标题',
    description: null,
    priority: 'medium',
    status: 'pending',
    mainAgentId: 'a_pm',
    mainAgentInstanceId: 'tmm_main',
    managedMode: false,
    executionMode: 'direct',
    backgroundDocs: null,
    teamId: 'tm_1',
    createdBy: 'u_admin',
    createdAt: new Date('2026-08-07T00:00:00Z'),
    startedAt: null,
    pendingReviewAt: null,
    completedAt: null,
    archivedAt: null,
    resetAfterComplete: false,
    planMode: false,
    version: 0,
    ...overrides,
  };
}

function mockTransitionTx(prisma: Record<string, any>): Record<string, any> {
  const tx = {
    task: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    taskEvent: { create: jest.fn().mockResolvedValue({ id: 'te_1' }) },
    session: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    team: { findUnique: jest.fn().mockResolvedValue(null) },
    teamQueue: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    artifact: { findMany: jest.fn().mockResolvedValue([]) },
    artifactVersion: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    message: {
      create: jest.fn().mockImplementation(({ data }: { data: any }) => ({
        id: data.id,
        channelId: data.channelId,
        senderType: data.senderType,
        senderId: data.senderId,
        content: data.content,
        mentions: data.mentions,
        status: data.status,
        createdAt: new Date('2026-08-07T00:00:00Z'),
      })),
    },
  };
  prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
  return tx;
}

function buildRealTasksService(
  prisma: Record<string, any>,
  idGen: { nextId: jest.Mock },
  realtime: { broadcast: jest.Mock },
): TasksService {
  const sessionLifecycle = {
    getInstancesByTeamMember: jest.fn(),
    getInstanceBySession: jest.fn(),
    resetTeamSessionsInTx: jest.fn(),
  };
  const progression = {
    register: jest.fn().mockResolvedValue(undefined),
    unregister: jest.fn(),
    triggerMemoryHarvest: jest.fn().mockResolvedValue(undefined),
  };
  const planLifecycle = { autoEnsureRow: jest.fn().mockResolvedValue({}) };
  return new TasksService(
    prisma as unknown as PrismaService,
    idGen as unknown as IdGeneratorService,
    realtime as unknown as RealtimeService,
    sessionLifecycle as unknown as SessionLifecycleService,
    progression as never,
    planLifecycle as unknown as PlanLifecycleService,
  );
}

/** 合并写入证据文件：保留既有字段（live 段由 shell runner 追加），覆盖本次断言字段。 */
function writeEvidence(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  let base: Record<string, unknown> = {};
  if (fs.existsSync(EVIDENCE_FILE)) {
    try {
      base = JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8')) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const next = {
    ...base,
    ...patch,
    plan: 'server-gate-removal-tool-authority',
    todo: 9,
    generatedBy:
      'server/src/platform-mcp/platform-mcp.authority-matrix.spec.ts (worker matrix + service-level proof)',
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(next, null, 2) + '\n');
}
