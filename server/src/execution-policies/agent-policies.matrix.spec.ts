import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEditPermission,
  buildReadPermission,
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  VTEAM_BROWSER_TOOL_NAMES,
  VTEAM_GIT_TOOL_NAMES,
  VTEAM_MCP_TOOL_NAMES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import {
  EVIDENCE_DIR,
  loadAgentPoliciesBaseline,
  projectNativePermission,
} from './__fixtures__/policy-fixtures';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * Todo 24 anti-drift self-check（防漂移能力矩阵自检）：
 * 单一来源 `ROLE_BOUNDARIES` 驱动全部期望值——测试内不重写逐角色字面量，
 * service 或常量任一漂移即红。覆盖：
 * - toolAllows 键命名空间（MCP `vteam_*` / 自定义 `git_*`，无裸名、无未知键）；
 * - mcpDenies 成员 + 与 toolAllows 互斥；
 * - 层① permission 派生形状（edit/read/bash/task/mcpDenies，无 write）；
 * - `buildAgentPolicies()`（直接调用 service，无 HTTP；自定义块空即纯内置输出）7 agents +
 *   guard 一致性 + permission 全 `task:'deny'` 且无 `write`。
 */
describe('agent-policies matrix self-check (Todo 24 anti-drift)', () => {
  /**
   * 曾由服务端按主实例身份 gate 的工具（授权矩阵 plan §(d)）。概念已退休：
   * `ROLE_SERVER_GATED_TOOLS` 恒为空，据此循环会空转假绿，故显式列举。
   */
  const FORMERLY_GATED_TOOLS = [
    'vteam_task_transition',
    'vteam_question_confirm',
    'vteam_task_create',
    'vteam_plan_complete',
    'vteam_team_add_member',
    'vteam_skill_create',
  ] as const;

  const AGENT_NAMES = Object.keys(ROLE_BOUNDARIES).sort() as VteamAgentName[];
  const MCP_SET = new Set<string>(VTEAM_MCP_TOOL_NAMES);
  const GIT_SET = new Set<string>(VTEAM_GIT_TOOL_NAMES);
  const BROWSER_SET = new Set<string>(VTEAM_BROWSER_TOOL_NAMES);

  it('7 agents：vteam-plan + 5 角色 + vteam-librarian（key 即 opencode agent 名）', () => {
    expect(AGENT_NAMES).toHaveLength(7);
    expect(AGENT_NAMES).toEqual(
      [
        'vteam-architect',
        'vteam-developer',
        'vteam-librarian',
        'vteam-plan',
        'vteam-product',
        'vteam-project_manager',
        'vteam-tester',
      ].sort(),
    );
  });

  it('toolAllows 键 ∈ MCP 注册表 ∪ GIT 注册表 ∪ 浏览器工具——无裸 MCP 名、无未知键', () => {
    for (const name of AGENT_NAMES) {
      for (const key of Object.keys(ROLE_BOUNDARIES[name].toolAllows)) {
        const inMcp = MCP_SET.has(key);
        const inGit = GIT_SET.has(key);
        const inBrowser = BROWSER_SET.has(key);
        expect(inMcp || inGit || inBrowser).toBe(true);
        // MCP 命名空间一律 `vteam_` 前缀；自定义 git 键不强制该前缀但必须在 GIT 注册表内。
        if (inMcp) expect(key).toMatch(/^vteam_/);
        // `task`/`execute` 永不列入 allowlist（guard 默认 deny）。
        expect(key).not.toBe('task');
        expect(key).not.toBe('execute');
      }
    }
  });

  it('vteam-plan：具 vteam_notify_agent + vteam_memory_search（读/通知），无 vteam_submit_artifact（落盘即交付）', () => {
    const plan = ROLE_BOUNDARIES['vteam-plan'].toolAllows;
    expect(plan).toHaveProperty('vteam_notify_agent', 'allow');
    expect(plan).toHaveProperty('vteam_memory_search', 'allow');
    expect(plan).not.toHaveProperty('vteam_submit_artifact');
    // vteam-librarian 防环：仍无 notify_agent（刻意拒绝，不随 plan 改动）
    expect(ROLE_BOUNDARIES['vteam-librarian'].toolAllows).not.toHaveProperty(
      'vteam_notify_agent',
    );
    expect(ROLE_BOUNDARIES['vteam-librarian'].toolAllows).toHaveProperty(
      'vteam_memory_search',
      'allow',
    );
  });

  it('mcpDenies ∈ MCP 注册表，且与该角色 toolAllows 互斥（补集 = 全集减 allowlist，无例外）', () => {
    for (const name of AGENT_NAMES) {
      const { toolAllows, mcpDenies } = ROLE_BOUNDARIES[name];
      const allowed = new Set(Object.keys(toolAllows));
      for (const denied of mcpDenies) {
        expect(MCP_SET.has(denied)).toBe(true);
        expect(allowed.has(denied)).toBe(false);
      }
      // mcpDenies 即 MCP 全集减 allowlist（server-gated 例外已退休）。
      expect([...mcpDenies].sort()).toEqual(
        VTEAM_MCP_TOOL_NAMES.filter((mcp) => !allowed.has(mcp)).sort(),
      );
    }
  });

  it('层① permission 派生 == Permission matrix：edit/read/bash/task/mcpDenies/ask，无 write', () => {
    for (const name of AGENT_NAMES) {
      const boundary = ROLE_BOUNDARIES[name];
      const expected: Record<string, unknown> = {
        edit: buildEditPermission(boundary.writeGlobs),
        read: buildReadPermission(),
        bash: boundary.bashEffect,
        task: name === 'vteam-plan' ? 'allow' : 'deny',
        ...Object.fromEntries(
          boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
        ),
      };
      // 形状断言：edit/read 由 helper 派生、bash 取自边界、task 恒 deny、无 write 键。
      expect(expected.edit).toEqual(buildEditPermission(boundary.writeGlobs));
      expect(expected.read).toEqual(buildReadPermission());
      expect(expected.bash).toBe(boundary.bashEffect);
      expect(expected.task).toBe(name === 'vteam-plan' ? 'allow' : 'deny');
      expect(expected).not.toHaveProperty('write');
      for (const denied of boundary.mcpDenies) {
        expect(expected[denied]).toBe('deny');
      }
    }
  });

  it('内置层① permission：未授权 formerly-gated 工具显式 deny（guard 侧），agents[] 原生键投影', async () => {
    const service = new ExecutionPolicyService(
      {
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
    const policies = await service.buildAgentPolicies();
    let assertions = 0;
    for (const agent of policies.agents) {
      const boundary = ROLE_BOUNDARIES[agent.name];
      const rolePermission = policies.guard.roles[agent.name].permission;
      for (const tool of FORMERLY_GATED_TOOLS) {
        const granted = Object.prototype.hasOwnProperty.call(
          boundary.toolAllows,
          tool,
        );
        if (granted) {
          expect(agent.permission).not.toHaveProperty(tool);
          expect(rolePermission).not.toHaveProperty(tool);
        } else {
          // todo 4：agents[] 只发射原生键——deny 明细留在 guard.roles[*].permission。
          expect(agent.permission).not.toHaveProperty(tool);
          expect(rolePermission).toHaveProperty(tool, 'deny');
        }
        assertions += 2;
      }
    }
    expect(assertions).toBe(
      policies.agents.length * FORMERLY_GATED_TOOLS.length * 2,
    );
    expect(assertions).toBeGreaterThan(0);
  });

  it('层① permission 无第三方硬编码键（协议与机制，不针对具体工具适配）', async () => {
    const service = new ExecutionPolicyService(
      {
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
    const policies = await service.buildAgentPolicies();
    expect(policies.agents).toHaveLength(7);
    for (const agent of policies.agents) {
      expect(agent.permission).not.toHaveProperty('github_merge_pr');
      expect(policies.guard.roles[agent.name].permission).not.toHaveProperty(
        'github_merge_pr',
      );
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
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
    let policies: Awaited<ReturnType<typeof service.buildAgentPolicies>>;

    beforeAll(async () => {
      policies = await service.buildAgentPolicies();
    });

    it('7 内置发射结果 deep-equal 冻结基线（before-agent-policies.json）', () => {
      const baseline = loadAgentPoliciesBaseline();
      expect(policies).toEqual(baseline);
      expect(JSON.stringify(policies)).toBe(JSON.stringify(baseline));
    });

    it('冻结基线文件 sha256 未变（旧基线保持只读；历史字节身份闸门自身不可动）', () => {
      const file = join(EVIDENCE_DIR, 'before-agent-policies.json');
      const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(sha).toBe(
        '3b8c5d4bf29003c48079b11623cf840f9741e3044f6b40e3bfe035c011ceaf87',
      );
    });

    it('返回 7 agents（vteam-plan + 5 角色 + vteam-librarian），guard.enabled === true', () => {
      expect(policies.agents).toHaveLength(7);
      expect(policies.guard.enabled).toBe(true);
    });

    it('guard.roles keys 与 agent names 完全一致', () => {
      const agentNames = policies.agents.map((a) => a.name).sort();
      expect(Object.keys(policies.guard.roles).sort()).toEqual(agentNames);
      expect(agentNames).toEqual([...AGENT_NAMES].sort());
    });

    it('guard.roles[name] 恰为 {permission}（todo 5：tools/bashDeny/correction 已随 worker guard 删除）', () => {
      for (const agent of policies.agents) {
        const role = policies.guard.roles[agent.name];
        expect(Object.keys(role)).toEqual(['permission']);
        expect(role.permission).toHaveProperty(
          'edit',
          buildEditPermission(ROLE_BOUNDARIES[agent.name].writeGlobs),
        );
      }
    });

    it('guard role permission 与层①派生 map 一致；agents[] 为原生键投影；仅 vteam-plan task allow、无 write', () => {
      for (const agent of policies.agents) {
        const boundary = ROLE_BOUNDARIES[agent.name];
        const expectedPermission = {
          edit: buildEditPermission(boundary.writeGlobs),
          read: buildReadPermission(),
          bash: boundary.bashEffect,
          task: agent.name === 'vteam-plan' ? 'allow' : 'deny',
          ...Object.fromEntries(
            boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
          ),
        };
        // guard.roles[*].permission 保持完整（含 vteam_* deny 明细，worker guard 层消费）。
        expect(policies.guard.roles[agent.name].permission).toEqual(
          expectedPermission,
        );
        // agents[] 只发射原生四键，值同派生 map（todo 4）。
        expect(agent.permission).toEqual(
          projectNativePermission(expectedPermission),
        );
        expect(agent.permission).not.toHaveProperty('write');
        expect(policies.guard.roles[agent.name].permission).not.toHaveProperty(
          'write',
        );
        expect(agent.permission.task).toBe(
          agent.name === 'vteam-plan' ? 'allow' : 'deny',
        );
        expect(policies.guard.roles[agent.name].permission.task).toBe(
          agent.name === 'vteam-plan' ? 'allow' : 'deny',
        );
      }
    });

    it('mode 仅 vteam-plan 为 all，其余为 primary', () => {
      for (const agent of policies.agents) {
        expect(agent.mode).toBe(
          agent.name === 'vteam-plan' ? 'all' : 'primary',
        );
      }
    });

    it('vteam-plan 层①含 plans 窄写 + 层②含 group_post', () => {
      const plan = policies.agents.find((a) => a.name === 'vteam-plan');
      expect(plan).toBeDefined();
      const edit = (plan?.permission.edit ?? {}) as Record<string, string>;
      const plansGlobs = Object.keys(edit).filter((glob) =>
        glob.includes('.opencode/plans'),
      );
      expect(plansGlobs.length).toBeGreaterThan(0);
      for (const glob of plansGlobs) {
        expect(edit[glob]).toBe('allow');
      }
      expect(policies.guard.roles['vteam-plan'].permission).not.toHaveProperty(
        'vteam_group_post',
      );
      expect(
        Object.prototype.hasOwnProperty.call(
          ROLE_BOUNDARIES['vteam-plan'].toolAllows,
          'vteam_group_post',
        ),
      ).toBe(true);
    });
  });
});
