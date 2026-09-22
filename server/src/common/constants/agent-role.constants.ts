import { createHash } from 'crypto';
import { buildCapabilityMatrixFromTools } from './platform-capability.constants';

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
 * - 唯一能力字段是 `capabilities`（岗位**业务能力点矩阵**，`Record<string, boolean>`；
 *   缺失键 ⇒ 允许）——服务端 `vteam_*` 工具权限的权威来源（2026-09-21 capability model）。
 *   引擎原生权限（permission/tools/model/worker）仍属 ExecutionPolicy / Agent，与岗位解耦。
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

/**
 * Agent 角色域错误码（agent-role-entity todo 6，随异常响应的 code 字段返回）。
 *
 * 命名沿用现有约定（大写 SNAKE）。`AGENT_ROLE_BUILTIN_READONLY` 镜像 agents 模块的
 * `PERMISSION_AGENT_READONLY`（`type=template` → 403）保护语义：本域 `type='builtin'`
 * 的内置角色不可删除。其余为角色域自有码（404/400/409）。
 */
export const AGENT_ROLE_ERRORS = {
  /** 目标角色不存在 → 404。 */
  AGENT_ROLE_NOT_FOUND: 'AGENT_ROLE_NOT_FOUND',
  /** 内置角色只读：DELETE type=builtin → 403（镜像 AGENT_ERRORS.AGENT_READONLY）。 */
  AGENT_ROLE_BUILTIN_READONLY: 'AGENT_ROLE_BUILTIN_READONLY',
  /** key 非法（格式不符 / 缺失）→ 400。 */
  AGENT_ROLE_KEY_INVALID: 'AGENT_ROLE_KEY_INVALID',
  /** key 唯一冲突 → 409（P2002）。 */
  AGENT_ROLE_KEY_CONFLICT: 'AGENT_ROLE_KEY_CONFLICT',
  /** defaultAgentId 指向不存在的 Agent → 400。 */
  AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND: 'AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND',
  /** capabilities 含目录外能力点键 / 非 boolean 值 → 400。 */
  AGENT_ROLE_CAPABILITY_KEY_INVALID: 'AGENT_ROLE_CAPABILITY_KEY_INVALID',
  /** 默认 Agent 槽位冲突（`defaultAgentId` 与 `defaultOpencodeAgentName` 同时非空）→ 400。 */
  AGENT_ROLE_DEFAULT_SLOT_CONFLICT: 'AGENT_ROLE_DEFAULT_SLOT_CONFLICT',
  /** 角色被团队成员引用（FK ON DELETE RESTRICT）→ 409，不可静默删除。 */
  AGENT_ROLE_IN_USE: 'AGENT_ROLE_IN_USE',
} as const;

export type AgentRoleErrorCode =
  (typeof AGENT_ROLE_ERRORS)[keyof typeof AGENT_ROLE_ERRORS];

/**
 * `defaultOpencodeAgentName`（外部引擎 Agent 名）的 DTO 长度上限。
 *
 * 实测依据（2026-09-20，live worker `GET /agent?directory=/data/vteam-worker`）：
 * 引擎返回 23 个 agent，最长名为 `Prometheus - Plan Builder`（25 字符）；
 * oh-my-openagent 4.19.4 的 display-name 表（dist/index.js `AGENT_DISPLAY_NAMES`）
 * 最长亦为 25。但 display 名可由用户 `overrides[].displayName` 自定义（无固有上限），
 * 故不取「当前最长」，取 128 留足余量；同时与列宽 `VARCHAR(128)` 一致。
 * 名字含空格/大写，仅限长、不做格式约束。
 */
export const AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH = 128 as const;

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

/**
 * 外部引擎岗位（`defaultOpencodeAgentName` 非空、无内部 Agent）的最小能力集。
 *
 * 外部引擎 Agent（如 Sisyphus/Prometheus/Atlas）不是平台内受管 Agent：它们**不得**
 * 创建任务、加成员、流转任务、创建技能、确认提问，也不得驱动 wecom/外发通道。
 * 仅放行协作/取证/产出所需的 8 个 `vteam_*` 工具，其余能力点显式 `false`。
 * migration 在存量库按 key 写入本能力矩阵；seed 对已存在的 NULL 行补齐。
 */
/** 外部岗位 key 清单（存量 live 数据；migration/seed 按 key 写入最小能力矩阵）。 */
export const EXTERNAL_AGENT_ROLE_KEYS: readonly string[] = [
  'sisyphus',
  'prometheus',
  'atlas',
] as const;

/** 外部岗位允许的 `vteam_*` 工具全集（其余 deny）。 */
export const EXTERNAL_AGENT_ROLE_TOOL_ALLOWLIST: readonly string[] = [
  'vteam_group_post',
  'vteam_chat_history',
  'vteam_doclib',
  'vteam_submit_artifact',
  'vteam_notify_agent',
  'vteam_task_context',
  'vteam_my_profile',
  'vteam_team_view',
] as const;

/**
 * 外部岗位的最小能力矩阵（由 8 工具 allowlist 经目录映射；未覆盖能力点显式 `false`）。
 * default-allow 语义下必须显式拒绝，否则外部岗位会因「缺失键 ⇒ 允许」获得全部能力。
 */
export const EXTERNAL_AGENT_ROLE_CAPABILITIES: Record<string, boolean> =
  buildCapabilityMatrixFromTools(
    Object.fromEntries(
      EXTERNAL_AGENT_ROLE_TOOL_ALLOWLIST.map((tool) => [tool, 'allow']),
    ),
  );

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
