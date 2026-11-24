/**
 * 多工作空间（租户）常量。
 *
 * 空间 = 租户边界：
 * - 平台内置资源归属 `ws_system`（isSystem=true，所有人隐式可读、普通用户只读）；
 * - 用户创建的数据归属其当前空间；
 * - 存量数据统一归 `ws_default`（迁移与 seed 建出的默认空间）。
 *
 * 这两个 id 是**固定引导 id**（迁移 SQL 与 seed 使用同一字面量，非 IdGenerator 序号），
 * 因此代码里以常量引用，不要散落硬编码。
 */

/** 固定引导空间 id（迁移/seed 与运行时代码的唯一事实来源）。 */
export const TENANT_WORKSPACE_ID = {
  /** 平台空间：承载全部 seed / 平台内置资源，全员隐式可读。 */
  SYSTEM: 'ws_system',
  /** 默认空间：存量数据归属，迁移后 admin 为 owner。 */
  DEFAULT: 'ws_default',
} as const;

/** 空间成员角色（空间内权限，与平台 RBAC 的 Role 正交）。 */
export const WORKSPACE_MEMBER_ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
} as const;

export type WorkspaceMemberRole =
  (typeof WORKSPACE_MEMBER_ROLES)[keyof typeof WORKSPACE_MEMBER_ROLES];

/** 空间状态。 */
export const WORKSPACE_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
} as const;

/** 租户相关错误码（随异常响应 code 字段返回）。 */
export const TENANT_ERRORS = {
  /** 请求缺少当前空间（JWT 无 wid 且无法回退到成员关系）。 */
  WORKSPACE_REQUIRED: 'TENANT_WORKSPACE_REQUIRED',
  /** 目标空间不存在或已归档。 */
  WORKSPACE_NOT_FOUND: 'TENANT_WORKSPACE_NOT_FOUND',
  /** 调用者不是目标空间成员（且非平台管理员的跨空间只读）。 */
  WORKSPACE_FORBIDDEN: 'TENANT_WORKSPACE_FORBIDDEN',
  /** 平台管理员跨空间只读态下尝试写操作。 */
  CROSS_WORKSPACE_WRITE_FORBIDDEN: 'TENANT_CROSS_WORKSPACE_WRITE_FORBIDDEN',
  /** 普通用户尝试写系统空间（平台资源只读）。 */
  SYSTEM_WORKSPACE_WRITE_FORBIDDEN: 'TENANT_SYSTEM_WORKSPACE_WRITE_FORBIDDEN',
  /** 无租户上下文的请求尝试访问隔离模型（防御性兜底）。 */
  CONTEXT_MISSING: 'TENANT_CONTEXT_MISSING',
} as const;

/**
 * 空间在文件系统路径/URL 中使用的目录名：仅允许字母数字下划线连字符（防路径穿越），
 * 其余字符替换为 `-`；空串回落 `default`。
 */
export function workspaceDirSegment(workspaceId?: string): string {
  const raw = String(workspaceId ?? '').trim();
  if (!raw) return 'default';
  const seg = raw.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return seg || 'default';
}

/** 跨空间只读时透传的目标空间请求头（仅平台管理员生效，服务端校验后写入上下文）。 */
export const TENANT_WORKSPACE_HEADER = 'x-workspace-id';
