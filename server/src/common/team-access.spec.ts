import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TEAM_MEMBERSHIP_ERRORS } from './guards/team-membership.guard';
import { assertTeamAccess, assertTeamMember } from './team-access';

/** 构造只实现 team / teamUserMember / user 三个 delegate 的 Prisma 替身。 */
function makePrisma(opts: {
  team?: { id: string } | null;
  membership?: { id: string } | null;
  adminUser?: {
    enabled: boolean;
    role?: { permissions: unknown } | null;
  } | null;
}): PrismaService {
  return {
    team: { findUnique: jest.fn().mockResolvedValue(opts.team ?? null) },
    teamUserMember: {
      findUnique: jest.fn().mockResolvedValue(opts.membership ?? null),
    },
    user: { findUnique: jest.fn().mockResolvedValue(opts.adminUser ?? null) },
  } as unknown as PrismaService;
}

describe('common/team-access（团队门唯一口径）', () => {
  describe('assertTeamAccess', () => {
    it('成员 → 放行', async () => {
      const prisma = makePrisma({
        team: { id: 't1' },
        membership: { id: 'x' },
      });
      await expect(
        assertTeamAccess(prisma, 't1', { userId: 'u1' }),
      ).resolves.toBeUndefined();
    });

    it('非成员 → 403 且错误码与守卫同源', async () => {
      const prisma = makePrisma({ team: { id: 't1' }, membership: null });
      await expect(
        assertTeamAccess(prisma, 't1', { userId: 'u1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        assertTeamAccess(prisma, 't1', { userId: 'u1' }),
      ).rejects.toMatchObject({
        response: { code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER },
      });
    });

    it('缺团队时缺省抛 404 TEAM_NOT_FOUND', async () => {
      const prisma = makePrisma({ team: null });
      await expect(
        assertTeamAccess(prisma, 't_missing', { userId: 'u1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        assertTeamAccess(prisma, 't_missing', { userId: 'u1' }),
      ).rejects.toMatchObject({ response: { code: 'TEAM_NOT_FOUND' } });
    });

    it('onMissingTeam=forbidden → 不查团队、直接 403（历史口径）', async () => {
      const prisma = makePrisma({ team: null, membership: null });
      await expect(
        assertTeamAccess(prisma, 't1', {
          userId: 'u1',
          onMissingTeam: 'forbidden',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.team.findUnique).not.toHaveBeenCalled();
    });

    it('无 userId → 直接 403（不查库）', async () => {
      const prisma = makePrisma({ team: { id: 't1' } });
      await expect(
        assertTeamAccess(prisma, 't1', { userId: null }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.teamUserMember.findUnique).not.toHaveBeenCalled();
    });

    it('allowPlatformAdmin=true 时管理员放行（非成员也行）', async () => {
      const prisma = makePrisma({
        team: { id: 't1' },
        membership: null,
        adminUser: { enabled: true, role: { permissions: { all: true } } },
      });
      await expect(
        assertTeamAccess(prisma, 't1', {
          userId: 'u_admin',
          allowPlatformAdmin: true,
        }),
      ).resolves.toBeUndefined();
    });

    it('allowPlatformAdmin 缺省 false → 管理员也需是成员', async () => {
      const prisma = makePrisma({
        team: { id: 't1' },
        membership: null,
        adminUser: { enabled: true, role: { permissions: { all: true } } },
      });
      await expect(
        assertTeamAccess(prisma, 't1', { userId: 'u_admin' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assertTeamMember（只认成员）', () => {
    it('成员 → 放行', async () => {
      const prisma = makePrisma({
        team: { id: 't1' },
        membership: { id: 'x' },
      });
      await expect(
        assertTeamMember(prisma, 't1', 'u1'),
      ).resolves.toBeUndefined();
    });

    it('非成员 → 403', async () => {
      const prisma = makePrisma({ team: { id: 't1' }, membership: null });
      await expect(assertTeamMember(prisma, 't1', 'u1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});
