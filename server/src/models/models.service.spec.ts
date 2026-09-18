import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerClient } from '../workers/worker.client';
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
      updateMany: jest.Mock;
      delete: jest.Mock;
      groupBy: jest.Mock;
    };
    modelCredential: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    gitCredential: {
      findMany: jest.Mock;
    };
    gitRepoGrant: {
      findMany: jest.Mock;
    };
    workerModelAvailability: {
      deleteMany: jest.Mock;
      upsert: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
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
      nextId: jest.fn(
        async (prefix: string) =>
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
        updateMany: jest.fn(),
        delete: jest.fn(),
        groupBy: jest.fn(),
      },
      modelCredential: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      gitCredential: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      gitRepoGrant: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      workerModelAvailability: {
        deleteMany: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
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
        {
          provide: WorkerClient,
          useValue: { listModels: jest.fn().mockResolvedValue([]) },
        },
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
      // git 凭证域（onModuleInit 亦对齐 gc_/gr_ 前缀，todo 1 挂接）
      prisma.gitCredential.findMany.mockResolvedValue([]);
      prisma.gitRepoGrant.findMany.mockResolvedValue([]);

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
            providerID: 'opencode',
            name: { contains: 'deep' },
          }),
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: 0,
          take: 20,
        }),
      );
      expect(result).toEqual({
        items: [modelRowFull],
        total: 1,
        page: 1,
        pageSize: 20,
      });
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
          capabilities: {
            models: ['qwen/qwen3.6-plus', 'deepseek/deepseek-v4-pro'],
          },
        },
      ]);

      const result = await service.listProviders();

      expect(prisma.worker.findMany).toHaveBeenCalledWith({
        where: { status: { not: 'offline' } },
        select: { capabilities: true },
      });
      // union：目录 opencode-go + worker 上报 deepseek/zhipu/qwen
      expect(result.map((r) => r.providerID)).toEqual([
        'deepseek',
        'opencode-go',
        'qwen',
        'zhipu',
      ]);
      // modelCount = Math.max(目录 count, worker 上报计数)（opencode-go: max(1,2)=2；deepseek 两个 worker 累加 = 2）
      expect(
        result.find((r) => r.providerID === 'opencode-go')?.modelCount,
      ).toBe(2);
      expect(result.find((r) => r.providerID === 'deepseek')?.modelCount).toBe(
        2,
      );
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

  describe('updateProvider（Provider 级配置：全模型行原子重写 + C6 门控下发）', () => {
    /* updateProvider 链路里 model.findMany 有三处用途，按 select 形态路由：
     * provider 行（{providerType, baseUrl}）、getLocalProviderConfigs
     * （{providerID, modelID, baseUrl}）、listProviders 元数据（{providerID, providerType, baseUrl}）。 */
    const routeFindMany = (opts: {
      providerRows: Array<{ providerType: string; baseUrl: string | null }>;
      configRows?: Array<{
        providerID: string;
        modelID: string;
        baseUrl: string;
      }>;
      metaRows?: Array<{
        providerID: string;
        providerType: string;
        baseUrl: string;
      }>;
    }) => {
      prisma.model.findMany.mockImplementation(
        (args: { select?: Record<string, boolean> }) => {
          const sel = args?.select ?? {};
          if (sel.modelID) return Promise.resolve(opts.configRows ?? []);
          if (sel.providerID) return Promise.resolve(opts.metaRows ?? []);
          return Promise.resolve(opts.providerRows);
        },
      );
    };

    it('providerType+baseUrl 原子重写（updateMany）+ 有活跃凭据 → C6 全量下发携带新配置', async () => {
      routeFindMany({
        providerRows: [
          { providerType: 'local', baseUrl: 'http://old:8000/v1' },
        ],
        configRows: [
          {
            providerID: 'vllm',
            modelID: 'qwen3-27b',
            baseUrl: 'http://new:8000/v1',
          },
        ],
        metaRows: [
          {
            providerID: 'vllm',
            providerType: 'local',
            baseUrl: 'http://new:8000/v1',
          },
        ],
      });
      prisma.model.updateMany.mockResolvedValue({ count: 2 });
      prisma.modelCredential.findUnique.mockResolvedValue({ revokedAt: null });
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'vllm', credentialRef: 'iv:tag:data' },
      ]);
      prisma.model.groupBy.mockResolvedValue([
        { providerID: 'vllm', _count: { _all: 2 } },
      ]);

      const result = await service.updateProvider('vllm', {
        providerType: 'local',
        baseUrl: 'http://new:8000/v1',
      });

      expect(prisma.model.updateMany).toHaveBeenCalledWith({
        where: { providerID: 'vllm' },
        data: { providerType: 'local', baseUrl: 'http://new:8000/v1' },
      });
      expect(workers.dispatchModelCredentials).toHaveBeenCalledWith(
        [{ providerID: 'vllm', key: 'sk-raw-token' }],
        undefined,
        {
          vllm: { baseUrl: 'http://new:8000/v1', models: { 'qwen3-27b': {} } },
        },
      );
      expect(result).toMatchObject({
        providerID: 'vllm',
        providerType: 'local',
        baseUrl: 'http://new:8000/v1',
        modelCount: 2,
      });
    });

    it('cloud 显式 baseUrl=null → 清空（updateMany baseUrl: null）', async () => {
      routeFindMany({
        providerRows: [{ providerType: 'cloud', baseUrl: 'http://x:8000/v1' }],
        metaRows: [{ providerID: 'p', providerType: 'cloud', baseUrl: '' }],
      });
      prisma.model.updateMany.mockResolvedValue({ count: 1 });
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.model.groupBy.mockResolvedValue([
        { providerID: 'p', _count: { _all: 1 } },
      ]);

      await service.updateProvider('p', { baseUrl: null });

      expect(prisma.model.updateMany).toHaveBeenCalledWith({
        where: { providerID: 'p' },
        data: { providerType: 'cloud', baseUrl: null },
      });
      expect(workers.dispatchModelCredentials).not.toHaveBeenCalled();
    });

    it('存在行但类型为 local 且缺 baseUrl → 400 MODEL_BASEURL_REQUIRED（不写库）', async () => {
      routeFindMany({
        providerRows: [{ providerType: 'local', baseUrl: null }],
      });

      await expect(
        service.updateProvider('vllm', { providerType: 'local' }),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_BASEURL_REQUIRED },
      });
      expect(prisma.model.updateMany).not.toHaveBeenCalled();
    });

    it('两字段皆缺省 → 400 MODEL_PROVIDER_UPDATE_EMPTY（不查询不写库）', async () => {
      await expect(service.updateProvider('p', {})).rejects.toMatchObject({
        response: { code: 'MODEL_PROVIDER_UPDATE_EMPTY' },
      });
      expect(prisma.model.findMany).not.toHaveBeenCalled();
      expect(prisma.model.updateMany).not.toHaveBeenCalled();
    });

    it('provider 无模型行 → 404 MODEL_NOT_FOUND（不写库）', async () => {
      routeFindMany({ providerRows: [] });

      await expect(
        service.updateProvider('ghost', { baseUrl: 'http://y:8000/v1' }),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_NOT_FOUND },
      });
      expect(prisma.model.updateMany).not.toHaveBeenCalled();
    });

    it('无活跃凭据 → 只改目录，不触发下发', async () => {
      routeFindMany({
        providerRows: [{ providerType: 'cloud', baseUrl: null }],
        metaRows: [
          {
            providerID: 'p',
            providerType: 'cloud',
            baseUrl: 'http://y:8000/v1',
          },
        ],
      });
      prisma.model.updateMany.mockResolvedValue({ count: 1 });
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.model.groupBy.mockResolvedValue([
        { providerID: 'p', _count: { _all: 1 } },
      ]);

      await service.updateProvider('p', { baseUrl: 'http://y:8000/v1' });

      expect(prisma.model.updateMany).toHaveBeenCalledWith({
        where: { providerID: 'p' },
        data: { providerType: 'cloud', baseUrl: 'http://y:8000/v1' },
      });
      expect(workers.dispatchModelCredentials).not.toHaveBeenCalled();
    });
  });

  describe('C8：per-model 能力下发（capabilities → providerConfigs）+ 端点探测', () => {
    it('getLocalProviderConfigs：capabilities 白名单提取（limit/布尔/modalities/options）', async () => {
      prisma.model.findMany.mockResolvedValue([
        {
          providerID: 'vllm',
          modelID: 'qwen3.8-27b',
          name: 'Qwen3.8 27B',
          baseUrl: 'http://192.168.10.10:18020/v1',
          capabilities: {
            limit: { context: 262144, output: 16384 },
            reasoning: true,
            toolCall: true,
            temperature: false,
            attachment: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            options: { reasoningEffort: 'high' },
          },
        },
      ]);

      const configs = await service.getLocalProviderConfigs();

      expect(configs).toEqual({
        vllm: {
          baseUrl: 'http://192.168.10.10:18020/v1',
          models: {
            'qwen3.8-27b': {
              name: 'Qwen3.8 27B',
              capabilities: {
                limit: { context: 262144, output: 16384 },
                reasoning: true,
                toolCall: true,
                temperature: false,
                attachment: true,
                modalities: { input: ['text', 'image'], output: ['text'] },
                options: { reasoningEffort: 'high' },
              },
            },
          },
        },
      });
    });

    it('getLocalProviderConfigs：非法 capabilities（残缺 limit/未知键/坏 modalities）→ 丢弃且不抛错', async () => {
      prisma.model.findMany.mockResolvedValue([
        {
          providerID: 'p',
          modelID: 'm1',
          name: 'm1',
          baseUrl: 'http://h:1/v1',
          capabilities: {
            limit: { context: 4096 },
            bogusKey: 'x',
            modalities: { input: ['not-a-modality'] },
          },
        },
        {
          providerID: 'p',
          modelID: 'm2',
          name: 'm2',
          baseUrl: 'http://h:1/v1',
          capabilities: null,
        },
      ]);

      const configs = await service.getLocalProviderConfigs();

      expect(configs.p.models.m1).toEqual({});
      expect(configs.p.models.m2).toEqual({});
    });

    it('getLocalProviderConfigs：name 与 modelID 相同 → 省略 name（避免冗余下发）', async () => {
      prisma.model.findMany.mockResolvedValue([
        {
          providerID: 'p',
          modelID: 'qwen3.8-27b',
          name: 'qwen3.8-27b',
          baseUrl: 'http://h:1/v1',
          capabilities: { reasoning: true },
        },
      ]);

      const configs = await service.getLocalProviderConfigs();

      expect(configs.p.models['qwen3.8-27b']).toEqual({
        capabilities: { reasoning: true },
      });
    });

    it('update：capabilities 变更 → 触发门控下发（此前会静默丢失）', async () => {
      prisma.model.findUnique.mockResolvedValue({
        ...modelRowFull,
        providerID: 'vllm',
        baseUrl: 'http://h:1/v1',
      });
      prisma.model.update.mockResolvedValue(modelRowFull);
      prisma.modelCredential.findUnique.mockResolvedValue({ revokedAt: null });
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'vllm', credentialRef: 'iv:tag:data' },
      ]);
      prisma.model.findMany.mockResolvedValue([]);

      await service.update('md_0000000001', {
        capabilities: { limit: { context: 262144, output: 16384 } },
      });

      expect(workers.dispatchModelCredentials).toHaveBeenCalled();
    });

    it('update：仅改 name/enabled → 不触发下发（非形态字段）', async () => {
      prisma.model.findUnique.mockResolvedValue({
        ...modelRowFull,
        providerID: 'vllm',
        baseUrl: 'http://h:1/v1',
      });
      prisma.model.update.mockResolvedValue(modelRowFull);

      await service.update('md_0000000001', { name: '新名字' });

      expect(workers.dispatchModelCredentials).not.toHaveBeenCalled();
    });

    it('probeEndpoint：vLLM max_model_len → context；缺该字段的模型只回 id', async () => {
      const spy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'qwen3.8-27b', max_model_len: 262144 },
            { id: 'plain-model' },
          ],
        }),
      } as Response);

      const result = await service.probeEndpoint('http://h:1/v1/');

      expect(spy).toHaveBeenCalledWith(
        'http://h:1/v1/models',
        expect.objectContaining({ signal: expect.anything() }),
      );
      expect(result).toEqual({
        models: [{ id: 'qwen3.8-27b', context: 262144 }, { id: 'plain-model' }],
      });
      spy.mockRestore();
    });

    it('probeEndpoint：端点不可达/非 200 → 返回空列表（探测失败不抛错，不阻断表单）', async () => {
      const spy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.probeEndpoint('http://unreachable:1/v1'),
      ).resolves.toEqual({
        models: [],
      });
      spy.mockRestore();
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

  describe('syncFromWorkerCapabilities（worker 上报合并入库 + 同步清理）', () => {
    it('上报 models → 逐条拆解 upsert 目录 + upsert availability，返回合并条数', async () => {
      prisma.model.findUnique
        .mockResolvedValueOnce(null) // 'opencode-go/deepseek-v4-flash' 目录不存在 → 新建 md_0000000001
        .mockResolvedValueOnce({ id: 'md_0000000002' }); // 'opencode/glm-5.1' 已存在 → 复用 md_0000000002
      prisma.model.create.mockResolvedValue({
        ...modelRowFull,
        id: 'md_0000000001',
        modelID: 'deepseek-v4-flash',
      });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 0 });

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
      // 同步清理：删除该 worker 不在本次上报列表中的旧 availability（仅未启用行）
      expect(prisma.workerModelAvailability.deleteMany).toHaveBeenCalledWith({
        where: {
          workerId: 'w_0000000001',
          modelId: { notIn: ['md_0000000001', 'md_0000000002'] },
          model: { enabled: false },
        },
      });
    });

    it('CONF-01：上报最新 8 个真实模型时，删除该 worker 不再上报的假模型 availability', async () => {
      // worker 实测真实模型（opencode models 权威列表）
      const realModelRefs = [
        'big-pickle/big-pickle',
        'opencode-go/deepseek-v4-flash-free',
        'opencode-go/laguna-s-2.1-free',
        'opencode-go/ling-3.0-tiny-free',
        'opencode-go/longcat-2.0-free',
        'opencode-go/mimo-v2.5-free',
        'opencode-go/nemotron-3-ultra-free',
        'opencode-go/north-mini-code-free',
      ];
      // 目录均不存在 → 新建，catalogId = md_<modelID>
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockImplementation(async ({ data }) => ({
        ...modelRowFull,
        id: `md_${data.modelID}`,
      }));
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      // 上次上报 25 个，本次 8 个 → 17 个假模型 availability 被清理
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({
        count: 17,
      });

      const n = await service.syncFromWorkerCapabilities(
        'w_0000000001',
        realModelRefs,
      );

      expect(n).toBe(8);
      expect(prisma.workerModelAvailability.upsert).toHaveBeenCalledTimes(8);
      expect(prisma.workerModelAvailability.deleteMany).toHaveBeenCalledWith({
        where: {
          workerId: 'w_0000000001',
          modelId: {
            notIn: realModelRefs.map((ref) => `md_${ref.split('/')[1]}`),
          },
          model: { enabled: false },
        },
      });
    });

    it('缺省/空数组 → 返回 0 不触碰目录（降级未上报保留旧数据）', async () => {
      expect(await service.syncFromWorkerCapabilities('w_0000000001', [])).toBe(
        0,
      );
      expect(prisma.model.findUnique).not.toHaveBeenCalled();
      expect(prisma.workerModelAvailability.upsert).not.toHaveBeenCalled();
      expect(prisma.workerModelAvailability.deleteMany).not.toHaveBeenCalled();
    });

    it('models-sync：worker 上报 stale 快照中的未知 opencode 模型 → 目录新建行 enabled=false（未 live 确认不进 dropdown）', async () => {
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockResolvedValue({
        ...modelRowFull,
        id: 'md_0000000001',
        providerID: 'opencode',
        modelID: 'stale-model-x',
      });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 0 });

      const n = await service.syncFromWorkerCapabilities('w_0000000001', [
        'opencode/stale-model-x',
      ]);

      expect(n).toBe(1);
      // 注册路径只做候选登记，不授予可见性；可见性唯一由 syncLiveModels 授予
      expect(prisma.model.create).toHaveBeenCalledWith({
        data: {
          id: 'md_0000000001',
          providerID: 'opencode',
          modelID: 'stale-model-x',
          name: 'stale-model-x',
          enabled: false,
        },
      });
    });

    it('models-sync：同步清理仅删未启用行的 availability，已启用（live 确认）行保留（stale 快照不 strip 新模型）', async () => {
      prisma.model.findUnique.mockResolvedValue({ id: 'md_live' });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 0 });

      await service.syncFromWorkerCapabilities('w_0000000001', [
        'opencode/live-model',
      ]);

      expect(prisma.workerModelAvailability.deleteMany).toHaveBeenCalledWith({
        where: {
          workerId: 'w_0000000001',
          modelId: { notIn: ['md_live'] },
          model: { enabled: false },
        },
      });
    });
  });

  describe('listCatalogModels（available-models 目录数据源）', () => {
    it('enabled=true 全部模型 → [{id: providerID/modelID, name}]（仅可用模型：免费或已配置凭据）', async () => {
      prisma.model.findMany.mockResolvedValue([modelRowFull]);
      prisma.modelCredential.findMany.mockResolvedValue([credentialRow]);
      prisma.workerModelAvailability.findMany.mockResolvedValue([
        { modelId: 'md_0000000001' },
      ]);

      const result = await service.listCatalogModels();

      expect(prisma.model.findMany).toHaveBeenCalledWith({
        where: { enabled: true },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          providerID: true,
          modelID: true,
          name: true,
          providerType: true,
        },
      });
      expect(prisma.modelCredential.findMany).toHaveBeenCalledWith({
        where: { revokedAt: null },
        select: { providerID: true },
      });
      expect(result).toEqual([
        { id: 'opencode-go/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ]);
    });

    it('未配置凭据的付费模型不返回，仅免费或已配置模型可见', async () => {
      const freeRow = {
        id: 'md_free',
        providerID: 'opencode',
        modelID: 'free-model',
        name: 'Free',
      };
      const localRow = {
        id: 'md_local',
        providerID: 'ollama',
        modelID: 'local-model',
        name: 'Local',
        providerType: 'local',
      };
      const paidNoCredRow = {
        id: 'md_paid',
        providerID: 'opencode-go',
        modelID: 'paid-model',
        name: 'Paid',
      };
      const paidWithCredRow = {
        id: 'md_paid2',
        providerID: 'zhipu',
        modelID: 'paid2',
        name: 'Paid2',
      };
      prisma.model.findMany.mockResolvedValue([
        freeRow,
        localRow,
        paidNoCredRow,
        paidWithCredRow,
      ]);
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'zhipu' },
      ]);
      prisma.workerModelAvailability.findMany.mockResolvedValue([
        { modelId: 'md_free' },
        { modelId: 'md_local' },
        { modelId: 'md_paid' },
        { modelId: 'md_paid2' },
      ]);

      const result = await service.listCatalogModels();

      expect(result).toEqual([
        { id: 'opencode/free-model', name: 'Free' },
        { id: 'ollama/local-model', name: 'Local' },
        { id: 'zhipu/paid2', name: 'Paid2' },
      ]);
      expect(
        result.find((r) => r.id === 'opencode-go/paid-model'),
      ).toBeUndefined();
    });

    it('models-sync：无 availability 的行不进 dropdown（sync 删孤儿 availability 即隐藏）', async () => {
      prisma.model.findMany.mockResolvedValue([
        {
          id: 'md_live',
          providerID: 'opencode',
          modelID: 'big-pickle',
          name: 'Big Pickle',
        },
        {
          id: 'md_stale',
          providerID: 'opencode',
          modelID: 'stale-x',
          name: 'Stale',
        },
      ]);
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.workerModelAvailability.findMany.mockResolvedValue([
        { modelId: 'md_live' },
      ]);

      const result = await service.listCatalogModels();

      expect(result).toEqual([
        { id: 'opencode/big-pickle', name: 'Big Pickle' },
      ]);
    });
  });

  describe('syncLiveModels（live 拉取 + 孤儿禁用：sync-then-list 一致性）', () => {
    const realFetch = (globalThis as any).fetch;

    afterEach(() => {
      (globalThis as any).fetch = realFetch;
    });

    it('models-sync：live 上架启用 + stale 孤儿禁用并删 availability（list 随后仅见 live）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        { id: 'w_0000000001', capabilities: { baseUrl: 'http://worker:4199' } },
      ]);
      (globalThis as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'big-pickle',
              providerID: 'opencode',
              status: 'active',
              enabled: true,
            },
          ],
        }),
      });
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockResolvedValue({
        ...modelRowFull,
        id: 'md_0000000001',
        providerID: 'opencode',
        modelID: 'big-pickle',
      });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.model.findMany.mockResolvedValue([
        { id: 'md_stale', providerID: 'opencode', providerType: 'cloud' },
      ]);
      prisma.model.update.mockResolvedValue({});
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.syncLiveModels();

      expect(result).toEqual({
        synced: 1,
        disabled: 1,
        liveModels: ['opencode/big-pickle'],
      });
      expect(prisma.model.update).toHaveBeenCalledWith({
        where: { id: 'md_stale' },
        data: { enabled: false },
      });
      expect(prisma.workerModelAvailability.deleteMany).toHaveBeenCalledWith({
        where: { modelId: 'md_stale' },
      });
    });

    it('models-sync：无在线 worker → 空结果不剪枝（offline 不误删）', async () => {
      prisma.worker.findMany.mockResolvedValue([]);

      const result = await service.syncLiveModels();

      expect(result).toEqual({ synced: 0, disabled: 0, liveModels: [] });
      expect(prisma.model.update).not.toHaveBeenCalled();
      expect(prisma.workerModelAvailability.deleteMany).not.toHaveBeenCalled();
    });

    it('models-truth：worker 上报 executableModels（opencode models CLI 真值）→ sync 优先采用，不再拉取 stale /api/model', async () => {
      const executableModels = [
        'opencode/big-pickle',
        'opencode/ling-3.0-flash-fin-free',
        'opencode/mimo-v2.5-free',
        'opencode/muse-spark-1.2-contributor-free',
        'opencode/muse-spark-1.3-contributor-free',
        'opencode/nemotron-3-ultra-free',
        'opencode/nemotron-3.5-lightning-free',
      ];
      prisma.worker.findMany.mockResolvedValue([
        {
          id: 'w_0000000001',
          capabilities: {
            baseUrl: 'http://worker:4199',
            executableModels,
          },
        },
      ]);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'ling-3.0-tiny-free',
              providerID: 'opencode',
              status: 'active',
              enabled: true,
            },
          ],
        }),
      });
      (globalThis as any).fetch = fetchMock;
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockImplementation(async (args: any) => ({
        ...modelRowFull,
        id: `md_new_${args.data.modelID}`,
        providerID: args.data.providerID,
        modelID: args.data.modelID,
      }));
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.model.findMany.mockResolvedValue([]);
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.syncLiveModels();

      // 上报 worker 免拉取：stale serve 注册表不再作为真值
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.liveModels).toEqual(executableModels);
      expect(result.synced).toBe(executableModels.length);
      expect(result.disabled).toBe(0);
    });

    it('models-truth：上报 worker 的 executableModels 含非法行 → 仅合法 provider/model 行进入 live 集', async () => {
      prisma.worker.findMany.mockResolvedValue([
        {
          id: 'w_0000000001',
          capabilities: {
            baseUrl: 'http://worker:4199',
            executableModels: [
              'opencode/big-pickle',
              '',
              'junk-without-slash',
              null,
              42,
            ],
          },
        },
      ]);
      const fetchMock = jest.fn();
      (globalThis as any).fetch = fetchMock;
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockImplementation(async (args: any) => ({
        ...modelRowFull,
        id: `md_new_${args.data.modelID}`,
        providerID: args.data.providerID,
        modelID: args.data.modelID,
      }));
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.model.findMany.mockResolvedValue([]);
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.syncLiveModels();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.liveModels).toEqual(['opencode/big-pickle']);
    });

    it('models-truth：旧 worker 未上报 executableModels → 回退 /api/model 拉取（兼容）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        { id: 'w_0000000001', capabilities: { baseUrl: 'http://worker:4199' } },
      ]);
      (globalThis as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'big-pickle',
              providerID: 'opencode',
              status: 'active',
              enabled: true,
            },
          ],
        }),
      });
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockResolvedValue({
        ...modelRowFull,
        id: 'md_0000000001',
        providerID: 'opencode',
        modelID: 'big-pickle',
      });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.model.findMany.mockResolvedValue([]);
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.syncLiveModels();

      expect(result).toEqual({
        synced: 1,
        disabled: 0,
        liveModels: ['opencode/big-pickle'],
      });
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
        expect.objectContaining({
          data: expect.objectContaining({ providerID: 'opencode-go' }),
        }),
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
      expect(result).toMatchObject({
        fingerprint: 'sk-n****xxxx',
        revokedAt: null,
      });
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
      // setCredential 流程中 prisma.model.findMany 有两个用途：
      // providerType 查询（select.providerType）与 C6 配置全量查询（其余）
      prisma.model.findMany.mockImplementation(
        async (args?: { select?: { providerType?: boolean } }) =>
          args?.select?.providerType ? [{ providerType: 'cloud' }] : [],
      );
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);
      prisma.modelCredential.findMany.mockResolvedValue([credentialRow]);

      await service.setCredential('md_0000000001', 'sk-raw-token');

      expect(workers.dispatchModelCredentials).toHaveBeenCalledWith(
        [{ providerID: 'opencode-go', key: 'sk-raw-token' }],
        undefined,
        {},
      );
    });

    it('C5：targetWorkerIds 非空时定向传递到 WorkersService.dispatchModelCredentials', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.model.findMany.mockImplementation(
        async (args?: { select?: { providerType?: boolean } }) =>
          args?.select?.providerType ? [{ providerType: 'cloud' }] : [],
      );
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);
      prisma.modelCredential.findMany.mockResolvedValue([credentialRow]);

      await service.setCredential(
        'md_0000000001',
        'sk-raw-token',
        'opencode-go',
        ['w_0000000001'],
      );

      expect(workers.dispatchModelCredentials).toHaveBeenCalledWith(
        [{ providerID: 'opencode-go', key: 'sk-raw-token' }],
        ['w_0000000001'],
        {},
      );
    });

    it('C6：local provider 保存凭据 → 下发负载携带该 provider 的 baseUrl + models 配置', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.model.findMany.mockImplementation(
        async (args?: { select?: { providerType?: boolean } }) =>
          args?.select?.providerType
            ? [{ providerType: 'local' }]
            : [
                {
                  providerID: 'opencode-go',
                  modelID: 'deepseek-v4-flash',
                  baseUrl: 'http://192.168.10.10:18020/v1',
                },
              ],
      );
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);
      prisma.modelCredential.findMany.mockResolvedValue([credentialRow]);
      // 空 token + local → local-noop 占位凭据路径（decrypt mock 对齐落库值）
      crypto.decrypt.mockReturnValue('local-noop');
      await service.setCredential('md_0000000001', '');

      expect(workers.dispatchModelCredentials).toHaveBeenCalledWith(
        [{ providerID: 'opencode-go', key: 'local-noop' }],
        undefined,
        {
          'opencode-go': {
            baseUrl: 'http://192.168.10.10:18020/v1',
            models: { 'deepseek-v4-flash': {} },
          },
        },
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

      const result = await service.setCredential(
        'md_0000000001',
        'sk-raw-token',
      );

      expect(result).toMatchObject({ configured: true });
      warnSpy.mockRestore();
    });
  });

  describe('models-credential（凭据变更即时收敛可见性）', () => {
    it('setCredential 保存成功后触发 syncLiveModels（未配前被禁用的凭据模型随 sync 回 enable）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.model.findMany.mockResolvedValue([{ providerType: 'cloud' }]);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);
      const syncSpy = jest
        .spyOn(service, 'syncLiveModels')
        .mockResolvedValue({ synced: 1, disabled: 0, liveModels: [] });

      await service.setCredential('md_0000000001', 'sk-raw-token');

      expect(syncSpy).toHaveBeenCalledTimes(1);
      syncSpy.mockRestore();
    });

    it('setCredential 后 sync 失败不阻断保存（返回脱敏视图）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.model.findMany.mockResolvedValue([{ providerType: 'cloud' }]);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);
      const syncSpy = jest
        .spyOn(service, 'syncLiveModels')
        .mockRejectedValue(new Error('sync offline'));
      const warnSpy = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => {});

      const result = await service.setCredential(
        'md_0000000001',
        'sk-raw-token',
      );

      expect(result).toMatchObject({ configured: true });
      expect(syncSpy).toHaveBeenCalledTimes(1);
      syncSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('revokeCredential 后触发 syncLiveModels（吊销即时剪枝）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.modelCredential.findUnique.mockResolvedValue(credentialRow);
      prisma.modelCredential.update.mockResolvedValue({
        ...credentialRow,
        revokedAt: new Date(),
      });
      const syncSpy = jest
        .spyOn(service, 'syncLiveModels')
        .mockResolvedValue({ synced: 0, disabled: 1, liveModels: [] });

      await service.revokeCredential('md_0000000001');

      expect(syncSpy).toHaveBeenCalledTimes(1);
      syncSpy.mockRestore();
    });

    it('revokeCredentialByProvider 后触发 syncLiveModels', async () => {
      prisma.modelCredential.findUnique.mockResolvedValue(credentialRow);
      prisma.modelCredential.update.mockResolvedValue({
        ...credentialRow,
        revokedAt: new Date(),
      });
      const syncSpy = jest
        .spyOn(service, 'syncLiveModels')
        .mockResolvedValue({ synced: 0, disabled: 1, liveModels: [] });

      await service.revokeCredentialByProvider('opencode-go');

      expect(syncSpy).toHaveBeenCalledTimes(1);
      syncSpy.mockRestore();
    });
  });

  describe('credentialed provider visibility（凭据即访问证明，live 探针缺席不隐藏）', () => {
    it('setCredential 保存成功后回 enable 该 provider 全量行 + 为在线 worker 补 availability', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.model.findMany
        .mockResolvedValueOnce([{ providerType: 'cloud' }])
        .mockResolvedValueOnce([
          { id: 'md_0000000001' },
          { id: 'md_0000000002' },
        ]);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);
      prisma.worker.findMany.mockResolvedValue([{ id: 'w_0000000001' }]);
      prisma.model.updateMany.mockResolvedValue({ count: 2 });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      const syncSpy = jest
        .spyOn(service, 'syncLiveModels')
        .mockResolvedValue({ synced: 0, disabled: 0, liveModels: [] });

      await service.setCredential('md_0000000001', 'sk-raw-token');

      expect(prisma.model.updateMany).toHaveBeenCalledWith({
        where: { providerID: 'opencode-go', enabled: false },
        data: { enabled: true },
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
      expect(syncSpy).toHaveBeenCalledTimes(1);
      syncSpy.mockRestore();
    });

    it('setCredential 定向 targetWorkerIds 时仅为指定 worker 补 availability（不查在线 worker）', async () => {
      prisma.model.findUnique.mockResolvedValue(modelRow);
      prisma.model.findMany
        .mockResolvedValueOnce([{ providerType: 'cloud' }])
        .mockResolvedValueOnce([{ id: 'md_0000000001' }]);
      prisma.modelCredential.findUnique.mockResolvedValue(null);
      prisma.modelCredential.create.mockResolvedValue(credentialRow);
      prisma.model.updateMany.mockResolvedValue({ count: 1 });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      const syncSpy = jest
        .spyOn(service, 'syncLiveModels')
        .mockResolvedValue({ synced: 0, disabled: 0, liveModels: [] });

      await service.setCredential(
        'md_0000000001',
        'sk-raw-token',
        'opencode-go',
        ['w_0000000009'],
      );

      expect(prisma.worker.findMany).not.toHaveBeenCalled();
      expect(prisma.workerModelAvailability.upsert).toHaveBeenCalledWith({
        where: {
          workerId_modelId: {
            workerId: 'w_0000000009',
            modelId: 'md_0000000001',
          },
        },
        create: { workerId: 'w_0000000009', modelId: 'md_0000000001' },
        update: {},
      });
      syncSpy.mockRestore();
    });

    it('syncLiveModels 孤儿剪枝跳过有未吊销凭据的 provider（无条件，凭据 beats 探针）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        {
          id: 'w_0000000001',
          capabilities: { executableModels: ['opencode/big-pickle'] },
        },
      ]);
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockResolvedValue({
        ...modelRowFull,
        id: 'md_live',
        providerID: 'opencode',
        modelID: 'big-pickle',
      });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go' },
      ]);
      prisma.model.findMany.mockResolvedValue([
        { id: 'md_go1', providerID: 'opencode-go', providerType: 'cloud' },
        { id: 'md_zhi', providerID: 'zhipu', providerType: 'cloud' },
      ]);
      prisma.model.update.mockResolvedValue({});
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.syncLiveModels();

      expect(prisma.model.update).not.toHaveBeenCalledWith({
        where: { id: 'md_go1' },
        data: { enabled: false },
      });
      expect(prisma.model.update).toHaveBeenCalledWith({
        where: { id: 'md_zhi' },
        data: { enabled: false },
      });
      expect(result.disabled).toBe(1);
    });

    it('syncLiveModels 无凭据 provider 的孤儿仍被剪枝（含 opencode 免费特殊-case 不变）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        {
          id: 'w_0000000001',
          capabilities: { executableModels: ['opencode/big-pickle'] },
        },
      ]);
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.model.create.mockResolvedValue({
        ...modelRowFull,
        id: 'md_live',
        providerID: 'opencode',
        modelID: 'big-pickle',
      });
      prisma.workerModelAvailability.upsert.mockResolvedValue({});
      prisma.modelCredential.findMany.mockResolvedValue([]);
      prisma.model.findMany.mockResolvedValue([
        { id: 'md_go1', providerID: 'opencode-go', providerType: 'cloud' },
        { id: 'md_free', providerID: 'opencode', providerType: 'cloud' },
      ]);
      prisma.model.update.mockResolvedValue({});
      prisma.workerModelAvailability.deleteMany.mockResolvedValue({ count: 2 });

      const result = await service.syncLiveModels();

      expect(prisma.model.update).toHaveBeenCalledWith({
        where: { id: 'md_go1' },
        data: { enabled: false },
      });
      expect(prisma.model.update).toHaveBeenCalledWith({
        where: { id: 'md_free' },
        data: { enabled: false },
      });
      expect(result.disabled).toBe(2);
    });

    it('listCatalogModels 含已配凭据 provider 的 enabled 行（即使零 availability 行）；吊销/未配仍隐藏', async () => {
      prisma.model.findMany.mockResolvedValue([
        {
          id: 'md_go1',
          providerID: 'opencode-go',
          modelID: 'paid-model',
          name: 'Paid',
        },
        {
          id: 'md_rev',
          providerID: 'revoked-p',
          modelID: 'rev-model',
          name: 'Revoked',
        },
      ]);
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go' },
      ]);
      prisma.workerModelAvailability.findMany.mockResolvedValue([
        { modelId: 'md_rev' },
      ]);

      const result = await service.listCatalogModels();

      expect(result).toEqual([{ id: 'opencode-go/paid-model', name: 'Paid' }]);
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

  describe('revokeCredentialByProvider（DELETE 按 provider 粒度软吊销）', () => {
    it('有凭据：直接按 providerID 吊销，不查 model 行', async () => {
      const now = new Date('2026-08-08T11:00:00Z');
      jest.spyOn(global, 'Date').mockImplementation(() => now as never);
      prisma.modelCredential.findUnique.mockResolvedValue(credentialRow);
      prisma.modelCredential.update.mockResolvedValue({
        ...credentialRow,
        revokedAt: now,
      });

      const result = await service.revokeCredentialByProvider('opencode-go');

      expect(prisma.model.findUnique).not.toHaveBeenCalled();
      expect(prisma.modelCredential.findUnique).toHaveBeenCalledWith({
        where: { providerID: 'opencode-go' },
      });
      expect(prisma.modelCredential.update).toHaveBeenCalledWith({
        where: { providerID: 'opencode-go' },
        data: { revokedAt: now },
      });
      expect(result).toMatchObject({ configured: false, revokedAt: now });
      (global.Date as unknown as jest.Mock).mockRestore();
    });

    it('无凭据 → 404 MODEL_CREDENTIAL_NOT_FOUND（不触发 update）', async () => {
      prisma.modelCredential.findUnique.mockResolvedValue(null);

      await expect(
        service.revokeCredentialByProvider('opencode'),
      ).rejects.toMatchObject({
        response: { code: MODEL_ERRORS.MODEL_CREDENTIAL_NOT_FOUND },
      });
      expect(prisma.modelCredential.update).not.toHaveBeenCalled();
    });

    it('model 不存在（worker-only provider）也能按 provider 删——不依赖 model 行', async () => {
      prisma.model.findUnique.mockResolvedValue(null);
      prisma.modelCredential.findUnique.mockResolvedValue(credentialRow);
      prisma.modelCredential.update.mockResolvedValue({
        ...credentialRow,
        revokedAt: new Date('2026-08-08T12:00:00Z'),
      });

      const result = await service.revokeCredentialByProvider('opencode-go');

      expect(prisma.model.findUnique).not.toHaveBeenCalled();
      expect(result).toMatchObject({ configured: false });
      expect(prisma.modelCredential.update).toHaveBeenCalled();
    });
  });
});
