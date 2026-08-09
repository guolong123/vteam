import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
    };
    role: {
      findUnique: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const userRow = {
    id: 'usr_1',
    username: 'alice',
    displayName: 'Alice',
    email: 'alice@test.com',
    roleId: 'role_admin',
    enabled: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    // 仅 mock PrismaService，聚焦 UsersService 业务逻辑
    prisma = {
      user: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      role: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('findAll（列表分页）', () => {
    it('返回 {items,total,page,pageSize}，且 items 不含 passwordHash', async () => {
      prisma.$transaction.mockResolvedValue([[userRow], 1]);

      const result = await service.findAll(1, 20);

      expect(result).toEqual({
        items: [userRow],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      // 契约保证：响应不含 password_hash
      expect(result.items[0]).not.toHaveProperty('passwordHash');
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('附带所属项目数 _count.projectMembers（MOCK-05）', async () => {
      const listRow = {
        ...userRow,
        _count: { projectMembers: 2 },
      };
      prisma.$transaction.mockResolvedValue([[listRow], 1]);

      const result = await service.findAll(1, 20);

      // Prisma select 透传 _count 关联计数
      const findManyArgs = prisma.user.findMany.mock.calls[0][0];
      expect(findManyArgs.select).toMatchObject({
        _count: { select: { projectMembers: true } },
      });
      // 响应原样透传真实计数（非硬编码 0）
      expect(result.items[0]).toEqual(listRow);
      expect(result.items[0]).toHaveProperty('_count.projectMembers', 2);
    });

    it('pageSize 上限收敛到 100（09 篇 §2.2）', async () => {
      prisma.$transaction.mockResolvedValue([[], 0]);
      await service.findAll(1, 9999);
      // 取 findMany 的 take 参数验证上限
      const findManyArgs = prisma.user.findMany.mock.calls[0][0];
      expect(findManyArgs.take).toBe(100);
    });

    it('search 命中 username/displayName 模糊匹配', async () => {
      prisma.$transaction.mockResolvedValue([[], 0]);
      await service.findAll(1, 20, 'ali');
      const findManyArgs = prisma.user.findMany.mock.calls[0][0];
      expect(findManyArgs.where).toEqual({
        OR: [
          { username: { contains: 'ali' } },
          { displayName: { contains: 'ali' } },
        ],
      });
    });
  });

  describe('findOne（详情）', () => {
    it('返回用户详情（不含 passwordHash）', async () => {
      prisma.user.findUnique.mockResolvedValue(userRow);
      const user = await service.findOne('usr_1');
      expect(user).toEqual(userRow);
      expect(user).not.toHaveProperty('passwordHash');
    });

    it('用户不存在抛 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findOne('usr_missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateStatus（禁用/启用，FR-22）', () => {
    it('禁用后 enabled=false，账号数据不删除', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'usr_1' });
      prisma.user.update.mockResolvedValue({ ...userRow, enabled: false });

      const result = await service.updateStatus('usr_1', { enabled: false });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'usr_1' },
        data: { enabled: false },
        select: expect.any(Object),
      });
      expect(result.enabled).toBe(false);
      // 禁用不删除：仅调用 update，业务代码不触碰 delete
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('目标用户不存在抛 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.updateStatus('usr_missing', { enabled: false }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('create（创建用户，Phase 3 T8）', () => {
    const createDto = {
      username: 'bob',
      password: 'secret123',
      displayName: 'Bob',
      email: 'bob@test.com',
      roleId: 'r_member',
    };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(null); // username/email 均未占用
      prisma.role.findUnique.mockResolvedValue({ id: 'r_member', name: 'member' });
      prisma.user.create.mockResolvedValue({
        ...userRow,
        id: 'u_bob',
        username: 'bob',
        displayName: 'Bob',
        email: 'bob@test.com',
        roleId: 'r_member',
      });
    });

    it('bcrypt 哈希密码后落库，角色关联 roleId，返回不含哈希摘要', async () => {
      const result = await service.create(createDto);

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          username: 'bob',
          roleId: 'r_member',
          enabled: true,
        }),
        select: expect.any(Object),
      });
      expect(result).not.toHaveProperty('passwordHash');
      // 落库的是 bcrypt 哈希（10 轮），非明文
      const stored = prisma.user.create.mock.calls[0][0].data.passwordHash;
      expect(stored).not.toBe('secret123');
      expect(await bcrypt.compare('secret123', stored)).toBe(true);
    });

    it('username 已被占用抛 ConflictException（USERNAME_CONFLICT）', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ id: 'u_x', username: 'bob' });
      await expect(service.create(createDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('email 已被占用抛 ConflictException（EMAIL_CONFLICT）', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // username 无冲突
        .mockResolvedValueOnce({ id: 'u_y', email: 'bob@test.com' }); // email 冲突
      await expect(service.create(createDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('roleId 指向的角色不存在抛 BadRequestException', async () => {
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.create(createDto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('resetPassword（重置密码，Phase 3 T8）', () => {
    it('bcrypt 重新哈希覆盖 password_hash，返回不含哈希摘要', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'usr_1' });
      prisma.user.update.mockResolvedValue({ ...userRow });

      const result = await service.resetPassword('usr_1', {
        newPassword: 'newPass123',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'usr_1' },
        data: expect.objectContaining({ passwordHash: expect.any(String) }),
        select: expect.any(Object),
      });
      const stored = prisma.user.update.mock.calls[0][0].data.passwordHash;
      expect(await bcrypt.compare('newPass123', stored)).toBe(true);
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('目标用户不存在抛 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.resetPassword('usr_missing', { newPassword: 'newPass123' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('update（编辑用户，ISSUE-002 修复）', () => {
    it('部分更新：仅提交的字段落库，返回不含哈希摘要', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(userRow) // 目标用户存在
        .mockResolvedValueOnce(null); // email 无冲突
      prisma.role.findUnique.mockResolvedValue({ id: 'r_member', name: 'member' });
      prisma.user.update.mockResolvedValue({
        ...userRow,
        email: 'new@test.com',
        roleId: 'r_member',
      });

      const result = await service.update('usr_1', {
        email: 'new@test.com',
        roleId: 'r_member',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'usr_1' },
        data: { email: 'new@test.com', roleId: 'r_member' },
        select: expect.any(Object),
      });
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('username 变更与他人冲突抛 ConflictException（USERNAME_CONFLICT）', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(userRow) // 目标用户存在
        .mockResolvedValueOnce({ id: 'u_x', username: 'alice2' }); // username 被占用
      await expect(
        service.update('usr_1', { username: 'alice2' }),
      ).rejects.toThrow(ConflictException);
    });

    it('email 传 null 清空邮箱（跳过唯一校验）', async () => {
      prisma.user.findUnique.mockResolvedValue(userRow);
      prisma.user.update.mockResolvedValue({ ...userRow, email: null });

      await service.update('usr_1', { email: null });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'usr_1' },
        data: { email: null },
        select: expect.any(Object),
      });
    });

    it('roleId 指向的角色不存在抛 BadRequestException', async () => {
      prisma.user.findUnique.mockResolvedValue(userRow);
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(
        service.update('usr_1', { roleId: 'r_ghost' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('PATCH 空 body 幂等返回当前用户（不触发空更新）', async () => {
      prisma.user.findUnique.mockResolvedValue(userRow);
      prisma.user.update.mockResolvedValue({});

      const result = await service.update('usr_1', {});

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(result.username).toBe('alice');
    });

    it('目标用户不存在抛 404', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.update('usr_missing', { username: 'alice' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
