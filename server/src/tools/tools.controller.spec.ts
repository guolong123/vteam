import { Test, TestingModule } from '@nestjs/testing';
import { AdminGuard } from '../users/admin.guard';
import { WorkerOrJwtGuard } from '../workers/worker-or-jwt.guard';
import { CreateToolDto } from './dto/create-tool.dto';
import { QueryToolsDto } from './dto/query-tools.dto';
import { UpdateToolDto } from './dto/update-tool.dto';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';

describe('ToolsController', () => {
  let controller: ToolsController;
  let service: {
    findAll: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ToolsController],
      providers: [{ provide: ToolsService, useValue: service }],
    })
      // @UseGuards(AdminGuard) 在模块 compile 时即被 Nest 实例化（非请求期）→ 必须 override
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(WorkerOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ToolsController>(ToolsController);
  });

  it('GET /tools 透传查询参数 + viewer（request.user）', async () => {
    const items = [
      {
        id: 'tl_0000000001',
        name: 'Jira 查询',
        action: 'jira-query',
        source: 'custom',
        execution: 'cli',
        mcpServer: null,
        schema: null,
        initCommand: null,
        enabled: true,
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

    const query: QueryToolsDto = {
      source: 'custom',
      execution: 'cli',
      enabled: true,
      page: 1,
      pageSize: 20,
    };
    const req = { user: { id: 'u_1', username: 'admin' } } as never;
    const result = await controller.findAll(query, req);

    expect(service.findAll).toHaveBeenCalledWith(query, { id: 'u_1' });
    expect(result).toMatchObject({ items, total: 1, page: 1, pageSize: 20 });
  });

  it('GET /tools 无 user 时不传 viewer（undefined）', async () => {
    service.findAll.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });

    await controller.findAll({}, { user: undefined } as never);

    expect(service.findAll).toHaveBeenCalledWith({}, undefined);
  });

  it('POST /tools 转发 create（无 source 入参，execution=mcp 时 service 推导）', async () => {
    const dto: CreateToolDto = {
      name: 'Jira 查询',
      action: 'jira-query',
      execution: 'cli',
    };
    service.create.mockResolvedValue({
      id: 'tl_0000000001',
      action: 'jira-query',
      source: 'custom',
      enabled: true,
    });

    const result = await controller.create(dto);

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result).toMatchObject({ id: 'tl_0000000001', source: 'custom' });
  });

  it('PATCH /tools/:id 转发 update（收敛 dto：仅 schema/initCommand/enabled）', async () => {
    const dto: UpdateToolDto = { enabled: false };
    service.update.mockResolvedValue({
      id: 'tl_0000000001',
      enabled: false,
    });

    const result = await controller.update('tl_0000000001', dto);

    expect(service.update).toHaveBeenCalledWith('tl_0000000001', dto);
    expect(result).toMatchObject({ enabled: false });
  });
});
