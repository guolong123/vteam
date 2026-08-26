import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_WORKER_TOKEN, WORKER_ERRORS } from './workers.constants';
import { WorkerTokenGuard, WorkerTokenRequest } from './worker-token.guard';

describe('WorkerTokenGuard', () => {
  let guard: WorkerTokenGuard;
  let config: { get: jest.Mock };

  const mockContext = (
    headers: Record<string, string | string[] | undefined>,
  ): ExecutionContext => {
    const request = { headers } as WorkerTokenRequest;
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  /** 断言抛出的 UnauthorizedException 带 WORKER_TOKEN_INVALID 业务码。 */
  const expectTokenRejected = (ctx: ExecutionContext) => {
    try {
      guard.canActivate(ctx);
      throw new Error('应当抛出 UnauthorizedException');
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).getResponse()).toMatchObject({
        code: WORKER_ERRORS.TOKEN_INVALID,
      });
    }
  };

  beforeEach(() => {
    config = { get: jest.fn().mockReturnValue('my-worker-token') };
    guard = new WorkerTokenGuard(config as never);
  });

  it('正确 token 放行并挂载 request.workerToken', () => {
    const ctx = mockContext({ 'x-worker-token': 'my-worker-token' });

    expect(guard.canActivate(ctx)).toBe(true);
    expect(
      ctx.switchToHttp().getRequest<WorkerTokenRequest>().workerToken,
    ).toBe('my-worker-token');
  });

  it('未配置 WORKER_TOKEN 时回退默认 dev-worker-token', () => {
    config.get.mockReturnValue(undefined);
    const ctx = mockContext({ 'x-worker-token': DEFAULT_WORKER_TOKEN });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('缺失 token → 401 WORKER_TOKEN_INVALID（不抛用户 JWT 语义）', () => {
    expectTokenRejected(mockContext({}));
  });

  it('错误 token → 401 WORKER_TOKEN_INVALID', () => {
    expectTokenRejected(mockContext({ 'x-worker-token': 'wrong-token' }));
  });

  it('header 类型异常（数组）→ 401', () => {
    expectTokenRejected(mockContext({ 'x-worker-token': ['a', 'b'] }));
  });
});
