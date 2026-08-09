import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkersService } from '../workers/workers.service';
import { MODEL_ERRORS } from './models.constants';
import { ModelsService } from './models.service';

describe('ModelsService（模型凭据：加密存储/脱敏查询/软吊销）', () => {
  let service: ModelsService;
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let prisma: {
    model: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      groupBy: jest.Mock;
    };
    modelCredential: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    workerModelAvailability: {
      deleteMany: jest.Mock;
      upsert: jest.Mock;
    };
    worker: {
      findMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let crypto: {
    encrypt: jest.Mock;
    decrypt: jest.Mock;
    fingerprint: jest.Mock;
  };
  let workers: { dispatchModelCredentials: jest.Mock };

  const modelRow = {
    id: 'md_0000000001',
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
  };

  const modelRowFull = {
    id: 'md_0000000001',
    providerID: 'opencode-go',
    modelID: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    capabilities: null,
    enabled: true,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
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

  let seq = 0;

  beforeEach(async () => {
    seq = 0;
    idGen = {
      nextId: jest.fn(async (prefix: string) =>
        `${prefix}_${String(++seq).padStart(10, '0')}`,
      ),
      seed: jest.fn(),
    };
    prisma = {
      model: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        groupBy: jest.fn(),
      },
      modelCredential: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      workerModelAvailability: {
        deleteMany: jest.fn(),
        upsert: jest.fn(),
      },
      worker: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(),
    };
    crypto = {
      encrypt: jest.fn().mockReturnValue('iv:tag:data'),
      decrypt: jest.fn().mockReturnValue('sk-raw-token'),
      fingerprint: jest.fn().mockReturnValue('sk-a****89xz'),
    };
    workers = {
      dispatchModelCredentials: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: CredentialCryptoService, useValue: crypto },
        { provide: WorkersService, useValue: workers },
      ],
    }).compile();

    service = module.get<ModelsService>(ModelsService);
  });

  describe('onModuleInit（md_/mc_ 前缀续号）', () => {
    it('对齐 model 表最大 md_ 序号 + modelCredential 表最大 mc_ 序号', async () => {
      prisma.model.findMany.mockResolvedValue([
        { id: 'md_0000000008' },
        { id: 'md_builtin_x' },
      ]);
      prisma.modelCredential.findMany.mockResolvedValue([
        { id: 'mc_0000000042' },
        { id: 'mc_builtin_x' },
      ]);

      await service.onModuleInit();

      expect(prisma.model.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'md_' } },
        select: { id: true },
      });
      expect(prisma.modelCredential.findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'mc_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('md', 8);
      expect(idGen.seed).toHaveBeenCalledWith('mc', 42);
    });
  });

  describe('findAll（目录列表：过滤 + 搜索 + 分页）', () => {
    it('enabled/providerID/name 过滤 + 分页 → {items, total, page, pageSize}', async () => {
      prisma.$transaction.mockResolvedValue([1, [modelRowFull]]);

      const result = await service.findAll({
        enabled: true,
        providerID: 'opencode',
        name: 'deep',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.model.count).toHaveBeenCalled();
      expect(prisma.model.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            enabled: true,
            providerID: { contains: 'opencode' },
            name: { contains: 'deep' },
          }),
          orderBy: { createdAt: 'asc' },
          skip: 0,
          take: 20,
        }),
      );
      expect(result).toEqual({ items: [modelRowFull], total: 1, page: 1, pageSize: 20 });
    });

    it('无过滤条件 → where 仅含 enabled undefined（全量）', async () => {
      prisma.$transaction.mockResolvedValue([0, []]);

      const result = await service.findAll();

      expect(prisma.model.count).toHaveBeenCalledWith({
        where: {
          enabled: undefined,
          providerID: undefined,
          modelID: undefined,
          name: undefined,
        },
      });
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });
  });

  describe('findOne（详情）', () => {
    it('存在 → 返回行', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRowFull);

      const result = await service.findOne('md_0000000001');

      expect(prisma.model.findUnique).toHaveBeenCalledWith({
        where: { id: 'md_0000000001' },
      });
      expect(result).toEqual(modelRowFull);
    });

    it('不存在 → 404 MODEL_NOT_FOUND', async () => {
      prisma.model.findUnique.mockResolvedValue(null);

      await expect(service.findOne('md_nonexistent')).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_NOT_FOUND },
      });
    });
  });

  describe('listProviders（provider 聚合：模型数 + 凭据状态）', () => {
    it('models groupBy + ModelCredential 合并：modelCount/configured/fingerprint/revokedAt + 字典序', async () => {
      prisma.model.groupBy.mockResolvedValue([
        { providerID: 'zhipu', _count: { _all: 3 } },
        { providerID: 'opencode-go', _count: { _all: 5 } },
        { providerID: 'opencode', _count: { _all: 2 } },
      ]);
      prisma.modelCredential.findMany.mockResolvedValue([
        credentialRow, // opencode-go：已配置
        {
          ...credentialRow,
          id: 'mc_0000000002',
          providerID: 'opencode',
          revokedAt: new Date('2026-08-01T00:00:00Z'),
        },
      ]);

      const result = await service.listProviders();

      expect(prisma.model.groupBy).toHaveBeenCalledWith({
        by: ['providerID'],
        where: { enabled: true },
        _count: { _all: true },
      });
      expect(prisma.modelCredential.findMany).toHaveBeenCalled();
      expect(result).toEqual([
        {
          providerID: 'opencode',
          modelCount: 2,
          configured: false,
          fingerprint: null,
          revokedAt: new Date('2026-08-01T00:00:00Z'),
        },
        {
          providerID: 'opencode-go',
          modelCount: 5,
          configured: true,
          fingerprint: 'sk-a****89xz',
          revokedAt: null,
        },
        {
          providerID: 'zhipu',
          modelCount: 3,
          configured: false,
          fingerprint: null,
          revokedAt: null,
        },
      ]);
    });

    it('凭据已吊销 → configured=false 且 fingerprint=null（吊销保留 revokedAt 轨迹）', async () => {
      prisma.model.groupBy.mockResolvedValue([
        { providerID: 'opencode', _count: { _all: 2 } },
      ]);
      prisma.modelCredential.findMany.mockResolvedValue([
        {
          ...credentialRow,
          providerID: 'opencode',
          fingerprint: 'sk-x****xxxx',
          revokedAt: new Date('2026-08-02T00:00:00Z'),
        },
      ]);

      const result = await service.listProviders();

      expect(result).toEqual([
        {
          providerID: 'opencode',
          modelCount: 2,
          configured: false,
          fingerprint: null,
          revokedAt: new Date('2026-08-02T00:00:00Z'),
        },
      ]);
    });

    it('无模型/无凭据 → 空数组', async () => {
      prisma.model.groupBy.mockResolvedValue([]);
      prisma.modelCredential.findMany.mockResolvedValue([]);

      expect(await service.listProviders()).toEqual([]);
    });

    it('D5：在线 worker 上报 capabilities.models → 拆 providerID union 补全（worker-only provider 出现 + modelCount 累加）', async () => {
      prisma.model.groupBy.mockResolvedValue([
        { providerID: 'opencode-go', _count: { _all: 1 } },
      ]);
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.worker.findMany.mockResolvedValue([
        {
          capabilities: {
            models: [
              'opencode-go/deepseek-v4-flash',
              'opencode-go/deepseek-v4-pro',
              'deepseek/deepseek-v4-pro',
              'zhipu/glm-5.1',
            ],
          },
        },
        {
          // 第二个在线 worker：qwen 新 provider + deepseek 模型计数累加
          capabilities: { models: ['qwen/qwen3.6-plus', 'deepseek/deepseek-v4-pro'] },
        },
      ]);

      const result = await service.listProviders();

      expect(prisma.worker.findMany).toHaveBeenCalledWith({
        where: { status: { not: 'offline' } },
        select: { capabilities: true },
      });
      // union：目录 opencode-go + worker 上报 deepseek/zhipu/qwen
      expect(result.map((r) => r.providerID)).toEqual(['deepseek', 'opencode-go', 'qwen', 'zhipu']);
      // modelCount = 目录 count + worker 上报计数（opencode-go: 1 + 2 = 3；deepseek 两个 worker 累加 = 2）
      expect(result.find((r) => r.providerID === 'opencode-go')?.modelCount).toBe(3);
      expect(result.find((r) => r.providerID === 'deepseek')?.modelCount).toBe(2);
      expect(result.find((r) => r.providerID === 'zhipu')?.modelCount).toBe(1);
      expect(result.find((r) => r.providerID === 'qwen')?.modelCount).toBe(1);
    });
  });

  describe('create（创建目录条目）', () => {
    const createDto = {
      providerID: 'opencode-go',
      modelID: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
    };

    it('唯一校验通过 → create + 返回新行（enabled 缺省 true）', async () => {
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockResolvedValue(modelRowFull);

      const result = await service.create(createDto);

      expect(prisma.model.findUnique).toHaveBeenCalledWith({
        where: {
          providerID_modelID: {
            providerID: 'opencode-go',
            modelID: 'deepseek-v4-flash',
          },
        },
        select: { id: true },
      });
      expect(prisma.model.create).toHaveBeenCalledWith({
        data: {
          id: 'md_0000000001',
          providerID: 'opencode-go',
          modelID: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          capabilities: undefined,
          enabled: true,
        },
      });
      expect(result).toEqual(modelRowFull);
    });

    it('providerID+modelID 撞 @unique → 409 MODEL_EXISTS（不触发 create）', async () => {
      prisma.model.findUnique.mockResolvedValue({ id: 'md_0000000009' });

      await expect(service.create(createDto)).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_EXISTS },
      });
      expect(prisma.model.create).not.toHaveBeenCalled();
    });
  });

  describe('update（部分更新）', () => {
    it('改 name/enabled → update 只写变更字段', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRowFull);
      prisma.model.update.mockResolvedValue({
        ...modelRowFull,
        name: '改名',
        enabled: false,
      });

      const result = await service.update('md_0000000001', {
        name: '改名',
        enabled: false,
      });

      expect(prisma.model.update).toHaveBeenCalledWith({
        where: { id: 'md_0000000001' },
        data: { name: '改名', enabled: false },
      });
      expect(result).toMatchObject({ name: '改名', enabled: false });
    });

    it('不存在 → 404 MODEL_NOT_FOUND（不触发 update）', async () => {
      prisma.model.findUnique.mockResolvedValue(null);

      await expect(
        service.update('md_nonexistent', { name: 'x' }),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_NOT_FOUND },
      });
      expect(prisma.model.update).not.toHaveBeenCalled();
    });

    it('改 providerID/modelID 撞唯一（非自身）→ 409 MODEL_EXISTS', async () => {
      prisma.model.findUnique
        .mockResolvedValueOnce(modelRowFull)
        .mockResolvedValueOnce({ id: 'md_0000000009' });

      await expect(
        service.update('md_0000000001', { providerID: 'opencode' }),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_EXISTS },
      });
      expect(prisma.model.update).not.toHaveBeenCalled();
    });
  });

  describe('remove（物理删除 + availability 级联清理）', () => {
    it('先删 worker_model_availabilities 再删 model（事务）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRowFull);
      prisma.$transaction.mockResolvedValue([{ count: 2 }, {}]);

      await service.remove('md_0000000001');

      expect(prisma.$transaction).toHaveBeenCalledWith([
        expect.objectContaining({}),
        expect.objectContaining({}),
      ]);
      expect(prisma.workerModelAvailability.deleteMany).toHaveBeenCalledWith({
        where: { modelId: 'md_0000000001' },
      });
      expect(prisma.model.delete).toHaveBeenCalledWith({
        where: { id: 'md_0000000001' },
      });
    });

    it('不存在 → 404 MODEL_NOT_FOUND（不触发删除）', async () => {
      prisma.model.findUnique.mockResolvedValue(null);

      await expect(service.remove('md_nonexistent')).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_NOT_FOUND },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('syncFromWorkerCapabilities（worker 上报合并入库）', () => {
    it('上报 models → 逐条拆解 upsert 目录 + upsert availability，返回合并条数', async () => {
      prisma.model.findUnique
        .mockResolvedValueOnce(null) // 'opencode-go/deepseek-v4-flash' 目录不存在 → 新建
        .mockResolvedValueOnce({ id: 'md_0000000001' }); // 'opencode/glm-5.1' 已存在 → 复用
      prisma.model.create.mockResolvedValue({
        ...modelRowFull,
        id: 'md_0000000001',
        modelID: 'deepseek-v4-flash',
      });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});

      const n = await service.syncFromWorkerCapabilities('w_0000000001', [
        'opencode-go/deepseek-v4-flash',
        'opencode/glm-5.1',
      ]);

      expect(n).toBe(2);
      expect(prisma.model.create).toHaveBeenCalledWith({
        data: {
          id: 'md_0000000001',
          providerID: 'opencode-go',
          modelID: 'deepseek-v4-flash',
          name: 'deepseek-v4-flash',
        },
      });
      expect(prisma.workerModelAvailability.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.workerModelAvailability.upsert).toHaveBeenCalledWith({
        where: {
          workerId_modelId: {
            workerId: 'w_0000000001',
            modelId: 'md_0000000001',
          },
        },
        create: { workerId: 'w_0000000001', modelId: 'md_0000000001' },
        update: {},
      });
    });

    it('缺省/空数组 → 返回 0 不触碰目录（降级未上报保留旧数据）', async () => {
      expect(await service.syncFromWorkerCapabilities('w_0000000001', [])).toBe(0);
      expect(prisma.model.findUnique).not.toHaveBeenCalled();
      expect(prisma.workerModelAvailability.upsert).not.toHaveBeenCalled();
    });
  });

  describe('listCatalogModels（available-models 目录数据源）', () => {
    it('enabled=true 全部模型 → [{id: providerID/modelID, name}]', async () => {
      prisma.model.findMany.mockResolvedValue([modelRowFull]);

      const result = await service.listCatalogModels();

      expect(prisma.model.findMany).toHaveBeenCalledWith({
        where: { enabled: true },
        orderBy: { createdAt: 'asc' },
        select: { providerID: true, modelID: true, name: true },
      });
      expect(result).toEqual([
        { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ]);
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

    it('C5：保存成功后触发凭据下发（targetWorkerIds 缺省 → 全量）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);

      await service.setCredential('md_0000000001', 'sk-raw-token');

      expect(workers.dispatchModelCredentials).toHaveBeenCalledWith(
        [{ providerID: 'opencode-go', key: 'sk-raw-token' }],
        undefined,
      );
    });

    it('C5：targetWorkerIds 非空时定向传递到 WorkersService.dispatchModelCredentials', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);

      await service.setCredential('md_0000000001', 'sk-raw-token', 'opencode-go', [
        'w_0000000001',
      ]);

      expect(workers.dispatchModelCredentials).toHaveBeenCalledWith(
        [{ providerID: 'opencode-go', key: 'sk-raw-token' }],
        ['w_0000000001'],
      );
    });

    it('C5：下发失败不阻断保存（凭据已落库，worker 注册回放兜底）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);
      workers.dispatchModelCredentials.mockRejectedValue(
        new Error('broadcast fail'),
      );
      const warnSpy = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => {});

      const result = await service.setCredential('md_0000000001', 'sk-raw-token');

      expect(result).toMatchObject({ configured: true });
      warnSpy.mockRestore();
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
      expect(result).toMatchObject({ configured: false, revokedAt: now });
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
