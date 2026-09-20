import {
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import {
  BUILTIN_ORDER,
  builtinPolicyRow,
  factorySeedConfig,
  loadAgentPoliciesBaseline,
  projectNativePermission,
  reorderLikeMysql,
} from './__fixtures__/policy-fixtures';
import { ExecutionPolicyService } from './execution-policy.service';

/**
 * vteam-role-behavior-abstraction Todo 15（收口证明）：DB 行真实驱动内置 7 角色。
 *
 * 与 `agent-policies.matrix.spec.ts` / `agent-policies.custom-agents.spec.ts` 的关键区别：
 * 那两个 spec 把 `executionPolicy.findMany` mock 成 `[]`（恒走常量回退），因此**无法**
 * 证明 DB 读路径已接线。本 spec 让绑定行携带与常量**不同**的 `config.tools` /
 * `config.permission`，并断言它一路穿透到：
 *   - `buildAgentPolicies()` 的 `agents[]` 与 `guard.roles[]`（Todo 3 的 DB 读路径）；
 *   - `resolveByAgent()` / `resolveManyByAgents()` 的 guard payload（Todo 4 去掉短路后的路径）。
 *
 * 同时断言发射形状满足 worker `buildAgentDefinitions()` 的严格字段契约（字段集不可增减，
 * 否则 injector 抛错并整体中性化 guard），且未编辑的 6 个内置角色与冻结基线逐字节一致。
 *
 * 变异检验（mutation check，见 task-15 evidence）：
 *   - 还原 Todo 3（`buildAgentPolicies()` 不读行、直接常量）→ 本 spec 的 DB 值断言失败；
 *   - 还原 Todo 4（`guardForAgent` 对内置名短路）→ 本 spec 的 resolveByAgent 断言失败。
 */
describe('agent-policies db-driven builtins (Todo 15 proof)', () => {
  const baseline = loadAgentPoliciesBaseline();

  /** 编辑对象：`vteam-product`——DB `tools` 与 `permission` 都刻意偏离常量。 */
  const EDITED: VteamAgentName = 'vteam-product';
  const DB_TOOLS = {
    vteam_memory_search: 'ask',
    vteam_group_post: 'deny',
    vteam_hook_cancel: 'deny',
  } as const;
  /** canonical 序（product `toolAllows` 声明序：group_post → memory_search → hook_cancel）。 */
  const DB_TOOLS_CANONICAL = {
    vteam_group_post: 'deny',
    vteam_memory_search: 'ask',
    vteam_hook_cancel: 'deny',
  };

  /** DB 编辑后的 product config：tools 换成差异矩阵，permission 加 bash=deny + channel_send=deny。 */
  function editedProductConfig() {
    const config = factorySeedConfig(EDITED);
    return {
      ...config,
      permission: {
        ...config.permission,
        bash: 'deny' as const,
        vteam_channel_send: 'deny' as const,
      },
      tools: { ...DB_TOOLS },
    };
  }

  /** 6 个未编辑角色用出厂 config，只有 product 用编辑后的 config（行序反转 + MySQL 键序）。 */
  function mixedRows() {
    return [...BUILTIN_ORDER]
      .reverse()
      .map((name) =>
        builtinPolicyRow(
          name,
          JSON.parse(
            JSON.stringify(
              reorderLikeMysql(
                name === EDITED
                  ? editedProductConfig()
                  : factorySeedConfig(name),
              ),
            ),
          ),
        ),
      );
  }

  function serviceWith(rows: unknown[], findUniqueRow?: unknown) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const findUnique = jest
      .fn()
      .mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          findUniqueRow !== undefined
            ? findUniqueRow
            : ((rows as Array<{ id: string }>).find((r) => r.id === where.id) ??
                null),
        ),
      );
    const service = new ExecutionPolicyService(
      {
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: { findMany, findUnique },
      } as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
    return { service, findMany, findUnique };
  }

  function canon(value: unknown): string {
    return JSON.stringify(value);
  }

  it('buildAgentPolicies(): DB 的 tools/permission 穿透到 agents[] 与 guard.roles[]，非法值丢弃', async () => {
    const { service, findMany } = serviceWith(mixedRows());
    const policies = await service.buildAgentPolicies();

    // 顺序恒取常量，且单次批量拉取 7 个绑定 id。
    expect(policies.agents.map((a) => a.name)).toEqual([...BUILTIN_ORDER]);
    expect(findMany).toHaveBeenCalledTimes(1);

    const editedAgent = policies.agents.find((a) => a.name === EDITED);
    const editedRole = policies.guard.roles[EDITED];

    // DB tools 胜出（canonical 序），且确实不同于常量 allowlist。
    expect(editedRole.tools).toEqual(DB_TOOLS_CANONICAL);
    expect(canon(editedRole.tools)).not.toBe(
      canon(ROLE_BOUNDARIES[EDITED].toolAllows),
    );
    // DB permission 胜出：bash 由 allow 变 deny，新增 channel_send deny。
    expect((editedRole.permission as { bash?: string }).bash).toBe('deny');
    expect(
      (editedRole.permission as Record<string, string>).vteam_channel_send,
    ).toBe('deny');
    expect(editedRole.permission).not.toEqual(
      (baseline.guard.roles[EDITED] as { permission: unknown }).permission,
    );
    // agent 与 guard 同源：agents[] 是 guard permission 的原生键投影（todo 4）。
    expect(canon(editedAgent?.permission)).toBe(
      canon(projectNativePermission(editedRole.permission)),
    );
  });

  it('buildAgentPolicies(): 未编辑的 6 个内置角色与冻结基线逐字节一致', async () => {
    const { service } = serviceWith(mixedRows());
    const policies = await service.buildAgentPolicies();

    const baselineAgentByName = new Map(
      baseline.agents.map((a) => [a.name as string, a]),
    );
    for (const name of BUILTIN_ORDER) {
      if (name === EDITED) continue;
      const agent = policies.agents.find((a) => a.name === name);
      expect(canon(agent)).toBe(canon(baselineAgentByName.get(name)));
      expect(canon(policies.guard.roles[name])).toBe(
        canon(baseline.guard.roles[name]),
      );
    }
  });

  it('resolveByAgent(): 内置名的 guard payload 反映 DB tools/permission（Todo 4 短路已移除）', async () => {
    const { service } = serviceWith(mixedRows());
    const resolved = await service.resolveByAgent({
      agentKey: 'product',
      policyId: 'ep_product',
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.agentName).toBe(EDITED);
    expect(resolved?.tools).toEqual(DB_TOOLS_CANONICAL);
    expect(resolved?.tools).not.toEqual(ROLE_BOUNDARIES[EDITED].toolAllows);
    expect((resolved?.permission as { bash?: string }).bash).toBe('deny');
    expect(resolved?.bashDeny).toEqual([...ROLE_BASH_DENY_PATTERNS]);
  });

  it('resolveManyByAgents(): 与单条解析同源，内置名的 guard payload 同样反映 DB 值', async () => {
    const { service } = serviceWith(mixedRows());
    const [product, plan] = await service.resolveManyByAgents([
      { policyId: 'ep_product', agentKey: 'product' },
      { policyId: 'ep_plan', agentKey: 'plan' },
    ]);

    expect(product?.tools).toEqual(DB_TOOLS_CANONICAL);
    // 未编辑的 vteam-plan 仍等于常量。
    expect(plan?.tools).toEqual(ROLE_BOUNDARIES['vteam-plan'].toolAllows);
  });

  it('发射形状满足 worker buildAgentDefinitions 严格字段契约（字段集不可增减）', async () => {
    const { service } = serviceWith(mixedRows());
    const policies = await service.buildAgentPolicies();

    // agent 定义恰为 {name,description,mode,permission}；permission 无 write 键。
    for (const agent of policies.agents) {
      expect(Object.keys(agent).sort()).toEqual([
        'description',
        'mode',
        'name',
        'permission',
      ]);
      expect(agent.mode === 'primary' || agent.mode === 'all').toBe(true);
      expect(agent.permission).not.toHaveProperty('write');
    }
    // guard role 恰为 {permission,tools,bashDeny,correction}；tools 三态、bashDeny string[]。
    const states = new Set(['allow', 'ask', 'deny']);
    for (const role of Object.values(policies.guard.roles)) {
      expect(Object.keys(role).sort()).toEqual([
        'bashDeny',
        'correction',
        'permission',
        'tools',
      ]);
      for (const value of Object.values(role.tools)) {
        expect(states.has(value as string)).toBe(true);
      }
      for (const pattern of role.bashDeny) {
        expect(typeof pattern).toBe('string');
      }
      expect(role.correction).not.toHaveProperty('write');
    }
    expect(policies.guard.enabled).toBe(true);
  });

  it('行全缺时回退常量（对照：无 DB 行 ≠ 编辑后的值，证明上方断言非空转）', async () => {
    const { service } = serviceWith([]);
    const policies = await service.buildAgentPolicies();
    expect(policies.guard.roles[EDITED].tools).toEqual(
      ROLE_BOUNDARIES[EDITED].toolAllows,
    );
    expect(policies.guard.roles[EDITED].tools).not.toEqual(DB_TOOLS_CANONICAL);
    expect(canon(policies)).toBe(canon(baseline));
  });
});
