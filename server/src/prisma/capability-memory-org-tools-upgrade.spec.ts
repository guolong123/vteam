import * as fs from 'fs';
import * as path from 'path';
import { toolAllowed } from '../chat/worker-dispatcher';
import {
  ROLE_BOUNDARIES,
  type VteamAgentName,
} from '../common/constants/agent.constants';
import {
  BUILTIN_AGENT_ROLES,
  BUILTIN_ROLE_CAPABILITY_MAPS,
  EXTERNAL_AGENT_ROLE_CAPABILITIES,
  EXTERNAL_AGENT_ROLE_KEYS,
  FALLBACK_AGENT_ROLE,
} from '../common/constants/agent-role.constants';
import {
  buildFactoryCapabilityMatrix,
  capabilityMatrixToToolStates,
} from '../common/constants/platform-capability.constants';
import {
  resolveBuiltinPolicy,
  resolveGuardTools,
  type AgentToolState,
} from '../execution-policies/execution-policy.service';
import { PlatformToolPermissionService } from '../platform-mcp/platform-tool-permission.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 迁移 `20261009020000_capability_memory_org_tools` 的**行为证明**（文本契约 spec 见
 * `capability-memory-org-tools.migration.spec.ts`）。
 *
 * 为什么必须另有此 spec：契约 spec 只做 readFileSync → 剥注释 → 正则，**从不执行 SQL**，
 * 结构上无法回答「回填之后 PM 到底能不能调这两个工具」。本 spec 补上这一环，且刻意
 * **由迁移文件驱动**——逐键赋值从 SQL 里解析出来（而不是在这里重抄一遍），再喂进**真实的**
 * `resolveGuardTools` / `resolveBuiltinPolicy` / `capabilityMatrixToToolStates` /
 * `toolAllowed` / `PlatformToolPermissionService`。SQL 与断言因此无法各自漂移：改 SQL 就改
 * 行为；要让测试变绿就必须同时骗过「SQL 内容」与「运行时判定」两处。
 *
 * 存量行形状（= 生产实测形状）：`agent_roles.capabilities` 为 31 键非 NULL 矩阵、恰好缺
 * `memory.archive`/`memory.merge`；`execution_policies.config.tools` 为 30 条合法项、同样
 * 缺这两键。其余 6 内置岗的矩阵亦缺这两键（default-allow ⇒ 当时**也能**调整理入口）。
 */

const MIGRATION = path.resolve(
  __dirname,
  '..',
  '..',
  'prisma',
  'migrations',
  '20261009020000_capability_memory_org_tools',
  'migration.sql',
);

const TOOL_KEYS = ['vteam_memory_archive', 'vteam_memory_merge'] as const;
const CAPABILITY_KEYS = ['memory.archive', 'memory.merge'] as const;
const PM = 'project_manager';
const PERMISSION_DENIED_CODE = 'PLATFORM_MCP_TOOL_NOT_PERMITTED';

type Matrix = Record<string, boolean>;

function executableSql(): string {
  return fs
    .readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

interface Assignment {
  key: string;
  value: boolean;
  /** `IN (...)` / `NOT IN (...)` 的岗位名单；单键 `= 'x'` 形式为 null。 */
  keys: string[] | null;
  /** 单键 `= 'x'` 形式的目标岗位。 */
  single: string | null;
  negated: boolean;
}

/** 从迁移 SQL 解析 `agent_roles` 的逐键赋值（三种名单形态都要认）。 */
function parsedRoleAssignments(): Assignment[] {
  const out: Assignment[] = [];
  for (const stmt of executableSql().split(';')) {
    const set =
      /JSON_SET\(\s*`capabilities`\s*,\s*'([^']+)'\s*,\s*(true|false)\s*\)/.exec(
        stmt,
      );
    if (!set) continue;
    const list = /`key`\s+(NOT\s+IN|IN)\s*\(([^)]*)\)/.exec(stmt);
    const single = /`key`\s*=\s*'([\w]+)'/.exec(stmt);
    out.push({
      key: set[1].replace('$."', '').replace('"', ''),
      value: set[2] === 'true',
      keys: list ? [...list[2].matchAll(/'([\w]+)'/g)].map((m) => m[1]) : null,
      single: single?.[1] ?? null,
      negated: list ? /^NOT/i.test(list[1]) : false,
    });
  }
  return out;
}

/**
 * 把迁移的 `agent_roles` 赋值应用到一行（模拟 MySQL 执行语义）。
 * 只增不改：键已存在（含显式 false）时原样保留——这正是 SQL 的 `JSON_CONTAINS_PATH(...)=0`
 * 守卫在做的事；`capabilities IS NULL` 的行不被触碰（SQL 的 `IS NOT NULL` 守卫）。
 */
function applyRoleMigration(
  assignments: Assignment[],
  roleKey: string,
  before: Matrix | null,
): Matrix | null {
  if (before === null) return null;
  const after: Matrix = { ...before };
  for (const a of assignments) {
    const hit =
      a.keys === null
        ? a.single === roleKey
        : a.negated
          ? !a.keys.includes(roleKey)
          : a.keys.includes(roleKey);
    if (!hit) continue;
    if (Object.prototype.hasOwnProperty.call(after, a.key)) continue;
    after[a.key] = a.value;
  }
  return after;
}

/** 把迁移的 `execution_policies` 赋值应用到一行 config（模拟 MySQL 执行语义）。 */
function applyPolicyMigration(
  policyId: string,
  before: Record<string, unknown>,
): Record<string, unknown> {
  const after = JSON.parse(JSON.stringify(before)) as Record<string, unknown>;
  for (const stmt of executableSql().split(';')) {
    const set =
      /JSON_SET\(\s*`config`\s*,\s*'\$\."tools"\."([^"]+)"'\s*,\s*'([^']+)'\s*\)/.exec(
        stmt,
      );
    if (!set) continue;
    if (/`id`\s*=\s*'([^']+)'/.exec(stmt)?.[1] !== policyId) continue;
    const tools = after['tools'];
    if (typeof tools !== 'object' || tools === null) continue;
    const record = tools as Record<string, unknown>;
    // 防误建守卫：既有记忆工具在场才动（对应 SQL 的 vteam_memory_update = 1）。
    if (!('vteam_memory_update' in record)) continue;
    if (Object.prototype.hasOwnProperty.call(record, set[1])) continue;
    record[set[1]] = set[2];
  }
  return after;
}

/** 出厂矩阵去掉两个记忆整理键 ⇒ Todo 8a 之前的存量行形状（31 键非 NULL）。 */
function withoutMemoryKeys(matrix: Matrix): Matrix {
  const out: Matrix = { ...matrix };
  for (const key of CAPABILITY_KEYS) delete out[key];
  return out;
}

function storedMatrixOf(roleKey: string): Matrix {
  if (BUILTIN_ROLE_CAPABILITY_MAPS[roleKey]) {
    return withoutMemoryKeys(BUILTIN_ROLE_CAPABILITY_MAPS[roleKey]);
  }
  if ((EXTERNAL_AGENT_ROLE_KEYS as readonly string[]).includes(roleKey)) {
    return withoutMemoryKeys(EXTERNAL_AGENT_ROLE_CAPABILITIES);
  }
  return withoutMemoryKeys(buildFactoryCapabilityMatrix());
}

/** 存量 `config`：出厂 config 去掉两个 vteam 键（生产实测 30 条 tools）。 */
function storedConfigOf(name: VteamAgentName): Record<string, unknown> {
  const boundary = ROLE_BOUNDARIES[name];
  const tools: Record<string, AgentToolState> = {
    ...(boundary.toolAllows as Record<string, AgentToolState>),
  };
  for (const tool of TOOL_KEYS) delete tools[tool];
  return {
    permission: {
      edit: { '*': 'deny' },
      read: { '*': 'allow' },
      bash: boundary.bashEffect,
      task: name === 'vteam-plan' ? 'allow' : 'deny',
    },
    correction: {
      scopeSummary: boundary.scopeSummary,
      handoff: { ...boundary.handoffTo },
      denyTemplate: '',
    },
    tools,
  };
}

/** 真实权限门 + 假 prisma 成员行：断言服务端 `tools/call` 的实际判定。 */
function permissionGate(capabilities: Matrix): PlatformToolPermissionService {
  const prisma = {
    teamMember: {
      findUnique: jest.fn().mockResolvedValue({
        role: { id: 'ar_x', key: 'x', capabilities },
      }),
    },
  };
  return new PlatformToolPermissionService(prisma as unknown as PrismaService);
}

const ROLE_ASSIGNMENTS = parsedRoleAssignments();

describe('记忆整理工具升级回填：回填后的运行时链路（迁移驱动）', () => {
  describe('① 回填前：存量行确实缺这两个键（缺陷的可证伪基线）', () => {
    it('PM 的 config.tools 缺两键 ⇒ 层② allowlist 不含它们，且不回退常量补齐', () => {
      const tools = resolveGuardTools(
        'vteam-project_manager',
        storedConfigOf('vteam-project_manager')['tools'],
      );
      expect(tools).toHaveProperty('vteam_memory_save', 'allow');
      for (const tool of TOOL_KEYS) {
        expect(tools).not.toHaveProperty(tool);
        expect(toolAllowed(tools, tool)).toBe(false);
      }
    });

    it('PM 岗位矩阵缺两键 ⇒ default-allow 放行调用，但能力视图里「没有」这两点', async () => {
      const before = storedMatrixOf(PM);
      for (const key of CAPABILITY_KEYS) expect(before).not.toHaveProperty(key);
      // default-allow：调用不被拦（这正是「看起来有门实则敞开」）。
      await expect(
        permissionGate(before).assertToolAllowed('tmm_pm', 'memory_archive'),
      ).resolves.toBeUndefined();
      const states = capabilityMatrixToToolStates(before);
      for (const tool of TOOL_KEYS) expect(states[tool]).toBe('allow');
    });

    it('非 PM 内置岗同样缺两键 ⇒ 回填前也能调整理入口（与 factory intent 相反）', async () => {
      await expect(
        permissionGate(storedMatrixOf('developer')).assertToolAllowed(
          'tmm_dev',
          'memory_merge',
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('② 回填后：PM 在两层都拿到两个工具', () => {
    const migratedConfig = applyPolicyMigration(
      'ep_project_manager',
      storedConfigOf('vteam-project_manager'),
    );

    it('config.tools 补齐 ⇒ resolveGuardTools / resolveBuiltinPolicy 都放行两键', () => {
      const tools = resolveGuardTools(
        'vteam-project_manager',
        migratedConfig['tools'],
      );
      for (const tool of TOOL_KEYS) {
        expect(tools[tool]).toBe('allow');
        expect(toolAllowed(tools, tool)).toBe(true);
      }
      const resolved = resolveBuiltinPolicy(
        'vteam-project_manager',
        migratedConfig,
      );
      for (const tool of TOOL_KEYS) expect(resolved.tools[tool]).toBe('allow');
    });

    it('补两键不会挤掉 PM 其余工具（resolveGuardTools 整体胜出语义的踩坑点）', () => {
      const resolved = resolveBuiltinPolicy(
        'vteam-project_manager',
        migratedConfig,
      );
      expect(Object.keys(resolved.tools).sort()).toEqual(
        Object.keys(ROLE_BOUNDARIES['vteam-project_manager'].toolAllows).sort(),
      );
    });

    it('capabilities 补齐 ⇒ 能力矩阵把两键映射为 allow（dispatcher 屏蔽表同源）', () => {
      const migrated = applyRoleMigration(
        ROLE_ASSIGNMENTS,
        PM,
        storedMatrixOf(PM),
      ) as Matrix;
      for (const key of CAPABILITY_KEYS) expect(migrated[key]).toBe(true);
      const states = capabilityMatrixToToolStates(migrated);
      for (const tool of TOOL_KEYS) expect(states[tool]).toBe('allow');
    });

    it('capabilities 补齐 ⇒ 服务端权限门对 PM 放行两个工具', async () => {
      const migrated = applyRoleMigration(
        ROLE_ASSIGNMENTS,
        PM,
        storedMatrixOf(PM),
      ) as Matrix;
      const gate = permissionGate(migrated);
      await expect(
        gate.assertToolAllowed('tmm_pm', 'memory_archive'),
      ).resolves.toBeUndefined();
      await expect(
        gate.assertToolAllowed('tmm_pm', 'memory_merge'),
      ).resolves.toBeUndefined();
    });
  });

  describe('③ 回填后：非 PM 岗位被显式拒绝（default-allow 洞被堵）', () => {
    it.each(BUILTIN_AGENT_ROLES.filter((r) => r.key !== PM).map((r) => r.key))(
      '内置岗 %s：两键为 false 且服务端 403',
      async (roleKey) => {
        const migrated = applyRoleMigration(
          ROLE_ASSIGNMENTS,
          roleKey,
          storedMatrixOf(roleKey),
        ) as Matrix;
        for (const key of CAPABILITY_KEYS) {
          expect(migrated[key]).toBe(false);
          expect(migrated[key]).toBe(
            BUILTIN_ROLE_CAPABILITY_MAPS[roleKey][key],
          );
        }
        const states = capabilityMatrixToToolStates(migrated);
        for (const tool of TOOL_KEYS) expect(states[tool]).toBe('deny');
        const gate = permissionGate(migrated);
        for (const tool of TOOL_KEYS) {
          await expect(
            gate.assertToolAllowed('tmm_x', tool),
          ).rejects.toMatchObject({
            response: { code: PERMISSION_DENIED_CODE },
          });
        }
      },
    );

    it.each(EXTERNAL_AGENT_ROLE_KEYS)('外部岗 %s：两键为 false', (roleKey) => {
      const migrated = applyRoleMigration(
        ROLE_ASSIGNMENTS,
        roleKey,
        storedMatrixOf(roleKey),
      ) as Matrix;
      for (const key of CAPABILITY_KEYS) expect(migrated[key]).toBe(false);
    });

    it('其余行（ar_general）：两键为 true，与出厂兜底矩阵一致且不放大授权', async () => {
      const stored = storedMatrixOf(FALLBACK_AGENT_ROLE.key);
      const migrated = applyRoleMigration(
        ROLE_ASSIGNMENTS,
        FALLBACK_AGENT_ROLE.key,
        stored,
      ) as Matrix;
      for (const key of CAPABILITY_KEYS) expect(migrated[key]).toBe(true);
      // default-allow 下回填前它本就被放行 ⇒ 回填只是把隐式放行显式化。
      await expect(
        permissionGate(stored).assertToolAllowed('tmm_g', 'memory_archive'),
      ).resolves.toBeUndefined();
    });
  });

  describe('④ 幂等与「只增不改」（重跑 migrate deploy 必须安全 no-op）', () => {
    it('重复应用回填得到完全相同的矩阵与 config', () => {
      const once = applyRoleMigration(ROLE_ASSIGNMENTS, PM, storedMatrixOf(PM));
      const twice = applyRoleMigration(ROLE_ASSIGNMENTS, PM, once);
      expect(twice).toEqual(once);
      const configOnce = applyPolicyMigration(
        'ep_project_manager',
        storedConfigOf('vteam-project_manager'),
      );
      expect(applyPolicyMigration('ep_project_manager', configOnce)).toEqual(
        configOnce,
      );
    });

    it('运营者已显式的 false / true / deny 原样保留（回填绝不覆盖人工决策）', () => {
      expect(
        applyRoleMigration(ROLE_ASSIGNMENTS, PM, {
          ...storedMatrixOf(PM),
          'memory.archive': false,
        })?.['memory.archive'],
      ).toBe(false);
      expect(
        applyRoleMigration(ROLE_ASSIGNMENTS, 'developer', {
          ...storedMatrixOf('developer'),
          'memory.merge': true,
        })?.['memory.merge'],
      ).toBe(true);
      const configDenied = storedConfigOf('vteam-project_manager');
      (configDenied['tools'] as Record<string, AgentToolState>)[
        'vteam_memory_merge'
      ] = 'deny';
      const migrated = applyPolicyMigration('ep_project_manager', configDenied);
      expect(
        (migrated['tools'] as Record<string, AgentToolState>)[
          'vteam_memory_merge'
        ],
      ).toBe('deny');
    });

    it('capabilities 为 NULL 的行不被本迁移触碰（交给 seed 出厂矩阵补齐）', () => {
      expect(applyRoleMigration(ROLE_ASSIGNMENTS, PM, null)).toBeNull();
    });

    it('半回填行可续跑：已显式 archive=false 的行仍能补上 merge（逐键幂等的语义）', () => {
      // 若两条语句共用一个「两键都缺失」守卫，这类行会被整行跳过 ⇒ merge 永久留空。
      const half = applyRoleMigration(ROLE_ASSIGNMENTS, PM, {
        ...storedMatrixOf(PM),
        'memory.archive': false,
      }) as Matrix;
      expect(half['memory.archive']).toBe(false);
      expect(half['memory.merge']).toBe(true);

      const stored = storedConfigOf('vteam-project_manager');
      const toolsBefore = stored['tools'] as Record<string, AgentToolState>;
      toolsBefore['vteam_memory_archive'] = 'deny';
      const tools = applyPolicyMigration('ep_project_manager', stored)[
        'tools'
      ] as Record<string, AgentToolState>;
      expect(tools['vteam_memory_archive']).toBe('deny');
      expect(tools['vteam_memory_merge']).toBe('allow');
    });
  });

  describe('⑤ 防误建 tools 对象（层② 整体胜出语义的踩坑守卫）', () => {
    it('config 里没有既有记忆工具时，回填不新建只含两键的 tools 对象', () => {
      const bare = {
        permission: { edit: {}, read: {}, bash: 'allow', task: 'deny' },
        correction: {},
      };
      expect(
        applyPolicyMigration('ep_project_manager', bare),
      ).not.toHaveProperty('tools');
    });

    it('tools 缺失时 resolveGuardTools 回退常量（PM 本就含两键，无需回填）', () => {
      const tools = resolveGuardTools('vteam-project_manager', undefined);
      for (const tool of TOOL_KEYS) expect(tools[tool]).toBe('allow');
    });
  });
});
