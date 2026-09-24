import {
  AGENT_KEY_PATTERN,
  ROLE_BOUNDARIES,
} from '../common/constants/agent.constants';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * third-party-agent-display Todo 4：外部（非 vteam / 引擎自带）agent 的**零发射证明**。
 *
 * UI 对第三方 agent 的诚实声明是"不受 vteam 权限治理"。本 spec 从**服务端发射面**证明
 * 该声明成立：`buildAgentPolicies()`（`GET /agent-policies` 的同一函数，worker 注入与
 * `governed` 标记的唯一来源）产出的 `agents[].name` 与 `guard.roles` 键**绝不包含任何
 * 引擎外部名**。外部 agent 因此在 worker 侧既拿不到策略也不会被 guard 治理——worker 侧
 * pass-through 由 `worker/src/role-guard/policy.spec.ts` 钉住。
 *
 * 断言源（防自证，期望值不取自被测实现）：
 * - 受治理内置集：显式 7 名（与 todo 1 live 证据的 governed 集一致），并与
 *   `ROLE_BOUNDARIES` 键集交叉校验（常量层漂移即红）；
 * - 自定义块：由本 spec 注入的 mock 行（agentKey）推导期望 `vteam-<agentKey>`；
 * - 外部名：本部署真实引擎名（todo 1 live 证据 24 agents − 8 governed，含大小写/
 *   空格/连字符变体），仅用于"缺席"断言——绝不是"受治理名"的来源。
 */
describe('agent-policies 零发射：外部/引擎 agent 名绝不进入策略集（third-party-agent-display Todo 4）', () => {
  /** 受治理内置名（显式硬编码，独立于被测实现；下方与 ROLE_BOUNDARIES 交叉校验）。 */
  const GOVERNED_BUILTINS = [
    'vteam-architect',
    'vteam-developer',
    'vteam-librarian',
    'vteam-plan',
    'vteam-product',
    'vteam-project_manager',
    'vteam-tester',
  ] as const;

  /**
   * 本部署真实引擎外部名（todo 1 证据）。含大写/空格/连字符变体是**刻意**的：
   * guard 与发射面都只做精确键匹配，任何大小写折叠/前缀/模糊匹配都会让这些名字泄漏。
   */
  const EXTERNAL_ENGINE_NAMES = [
    'compaction',
    'summary',
    'title',
    'build',
    'plan',
    'general',
    'explore',
    'librarian',
    'multimodal-looker',
    'oracle',
    'prometheus',
    'Sisyphus',
    'Sisyphus - ultraworker',
    'Sisyphus-Junior',
    'Prometheus - Plan Builder',
    'Atlas - Plan Executor',
    'Metis - Plan Consultant',
    'Momus - Plan Critic',
  ] as const;

  const AGENT_KEY_RE = new RegExp(AGENT_KEY_PATTERN);

  /** 发射名不变式：`vteam-` 前缀 + 合法 agentKey（AGENT_KEY_PATTERN）。 */
  function isGovernedNamespaceName(name: string): boolean {
    if (!name.startsWith('vteam-')) {
      return false;
    }
    return AGENT_KEY_RE.test(name.slice('vteam-'.length));
  }

  function serviceWith(prisma: unknown): ExecutionPolicyService {
    return new ExecutionPolicyService(
      prisma as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
  }

  function emptyDbService(): ExecutionPolicyService {
    return serviceWith({
      agent: { findMany: jest.fn().mockResolvedValue([]) },
      executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
    });
  }

  /** agents 与 guard.roles 两侧的并集名字清单（去重前，便于断言两侧一致）。 */
  function emittedNames(
    policies: Awaited<ReturnType<ExecutionPolicyService['buildAgentPolicies']>>,
  ): { agentNames: string[]; roleKeys: string[] } {
    return {
      agentNames: policies.agents.map((a) => a.name),
      roleKeys: Object.keys(policies.guard.roles),
    };
  }

  /** 外部引擎名（含大小写不敏感/空白规范化变体）在给定名单中零出现。 */
  function expectNoExternalEmission(names: readonly string[]): void {
    const normalize = (value: string) =>
      value.toLowerCase().replace(/\s+/g, '');
    const normalizedNames = names.map(normalize);
    for (const external of EXTERNAL_ENGINE_NAMES) {
      expect(names).not.toContain(external);
      expect(normalizedNames).not.toContain(normalize(external));
    }
    expect(EXTERNAL_ENGINE_NAMES.length).toBeGreaterThan(0);
  }

  describe('纯内置（DB 无自定义行）', () => {
    it('agents[].name 与 guard.roles 键集恰为 7 个受治理内置名（硬编码期望 + 常量交叉校验）', async () => {
      const policies = await emptyDbService().buildAgentPolicies();
      const { agentNames, roleKeys } = emittedNames(policies);

      expect([...agentNames].sort()).toEqual([...GOVERNED_BUILTINS].sort());
      expect([...roleKeys].sort()).toEqual([...GOVERNED_BUILTINS].sort());
      // 期望集本身独立于被测实现：常量键集必须同集（7 名清单漂移即红）。
      expect([...GOVERNED_BUILTINS].sort()).toEqual(
        Object.keys(ROLE_BOUNDARIES).sort(),
      );
    });

    it('不变式：每个发射名都是 vteam- 前缀 + AGENT_KEY_PATTERN 键；违例为空且样本非空', async () => {
      const policies = await emptyDbService().buildAgentPolicies();
      const { agentNames, roleKeys } = emittedNames(policies);
      const allNames = [...agentNames, ...roleKeys];

      const violations = allNames.filter(
        (name) => !isGovernedNamespaceName(name),
      );
      expect(violations).toEqual([]);
      expect(allNames.length).toBeGreaterThan(0);

      // 判别力自检：外部名（含大小写/空格变体）全部违反该不变式，内置名全部满足。
      for (const external of EXTERNAL_ENGINE_NAMES) {
        expect(isGovernedNamespaceName(external)).toBe(false);
      }
      expect(isGovernedNamespaceName('vteam-developer')).toBe(true);
      expect(isGovernedNamespaceName('vteam-project_manager')).toBe(true);
      expect(isGovernedNamespaceName('vteam-demo-agent')).toBe(true);
    });

    it('真实引擎外部名（含大小写/空格变体）在 agents 与 guard.roles 两侧均零出现（无模糊/前缀泄漏）', async () => {
      const policies = await emptyDbService().buildAgentPolicies();
      const { agentNames, roleKeys } = emittedNames(policies);
      expectNoExternalEmission(agentNames);
      expectNoExternalEmission(roleKeys);
    });
  });

  describe('含自定义 agent 行（DB 驱动）', () => {
    const CUSTOM_AGENT_ROWS = [
      {
        id: 'a_0000000101',
        name: 'Zeta Agent',
        type: 'custom',
        baseAgentId: null,
        role: null,
        agentKey: 'zeta',
        prompt: 'zeta',
        defaultModelId: null,
        workerId: null,
        ackMessage: null,
        persona: null,
        policyId: 'ep_zeta',
        createdBy: 'u_1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        id: 'a_0000000102',
        name: 'Demo Agent',
        type: 'custom',
        baseAgentId: null,
        role: null,
        agentKey: 'demo-agent',
        prompt: 'demo',
        defaultModelId: null,
        workerId: null,
        ackMessage: null,
        persona: null,
        policyId: 'ep_demo',
        createdBy: 'u_1',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];

    const CUSTOM_POLICY_ROWS = [
      {
        id: 'ep_demo',
        name: 'Demo policy',
        description: 'demo policy desc',
        type: 'custom',
        config: {
          permission: { edit: { '*': 'deny' }, task: 'deny' },
          correction: { scopeSummary: 'demo' },
          tools: { vteam_group_post: 'allow' },
        },
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        id: 'ep_zeta',
        name: 'Zeta policy',
        description: 'zeta policy desc',
        type: 'custom',
        config: {
          permission: { edit: { '*': 'deny' }, task: 'deny' },
          correction: { scopeSummary: 'zeta' },
          tools: { vteam_group_post: 'ask' },
        },
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];

    /** 由 mock 行推导（非回读实现）：内置 7 + vteam-<agentKey>。 */
    const EXPECTED_GOVERNED = [
      ...GOVERNED_BUILTINS,
      'vteam-demo-agent',
      'vteam-zeta',
    ].sort();

    function customDbService(): ExecutionPolicyService {
      return serviceWith({
        agent: { findMany: jest.fn().mockResolvedValue(CUSTOM_AGENT_ROWS) },
        executionPolicy: {
          findMany: jest.fn().mockResolvedValue(CUSTOM_POLICY_ROWS),
        },
      });
    }

    it('发射并集恰为 内置 ∪ vteam-<agentKey>（多一个名即失败；两侧同集）', async () => {
      const policies = await customDbService().buildAgentPolicies();
      const { agentNames, roleKeys } = emittedNames(policies);

      expect([...agentNames].sort()).toEqual(EXPECTED_GOVERNED);
      expect([...roleKeys].sort()).toEqual(EXPECTED_GOVERNED);
      // 事故性追加外部名会同时打破上面的集相等与下面的违例断言。
      const unexpected = [...agentNames, ...roleKeys].filter(
        (name) => !isGovernedNamespaceName(name),
      );
      expect(unexpected).toEqual([]);
    });

    it('外部引擎名（含大小写/空格变体）在自定义块存在时仍零出现', async () => {
      const policies = await customDbService().buildAgentPolicies();
      const { agentNames, roleKeys } = emittedNames(policies);
      expectNoExternalEmission(agentNames);
      expectNoExternalEmission(roleKeys);
    });

    it('自定义发出名可从 mock 行独立推导：vteam-demo-agent / vteam-zeta 均在两侧', async () => {
      const policies = await customDbService().buildAgentPolicies();
      const { agentNames, roleKeys } = emittedNames(policies);
      for (const expected of ['vteam-demo-agent', 'vteam-zeta']) {
        expect(agentNames).toContain(expected);
        expect(roleKeys).toContain(expected);
      }
    });
  });
});
