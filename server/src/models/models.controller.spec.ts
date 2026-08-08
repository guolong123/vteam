import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { SetModelCredentialDto } from './dto/set-model-credential.dto';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

describe('ModelsController（模型凭据端点）', () => {
  let controller: ModelsController;
  let service: {
    setCredential: jest.Mock;
    getCredential: jest.Mock;
    revokeCredential: jest.Mock;
  };

  const view = {
    id: 'mc_0000000001',
    providerID: 'opencode-go',
    configured: true,
    fingerprint: 'sk-a****89xz',
    revokedAt: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
  };

  beforeEach(async () => {
    service = {
      setCredential: jest.fn(),
      getCredential: jest.fn(),
      revokeCredential: jest.fn(),
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

  it('POST /models/:id/credentials 转发 setCredential（token + providerID 传服务层加密）', async () => {
    const dto: SetModelCredentialDto = { token: 'sk-raw-token', providerID: 'opencode-go' };
    service.setCredential.mockResolvedValue(view);

    const result = await controller.setCredential('md_0000000001', dto);

    expect(service.setCredential).toHaveBeenCalledWith(
      'md_0000000001',
      'sk-raw-token',
      'opencode-go',
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
});
