import { ROLE_BOUNDARIES } from '../common/constants/agent.constants';
import {
  BUILTIN_ORDER,
  builtinPolicyRow,
  factorySeedConfig,
  loadAgentPoliciesBaseline,
  reorderLikeMysql,
  storageRoundTrip,
} from './__fixtures__/policy-fixtures';
import {
  builtinPolicyIdOf,
  ExecutionPolicyService,
} from './execution-policy.service';

/**
 * vteam-role-behavior-abstraction Todo 3 契约测试：内置 7 角色的 `/agent-policies` 输出
 * 由绑定 DB 行 `ep_<role>` 驱动（单次批量 `findMany`），行/字段缺失回退常量、永不抛错。
 *
 * 与 `agent-policies.custom-agents.spec.ts`（DB 查询 mock 为 `[]`，恒走常量回退）互补：
 * 本 spec 显式让绑定行携带出厂 config，证明 DB 路径真实生效且输出与冻结基线逐字节一致；
 * 基线取自 `.omo/evidence/vteam-role-behavior-abstraction/before-agent-policies.json`
 * —— 该文件**必须随仓库提交**（见 `loadAgentPoliciesBaseline`），否则缺失时清晰报错。
 */
describe('agent-policies db-backed builtins (Todo 3)', () => {
  const baseline = loadAgentPoliciesBaseline();

  /** 出厂 config 经 JSON 存储往返 + MySQL 键序重排，模拟 DB 返回。 */
  function storedConfig(name: (typeof BUILTIN_ORDER)[number]) {
    return storageRoundTrip(reorderLikeMysql(factorySeedConfig(name)));
  }

  function factoryRows(order: readonly (typeof BUILTIN_ORDER)[number][]) {
    return order.map((name) => builtinPolicyRow(name, storedConfig(name)));
  }

  function serviceWith(executionPolicy: {
    findMany: jest.Mock;
  }): ExecutionPolicyService {
    return new ExecutionPolicyService(
      {
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy,
      } as never,
      {} as never,
    );
  }

  describe('绑定行携带出厂 config（DB 路径生效）', () => {
    it('输出与冻结基线逐字节一致（深比较 + JSON.stringify），顺序恒为 AGENT_POLICIES_ORDER', async () => {
      const executionPolicy = {
        findMany: jest.fn().mockResolvedValue(factoryRows(BUILTIN_ORDER)),
      };
      const policies = await serviceWith(executionPolicy).buildAgentPolicies();

      expect(policies.agents.map((a) => a.name)).toEqual([...BUILTIN_ORDER]);
      expect(policies.guard.enabled).toBe(true);
      expect(Object.keys(policies.guard.roles)).toEqual([...BUILTIN_ORDER]);
      expect(policies).toEqual(baseline);
      expect(JSON.stringify(policies)).toBe(JSON.stringify(baseline));
    });

    it('DB 返回乱序时输出顺序仍取常量（不得按查询结果排序）', async () => {
      const shuffled = [...BUILTIN_ORDER].reverse();
      const executionPolicy = {
        findMany: jest.fn().mockResolvedValue(factoryRows(shuffled)),
      };
      const policies = await serviceWith(executionPolicy).buildAgentPolicies();
      expect(policies.agents.map((a) => a.name)).toEqual([...BUILTIN_ORDER]);
      expect(JSON.stringify(policies)).toBe(JSON.stringify(baseline));
    });

    it('单次 findMany 批量拉取 7 个绑定 id（无 N+1）', async () => {
      const executionPolicy = {
        findMany: jest.fn().mockResolvedValue(factoryRows(BUILTIN_ORDER)),
      };
      await serviceWith(executionPolicy).buildAgentPolicies();

      expect(executionPolicy.findMany).toHaveBeenCalledTimes(1);
      const where = executionPolicy.findMany.mock.calls[0][0].where as {
        id: { in: string[] };
      };
      expect([...where.id.in].sort()).toEqual(
        BUILTIN_ORDER.map((name) => builtinPolicyIdOf(name)).sort(),
      );
    });

    it('DB 值真实胜出：绑定行 tools 与常量不同时输出反映 DB 值', async () => {
      const config = factorySeedConfig('vteam-product');
      const executionPolicy = {
        findMany: jest.fn().mockResolvedValue([
          builtinPolicyRow('vteam-product', {
            ...config,
            tools: { vteam_group_post: 'deny', vteam_memory_search: 'ask' },
          }),
        ]),
      };
      const policies = await serviceWith(executionPolicy).buildAgentPolicies();
      expect(policies.guard.roles['vteam-product'].tools).toEqual({
        vteam_group_post: 'deny',
        vteam_memory_search: 'ask',
      });
      expect(policies.guard.roles['vteam-product'].tools).not.toEqual(
        ROLE_BOUNDARIES['vteam-product'].toolAllows,
      );
    });
  });

  describe('行/字段缺失 → 常量回退（永不抛错、永不残缺）', () => {
    it('全部绑定行缺失 → 输出等于常量派生基线，不抛错', async () => {
      const executionPolicy = { findMany: jest.fn().mockResolvedValue([]) };
      const policies = await serviceWith(executionPolicy).buildAgentPolicies();
      expect(JSON.stringify(policies)).toBe(JSON.stringify(baseline));
    });

    it('绑定行存在但 config 残缺（缺 tools）→ tools 回退常量非空 allowlist', async () => {
      const config = factorySeedConfig('vteam-tester');
      const executionPolicy = {
        findMany: jest.fn().mockResolvedValue([
          builtinPolicyRow('vteam-tester', {
            permission: config.permission,
            correction: config.correction,
          }),
        ]),
      };
      const policies = await serviceWith(executionPolicy).buildAgentPolicies();
      const role = policies.guard.roles['vteam-tester'];
      expect(role.tools).toEqual(ROLE_BOUNDARIES['vteam-tester'].toolAllows);
      expect(Object.keys(role.tools).length).toBeGreaterThan(0);
    });
  });
});
