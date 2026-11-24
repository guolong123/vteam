import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { DEFAULT_WORKER_TOKEN, WORKER_ERRORS } from './workers.constants';
import { WorkerTokenGuard, WorkerTokenRequest } from './worker-token.guard';

describe('WorkerTokenGuard', () => {
  let guard: WorkerTokenGuard;
  let config: { get: jest.Mock };
  let prisma: {
    workspace: { findFirst: jest.Mock };
    worker: { findUnique: jest.Mock };
  };

  const mockContext = (
    headers: Record<string, string | string[] | undefined>,
    extra: Partial<WorkerTokenRequest> = {},
  ): ExecutionContext => {
    const request = { headers, ...extra } as WorkerTokenRequest;
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };

  const expectRejected = async (
    ctx: ExecutionContext,
    ctor: typeof UnauthorizedException | typeof ForbiddenException,
    code: string,
  ) => {
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ctor);
    try {
      await guard.canActivate(ctx);
    } catch (err) {
      expect((err as UnauthorizedException).getResponse()).toMatchObject({
        code,
      });
    }
  };

  beforeEach(() => {
    config = { get: jest.fn().mockReturnValue('my-worker-token') };
    prisma = {
      workspace: { findFirst: jest.fn().mockResolvedValue(null) },
      worker: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    guard = new WorkerTokenGuard(config as never, prisma as never);
  });

  it('全局 token 放行并挂载 request.workerToken（旧模式兼容）', async () => {
    const ctx = mockContext({ 'x-worker-token': 'my-worker-token' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(
      ctx.switchToHttp().getRequest<WorkerTokenRequest>().workerToken,
    ).toBe('my-worker-token');
  });

  it('未配置 WORKER_TOKEN 时回退默认 dev-worker-token', async () => {
    config.get.mockReturnValue(undefined);
    await expect(
      guard.canActivate(
        mockContext({ 'x-worker-token': DEFAULT_WORKER_TOKEN }),
      ),
    ).resolves.toBe(true);
  });

  it('缺失 token → 401 WORKER_TOKEN_INVALID', async () => {
    await expectRejected(
      mockContext({}),
      UnauthorizedException,
      WORKER_ERRORS.TOKEN_INVALID,
    );
  });

  it('错误 token（既非全局也非空间令牌）→ 401', async () => {
    await expectRejected(
      mockContext({ 'x-worker-token': 'wrong-token' }),
      UnauthorizedException,
      WORKER_ERRORS.TOKEN_INVALID,
    );
  });

  it('header 类型异常（数组）→ 401', async () => {
    await expectRejected(
      mockContext({ 'x-worker-token': ['a', 'b'] }),
      UnauthorizedException,
      WORKER_ERRORS.TOKEN_INVALID,
    );
  });

  it('空间注册令牌：反查空间成功并挂载 workerSpaceId', async () => {
    prisma.workspace.findFirst.mockResolvedValue({ id: 'ws_a' });
    const ctx = mockContext({ 'x-worker-token': 'wst_abc' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(
      ctx.switchToHttp().getRequest<WorkerTokenRequest>().workerSpaceId,
    ).toBe('ws_a');
  });

  it('空间令牌操作他空间 worker → 403 WORKER_SPACE_MISMATCH', async () => {
    prisma.workspace.findFirst.mockResolvedValue({ id: 'ws_a' });
    prisma.worker.findUnique.mockResolvedValue({ workspaceId: 'ws_b' });
    await expectRejected(
      mockContext({ 'x-worker-token': 'wst_abc', 'x-worker-id': 'w_b' }),
      ForbiddenException,
      WORKER_ERRORS.WORKER_SPACE_MISMATCH,
    );
  });

  it('空间令牌操作本空间 worker → 放行', async () => {
    prisma.workspace.findFirst.mockResolvedValue({ id: 'ws_a' });
    prisma.worker.findUnique.mockResolvedValue({ workspaceId: 'ws_a' });
    await expect(
      guard.canActivate(
        mockContext({ 'x-worker-token': 'wst_abc', 'x-worker-id': 'w_a' }),
      ),
    ).resolves.toBe(true);
  });

  it('空间令牌首次注册（worker 尚不存在）→ 放行', async () => {
    prisma.workspace.findFirst.mockResolvedValue({ id: 'ws_a' });
    prisma.worker.findUnique.mockResolvedValue(null);
    await expect(
      guard.canActivate(
        mockContext({ 'x-worker-token': 'wst_new' }, {
          body: { workerId: 'w_new' },
        } as never),
      ),
    ).resolves.toBe(true);
  });

  it('空间令牌未匹配任何空间 → 401', async () => {
    await expectRejected(
      mockContext({ 'x-worker-token': 'wst_unknown' }),
      UnauthorizedException,
      WORKER_ERRORS.TOKEN_INVALID,
    );
  });
});
