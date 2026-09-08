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

/**
 * 团队用户成员校验守卫（remove-project-dimension 团队门）。
 *
 * 前置全局 JwtAuthGuard 已把 JWT validate 结果挂到 `req.user`
 * （{id, username, roleId}）；本守卫校验调用者是目标团队的用户成员
 * （team_user_members 表存在 (teamId, userId) 记录，命中
 * uk_team_user_members_team_user 唯一约束），否则拒绝 403，自有错误码
 * `TEAM_MEMBERSHIP_ERRORS.NOT_MEMBER`（`PERMISSION_TEAM_NOT_MEMBER`）。
 *
 * teamId 来源（按优先级）：
 *   1. 路由参数 `:id` 先按团队 id 解释（团队存在即用）；
 *      不存在则回退为任务 id，从任务反查 teamId（任务不存在抛 404
 *      `TASK_NOT_FOUND`，任务无归属团队抛 400 `TEAM_ID_REQUIRED`）；
 *   2. 路由参数 `:taskId` 视为任务 id，从任务反查 teamId（同上）。
 *
 * 无团队参数模式（`POST /tasks` body.teamId、`GET /tasks?teamId=` 等无参路由）：
 * 无 `id`/`taskId` 参数时仅要求登录（`req.user` 存在即放行），成员过滤下沉到
 * 控制器/service 层按 query/body 的 teamId 执行。
 *
 * 使用方需在模块 providers 注册本守卫（PrismaService 由全局 PrismaModule 提供）。
 */
export const TEAM_MEMBERSHIP_ERRORS = {
  NOT_MEMBER: 'PERMISSION_TEAM_NOT_MEMBER',
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
      // 无团队参数路由（POST /tasks、GET /tasks 等）：仅要求登录，
      // 成员过滤下沉到控制器/service 层按 query/body 的 teamId 执行
      return true;
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

  /**
   * 解析团队 ID：路由参数 id 先按团队解释、不存在回退任务反查；
   * 其次路由参数 taskId 任务反查；两者皆无返回 undefined（调用方直通）。
   */
  private async resolveTeamId(
    context: ExecutionContext,
  ): Promise<string | undefined> {
    const request = context.switchToHttp().getRequest<Request>();
    const paramId = request.params?.id;
    if (typeof paramId === 'string' && paramId.length > 0) {
      const team = await (this.prisma as any).team.findUnique({
        where: { id: paramId },
        select: { id: true },
      });
      if (team) {
        return paramId;
      }
      return this.resolveTeamIdFromTask(paramId);
    }
    // 任务路由兜底：/:taskId 无团队参数时，从任务反查 teamId
    const taskId = (request.params as any)?.taskId;
    if (typeof taskId === 'string' && taskId.length > 0) {
      return this.resolveTeamIdFromTask(taskId);
    }
    return undefined;
  }

  /** 从任务反查归属团队：任务不存在 404，任务无归属团队 400。 */
  private async resolveTeamIdFromTask(taskId: string): Promise<string> {
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
    throw new BadRequestException({
      code: TEAM_MEMBERSHIP_ERRORS.TEAM_ID_REQUIRED,
      message: '任务无归属团队',
    });
  }
}
