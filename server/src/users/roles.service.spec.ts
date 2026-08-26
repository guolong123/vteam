import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RolesService', () => {
  let service: RolesService;
  let prisma: {
    role: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    user: {
      count: jest.Mock;
    };
  };

  const customRole = {
    id: 'r_custom_1',
    name: 'reviewer',
    permissions: { tasks: { view: true, manage: false } },
    scopes: { global: false, projects: [], innerRoles: [] },
    isBuiltin: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  const builtinRole = {
    id: 'r_admin',
    name: 'admin',
    permissions: { all: true },
    scopes: { global: true },
    isBuiltin: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    prisma = {
      role: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      user: {
        count: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RolesService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<RolesService>(RolesService);
  });

  describe('findAll', () => {
    it('返回全部角色（含 permissions/scopes）', async () => {
      prisma.role.findMany.mockResolvedValue([builtinRole, customRole]);
      const roles = await service.findAll();
      expect(roles).toHaveLength(2);
      expect(prisma.role.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'asc' },
      });
    });
  });

  describe('create', () => {
    it('创建自定义角色 isBuiltin=false，permissions/scopes 透传', async () => {
      prisma.role.findUnique.mockResolvedValue(null);
      prisma.role.create.mockResolvedValue(customRole);

      const result = await service.create({
        name: 'reviewer',
        permissions: { tasks: { view: true, manage: false } },
        scopes: { global: false, projects: [], innerRoles: [] },
      });

      expect(prisma.role.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'reviewer',
          isBuiltin: false,
          permissions: { tasks: { view: true, manage: false } },
        }),
      });
      expect(result).toEqual(customRole);
    });

    it('角色名重复抛 ConflictException', async () => {
      prisma.role.findUnique.mockResolvedValue(builtinRole);
      await expect(
        service.create({ name: 'admin', permissions: {} }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('自定义角色可更新 name/permissions', async () => {
      prisma.role.findUnique
        .mockResolvedValueOnce(customRole) // 目标存在
        .mockResolvedValueOnce(null); // 新名未被占用
      prisma.role.update.mockResolvedValue({
        ...customRole,
        name: 'senior-reviewer',
      });

      const result = await service.update('r_custom_1', {
        name: 'senior-reviewer',
        permissions: { tasks: { view: true, manage: true } },
      });

      expect(prisma.role.update).toHaveBeenCalledWith({
        where: { id: 'r_custom_1' },
        data: expect.objectContaining({ name: 'senior-reviewer' }),
      });
      expect(result.name).toBe('senior-reviewer');
    });

    it('预置角色（isBuiltin）更新抛 403', async () => {
      prisma.role.findUnique.mockResolvedValue(builtinRole);
      await expect(service.update('r_admin', { name: 'root' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('目标角色不存在抛 404', async () => {
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.update('r_missing', { name: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('新角色名与他人冲突抛 ConflictException', async () => {
      prisma.role.findUnique.mockResolvedValueOnce(customRole); // 目标存在
      prisma.role.findUnique.mockResolvedValueOnce(builtinRole); // 新名被占用
      await expect(
        service.update('r_custom_1', { name: 'admin' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('remove', () => {
    it('自定义角色无引用可删除', async () => {
      prisma.role.findUnique.mockResolvedValue(customRole);
      prisma.user.count.mockResolvedValue(0);
      prisma.role.delete.mockResolvedValue(customRole);

      const result = await service.remove('r_custom_1');

      expect(prisma.role.delete).toHaveBeenCalledWith({
        where: { id: 'r_custom_1' },
      });
      expect(result).toEqual({ deleted: true, id: 'r_custom_1' });
    });

    it('预置角色删除抛 403', async () => {
      prisma.role.findUnique.mockResolvedValue(builtinRole);
      await expect(service.remove('r_admin')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('仍被用户引用的角色删除抛 ConflictException', async () => {
      prisma.role.findUnique.mockResolvedValue(customRole);
      prisma.user.count.mockResolvedValue(3);
      await expect(service.remove('r_custom_1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('目标角色不存在抛 404', async () => {
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.remove('r_missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
