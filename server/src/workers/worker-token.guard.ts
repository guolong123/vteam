import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { resolveWorkspaceByWorkerToken } from '../common/tenant/worker-space-token';
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
  /** 空间注册令牌解析出的空间 id（全局共享 token 旧模式为 undefined） */
  workerSpaceId?: string;
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
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkerTokenRequest>();
    const header = request.headers[WORKER_TOKEN_HEADER];
    if (typeof header !== 'string' || header.trim().length === 0) {
      throw new UnauthorizedException({
        code: WORKER_ERRORS.TOKEN_INVALID,
        message: 'X-Worker-Token 无效',
      });
    }
    const token = header.trim();
    const expected =
      this.config.get<string>('WORKER_TOKEN') ?? DEFAULT_WORKER_TOKEN;

    // 旧模式：全局共享 token（向后兼容既有部署）
    if (this.safeEqual(token, expected)) {
      request.workerToken = token;
      return true;
    }

    // 新模式：空间注册令牌——token 本身反查空间；同一 token 也用于运行期鉴权，
    // 因此不再需要 WORKSPACE_ID / WORKER_JOIN_TOKEN 两个额外参数。
    const workspaceId = await resolveWorkspaceByWorkerToken(
      // 只用到 workspace.findFirst，避免把 PrismaService 泛型带入共享工具
      this.prisma as unknown as {
        workspace: { findFirst: (args: unknown) => Promise<unknown> };
      },
      token,
    );
    if (!workspaceId) {
      throw new UnauthorizedException({
        code: WORKER_ERRORS.TOKEN_INVALID,
        message: 'X-Worker-Token 无效',
      });
    }
    request.workerToken = token;
    request.workerSpaceId = workspaceId;

    // 空间令牌只能操作本空间的 worker：请求若携带 workerId，校验其归属。
    const workerId = this.extractWorkerId(request);
    if (workerId) {
      const worker = (await this.prisma.worker.findUnique({
        where: { id: workerId },
        select: { workspaceId: true },
      })) as { workspaceId?: string } | null;
      // 首次注册时 worker 尚不存在 → 放行（由 register 创建并绑定令牌空间）；
      // 已存在的 worker 才校验空间归属，防止空间令牌越权操作其它空间节点。
      if (worker && worker.workspaceId !== workspaceId) {
        throw new ForbiddenException({
          code: WORKER_ERRORS.WORKER_SPACE_MISMATCH,
          message: '空间注册令牌与目标 worker 所属空间不一致',
        });
      }
    }
    return true;
  }

  /** 从常见位置提取 workerId（不同端点分别用 header / path param / body）。 */
  private extractWorkerId(request: WorkerTokenRequest): string | undefined {
    const header = request.headers['x-worker-id'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const fromParams = params.workerId ?? params.id;
    if (fromParams) return fromParams.trim();
    const body = request.body as
      { workerId?: unknown; id?: unknown } | undefined;
    const fromBody = body?.workerId ?? body?.id;
    if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim();
    return undefined;
  }

  private safeEqual(a: string, b: string): boolean {
    const digestA = createHash('sha256').update(a).digest();
    const digestB = createHash('sha256').update(b).digest();
    return timingSafeEqual(digestA, digestB);
  }
}
