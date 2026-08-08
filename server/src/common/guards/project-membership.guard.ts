import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AUTH_ERRORS } from '../../auth/auth.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { TASK_ERRORS } from '../constants/task.constants';
import { PROJECT_ID_KEY } from '../decorators/project-id.decorator';

/**
 * 项目成员校验守卫（Phase 2 权限地基）。
 *
 * 前置：全局 JwtAuthGuard 已把 JWT validate 结果挂到 `req.user`（{id, username, roleId}）。
 * 本守卫校验调用者是目标项目的成员（project_members 表存在 (projectId, userId) 记录，
 * 命中 uk_project_members_pid_uid 唯一约束），否则拒绝 403 `PERMISSION_PROJECT_NOT_MEMBER`。
 *
 * projectId 来源（三选一，按优先级）：
 *   1. 路由参数 `:pid`（如 POST /api/v1/projects/:pid/tasks）；
 *   2. `@ProjectId()` 装饰器写入的 metadata（PROJECT_ID_KEY），供无 pid 参数的路由扩展；
 *   3. 任务路由兜底：路由参数 `:id` 视为任务 id（如 GET/PATCH /api/v1/tasks/:id），
 *      先查 task.projectId 再校验成员；任务不存在抛 404 `TASK_NOT_FOUND`。
 *
 * 使用方需在模块 providers 注册本守卫（PrismaService 由全局 PrismaModule 提供）。
 */
export const PROJECT_MEMBERSHIP_ERRORS = {
  NOT_MEMBER: 'PERMISSION_PROJECT_NOT_MEMBER',
  PROJECT_ID_REQUIRED: 'PROJECT_ID_REQUIRED',
} as const;

@Injectable()
export class ProjectMembershipGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

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

    const projectId = await this.resolveProjectId(context);
    if (!projectId) {
      throw new BadRequestException({
        code: PROJECT_MEMBERSHIP_ERRORS.PROJECT_ID_REQUIRED,
        message: '缺少项目 ID（路由参数 pid）',
      });
    }

    const member = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId, userId: user.id },
      },
    });

    if (!member) {
      throw new ForbiddenException({
        code: PROJECT_MEMBERSHIP_ERRORS.NOT_MEMBER,
        message: '您不是该项目成员',
      });
    }

    return true;
  }

  /** 解析项目 ID：优先路由参数 pid，其次 @ProjectId() metadata，最后任务路由反查。 */
  private async resolveProjectId(
    context: ExecutionContext,
  ): Promise<string | undefined> {
    const request = context.switchToHttp().getRequest<Request>();
    const paramPid = request.params?.pid;
    if (typeof paramPid === 'string' && paramPid.length > 0) {
      return paramPid;
    }
    const metadataPid = this.reflector.getAllAndOverride<string>(
      PROJECT_ID_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (metadataPid) {
      return metadataPid;
    }
    // 任务路由兜底：/tasks/:id 无 pid 参数，从任务反查 projectId（09 篇 §3.4 GET/PATCH /tasks/:id）
    const taskId = request.params?.id;
    if (typeof taskId === 'string' && taskId.length > 0) {
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { projectId: true },
      });
      if (!task) {
        throw new NotFoundException({
          code: TASK_ERRORS.TASK_NOT_FOUND,
          message: '任务不存在',
        });
      }
      return task.projectId;
    }
    return undefined;
  }
}
