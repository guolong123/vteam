import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AUTH_ERRORS } from '../../auth/auth.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { PROJECT_MEMBERSHIP_ERRORS } from './project-membership.guard';

/**
 * 团队用户成员校验守卫（team-free-chat Todo 2）。
 *
 * 结构镜像 `ProjectMembershipGuard`：前置全局 JwtAuthGuard 已把 JWT validate
 * 结果挂到 `req.user`（{id, username, roleId}）；本守卫校验调用者是目标团队的
 * 用户成员（team_user_members 表存在 (teamId, userId) 记录，命中
 * uk_team_user_members_team_user 唯一约束），否则拒绝 403，错误码复用
 * `PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER`（`PERMISSION_PROJECT_NOT_MEMBER`）
 * 语义——调用方无需区分项目/团队成员拒绝。
 *
 * teamId 来源（按优先级）：
 *   1. 路由参数 `:id`（如 POST /api/v1/teams/:id/users）；
 *   2. 任务路由兜底：路由参数 `:taskId` 视为任务 id，从任务反查 teamId；
 *      任务不存在抛 404 `TASK_NOT_FOUND`，任务无归属团队抛 400 `TEAM_ID_REQUIRED`。
 *
 * 使用方需在模块 providers 注册本守卫（PrismaService 由全局 PrismaModule 提供）。
 */
export const TEAM_MEMBERSHIP_ERRORS = {
  NOT_MEMBER: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
  TEAM_ID_REQUIRED: 'TEAM_ID_REQUIRED',
} as const;

@Injectable()
export class TeamMembershipGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { id: string } }>();

    // 全局 JwtAuthGuard 理论上已挂载 req.user；此处防御无 token 直达的场景
    const user = request.user;
    if (!user?.id) {
      throw new UnauthorizedException({
        code: AUTH_ERRORS.UNAUTHORIZED,
        message: '未认证或 token 无效/已过期',
      });
    }

    const teamId = await this.resolveTeamId(context);
    if (!teamId) {
      throw new BadRequestException({
        code: TEAM_MEMBERSHIP_ERRORS.TEAM_ID_REQUIRED,
        message: '缺少团队 ID（路由参数 id）',
      });
    }

    const member = await (this.prisma as any).teamUserMember.findUnique({
      where: {
        teamId_userId: { teamId, userId: user.id },
      },
    });

    if (!member) {
      throw new ForbiddenException({
        code: TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该团队成员',
      });
    }

    return true;
  }

  /** 解析团队 ID：优先路由参数 id，最后任务路由反查。 */
  private async resolveTeamId(
    context: ExecutionContext,
  ): Promise<string | undefined> {
    const request = context.switchToHttp().getRequest<Request>();
    const paramId = request.params?.id;
    if (typeof paramId === 'string' && paramId.length > 0) {
      return paramId;
    }
    // 任务路由兜底：/:taskId 无团队参数时，从任务反查 teamId
    const taskId = (request.params as any)?.taskId;
    if (typeof taskId === 'string' && taskId.length > 0) {
      const task = await (this.prisma as any).task.findUnique({
        where: { id: taskId },
        select: { teamId: true },
      });
      if (!task) {
        throw new NotFoundException({
          code: 'TASK_NOT_FOUND',
          message: '任务不存在',
        });
      }
      if (typeof task.teamId === 'string' && task.teamId.length > 0) {
        return task.teamId;
      }
    }
    return undefined;
  }
}
