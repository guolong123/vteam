import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildEditPermission,
  buildReadPermission,
  ROLE_BASH_DENY_PATTERNS,
  ROLE_BOUNDARIES,
  ROLE_POLICY_DENY_TEMPLATE,
  type VteamAgentName,
} from '../../common/constants/agent.constants';
import { builtinPolicyIdOf } from '../execution-policy.service';

/**
 * execution-policies 单测共享夹具（F2 FINDING-6 收敛：`reorderLikeMysql` /
 * `factorySeedConfig` / `constantDerived` 曾在 3 个 spec 中复制，收口到本模块一处）。
 *
 * 本模块为**纯夹具**（不依赖 jest），可被任意 spec import；不含生产逻辑。
 */

/** `/agent-policies` 输出顺序（`vteam-plan` 首位 + 5 协作角色 + 只读 `vteam-librarian` 末位）。 */
export const BUILTIN_ORDER: readonly VteamAgentName[] = [
  'vteam-plan',
  'vteam-product',
  'vteam-architect',
  'vteam-developer',
  'vteam-tester',
  'vteam-project_manager',
  'vteam-librarian',
];

/** 常量派生期望输出（策略 config 形状；`permission` 含 `vteam_*` deny 键，与 `resolveBuiltinPolicy` 同形）。 */
export function constantDerived(name: VteamAgentName) {
  const boundary = ROLE_BOUNDARIES[name];
  return {
    description: boundary.scopeSummary,
    mode: name === 'vteam-plan' ? 'all' : 'primary',
    permission: {
      edit: buildEditPermission(boundary.writeGlobs),
      read: buildReadPermission(),
      bash: boundary.bashEffect,
      task: name === 'vteam-plan' ? ('allow' as const) : ('deny' as const),
      ...Object.fromEntries(
        boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
      ),
    },
    tools: { ...boundary.toolAllows },
    bashDeny: [...ROLE_BASH_DENY_PATTERNS],
    correction: {
      scopeSummary: boundary.scopeSummary,
      handoff: { ...boundary.handoffTo },
      denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
    },
  };
}

/**
 * `agents[].permission` 原生键集合（opencode-native-permissions-and-fixes Todo 4）。
 * **刻意独立硬编码**、不 import 生产常量：生产把新原生键加入发射面时本投影不跟随，
 * 字节身份测试即红，强制一次有意的 re-baseline（防静默漂移）。
 */
export const NATIVE_PERMISSION_KEYS_FIXTURE: readonly string[] = [
  'edit',
  'read',
  'bash',
  'task',
] as const;

export function projectNativePermission(
  permission: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    NATIVE_PERMISSION_KEYS_FIXTURE.filter((key) =>
      Object.prototype.hasOwnProperty.call(permission, key),
    ).map((key) => [key, permission[key]]),
  );
}

export function nativePermissionOf(name: VteamAgentName) {
  return projectNativePermission(constantDerived(name).permission);
}

/** seed.ts:903-917 落库的出厂 config（键序即 seed 插入序）。 */
export function factorySeedConfig(name: VteamAgentName) {
  const boundary = ROLE_BOUNDARIES[name];
  return {
    permission: {
      edit: buildEditPermission(boundary.writeGlobs),
      read: buildReadPermission(),
      bash: boundary.bashEffect,
      task: name === 'vteam-plan' ? ('allow' as const) : ('deny' as const),
      ...Object.fromEntries(
        boundary.mcpDenies.map((tool) => [tool, 'deny' as const]),
      ),
    },
    correction: {
      scopeSummary: boundary.scopeSummary,
      handoff: { ...boundary.handoffTo },
      denyTemplate: ROLE_POLICY_DENY_TEMPLATE,
    },
    tools: { ...boundary.toolAllows },
  };
}

/**
 * 常量派生的完整 `/agent-policies` 夹具（`{agents, guard:{enabled, roles}}`），
 * 期望输出由 `ROLE_BOUNDARIES` 独立推导、绝不内联字面量（防漂移）。
 *
 * `agents[].permission` 经原生键投影（todo 4）；`guard.roles[*].permission` 保持
 * 完整（含 `vteam_*`，worker guard 层仍消费）。
 */
export function builtinPoliciesFixture() {
  const agents = BUILTIN_ORDER.map((name) => {
    const derived = constantDerived(name);
    return {
      name,
      description: derived.description,
      mode: derived.mode,
      permission: nativePermissionOf(name),
    };
  });
  const roles = Object.fromEntries(
    BUILTIN_ORDER.map((name) => {
      const derived = constantDerived(name);
      return [
        name,
        {
          permission: derived.permission,
          tools: derived.tools,
          bashDeny: derived.bashDeny,
          correction: derived.correction,
        },
      ];
    }),
  );
  return { agents, guard: { enabled: true as const, roles } };
}

/**
 * 递归按 MySQL `JSON` 列的键序（键长度升序 + 字节序）重排，模拟落库后的键序。
 * 见 execution-policy.service.ts 模块注释：MySQL 原生 JSON 列重排对象键，而字节
 * 一致性要求固定键序，故解析端必须 canonical 化。
 */
export function reorderLikeMysql(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reorderLikeMysql);
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort((a, b) =>
      a.length === b.length
        ? a < b
          ? -1
          : a > b
            ? 1
            : 0
        : a.length - b.length,
    );
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = reorderLikeMysql((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 递归反转键序（另一种确定性的乱序，验证不依赖单一重排模式）。 */
export function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(
      value as Record<string, unknown>,
    ).reverse()) {
      out[key] = reverseKeys(val);
    }
    return out;
  }
  return value;
}

/** JSON 存储往返：`JSON.parse(JSON.stringify(x))`。 */
export function storageRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** 内置绑定策略行夹具（id 与 `builtinPolicyIdOf(name)` 一致）。 */
export function builtinPolicyRow(name: VteamAgentName, config: unknown) {
  return {
    id: builtinPolicyIdOf(name),
    name: `policy-${name}`,
    description: null,
    type: 'template',
    config,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/* -------------------------------------------------------------------------- */
/* 冻结基线（.omo/evidence）读取：缺失即**清晰报错**，绝不静默跳过                  */
/* -------------------------------------------------------------------------- */

/** 历史证据目录：boundary 基线 + 旧 `/agent-policies` 基线（历史产物，只读不改）。 */
export const EVIDENCE_DIR = join(
  __dirname,
  '../../../../.omo/evidence/vteam-role-behavior-abstraction',
);

/** 本计划证据目录：todo 4 新基线所在。 */
export const NATIVE_ONLY_EVIDENCE_DIR = join(
  __dirname,
  '../../../../.omo/evidence/opencode-native-permissions-and-fixes',
);

export interface AgentPoliciesBaseline {
  agents: Array<Record<string, unknown>>;
  guard: {
    enabled: boolean;
    roles: Record<string, Record<string, unknown>>;
  };
}

export interface BoundaryBaseline {
  sections: Record<string, string>;
}

/**
 * 读取冻结基线 JSON。
 *
 * BLOCKER-1 修复：基线文件必须**随仓库提交**（`git ls-files` 可见），否则干净检出
 * 下测试不可复现。缺失时抛错而不是静默跳过——断言基线一致性是这些 spec 的核心
 * 价值，跳过会让「证明」退化为空转。
 */
export function loadEvidenceJson<T>(fileName: string, dir = EVIDENCE_DIR): T {
  const filePath = join(dir, fileName);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(
      `[policy-fixtures] 缺失冻结基线 ${filePath}。` +
        `该文件必须随仓库提交（${dir.replace(/^.*\.omo/, '.omo')}/${fileName}），` +
        `否则干净检出下测试无法复现；请 git add 该文件后重跑。`,
    );
  }
  return JSON.parse(raw) as T;
}

/** `/agent-policies` 出厂基线（todo 4 新基线：agents[] 原生键，guard.roles[*] 含 vteam_*）。 */
export function loadAgentPoliciesBaseline(): AgentPoliciesBaseline {
  return loadEvidenceJson<AgentPoliciesBaseline>(
    'baseline-agent-policies.json',
    NATIVE_ONLY_EVIDENCE_DIR,
  );
}

/** todo 4 之前的出厂基线（历史产物，只读不改）：证明原生键值与 guard 矩阵未漂移。 */
export function loadHistoricalAgentPoliciesBaseline(): AgentPoliciesBaseline {
  return loadEvidenceJson<AgentPoliciesBaseline>('before-agent-policies.json');
}

/** 内置 7 角色 boundary 渲染基线（`{sections: {name: 渲染字符串}}`）。 */
export function loadBoundaryBaseline(): BoundaryBaseline {
  return loadEvidenceJson<BoundaryBaseline>('before-boundary.json');
}
