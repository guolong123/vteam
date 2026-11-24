import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { firstValueFrom, Observable } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { AUTH_ERRORS } from '../auth.constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { WORKER_OR_JWT_KEY } from '../decorators/worker-or-jwt.decorator';
import {
  DEFAULT_WORKER_TOKEN,
  WORKER_ERRORS,
} from '../../workers/workers.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveWorkspaceByWorkerToken } from '../../common/tenant/worker-space-token';

const WORKER_TOKEN_HEADER = 'x-worker-token';

/**
 * 全局 JWT 鉴权守卫（APP_GUARD）。
 * - 命中 @Public() 标记的端点放行（register/login/refresh/health 等）。
 * - 其余端点要求合法 Bearer access token，否则 401 AUTH_UNAUTHORIZED。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    // 双通道路由：worker token 通道在此放行（X-Worker-Token 与全局共享 token 比对），
    // 用户 JWT 仍走 passport 校验。仅标记了 @WorkerOrJwtAllowed() 的端点可用。
    const workerOrJwt = this.reflector.getAllAndOverride<boolean>(
      WORKER_OR_JWT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (workerOrJwt) {
      const request = context
        .switchToHttp()
        .getRequest<Request & { workerToken?: string }>();
      const token = (request.headers as unknown as Record<string, unknown>)[
        WORKER_TOKEN_HEADER
      ];
      if (typeof token === 'string' && token.trim().length > 0) {
        const expected =
          this.config.get<string>('WORKER_TOKEN') ?? DEFAULT_WORKER_TOKEN;
        const a = createHash('sha256').update(token.trim()).digest();
        const b = createHash('sha256').update(expected).digest();
        if (timingSafeEqual(a, b)) {
          request.workerToken = token.trim();
          return true;
        }
        // 单令牌模式：空间注册令牌也可用于 worker 资源拉取端点
        // （/skills、/agent-policies、/mcp-servers 等 WorkerOrJwt 双通道路由）。
        const spaceWorkspaceId = await resolveWorkspaceByWorkerToken(
          this.prisma as unknown as {
            workspace: { findFirst: (args: unknown) => Promise<unknown> };
          },
          token,
        );
        if (spaceWorkspaceId) {
          request.workerToken = token.trim();
          return true;
        }
        throw new UnauthorizedException({
          code: WORKER_ERRORS.TOKEN_INVALID,
          message: 'X-Worker-Token 无效',
        });
      }
    }
    const result = super.canActivate(context) as
      boolean | Promise<boolean> | Observable<boolean>;
    if (typeof result === 'boolean') return result;
    if (result instanceof Observable) {
      return (await firstValueFrom(result)) as boolean;
    }
    return (await result) as boolean;
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
