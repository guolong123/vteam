import { ForbiddenException } from '@nestjs/common';
import {
  TEAM_MEMBERSHIP_ERRORS,
  TeamMembershipGuard,
} from './team-membership.guard';

/** TeamMembershipGuard：团队优先解释 :id、无参直通、任务反查回退。 */
describe('TeamMembershipGuard', () => {
  const prisma = {
    team: { findUnique: jest.fn() },
    task: { findUnique: jest.fn() },
    teamUserMember: { findUnique: jest.fn() },
  };
  const guard = new TeamMembershipGuard(prisma as never);
  const ctxOf = (user: unknown, params: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, params }) }),
    }) as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('成员（:id 为团队 id）直接放行', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm_1' });
    prisma.teamUserMember.findUnique.mockResolvedValue({
      teamId: 'tm_1',
      userId: 'u_1',
    });

    await expect(
      guard.canActivate(ctxOf({ id: 'u_1' }, { id: 'tm_1' })),
    ).resolves.toBe(true);
    expect(prisma.team.findUnique).toHaveBeenCalledWith({
      where: { id: 'tm_1' },
      select: { id: true },
    });
    expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 'tm_1', userId: 'u_1' } },
    });
    expect(prisma.task.findUnique).not.toHaveBeenCalled();
  });

  it('非成员抛 403 PERMISSION_TEAM_NOT_MEMBER', async () => {
    prisma.team.findUnique.mockResolvedValue({ id: 'tm_1' });
    prisma.teamUserMember.findUnique.mockResolvedValue(null);

    const err = await guard
      .canActivate(ctxOf({ id: 'u_out' }, { id: 'tm_1' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({
      code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
      message: '您不是该团队成员',
    });
  });

  it('无 id/taskId 参数仅要求登录（auth-only，不查任何表）', async () => {
    await expect(guard.canActivate(ctxOf({ id: 'u_1' }, {}))).resolves.toBe(
      true,
    );
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
    expect(prisma.task.findUnique).not.toHaveBeenCalled();
    expect(prisma.teamUserMember.findUnique).not.toHaveBeenCalled();
  });

  it(':id 为任务 id 时经任务反查 teamId 再验成员', async () => {
    prisma.team.findUnique.mockResolvedValue(null);
    prisma.task.findUnique.mockResolvedValue({
      teamId: 'tm_9',
    });
    prisma.teamUserMember.findUnique.mockResolvedValue({
      teamId: 'tm_9',
      userId: 'u_1',
    });

    await expect(
      guard.canActivate(ctxOf({ id: 'u_1' }, { id: 't_7' })),
    ).resolves.toBe(true);
    expect(prisma.task.findUnique).toHaveBeenCalledWith({
      where: { id: 't_7' },
      select: { teamId: true },
    });
    expect(prisma.teamUserMember.findUnique).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: 'tm_9', userId: 'u_1' } },
    });
  });
});
