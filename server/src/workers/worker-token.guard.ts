import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import {
  DEFAULT_WORKER_TOKEN,
  WORKER_ERRORS,
  WORKER_TOKEN_HEADER,
} from './workers.constants';

/** 携带 worker token 的请求（guard 校验通过后挂载，供 register 计算 tokenHash）。 */
export interface WorkerTokenRequest extends Request {
  workerToken?: string;
}

/**
 * X-Worker-Token 鉴权守卫（架构决策 D1：worker token 与用户 JWT 完全隔离）。
 *
 * - 读取 `X-Worker-Token` header，与部署配置 `WORKER_TOKEN`（process.env，默认
 *   `dev-worker-token`）对比；不匹配一律 401 `WORKER_TOKEN_INVALID`。
 * - 不校验、不依赖用户 JWT（register/heartbeat 端点均 `@Public()` 跳过全局
 *   JwtAuthGuard，由本守卫独立把关）。
 * - 校验通过后把原始 token 挂到 `request.workerToken`，register 据此落库 tokenHash。
 *
 * 对比方式：两侧先 sha256 归一化到固定长度，再 timingSafeEqual 常量时间比较
 * （避免字符串长度差异侧信道）。
 */
@Injectable()
export class WorkerTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<WorkerTokenRequest>();
    const token = request.headers[WORKER_TOKEN_HEADER];
    const expected =
      this.config.get<string>('WORKER_TOKEN') ?? DEFAULT_WORKER_TOKEN;

    if (typeof token !== 'string' || !this.safeEqual(token, expected)) {
      throw new UnauthorizedException({
        code: WORKER_ERRORS.TOKEN_INVALID,
        message: 'X-Worker-Token 无效',
      });
    }

    request.workerToken = token;
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const digestA = createHash('sha256').update(a).digest();
    const digestB = createHash('sha256').update(b).digest();
    return timingSafeEqual(digestA, digestB);
  }
}
