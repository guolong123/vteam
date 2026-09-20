import {
  buildEditPermission,
  buildReadPermission,
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  ROLE_POLICY_DENY_TEMPLATE,
  ROLE_SERVER_GATED_TOOLS,
} from '../common/constants/agent.constants';
import { projectNativePermission } from './__fixtures__/policy-fixtures';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * Todo 2（DB-backed agent-policies）契约测试：
 * - 内置字节一致：自定义块为空时输出与改前纯函数逐字节一致（顺序 + 全字段深比较 + 序列化快照）；
 * - 自定义块：agentKey/policyId 双非空行按 agentKey 升序追加 `vteam-<agentKey>`，
 *   permission 取策略 config，guard.roles tools 取三态矩阵（非法值丢弃）。
 */
describe('agent-policies custom agents (Todo 2)', () => {
  /**
   * 曾由服务端按主实例身份 gate 的工具（授权矩阵 plan §(d)）。概念已退休：
   * `ROLE_SERVER_GATED_TOOLS` 恒为空，据此循环会空转假绿，故显式列举。
   */
  const FORMERLY_GATED_TOOLS = [
    'vteam_task_transition',
    'vteam_question_confirm',
    'vteam_task_create',
    'vteam_plan_mode',
    'vteam_plan_complete',
    'vteam_team_add_member',
    'vteam_skill_create',
  ] as const;

  const BUILTIN_ORDER = [
    'vteam-plan',
    'vteam-product',
    'vteam-architect',
    'vteam-developer',
    'vteam-tester',
    'vteam-project_manager',
    'vteam-librarian',
  ];

  function builtinFixture() {
    const agents = BUILTIN_ORDER.map((name) => {
      const boundary = ROLE_BOUNDARIES[name as keyof typeof ROLE_BOUNDARIES];
      return {
        name,
        description: boundary.scopeSummary,
        mode: (name === 'vteam-plan' ? 'all' : 'primary') as 'primary' | 'all',
        permission: projectNativePermission({
          edit: buildEditPermission(boundary.writeGlobs),
          read: buildReadPermission(),
          bash: boundary.bashEffect,
          task: name === 'vteam-plan' ? 'allow' : 'deny',
          ...Object.fromEntries(
            boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
          ),
        }),
      };
    });
    const roles = Object.fromEntries(
      BUILTIN_ORDER.map((name) => {
        const boundary = ROLE_BOUNDARIES[name as keyof typeof ROLE_BOUNDARIES];
        return [
          name,
          {
            // todo 5: guard role carries permission only (tools/bashDeny/correction
            // were consumed solely by the deleted worker guard).
            permission: {
              edit: buildEditPermission(boundary.writeGlobs),
              read: buildReadPermission(),
              bash: boundary.bashEffect,
              task: name === 'vteam-plan' ? 'allow' : 'deny',
              ...Object.fromEntries(
                boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
              ),
            },
          },
        ];
      }),
    );
    return { agents, guard: { enabled: true as const, roles } };
  }

  function serviceWith(prisma: unknown) {
    return new ExecutionPolicyService(
      prisma as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
  }

  describe('内置字节一致（无自定义 agent）', () => {
    it('7 内置首位输出、顺序固定、全字段与独立推导夹具深一致', async () => {
      const service = serviceWith({
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const policies = await service.buildAgentPolicies();
      const expected = builtinFixture();

      expect(policies.agents.map((a) => a.name)).toEqual(BUILTIN_ORDER);
      expect(policies).toEqual(expected);
      expect(JSON.stringify(policies)).toBe(JSON.stringify(expected));
      expect(policies).toMatchSnapshot();
    });

    it('内置层① permission 对未授权 formerly-gated 工具显式 deny（guard 侧），agents[] 原生键投影', async () => {
      const service = serviceWith({
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const policies = await service.buildAgentPolicies();
      let assertions = 0;
      for (const agent of policies.agents) {
        const boundary =
          ROLE_BOUNDARIES[agent.name as keyof typeof ROLE_BOUNDARIES];
        const role = policies.guard.roles[agent.name];
        for (const tool of FORMERLY_GATED_TOOLS) {
          const granted = Object.prototype.hasOwnProperty.call(
            boundary.toolAllows,
            tool,
          );
          // todo 5：guard.roles[*] 只留 permission；agents[] 永不发射平台键。
          expect(agent.permission).not.toHaveProperty(tool);
          if (granted) {
            expect(role.permission).not.toHaveProperty(tool);
          } else {
            expect(role.permission).toHaveProperty(tool, 'deny');
          }
          assertions += 3;
        }
      }
      expect(assertions).toBe(
        policies.agents.length * FORMERLY_GATED_TOOLS.length * 3,
      );
      expect(assertions).toBeGreaterThan(0);
    });

    it('policyId 缺失的 agent 行不进入自定义块（仍纯 7 内置）', async () => {
      const service = serviceWith({
        agent: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const policies = await service.buildAgentPolicies();
      expect(policies.agents).toHaveLength(7);
      expect(Object.keys(policies.guard.roles)).toHaveLength(7);
    });
  });

  describe('自定义块（mocked DB）', () => {
    const customRow = {
      id: 'a_0000000001',
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
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const zetaRow = {
      ...customRow,
      id: 'a_0000000002',
      name: 'Zeta Agent',
      agentKey: 'zeta',
      policyId: 'ep_zeta',
    };
    const demoPolicy = {
      id: 'ep_demo',
      name: 'Demo policy',
      description: 'demo policy desc',
      type: 'custom',
      config: {
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'demo' },
        tools: {
          vteam_group_post: 'allow',
          vteam_member_remove: 'deny',
          vteam_task_context: 'ask',
          bogus_tool: 'whatever',
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const zetaPolicy = {
      ...demoPolicy,
      id: 'ep_zeta',
      name: 'Zeta policy',
      config: {
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'zeta' },
        tools: { vteam_group_post: 'ask' },
      },
    };

    function customService() {
      return serviceWith({
        agent: { findMany: jest.fn().mockResolvedValue([zetaRow, customRow]) },
        executionPolicy: {
          findMany: jest.fn().mockResolvedValue([demoPolicy, zetaPolicy]),
          findUnique: jest.fn().mockImplementation(({ where }: never) => {
            const id = (where as { id: string }).id;
            const found = [demoPolicy, zetaPolicy].find((p) => p.id === id);
            return Promise.resolve(found ?? null);
          }),
        },
      });
    }

    it('/agent-policies 同时在 agents 与 guard.roles 含 vteam-demo-agent（tools 矩阵透出，非法值丢弃）', async () => {
      const policies = await customService().buildAgentPolicies();

      expect(policies.agents.map((a) => a.name).slice(0, 7)).toEqual(
        BUILTIN_ORDER,
      );
      const names = policies.agents.map((a) => a.name);
      expect(names).toContain('vteam-demo-agent');
      expect(names.indexOf('vteam-demo-agent')).toBeLessThan(
        names.indexOf('vteam-zeta'),
      );

      const role = policies.guard.roles['vteam-demo-agent'];
      expect(role).toBeDefined();
      expect(Object.keys(role)).toEqual(['permission']);

      const def = policies.agents.find((a) => a.name === 'vteam-demo-agent');
      expect(def?.mode).toBe('primary');
      expect(def?.permission).toEqual(
        projectNativePermission(
          demoPolicy.config.permission as Record<string, unknown>,
        ),
      );
      expect(def?.description).toBe('demo policy desc');
      expect(role.permission).toEqual(demoPolicy.config.permission);
    });

    it('resolveByAgent 对自定义 agent 经 agentKey 命名并透出三态 tools（含 deny）', async () => {
      const resolved = await customService().resolveByAgent({
        agentKey: 'demo-agent',
        policyId: 'ep_demo',
      });
      expect(resolved?.agentName).toBe('vteam-demo-agent');
      expect(resolved?.tools).toEqual({
        vteam_group_post: 'allow',
        vteam_member_remove: 'deny',
        vteam_task_context: 'ask',
      });
      expect(resolved?.bashDeny).toEqual([...ROLE_BASH_DENY_PATTERNS]);
    });

    it('resolveByAgent 的 serverGated 恒为空数组（该概念已退休）', async () => {
      const service = serviceWith({
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'ep_product',
            name: 'product',
            config: {
              permission: { task: 'deny' },
              correction: { scopeSummary: 'x' },
            },
          }),
        },
      });
      const resolved = await service.resolveByAgent({
        agentKey: 'product',
        policyId: 'ep_product',
      });
      expect(ROLE_SERVER_GATED_TOOLS).toEqual([]);
      expect(resolved?.serverGated).toEqual([]);
      resolved?.serverGated.push('mutated');
      expect(resolved?.serverGated).toContain('mutated');
      expect(ROLE_SERVER_GATED_TOOLS).not.toContain('mutated');
    });

    it('resolveByAgent 对内置名从 config.tools 解析（DB 值胜出，非法值丢弃）', async () => {
      const service = serviceWith({
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'ep_product',
            name: 'product',
            config: {
              permission: { task: 'deny' },
              correction: { scopeSummary: 'x' },
              tools: { vteam_group_post: 'deny', bogus: 'whatever' },
            },
          }),
        },
      });
      const resolved = await service.resolveByAgent({
        agentKey: 'product',
        policyId: 'ep_product',
      });
      expect(resolved?.agentName).toBe('vteam-product');
      expect(resolved?.tools).toEqual({ vteam_group_post: 'deny' });
      expect(resolved?.tools).not.toEqual(
        ROLE_BOUNDARIES['vteam-product'].toolAllows,
      );
    });

    it('resolveByAgent 对内置名 config.tools 缺失/全非法时回退常量 allowlist（绝不 {}）', async () => {
      for (const tools of [
        undefined,
        { bogus: 'whatever' },
        { another_bad: 42 },
        [],
        'nope',
      ]) {
        const service = serviceWith({
          agent: { findMany: jest.fn().mockResolvedValue([]) },
          executionPolicy: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'ep_product',
              name: 'product',
              config: {
                permission: { task: 'deny' },
                correction: { scopeSummary: 'x' },
                tools,
              },
            }),
          },
        });
        const resolved = await service.resolveByAgent({
          agentKey: 'product',
          policyId: 'ep_product',
        });
        expect(resolved?.tools).toEqual(
          ROLE_BOUNDARIES['vteam-product'].toolAllows,
        );
        expect(Object.keys(resolved?.tools ?? {}).length).toBeGreaterThan(0);
      }
    });

    it('resolveByAgent 对内置名从 config.bashDeny 解析（string[] 过滤，缺失回退常量）', async () => {
      const withPatterns = await serviceWith({
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'ep_product',
            name: 'product',
            config: {
              permission: { task: 'deny' },
              correction: { scopeSummary: 'x' },
              bashDeny: ['rm -rf /', 42],
            },
          }),
        },
      }).resolveByAgent({ agentKey: 'product', policyId: 'ep_product' });
      expect(withPatterns?.bashDeny).toEqual(['rm -rf /']);

      const fallback = await serviceWith({
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'ep_product',
            name: 'product',
            config: {
              permission: { task: 'deny' },
              correction: { scopeSummary: 'x' },
            },
          }),
        },
      }).resolveByAgent({ agentKey: 'product', policyId: 'ep_product' });
      expect(fallback?.bashDeny).toEqual([...ROLE_BASH_DENY_PATTERNS]);
    });
  });

  describe('BLOCKER-2：DB 自定义策略 permission.write 防御式剥离', () => {
    const poisonedPermission = {
      write: { '*': 'allow' },
      edit: { '*': 'deny' },
      task: 'deny',
    };

    function poisonedService() {
      const policy = {
        id: 'ep_demo',
        name: 'Demo policy',
        description: 'demo',
        type: 'custom',
        config: {
          permission: { ...poisonedPermission },
          correction: { scopeSummary: 'demo' },
          tools: { vteam_group_post: 'allow' },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return serviceWith({
        agent: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'a_0000000001',
              name: 'Demo Agent',
              type: 'custom',
              agentKey: 'demo-agent',
              policyId: 'ep_demo',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]),
        },
        executionPolicy: {
          findMany: jest.fn().mockResolvedValue([policy]),
          findUnique: jest.fn().mockResolvedValue(policy),
        },
      });
    }

    it('buildAgentPolicies：agents[] 与 guard.roles[] 均不含 permission.write', async () => {
      const policies = await poisonedService().buildAgentPolicies();
      const agent = policies.agents.find((a) => a.name === 'vteam-demo-agent');
      const role = policies.guard.roles['vteam-demo-agent'];

      expect(agent).toBeDefined();
      expect(agent?.permission).not.toHaveProperty('write');
      expect(role.permission).not.toHaveProperty('write');
      expect(JSON.stringify(agent?.permission)).not.toContain('"write"');
      expect(JSON.stringify(role.permission)).not.toContain('"write"');
      expect(agent?.permission).toEqual({
        edit: { '*': 'deny' },
        task: 'deny',
      });
    });

    it('resolveByAgent：permission 不含 write（worker assertAgentShape 不抛错）', async () => {
      const resolved = await poisonedService().resolveByAgent({
        agentKey: 'demo-agent',
        policyId: 'ep_demo',
      });
      expect(resolved?.permission).not.toHaveProperty('write');
      expect(JSON.stringify(resolved?.permission)).not.toContain('"write"');
    });
  });
});
