import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AUTH_ERRORS } from '../auth.constants';

describe('JwtAuthGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  } as unknown as Reflector;

  const buildContext = (isPublic: boolean) => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(isPublic);
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
        getResponse: () => ({}),
      }),
    } as any;
  };

  it('canActivate：@Public() 端点放行，不校验 token', () => {
    const guard = new JwtAuthGuard(reflector);
    expect(guard.canActivate(buildContext(true))).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      IS_PUBLIC_KEY,
      expect.any(Array),
    );
  });

  describe('handleRequest', () => {
    it('user 为空（无 token / 无效 token）应抛 401 AUTH_UNAUTHORIZED', () => {
      const guard = new JwtAuthGuard(reflector);
      try {
        guard.handleRequest(null, null, 'No auth token');
        fail('应当抛出 UnauthorizedException');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).getResponse()).toMatchObject({
          code: AUTH_ERRORS.UNAUTHORIZED,
        });
      }
    });

    it('user 存在（合法 token）应原样返回', () => {
      const guard = new JwtAuthGuard(reflector);
      const user = { id: 'u_1', username: 'alice', roleId: 'r_member' };
      expect(guard.handleRequest(null, user, null)).toBe(user);
    });
  });
});
