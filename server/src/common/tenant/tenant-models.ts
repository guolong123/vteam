/**
 * 租户模型策略注册表（**单一事实来源**）。
 *
 * 判定「哪些模型带 workspaceId、读的时候要不要回落系统空间、写的时候目标空间是谁」。
 * 任何新增资源表都必须在这里登记，否则租户中间件不会自动注入过滤/归属（默认按 none 跳过）。
 *
 * 三类：
 * - `platform`：平台资源（内置 Agent 模板 / 角色 / 技能 / 工具 / 执行策略 / 模型目录 / MCP Server）。
 *   读：`workspaceId IN (当前空间, ws_system)`；写：当前空间（系统行由平台管理员在系统空间维护）。
 * - `private`：用户态资源。读：`workspaceId = 当前空间`（**不回落系统空间**）；写：当前空间。
 * - `none`：系统本体（User / Role / Workspace / WorkspaceMember）或未登记模型，不注入。
 *
 * ⚠️ 子表/关联表（TeamMember、SessionTurn、ArtifactVersion、绑定表等）靠父实体承载空间归属，
 *    本表不登记、不加列（见设计文档 §4.4 的「子表豁免」清单）。
 */

export type TenantModelScope = 'platform' | 'private' | 'none';

/** 平台资源：所有空间可读，普通用户只读。 */
export const TENANT_PLATFORM_MODELS = [
  'Agent',
  'AgentRole',
  'Skill',
  'Tool',
  'ExecutionPolicy',
  'Model',
  'McpServer',
] as const;

/** 用户态资源：严格按空间隔离。 */
export const TENANT_PRIVATE_MODELS = [
  'Artifact',
  'ChatChannel',
  'ExternalUser',
  'GitCredential',
  'GitRepo',
  'GitRepoGrant',
  'Hook',
  'Issue',
  'Member',
  'MemberNotificationChannel',
  'Message',
  'MessageChannel',
  'MessageReceipt',
  'ModelCredential',
  'ModelUsage',
  'NotificationChannel',
  'Plan',
  'ProviderTombstone',
  'RealtimeEvent',
  'Session',
  'Task',
  'TaskGroupInstance',
  'Team',
  'Trigger',
  'Worker',
] as const;

/** 系统本体：无 workspaceId 列，不参与自动注入。 */
export const TENANT_SYSTEM_MODELS = [
  'User',
  'Role',
  'Workspace',
  'WorkspaceMember',
] as const;

const SCOPE_MAP: ReadonlyMap<string, TenantModelScope> = new Map([
  ...TENANT_PLATFORM_MODELS.map((m) => [m, 'platform'] as const),
  ...TENANT_PRIVATE_MODELS.map((m) => [m, 'private'] as const),
  ...TENANT_SYSTEM_MODELS.map((m) => [m, 'none'] as const),
]);

/** 模型 → 空间策略；未登记（含子表）一律 none。 */
export function tenantScopeOf(model: string | undefined): TenantModelScope {
  if (!model) {
    return 'none';
  }
  return SCOPE_MAP.get(model) ?? 'none';
}

/** 所有带 workspaceId 的模型（供 seed / 迁移 / 校验脚本复用）。 */
export const TENANT_SCOPED_MODELS: readonly string[] = [
  ...TENANT_PLATFORM_MODELS,
  ...TENANT_PRIVATE_MODELS,
];

/** 读操作（需要注入 where 过滤）。 */
export const TENANT_READ_OPERATIONS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
] as const;

/** 写操作（需要注入归属 / 拦截跨空间）。 */
export const TENANT_WRITE_OPERATIONS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
] as const;
