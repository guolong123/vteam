/**
 * Auth 业务码与角色常量（对齐 09 篇 §2.1 错误码约定 / §3.1 Auth 契约）。
 */
export const AUTH_ERRORS = {
  USERNAME_CONFLICT: 'USERNAME_CONFLICT',
  EMAIL_CONFLICT: 'EMAIL_CONFLICT',
  INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  DISABLED: 'AUTH_DISABLED',
  REFRESH_INVALID: 'AUTH_REFRESH_INVALID',
  UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  /** 忘记密码：账号（用户名/邮箱）不存在 */
  USER_NOT_FOUND: 'AUTH_USER_NOT_FOUND',
  /** 重置密码：token 无效或已过期 */
  RESET_TOKEN_INVALID: 'AUTH_RESET_TOKEN_INVALID',
} as const;

/** 平台内置角色（15 篇 §3.1 roles.name 预置 admin/member） */
export const BUILTIN_ROLES = {
  ADMIN: 'admin',
  MEMBER: 'member',
} as const;

/** JWT claims 类型标记：区分 access / refresh（08 §7.6） */
export const JWT_TOKEN_TYPE = {
  ACCESS: 'access',
  REFRESH: 'refresh',
} as const;
