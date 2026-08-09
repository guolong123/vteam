import { PATH_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { SetModelCredentialDto } from './dto/set-model-credential.dto';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

describe('ModelsController（目录 CRUD + 凭据端点）', () => {
  let controller: ModelsController;
  let service: {
    findAll: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    listProviders: jest.Mock;
    setCredential: jest.Mock;
    getCredential: jest.Mock;
    revokeCredential: jest.Mock;
    revokeCredentialByProvider: jest.Mock;
  };

  const view = {
    id: 'mc_0000000001',
    providerID: 'opencode-go',
    configured: true,
    fingerprint: 'sk-a****89xz',
    revokedAt: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
  };

  const modelRow = {
    id: 'md_0000000001',
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    enabled: true,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      listProviders: jest.fn(),
      setCredential: jest.fn(),
      getCredential: jest.fn(),
      revokeCredential: jest.fn(),
      revokeCredentialByProvider: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ModelsController],
      providers: [
        { provide: ModelsService, useValue: service },
        // 方法级 @UseGuards(AdminGuard) 会在 compile 时实例化 guard，
        // AdminGuard 依赖全局 PrismaService，提供 mock 占位
        { provide: PrismaService, useValue: { user: { findUnique: jest.fn() } } },
      ],
    }).compile();

    controller = module.get<ModelsController>(ModelsController);
  });

  it('GET /models 转发 findAll（查询参数透传）', async () => {
    service.findAll.mockResolvedValue({ items: [modelRow], total: 1, page: 1, pageSize: 20 });
    const query = { enabled: true, name: 'deep' };

    const result = await controller.findAll(query);

    expect(service.findAll).toHaveBeenCalledWith(query);
    expect(result).toMatchObject({ total: 1, items: [modelRow] });
  });

  it('GET /models/:id 转发 findOne', async () => {
    service.findOne.mockResolvedValue(modelRow);

    const result = await controller.findOne('md_0000000001');

    expect(service.findOne).toHaveBeenCalledWith('md_0000000001');
    expect(result).toEqual(modelRow);
  });

  it('GET /models/providers 转发 listProviders（provider 聚合）', async () => {
    service.listProviders.mockResolvedValue([
      {
        providerID: 'opencode-go',
        modelCount: 5,
        configured: true,
        fingerprint: 'sk-a****89xz',
        revokedAt: null,
      },
    ]);

    const result = await controller.listProviders();

    expect(service.listProviders).toHaveBeenCalled();
    expect(result).toMatchObject([
      { providerID: 'opencode-go', modelCount: 5, configured: true },
    ]);
  });

  it('路由顺序：providers 静态段在 :id 参数段之前声明（避免被 :id 吞路由）', () => {
    // @Get 的 PATH_METADATA 定义在 descriptor.value（函数对象）上，故直接读函数对象
    const pathOf = (method: string) =>
      Reflect.getMetadata(
        PATH_METADATA,
        ModelsController.prototype[method],
      ) as string;
    const methods = Object.getOwnPropertyNames(
      ModelsController.prototype,
    ).filter((k) => k !== 'constructor');

    const providersIdx = methods.findIndex((m) => pathOf(m) === 'providers');
    const idIdx = methods.findIndex((m) => pathOf(m) === ':id');
    expect(providersIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeGreaterThan(-1);
    expect(providersIdx).toBeLessThan(idIdx);
  });

  it('POST /models 转发 create（DTO 透传）', async () => {
    const dto = { providerID: 'opencode-go', modelID: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' };
    service.create.mockResolvedValue(modelRow);

    const result = await controller.create(dto);

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result).toEqual(modelRow);
  });

  it('PATCH /models/:id 转发 update', async () => {
    const dto = { enabled: false };
    service.update.mockResolvedValue({ ...modelRow, enabled: false });

    const result = await controller.update('md_0000000001', dto);

    expect(service.update).toHaveBeenCalledWith('md_0000000001', dto);
    expect(result).toMatchObject({ enabled: false });
  });

  it('DELETE /models/:id 转发 remove', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove('md_0000000001');

    expect(service.remove).toHaveBeenCalledWith('md_0000000001');
  });

  it('POST /models/:id/credentials 转发 setCredential（token + providerID 传服务层加密）', async () => {
    const dto: SetModelCredentialDto = { token: 'sk-raw-token', providerID: 'opencode-go' };
    service.setCredential.mockResolvedValue(view);

    const result = await controller.setCredential('md_0000000001', dto);

    expect(service.setCredential).toHaveBeenCalledWith(
      'md_0000000001',
      'sk-raw-token',
      'opencode-go',
      undefined,
    );
    expect(result).toMatchObject({ configured: true, fingerprint: 'sk-a****89xz' });
    expect(JSON.stringify(result)).not.toContain('sk-raw-token');
  });

  it('POST 未传 providerID 时缺省 undefined（服务层回退 model.providerID）', async () => {
    const dto: SetModelCredentialDto = { token: 'sk-raw-token' };
    service.setCredential.mockResolvedValue(view);

    await controller.setCredential('md_0000000001', dto);

    expect(service.setCredential).toHaveBeenCalledWith(
      'md_0000000001',
      'sk-raw-token',
      undefined,
      undefined,
    );
  });

  it('C5：targetWorkerIds 透传服务层（定向下发）', async () => {
    const dto: SetModelCredentialDto = {
      token: 'sk-raw-token',
      targetWorkerIds: ['w_0000000001'],
    };
    service.setCredential.mockResolvedValue(view);

    await controller.setCredential('md_0000000001', dto);

    expect(service.setCredential).toHaveBeenCalledWith(
      'md_0000000001',
      'sk-raw-token',
      undefined,
      ['w_0000000001'],
    );
  });

  it('C5：targetWorkerIds 缺省时不携带（undefined → 全量下发）', async () => {
    const dto: SetModelCredentialDto = { token: 'sk-raw-token' };
    service.setCredential.mockResolvedValue(view);

    await controller.setCredential('md_0000000001', dto);

    expect(service.setCredential).toHaveBeenCalledWith(
      'md_0000000001',
      'sk-raw-token',
      undefined,
      undefined,
    );
  });

  it('GET /models/:id/credentials 转发 getCredential（返回脱敏视图）', async () => {
    service.getCredential.mockResolvedValue(view);

    const result = await controller.getCredential('md_0000000001');

    expect(service.getCredential).toHaveBeenCalledWith('md_0000000001');
    expect(result).toMatchObject({ configured: true, fingerprint: 'sk-a****89xz' });
  });

  it('DELETE /models/:id/credentials 转发 revokeCredential', async () => {
    service.revokeCredential.mockResolvedValue({
      ...view,
      revokedAt: new Date('2026-08-08T10:00:00Z'),
    });

    const result = await controller.revokeCredential('md_0000000001');

    expect(service.revokeCredential).toHaveBeenCalledWith('md_0000000001');
    expect(result).toMatchObject({ revokedAt: expect.any(Date) });
  });

  it('DELETE /models/providers/:providerID/credentials 转发 revokeCredentialByProvider', async () => {
    service.revokeCredentialByProvider.mockResolvedValue({
      ...view,
      providerID: 'opencode-go',
      revokedAt: new Date('2026-08-08T10:00:00Z'),
    });

    const result = await controller.revokeCredentialByProvider('opencode-go');

    expect(service.revokeCredentialByProvider).toHaveBeenCalledWith('opencode-go');
    expect(result).toMatchObject({ providerID: 'opencode-go', revokedAt: expect.any(Date) });
  });

  it('路由顺序：@Delete providers 静态段在 :id 参数段之前声明（不吞 providers/:providerID/credentials）', () => {
    const pathOf = (method: string) =>
      Reflect.getMetadata(
        PATH_METADATA,
        ModelsController.prototype[method],
      ) as string;
    const methodNames = Object.getOwnPropertyNames(
      ModelsController.prototype,
    ).filter((k) => k !== 'constructor');

    const deleteProviderCredIdx = methodNames.findIndex(
      (m) => pathOf(m) === 'providers/:providerID/credentials',
    );
    const deleteIdIdx = methodNames.findIndex((m) => pathOf(m) === ':id');
    expect(deleteProviderCredIdx).toBeGreaterThan(-1);
    expect(deleteIdIdx).toBeGreaterThan(-1);
    expect(deleteProviderCredIdx).toBeLessThan(deleteIdIdx);
  });
});
