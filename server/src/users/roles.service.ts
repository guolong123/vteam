import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { emptyPermissions, isBuiltinRole } from './roles.constants';

const DEFAULT_SCOPES = { global: false, projects: [], innerRoles: [] };

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /roles：角色列表（含 permissions/scopes） */
  findAll() {
    return this.prisma.role.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  /** POST /roles：创建自定义角色（isBuiltin=false） */
  async create(dto: CreateRoleDto) {
    const { name, permissions, scopes } = dto;

    const existing = await this.prisma.role.findUnique({ where: { name } });
    if (existing) {
      throw new ConflictException(`角色名 ${name} 已存在`);
    }

    return this.prisma.role.create({
      data: {
        id: `r_${Date.now()}`,
        name,
        permissions: (permissions ??
          emptyPermissions()) as Prisma.InputJsonValue,
        scopes: (scopes ?? DEFAULT_SCOPES) as Prisma.InputJsonValue,
        isBuiltin: false,
      },
    });
  }

  /** PATCH /roles/:id：预置角色只读（403），自定义角色可更新 */
  async update(id: string, dto: UpdateRoleDto) {
    const role = await this.getRoleOrThrow(id);
    if (isBuiltinRole(role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_BUILTIN_ROLE',
        message: `内置角色 ${role.name} 为预置只读，不可修改`,
      });
    }

    if (dto.name !== undefined && dto.name !== role.name) {
      const nameTaken = await this.prisma.role.findUnique({
        where: { name: dto.name },
      });
      if (nameTaken) {
        throw new ConflictException(`角色名 ${dto.name} 已存在`);
      }
    }

    return this.prisma.role.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.permissions !== undefined
          ? { permissions: dto.permissions as Prisma.InputJsonValue }
          : {}),
        ...(dto.scopes !== undefined
          ? { scopes: dto.scopes as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  /** DELETE /roles/:id：预置角色只读（403）；被用户引用的角色不可删（409） */
  async remove(id: string) {
    const role = await this.getRoleOrThrow(id);
    if (isBuiltinRole(role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_BUILTIN_ROLE',
        message: `内置角色 ${role.name} 为预置只读，不可删除`,
      });
    }

    const userCount = await this.prisma.user.count({
      where: { roleId: id },
    });
    if (userCount > 0) {
      throw new ConflictException(
        `角色 ${role.name} 仍被 ${userCount} 个用户引用，无法删除`,
      );
    }

    await this.prisma.role.delete({ where: { id } });
    return { deleted: true, id };
  }

  private async getRoleOrThrow(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) {
      throw new NotFoundException(`角色 ${id} 不存在`);
    }
    return role;
  }
}
