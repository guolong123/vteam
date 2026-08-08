import { Test, TestingModule } from '@nestjs/testing';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { CloneAgentDto } from './dto/clone-agent.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { QueryAgentsDto } from './dto/query-agents.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

describe('AgentsController', () => {
  let controller: AgentsController;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    clone: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    getAvailableModels: jest.Mock;
  };

  const user = { id: 'u_admin', username: 'admin', roleId: 'r_admin' };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      clone: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      getAvailableModels: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [{ provide: AgentsService, useValue: service }],
    }).compile();

    controller = module.get<AgentsController>(AgentsController);
  });

  it('GET /agents 透传查询参数（{items, total, page, pageSize}）', async () => {
    const items = [
      {
        id: 'a_product',
        name: '产品经理',
        role: 'product',
        type: 'template',
        prompt: 'p',
        baseAgentId: null,
        defaultModelId: null,
        permissionScope: null,
        skillIds: [],
        toolEffects: [],
      },
    ];
    service.findAll.mockResolvedValue({ items, total: 1, page: 1, pageSize: 20 });

    const query: QueryAgentsDto = { type: 'template', page: 1, pageSize: 20 };
    const result = await controller.findAll(query);

    expect(service.findAll).toHaveBeenCalledWith(query);
    expect(result).toMatchObject({ items, total: 1, page: 1, pageSize: 20 });
  });

  it('GET /agents/:id 转发 findOne 返回详情', async () => {
    const detail = { id: 'a_product', name: '产品经理' };
    service.findOne.mockResolvedValue(detail);

    const result = await controller.findOne('a_product');

    expect(service.findOne).toHaveBeenCalledWith('a_product');
    expect(result).toMatchObject(detail);
  });

  it('POST /agents 以 req.user.id 转发 create', async () => {
    const dto: CreateAgentDto = { name: '数据分析师', type: 'custom' };
    service.create.mockResolvedValue({ id: 'a_0000000005', name: '数据分析师' });

    const result = await controller.create(user as never, dto);

    expect(service.create).toHaveBeenCalledWith('u_admin', dto);
    expect(result).toMatchObject({ id: 'a_0000000005' });
  });

  it('POST /agents/:id/clone 以 req.user.id 转发 clone', async () => {
    const dto: CloneAgentDto = { name: '副本' };
    service.clone.mockResolvedValue({
      id: 'a_0000000005',
      name: '副本',
      type: 'clone',
      baseAgentId: 'a_product',
    });

    const result = await controller.clone(user as never, 'a_product', dto);

    expect(service.clone).toHaveBeenCalledWith('u_admin', 'a_product', dto);
    expect(result).toMatchObject({ type: 'clone', baseAgentId: 'a_product' });
  });

  it('PATCH /agents/:id 转发 update', async () => {
    const dto: UpdateAgentDto = { prompt: 'new' };
    service.update.mockResolvedValue({ id: 'a_0000000005', prompt: 'new' });

    const result = await controller.update('a_0000000005', dto);

    expect(service.update).toHaveBeenCalledWith('a_0000000005', dto);
    expect(result).toMatchObject({ prompt: 'new' });
  });

  it('DELETE /agents/:id 转发 remove', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove('a_0000000005');

    expect(service.remove).toHaveBeenCalledWith('a_0000000005');
  });

  it('GET /agents/:id/available-models 转发 getAvailableModels', async () => {
    service.getAvailableModels.mockResolvedValue([
      { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ]);

    const result = await controller.getAvailableModels('a_product');

    expect(service.getAvailableModels).toHaveBeenCalledWith('a_product');
    expect(result).toHaveLength(1);
  });
});
