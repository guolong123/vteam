import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_ORDER,
  builtinPolicyRow,
  factorySeedConfig,
  loadAgentPoliciesBaseline,
  loadHistoricalAgentPoliciesBaseline,
  NATIVE_ONLY_EVIDENCE_DIR,
  projectNativePermission,
  reorderLikeMysql,
  storageRoundTrip,
} from './__fixtures__/policy-fixtures';
import {
  ExecutionPolicyService,
  NATIVE_PERMISSION_KEYS,
  projectNativePermission as projectNativePermissionProd,
} from './execution-policy.service';

/**
 * opencode-native-permissions-and-fixes Todo 4+5 契约测试：
 *
 * 1. `agents[].permission` 只含 opencode 原生键——**零 `vteam_` 前缀键**（可证伪：
 *    改回旧发射即红）；
 * 2. 原生键 `edit`/`read`/`bash`/`task` 的**值**与 todo 4 之前的冻结基线逐键一致
 *    （防"顺手改值"把 agent 放出任务目录）；
 * 3. `guard.roles[*]` 恰为 `{permission}`：todo 5 已删除 worker role-guard 层，
 *    `tools`/`bashDeny`/`correction` 三个**死载荷**不得再发射（可证伪：加回任一键即红）；
 *    `permission` 保持完整（含 `vteam_*`），因为是服务端门 `resolveByAgent` 之外
 *    唯一保留该矩阵的展示位，且历史基线逐字节一致仍成立；
 * 4. 新基线 artifact 的 sha256 与其内容自洽（文件即冻结证据）。
 */
describe('agents[].permission native-only payload (todo 4)', () => {
  const baseline = loadAgentPoliciesBaseline();
  const historical = loadHistoricalAgentPoliciesBaseline();

  function serviceWith(rows: unknown[] = []) {
    return new ExecutionPolicyService(
      {
        agent: { findMany: jest.fn().mockResolvedValue([]) },
        executionPolicy: { findMany: jest.fn().mockResolvedValue(rows) },
      } as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
  }

  function historicalAgentByName(name: string) {
    const found = historical.agents.find((a) => a.name === name);
    if (!found) {
      throw new Error(`historical baseline lacks agent ${name}`);
    }
    return found as { name: string; permission: Record<string, unknown> };
  }

  it('零 vteam_ 键：7 内置 agents[].permission 无任何 vteam_ 前缀键，且键集 == 原生四键', async () => {
    const policies = await serviceWith().buildAgentPolicies();
    expect(policies.agents).toHaveLength(7);

    let scanned = 0;
    for (const agent of policies.agents) {
      const keys = Object.keys(agent.permission);
      const offenders = keys.filter((key) => key.startsWith('vteam_'));
      expect(offenders).toEqual([]);
      expect([...keys].sort()).toEqual([...NATIVE_PERMISSION_KEYS].sort());
      // agent 与 guard 的 permission 在 todo 4 后**不同源**：guard 仍保留 vteam_*。
      const guardKeys = Object.keys(policies.guard.roles[agent.name].permission);
      expect(guardKeys).not.toEqual(keys);
      scanned += keys.length;
    }
    expect(scanned).toBe(7 * NATIVE_PERMISSION_KEYS.length);
  });

  it.each(BUILTIN_ORDER)(
    '%s：edit/read/bash/task 的值与 todo 4 之前的历史基线逐键一致',
    async (name) => {
      const policies = await serviceWith().buildAgentPolicies();
      const agent = policies.agents.find((a) => a.name === name);
      expect(agent).toBeDefined();
      const before = historicalAgentByName(name).permission;
      for (const key of NATIVE_PERMISSION_KEYS) {
        expect(agent?.permission[key]).toEqual(before[key]);
      }
    },
  );

  it('历史基线未被本 todo 修改：只读旧 artifact，且仍含 vteam_ 键（对照证明断言非空转）', () => {
    const product = historicalAgentByName('vteam-product');
    const vteamKeys = Object.keys(product.permission).filter((k) =>
      k.startsWith('vteam_'),
    );
    expect(vteamKeys.length).toBeGreaterThan(0);
    // 判别力自检：若把历史 agents[].permission 投影后，vteam_ 键为 0——证明上面的
    // "零 vteam_" 断言能真正区分两种形态（而非恒真）。
    expect(
      Object.keys(
        projectNativePermission(product.permission),
      ).filter((k) => k.startsWith('vteam_')),
    ).toEqual([]);
  });

  it('guard.roles[*] 恰为 {permission}：tools/bashDeny/correction 三个死载荷不再发射（todo 5 回归闸门）', async () => {
    const policies = await serviceWith().buildAgentPolicies();
    for (const agent of policies.agents) {
      const role = policies.guard.roles[agent.name];
      expect(role).toBeDefined();
      expect(Object.keys(role)).toEqual(['permission']);
      expect(role).not.toHaveProperty('tools');
      expect(role).not.toHaveProperty('bashDeny');
      expect(role).not.toHaveProperty('correction');
      expect(Object.keys(role.permission).length).toBeGreaterThan(
        NATIVE_PERMISSION_KEYS.length,
      );
    }
  });

  it('guard.roles[*].permission 与历史基线一致（仅允许已下线工具的 vteam_* deny 键缺席）', async () => {
    const policies = await serviceWith().buildAgentPolicies();
    for (const agent of policies.agents) {
      const current = policies.guard.roles[agent.name].permission as Record<
        string,
        unknown
      >;
      const hist = historical.guard.roles[agent.name].permission as Record<
        string,
        unknown
      >;
      // layer① 的键源是 MCP 工具注册表：注册表删一个工具，历史基线就多一个 vteam_* deny 键。
      // 因此只允许「历史侧独有的 vteam_* 键」缺席；其余键必须逐键同值，且当前侧不得出现新键。
      expect(
        Object.keys(hist)
          .filter((k) => !(k in current))
          .every((k) => k.startsWith('vteam_')),
      ).toBe(true);
      expect(Object.keys(current).filter((k) => !(k in hist))).toEqual([]);
      for (const k of Object.keys(hist)) {
        if (k in current) expect(current[k]).toEqual(hist[k]);
      }
      // 判別力自检：历史基线里这三个键确实存在（证明上面的缺省断言非恒真）。
      expect(historical.guard.roles[agent.name]).toHaveProperty('tools');
      expect(historical.guard.roles[agent.name]).toHaveProperty('bashDeny');
      expect(historical.guard.roles[agent.name]).toHaveProperty('correction');
    }
  });

  it('DB 路径同投影：绑定行携带出厂 config 时 agents[] 仍原生键，guard 仍只留 permission', async () => {
    const rows = BUILTIN_ORDER.map((name) =>
      builtinPolicyRow(
        name,
        storageRoundTrip(reorderLikeMysql(factorySeedConfig(name))),
      ),
    );
    const policies = await serviceWith(rows).buildAgentPolicies();
    for (const agent of policies.agents) {
      expect(
        Object.keys(agent.permission).filter((k) => k.startsWith('vteam_')),
      ).toEqual([]);
      expect(Object.keys(policies.guard.roles[agent.name])).toEqual([
        'permission',
      ]);
      expect(
        Object.keys(policies.guard.roles[agent.name].permission).filter((k) =>
          k.startsWith('vteam_'),
        ).length,
      ).toBeGreaterThan(0);
    }
  });

  it('自定义 agent 同投影：agents[] 原生键、guard.roles 保留策略原始 permission', async () => {
    const policy = {
      id: 'ep_demo',
      name: 'Demo policy',
      description: 'demo',
      type: 'custom',
      config: {
        permission: {
          edit: { '*': 'deny' },
          bash: 'allow',
          task: 'deny',
          vteam_group_post: 'deny',
          vteam_memory_search: 'ask',
        },
        correction: { scopeSummary: 'demo' },
        tools: { vteam_group_post: 'allow' },
      },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const service = new ExecutionPolicyService(
      {
        agent: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'a_0000000001',
              name: 'Demo Agent',
              type: 'custom',
              agentKey: 'demo-agent',
              policyId: 'ep_demo',
              createdAt: new Date(0),
              updatedAt: new Date(0),
            },
          ]),
        },
        executionPolicy: { findMany: jest.fn().mockResolvedValue([policy]) },
      } as never,
      {} as never,
      { broadcastCommand: jest.fn().mockResolvedValue(0) } as never,
    );
    const policies = await service.buildAgentPolicies();
    const agent = policies.agents.find((a) => a.name === 'vteam-demo-agent');
    const role = policies.guard.roles['vteam-demo-agent'];
    expect(agent?.permission).toEqual({
      edit: { '*': 'deny' },
      bash: 'allow',
      task: 'deny',
    });
    expect(role.permission).toHaveProperty('vteam_group_post', 'deny');
    expect(role.permission).toHaveProperty('vteam_memory_search', 'ask');
    expect(Object.keys(role)).toEqual(['permission']);
  });

  it('生产投影只保留原生键（单测投影函数本身，含未知键丢弃与键序）', () => {
    const projected = projectNativePermissionProd({
      vteam_group_post: 'deny',
      task: 'deny',
      edit: { '*': 'deny' },
      write: 'allow',
      bash: 'allow',
      read: { '*': 'allow' },
    });
    expect(Object.keys(projected)).toEqual(['edit', 'read', 'bash', 'task']);
    expect(projected).not.toHaveProperty('write');
    expect(projected).not.toHaveProperty('vteam_group_post');
  });

  it('新基线 artifact：内容与 7 内置发射逐字节一致，且 sha256 自洽可复算', async () => {
    const policies = await serviceWith().buildAgentPolicies();
    expect(policies).toEqual(baseline);
    expect(JSON.stringify(policies)).toBe(JSON.stringify(baseline));

    const file = join(NATIVE_ONLY_EVIDENCE_DIR, 'baseline-agent-policies.json');
    const raw = readFileSync(file);
    const sha = createHash('sha256').update(raw).digest('hex');
    expect(sha).toBe(
      createHash('sha256')
        .update(JSON.stringify(baseline, null, 2) + '\n')
        .digest('hex'),
    );
    // 档案自洽：文件里 agents[] 全部原生键（防止归档件被手改回旧形态）。
    for (const agent of (
      JSON.parse(raw.toString()) as {
        agents: Array<{ name: string; permission: Record<string, unknown> }>;
      }
    ).agents) {
      expect(
        Object.keys(agent.permission).filter((k) => k.startsWith('vteam_')),
      ).toEqual([]);
    }
  });

  it('projectNativePermission 与 fixture 独立实现结果一致（防两侧实现漂移）', () => {
    for (const name of BUILTIN_ORDER) {
      const full = factorySeedConfig(name).permission;
      expect(projectNativePermissionProd(full)).toEqual(
        projectNativePermission(full),
      );
    }
  });
});
