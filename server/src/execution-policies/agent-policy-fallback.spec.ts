import {
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import { AgentsService } from '../agents/agents.service';
import {
  ExecutionPolicyService,
  resolveConstantPolicySource,
} from './execution-policy.service';

/**
 * vteam-role-behavior-abstraction Todo 5 契约测试：`resolveByAgent` /
 * `resolveManyByAgents` 与 `agents.resolveTemplateSource` 共用同一回退策略——
 * DB 行胜出，行缺失时内置角色回退 `ROLE_BOUNDARIES` 常量派生（非 null）。
 */
describe('unified agent policy fallback (Todo 5)', () => {
  function serviceWith(policy: unknown) {
    return new ExecutionPolicyService(
      {
        executionPolicy: {
          findUnique: jest.fn().mockResolvedValue(policy),
          findMany: jest
            .fn()
            .mockResolvedValue(policy === null ? [] : [policy]),
        },
      } as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
  }

  function constantOf(name: VteamAgentName) {
    const source = resolveConstantPolicySource(name);
    if (!source) {
      throw new Error(`no constant source for ${name}`);
    }
    return source;
  }

  it('resolveByAgent：DB 行缺失的内置 agentKey → 常量派生策略（非 null），内容与常量逐字段一致', async () => {
    const resolved = await serviceWith(null).resolveByAgent({
      policyId: 'ep_product',
      agentKey: 'product',
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.agentName).toBe('vteam-product');
    expect(resolved?.policyId).toBe('ep_product');
    expect(resolved?.permission).toEqual(
      constantOf('vteam-product').config.permission,
    );
    expect(resolved?.tools).toEqual(
      ROLE_BOUNDARIES['vteam-product'].toolAllows,
    );
    expect(Object.keys(resolved?.tools ?? {}).length).toBeGreaterThan(0);
    expect(resolved?.correction).toEqual(
      constantOf('vteam-product').config.correction,
    );
    expect(resolved?.bashDeny).toEqual([...ROLE_BASH_DENY_PATTERNS]);
  });

  it('resolveManyByAgents：DB 行缺失的内置 agentKey → 常量派生策略（非 null），与单条解析同源', async () => {
    const [product, plan, custom] = await serviceWith(null).resolveManyByAgents(
      [
        { policyId: 'ep_product', agentKey: 'product' },
        { policyId: 'ep_plan', agentKey: 'plan' },
        { policyId: 'ep_demo', agentKey: 'demo' },
      ],
    );

    expect(product?.tools).toEqual(ROLE_BOUNDARIES['vteam-product'].toolAllows);
    expect(plan?.permission.task).toBe('allow');
    expect(plan?.tools).toEqual(ROLE_BOUNDARIES['vteam-plan'].toolAllows);
    expect(custom).toBeNull();
  });

  it('DB 行存在且 config 完整时仍胜出（行优先于常量回退）', async () => {
    const dbTools = { vteam_group_post: 'deny', vteam_memory_search: 'ask' };
    const resolved = await serviceWith({
      id: 'ep_product',
      name: 'db-product',
      config: {
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'db' },
        tools: dbTools,
      },
    }).resolveByAgent({ policyId: 'ep_product', agentKey: 'product' });

    expect(resolved?.policyName).toBe('db-product');
    expect(resolved?.permission).toEqual({
      edit: { '*': 'deny' },
      task: 'deny',
    });
    expect(resolved?.correction).toEqual({ scopeSummary: 'db' });
  });

  it('未绑定的未知 agentKey（非内置）行缺失 → null（不臆造策略）', async () => {
    const resolved = await serviceWith(null).resolveByAgent({
      agentKey: 'analyst',
    });
    expect(resolved).toBeNull();
  });

  it('两条路径共用同一常量推导：resolveByAgent 与 resolveTemplateSource 行缺失结果一致', async () => {
    const resolved = await serviceWith(null).resolveByAgent({
      policyId: 'ep_developer',
      agentKey: 'developer',
    });

    const agents = new AgentsService(
      { executionPolicy: { findUnique: () => Promise.resolve(null) } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const source = await (
      agents as unknown as {
        resolveTemplateSource: (
          tx: unknown,
          role: string,
        ) => Promise<{ config: Record<string, unknown> } | null>;
      }
    ).resolveTemplateSource(
      { executionPolicy: { findUnique: () => Promise.resolve(null) } },
      'developer',
    );

    expect(source).not.toBeNull();
    expect(resolved?.permission).toEqual(source?.config.permission);
    expect(resolved?.correction).toEqual(source?.config.correction);
    expect(resolved?.tools).toEqual(source?.config.tools);
  });

  describe('agent-role-decommission todo 3：解析不再读 role', () => {
    /** DB 行：tools 刻意偏离常量，证明解析走的是行而非常量回退。 */
    const editedProductRow = {
      id: 'ep_product',
      name: 'edited-product',
      config: {
        permission: { edit: { '*': 'deny' }, task: 'deny' },
        correction: { scopeSummary: 'edited' },
        tools: { vteam_group_post: 'deny' },
      },
    };

    it('policyId 已绑定且输入无 role 键（列已删/缺席）→ DB 行解析成功', async () => {
      const resolved = await serviceWith(editedProductRow).resolveByAgent({
        policyId: 'ep_product',
        agentKey: 'product',
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.policyId).toBe('ep_product');
      expect(resolved?.agentName).toBe('vteam-product');
      expect(resolved?.policyName).toBe('edited-product');
      expect(resolved?.tools).toEqual({ vteam_group_post: 'deny' });
      expect(resolved?.tools).not.toEqual(
        ROLE_BOUNDARIES['vteam-product'].toolAllows,
      );
    });

    it('policyId 为 null + 注册名（agentKey 命中内置）→ 常量回退解析（行缺失，无 null 崩溃）', async () => {
      const resolved = await serviceWith(null).resolveByAgent({
        policyId: null,
        agentKey: 'product',
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.agentName).toBe('vteam-product');
      expect(resolved?.policyId).toBe('ep_product');
      expect(resolved?.tools).toEqual(
        ROLE_BOUNDARIES['vteam-product'].toolAllows,
      );
      expect(Object.keys(resolved?.tools ?? {}).length).toBeGreaterThan(0);
    });

    it('部分迁移库：policyId 为 null + 注册名 + 已存在（用户编辑过）的内置行 → DB 行胜出（行为不变）', async () => {
      const resolved = await serviceWith(editedProductRow).resolveByAgent({
        policyId: null,
        agentKey: 'product',
      });

      expect(resolved?.policyName).toBe('edited-product');
      expect(resolved?.tools).toEqual({ vteam_group_post: 'deny' });
      expect(resolved?.tools).not.toEqual(
        ROLE_BOUNDARIES['vteam-product'].toolAllows,
      );
    });

    it('role 键被忽略：仅 role（无 agentKey/policyId）不产生候选 → null（旧实现会回退 vteam-<role>）', async () => {
      const resolved = await serviceWith(editedProductRow).resolveByAgent({
        role: 'product',
      });

      expect(resolved).toBeNull();
    });

    it('role 键被忽略：agentKey 缺席时解析名不取 vteam-<role>（规则 4 收窄）', async () => {
      const resolved = await serviceWith(editedProductRow).resolveByAgent({
        policyId: 'ep_product',
        role: 'product',
      });

      expect(resolved?.agentName).toBe('vteam-plan');
      expect(resolved?.agentName).not.toBe('vteam-product');
    });
  });
});
