import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AUTH_ERRORS } from '../auth.constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * 全局 JWT 鉴权守卫（APP_GUARD）。
 * - 命中 @Public() 标记的端点放行（register/login/refresh/health 等）。
 * - 其余端点要求合法 Bearer access token，否则 401 AUTH_UNAUTHORIZED。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  handleRequest(err, user, _info) {
    if (err || !user) {
      throw (
        err ||
        new UnauthorizedException({
          code: AUTH_ERRORS.UNAUTHORIZED,
          message: '未认证或 token 无效/已过期',
        })
      );
    }
    return user;
  }
}
