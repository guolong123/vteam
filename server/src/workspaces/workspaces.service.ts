import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdGeneratorService } from '../common/id-generator';
import {
  TENANT_WORKSPACE_ID,
  WORKSPACE_STATUS,
} from '../common/tenant/tenant.constants';
import { runWithTenant } from '../common/tenant/tenant-context';
import type { TenantContext } from '../common/tenant/tenant-context';
import { isPlatformAdminByUserId } from '../users/admin-permission';
import { resyncIdPrefix } from '../common/id-resync';
import { createHash, randomBytes } from 'crypto';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { WORKER_COMMAND_TYPES } from '../workers/workers.service';
import { WorkersService } from '../workers/workers.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  RELOCATABLE_RESOURCES,
  RELOCATABLE_RESOURCE_TYPES,
  WORKSPACE_ERRORS,
  WORKSPACE_MANAGER_ROLES,
  WORKSPACE_RELOCATION_ID_PREFIX,
  WORKSPACE_ROLE,
  type RelocatableResourceType,
  type WorkspaceRole,
  type WorkspaceSummary,
} from './workspaces.constants';
import type { RelocateResourceDto } from './dto/relocate-resource.dto';

/** 空间列表项（Prisma 查询结果的最小形状）。 */
export interface WorkspaceRow {
  id: string;
  name: string;
  isSystem: boolean;
  status: string;
  ownerUserId: string | null;
  createdAt: Date;
}

interface WorkspaceMemberRow {
  role: string;
  workspace: WorkspaceRow;
}

export interface ResolvedWorkspace {
  workspaceId: string;
  /** 平台管理员跨空间只读时为 true（写操作由租户中间件拒绝）。 */
  readOnly: boolean;
  isPlatformAdmin: boolean;
}

/**
 * 工作空间服务：空间解析（请求上下文）、成员关系、空间 CRUD。
 *
 * 「当前空间」来源优先级（WorkspaceGuard 使用）：
 * 1. 平台管理员显式请求头 `x-workspace-id`（跨空间只读，或系统空间维护）；
 * 2. JWT 的 `wid`（登录/切换空间时签入）；
 * 3. 用户 `lastWorkspaceId`；
 * 4. 用户最早加入的成员空间；
 * 5. 以上皆无 → 自动创建个人空间（自愈，避免老账号无空间可用）。
 */
@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idGen: IdGeneratorService,
    // 迁移后副作用重放（worker reload / 凭据回放）；单测轻量装配时可缺省。
    @Optional()
    @Inject(forwardRef(() => WorkersService))
    private readonly workers?: WorkersService,
    @Optional()
    @Inject(forwardRef(() => RealtimeService))
    private readonly realtime?: RealtimeService,
  ) {}

  /** 启动期对齐 `ws_` / `wsr_` 序号（固定引导 id 非数字尾段，自动跳过）。 */
  async onModuleInit(): Promise<void> {
    await resyncIdPrefix(this.prisma.workspace, 'ws', this.idGen);
    await resyncIdPrefix(
      this.prisma.workspaceRelocation,
      WORKSPACE_RELOCATION_ID_PREFIX,
      this.idGen,
    );
  }

  /** 系统空间 id（迁移/seed 固定引导 id，缺失时抛错提示）。 */
  async getSystemWorkspaceId(): Promise<string> {
    const sys = await this.prisma.workspace.findUnique({
      where: { id: TENANT_WORKSPACE_ID.SYSTEM },
      select: { id: true, isSystem: true },
    });
    if (!sys || !sys.isSystem) {
      throw new NotFoundException({
        code: WORKSPACE_ERRORS.NOT_FOUND,
        message: '系统空间未初始化，请先执行迁移/seed',
      });
    }
    return sys.id;
  }

  /** 我的空间列表（含隐式可读的系统空间，排在最前）。 */
  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const memberships: WorkspaceMemberRow[] =
      (await this.prisma.workspaceMember.findMany({
        where: { userId },
        select: {
          role: true,
          workspace: {
            select: {
              id: true,
              name: true,
              isSystem: true,
              status: true,
              ownerUserId: true,
              createdAt: true,
            },
          },
        },
      })) as unknown as WorkspaceMemberRow[];

    const mine = memberships
      .filter((m) => m.workspace.status === WORKSPACE_STATUS.ACTIVE)
      .map((m) => this.toSummary(m.workspace, m.role));

    const system = await this.prisma.workspace.findFirst({
      where: { isSystem: true, status: WORKSPACE_STATUS.ACTIVE },
      select: {
        id: true,
        name: true,
        isSystem: true,
        status: true,
        ownerUserId: true,
        createdAt: true,
      },
    });
    const withSystem = system
      ? [this.toSummary(system as WorkspaceRow, WORKSPACE_ROLE.MEMBER), ...mine]
      : mine;

    // 去重（管理员可能显式拥有系统空间成员行）+ 系统空间置顶
    const seen = new Set<string>();
    return withSystem
      .filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)))
      .sort((a, b) => Number(b.isSystem) - Number(a.isSystem));
  }

  /** 是否可访问空间：成员关系，或系统空间（全员隐式）。 */
  async canAccess(userId: string, workspaceId: string): Promise<boolean> {
    if (workspaceId === TENANT_WORKSPACE_ID.SYSTEM) {
      return true;
    }
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    return !!member;
  }

  /**
   * 只读场景可访问性：成员可访问，或平台管理员（跨空间只读）。
   * 写操作仍走 assertAccessible / assertManager（管理员不能借只读旁路写入）。
   */
  async assertAccessibleOrAdminRead(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    if (workspaceId === TENANT_WORKSPACE_ID.SYSTEM) return;
    await this.assertWorkspaceExists(workspaceId);
    if (await isPlatformAdminByUserId(this.prisma, userId)) return;
    await this.assertAccessible(userId, workspaceId);
  }

  /** 断言可访问；不可访问抛 403（管理员跨空间读由调用方单独放行）。 */
  async assertAccessible(userId: string, workspaceId: string): Promise<void> {
    if (!(await this.canAccess(userId, workspaceId))) {
      throw new ForbiddenException({
        code: WORKSPACE_ERRORS.FORBIDDEN,
        message: '您不是该工作空间成员',
      });
    }
  }

  /**
   * 解析一次请求的租户上下文（WorkspaceGuard 调用）。
   *
   * @param user JWT 解析出的用户（含 wid）
   * @param headerWorkspaceId 请求头 x-workspace-id（仅平台管理员可用；成员也可用于切到自有空间）
   */
  async resolveRequestWorkspace(
    user: { id: string; workspaceId?: string },
    headerWorkspaceId?: string,
  ): Promise<ResolvedWorkspace> {
    const isPlatformAdmin = await isPlatformAdminByUserId(this.prisma, user.id);

    const header = headerWorkspaceId?.trim() || undefined;
    if (header) {
      await this.assertWorkspaceExists(header);
      if (isPlatformAdmin) {
        // 管理员：可看任意空间（跨空间只读）；系统空间可写（维护平台资源）。
        const isOwn = await this.canAccess(user.id, header);
        return {
          workspaceId: header,
          readOnly:
            !isOwn && header !== TENANT_WORKSPACE_ID.SYSTEM ? true : false,
          isPlatformAdmin,
        };
      }
      // 普通用户：请求头只能用于切换到自己可访问的空间，否则拒绝（防伪造）。
      if (!(await this.canAccess(user.id, header))) {
        throw new ForbiddenException({
          code: WORKSPACE_ERRORS.FORBIDDEN,
          message: '无权访问该工作空间',
        });
      }
      return { workspaceId: header, readOnly: false, isPlatformAdmin };
    }

    // JWT 中的当前空间
    if (user.workspaceId) {
      if (user.workspaceId === TENANT_WORKSPACE_ID.SYSTEM) {
        return {
          workspaceId: user.workspaceId,
          readOnly: false,
          isPlatformAdmin,
        };
      }
      if (await this.canAccess(user.id, user.workspaceId)) {
        return {
          workspaceId: user.workspaceId,
          readOnly: false,
          isPlatformAdmin,
        };
      }
    }

    // 回退：lastWorkspaceId → 最早成员空间 → 自动建个人空间
    const workspaceId = await this.resolveOrCreateDefault(user.id);
    return { workspaceId, readOnly: false, isPlatformAdmin };
  }

  /** 解析用户默认空间（登录时也用）：last → 最早成员 → 自动创建个人空间。 */
  async resolveOrCreateDefault(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, lastWorkspaceId: true },
    });
    if (!user) {
      throw new NotFoundException({
        code: WORKSPACE_ERRORS.USER_NOT_FOUND,
        message: '用户不存在',
      });
    }
    const last = user.lastWorkspaceId;
    if (last && (await this.canAccess(user.id, last))) {
      return last;
    }
    const first = await this.prisma.workspaceMember.findFirst({
      where: { userId, workspace: { status: WORKSPACE_STATUS.ACTIVE } },
      orderBy: { joinedAt: 'asc' },
      select: { workspaceId: true },
    });
    if (first) {
      return first.workspaceId;
    }
    const created = await this.createForUser(
      user.id,
      `${user.displayName || user.id} 的空间`,
    );
    return created.id;
  }

  /** 创建空间（调用者为 owner），并设为该用户当前空间。 */
  async createForUser(
    userId: string,
    name: string,
    // 测试/seed 允许显式 id
    explicitId?: string,
  ): Promise<WorkspaceRow> {
    const trimmed = name?.trim();
    if (!trimmed) {
      throw new BadRequestException({
        code: WORKSPACE_ERRORS.NAME_CONFLICT,
        message: '空间名称不能为空',
      });
    }
    const existing = await this.prisma.workspace.findFirst({
      where: { ownerUserId: userId, name: trimmed },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: WORKSPACE_ERRORS.NAME_CONFLICT,
        message: `空间名称 ${trimmed} 已存在`,
      });
    }
    const id = explicitId ?? (await this.idGen.nextId('ws'));
    const created = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          id,
          name: trimmed,
          isSystem: false,
          status: WORKSPACE_STATUS.ACTIVE,
          ownerUserId: userId,
        },
        select: {
          id: true,
          name: true,
          isSystem: true,
          status: true,
          ownerUserId: true,
          createdAt: true,
        },
      });
      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId,
          role: WORKSPACE_ROLE.OWNER,
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { lastWorkspaceId: workspace.id },
      });
      return workspace;
    });
    return created as unknown as WorkspaceRow;
  }

  /** 切换当前空间：校验可访问后写 lastWorkspaceId。 */
  async switchTo(userId: string, workspaceId: string): Promise<void> {
    await this.assertWorkspaceExists(workspaceId);
    await this.assertAccessible(userId, workspaceId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastWorkspaceId: workspaceId },
    });
  }

  /**
   * 全部空间列表（平台管理员）：用于跨空间只读查看/运维排查。
   * 返回每个空间的成员数，便于管理员判断这是谁的空间。
   */
  async listAll(): Promise<
    Array<{
      id: string;
      name: string;
      isSystem: boolean;
      status: string;
      ownerUserId: string | null;
      createdAt: Date;
      memberCount: number;
    }>
  > {
    const rows = await this.prisma.workspace.findMany({
      where: { status: WORKSPACE_STATUS.ACTIVE },
      select: {
        id: true,
        name: true,
        isSystem: true,
        status: true,
        ownerUserId: true,
        createdAt: true,
        _count: { select: { members: true } },
      },
      orderBy: [{ isSystem: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      isSystem: row.isSystem,
      status: row.status,
      ownerUserId: row.ownerUserId,
      createdAt: row.createdAt,
      memberCount: row._count.members,
    }));
  }

  /** 空间成员列表（需可访问；平台管理员可跨空间只读查看）。 */
  async listMembers(userId: string, workspaceId: string) {
    await this.assertAccessibleOrAdminRead(userId, workspaceId);
    const rows = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { joinedAt: 'asc' },
      select: {
        userId: true,
        role: true,
        joinedAt: true,
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            enabled: true,
          },
        },
      },
    });
    return rows;
  }

  /** 邀请成员（owner/admin；需目标用户存在且未加入）。 */
  async addMember(
    actorId: string,
    workspaceId: string,
    targetUserId: string,
    role: string = WORKSPACE_ROLE.MEMBER,
  ) {
    await this.assertManager(actorId, workspaceId);
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!target) {
      throw new NotFoundException({
        code: WORKSPACE_ERRORS.USER_NOT_FOUND,
        message: '目标用户不存在',
      });
    }
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      select: { userId: true },
    });
    if (existing) {
      throw new ConflictException({
        code: WORKSPACE_ERRORS.MEMBER_EXISTS,
        message: '该用户已是空间成员',
      });
    }
    const created = await this.prisma.workspaceMember.create({
      data: { workspaceId, userId: targetUserId, role },
      select: { userId: true, role: true, joinedAt: true },
    });
    return created;
  }

  /** 移除成员（owner/admin；owner 受保护）。 */
  async removeMember(
    actorId: string,
    workspaceId: string,
    targetUserId: string,
  ) {
    await this.assertManager(actorId, workspaceId);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerUserId: true, isSystem: true },
    });
    if (!workspace) {
      throw new NotFoundException({
        code: WORKSPACE_ERRORS.NOT_FOUND,
        message: '空间不存在',
      });
    }
    if (workspace.isSystem) {
      throw new ForbiddenException({
        code: WORKSPACE_ERRORS.SYSTEM_IMMUTABLE,
        message: '系统空间成员关系不可修改',
      });
    }
    if (workspace.ownerUserId === targetUserId) {
      throw new ForbiddenException({
        code: WORKSPACE_ERRORS.OWNER_PROTECTED,
        message: '不能移除空间 owner',
      });
    }
    await this.prisma.workspaceMember.deleteMany({
      where: { workspaceId, userId: targetUserId },
    });
    return { removed: true, userId: targetUserId };
  }

  /** 断言调用者是空间 owner/admin（系统空间仅平台管理员可管理）。 */
  async assertManager(userId: string, workspaceId: string): Promise<string> {
    if (workspaceId === TENANT_WORKSPACE_ID.SYSTEM) {
      if (await isPlatformAdminByUserId(this.prisma, userId)) {
        return WORKSPACE_ROLE.ADMIN;
      }
      throw new ForbiddenException({
        code: WORKSPACE_ERRORS.ROLE_INSUFFICIENT,
        message: '系统空间仅平台管理员可管理',
      });
    }
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member || !WORKSPACE_MANAGER_ROLES.includes(member.role)) {
      throw new ForbiddenException({
        code: WORKSPACE_ERRORS.ROLE_INSUFFICIENT,
        message: '需要空间 owner/admin 权限',
      });
    }
    return member.role;
  }

  /** 空间是否存在且未归档。 */
  async assertWorkspaceExists(workspaceId: string): Promise<void> {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { status: true },
    });
    if (!ws || ws.status !== WORKSPACE_STATUS.ACTIVE) {
      throw new NotFoundException({
        code: WORKSPACE_ERRORS.NOT_FOUND,
        message: '工作空间不存在或已归档',
      });
    }
  }

  /**
   * 构造请求租户上下文（guard 用）。
   * 说明：`mode` 固定 request；跨空间只读由 readOnly 表达（中间件拒绝写）。
   */
  async buildTenantContext(
    user: { id: string; workspaceId?: string },
    headerWorkspaceId?: string,
  ): Promise<TenantContext & ResolvedWorkspace> {
    const resolved = await this.resolveRequestWorkspace(
      user,
      headerWorkspaceId,
    );
    return {
      ...resolved,
      userId: user.id,
      mode: 'request',
    };
  }

  /**
   * 资源空间迁移（管理员）：在空间之间移动「配置/能力类」资源。
   * - 目标为 `ws_system` = 发布为平台共享（所有空间可读、可共享类型可用）；
   * - 从 `ws_system` 移出 = 回收共享，必须先确认无其它空间引用；
   * - 目标空间内唯一键冲突 → 409（不自动改名）；
   * - 全程在 system 模式下执行（不做空间自动过滤，显式校验 from/target），并写审计行。
   *
   * ⚠️ 仅平台管理员可调用（controller 挂 AdminGuard）；普通用户空间 owner 的迁移能力留待后续。
   */
  async relocate(actorUserId: string, dto: RelocateResourceDto) {
    const result = await this.relocateTx(actorUserId, dto);
    if (result.moved) {
      // 迁移成功后的副作用重放（best-effort，不改变迁移结果）：
      // 让两端的 worker 重新拉取资源清单/凭据，避免共享 worker 仍持有旧空间配置。
      await this.replayRelocationSideEffects(
        actorUserId,
        dto,
        result.fromWorkspaceId,
        result.toWorkspaceId,
      );
    }
    return result;
  }

  /** 迁移事务主体（拆出便于在事务成功后统一做副作用重放）。 */
  private async relocateTx(actorUserId: string, dto: RelocateResourceDto) {
    const def =
      RELOCATABLE_RESOURCES[dto.resourceType as RelocatableResourceType];
    if (!def) {
      throw new BadRequestException({
        code: WORKSPACE_ERRORS.RELOCATE_UNSUPPORTED,
        message: `不支持迁移的资源类型：${dto.resourceType}（仅允许 ${RELOCATABLE_RESOURCE_TYPES.join(', ')}）`,
      });
    }
    return runWithTenant(
      { workspaceId: TENANT_WORKSPACE_ID.SYSTEM, mode: 'system' },
      async () => {
        const target = await this.prisma.workspace.findUnique({
          where: { id: dto.targetWorkspaceId },
          select: { id: true, status: true },
        });
        if (!target || target.status !== WORKSPACE_STATUS.ACTIVE) {
          throw new NotFoundException({
            code: WORKSPACE_ERRORS.RELOCATE_TARGET_NOT_FOUND,
            message: '目标工作空间不存在或已归档',
          });
        }
        const delegate = (this.prisma as unknown as Record<string, any>)[
          def.delegate
        ];
        const row = await delegate.findUnique({
          where: { id: dto.resourceId },
        });
        if (!row) {
          throw new NotFoundException({
            code: WORKSPACE_ERRORS.RELOCATE_NOT_FOUND,
            message: `${def.label} ${dto.resourceId} 不存在`,
          });
        }
        const fromWorkspaceId = String(row.workspaceId);
        if (fromWorkspaceId === target.id) {
          return {
            moved: false as const,
            resourceType: dto.resourceType,
            resourceId: dto.resourceId,
            fromWorkspaceId,
            toWorkspaceId: target.id,
          };
        }
        await this.assertNoCrossSpaceDependencies(
          dto.resourceType as RelocatableResourceType,
          dto.resourceId,
          row,
          target.id,
        );
        if (def.uniqueFields.length > 0) {
          const key = ['workspaceId', ...def.uniqueFields].join('_');
          const fields: Record<string, unknown> = { workspaceId: target.id };
          for (const f of def.uniqueFields) fields[f] = row[f];
          const conflict = await delegate.findUnique({
            where: { [key]: fields },
          });
          if (conflict && conflict.id !== row.id) {
            throw new ConflictException({
              code: WORKSPACE_ERRORS.RELOCATE_CONFLICT,
              message: `目标空间已存在同唯一键的${def.label}（${def.uniqueFields.map((f: string) => `${f}=${String(row[f])}`).join(', ')}），请先处理冲突`,
            });
          }
        }
        const res = await delegate.updateMany({
          where: { id: row.id, workspaceId: fromWorkspaceId },
          data: { workspaceId: target.id },
        });
        if (!res || res.count === 0) {
          throw new ConflictException({
            code: WORKSPACE_ERRORS.RELOCATE_CONCURRENT,
            message: '资源已被并发修改（空间归属已变化），请刷新后重试',
          });
        }
        const relocationId = await this.idGen.nextId(
          WORKSPACE_RELOCATION_ID_PREFIX,
        );
        await this.prisma.workspaceRelocation.create({
          data: {
            id: relocationId,
            resourceType: dto.resourceType,
            resourceId: dto.resourceId,
            fromWorkspaceId,
            toWorkspaceId: target.id,
            reason: dto.reason ?? null,
            actorUserId,
          },
        });
        return {
          moved: true as const,
          id: relocationId,
          resourceType: dto.resourceType,
          resourceId: dto.resourceId,
          fromWorkspaceId,
          toWorkspaceId: target.id,
        };
      },
    );
  }

  /**
   * 迁移后的副作用重放（best-effort）：
   * - 在「迁出空间 / 迁入空间」两个租户上下文里分别广播 reload-config（worker 重新拉取
   *   Agent/技能/工具/MCP/策略等清单）；
   * - 回放模型凭据与 git 凭据（凭据只在所属空间内可见，不会跨空间下发）；
   * - 向两个空间广播 `workspace.resource.relocated` SSE 事件，前端可按空间失效缓存。
   *
   * 单测/轻量装配缺省 workers/realtime 时直接跳过；异常只告警，不回滚迁移。
   */
  private async replayRelocationSideEffects(
    actorUserId: string,
    dto: RelocateResourceDto,
    fromWorkspaceId: string,
    toWorkspaceId: string,
  ): Promise<void> {
    if (!this.workers && !this.realtime) return;
    const affected = Array.from(new Set([fromWorkspaceId, toWorkspaceId]));
    for (const workspaceId of affected) {
      try {
        await runWithTenant(
          { workspaceId, mode: 'request', userId: actorUserId },
          async () => {
            if (this.workers) {
              await this.workers.broadcastCommand({
                type: WORKER_COMMAND_TYPES.RELOAD_CONFIG,
                resourceVersion: new Date().toISOString(),
              });
              await this.workers.dispatchGitCredentials().catch((err) => {
                this.logger.warn(
                  `迁移后 git 凭据回放失败 ws=${workspaceId}: ${(err as Error).message}`,
                );
              });
              await this.workers
                .replayModelCredentialsToWorkspace(workspaceId)
                .catch((err) => {
                  this.logger.warn(
                    `迁移后模型凭据回放失败 ws=${workspaceId}: ${(err as Error).message}`,
                  );
                });
            }
            if (this.realtime) {
              await this.realtime
                .emit(EVENT_TYPES.WORKSPACE_RESOURCE_RELOCATED, {
                  resourceType: dto.resourceType,
                  resourceId: dto.resourceId,
                  fromWorkspaceId,
                  toWorkspaceId,
                  workspaceId,
                })
                .catch((err) => {
                  this.logger.warn(
                    `迁移事件广播失败 ws=${workspaceId}: ${(err as Error).message}`,
                  );
                });
            }
          },
        );
      } catch (err) {
        this.logger.warn(
          `迁移后副作用重放失败 ws=${workspaceId}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * 签发某空间的 worker 注册令牌（仅 owner/admin 或平台管理员）。
   *
   * 一个令牌即代表一个空间：worker 安装/注册只需携带它（X-Worker-Token），
   * 服务端按令牌反查空间；不再需要单独的 WORKSPACE_ID / WORKER_JOIN_TOKEN。
   * 明文只返回一次，DB 只存 SHA-256；重新签发会立即作废旧码。
   *
   * 默认空间（ws_default）无需加入码（单租户向后兼容），仍可签发但不会强制。
   */
  async issueWorkerJoinToken(
    actorUserId: string,
    workspaceId: string,
  ): Promise<{ workspaceId: string; joinToken: string }> {
    await this.assertWorkspaceExists(workspaceId);
    if (workspaceId === TENANT_WORKSPACE_ID.SYSTEM) {
      if (!(await isPlatformAdminByUserId(this.prisma, actorUserId))) {
        throw new ForbiddenException({
          code: WORKSPACE_ERRORS.FORBIDDEN,
          message: '仅平台管理员可管理系统空间的 worker 加入码',
        });
      }
    } else {
      await this.assertManager(actorUserId, workspaceId);
    }
    const joinToken = `wst_${randomBytes(24).toString('hex')}`;
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        workerJoinTokenHash: createHash('sha256')
          .update(joinToken)
          .digest('hex'),
      },
    });
    return { workspaceId, joinToken };
  }

  /** 查询 worker 的归属空间（worker 注入通道解析租户上下文用）。 */
  async resolveWorkerWorkspaceId(
    workerId: string,
  ): Promise<string | undefined> {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: { workspaceId: true },
    });
    return worker?.workspaceId;
  }

  /** 迁移审计列表（管理员，最近优先）。 */
  async listRelocations(limit = 50) {
    return this.prisma.workspaceRelocation.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  /**
   * 引用检查：资源迁走后，原空间里指向它的引用会变成跨空间引用（隔离破口/功能失效）。
   * 存在「目标空间之外」的引用 → 409 并列出类型。
   */
  private async assertNoCrossSpaceDependencies(
    type: RelocatableResourceType,
    resourceId: string,
    row: Record<string, unknown>,
    targetWorkspaceId: string,
  ): Promise<void> {
    const prisma = this.prisma as unknown as Record<string, any>;
    const outside = { not: targetWorkspaceId };
    const refs: string[] = [];
    const exists = async (name: string, p: Promise<unknown>) => {
      if (await p) refs.push(name);
    };
    switch (type) {
      case 'agent':
        await exists(
          '团队成员席位',
          prisma.teamMember.findFirst({
            where: { agentId: resourceId, team: { workspaceId: outside } },
            select: { id: true },
          }),
        );
        await exists(
          '成员库成员',
          prisma.member.findFirst({
            where: { agentId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        await exists(
          '会话',
          prisma.session.findFirst({
            where: { agentId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        break;
      case 'agent_role':
        await exists(
          '团队成员席位',
          prisma.teamMember.findFirst({
            where: { roleId: resourceId, team: { workspaceId: outside } },
            select: { id: true },
          }),
        );
        await exists(
          '成员默认岗位',
          prisma.member.findFirst({
            where: { defaultRoleId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        break;
      case 'skill':
        await exists(
          'Agent 技能绑定',
          prisma.agentSkill.findFirst({
            where: { skillId: resourceId, agent: { workspaceId: outside } },
            select: { id: true },
          }),
        );
        break;
      case 'execution_policy':
        await exists(
          'Agent 策略绑定',
          prisma.agent.findFirst({
            where: { policyId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        break;
      case 'model':
        await exists(
          'Agent 默认模型',
          prisma.agent.findFirst({
            where: { defaultModelId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        await exists(
          '团队默认模型',
          prisma.team.findFirst({
            where: { defaultModelId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        await exists(
          '成员默认模型',
          prisma.member.findFirst({
            where: { defaultModelId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        await exists(
          'Worker 默认模型',
          prisma.worker.findFirst({
            where: { defaultModelId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        break;
      case 'model_credential': {
        const providerID = String(row.providerID ?? '');
        await exists(
          '其它空间的同 provider 模型目录行',
          prisma.model.findFirst({
            where: { providerID, workspaceId: outside },
            select: { id: true },
          }),
        );
        break;
      }
      case 'worker':
        await exists(
          '会话',
          prisma.session.findFirst({
            where: { workerId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        await exists(
          '任务实例',
          prisma.taskGroupInstance.findFirst({
            where: { workerId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        await exists(
          '团队首选 worker',
          prisma.team.findFirst({
            where: { preferredWorkerId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        await exists(
          '成员首选 worker',
          prisma.member.findFirst({
            where: { preferredWorkerId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        break;
      case 'git_repo':
        await exists(
          '仓库授权',
          prisma.gitRepoGrant.findFirst({
            where: { repoId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        break;
      case 'git_credential':
        await exists(
          'Git 仓库引用',
          prisma.gitRepo.findFirst({
            where: { credentialId: resourceId, workspaceId: outside },
            select: { id: true },
          }),
        );
        break;
      // tool / mcp_server：全局字符串引用（Tool.mcpServer 名称），无法做可靠归属判定，跳过。
      default:
        break;
    }
    if (refs.length > 0) {
      throw new ConflictException({
        code: WORKSPACE_ERRORS.RELOCATE_IN_USE,
        message: `该资源仍被其它空间引用（${refs.join('、')}），请先解除引用再迁移`,
      });
    }
  }

  private toSummary(row: WorkspaceRow, role: string): WorkspaceSummary {
    return {
      id: row.id,
      name: row.name,
      isSystem: row.isSystem,
      status: row.status,
      role: row.isSystem ? WORKSPACE_ROLE.MEMBER : (role as WorkspaceRole),
      ownerUserId: row.ownerUserId,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}
