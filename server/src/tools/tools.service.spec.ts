import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TOOL_ERRORS } from '../common/constants/tool.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkersService } from '../workers/workers.service';
import { CreateToolDto } from './dto/create-tool.dto';
import { UpdateToolDto } from './dto/update-tool.dto';
import { ToolsService } from './tools.service';

describe('ToolsService', () => {
  let service: ToolsService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let workersService: { broadcastCommand: jest.Mock };
  let prisma: {
    tool: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    user: { findUnique: jest.Mock };
    mcpServer: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };

  const toolRows = [
    {
      id: 'tl_0000000001',
      name: 'Jira 查询',
      action: 'jira-query',
      source: 'custom',
      execution: 'cli',
      mcpServer: null,
      schema: { type: 'object', properties: { jobName: { type: 'string' } } },
      initCommand: [{ script: 'jcli login' }],
      enabled: true,
      createdAt: new Date('2026-08-08T00:00:00Z'),
      updatedAt: new Date('2026-08-08T00:00:00Z'),
    },
    {
      id: 'tl_0000000002',
      name: 'git-status',
      action: 'git-status',
      source: 'builtin',
      execution: 'code',
      mcpServer: null,
      schema: null,
      initCommand: null,
      enabled: true,
      createdAt: new Date('2026-08-08T00:00:01Z'),
      updatedAt: new Date('2026-08-08T00:00:01Z'),
    },
  ];

  beforeEach(async () => {
    idGen = {
      nextId: jest.fn().mockResolvedValue('tl_0000000003'),
      seed: jest.fn(),
    };
    prisma = {
      tool: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: { findUnique: jest.fn() },
      mcpServer: { findFirst: jest.fn() },
      $transaction: jest.fn(),
    };
    workersService = { broadcastCommand: jest.fn().mockResolvedValue(1) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ToolsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: WorkersService, useValue: workersService },
      ],
    }).compile();

    service = module.get<ToolsService>(ToolsService);
  });

  describe('onModuleInit（重启续号，忽略 tl_builtin_* 命名 id）', () => {
    it('库内已有 tl_<数字> 最大 id 时对齐 tool 前缀序号', async () => {
      prisma.tool.findMany.mockResolvedValue([{ id: 'tl_0000000042' }]);

      await service.onModuleInit();

      expect(prisma.tool.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'tl_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('tl', 42);
    });

    it('混入 tl_builtin_* 命名 id 时仍按数字序号续号（不被字典序更大的命名 id 干扰）', async () => {
      prisma.tool.findMany.mockResolvedValue([
        { id: 'tl_0000000001' },
        { id: 'tl_builtin_write' },
        { id: 'tl_0000000010' },
      ]);

      await service.onModuleInit();

      expect(idGen.seed).toHaveBeenCalledWith('tl', 10);
    });

    it('空库/无记录时跳过续号', async () => {
      prisma.tool.findMany.mockResolvedValue([]);

      await service.onModuleInit();

      expect(idGen.seed).not.toHaveBeenCalled();
    });
  });

  describe('findAll（列表：过滤 + 分页）', () => {
    it('无参返回全部工具 + 缺省分页 {items, total, page, pageSize}', async () => {
      prisma.$transaction.mockResolvedValue([toolRows.length, toolRows]);

      const result = await service.findAll();

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: 'tl_0000000001',
        name: 'Jira 查询',
        action: 'jira-query',
        source: 'custom',
        execution: 'cli',
        enabled: true,
      });
    });

    it('source/execution/enabled 过滤 + name 搜索 + 自定义分页', async () => {
      prisma.$transaction.mockResolvedValue([1, [toolRows[0]]]);

      await service.findAll({
        source: 'custom',
        execution: 'cli',
        enabled: true,
        name: 'jira',
        page: 2,
        pageSize: 10,
      });

      expect(prisma.tool.count).toHaveBeenCalledWith({
        where: {
          source: { equals: 'custom' },
          execution: { equals: 'cli' },
          enabled: true,
          name: { contains: 'jira' },
        },
      });
      expect(prisma.tool.findMany).toHaveBeenCalledWith({
        where: {
          source: { equals: 'custom' },
          execution: { equals: 'cli' },
          enabled: true,
          name: { contains: 'jira' },
        },
        orderBy: { createdAt: 'asc' },
        skip: 10,
        take: 10,
      });
    });

    it('mcpServer 过滤参数正确传入 Prisma where（缺省其余过滤 undefined）', async () => {
      prisma.$transaction.mockResolvedValue([1, [toolRows[1]]]);

      await service.findAll({ mcpServer: 'filesystem' });

      expect(prisma.tool.count).toHaveBeenCalledWith({
        where: {
          source: undefined,
          execution: undefined,
          enabled: undefined,
          name: undefined,
          mcpServer: { equals: 'filesystem' },
        },
      });
      expect(prisma.tool.findMany).toHaveBeenCalledWith({
        where: {
          source: undefined,
          execution: undefined,
          enabled: undefined,
          name: undefined,
          mcpServer: { equals: 'filesystem' },
        },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 20,
      });
    });

    it('source=mcp + mcpServer 组合过滤只返回该 server 的工具', async () => {
      prisma.$transaction.mockResolvedValue([1, [toolRows[1]]]);

      await service.findAll({ source: 'mcp', mcpServer: 'filesystem' });

      expect(prisma.tool.count).toHaveBeenCalledWith({
        where: {
          source: { equals: 'mcp' },
          execution: undefined,
          enabled: undefined,
          name: undefined,
          mcpServer: { equals: 'filesystem' },
        },
      });
      expect(prisma.tool.findMany).toHaveBeenCalledWith({
        where: {
          source: { equals: 'mcp' },
          execution: undefined,
          enabled: undefined,
          name: undefined,
          mcpServer: { equals: 'filesystem' },
        },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 20,
      });
    });

    it('enabled=false 过滤停用工具（不误伤 true）', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ enabled: false });

      expect(prisma.tool.count).toHaveBeenCalledWith({
        where: {
          source: undefined,
          execution: undefined,
          enabled: false,
          name: undefined,
        },
      });
    });

    it('成员 viewer → 强制 enabled=true（agent 配置页工具区仅可见启用工具）', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u_member',
        enabled: true,
        role: { permissions: { all: false } },
      });
      prisma.$transaction.mockResolvedValue([1, [toolRows[0]]]);

      const result = await service.findAll(
        { enabled: false },
        { id: 'u_member' },
      );

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u_member' },
        include: { role: true },
      });
      expect(prisma.tool.count).toHaveBeenCalledWith({
        where: {
          source: undefined,
          execution: undefined,
          enabled: true,
          name: undefined,
        },
      });
      expect(result.items).toHaveLength(1);
    });

    it('admin viewer（permissions.all）→ 遵循 query.enabled 不强制过滤', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u_admin',
        enabled: true,
        role: { permissions: { all: true } },
      });
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ enabled: false }, { id: 'u_admin' });

      expect(prisma.tool.count).toHaveBeenCalledWith({
        where: {
          source: undefined,
          execution: undefined,
          enabled: false,
          name: undefined,
        },
      });
    });

    it('viewer 用户不存在或已禁用 → 视为非 admin 强制 enabled=true', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({}, { id: 'u_gone' });

      expect(prisma.tool.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ enabled: true }),
        }),
      );
    });

    it('pageSize 超上限 100 时收敛为 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ pageSize: 999 });

      expect(prisma.tool.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });
  });

  describe('create（POST /tools，去独立 source 入参）', () => {
    const dto: CreateToolDto = {
      name: '  Git 提交 ',
      action: 'git-commit',
      execution: 'code',
      mcpServer: undefined,
      schema: { type: 'object' },
      initCommand: [{ script: 'git config' }],
    };

    it('非 mcp 执行方式 → source 推导 custom；id=tl_前缀、name/action trim、Json 透传、enabled 默认 true', async () => {
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.tool.create.mockResolvedValue({
        ...toolRows[0],
        id: 'tl_0000000003',
        name: 'Git 提交',
        action: 'git-commit',
      });

      const result = await service.create(dto);

      expect(prisma.tool.findUnique).toHaveBeenCalledWith({
        where: { action: 'git-commit' },
        select: { id: true },
      });
      expect(prisma.tool.create).toHaveBeenCalledWith({
        data: {
          id: 'tl_0000000003',
          name: 'Git 提交',
          action: 'git-commit',
          source: 'custom',
          execution: 'code',
          mcpServer: null,
          schema: { type: 'object' },
          initCommand: [{ script: 'git config' }],
          enabled: true,
        },
      });
      expect(result).toMatchObject({ id: 'tl_0000000003' });
    });

    it('F1 MAJOR：create 落库成功后广播 reload-config 到在线 worker', async () => {
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.tool.create.mockResolvedValue({
        ...toolRows[0],
        id: 'tl_0000000003',
      });

      await service.create(dto);

      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('F1 MAJOR：action 冲突 409 时不广播（变更未落库）', async () => {
      prisma.tool.findUnique.mockResolvedValue({ id: 'tl_0000000001' });

      await expect(
        service.create({ ...dto, action: 'jira-query' }),
      ).rejects.toMatchObject({
        response: { code: TOOL_ERRORS.TOOL_ACTION_EXISTS },
      });

      expect(workersService.broadcastCommand).not.toHaveBeenCalled();
    });

    it('execution=mcp → source 推导 mcp（mcpServer 透传）', async () => {
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.mcpServer.findFirst.mockResolvedValue({ id: 'ms_0000000001' });
      prisma.tool.create.mockResolvedValue({
        ...toolRows[0],
        id: 'tl_0000000003',
        source: 'mcp',
        mcpServer: 'filesystem',
      });

      await service.create({
        ...dto,
        execution: 'mcp',
        mcpServer: 'filesystem',
      });

      expect(prisma.mcpServer.findFirst).toHaveBeenCalledWith({
        where: { OR: [{ id: 'filesystem' }, { name: 'filesystem' }] },
        select: { id: true },
      });
      expect(prisma.tool.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          source: 'mcp',
          execution: 'mcp',
          mcpServer: 'filesystem',
        }),
      });
    });

    it('execution=mcp 但 mcpServer 未注册 → 400 TOOL_MCP_SERVER_NOT_FOUND（弱关联防断链）', async () => {
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.mcpServer.findFirst.mockResolvedValue(null);

      await expect(
        service.create({
          ...dto,
          execution: 'mcp',
          mcpServer: 'npx',
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create({
          ...dto,
          execution: 'mcp',
          mcpServer: 'npx',
        }),
      ).rejects.toMatchObject({
        response: { code: TOOL_ERRORS.TOOL_MCP_SERVER_NOT_FOUND },
      });
      expect(prisma.tool.create).not.toHaveBeenCalled();
      expect(workersService.broadcastCommand).not.toHaveBeenCalled();
    });

    it('execution=mcp 且 mcpServer 以 id 命中 → 校验通过（name/id 双键兼容）', async () => {
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.mcpServer.findFirst.mockResolvedValue({ id: 'ms_0000000001' });
      prisma.tool.create.mockResolvedValue({ id: 'tl_0000000003' });

      await service.create({
        ...dto,
        execution: 'mcp',
        mcpServer: 'ms_0000000001',
      });

      expect(prisma.mcpServer.findFirst).toHaveBeenCalledWith({
        where: { OR: [{ id: 'ms_0000000001' }, { name: 'ms_0000000001' }] },
        select: { id: true },
      });
    });

    it('execution=cli/http → source 均推导 custom（builtin 走 seed 不入库）', async () => {
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.tool.create.mockResolvedValue({ id: 'tl_0000000003' });

      await service.create({ ...dto, execution: 'cli' });
      await service.create({ ...dto, action: 'http-api', execution: 'http' });

      expect(prisma.tool.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ source: 'custom' }),
        }),
      );
      expect(prisma.tool.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ source: 'custom' }),
        }),
      );
    });

    it('action 已存在 → 409 TOOL_ACTION_EXISTS', async () => {
      prisma.tool.findUnique.mockResolvedValue({ id: 'tl_0000000001' });

      await expect(
        service.create({ ...dto, action: 'jira-query' }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.create({ ...dto, action: 'jira-query' }),
      ).rejects.toMatchObject({
        response: { code: TOOL_ERRORS.TOOL_ACTION_EXISTS },
      });
      expect(prisma.tool.create).not.toHaveBeenCalled();
    });
  });

  describe('update（PATCH /tools/:id，收敛为 schema/initCommand/enabled）', () => {
    it('只改 enabled 停用工具', async () => {
      prisma.tool.findUnique.mockResolvedValue(toolRows[0]);
      prisma.tool.update.mockResolvedValue({ ...toolRows[0], enabled: false });

      const dto: UpdateToolDto = { enabled: false };
      const result = await service.update('tl_0000000001', dto);

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 'tl_0000000001' },
        data: { enabled: false },
      });
      expect(result).toMatchObject({ enabled: false });
    });

    it('F1 MAJOR：PATCH 成功同样广播 reload-config', async () => {
      prisma.tool.findUnique.mockResolvedValue(toolRows[0]);
      prisma.tool.update.mockResolvedValue({ ...toolRows[0], enabled: false });

      await service.update('tl_0000000001', { enabled: false });

      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('更新 schema + initCommand 透传 Json', async () => {
      prisma.tool.findUnique.mockResolvedValue(toolRows[0]);
      prisma.tool.update.mockResolvedValue({
        ...toolRows[0],
        schema: { type: 'string' },
      });

      const dto: UpdateToolDto = {
        schema: { type: 'string' },
        initCommand: [{ script: 'jcli login' }],
      };
      await service.update('tl_0000000001', dto);

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 'tl_0000000001' },
        data: {
          schema: { type: 'string' },
          initCommand: [{ script: 'jcli login' }],
        },
      });
    });

    it('工具不存在 → 404 TOOL_NOT_FOUND', async () => {
      prisma.tool.findUnique.mockResolvedValue(null);

      await expect(
        service.update('tl_nonexistent', { enabled: false }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.update('tl_nonexistent', { enabled: false }),
      ).rejects.toMatchObject({
        response: { code: TOOL_ERRORS.TOOL_NOT_FOUND },
      });
      expect(prisma.tool.update).not.toHaveBeenCalled();
    });
  });
});
