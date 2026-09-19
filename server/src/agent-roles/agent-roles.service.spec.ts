import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AGENT_ROLE_ERRORS,
  BUILTIN_AGENT_ROLES,
} from '../common/constants/agent-role.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRolesService } from './agent-roles.service';
import { CreateAgentRoleDto } from './dto/create-agent-role.dto';
import { UpdateAgentRoleDto } from './dto/update-agent-role.dto';

describe('AgentRolesService', () => {
  let service: AgentRolesService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let prisma: {
    agentRole: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    agent: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };

  const now = new Date('2026-09-19T00:00:00Z');
  const builtinRow = {
    id: 'ar_product',
    key: 'product',
    name: '产品经理',
    description: '内置角色：产品经理（需求分析与原型设计）。',
    type: 'builtin',
    defaultAgentId: 'a_product',
    rolePrompt: '你是产品经理。',
    sortOrder: 1,
    createdAt: now,
    updatedAt: now,
  };
  const customRow = {
    id: 'ar_0000000001',
    key: 'data-analyst',
    name: '数据分析师',
    description: null,
    type: 'custom',
    defaultAgentId: null,
    rolePrompt: '你是数据分析师。',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };

  const builtinRows = BUILTIN_AGENT_ROLES.map((r, i) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: null,
    type: 'builtin',
    defaultAgentId: r.defaultAgentId,
    rolePrompt: `role-prompt-${r.key}`,
    sortOrder: r.sortOrder,
    createdAt: new Date(`2026-09-19T00:00:0${i}Z`),
    updatedAt: new Date(`2026-09-19T00:00:0${i}Z`),
  }));

  beforeEach(async () => {
    idGen = {
      nextId: jest.fn(async (prefix: string) => `${prefix}_0000000001`),
      seed: jest.fn(),
    };
    prisma = {
      agentRole: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      agent: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRolesService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
      ],
    }).compile();

    service = module.get<AgentRolesService>(AgentRolesService);
  });

  describe('findAll（列表：type 过滤 + 分页 + 内置优先排序）', () => {
    it('无参返回全部角色，按 type asc + sortOrder asc（7 内置在前）', async () => {
      prisma.$transaction.mockResolvedValue([
        builtinRows.length + 1,
        [...builtinRows, { ...customRow, type: 'custom' }],
      ]);

      const result = await service.findAll();

      expect(result.total).toBe(8);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.items).toHaveLength(8);
      expect(prisma.agentRole.findMany).toHaveBeenCalledWith({
        where: { type: undefined },
        orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
        skip: 0,
        take: 20,
      });
      // 7 个内置在前，key/defaultAgentId/rolePrompt 齐全
      const builtin = result.items.filter((r) => r.type === 'builtin');
      expect(builtin).toHaveLength(7);
      expect(builtin.map((r) => r.key)).toEqual([
        'product',
        'project_manager',
        'architect',
        'developer',
        'tester',
        'plan',
        'librarian',
      ]);
      expect(builtin.every((r) => r.defaultAgentId !== null)).toBe(true);
      // rolePrompt 字段已暴露（可编辑文本；todo 4 负责填充内置行正文）。
      expect(builtin.every((r) => 'rolePrompt' in r)).toBe(true);
      expect(builtin[0].rolePrompt).toBe('role-prompt-product');
    });

    it('type=builtin 过滤 + 自定义分页（page=2, pageSize=5）', async () => {
      prisma.$transaction.mockResolvedValue([7, builtinRows]);

      await service.findAll({ type: 'builtin', page: 2, pageSize: 5 });

      expect(prisma.agentRole.count).toHaveBeenCalledWith({
        where: { type: { equals: 'builtin' } },
      });
      expect(prisma.agentRole.findMany).toHaveBeenCalledWith({
        where: { type: { equals: 'builtin' } },
        orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
        skip: 5,
        take: 5,
      });
    });

    it('pageSize 超上限 100 时收敛为 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ pageSize: 999 });

      expect(prisma.agentRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });

    it('响应对象键恰为身份 + rolePrompt（无能力字段 permission/tools/model/worker）', async () => {
      prisma.$transaction.mockResolvedValue([1, [builtinRow]]);

      const result = await service.findAll();

      expect(Object.keys(result.items[0]).sort()).toEqual(
        [
          'id',
          'key',
          'name',
          'description',
          'type',
          'defaultAgentId',
          'rolePrompt',
          'sortOrder',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      expect(result.items[0]).not.toHaveProperty('permission');
      expect(result.items[0]).not.toHaveProperty('tools');
      expect(result.items[0]).not.toHaveProperty('model');
      expect(result.items[0]).not.toHaveProperty('worker');
    });
  });

  describe('findOne（详情）', () => {
    it('返回完整角色（含 defaultAgentId + rolePrompt）', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(builtinRow);

      const result = await service.findOne('ar_product');

      expect(prisma.agentRole.findUnique).toHaveBeenCalledWith({
        where: { id: 'ar_product' },
      });
      expect(result).toMatchObject({
        id: 'ar_product',
        key: 'product',
        type: 'builtin',
        defaultAgentId: 'a_product',
        rolePrompt: '你是产品经理。',
      });
    });

    it('角色不存在 → 404 AGENT_ROLE_NOT_FOUND', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(null);

      await expect(service.findOne('ar_nonexistent')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne('ar_nonexistent')).rejects.toMatchObject({
        response: { code: AGENT_ROLE_ERRORS.AGENT_ROLE_NOT_FOUND },
      });
    });
  });

  describe('create（POST /agent-roles，仅 custom）', () => {
    it('custom 创建：落库 type=custom + key/name/defaultAgentId/rolePrompt', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_developer' });
      prisma.agentRole.create.mockResolvedValue({
        ...customRow,
        defaultAgentId: 'a_developer',
      });

      const dto: CreateAgentRoleDto = {
        name: ' 数据分析师 ',
        key: 'data-analyst',
        type: 'custom',
        defaultAgentId: 'a_developer',
        rolePrompt: '你是数据分析师。',
      };

      const result = await service.create(dto);

      expect(prisma.agentRole.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          id: expect.any(String),
          key: 'data-analyst',
          name: '数据分析师',
          description: null,
          type: 'custom',
          defaultAgentId: 'a_developer',
          rolePrompt: '你是数据分析师。',
          sortOrder: 0,
        }),
      });
      expect(result).toMatchObject({
        id: 'ar_0000000001',
        key: 'data-analyst',
        type: 'custom',
        defaultAgentId: 'a_developer',
        rolePrompt: '你是数据分析师。',
      });
    });

    it('defaultAgentId 缺省 → null（不预填），不查 Agent 存在性', async () => {
      prisma.agentRole.create.mockResolvedValue(customRow);

      await service.create({
        name: '数据分析师',
        key: 'data-analyst',
        type: 'custom',
      });

      expect(prisma.agent.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentRole.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ defaultAgentId: null }),
        }),
      );
    });

    it('defaultAgentId 显式 null → null（不清空预填以外的语义，不查 Agent）', async () => {
      prisma.agentRole.create.mockResolvedValue(customRow);

      await service.create({
        name: '数据分析师',
        key: 'data-analyst',
        type: 'custom',
        defaultAgentId: null,
      });

      expect(prisma.agent.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentRole.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ defaultAgentId: null }),
        }),
      );
    });

    it('defaultAgentId 指向不存在的 Agent → 400 AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND（不落库）', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(
        service.create({
          name: '数据分析师',
          key: 'data-analyst',
          type: 'custom',
          defaultAgentId: 'a_ghost',
        }),
      ).rejects.toMatchObject({
        response: {
          code: AGENT_ROLE_ERRORS.AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND,
        },
      });
      expect(prisma.agentRole.create).not.toHaveBeenCalled();
    });

    it('非法 key → 400 AGENT_ROLE_KEY_INVALID（不落库）', async () => {
      await expect(
        service.create({
          name: '数据分析师',
          key: 'Invalid_Key!',
          type: 'custom',
        }),
      ).rejects.toMatchObject({
        response: { code: AGENT_ROLE_ERRORS.AGENT_ROLE_KEY_INVALID },
      });
      expect(prisma.agentRole.create).not.toHaveBeenCalled();
    });

    it('key 唯一冲突（P2002）→ 409 AGENT_ROLE_KEY_CONFLICT', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_developer' });
      prisma.agentRole.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      await expect(
        service.create({
          name: '重复角色',
          key: 'data-analyst',
          type: 'custom',
        }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.create({
          name: '重复角色',
          key: 'data-analyst',
          type: 'custom',
        }),
      ).rejects.toMatchObject({
        response: { code: AGENT_ROLE_ERRORS.AGENT_ROLE_KEY_CONFLICT },
      });
    });
  });

  describe('update（PATCH /agent-roles/:id）', () => {
    it('custom 更新：name/description/rolePrompt/defaultAgentId 落库', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(customRow);
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_developer' });
      prisma.agentRole.update.mockResolvedValue({
        ...customRow,
        name: '高级分析师',
        description: '描述',
        defaultAgentId: 'a_developer',
        rolePrompt: '新指令',
      });

      const dto: UpdateAgentRoleDto = {
        name: '高级分析师',
        description: '描述',
        defaultAgentId: 'a_developer',
        rolePrompt: '新指令',
      };
      const result = await service.update('ar_0000000001', dto);

      expect(prisma.agentRole.update).toHaveBeenCalledWith({
        where: { id: 'ar_0000000001' },
        data: expect.objectContaining({
          name: '高级分析师',
          description: '描述',
          defaultAgentId: 'a_developer',
          rolePrompt: '新指令',
        }),
      });
      expect(result).toMatchObject({
        name: '高级分析师',
        rolePrompt: '新指令',
        defaultAgentId: 'a_developer',
      });
    });

    it('内置角色可编辑 name/description/rolePrompt/defaultAgentId（Roles tab 读取）', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(builtinRow);
      prisma.agent.findUnique.mockResolvedValue({ id: 'a_developer' });
      prisma.agentRole.update.mockResolvedValue({
        ...builtinRow,
        name: '产品经理（修订）',
        rolePrompt: '新岗位说明',
        defaultAgentId: 'a_developer',
      });

      await service.update('ar_product', {
        name: '产品经理（修订）',
        rolePrompt: '新岗位说明',
        defaultAgentId: 'a_developer',
      });

      expect(prisma.agentRole.update).toHaveBeenCalledWith({
        where: { id: 'ar_product' },
        data: expect.objectContaining({
          name: '产品经理（修订）',
          rolePrompt: '新岗位说明',
          defaultAgentId: 'a_developer',
        }),
      });
    });

    it('内置角色改 key → 403 AGENT_ROLE_BUILTIN_READONLY（不落库）', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(builtinRow);

      await expect(
        service.update('ar_product', { key: 'product-v2' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.update('ar_product', { key: 'product-v2' }),
      ).rejects.toMatchObject({
        response: { code: AGENT_ROLE_ERRORS.AGENT_ROLE_BUILTIN_READONLY },
      });
      expect(prisma.agentRole.update).not.toHaveBeenCalled();
    });

    it('defaultAgentId 显式 null → 清除（不查 Agent 存在性）', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(customRow);
      prisma.agentRole.update.mockResolvedValue({
        ...customRow,
        defaultAgentId: null,
      });

      await service.update('ar_0000000001', { defaultAgentId: null });

      expect(prisma.agent.findUnique).not.toHaveBeenCalled();
      expect(prisma.agentRole.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ defaultAgentId: null }),
        }),
      );
    });

    it('defaultAgentId 指向不存在的 Agent → 400（不落库）', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(customRow);
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(
        service.update('ar_0000000001', { defaultAgentId: 'a_ghost' }),
      ).rejects.toMatchObject({
        response: {
          code: AGENT_ROLE_ERRORS.AGENT_ROLE_DEFAULT_AGENT_NOT_FOUND,
        },
      });
      expect(prisma.agentRole.update).not.toHaveBeenCalled();
    });

    it('不传字段不触碰（data 不含 name/key/defaultAgentId/rolePrompt）', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(customRow);
      prisma.agentRole.update.mockResolvedValue(customRow);

      await service.update('ar_0000000001', { sortOrder: 5 });

      expect(prisma.agentRole.update).toHaveBeenCalledWith({
        where: { id: 'ar_0000000001' },
        data: { sortOrder: 5 },
      });
    });

    it('角色不存在 → 404 AGENT_ROLE_NOT_FOUND', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(null);

      await expect(
        service.update('ar_ghost', { name: 'x' }),
      ).rejects.toMatchObject({
        response: { code: AGENT_ROLE_ERRORS.AGENT_ROLE_NOT_FOUND },
      });
    });
  });

  describe('remove（DELETE /agent-roles/:id，内置保护）', () => {
    it('type=builtin → 403 AGENT_ROLE_BUILTIN_READONLY，且行仍存在（不删）', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(builtinRow);

      await expect(service.remove('ar_product')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.remove('ar_product')).rejects.toMatchObject({
        response: { code: AGENT_ROLE_ERRORS.AGENT_ROLE_BUILTIN_READONLY },
      });
      // 内置角色行未被删除
      expect(prisma.agentRole.delete).not.toHaveBeenCalled();
    });

    it('custom 角色：正常删除', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(customRow);
      prisma.agentRole.delete.mockResolvedValue(customRow);

      await service.remove('ar_0000000001');

      expect(prisma.agentRole.delete).toHaveBeenCalledWith({
        where: { id: 'ar_0000000001' },
      });
    });

    it('被团队成员引用（P2003 RESTRICT）→ 409 AGENT_ROLE_IN_USE', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(customRow);
      prisma.agentRole.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('fk', {
          code: 'P2003',
          clientVersion: '6.19.3',
        }),
      );

      await expect(service.remove('ar_0000000001')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.remove('ar_0000000001')).rejects.toMatchObject({
        response: { code: AGENT_ROLE_ERRORS.AGENT_ROLE_IN_USE },
      });
    });

    it('角色不存在 → 404（删除前先校验存在性）', async () => {
      prisma.agentRole.findUnique.mockResolvedValue(null);

      await expect(service.remove('ar_ghost')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.agentRole.delete).not.toHaveBeenCalled();
    });
  });
});
