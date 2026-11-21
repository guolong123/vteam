/**
 * 团队可见性断言（**团队门唯一口径**）。
 *
 * 为什么抽出来：`assertTeamMember` / `assertMember` 曾在 6 处逐字复制
 * （issues.service / questions.controller / docs-site.controller / artifacts.controller
 * / stats.service / usage.service），且**口径已经漂移**：
 * - 有的查团队存在性（缺团队 404），有的不查（缺团队直接 403）；
 * - 只有 stats/usage 承认平台管理员；
 * - usage 把「查成员」和「查管理员」写成两种风格，阅读成本高。
 *
 * 统一后所有调用点共享同一套语义，新增端点不会再各自发明一套。
 *
 * 与 `TeamMembershipGuard` 的关系：守卫在**路由层**拦截（读路由参数反查 teamId），
 * 本模块供**已知 teamId 的 service/controller 内部**做二次断言（守卫覆盖不到的
 * body/query 里带的 teamId、或非 HTTP 入口如 MCP）。两者共用同一错误码与文案。
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isPlatformAdminByUserId } from '../users/admin-permission';
import { TEAM_MEMBERSHIP_ERRORS } from './guards/team-membership.guard';

/** 断言选项。 */
export interface AssertTeamAccessOptions {
  /** 团队不存在时的行为：`'not-found'` 抛 404 TEAM_NOT_FOUND；`'forbidden'` 直接 403。 */
  onMissingTeam?: 'not-found' | 'forbidden';
  /** 是否放行平台管理员（缺省 false：只认 team_user_members）。 */
  allowPlatformAdmin?: boolean;
  /** 调用者 userId；缺省 → 直接 403（未认证等价于无权限）。 */
  userId?: string | null;
}

/** 统一 403：不是该团队成员（错误码与守卫同源）。 */
function notMember(): ForbiddenException {
  return new ForbiddenException({
    code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
    message: '您不是该团队成员',
  });
}

/** 统一 404：团队不存在。 */
function teamNotFound(teamId: string): NotFoundException {
  return new NotFoundException({
    code: 'TEAM_NOT_FOUND',
    message: `团队 ${teamId} 不存在`,
  });
}

/**
 * 断言调用者是该团队的用户成员；不满足即抛 403（团队缺失时按 opts 抛 404 或 403）。
 *
 * @param prisma - Prisma 服务
 * @param teamId - 目标团队
 * @param options - 见 {@link AssertTeamAccessOptions}
 * @throws ForbiddenException | NotFoundException
 */
export async function assertTeamAccess(
  prisma: PrismaService,
  teamId: string,
  options: AssertTeamAccessOptions = {},
): Promise<void> {
  const { onMissingTeam = 'not-found', allowPlatformAdmin = false } = options;
  const userId = options.userId ?? null;

  if (onMissingTeam === 'not-found') {
    const team = await (prisma as any).team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });
    if (!team) {
      throw teamNotFound(teamId);
    }
  }

  if (userId) {
    const membership = await (prisma as any).teamUserMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });
    if (membership) {
      return;
    }
    if (allowPlatformAdmin && (await isPlatformAdminByUserId(prisma, userId))) {
      return;
    }
  }

  throw notMember();
}

/**
 * `assertTeamAccess` 的只认成员版本（不查团队存在性、不放行管理员）——
 * 覆盖历史上「缺团队也直接 403」的调用点，保持行为不变。
 */
export async function assertTeamMember(
  prisma: PrismaService,
  teamId: string,
  userId: string,
): Promise<void> {
  await assertTeamAccess(prisma, teamId, {
    userId,
    onMissingTeam: 'forbidden',
  });
}
