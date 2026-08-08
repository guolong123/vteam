import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { MODEL_ERRORS } from './models.constants';
import { ModelsService } from './models.service';

describe('ModelsService（模型凭据：加密存储/脱敏查询/软吊销）', () => {
  let service: ModelsService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let prisma: {
    model: {
      findUnique: jest.Mock;
    };
    modelCredential: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let crypto: {
    encrypt: jest.Mock;
    decrypt: jest.Mock;
    fingerprint: jest.Mock;
  };

  const modelRow = {
    id: 'md_0000000001',
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
  };

  const credentialRow = {
    id: 'mc_0000000001',
    providerID: 'opencode-go',
    credentialRef: 'iv:tag:data',
    fingerprint: 'sk-a****89xz',
    revokedAt: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
  };

  beforeEach(async () => {
    idGen = {
      nextId: jest.fn().mockResolvedValue('mc_0000000001'),
      seed: jest.fn(),
    };
    prisma = {
      model: { findUnique: jest.fn() },
      modelCredential: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    crypto = {
      encrypt: jest.fn().mockReturnValue('iv:tag:data'),
      decrypt: jest.fn().mockReturnValue('sk-raw-token'),
      fingerprint: jest.fn().mockReturnValue('sk-a****89xz'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: CredentialCryptoService, useValue: crypto },
      ],
    }).compile();

    service = module.get<ModelsService>(ModelsService);
  });

  describe('onModuleInit（mc_ 前缀续号）', () => {
    it('对齐 modelCredential 表最大 mc_ 序号', async () => {
      prisma.modelCredential.findMany.mockResolvedValue([
        { id: 'mc_0000000042' },
        { id: 'mc_builtin_x' },
      ]);

      await service.onModuleInit();

      expect(prisma.modelCredential.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'mc_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('mc', 42);
    });
  });

  describe('setCredential（POST 加密存储）', () => {
    it('首次录入：查 model 解析 providerID → 加密 → create + 返回脱敏视图', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);

      const result = await service.setCredential(
        'md_0000000001',
        'sk-raw-token',
      );

      expect(prisma.model.findUnique).toHaveBeenCalledWith({
        where: { id: 'md_0000000001' },
        select: { providerID: true },
      });
      expect(crypto.encrypt).toHaveBeenCalledWith('sk-raw-token');
      expect(crypto.fingerprint).toHaveBeenCalledWith('sk-raw-token');
      expect(prisma.modelCredential.create).toHaveBeenCalledWith({
        data: {
          id: 'mc_0000000001',
          providerID: 'opencode-go',
          credentialRef: 'iv:tag:data',
          fingerprint: 'sk-a****89xz',
        },
      });
      expect(result).toEqual({
        id: 'mc_0000000001',
        providerID: 'opencode-go',
        configured: true,
        fingerprint: 'sk-a****89xz',
        revokedAt: null,
        createdAt: credentialRow.createdAt,
      });
    });

    it('body.providerID 显式提供且与 model 一致 → 放行（同 provider 存储）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);

      const result = await service.setCredential(
        'md_0000000001',
        'sk-raw-token',
        'opencode-go',
      );

      expect(prisma.modelCredential.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ providerID: 'opencode-go' }) }),
      );
      expect(result).toMatchObject({ configured: true });
    });

    it('body.providerID 与 model.providerID 不一致 → 400 MODEL_PROVIDER_MISMATCH（不加密不写入）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);

      await expect(
        service.setCredential('md_0000000001', 'sk-x', 'opencode'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.setCredential('md_0000000001', 'sk-x', 'opencode'),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_PROVIDER_MISMATCH },
      });
      expect(crypto.encrypt).not.toHaveBeenCalled();
      expect(prisma.modelCredential.create).not.toHaveBeenCalled();
    });

    it('同 provider 重复 POST：覆盖更新（新加密 ref + 新 fingerprint + 清除 revokedAt）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue({
        ...credentialRow,
        revokedAt: new Date('2026-08-01T00:00:00Z'),
      });
      crypto.encrypt.mockReturnValue('iv:newtag:newdata');
      crypto.fingerprint.mockReturnValue('sk-n****xxxx');
      prisma.modelCredential.update.mockResolvedValue({
        ...credentialRow,
        credentialRef: 'iv:newtag:newdata',
        fingerprint: 'sk-n****xxxx',
        revokedAt: null,
      });

      const result = await service.setCredential('md_0000000001', 'new-token');

      expect(prisma.modelCredential.update).toHaveBeenCalledWith({
        where: { providerID: 'opencode-go' },
        data: {
          credentialRef: 'iv:newtag:newdata',
          fingerprint: 'sk-n****xxxx',
          revokedAt: null,
        },
      });
      expect(prisma.modelCredential.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ fingerprint: 'sk-n****xxxx', revokedAt: null });
    });

    it('model 不存在 → 404 MODEL_NOT_FOUND（不触发任何加密/写入）', async () => {
      prisma.model.findUnique.mockResolvedValue(null);

      await expect(
        service.setCredential('md_nonexistent', 'sk-x'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.setCredential('md_nonexistent', 'sk-x'),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_NOT_FOUND },
      });
      expect(crypto.encrypt).not.toHaveBeenCalled();
      expect(prisma.modelCredential.create).not.toHaveBeenCalled();
    });
  });

  describe('getCredential（GET 脱敏查询）', () => {
    it('已配置：返回 fingerprint + revokedAt，不包含 credentialRef/明文', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(credentialRow);

      const result = await service.getCredential('md_0000000001');

      expect(result).toEqual({
        id: 'mc_0000000001',
        providerID: 'opencode-go',
        configured: true,
        fingerprint: 'sk-a****89xz',
        revokedAt: null,
        createdAt: credentialRow.createdAt,
      });
      expect(JSON.stringify(result)).not.toContain('iv:tag:data');
      expect(JSON.stringify(result)).not.toContain('sk-raw-token');
    });

    it('未配置：configured=false + fingerprint null（不 404）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(null);

      const result = await service.getCredential('md_0000000001');

      expect(result).toEqual({
        id: '',
        providerID: 'opencode-go',
        configured: false,
        fingerprint: null,
        revokedAt: null,
        createdAt: null,
      });
    });

    it('model 不存在 → 404 MODEL_NOT_FOUND', async () => {
      prisma.model.findUnique.mockResolvedValue(null);

      await expect(service.getCredential('md_nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('revokeCredential（DELETE 软吊销）', () => {
    it('已配置：revokedAt 置当前时间，保留 fingerprint 审计轨迹', async () => {
      const now = new Date('2026-08-08T10:00:00Z');
      jest.spyOn(global, 'Date').mockImplementation(() => now as never);
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(credentialRow);
      prisma.modelCredential.update.mockResolvedValue({
        ...credentialRow,
        revokedAt: now,
      });

      const result = await service.revokeCredential('md_0000000001');

      expect(prisma.modelCredential.update).toHaveBeenCalledWith({
        where: { providerID: 'opencode-go' },
        data: { revokedAt: now },
      });
      expect(result).toMatchObject({ configured: true, revokedAt: now });
      (global.Date as unknown as jest.Mock).mockRestore();
    });

    it('未配置 → 404 MODEL_CREDENTIAL_NOT_FOUND（不触发 update）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeCredential('md_0000000001'),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_CREDENTIAL_NOT_FOUND },
      });
      expect(prisma.modelCredential.update).not.toHaveBeenCalled();
    });

    it('model 不存在 → 404 MODEL_NOT_FOUND', async () => {
      prisma.model.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeCredential('md_nonexistent'),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_NOT_FOUND },
      });
    });
  });
});
