import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/**
 * 认证用户结构：对应全局 JwtAuthGuard / JwtStrategy.validate 的返回
 * （{id, username, roleId, tokenType}，来源为 JWT access payload）。
 */
export interface AuthenticatedUser {
  id: string;
  username: string;
  roleId: string;
  tokenType?: string;
}

/**
 * `@CurrentUser()` 参数装饰器：从 `req.user` 提取当前登录用户。
 * `req.user` 由全局 JwtAuthGuard（JWT 校验）挂载，projects 端点不再依赖
 * x-user-id 占位守卫。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: AuthenticatedUser }>();
    return request.user;
  },
);
