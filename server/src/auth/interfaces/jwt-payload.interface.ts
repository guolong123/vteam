import { JWT_TOKEN_TYPE } from '../auth.constants';

/** JWT 载荷（对齐 08 §7.6：sub=userId + 角色 + 类型标记） */
export interface JwtPayload {
  /** 用户主键 id */
  sub: string;
  username: string;
  roleId: string;
  /** access | refresh */
  type: string;
}

/** JwtAuthGuard 校验通过后挂到 request.user 上的结构 */
export interface AuthenticatedUser {
  id: string;
  username: string;
  roleId: string;
  tokenType: string;
  /** refresh token 载荷不带该字段 */
  isRefresh?: boolean;
}

export { JWT_TOKEN_TYPE };
