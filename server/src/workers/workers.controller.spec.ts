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
    setDefaultWorker: jest.Mock;
    requestRestart: jest.Mock;
    requestShutdown: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      register: jest.fn(),
      heartbeat: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      updateDefaultModel: jest.fn(),
      setDefaultWorker: jest.fn(),
      requestRestart: jest.fn(),
      requestShutdown: jest.fn(),
      remove: jest.fn(),
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

    const result = await controller.update('w_0000000001', dto);

    expect(service.updateDefaultModel).toHaveBeenCalledWith('w_0000000001', dto);
    expect(service.setDefaultWorker).not.toHaveBeenCalled();
    expect(result).toEqual(view);
  });

  it('C8：PATCH /workers/:id 支持 null（清除默认模型）', async () => {
    const dto: UpdateWorkerModelDto = { defaultModelId: null };
    service.updateDefaultModel.mockResolvedValue({ id: 'w_0000000001', defaultModelId: null });

    await controller.update('w_0000000001', dto);

    expect(service.updateDefaultModel).toHaveBeenCalledWith('w_0000000001', { defaultModelId: null });
    expect(service.setDefaultWorker).not.toHaveBeenCalled();
  });

  it('默认 worker：PATCH /workers/:id 传 isDefault → 转发 setDefaultWorker', async () => {
    const dto: UpdateWorkerModelDto = { isDefault: true };
    const view = { id: 'w_0000000001', isDefault: true };
    service.updateDefaultModel.mockResolvedValue({
      id: 'w_0000000001',
      defaultModelId: null,
    });
    service.setDefaultWorker.mockResolvedValue(view);

    const result = await controller.update('w_0000000001', dto);

    expect(service.updateDefaultModel).toHaveBeenCalledWith('w_0000000001', dto);
    expect(service.setDefaultWorker).toHaveBeenCalledWith('w_0000000001', true);
    expect(result).toEqual(view);
  });

  it('UX-01：POST /workers/:id/restart 转发 requestRestart（workers.edit 保护）', async () => {
    service.requestRestart.mockResolvedValue({
      workerId: 'w_0000000001',
      command: 'restart',
      queued: true,
    });

    const result = await controller.requestRestart('w_0000000001');

    expect(service.requestRestart).toHaveBeenCalledWith('w_0000000001');
    expect(result).toMatchObject({ workerId: 'w_0000000001', command: 'restart' });
  });

  it('UX-01：POST /workers/:id/shutdown 转发 requestShutdown（workers.edit 保护）', async () => {
    service.requestShutdown.mockResolvedValue({
      workerId: 'w_0000000001',
      command: 'shutdown',
      queued: true,
      status: 'offline',
    });

    const result = await controller.requestShutdown('w_0000000001');

    expect(service.requestShutdown).toHaveBeenCalledWith('w_0000000001');
    expect(result).toMatchObject({ workerId: 'w_0000000001', status: 'offline' });
  });

  it('DELETE /workers/:id 转发 remove（workers.delete 保护）', async () => {
    service.remove.mockResolvedValue({ id: 'w_0000000001', deleted: true });

    const result = await controller.remove('w_0000000001');

    expect(service.remove).toHaveBeenCalledWith('w_0000000001');
    expect(result).toEqual({ id: 'w_0000000001', deleted: true });
  });
});
