import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ROLE_BOUNDARIES,
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
import {
  capabilityKeyForTool,
  isCapabilityGranted,
} from '../common/constants/platform-capability.constants';
import { BUILTIN_ROLE_CAPABILITY_MAPS } from '../common/constants/agent-role.constants';
import { PLATFORM_MCP_ERRORS } from './platform-mcp.constants';
import { PlatformMcpService } from './platform-mcp.service';
import { PlatformToolPermissionService } from './platform-tool-permission.service';

/**
 * Todo 9 中央可证伪证明：role×tool authority matrix（2026-09-20 改造）。
 *
 * 三层证据，全部断言**判定值**（allow/deny），不读日志：
 * ① 28 工具 × 7 角色的**服务端工具权限门**矩阵（2026-09-21 capability model：
 *    `PlatformToolPermissionService.assertToolAllowed` 是平台工具唯一闸门）：逐格调用
 *    **真实生产门**，成员 → AgentRole(`capabilities`) → 业务能力点判定； expect 由
 *    岗位矩阵给出（与 seed/migration 同口径：`BUILTIN_ROLE_CAPABILITY_MAPS`，
 *    2026-09-22 按角色定制——PM 全 27 点 true、其余按 ROLE_BOUNDARIES 全组放行派生）。
 *    负格（未授权）显式保留；空集守卫 + allow/deny 双非空防「空转假绿」。
 *    `git_*`/`browser` 非平台注册工具，无 `tools/call` 面，不进矩阵（见
 *    `CONTRACT-tool-naming-and-identity.md` §5）。
 * ② 非主实例成功：真实 `PlatformMcpService.taskCreate` 与真实 `TasksService.transitionByAgent`
 *    在非主 selfInstanceId 下**不再**抛出 `TASK_STATUS_MAIN_AGENT_ONLY`（身份门已移除）。
 * ③ 主 Agent happy path：经真实 `PlatformMcpService` 依次 create→start→
 *    plan_complete→mark-pending-review，记录每步判定值。
 *
 * 产物 `.omo/evidence/server-gate-removal-tool-authority/task-9-matrix.json` 由本 spec 写入
 * （服务端门矩阵 + 服务层断言）；live 真栈 happy path 由 `scripts/prove-authority-matrix.sh`
 * 运行本 spec 后合并写入同一文件（单一可复现命令）。
 */

const ROLES = Object.keys(ROLE_BOUNDARIES).sort() as VteamAgentName[];
const PLATFORM_TOOLS: readonly string[] = [...VTEAM_MCP_TOOL_NAMES];
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

/** `vteam-product` → `tmm_product`：矩阵每一行对应一个可解析成员。 */
function memberIdOf(agent: string): string {
  return `tmm_${agent.slice('vteam-'.length)}`;
}

/** 内置角色按岗位能力矩阵（与 seed/migration 同口径：BUILTIN_ROLE_CAPABILITY_MAPS，2026-09-22 按角色定制——PM 全开、其余按 ROLE_BOUNDARIES 派生）。 */
function builtinCapabilities(agent: string): Record<string, boolean> {
  const key = agent.slice('vteam-'.length);
  const map = BUILTIN_ROLE_CAPABILITY_MAPS[key];
  if (!map) {
    throw new Error(`内置岗位缺少定制能力矩阵: ${key}`);
  }
  return { ...map };
}

/**
 * 真实生产门：真实 `PlatformToolPermissionService`；prisma 只 stub 成员→AgentRole 行
 * （key/capabilities，内置按岗位定制矩阵），与运行时 `resolveToolCallerId` 供出的形状一致。
 * 可选 `overrides` 覆盖某角色的能力矩阵（证明矩阵可变更）。
 */
function buildRealPermissionGate(
  overrides: Record<string, Record<string, boolean>> = {},
): {
  gate: PlatformToolPermissionService;
  prisma: { teamMember: { findUnique: jest.Mock } };
} {
  const prisma = {
    teamMember: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const agentKey = where.id.startsWith('tmm_')
          ? where.id.slice('tmm_'.length)
          : null;
        if (!agentKey) {
          return null;
        }
        const agent = `vteam-${agentKey}`;
        if (!(agent in ROLE_BOUNDARIES)) {
          return { role: null };
        }
        return {
          role: {
            id: `ar_${agentKey}`,
            key: agentKey,
            capabilities: overrides[agent] ?? builtinCapabilities(agent),
          },
        };
      }),
    },
  };
  return {
    gate: new PlatformToolPermissionService(prisma as never),
    prisma,
  };
}

/** 单格判定：真实门放行 = allow，403 = deny。 */
async function decideCell(
  gate: PlatformToolPermissionService,
  agent: string,
  tool: string,
): Promise<{ action: 'allow' | 'deny'; message: string | null }> {
  const bare = tool.replace(/^vteam_/, '');
  try {
    await gate.assertToolAllowed(memberIdOf(agent), bare);
    return { action: 'allow', message: null };
  } catch (err) {
    const response = (err as { getResponse?: () => unknown }).getResponse?.();
    const body =
      response && typeof response === 'object'
        ? (response as { message?: unknown }).message
        : undefined;
    return { action: 'deny', message: typeof body === 'string' ? body : null };
  }
}

/** 逐格评估：source-derived expect + 真实服务端门 actual。 */
async function evaluateMatrix(
  gate: PlatformToolPermissionService,
): Promise<MatrixCell[]> {
  const cells: MatrixCell[] = [];
  for (const agent of ROLES) {
    const matrix = builtinCapabilities(agent);
    for (const tool of PLATFORM_TOOLS) {
      const decision = await decideCell(gate, agent, tool);
      const capabilityKey = capabilityKeyForTool(tool);
      const expected =
        capabilityKey === null
          ? 'deny'
          : isCapabilityGranted(matrix, capabilityKey);
      cells.push({
        agent,
        tool,
        expect: expected ? 'allow' : 'deny',
        actual: decision.action,
        message: decision.message,
      });
    }
  }
  return cells;
}

/** 期望值非空且双向可判别：负格显式存在，杜绝「只断言 allow 格」。 */
function assertDiscriminating(cells: MatrixCell[]): void {
  const expectedCells = ROLES.length * PLATFORM_TOOLS.length;
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

  describe('① 服务端工具权限门矩阵：每一 role×tool 格的实际判定 === source-derived 期望', () => {
    it('196 格逐格匹配；allow/deny 双非空；负格显式存在；空转守卫记录迭代数', async () => {
      const { gate } = buildRealPermissionGate();
      const cells = await evaluateMatrix(gate);
      assertDiscriminating(cells);

      const mismatches = cells.filter((c) => c.actual !== c.expect);
      expect(mismatches).toEqual([]);

      const allow = cells.filter((c) => c.expect === 'allow').length;
      const deny = cells.filter((c) => c.expect === 'deny').length;
      // 空转证明：矩阵大小必须是 roles×tools 的完整笛卡尔积，不是空集。
      expect(cells.length).toBe(ROLES.length * PLATFORM_TOOLS.length);
      expect(cells.length).toBeGreaterThan(0);
      // 逐格断言（失败时给出精确坐标）——不得只断言 allow 格。
      for (const cell of cells) {
        expect(`${cell.agent}|${cell.tool}=${cell.actual}`).toBe(
          `${cell.agent}|${cell.tool}=${cell.expect}`,
        );
      }

      writeEvidence({
        matrix: {
          source:
            'PlatformToolPermissionService.assertToolAllowed (server-side gate, todo 3)',
          roles: ROLES,
          tools: PLATFORM_TOOLS,
          expectedCellCount: ROLES.length * PLATFORM_TOOLS.length,
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

    it('负对照：任何角色都未列入的 MCP 工具 → deny + 稳定码（不可只靠 allow 格）', async () => {
      const { gate } = buildRealPermissionGate();
      for (const agent of ROLES) {
        await expect(
          gate.assertToolAllowed(memberIdOf(agent), 'member_remove'),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            code: PLATFORM_MCP_ERRORS.TOOL_NOT_PERMITTED,
          }),
        });
      }
    });

    it('具名负格：未授权角色对 formerly-gated 工具一律 deny（显式断言）', async () => {
      const { gate } = buildRealPermissionGate();
      const negatives: Array<[VteamAgentName, string]> = [
        ['vteam-architect', 'vteam_task_create'],
        ['vteam-developer', 'vteam_task_create'],
        ['vteam-tester', 'vteam_task_transition'],
        ['vteam-librarian', 'vteam_skill_create'],
        ['vteam-plan', 'vteam_task_create'],
        ['vteam-plan', 'vteam_question_confirm'],
        ['vteam-product', 'vteam_plan_complete'],
        ['vteam-product', 'vteam_skill_create'],
      ];
      for (const [agent, tool] of negatives) {
        expect(
          Object.prototype.hasOwnProperty.call(
            ROLE_BOUNDARIES[agent].toolAllows,
            tool,
          ),
        ).toBe(false);
        const d = await decideCell(gate, agent, tool);
        expect(`${agent}/${tool}=${d.action}`).toBe(`${agent}/${tool}=deny`);
      }
    });

    it('矩阵可变更：改岗位 capabilities 一格即翻转判定（非角色名硬编码）', async () => {
      const base = buildRealPermissionGate();
      expect(
        (await decideCell(base.gate, 'vteam-product', 'vteam_doclib')).action,
      ).toBe('allow');
      expect(
        (await decideCell(base.gate, 'vteam-architect', 'vteam_doclib')).action,
      ).toBe('allow');
      // 只改 product 的 capabilities：doc.read 显式 false（其余保持该岗定制矩阵）。
      const productCaps = builtinCapabilities('vteam-product');
      const edited = buildRealPermissionGate({
        'vteam-product': { ...productCaps, 'doc.read': false },
      });
      expect(
        (await decideCell(edited.gate, 'vteam-product', 'vteam_doclib')).action,
      ).toBe('deny');
      // 负对照：同一矩阵仍放行 group_post（证明翻转来自该格，非全局关闸）。
      expect(
        (await decideCell(edited.gate, 'vteam-product', 'vteam_group_post'))
          .action,
      ).toBe('allow');
      // 未改岗位的角色不受影响。
      expect(
        (await decideCell(edited.gate, 'vteam-architect', 'vteam_doclib'))
          .action,
      ).toBe('allow');
    });
  });

  describe('② 非主实例成功：真实服务层不再返回身份拒绝', () => {
    it('非主 task_create 触达 createByAgent（无 TASK_STATUS_MAIN_AGENT_ONLY）', async () => {
      allowWorkerAs(nonMainId);
      tasksService.createByAgent.mockResolvedValue({
        id: 't_new',
        teamId: 'tm_1',
      });

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
        .mockResolvedValue({
          ...taskRow({ status: 'in_progress', version: 2 }),
        });
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

      const result = await realTasks.transitionByAgent(
        taskId,
        nonMainId,
        'start',
      );

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
    it('create → start → plan_complete → mark-pending-review 全部成功', async () => {
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
      steps.push({
        step: 'task_transition.start',
        ok: !!started,
        result: started,
      });

      // 3) plan_complete
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

      // 4) mark-pending-review
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

      writeEvidence({
        mainHappyPath: { steps, allStepsOk: steps.every((s) => s.ok) },
      });
      expect(steps.every((s) => s.ok)).toBe(true);
      expect(steps.map((s) => s.step)).toEqual([
        'task_create',
        'task_transition.start',
        'plan_complete',
        'task_transition.mark-pending-review',
      ]);
    });
  });
});

/* ------------------------------------------------------------------ helpers */

function taskRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
      base = JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8')) as Record<
        string,
        unknown
      >;
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
