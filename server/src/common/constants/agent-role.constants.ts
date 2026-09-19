import { createHash } from 'crypto';

/**
 * Agent 角色域（agent_roles）常量 —— 单一事实来源（agent-role-entity 计划 todo 1）。
 *
 * 与 account-permission 的 RBAC `Role`（`roles` 表 / 主键前缀 `r_`）**无关**：
 * 本域映射 `agent_roles`，主键前缀 `ar`，禁止命名为 `Role`。
 *
 * 设计要点：
 * - `id` 前缀 `ar`（对齐 `agent: 'a'` / `policy: 'ep'`）；内置行用命名 id
 *   （`ar_<role>`，与 `a_<role>` / `ep_<role>` 逐字对应），迁移派生的自定义行用
 *   `ar_c_<md5(raw)[:16]>`（确定性，见 `deriveCustomAgentRoleKey`）。
 * - `key` 为 machine-safe 唯一标识，必须匹配 `AGENT_KEY_PATTERN`
 *   （`^[a-z][a-z0-9_-]{0,62}$`）。内置 key = 模板 Agent 的 `role` 值。
 * - 无任何能力字段：permission/tools/model/worker 属 ExecutionPolicy / Agent。
 */

/** Agent 角色主键前缀（`ar_<零填充序号>`；内置/迁移派生用命名 id）。 */
export const AGENT_ROLE_ID_PREFIX = 'ar' as const;

/** 角色类型：内置（seed 的 7 个模板角色）/ 自定义（用户创建或迁移回填派生）。 */
export const AGENT_ROLE_TYPES = {
  builtin: 'builtin',
  custom: 'custom',
} as const;

export type AgentRoleType = (typeof AGENT_ROLE_TYPES)[keyof typeof AGENT_ROLE_TYPES];

/**
 * 迁移回填（migration 20260919000007）的确定性 key 派生规则，与 SQL 表达式**逐字节一致**：
 *
 *   stem = LEFT(REGEXP_REPLACE(LOWER(TRIM(raw)), '[^a-z0-9]+', '_'), 32)
 *          ；stem 为空时回落 'role'
 *   key  = 'custom_' || stem || '_' || LEFT(MD5(raw), 8)
 *
 * 注意：MD5 哈希的是 **raw 原文**（非 trim/lower 后的值），保证与 SQL `MD5(a.role)` 一致。
 * `id` 用同一族哈希的前 16 位：`ar_c_` || LEFT(MD5(raw), 16)。
 */
export function deriveCustomAgentRoleKey(raw: string): string {
  const stem =
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'role';
  const hash = createHash('md5').update(raw).digest('hex');
  return `custom_${stem}_${hash.slice(0, 8)}`;
}

/** 迁移派生的自定义角色 id（与 key 同源哈希，确定性、唯一）。 */
export function deriveCustomAgentRoleId(raw: string): string {
  const hash = createHash('md5').update(raw).digest('hex');
  return `ar_c_${hash.slice(0, 16)}`;
}

/** 内置角色行定义（7 个模板角色；`defaultAgentId` 指向 seed 的模板 Agent）。 */
export interface BuiltinAgentRole {
  id: string;
  key: string;
  name: string;
  defaultAgentId: string;
  /** 稳定展示序（1..7，按产品/项目经理/架构师/开发者/测试/计划员/知识管理员）。 */
  sortOrder: number;
}

/**
 * 7 个内置角色 —— 与 `prisma/seed.ts` 的 `templateAgents` 一一对应
 * （key = 模板 `role`，defaultAgentId = 模板 `id`）。migration 与 seed 均引用本清单口径。
 */
export const BUILTIN_AGENT_ROLES: readonly BuiltinAgentRole[] = [
  { id: 'ar_product', key: 'product', name: '产品经理', defaultAgentId: 'a_product', sortOrder: 1 },
  { id: 'ar_project_manager', key: 'project_manager', name: '项目经理', defaultAgentId: 'a_project_manager', sortOrder: 2 },
  { id: 'ar_architect', key: 'architect', name: '架构师', defaultAgentId: 'a_architect', sortOrder: 3 },
  { id: 'ar_developer', key: 'developer', name: '开发者', defaultAgentId: 'a_developer', sortOrder: 4 },
  { id: 'ar_tester', key: 'tester', name: '测试', defaultAgentId: 'a_tester', sortOrder: 5 },
  { id: 'ar_plan', key: 'plan', name: '计划员', defaultAgentId: 'a_plan', sortOrder: 6 },
  { id: 'ar_librarian', key: 'librarian', name: '知识管理员', defaultAgentId: 'a_librarian', sortOrder: 7 },
];

/** key → 内置角色行（供 seed 成员绑定 `roleId` 使用）。 */
export const BUILTIN_AGENT_ROLE_BY_KEY: Record<string, BuiltinAgentRole> =
  Object.fromEntries(BUILTIN_AGENT_ROLES.map((r) => [r.key, r]));

/**
 * 回填兜底自定义角色（case iii：`Agent.role IS NULL` 的成员）。
 * 键固定 `general`，名称「通用」，与 migration 的 INSERT 逐字一致。
 */
export const FALLBACK_AGENT_ROLE = {
  id: 'ar_general',
  key: 'general',
  name: '通用',
  description: '通用角色（未分类）：存量成员的 Agent.role 为空时的回填兜底。',
  sortOrder: 100,
} as const;
