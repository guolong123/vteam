import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MCP_SERVER_ERRORS } from '../common/constants/mcp-server.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkersService } from '../workers/workers.service';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { McpServersService } from './mcp-servers.service';

describe('McpServersService', () => {
  let service: McpServersService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let workersService: { broadcastCommand: jest.Mock };
  let prisma: {
    mcpServer: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const localRow = {
    id: 'ms_0000000001',
    name: 'gitee-ent',
    type: 'local',
    command: { command: ['npx', '-y', '@gitee/mcp-gitee-ent@latest'] },
    url: null,
    headers: null,
    oauth: null,
    enabled: true,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
  };

  const remoteRow = {
    id: 'ms_0000000002',
    name: 'swagger',
    type: 'remote',
    command: null,
    url: 'https://keta-mcp.ketaops.cc/swagger',
    headers: { Authorization: 'Bearer xxx' },
    oauth: null,
    enabled: true,
    createdAt: new Date('2026-08-08T00:00:01Z'),
    updatedAt: new Date('2026-08-08T00:00:01Z'),
  };

  beforeEach(async () => {
    idGen = {
      nextId: jest.fn().mockResolvedValue('ms_0000000003'),
      seed: jest.fn(),
    };
    prisma = {
      mcpServer: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    workersService = { broadcastCommand: jest.fn().mockResolvedValue(1) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpServersService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: WorkersService, useValue: workersService },
      ],
    }).compile();

    service = module.get<McpServersService>(McpServersService);
  });

  describe('onModuleInit（重启续号）', () => {
    it('库内已有最大 id 时对齐 ms 前缀序号', async () => {
      prisma.mcpServer.findFirst.mockResolvedValue({ id: 'ms_0000000042' });

      await service.onModuleInit();

      expect(prisma.mcpServer.findFirst).toHaveBeenCalledWith({
        orderBy: { id: 'desc' },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('ms', 42);
    });

    it('空库/无记录时跳过续号', async () => {
      prisma.mcpServer.findFirst.mockResolvedValue(null);

      await service.onModuleInit();

      expect(idGen.seed).not.toHaveBeenCalled();
    });
  });

  describe('findAll（列表：过滤 + 分页）', () => {
    it('无参返回全部服务器 + 缺省分页 {items, total, page, pageSize}', async () => {
      prisma.$transaction.mockResolvedValue([2, [localRow, remoteRow]]);

      const result = await service.findAll();

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: 'ms_0000000001',
        name: 'gitee-ent',
        type: 'local',
        enabled: true,
      });
    });

    it('type/enabled 过滤 + name 搜索 + 自定义分页', async () => {
      prisma.$transaction.mockResolvedValue([1, [remoteRow]]);

      await service.findAll({
        type: 'remote',
        enabled: true,
        name: 'swagger',
        page: 2,
        pageSize: 10,
      });

      expect(prisma.mcpServer.count).toHaveBeenCalledWith({
        where: {
          type: { equals: 'remote' },
          enabled: true,
          name: { contains: 'swagger' },
        },
      });
      expect(prisma.mcpServer.findMany).toHaveBeenCalledWith({
        where: {
          type: { equals: 'remote' },
          enabled: true,
          name: { contains: 'swagger' },
        },
        orderBy: { createdAt: 'asc' },
        skip: 10,
        take: 10,
      });
    });

    it('enabled=false 过滤停用服务器（不误伤 true）', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ enabled: false });

      expect(prisma.mcpServer.count).toHaveBeenCalledWith({
        where: { type: undefined, enabled: false, name: undefined },
      });
    });

    it('pageSize 超上限 100 时收敛为 100', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      await service.findAll({ pageSize: 999 });

      expect(prisma.mcpServer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 }),
      );
    });
  });

  describe('T8c：applyHeartbeatStatus（worker 心跳上报三态 → 内存存储）', () => {
    it('写入后 findAll 按 serverName 合并 status（未上报服务器为 null）', async () => {
      service.applyHeartbeatStatus([
        { serverName: 'gitee-ent', status: 'connected' },
        { serverName: 'test-bad-local', status: 'failed' },
      ]);
      prisma.$transaction.mockResolvedValue([2, [localRow, remoteRow]]);

      const result = await service.findAll();

      expect(result.items[0]).toMatchObject({ name: 'gitee-ent', status: 'connected' });
      expect(result.items[1]).toMatchObject({ name: 'swagger', status: null });
    });

    it('needs_auth 三态透传 + findOne 合并 status', async () => {
      service.applyHeartbeatStatus([{ serverName: 'github-remote', status: 'needs_auth' }]);
      prisma.mcpServer.findUnique.mockResolvedValue({
        ...remoteRow,
        id: 'ms_0000000003',
        name: 'github-remote',
        url: 'https://github-mcp.example.com',
      });

      const result = await service.findOne('ms_0000000003');

      expect(result).toMatchObject({ name: 'github-remote', status: 'needs_auth' });
    });

    it('同名重复上报 last-update-wins 覆盖', async () => {
      service.applyHeartbeatStatus([{ serverName: 'gitee-ent', status: 'connected' }]);
      service.applyHeartbeatStatus([{ serverName: 'gitee-ent', status: 'needs_auth' }]);
      prisma.$transaction.mockResolvedValue([1, [localRow]]);

      const result = await service.findAll();

      expect(result.items[0]).toMatchObject({ name: 'gitee-ent', status: 'needs_auth' });
    });

    it('空数组/非法条目不写入（幂等）', async () => {
      service.applyHeartbeatStatus([]);
      service.applyHeartbeatStatus([{ serverName: '', status: 'connected' }]);
      prisma.$transaction.mockResolvedValue([1, [localRow]]);

      const result = await service.findAll();

      expect(result.items[0]).toMatchObject({ name: 'gitee-ent', status: null });
    });
  });

  describe('findOne（GET /mcp-servers/:id）', () => {
    it('存在时返回详情', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);

      const result = await service.findOne('ms_0000000001');

      expect(prisma.mcpServer.findUnique).toHaveBeenCalledWith({
        where: { id: 'ms_0000000001' },
      });
      expect(result).toMatchObject({ id: 'ms_0000000001' });
    });

    it('不存在 → 404 MCP_SERVER_NOT_FOUND', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);

      await expect(service.findOne('ms_nonexistent')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne('ms_nonexistent')).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_NOT_FOUND },
      });
    });
  });

  describe('create（POST /mcp-servers）', () => {
    it('local 类型：name trim + command 透传 Json + enabled 默认 true', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);
      prisma.mcpServer.create.mockResolvedValue({
        ...localRow,
        id: 'ms_0000000003',
        name: 'gitee-ent',
      });

      const dto: CreateMcpServerDto = {
        name: '  gitee-ent ',
        type: 'local',
        command: { command: ['npx', '-y', '@gitee/mcp-gitee-ent@latest'] },
      };
      const result = await service.create(dto);

      expect(prisma.mcpServer.findUnique).toHaveBeenCalledWith({
        where: { name: 'gitee-ent' },
        select: { id: true },
      });
      expect(prisma.mcpServer.create).toHaveBeenCalledWith({
        data: {
          id: 'ms_0000000003',
          name: 'gitee-ent',
          type: 'local',
          command: { command: ['npx', '-y', '@gitee/mcp-gitee-ent@latest'] },
          url: null,
          headers: undefined,
          oauth: undefined,
          enabled: true,
        },
      });
      expect(result).toMatchObject({ id: 'ms_0000000003' });
    });

    it('F1 MAJOR：create 落库成功后广播 reload-config 到在线 worker', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);
      prisma.mcpServer.create.mockResolvedValue(localRow);

      const dto: CreateMcpServerDto = {
        name: 'gitee-ent',
        type: 'local',
        command: { command: ['npx'] },
      };
      await service.create(dto);

      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('remote 类型：url + headers/oauth 透传 Json', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);
      prisma.mcpServer.create.mockResolvedValue(remoteRow);

      const dto: CreateMcpServerDto = {
        name: 'swagger',
        type: 'remote',
        url: 'https://keta-mcp.ketaops.cc/swagger',
        headers: { Authorization: 'Bearer xxx' },
        oauth: false,
      };
      const result = await service.create(dto);

      expect(prisma.mcpServer.create).toHaveBeenCalledWith({
        data: {
          id: 'ms_0000000003',
          name: 'swagger',
          type: 'remote',
          command: undefined,
          url: 'https://keta-mcp.ketaops.cc/swagger',
          headers: { Authorization: 'Bearer xxx' },
          oauth: false,
          enabled: true,
        },
      });
      expect(result).toMatchObject({ type: 'remote' });
    });

    it('name 已存在 → 409 MCP_SERVER_NAME_EXISTS（不触发 create）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue({ id: 'ms_0000000001' });

      await expect(
        service.create({
          name: 'gitee-ent',
          type: 'local',
          command: { command: ['npx'] },
        }),
      ).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_NAME_EXISTS },
      });
      expect(prisma.mcpServer.create).not.toHaveBeenCalled();
    });

    it('local 缺 command / command 为空数组 → 400 MCP_SERVER_INVALID_CONFIG', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ name: 'x', type: 'local' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create({ name: 'x', type: 'local', command: { command: [] } }),
      ).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_INVALID_CONFIG },
      });
      await expect(
        service.create({
          name: 'x',
          type: 'local',
          command: { command: [42] },
        }),
      ).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_INVALID_CONFIG },
      });
      expect(prisma.mcpServer.create).not.toHaveBeenCalled();
    });

    it('remote 缺 url / 非 http(s) url → 400 MCP_SERVER_INVALID_CONFIG', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ name: 'x', type: 'remote' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.create({ name: 'x', type: 'remote', url: 'ftp://nope' }),
      ).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_INVALID_CONFIG },
      });
      expect(prisma.mcpServer.create).not.toHaveBeenCalled();
    });
  });

  describe('update（PATCH /mcp-servers/:id）', () => {
    it('部分更新：只改 enabled 停用服务器', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);
      prisma.mcpServer.update.mockResolvedValue({ ...localRow, enabled: false });

      const dto: UpdateMcpServerDto = { enabled: false };
      const result = await service.update('ms_0000000001', dto);

      expect(prisma.mcpServer.update).toHaveBeenCalledWith({
        where: { id: 'ms_0000000001' },
        data: { enabled: false },
      });
      expect(result).toMatchObject({ enabled: false });
    });

    it('F1 MAJOR：PATCH 成功同样广播 reload-config', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);
      prisma.mcpServer.update.mockResolvedValue({ ...localRow, enabled: false });

      await service.update('ms_0000000001', { enabled: false });

      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('改 name 撞其他服务器 → 409 MCP_SERVER_NAME_EXISTS（不触发 update）', async () => {
      prisma.mcpServer.findUnique
        .mockResolvedValueOnce(localRow) // 存在性
        .mockResolvedValueOnce({ id: 'ms_0000000002' }); // name 冲突
      prisma.mcpServer.update.mockResolvedValue(localRow);

      await expect(
        service.update('ms_0000000001', { name: 'swagger' }),
      ).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_NAME_EXISTS },
      });
      expect(prisma.mcpServer.update).not.toHaveBeenCalled();
    });

    it('改 name 为自身当前值不触发冲突（同 id 放行）', async () => {
      prisma.mcpServer.findUnique
        .mockResolvedValueOnce(localRow) // 存在性
        .mockResolvedValueOnce({ id: 'ms_0000000001' }); // 命中自身
      prisma.mcpServer.update.mockResolvedValue(localRow);

      const result = await service.update('ms_0000000001', {
        name: 'gitee-ent',
      });

      expect(prisma.mcpServer.update).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('remote 改 url 为非法地址 → 400 MCP_SERVER_INVALID_CONFIG', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(remoteRow);

      await expect(
        service.update('ms_0000000002', { url: 'not-a-url' }),
      ).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_INVALID_CONFIG },
      });
      expect(prisma.mcpServer.update).not.toHaveBeenCalled();
    });

    it('local 改 type 为 remote 但缺 url → 400（按合并后配置校验）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);

      await expect(
        service.update('ms_0000000001', { type: 'remote' }),
      ).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_INVALID_CONFIG },
      });
      expect(prisma.mcpServer.update).not.toHaveBeenCalled();
    });

    it('服务器不存在 → 404 MCP_SERVER_NOT_FOUND', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);

      await expect(
        service.update('ms_nonexistent', { name: 'x' }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.update('ms_nonexistent', { name: 'x' }),
      ).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_NOT_FOUND },
      });
    });
  });

  describe('remove（DELETE /mcp-servers/:id）', () => {
    it('服务器存在时物理删除', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);
      prisma.mcpServer.delete.mockResolvedValue(localRow);

      await service.remove('ms_0000000001');

      expect(prisma.mcpServer.delete).toHaveBeenCalledWith({
        where: { id: 'ms_0000000001' },
      });
    });

    it('F1 MAJOR：DELETE 成功后同样广播 reload-config', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);
      prisma.mcpServer.delete.mockResolvedValue(localRow);

      await service.remove('ms_0000000001');

      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('服务器不存在 → 404 MCP_SERVER_NOT_FOUND', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);

      await expect(service.remove('ms_nonexistent')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove('ms_nonexistent')).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_NOT_FOUND },
      });
      expect(prisma.mcpServer.delete).not.toHaveBeenCalled();
    });
  });
});
