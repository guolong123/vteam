import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { CreateMcpServerDto } from './dto/create-mcp-server.dto';
import { QueryMcpServersDto } from './dto/query-mcp-servers.dto';
import { UpdateMcpServerDto } from './dto/update-mcp-server.dto';
import { McpServersController } from './mcp-servers.controller';
import { McpServersService } from './mcp-servers.service';

describe('McpServersController', () => {
  let controller: McpServersController;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    syncTools: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      syncTools: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpServersController],
      providers: [
        { provide: McpServersService, useValue: service },
        // 控制器方法级 @UseGuards(AdminGuard) 会在 compile 时实例化 guard，
        // AdminGuard 依赖全局 PrismaService，提供 mock 占位
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn() } },
        },
      ],
    })
      .overrideGuard(WorkerOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<McpServersController>(McpServersController);
  });

  it('GET /mcp-servers 透传查询参数（{items, total, page, pageSize}）', async () => {
    const items = [
      {
        id: 'ms_0000000001',
        name: 'gitee-ent',
        type: 'local',
        command: { command: ['npx', '-y', '@gitee/mcp-gitee-ent@latest'] },
        url: null,
        headers: null,
        oauth: null,
        enabled: true,
        toolCount: 3,
        createdAt: new Date('2026-08-08T00:00:00Z'),
        updatedAt: new Date('2026-08-08T00:00:00Z'),
      },
    ];
    service.findAll.mockResolvedValue({
      items,
      total: 1,
      page: 1,
      pageSize: 20,
    });

    const query: QueryMcpServersDto = {
      type: 'local',
      enabled: true,
      page: 1,
      pageSize: 20,
    };
    const result = await controller.findAll(query, { headers: {} } as never);

    expect(service.findAll).toHaveBeenCalledWith(query, undefined);
    expect(result).toMatchObject({ items, total: 1, page: 1, pageSize: 20 });
    expect(result.items[0]).toMatchObject({ toolCount: 3 });
  });

  it('GET /mcp-servers/:id 转发 findOne', async () => {
    service.findOne.mockResolvedValue({
      id: 'ms_0000000001',
      name: 'gitee-ent',
      type: 'local',
      toolCount: 3,
    });

    const result = await controller.findOne('ms_0000000001');

    expect(service.findOne).toHaveBeenCalledWith('ms_0000000001');
    expect(result).toMatchObject({ id: 'ms_0000000001', toolCount: 3 });
  });

  it('POST /mcp-servers 转发 create', async () => {
    const dto: CreateMcpServerDto = {
      name: 'gitee-ent',
      type: 'local',
      command: { command: ['npx', '-y', '@gitee/mcp-gitee-ent@latest'] },
    };
    service.create.mockResolvedValue({
      id: 'ms_0000000001',
      name: 'gitee-ent',
      type: 'local',
      enabled: true,
    });

    const result = await controller.create(dto);

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result).toMatchObject({ id: 'ms_0000000001' });
  });

  it('PATCH /mcp-servers/:id 转发 update', async () => {
    const dto: UpdateMcpServerDto = { enabled: false };
    service.update.mockResolvedValue({
      id: 'ms_0000000001',
      enabled: false,
    });

    const result = await controller.update('ms_0000000001', dto);

    expect(service.update).toHaveBeenCalledWith('ms_0000000001', dto);
    expect(result).toMatchObject({ enabled: false });
  });

  it('DELETE /mcp-servers/:id 转发 remove', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove('ms_0000000001');

    expect(service.remove).toHaveBeenCalledWith('ms_0000000001');
  });

  it('POST /mcp-servers/:id/sync 转发 syncTools', async () => {
    service.syncTools.mockResolvedValue({
      server: { id: 'ms_0000000001', name: 'ketacli', type: 'remote' },
      discovered: 1,
      created: 1,
      updated: 0,
      disabled: 0,
      skipped: [],
      tools: [
        {
          id: 'tl_0000000042',
          name: 'ketacli_aliases.list',
          action: 'aliases.list',
        },
      ],
    });

    const result = await controller.syncTools('ms_0000000001');

    expect(service.syncTools).toHaveBeenCalledWith('ms_0000000001');
    expect(result).toMatchObject({ discovered: 1, created: 1 });
  });
});
