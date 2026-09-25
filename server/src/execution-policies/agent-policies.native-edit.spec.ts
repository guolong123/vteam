import {
  buildEditPermission,
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
  storageRoundTrip,
} from './__fixtures__/policy-fixtures';
import {
  builtinPolicyIdOf,
  ExecutionPolicyService,
} from './execution-policy.service';

/**
 * agent-native-permission-editor Todo 8(a)：DB 驱动的**原生 `permission.edit`** 穿透证明。
 *
 * 与 `agent-policies.matrix.spec.ts` 的关键区别：那个 spec 把
 * `executionPolicy.findMany` mock 成 `[]`（恒走常量回退），因此**无法**证明一条
 * 与出厂值不同的 `edit` 规则能一路穿透到 `/agent-policies` 的消费端。本 spec 让
 * 绑定行 `ep_product` 携带与常量**不同**的 `permission.edit`（`docs` 由 allow 改
 * deny + 新增 `**custom/**`），并断言它到达：
 *   - `buildAgentPolicies()` 的 `agents[].permission.edit` 与
 *     `guard.roles[].permission.edit`（worker injector 的 wire 数据源）；
 *   - `resolveByAgent()` 的 `permission.edit`（dispatcher 注入路径）。
 *
 * 可证伪性（falsifiability）：断言在「DB 行被忽略、走常量回退」时必然失败——见末位
 * 对照用例（空行 → 常量 edit，且 != DB_EDIT）。变异检验见 task-8 evidence。
 */
describe('agent-policies native edit (Todo 8a proof)', () => {
  const baseline = loadAgentPoliciesBaseline();

  /** 编辑对象：`vteam-product`——DB `permission.edit` 刻意偏离常量（docs 收紧 + 新增 glob）。 */
  const EDITED: VteamAgentName = 'vteam-product';

  /**
   * DB 中的原生 edit 规则：与出厂 `{ '*':'deny', prototypes allow, docs allow }` 不同——
   * docs 由 allow 变 deny，并新增 `**custom/**` allow。
   */
  const DB_EDIT: Record<string, 'allow' | 'deny'> = {
    '*': 'deny',
    '**tasks/*/docs/**': 'deny',
    '**custom/**': 'allow',
  };

  /** canonical 发射序：`*` → 该角色 writeGlobs 声明序 → 剩余键字典序。 */
  const DB_EDIT_CANONICAL: Record<string, string> = {
    '*': 'deny',
    '**tasks/*/docs/**': 'deny',
    '**custom/**': 'allow',
  };

  /** 出厂（常量）edit，用于证明 DB_EDIT 确实偏离。 */
  const FACTORY_EDIT = buildEditPermission(ROLE_BOUNDARIES[EDITED].writeGlobs);

  /** DB 编辑后的 product config：仅 permission.edit 偏离，其余字段保持出厂。 */
  function editedProductConfig() {
    const config = factorySeedConfig(EDITED);
    return {
      ...config,
      permission: { ...config.permission, edit: { ...DB_EDIT } },
    };
  }

  /** 6 个未编辑角色用出厂 config，只有 product 用编辑后的 config（行序反转 + MySQL 键序）。 */
  function mixedRows() {
    return [...BUILTIN_ORDER]
      .reverse()
      .map((name) =>
        builtinPolicyRow(
          name,
          storageRoundTrip(
            reorderLikeMysql(
              name === EDITED ? editedProductConfig() : factorySeedConfig(name),
            ),
          ),
        ),
      );
  }

  function serviceWith(rows: unknown[]) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const findUnique = jest
      .fn()
      .mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          (rows as Array<{ id: string }>).find((r) => r.id === where.id) ??
            null,
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

  it('前置断言：DB_EDIT 确实偏离出厂常量（否则本 spec 空转）', () => {
    expect(DB_EDIT_CANONICAL).not.toEqual(FACTORY_EDIT);
    // docs 在 DB 中由 allow 收紧为 deny。
    expect(FACTORY_EDIT['**tasks/*/docs/**']).toBe('allow');
    expect(DB_EDIT_CANONICAL['**tasks/*/docs/**']).toBe('deny');
  });

  it('buildAgentPolicies(): DB 的 permission.edit 穿透到 agents[] 与 guard.roles[]', async () => {
    const { service, findMany } = serviceWith(mixedRows());
    const policies = await service.buildAgentPolicies();

    expect(policies.agents.map((a) => a.name)).toEqual([...BUILTIN_ORDER]);
    expect(findMany).toHaveBeenCalledTimes(1);

    const editedAgent = policies.agents.find((a) => a.name === EDITED);
    const editedRole = policies.guard.roles[EDITED];

    // DB edit 胜出（canonical 序），且确实不同于常量。
    expect(editedAgent?.permission.edit).toEqual(DB_EDIT_CANONICAL);
    expect(editedRole.permission.edit).toEqual(DB_EDIT_CANONICAL);
    expect(canon(editedRole.permission.edit)).not.toBe(canon(FACTORY_EDIT));

    // agent 与 guard 同源：agents[] 是 guard permission 的原生键投影（todo 4）。
    expect(canon(editedAgent?.permission)).toBe(
      canon(projectNativePermission(editedRole.permission)),
    );

    // 新 glob 出现在发射结果里，且 docs 被收紧到 deny。
    const emitted = editedRole.permission.edit as Record<string, string>;
    expect(emitted['**custom/**']).toBe('allow');
    expect(emitted['**tasks/*/docs/**']).toBe('deny');
    expect(emitted['*']).toBe('deny');
  });

  it('buildAgentPolicies(): 未编辑的 6 个内置角色仍与冻结基线逐字节一致', async () => {
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

  it('resolveByAgent(): permission.edit 反映 DB 值（非常量回退）', async () => {
    const { service } = serviceWith(mixedRows());
    const resolved = await service.resolveByAgent({
      agentKey: 'product',
      policyId: 'ep_product',
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.agentName).toBe(EDITED);
    expect(resolved?.permission.edit).toEqual(DB_EDIT_CANONICAL);
    expect(canon(resolved?.permission.edit)).not.toBe(canon(FACTORY_EDIT));
  });

  it('可证伪对照：绑定行全缺 → 回退常量 edit，且 != DB_EDIT（证明上方非空转）', async () => {
    const { service } = serviceWith([]);
    const policies = await service.buildAgentPolicies();

    expect(policies.guard.roles[EDITED].permission.edit).toEqual(FACTORY_EDIT);
    expect(canon(policies.guard.roles[EDITED].permission.edit)).not.toBe(
      canon(DB_EDIT_CANONICAL),
    );
    expect(canon(policies)).toBe(canon(baseline));

    const resolved = await service.resolveByAgent({ agentKey: 'product' });
    expect(resolved?.permission.edit).toEqual(FACTORY_EDIT);
    expect(canon(resolved?.permission.edit)).not.toBe(canon(DB_EDIT_CANONICAL));
  });

  it('策略 id 绑定正确：ed_ 行按 builtinPolicyIdOf(EDITED) 查询', () => {
    expect(builtinPolicyIdOf(EDITED)).toBe('ep_product');
  });
});
