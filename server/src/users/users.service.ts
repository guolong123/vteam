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
  createdAt: true,
  updatedAt: true,
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
   * 附带所属项目数 _count.projectMembers（MOCK-05：真实计数，非前端硬编码 0）。
   */
  async findAll(page = 1, pageSize = DEFAULT_PAGE_SIZE, search?: string) {
    const safePage = page >= 1 ? page : 1;
    const safePageSize =
      pageSize >= 1 ? Math.min(pageSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

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
          _count: { select: { projectMembers: true } },
        },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items, total, page: safePage, pageSize: safePageSize };
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
    const { username, password, displayName, email, roleId } = dto;

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

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    return this.prisma.user.create({
      data: {
        id: `u_${Date.now()}`,
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
      const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
      if (!role) {
        throw new BadRequestException(`角色 ${dto.roleId} 不存在`);
      }
    }

    const data = {
      ...(dto.username !== undefined ? { username: dto.username } : {}),
      ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
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
