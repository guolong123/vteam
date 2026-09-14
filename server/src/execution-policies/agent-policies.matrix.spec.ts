import {
  buildEditPermission,
  buildReadPermission,
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  VTEAM_GIT_TOOL_NAMES,
  VTEAM_MCP_TOOL_NAMES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * Todo 24 anti-drift self-check（防漂移能力矩阵自检）：
 * 单一来源 `ROLE_BOUNDARIES` 驱动全部期望值——测试内不重写逐角色字面量，
 * service 或常量任一漂移即红。覆盖：
 * - toolAllows 键命名空间（MCP `vteam_*` / 自定义 `git_*`，无裸名、无未知键）；
 * - mcpDenies 成员 + 与 toolAllows 互斥；
 * - 层① permission 派生形状（edit/read/bash/task/mcpDenies，无 write）；
 * - `buildAgentPolicies()`（直接调用 service，无 HTTP；自定义块空即纯内置输出）6 agents +
 *   guard 一致性 + permission 全 `task:'deny'` 且无 `write`。
 */
describe('agent-policies matrix self-check (Todo 24 anti-drift)', () => {
  const AGENT_NAMES = Object.keys(ROLE_BOUNDARIES).sort() as VteamAgentName[];
  const MCP_SET = new Set<string>(VTEAM_MCP_TOOL_NAMES);
  const GIT_SET = new Set<string>(VTEAM_GIT_TOOL_NAMES);

  it('6 agents：vteam-plan + 5 角色（key 即 opencode agent 名）', () => {
    expect(AGENT_NAMES).toHaveLength(6);
    expect(AGENT_NAMES).toEqual(
      [
        'vteam-architect',
        'vteam-developer',
        'vteam-plan',
        'vteam-product',
        'vteam-project_manager',
        'vteam-tester',
      ].sort(),
    );
  });

  it('toolAllows 键 ∈ MCP 注册表 ∪ GIT 注册表——无裸 MCP 名、无未知键', () => {
    for (const name of AGENT_NAMES) {
      for (const key of Object.keys(ROLE_BOUNDARIES[name].toolAllows)) {
        const inMcp = MCP_SET.has(key);
        const inGit = GIT_SET.has(key);
        expect(inMcp || inGit).toBe(true);
        // MCP 命名空间一律 `vteam_` 前缀；自定义 git 键不强制该前缀但必须在 GIT 注册表内。
        if (inMcp) expect(key).toMatch(/^vteam_/);
        // `task`/`execute` 永不列入 allowlist（guard 默认 deny）。
        expect(key).not.toBe('task');
        expect(key).not.toBe('execute');
      }
    }
  });

  it('mcpDenies ∈ MCP 注册表且与该角色 toolAllows 互斥', () => {
    for (const name of AGENT_NAMES) {
      const { toolAllows, mcpDenies } = ROLE_BOUNDARIES[name];
      const allowed = new Set(Object.keys(toolAllows));
      for (const denied of mcpDenies) {
        expect(MCP_SET.has(denied)).toBe(true);
        expect(allowed.has(denied)).toBe(false);
      }
      // mcpDenies 即 MCP 全集减 allowlist（与 defineBoundary 补集语义一致）。
      expect([...mcpDenies].sort()).toEqual(
        VTEAM_MCP_TOOL_NAMES.filter((mcp) => !allowed.has(mcp)).sort(),
      );
    }
  });

  it('层① permission 派生 == Permission matrix：edit/read/bash/task/mcpDenies，无 write', () => {
    for (const name of AGENT_NAMES) {
      const boundary = ROLE_BOUNDARIES[name];
      const expected: Record<string, unknown> = {
        edit: buildEditPermission(boundary.writeGlobs),
        read: buildReadPermission(),
        bash: boundary.bashEffect,
        task: 'deny',
        ...Object.fromEntries(
          boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
        ),
      };
      // 形状断言：edit/read 由 helper 派生、bash 取自边界、task 恒 deny、无 write 键。
      expect(expected.edit).toEqual(
        buildEditPermission(boundary.writeGlobs),
      );
      expect(expected.read).toEqual(buildReadPermission());
      expect(expected.bash).toBe(boundary.bashEffect);
      expect(expected.task).toBe('deny');
      expect(expected).not.toHaveProperty('write');
      for (const denied of boundary.mcpDenies) {
        expect(expected[denied]).toBe('deny');
      }
    }
  });

  describe('buildAgentPolicies()（service 直接调用，无 HTTP；自定义块空时即纯内置输出）', () => {
    // DB 依赖：prisma.agent/executionPolicy.findMany 占位空数组（无自定义 agent）。
    const service = new ExecutionPolicyService(
      {
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
    );
    let policies: Awaited<ReturnType<typeof service.buildAgentPolicies>>;

    beforeAll(async () => {
      policies = await service.buildAgentPolicies();
    });

    it('返回 6 agents（vteam-plan + 5 角色），guard.enabled === true', () => {
      expect(policies.agents).toHaveLength(6);
      expect(policies.guard.enabled).toBe(true);
    });

    it('guard.roles keys 与 agent names 完全一致', () => {
      const agentNames = policies.agents.map((a) => a.name).sort();
      expect(Object.keys(policies.guard.roles).sort()).toEqual(agentNames);
      expect(agentNames).toEqual([...AGENT_NAMES].sort());
    });

    it('guard.roles[name].tools === ROLE_BOUNDARIES[name].toolAllows', () => {
      for (const agent of policies.agents) {
        expect(policies.guard.roles[agent.name].tools).toEqual(
          ROLE_BOUNDARIES[agent.name].toolAllows,
        );
      }
    });

    it('guard.roles[name].bashDeny 包含全部 ROLE_BASH_DENY_PATTERNS', () => {
      for (const agent of policies.agents) {
        for (const pattern of ROLE_BASH_DENY_PATTERNS) {
          expect(policies.guard.roles[agent.name].bashDeny).toContain(pattern);
        }
      }
    });

    it('agent/role permission 与层①派生 map 一致；全员 task deny、无 write', () => {
      for (const agent of policies.agents) {
        const boundary = ROLE_BOUNDARIES[agent.name];
        const expectedPermission = {
          edit: buildEditPermission(boundary.writeGlobs),
          read: buildReadPermission(),
          bash: boundary.bashEffect,
          task: 'deny',
          ...Object.fromEntries(
            boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
          ),
        };
        expect(agent.permission).toEqual(expectedPermission);
        expect(policies.guard.roles[agent.name].permission).toEqual(
          expectedPermission,
        );
        expect(agent.permission).not.toHaveProperty('write');
        expect(
          policies.guard.roles[agent.name].permission,
        ).not.toHaveProperty('write');
        expect(agent.permission.task).toBe('deny');
        expect(policies.guard.roles[agent.name].permission.task).toBe('deny');
      }
    });
  });
});
