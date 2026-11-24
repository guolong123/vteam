/**
 * 工作空间域常量与错误码。
 *
 * 空间 = 租户边界；用户与空间为 M:N（WorkspaceMember）。
 * 系统空间 `ws_system` 由迁移/seed 建出（isSystem=true），全员隐式可读、普通用户只读。
 */
export const WORKSPACE_ERRORS = {
  /** 空间不存在或已归档。 */
  NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  /** 调用者不是空间成员。 */
  FORBIDDEN: 'WORKSPACE_FORBIDDEN',
  /** 空间名重复（同一 owner 下）。 */
  NAME_CONFLICT: 'WORKSPACE_NAME_CONFLICT',
  /** 系统空间不可重命名/删除/归档。 */
  SYSTEM_IMMUTABLE: 'WORKSPACE_SYSTEM_IMMUTABLE',
  /** 已是成员（重复邀请）。 */
  MEMBER_EXISTS: 'WORKSPACE_MEMBER_EXISTS',
  /** 目标用户不存在。 */
  USER_NOT_FOUND: 'WORKSPACE_USER_NOT_FOUND',
  /** 空间内角色不足（需 owner/admin）。 */
  ROLE_INSUFFICIENT: 'WORKSPACE_ROLE_INSUFFICIENT',
  /** 不能移除/降级空间 owner。 */
  OWNER_PROTECTED: 'WORKSPACE_OWNER_PROTECTED',
  /** 资源类型不支持迁移。 */
  RELOCATE_UNSUPPORTED: 'WORKSPACE_RELOCATE_UNSUPPORTED',
  /** 资源不存在。 */
  RELOCATE_NOT_FOUND: 'WORKSPACE_RELOCATE_NOT_FOUND',
  /** 目标空间不存在/已归档。 */
  RELOCATE_TARGET_NOT_FOUND: 'WORKSPACE_RELOCATE_TARGET_NOT_FOUND',
  /** 目标空间存在同名/同唯一键资源（唯一键冲突）。 */
  RELOCATE_CONFLICT: 'WORKSPACE_RELOCATE_CONFLICT',
  /** 资源仍被其它空间引用，不能迁移（先解除引用）。 */
  RELOCATE_IN_USE: 'WORKSPACE_RELOCATE_IN_USE',
  /** 并发迁移（资源已被移走/变更）。 */
  RELOCATE_CONCURRENT: 'WORKSPACE_RELOCATE_CONCURRENT',
} as const;

/** 资源迁移 id 前缀（workspace_relocations）。 */
export const WORKSPACE_RELOCATION_ID_PREFIX = 'wsr';

/**
 * 允许在空间之间迁移的「配置/能力类」资源白名单。
 * - delegate：Prisma 模型访问名
 * - label：中文名（错误信息/审计展示）
 * - uniqueFields：目标空间内需要做唯一键冲突预检的字段（与 schema 复合唯一键顺序一致；空=无唯一键）
 *
 * ⚠️ 团队 / 任务 / 会话 / 成员 / 消息 / 产出物等业务数据**不在此列**：迁移会破坏上下文语义。
 */
export const RELOCATABLE_RESOURCES = {
  agent: { delegate: 'agent', label: 'Agent', uniqueFields: ['agentKey'] },
  agent_role: {
    delegate: 'agentRole',
    label: '岗位角色',
    uniqueFields: ['key'],
  },
  skill: { delegate: 'skill', label: '技能', uniqueFields: ['name'] },
  tool: { delegate: 'tool', label: '工具', uniqueFields: ['action'] },
  execution_policy: {
    delegate: 'executionPolicy',
    label: '执行策略',
    uniqueFields: [] as string[],
  },
  model: {
    delegate: 'model',
    label: '模型目录条目',
    uniqueFields: ['providerID', 'modelID'],
  },
  model_credential: {
    delegate: 'modelCredential',
    label: '模型凭据',
    uniqueFields: ['providerID'],
  },
  mcp_server: {
    delegate: 'mcpServer',
    label: 'MCP Server',
    uniqueFields: ['name'],
  },
  git_repo: {
    delegate: 'gitRepo',
    label: 'Git 仓库',
    uniqueFields: ['repoUrl'],
  },
  git_credential: {
    delegate: 'gitCredential',
    label: 'Git 凭据',
    uniqueFields: ['name'],
  },
  worker: { delegate: 'worker', label: 'Worker', uniqueFields: [] as string[] },
} as const;

export type RelocatableResourceType = keyof typeof RELOCATABLE_RESOURCES;

export const RELOCATABLE_RESOURCE_TYPES = Object.keys(
  RELOCATABLE_RESOURCES,
) as RelocatableResourceType[];

/** 空间内角色（与平台 RBAC 的 Role 正交）。 */
export const WORKSPACE_ROLE = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
} as const;

export type WorkspaceRole =
  (typeof WORKSPACE_ROLE)[keyof typeof WORKSPACE_ROLE];

/** 可管理成员/空间配置的角色。 */
export const WORKSPACE_MANAGER_ROLES: readonly string[] = [
  WORKSPACE_ROLE.OWNER,
  WORKSPACE_ROLE.ADMIN,
];

/** 空间列表/详情返回结构。 */
export interface WorkspaceSummary {
  id: string;
  name: string;
  isSystem: boolean;
  status: string;
  /** 当前用户在该空间的角色；系统空间为 'member'（隐式）。 */
  role: string;
  ownerUserId: string | null;
  createdAt: string;
}
