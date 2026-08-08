import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import {
  DEFAULT_WORKER_TOKEN,
  WORKER_ERRORS,
  WORKER_TOKEN_HEADER,
} from './workers.constants';
import { WorkerTokenRequest } from './worker-token.guard';

/**
 * 资源端点双通道守卫（T4b worker 注入拉取）。
 *
 * 场景：skills/tools/mcp-servers 的 GET 端点原先仅接受用户 JWT（全局 JwtAuthGuard），
 * 但 T4b 要求 worker 用 X-Worker-Token 拉取资源（架构决策 D1：worker token 与用户
 * JWT 完全隔离）。端点挂 `@Public()` 跳过全局 JWT 守卫后，由本守卫做二选一鉴权：
 *   1. 请求带 X-Worker-Token → 与部署配置 WORKER_TOKEN 比对（timingSafeEqual），
 *      通过后挂 `request.workerToken`，与 WorkerTokenGuard 语义一致。
 *   2. 否则 → 委托 passport 'jwt' 策略校验用户 Bearer token（复用全局已注册策略），
 *      校验结果挂 `request.user`（skills.service 据此判断 admin 做成员只读过滤）。
 *
 * 注意：不委托全局 JwtAuthGuard 实例——端点的 @Public() 标记会让其直接放行。
 * 直接 new AuthGuard('jwt')（memoize 工厂），passport 策略由 AuthModule 初始化时
 * 全局注册，请求期必然可用。
 */
@Injectable()
export class WorkerOrJwtGuard implements CanActivate {
  private readonly jwtGuard = new (AuthGuard('jwt'))();

  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkerTokenRequest>();
    const token = request.headers[WORKER_TOKEN_HEADER];

    if (typeof token === 'string' && token.trim().length > 0) {
      const expected =
        this.config.get<string>('WORKER_TOKEN') ?? DEFAULT_WORKER_TOKEN;
      if (!this.safeEqual(token.trim(), expected)) {
        throw new UnauthorizedException({
          code: WORKER_ERRORS.TOKEN_INVALID,
          message: 'X-Worker-Token 无效',
        });
      }
      request.workerToken = token.trim();
      return true;
    }

    return Boolean(await this.jwtGuard.canActivate(context));
  }

  private safeEqual(a: string, b: string): boolean {
    const digestA = createHash('sha256').update(a).digest();
    const digestB = createHash('sha256').update(b).digest();
    return timingSafeEqual(digestA, digestB);
  }
}
