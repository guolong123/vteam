import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import {
  normalizePage,
  normalizePageSize,
  paginated,
} from '../common/pagination';

/** bcrypt 轮数：与 auth.service.register 保持一致 */
const BCRYPT_ROUNDS = 10;

/**
 * 列表返回字段——绝不包含 passwordHash（09 篇 §3.2 GET /users 契约）。
 */
const SAFE_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  roleId: true,
  enabled: true,
  lastWorkspaceId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** 用户列表/详情选择：安全字段 + 空间成员关系（管理页展示/编辑空间用）。 */
const USER_DETAIL_SELECT = {
  ...SAFE_USER_SELECT,
  workspaceMembers: {
    select: {
      workspaceId: true,
      role: true,
      workspace: { select: { id: true, name: true, isSystem: true } },
    },
  },
} as const;

export interface UserListResult {
  items: unknown[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 分页列表（对齐 09 篇 §2.2：page/pageSize 默认 1/20，上限 100）。
   * search 对 username / displayName 做模糊匹配。响应不含 password_hash。
   * 附带所属团队数 _count.teamUserMembers（MOCK-05：真实计数，非前端硬编码 0）。
   */
  async findAll(page = 1, pageSize?: number, search?: string) {
    // 与全平台列表端点同一分页口径（common/pagination）；此前是第 4 种手写实现。
    const safePage = normalizePage(page);
    const safePageSize = normalizePageSize(pageSize);

    const where = search
      ? {
          OR: [
            { username: { contains: search } },
            { displayName: { contains: search } },
          ],
        }
      : undefined;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          ...SAFE_USER_SELECT,
          workspaceMembers: USER_DETAIL_SELECT.workspaceMembers,
          _count: { select: { teamUserMembers: true } },
        },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginated(items, total, safePage, safePageSize);
  }

  /**
   * 用户详情（不含 password_hash）。不存在则抛 404。
   */
  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: SAFE_USER_SELECT,
    });
    if (!user) {
      throw new NotFoundException(`用户 ${id} 不存在`);
    }
    return user;
  }

  /**
   * 禁用/启用用户（FR-22）。禁用后该用户登录返回 401（由 AuthModule 校验 enabled 门控）。
   * 仅更新 enabled 标记，不删除任何账号数据。
   */
  async updateStatus(id: string, dto: UpdateUserStatusDto) {
    const existing = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException(`用户 ${id} 不存在`);
    }
    return this.prisma.user.update({
      where: { id },
      data: { enabled: dto.enabled },
      select: SAFE_USER_SELECT,
    });
  }

  /**
   * 创建用户（Phase 3 T8，管理员操作）。
   * 冲突校验（username/email 唯一）与 bcrypt 哈希逻辑对齐 auth.service.register；
   * 额外校验 roleId 指向的角色存在后完成角色关联。
   */
  async create(dto: CreateUserDto) {
    const {
      username,
      password,
      displayName,
      email,
      roleId,
      workspaceId,
      workspaceRole = 'member',
    } = dto;

    const existingByUsername = await this.prisma.user.findUnique({
      where: { username },
    });
    if (existingByUsername) {
      throw new ConflictException({
        code: 'USERNAME_CONFLICT',
        message: `用户名 ${username} 已被占用`,
      });
    }
    if (email) {
      const existingByEmail = await this.prisma.user.findUnique({
        where: { email },
      });
      if (existingByEmail) {
        throw new ConflictException({
          code: 'EMAIL_CONFLICT',
          message: `邮箱 ${email} 已被占用`,
        });
      }
    }

    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new BadRequestException(`角色 ${roleId} 不存在`);
    }

    // 可选：创建后直接加入指定工作空间（管理员在「新增用户」里选空间）
    if (workspaceId) {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, status: true, isSystem: true },
      });
      if (!workspace || workspace.status !== 'active') {
        throw new BadRequestException({
          code: 'USER_WORKSPACE_NOT_FOUND',
          message: `工作空间 ${workspaceId} 不存在或已归档`,
        });
      }
      if (workspace.isSystem) {
        throw new BadRequestException({
          code: 'USER_WORKSPACE_SYSTEM_NOT_JOINABLE',
          message: '平台空间默认对所有用户只读可见，无需加入',
        });
      }
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userId = `u_${Date.now()}`;
    // 未指定空间：保持原有行为（首次登录由 WorkspacesService 自愈创建个人空间）
    if (!workspaceId) {
      return this.prisma.user.create({
        data: {
          id: userId,
          username,
          passwordHash,
          displayName,
          email,
          roleId: role.id,
          enabled: true,
        },
        select: SAFE_USER_SELECT,
      });
    }
    // 指定空间：用户 + 空间成员 + lastWorkspaceId 同一事务落库，
    // 保证「创建成功即可直接进入所选空间」。
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: userId,
          username,
          passwordHash,
          displayName,
          email,
          roleId: role.id,
          enabled: true,
          lastWorkspaceId: workspaceId,
        },
        select: SAFE_USER_SELECT,
      });
      await tx.workspaceMember.create({
        data: {
          workspaceId,
          userId,
          role: workspaceRole,
        },
      });
      return user;
    });
  }

  /**
   * 更新用户信息（ISSUE-002 修复：编辑用户名/邮箱/角色）。
   * 仅更新提交的字段；username/email 变更时校验唯一冲突（排除自身）；
   * email 传 null 表示清空；roleId 变更时校验角色存在。
   */
  async update(id: string, dto: UpdateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`用户 ${id} 不存在`);
    }

    if (dto.username !== undefined && dto.username !== existing.username) {
      const conflict = await this.prisma.user.findUnique({
        where: { username: dto.username },
      });
      if (conflict) {
        throw new ConflictException({
          code: 'USERNAME_CONFLICT',
          message: `用户名 ${dto.username} 已被占用`,
        });
      }
    }

    if (dto.email !== undefined && dto.email !== existing.email && dto.email) {
      const conflict = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (conflict) {
        throw new ConflictException({
          code: 'EMAIL_CONFLICT',
          message: `邮箱 ${dto.email} 已被占用`,
        });
      }
    }

    if (dto.roleId !== undefined) {
      const role = await this.prisma.role.findUnique({
        where: { id: dto.roleId },
      });
      if (!role) {
        throw new BadRequestException(`角色 ${dto.roleId} 不存在`);
      }
    }

    // 工作空间成员关系同步（管理页「所属空间」编辑）
    if (dto.workspaceIds !== undefined) {
      const ids = [
        ...new Set(dto.workspaceIds.map((v) => v.trim()).filter(Boolean)),
      ];
      const spaces = await this.prisma.workspace.findMany({
        where: { id: { in: ids }, status: 'active' },
        select: { id: true },
      });
      const found = new Set(spaces.map((w) => w.id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new BadRequestException({
          code: 'USER_WORKSPACE_NOT_FOUND',
          message: `工作空间不存在或已归档：${missing.join(', ')}`,
        });
      }
      const current =
        dto.currentWorkspaceId ??
        (existing.lastWorkspaceId && ids.includes(existing.lastWorkspaceId)
          ? existing.lastWorkspaceId
          : (ids[0] ?? null));
      if (current && !ids.includes(current)) {
        throw new BadRequestException({
          code: 'USER_WORKSPACE_CURRENT_INVALID',
          message: '当前空间必须包含在 workspaceIds 中',
        });
      }
      return this.prisma.$transaction(async (tx) => {
        const members = await tx.workspaceMember.findMany({
          where: { userId: id },
          select: { workspaceId: true, role: true },
        });
        for (const m of members) {
          if (ids.includes(m.workspaceId)) continue;
          if (m.role === 'owner') {
            throw new BadRequestException({
              code: 'USER_WORKSPACE_OWNER_REMOVE',
              message: `用户是空间 ${m.workspaceId} 的 owner，不能直接移出（请先转移空间归属）`,
            });
          }
          await tx.workspaceMember.delete({
            where: {
              workspaceId_userId: { workspaceId: m.workspaceId, userId: id },
            },
          });
        }
        const existingIds = new Set(members.map((m) => m.workspaceId));
        for (const wsId of ids) {
          if (existingIds.has(wsId)) continue;
          await tx.workspaceMember.create({
            data: { workspaceId: wsId, userId: id, role: 'member' },
          });
        }
        return tx.user.update({
          where: { id },
          data: {
            ...(dto.username !== undefined ? { username: dto.username } : {}),
            ...(dto.displayName !== undefined
              ? { displayName: dto.displayName }
              : {}),
            ...(dto.email !== undefined ? { email: dto.email } : {}),
            ...(dto.roleId !== undefined ? { roleId: dto.roleId } : {}),
            lastWorkspaceId: current,
          },
          select: USER_DETAIL_SELECT,
        });
      });
    }

    const data = {
      ...(dto.username !== undefined ? { username: dto.username } : {}),
      ...(dto.displayName !== undefined
        ? { displayName: dto.displayName }
        : {}),
      ...(dto.email !== undefined ? { email: dto.email } : {}),
      ...(dto.roleId !== undefined ? { roleId: dto.roleId } : {}),
    };

    // 空 data（PATCH 空 body）幂等返回当前用户，避免 Prisma 空更新报错
    if (Object.keys(data).length === 0) {
      return this.findOne(id);
    }

    return this.prisma.user.update({
      where: { id },
      data,
      select: SAFE_USER_SELECT,
    });
  }

  /**
   * 重置密码（Phase 3 T8，管理员操作）。bcrypt 重新哈希覆盖 password_hash。
   */
  async resetPassword(id: string, dto: ResetPasswordDto) {
    const existing = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException(`用户 ${id} 不存在`);
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    return this.prisma.user.update({
      where: { id },
      data: { passwordHash },
      select: SAFE_USER_SELECT,
    });
  }
}
