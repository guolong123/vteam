import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { HeartbeatWorkerDto } from './dto/heartbeat-worker.dto';
import { RegisterWorkerDto } from './dto/register-worker.dto';
import { UpdateWorkerModelDto } from './dto/update-worker-model.dto';
import { WorkerTokenRequest } from './worker-token.guard';
import { WorkersController } from './workers.controller';
import { WorkersService } from './workers.service';

describe('WorkersController', () => {
  let controller: WorkersController;
  let service: {
    register: jest.Mock;
    heartbeat: jest.Mock;
    findAll: jest.Mock;
    findOne: jest.Mock;
    updateDefaultModel: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      register: jest.fn(),
      heartbeat: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      updateDefaultModel: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorkersController],
      providers: [
        { provide: WorkersService, useValue: service },
        // 控制器方法级 @UseGuards(WorkerTokenGuard) 会在 compile 时实例化 guard
        { provide: ConfigService, useValue: { get: jest.fn() } },
        // 方法级 @UseGuards(PermissionGuard) 依赖 PrismaService + Reflector（compile 时实例化 guard）
        { provide: PrismaService, useValue: { user: { findUnique: jest.fn() } } },
      ],
    }).compile();

    controller = module.get<WorkersController>(WorkersController);
  });

  it('POST /workers/register 以 guard 挂载的 workerToken 转发 register', async () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000001';
    dto.opencodeVersion = '1.18.14';
    dto.capabilities = { maxInstances: 2, skills: [], tools: [] };
    dto.load = { instances: 0 };
    service.register.mockResolvedValue({
      workerId: 'w_0000000001',
      heartbeatIntervalMs: 10000,
      serverTime: '2026-08-08T00:00:00.000Z',
    });

    const req = { workerToken: 'secret-token' } as WorkerTokenRequest;
    const result = await controller.register(req, dto);

    expect(service.register).toHaveBeenCalledWith('secret-token', dto);
    expect(result).toMatchObject({ workerId: 'w_0000000001' });
  });

  it('POST /workers/:id/heartbeat 转发 heartbeat', async () => {
    const dto: HeartbeatWorkerDto = {
      workerId: 'w_0000000001',
      load: { instances: 1 },
      health: 'ok',
    };
    service.heartbeat.mockResolvedValue({
      workerId: 'w_0000000001',
      status: 'online',
    });

    // F2 M2：controller 3 参数签名（id, req, dto），req.workerToken 由 guard 挂载后转发 service
    const req = { workerToken: 'secret-token' } as WorkerTokenRequest;
    const result = await controller.heartbeat('w_0000000001', req, dto);

    expect(service.heartbeat).toHaveBeenCalledWith('w_0000000001', dto, 'secret-token');
    expect(result).toMatchObject({ status: 'online' });
  });

  it('GET /workers 转发 findAll 返回列表', async () => {
    const rows = [{ id: 'w_0000000001', status: 'online' }];
    service.findAll.mockResolvedValue(rows);

    expect(await controller.findAll()).toBe(rows);
  });

  it('GET /workers/:id 转发 findOne 返回详情', async () => {
    const detail = { id: 'w_0000000001', status: 'online' };
    service.findOne.mockResolvedValue(detail);

    expect(await controller.findOne('w_0000000001')).toBe(detail);
    expect(service.findOne).toHaveBeenCalledWith('w_0000000001');
  });

  it('C8：PATCH /workers/:id 转发 updateDefaultModel（DTO 透传，workers.edit 保护）', async () => {
    const dto: UpdateWorkerModelDto = { defaultModelId: 'opencode-go/deepseek-v4-flash' };
    const view = {
      id: 'w_0000000001',
      status: 'online',
      defaultModelId: 'opencode-go/deepseek-v4-flash',
    };
    service.updateDefaultModel.mockResolvedValue(view);

    const result = await controller.updateDefaultModel('w_0000000001', dto);

    expect(service.updateDefaultModel).toHaveBeenCalledWith('w_0000000001', dto);
    expect(result).toEqual(view);
  });

  it('C8：PATCH /workers/:id 支持 null（清除默认模型）', async () => {
    const dto: UpdateWorkerModelDto = { defaultModelId: null };
    service.updateDefaultModel.mockResolvedValue({ id: 'w_0000000001', defaultModelId: null });

    await controller.updateDefaultModel('w_0000000001', dto);

    expect(service.updateDefaultModel).toHaveBeenCalledWith('w_0000000001', { defaultModelId: null });
  });
});
