import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import type { TenantContext } from '../tenant/tenant-context';
import { WORKSPACE_ROLE } from '../../workspaces/workspaces.constants';

/**
 * 平台级资源域：即使调用者是空间管理员也不放行（账号、角色、平台统计）。
 * 其余资源域（tasks/chats/artifacts/agents/workers/skills/teams/channels）
 * 由空间管理员在本空间内管理。
 */
const PLATFORM_ONLY_PERMISSION_RESOURCES = new Set([
  'users',
  'roles',
  'stats',
  // platform.* 权限点（迁移/跨空间只读）只归平台管理员，空间管理员不享受兜底
  'platform',
]);

/**
 * 通用权限点守卫（Phase 3 T8 权限矩阵落地，修复 ISSUE-006）。
 *
 * 前置：全局 JwtAuthGuard 已解析 access token 并填充 request.user =
 * `{ id, username, roleId, tokenType }`（见 auth/jwt.strategy.ts validate）。
 * 端点需同时挂 `@RequirePermission('resource.action')` 标记所需权限点：
 *
 * ```ts
 * @UseGuards(PermissionGuard)
 * @RequirePermission('agents.create')
 * @Post()
 * create(@CurrentUser() user, @Body() dto) { ... }
 * ```
 *
 * 校验链路：
 *   0. request.workerToken 已设置（前置 WorkerOrJwtGuard 校验过 X-Worker-Token）→
 *      放行——D1 架构决策：worker token 与用户 JWT 隔离，skills 等 GET 端点
 *      供 worker 注入拉取（T4b），无用户上下文不做权限点判定；
 *   1. request.user.id → 查 users 表（含 role）；
 *   2. 用户不存在或已禁用 → 401；
 *   3. 读取 role.permissions JSON 判定（两种兼容格式，见 roles.constants.ts）：
 *      - `permissions.all === true`（seed 预置 admin 简写）→ 放行；
 *      - `permissions.all === false`（旧版 member 简写/未配置矩阵的自定义角色）→
 *        按「成员只读」放行 view 类权限、拒绝写操作（create/edit/delete/manage）；
 *      - 完整矩阵格式 `{ [resource]: { [action]: boolean } }` →
 *        校验 `permissions[resource][action] === true`（缺省视为 false）。
 *        seed 预置 member 已迁移为完整矩阵（09 §2.3 默认权限点，见 prisma/seed.ts）。
 *   4. 不满足 → 403 FORBIDDEN_PERMISSION（携带缺失权限点）。
 *
 * 使用方需在模块 providers 注册本守卫（PrismaService 由全局 PrismaModule 提供）。
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<string>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    // 防御：未挂 @RequirePermission 的端点不拦截（保持既有行为）
    if (!permission) {
      return true;
    }
    const [resource, action] = permission.split('.');

    const request = context.switchToHttp().getRequest<Request>();

    // worker 通道放行：前置 WorkerOrJwtGuard 已验证 X-Worker-Token 并挂
    // request.workerToken（skills/tools 等 GET 端点双通道：worker 注入拉取 or 用户 JWT）。
    // D1：worker token 与用户 JWT 完全隔离，worker 请求无用户上下文，跳过权限点判定。
    const workerToken = (request as Request & { workerToken?: string })
      .workerToken;
    if (workerToken) {
      return true;
    }

    const authUser = request.user as
      { id?: string; username?: string } | undefined;

    if (!authUser?.id) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '未认证或 token 无效',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: authUser.id },
      include: { role: true },
    });
    if (!user || !user.enabled) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: '账号不存在或已禁用',
      });
    }

    const permissions = (user.role.permissions ?? {}) as Record<
      string,
      unknown
    >;

    // seed admin 简写 `{ all: true }`：全权限放行
    if (permissions.all === true) {
      return true;
    }

    // 完整矩阵格式：permissions[resource][action] === true → 放行
    const resourcePerm = permissions[resource] as
      Record<string, boolean> | undefined;
    if (resourcePerm?.[action] === true) {
      return true;
    }

    // 空间管理员兜底（M4 角色分层）：当前空间的 owner/admin 可在**本空间内**
    // 操作空间级资源（Agent/团队/技能/模型/Worker/MCP/仓库/记忆等）；
    // 账号/角色/平台统计等平台级资源仍只归平台管理员。
    if (
      !PLATFORM_ONLY_PERMISSION_RESOURCES.has(resource) &&
      (await this.isWorkspaceManager(request, authUser.id))
    ) {
      return true;
    }

    // seed member 简写 `{ all: false }`（未配置矩阵）：
    // 对齐 09 篇「成员只读可见」语义——view 类放行，写操作（create/edit/delete/manage）拒绝。
    if (permissions.all === false && action === 'view') {
      return true;
    }

    throw new ForbiddenException({
      code: 'FORBIDDEN_PERMISSION',
      message: `缺少 ${permission} 权限`,
    });
  }

  /**
   * 当前空间 owner/admin 判定（WorkspaceGuard 已把解析结果写入请求级 tenant）。
   * 无租户上下文（如 worker 通道）或系统空间 → false（系统空间只归平台管理员）。
   */
  private async isWorkspaceManager(
    request: Request & { tenant?: TenantContext },
    userId: string,
  ): Promise<boolean> {
    const workspaceId = request.tenant?.workspaceId;
    if (!workspaceId || workspaceId === 'ws_system') return false;
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return (
      member?.role === WORKSPACE_ROLE.OWNER ||
      member?.role === WORKSPACE_ROLE.ADMIN
    );
  }
}
