import { type VteamAgentName } from '../common/constants/agent.constants';
import {
  deriveAgentMode,
  ExecutionPolicyService,
  resolveTaskEffect,
} from './execution-policy.service';
import { loadAgentPoliciesBaseline } from './__fixtures__/policy-fixtures';

/**
 * vteam-role-behavior-abstraction Todo 6 契约测试：`mode` 与 `permission.task`
 * 的派生权威各自唯一，且出厂状态下 task allow 恰好一个（vteam-plan）。
 *
 * agent-role-decommission todo 2：判据由散落的 `vteam-plan` 字面量改为职责注册表
 * （`getOpencodeAgentDuty`），并新增「7 内置 mode/task 与冻结基线逐字节一致」的防漂移锁。
 */
describe('agent policy mode/task derivation (Todo 6)', () => {
  const BUILTIN_ORDER: readonly VteamAgentName[] = [
    'vteam-plan',
    'vteam-product',
    'vteam-architect',
    'vteam-developer',
    'vteam-tester',
    'vteam-project_manager',
    'vteam-librarian',
  ];

  describe('deriveAgentMode（唯一规则）', () => {
    it('计划职责为 all，其余（含自定义名）为 primary', () => {
      expect(deriveAgentMode('vteam-plan')).toBe('all');
      for (const name of BUILTIN_ORDER.filter((n) => n !== 'vteam-plan')) {
        expect(deriveAgentMode(name)).toBe('primary');
      }
      expect(deriveAgentMode('vteam-demo-agent')).toBe('primary');
    });

    it('判据是职责（非 vteam 名）：裸 plan/prometheus 亦为 all，vteam-prometheus 否', () => {
      expect(deriveAgentMode('plan')).toBe('all');
      expect(deriveAgentMode('prometheus')).toBe('all');
      expect(deriveAgentMode('vteam-prometheus')).toBe('primary');
      expect(deriveAgentMode('vteam-plan')).toBe('all');
    });
  });

  describe('resolveTaskEffect（唯一权威：DB 值合法则胜出，否则派生规则）', () => {
    it('计划职责无 DB 值 → allow；其余 → deny', () => {
      expect(resolveTaskEffect('vteam-plan')).toBe('allow');
      for (const name of BUILTIN_ORDER.filter((n) => n !== 'vteam-plan')) {
        expect(resolveTaskEffect(name)).toBe('deny');
      }
    });

    it('合法 DB 值胜出；缺失/非法回退派生规则（绝不 undefined）', () => {
      expect(resolveTaskEffect('vteam-product', 'allow')).toBe('allow');
      expect(resolveTaskEffect('vteam-plan', 'deny')).toBe('deny');
      expect(resolveTaskEffect('vteam-plan', 'ask')).toBe('ask');
      expect(resolveTaskEffect('vteam-plan', undefined)).toBe('allow');
      expect(resolveTaskEffect('vteam-plan', 'bogus')).toBe('allow');
      expect(resolveTaskEffect('vteam-product', 'bogus')).toBe('deny');
    });
  });

  describe('出厂状态（DB 空 → 常量回退）', () => {
    function serviceWith() {
      return new ExecutionPolicyService(
        {
          agent: { findMany: jest.fn().mockResolvedValue([]) },
          executionPolicy: { findMany: jest.fn().mockResolvedValue([]) },
        } as never,
        {} as never,
        { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
      );
    }

    it('mode === all 恰好一次，且为 vteam-plan', async () => {
      const policies = await serviceWith().buildAgentPolicies();
      const allModes = policies.agents
        .filter((a) => a.mode === 'all')
        .map((a) => a.name);
      expect(allModes).toEqual(['vteam-plan']);
      for (const agent of policies.agents) {
        expect(agent.mode).toBe(deriveAgentMode(agent.name));
      }
    });

    it("permission.task === 'allow' 恰好一次，且为 vteam-plan；其余六个 deny", async () => {
      const policies = await serviceWith().buildAgentPolicies();
      const allow = policies.agents
        .filter((a) => a.permission.task === 'allow')
        .map((a) => a.name);
      expect(allow).toEqual(['vteam-plan']);
      for (const agent of policies.agents) {
        expect(agent.permission).toHaveProperty('task');
        expect(agent.permission.task).toBe(
          agent.name === 'vteam-plan' ? 'allow' : 'deny',
        );
        expect(policies.guard.roles[agent.name].permission).toHaveProperty(
          'task',
        );
      }
      const taskViaRoles = Object.entries(policies.guard.roles)
        .filter(([, role]) => role.permission.task === 'allow')
        .map(([name]) => name);
      expect(taskViaRoles).toEqual(['vteam-plan']);
    });

    it('7 内置 mode/task 与冻结基线逐字节一致（防职责判据漂移）', async () => {
      const baseline = loadAgentPoliciesBaseline();
      const policies = await serviceWith().buildAgentPolicies();
      expect(policies.agents).toHaveLength(baseline.agents.length);
      for (const expected of baseline.agents) {
        const actual = policies.agents.find((a) => a.name === expected.name);
        expect(actual).toBeDefined();
        expect(actual!.mode).toBe(expected.mode);
        expect(actual!.permission.task).toBe(
          (expected.permission as Record<string, unknown>).task,
        );
      }
    });
  });
});
