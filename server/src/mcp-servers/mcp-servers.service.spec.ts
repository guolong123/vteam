import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
    tool: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
    worker: {
      findUnique: jest.Mock;
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
      tool: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      worker: {
        findUnique: jest.fn(),
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

  describe('onModuleInit（重启续号，忽略 ms_vteam 等命名 id）', () => {
    it('混入命名 id 时仍按数字序号续号（不被字典序更大的命名 id 干扰）', async () => {
      prisma.mcpServer.findMany.mockResolvedValue([
        { id: 'ms_vteam' },
        { id: 'ms_vteam_api' },
        { id: 'ms_0000000001' },
        { id: 'ms_0000000002' },
      ]);

      await service.onModuleInit();

      expect(prisma.mcpServer.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'ms_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('ms', 2);
    });

    it('空库/无记录时跳过续号', async () => {
      prisma.mcpServer.findMany.mockResolvedValue([]);

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

  describe('toolCount（findAll/findOne 聚合 Tool.mcpServer id/name 双键）', () => {
    const vteamRow = {
      id: 'ms_vteam',
      name: 'vteam',
      type: 'remote',
      command: null,
      url: 'http://platform-mcp:3000/mcp',
      headers: null,
      oauth: null,
      enabled: true,
      createdAt: new Date('2026-08-08T00:00:03Z'),
      updatedAt: new Date('2026-08-08T00:00:03Z'),
    };

    it('混合 id/name 绑定计数 + 未绑定忽略 + 零计数返回 0（单轮 findMany）', async () => {
      prisma.$transaction.mockResolvedValue([2, [localRow, remoteRow]]);
      prisma.tool.findMany.mockResolvedValue([
        { mcpServer: 'ms_0000000001' },
        { mcpServer: 'gitee-ent' },
        { mcpServer: 'gitee-ent' },
        { mcpServer: null },
        { mcpServer: 'other-server' },
      ]);

      const result = await service.findAll();

      expect(prisma.tool.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.tool.findMany).toHaveBeenCalledWith({
        where: {
          mcpServer: {
            in: expect.arrayContaining([
              'ms_0000000001',
              'gitee-ent',
              'ms_0000000002',
              'swagger',
            ]),
          },
        },
        select: { mcpServer: true },
      });
      expect(result.items[0]).toMatchObject({
        name: 'gitee-ent',
        toolCount: 3,
      });
      expect(result.items[1]).toMatchObject({
        name: 'swagger',
        toolCount: 0,
      });
    });

    it('无工具行 → toolCount 均为 0', async () => {
      prisma.$transaction.mockResolvedValue([2, [localRow, remoteRow]]);
      prisma.tool.findMany.mockResolvedValue([]);

      const result = await service.findAll();

      expect(result.items[0]).toMatchObject({ toolCount: 0 });
      expect(result.items[1]).toMatchObject({ toolCount: 0 });
    });

    it('空列表不查 Tool 表（零额外轮次）', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      const result = await service.findAll();

      expect(result.items).toEqual([]);
      expect(prisma.tool.findMany).not.toHaveBeenCalled();
    });

    it('workerId 覆盖 vteam url 时保留 toolCount', async () => {
      prisma.$transaction.mockResolvedValue([1, [vteamRow]]);
      prisma.tool.findMany.mockResolvedValue([{ mcpServer: 'vteam' }]);
      prisma.worker.findUnique.mockResolvedValue({
        capabilities: { mcpUrl: 'http://ext:9999/mcp' },
      });

      const result = await service.findAll({}, 'wk_0000000001');

      expect(result.items[0]).toMatchObject({
        name: 'vteam',
        url: 'http://ext:9999/mcp',
        toolCount: 1,
      });
    });

    it('findOne 返回 toolCount（id/name 双键合计，单轮查询）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);
      prisma.tool.findMany.mockResolvedValue([
        { mcpServer: 'gitee-ent' },
        { mcpServer: 'ms_0000000001' },
      ]);

      const result = await service.findOne('ms_0000000001');

      expect(prisma.tool.findMany).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ id: 'ms_0000000001', toolCount: 2 });
    });

    it('findOne 无工具行 → toolCount 为 0', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);
      prisma.tool.findMany.mockResolvedValue([]);

      const result = await service.findOne('ms_0000000001');

      expect(result).toMatchObject({ id: 'ms_0000000001', toolCount: 0 });
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

      expect(result.items[0]).toMatchObject({
        name: 'gitee-ent',
        status: 'connected',
      });
      expect(result.items[1]).toMatchObject({ name: 'swagger', status: null });
    });

    it('needs_auth 三态透传 + findOne 合并 status', async () => {
      service.applyHeartbeatStatus([
        { serverName: 'github-remote', status: 'needs_auth' },
      ]);
      prisma.mcpServer.findUnique.mockResolvedValue({
        ...remoteRow,
        id: 'ms_0000000003',
        name: 'github-remote',
        url: 'https://github-mcp.example.com',
      });

      const result = await service.findOne('ms_0000000003');

      expect(result).toMatchObject({
        name: 'github-remote',
        status: 'needs_auth',
      });
    });

    it('同名重复上报 last-update-wins 覆盖', async () => {
      service.applyHeartbeatStatus([
        { serverName: 'gitee-ent', status: 'connected' },
      ]);
      service.applyHeartbeatStatus([
        { serverName: 'gitee-ent', status: 'needs_auth' },
      ]);
      prisma.$transaction.mockResolvedValue([1, [localRow]]);

      const result = await service.findAll();

      expect(result.items[0]).toMatchObject({
        name: 'gitee-ent',
        status: 'needs_auth',
      });
    });

    it('空数组/非法条目不写入（幂等）', async () => {
      service.applyHeartbeatStatus([]);
      service.applyHeartbeatStatus([{ serverName: '', status: 'connected' }]);
      prisma.$transaction.mockResolvedValue([1, [localRow]]);

      const result = await service.findAll();

      expect(result.items[0]).toMatchObject({
        name: 'gitee-ent',
        status: null,
      });
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
      prisma.mcpServer.update.mockResolvedValue({
        ...localRow,
        enabled: false,
      });

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
      prisma.mcpServer.update.mockResolvedValue({
        ...localRow,
        enabled: false,
      });

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
    it('服务器存在时物理删除 + 级联删除其物化的工具行（id/name 双键）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(localRow);
      prisma.mcpServer.delete.mockResolvedValue(localRow);
      prisma.tool.deleteMany.mockResolvedValue({ count: 3 });

      await service.remove('ms_0000000001');

      expect(prisma.mcpServer.delete).toHaveBeenCalledWith({
        where: { id: 'ms_0000000001' },
      });
      expect(prisma.tool.deleteMany).toHaveBeenCalledWith({
        where: { mcpServer: { in: ['ms_0000000001', 'gitee-ent'] } },
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
      expect(prisma.tool.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('syncTools（POST /mcp-servers/:id/sync）', () => {
    const ketacliRow = {
      id: 'ms_0000000009',
      name: 'ketacli',
      type: 'remote',
      command: null,
      url: 'http://192.168.10.78:14010/mcp',
      headers: null,
      oauth: null,
      enabled: true,
      createdAt: new Date('2026-08-08T00:00:02Z'),
      updatedAt: new Date('2026-08-08T00:00:02Z'),
    };

    function mockDiscovery(tools: unknown[]) {
      return jest
        .spyOn(
          service as unknown as {
            discoverTools: () => Promise<unknown[]>;
          },
          'discoverTools',
        )
        .mockResolvedValue(tools);
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('id 未知 → 404 MCP_SERVER_NOT_FOUND（不触发发现）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(null);
      const spy = mockDiscovery([]);

      await expect(service.syncTools('ms_nonexistent')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.syncTools('ms_nonexistent')).rejects.toMatchObject({
        response: { code: MCP_SERVER_ERRORS.MCP_SERVER_NOT_FOUND },
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('连接/发现失败 → 400 MCP_SERVER_SYNC_FAILED（携带可读原因）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      jest
        .spyOn(
          service as unknown as {
            discoverTools: () => Promise<unknown[]>;
          },
          'discoverTools',
        )
        .mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(service.syncTools('ms_0000000009')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.syncTools('ms_0000000009')).rejects.toMatchObject({
        response: {
          code: MCP_SERVER_ERRORS.MCP_SERVER_SYNC_FAILED,
          message: expect.stringContaining('ECONNREFUSED'),
        },
      });
      expect(prisma.tool.create).not.toHaveBeenCalled();
    });

    it('服务端要求 OAuth → 400 MCP_SERVER_SYNC_FAILED（可读提示）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      jest
        .spyOn(
          service as unknown as {
            discoverTools: () => Promise<unknown[]>;
          },
          'discoverTools',
        )
        .mockRejectedValue(new Error('MCP 服务器 ketacli 要求 OAuth 认证'));

      await expect(service.syncTools('ms_0000000009')).rejects.toMatchObject({
        response: {
          code: MCP_SERVER_ERRORS.MCP_SERVER_SYNC_FAILED,
          message: expect.stringContaining('OAuth'),
        },
      });
    });

    it('新工具：创建行（tl_ 前缀/source+execution=mcp/mcpServer=server.name）+ 广播', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([
        {
          name: 'aliases.list',
          description: 'list aliases',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.tool.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('tl_0000000042');
      prisma.tool.create.mockResolvedValue({
        id: 'tl_0000000042',
        name: 'ketacli_aliases.list',
        action: 'aliases.list',
        source: 'mcp',
        execution: 'mcp',
        mcpServer: 'ketacli',
        schema: { type: 'object', properties: {} },
        enabled: true,
      });

      const result = await service.syncTools('ms_0000000009');

      expect(idGen.nextId).toHaveBeenCalledWith('tl');
      expect(prisma.tool.create).toHaveBeenCalledWith({
        data: {
          id: 'tl_0000000042',
          name: 'ketacli_aliases.list',
          action: 'aliases.list',
          source: 'mcp',
          execution: 'mcp',
          mcpServer: 'ketacli',
          description: 'list aliases',
          schema: { type: 'object', properties: {} },
          enabled: true,
        },
      });
      expect(result).toMatchObject({
        server: { id: 'ms_0000000009', name: 'ketacli', type: 'remote' },
        discovered: 1,
        created: 1,
        updated: 0,
        disabled: 0,
        skipped: [],
      });
      expect(result.tools).toEqual([
        {
          id: 'tl_0000000042',
          name: 'ketacli_aliases.list',
          action: 'aliases.list',
        },
      ]);
      expect(workersService.broadcastCommand).toHaveBeenCalledWith({
        type: 'reload-config',
        resourceVersion: expect.any(String),
      });
    });

    it('远端名大小写/非法字符清洗为合法 action（首字母小写，非法转 -）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([
        { name: 'Allocation.List', inputSchema: { type: 'object' } },
      ]);
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.tool.findMany.mockResolvedValue([
        {
          id: 'tl_0000000042',
          name: 'ketacli_allocation.list',
          action: 'allocation.list',
          mcpServer: 'ketacli',
          enabled: true,
        },
      ]);
      idGen.nextId.mockResolvedValue('tl_0000000043');
      prisma.tool.create.mockResolvedValue({
        id: 'tl_0000000043',
        name: 'ketacli_Allocation.List',
        action: 'allocation.list',
        enabled: true,
      });

      const result = await service.syncTools('ms_0000000009');

      expect(prisma.tool.findUnique).toHaveBeenCalledWith({
        where: { action: 'allocation.list' },
      });
      expect(result).toMatchObject({ created: 1 });
    });

    it('已存在且归属本服务器（name/id 均可）→ 更新 schema + enabled:true', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([
        { name: 'aliases.list', inputSchema: { type: 'object' } },
        { name: 'allocation.list', inputSchema: { type: 'object' } },
      ]);
      prisma.tool.findUnique
        .mockResolvedValueOnce({
          id: 'tl_0000000001',
          name: 'ketacli_aliases.list',
          action: 'aliases.list',
          mcpServer: 'ketacli',
          enabled: false,
        })
        .mockResolvedValueOnce({
          id: 'tl_0000000002',
          name: 'ketacli_allocation.list',
          action: 'allocation.list',
          mcpServer: 'ms_0000000009',
          enabled: true,
        });
      prisma.tool.findMany.mockResolvedValue([]);
      prisma.tool.update.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            name: `ketacli_row`,
            action: 'aliases.list',
          }),
      );

      const result = await service.syncTools('ms_0000000009');

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 'tl_0000000001' },
        data: { schema: { type: 'object' }, description: null, enabled: true },
      });
      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 'tl_0000000002' },
        data: { schema: { type: 'object' }, description: null, enabled: true },
      });
      expect(prisma.tool.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ created: 0, updated: 2, disabled: 0 });
      expect(workersService.broadcastCommand).toHaveBeenCalled();
    });

    it('resync 回填已有行 description（上游文案覆盖存量 NULL）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([
        {
          name: 'task_create',
          description: '在团队会话无任务时创建任务',
          inputSchema: { type: 'object' },
        },
      ]);
      prisma.tool.findUnique.mockResolvedValue({
        id: 'tl_0000000010',
        name: 'ketacli_task_create',
        action: 'task_create',
        mcpServer: 'ketacli',
        description: null,
        enabled: true,
      });
      prisma.tool.findMany.mockResolvedValue([]);
      prisma.tool.update.mockResolvedValue({
        id: 'tl_0000000010',
        name: 'ketacli_task_create',
        action: 'task_create',
      });

      const result = await service.syncTools('ms_0000000009');

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 'tl_0000000010' },
        data: {
          schema: { type: 'object' },
          description: '在团队会话无任务时创建任务',
          enabled: true,
        },
      });
      expect(prisma.tool.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ created: 0, updated: 1, disabled: 0 });
    });

    it('发现项缺 description/非字符串 → 落库 NULL（非空串、不污染）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([
        { name: 'nodesc.tool', inputSchema: { type: 'object' } },
        { name: 'baddesc.tool', description: 42, inputSchema: { type: 'object' } },
      ]);
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.tool.findMany.mockResolvedValue([]);
      idGen.nextId
        .mockResolvedValueOnce('tl_0000000060')
        .mockResolvedValueOnce('tl_0000000061');
      prisma.tool.create.mockImplementation(({ data }: { data: object }) =>
        Promise.resolve(data),
      );

      const result = await service.syncTools('ms_0000000009');

      expect(prisma.tool.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ description: null }),
        }),
      );
      expect(prisma.tool.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ description: null }),
        }),
      );
      expect(result).toMatchObject({ created: 2, updated: 0 });
    });

    it('action 被他服务器占用 → skipped（action 冲突，不覆盖）', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([{ name: 'chat_history', inputSchema: null }]);
      prisma.tool.findUnique.mockResolvedValue({
        id: 'tl_vteam_chat_history',
        name: 'vteam_chat_history',
        action: 'chat_history',
        mcpServer: 'vteam',
        enabled: true,
      });
      prisma.tool.findMany.mockResolvedValue([]);

      const result = await service.syncTools('ms_0000000009');

      expect(prisma.tool.create).not.toHaveBeenCalled();
      expect(prisma.tool.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        discovered: 1,
        created: 0,
        updated: 0,
        disabled: 0,
      });
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]).toMatchObject({ action: 'chat_history' });
      expect(result.skipped[0].reason).toContain('占用');
      expect(result.tools).toEqual([]);
      expect(workersService.broadcastCommand).not.toHaveBeenCalled();
    });

    it('非法工具名（置空/非法开头）→ skipped；单行落库失败不中断整批', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([
        { name: '!!!' },
        { name: '' },
        { name: 'fail.tool', inputSchema: { type: 'object' } },
        { name: 'ok.tool', inputSchema: { type: 'object' } },
      ]);
      prisma.tool.findUnique.mockResolvedValue(null);
      prisma.tool.findMany.mockResolvedValue([]);
      idGen.nextId.mockResolvedValue('tl_0000000050');
      prisma.tool.create.mockRejectedValueOnce(new Error('db down'));
      prisma.tool.create.mockResolvedValueOnce({
        id: 'tl_0000000050',
        name: 'ketacli_ok.tool',
        action: 'ok.tool',
        enabled: true,
      });

      const result = await service.syncTools('ms_0000000009');

      expect(result).toMatchObject({
        discovered: 4,
        created: 1,
        updated: 0,
        disabled: 0,
      });
      expect(result.skipped).toHaveLength(3);
      expect(result.skipped.map((s) => s.action)).toContain('!!!');
      expect(result.skipped.map((s) => s.action)).toContain('fail.tool');
      expect(result.tools).toEqual([
        { id: 'tl_0000000050', name: 'ketacli_ok.tool', action: 'ok.tool' },
      ]);
    });

    it('存量行 action 不在发现集合 → enabled=false（disabled++）；无变更不广播', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([{ name: 'aliases.list', inputSchema: null }]);
      prisma.tool.findUnique.mockResolvedValue({
        id: 'tl_0000000001',
        name: 'ketacli_aliases.list',
        action: 'aliases.list',
        mcpServer: 'ketacli',
        enabled: true,
      });
      prisma.tool.findMany.mockResolvedValue([
        {
          id: 'tl_0000000001',
          name: 'ketacli_aliases.list',
          action: 'aliases.list',
          mcpServer: 'ketacli',
          enabled: true,
        },
        {
          id: 'tl_0000000007',
          name: 'ketacli_old.tool',
          action: 'old.tool',
          mcpServer: 'ms_0000000009',
          enabled: true,
        },
        {
          id: 'tl_0000000008',
          name: 'ketacli_gone.tool',
          action: 'gone.tool',
          mcpServer: 'ketacli',
          enabled: false,
        },
      ]);
      prisma.tool.update.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve({ id: where.id, name: 'x', action: 'y' }),
      );

      const result = await service.syncTools('ms_0000000009');

      expect(prisma.tool.update).toHaveBeenCalledWith({
        where: { id: 'tl_0000000007' },
        data: { enabled: false },
      });
      expect(result).toMatchObject({ updated: 1, disabled: 1 });
      expect(workersService.broadcastCommand).toHaveBeenCalled();
    });

    it('空发现 + 无存量行 → 零变更且不广播', async () => {
      prisma.mcpServer.findUnique.mockResolvedValue(ketacliRow);
      mockDiscovery([]);
      prisma.tool.findMany.mockResolvedValue([]);
      workersService.broadcastCommand.mockClear();

      const result = await service.syncTools('ms_0000000009');

      expect(result).toMatchObject({
        discovered: 0,
        created: 0,
        updated: 0,
        disabled: 0,
        skipped: [],
        tools: [],
      });
      expect(workersService.broadcastCommand).not.toHaveBeenCalled();
    });
  });
});
