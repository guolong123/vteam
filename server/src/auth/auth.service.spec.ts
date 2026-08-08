import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AUTH_ERRORS, BUILTIN_ROLES } from './auth.constants';
import { AuthService } from './auth.service';

const createMockPrisma = () => {
  const users: any[] = [];
  const roles = [
    { id: 'r_admin', name: 'admin' },
    { id: 'r_member', name: 'member' },
  ];
  // 为返回的用户附加 role 关系（对齐 service 的 include: { role: true }）
  const enrich = (u: any) =>
    u ? { ...u, role: roles.find((r) => r.id === u.roleId) } : u;
  return {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.username !== undefined) {
          return enrich(
            users.find((u) => u.username === where.username) ?? null,
          );
        }
        if (where.email !== undefined) {
          return enrich(
            users.find(
              (u) => u.email !== undefined && u.email === where.email,
            ) ?? null,
          );
        }
        if (where.id !== undefined) {
          return enrich(users.find((u) => u.id === where.id) ?? null);
        }
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const user = { ...data, id: data.id ?? 'u_new' };
        users.push(user);
        return user;
      }),
    },
    role: {
      findUnique: jest.fn(async ({ where }: any) => {
        return roles.find((r) => r.name === where.name) ?? null;
      }),
    },
    _store: users,
  };
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let jwt: JwtService;

  const config = {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        JWT_SECRET: 'test-secret',
        JWT_ACCESS_EXPIRES_IN: '1h',
        JWT_REFRESH_EXPIRES_IN: '7d',
      };
      return map[key];
    }),
  } as unknown as ConfigService;

  beforeEach(() => {
    prisma = createMockPrisma();
    jwt = {
      signAsync: jest.fn(
        async (payload: any) => `signed.${payload.type}.${payload.sub}`,
      ),
      verifyAsync: jest.fn(async (_token: string, _opts?: any) => ({
        sub: 'u_admin',
        username: 'admin',
        roleId: 'r_admin',
        type: 'refresh',
      })),
    } as unknown as JwtService;
    service = new AuthService(prisma as unknown as PrismaService, jwt, config);
  });

  describe('register', () => {
    it('应使用 bcrypt 哈希密码后落库，且返回不含哈希的摘要', async () => {
      const result = await service.register({
        username: 'alice',
        password: 'secret123',
        displayName: 'Alice',
      });
      expect(result).toEqual({
        id: expect.any(String),
        username: 'alice',
        displayName: 'Alice',
      });
      // 落库的 passwordHash 是 bcrypt 哈希，非明文
      const stored = prisma._store.find((u) => u.username === 'alice');
      expect(stored.passwordHash).not.toBe('secret123');
      expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(await bcrypt.compare('secret123', stored.passwordHash)).toBe(true);
      // 默认角色 member
      expect(stored.roleId).toBe('r_member');
    });

    it('重复用户名应抛 409 USERNAME_CONFLICT', async () => {
      await service.register({
        username: 'bob',
        password: 'secret123',
        displayName: 'Bob',
      });
      await expect(
        service.register({
          username: 'bob',
          password: 'secret123',
          displayName: 'Bob2',
        }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.register({
          username: 'bob',
          password: 'secret123',
          displayName: 'Bob2',
        }),
      ).rejects.toMatchObject({
        response: { code: AUTH_ERRORS.USERNAME_CONFLICT },
      });
    });

    it('重复邮箱应抛 409 EMAIL_CONFLICT', async () => {
      await service.register({
        username: 'carol',
        password: 'secret123',
        displayName: 'Carol',
        email: 'carol@x.com',
      });
      await expect(
        service.register({
          username: 'carol2',
          password: 'secret123',
          displayName: 'Carol2',
          email: 'carol@x.com',
        }),
      ).rejects.toMatchObject({
        response: { code: AUTH_ERRORS.EMAIL_CONFLICT },
      });
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      await service.register({
        username: 'admin',
        password: 'admin123',
        displayName: 'Admin',
      });
    });

    it('正确凭证应返回 accessToken/refreshToken 与 user 摘要', async () => {
      const result = await service.login({
        username: 'admin',
        password: 'admin123',
      });
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.user.username).toBe('admin');
      expect(result.user.roleName).toBe(BUILTIN_ROLES.MEMBER);
      // user 摘要不含 password_hash
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('错误密码应抛 401 AUTH_INVALID_CREDENTIALS', async () => {
      await expect(
        service.login({ username: 'admin', password: 'wrong-pass' }),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.login({ username: 'admin', password: 'wrong-pass' }),
      ).rejects.toMatchObject({
        response: { code: AUTH_ERRORS.INVALID_CREDENTIALS },
      });
    });

    it('不存在的用户应抛 401', async () => {
      await expect(
        service.login({ username: 'nobody', password: 'x123456' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('profile', () => {
    beforeEach(async () => {
      await service.register({
        username: 'dave',
        password: 'secret123',
        displayName: 'Dave',
      });
    });

    it('应返回当前用户资料（不含 password_hash）', async () => {
      const user = prisma._store.find((u) => u.username === 'dave');
      const profile = await service.profile(user.id);
      expect(profile.username).toBe('dave');
      expect(profile.displayName).toBe('Dave');
      expect(profile).not.toHaveProperty('passwordHash');
    });
  });

  describe('refresh', () => {
    it('有效 refresh token 应签发新 token 对', async () => {
      await service.register({
        username: 'refresh-user',
        password: 'secret123',
        displayName: 'Refresh',
      });
      const stored = prisma._store.find((u) => u.username === 'refresh-user');
      (jwt.verifyAsync as jest.Mock).mockResolvedValueOnce({
        sub: stored.id,
        username: 'refresh-user',
        roleId: stored.roleId,
        type: 'refresh',
      });
      const result = await service.refresh({
        refreshToken: 'some-refresh-token',
      });
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
    });

    it('无效 refresh token 应抛 401 AUTH_REFRESH_INVALID', async () => {
      (jwt.verifyAsync as jest.Mock).mockRejectedValueOnce(
        new Error('jwt expired'),
      );
      await expect(
        service.refresh({ refreshToken: 'bad-token' }),
      ).rejects.toMatchObject({
        response: { code: AUTH_ERRORS.REFRESH_INVALID },
      });
    });
  });
});
