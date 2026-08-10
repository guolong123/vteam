import {
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { ModelsService } from '../models/models.service';
import { HeartbeatWorkerDto } from './dto/heartbeat-worker.dto';
import { RegisterWorkerDto } from './dto/register-worker.dto';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_OFFLINE_TIMEOUT_MS,
  WORKER_STATUS,
} from './workers.constants';
import { WorkersService } from './workers.service';

jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));
import * as bcrypt from 'bcrypt';
const mockBcryptHash = bcrypt.hash as jest.Mock;
const mockBcryptCompare = bcrypt.compare as jest.Mock;

describe('WorkersService', () => {
  let service: WorkersService;
  let prisma: {
    worker: {
      upsert: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    modelCredential: {
      findMany: jest.Mock;
    };
  };
  let mcpServers: { applyHeartbeatStatus: jest.Mock };
  let credentialCrypto: { decrypt: jest.Mock };
  let modelsService: {
    syncFromWorkerCapabilities: jest.Mock;
    findCatalogByRef: jest.Mock;
  };

  /** 构造一个 Worker 行（prisma findMany/findUnique 返回值）。 */
  const workerRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'w_0000000001',
    name: 'worker-1',
    opencodeVersion: '1.18.14',
    capabilities: { maxInstances: 5, skills: ['coding'], tools: ['git'] },
    load: { instances: 1 },
    status: WORKER_STATUS.ONLINE,
    tokenHash: 'hashed-token',
    lastHeartbeatAt: new Date('2026-08-08T00:00:00Z'),
    registeredAt: new Date('2026-08-08T00:00:00Z'),
    defaultModelId: null,
    ...overrides,
  });

  const registerDto = () => {
    const dto = new RegisterWorkerDto();
    dto.workerId = 'w_0000000001';
    dto.name = 'worker-1';
    dto.opencodeVersion = '1.18.14';
    dto.capabilities = { maxInstances: 5, skills: ['coding'], tools: ['git'] };
    dto.load = { instances: 1 };
    return dto;
  };

  beforeEach(async () => {
    mockBcryptHash.mockReset().mockResolvedValue('hashed-token');
    mockBcryptCompare.mockReset().mockResolvedValue(true);
    prisma = {
      worker: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      modelCredential: {
        findMany: jest.fn(),
      },
    };

    mcpServers = { applyHeartbeatStatus: jest.fn() };
    credentialCrypto = { decrypt: jest.fn().mockReturnValue('sk-raw-token') };
    modelsService = {
      syncFromWorkerCapabilities: jest.fn().mockResolvedValue(2),
      findCatalogByRef: jest.fn().mockResolvedValue({
        id: 'md_0000000001',
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        enabled: true,
      }),
    };
    prisma.modelCredential.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: prisma },
        { provide: McpServersService, useValue: mcpServers },
        { provide: CredentialCryptoService, useValue: credentialCrypto },
        { provide: ModelsService, useValue: modelsService },
      ],
    }).compile();

    service = module.get<WorkersService>(WorkersService);
  });

  describe('register（WorkerRegistry）', () => {
    it('新 worker 走 upsert create：tokenHash=bcrypt(token)、status=online、lastHeartbeatAt=now，返回协议字段', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      const dto = registerDto();

      const result = await service.register('secret-token', dto);

      expect(mockBcryptHash).toHaveBeenCalledWith('secret-token', 10);
      const [args] = prisma.worker.upsert.mock.calls[0];
      expect(args.where).toEqual({ id: 'w_0000000001' });
      expect(args.create).toMatchObject({
        id: 'w_0000000001',
        name: 'worker-1',
        opencodeVersion: '1.18.14',
        capabilities: { maxInstances: 5 },
        tokenHash: 'hashed-token',
        status: WORKER_STATUS.ONLINE,
      });
      expect(args.create.lastHeartbeatAt).toBeInstanceOf(Date);
      expect(result).toEqual({
        workerId: 'w_0000000001',
        heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
        serverTime: expect.any(String),
      });
    });

    it('重复注册走 upsert update：刷新 tokenHash/能力/负载/心跳，不丢 workerId', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow({ name: null }));
      const dto = registerDto();
      dto.name = undefined;

      const result = await service.register('new-secret', dto);

      const [args] = prisma.worker.upsert.mock.calls[0];
      expect(args.update).toMatchObject({
        name: null,
        opencodeVersion: '1.18.14',
        tokenHash: 'hashed-token',
        status: WORKER_STATUS.ONLINE,
      });
      expect(args.create.id).toBe('w_0000000001');
      expect(result.workerId).toBe('w_0000000001');
    });

    it('C2：worker 上报 defaultModelId/models 时落库（capabilities 整块含 models，defaultModelId 独立列）', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      const dto = registerDto();
      dto.capabilities = {
        maxInstances: 5,
        skills: [],
        tools: [],
        models: ['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1'],
      };
      dto.defaultModelId = 'opencode-go/deepseek-v4-flash';

      await service.register('secret-token', dto);

      const [args] = prisma.worker.upsert.mock.calls[0];
      expect(args.create.capabilities).toEqual({
        maxInstances: 5,
        skills: [],
        tools: [],
        models: ['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1'],
      });
      expect(args.create.defaultModelId).toBe('opencode-go/deepseek-v4-flash');
      expect(args.update.defaultModelId).toBe('opencode-go/deepseek-v4-flash');
    });

    it('C2：worker 未上报 defaultModelId 时不覆盖已有值（旧 worker 重注册不误清 C8/PATCH 配置）', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      const dto = registerDto();

      await service.register('secret-token', dto);

      const [args] = prisma.worker.upsert.mock.calls[0];
      expect(args.create.defaultModelId).toBeUndefined();
      expect(args.update.defaultModelId).toBeUndefined();
    });

    it('C3（集成验收）：worker 上报 capabilities.models → syncFromWorkerCapabilities 透传（目录 + availability 落库链路）', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      const dto = registerDto();
      dto.capabilities = {
        maxInstances: 5,
        skills: [],
        tools: [],
        models: ['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1'],
      };

      await service.register('secret-token', dto);

      // 注册落库后调用合并入库（workerId + 原始 models 数组透传）
      expect(modelsService.syncFromWorkerCapabilities).toHaveBeenCalledWith(
        'w_0000000001',
        ['opencode-go/deepseek-v4-flash', 'opencode/glm-5.1'],
      );
    });

    it('C3：worker 未上报 models（降级缺省）→ syncFromWorkerCapabilities 仍调用但收到 undefined（保留旧数据）', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      const dto = registerDto();

      await service.register('secret-token', dto);

      expect(modelsService.syncFromWorkerCapabilities).toHaveBeenCalledWith(
        'w_0000000001',
        undefined,
      );
    });

    it('C3：syncFromWorkerCapabilities 抛错不阻断注册（warn 可观测，worker 仍上线）', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      modelsService.syncFromWorkerCapabilities.mockRejectedValue(
        new Error('DB down'),
      );
      const dto = registerDto();

      const result = await service.register('secret-token', dto);

      expect(result.workerId).toBe('w_0000000001');
      expect(modelsService.syncFromWorkerCapabilities).toHaveBeenCalled();
    });

    it('C5（R5）：注册成功后回放全部未吊销凭据（decrypt + enqueueCommand）', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go', credentialRef: 'iv:tag:data1' },
        { providerID: 'opencode', credentialRef: 'iv:tag:data2' },
      ]);
      const dto = registerDto();

      await service.register('secret-token', dto);

      expect(prisma.modelCredential.findMany).toHaveBeenCalledWith({
        where: { revokedAt: null },
        select: { providerID: true, credentialRef: true },
      });
      expect(credentialCrypto.decrypt).toHaveBeenCalledWith('iv:tag:data1');
      expect(credentialCrypto.decrypt).toHaveBeenCalledWith('iv:tag:data2');
      expect(service['pendingCommands'].get('w_0000000001')).toEqual([
        {
          type: 'model-credentials',
          resourceVersion: 'model-credentials',
          payload: {
            providerKeys: [
              { providerID: 'opencode-go', key: 'sk-raw-token' },
              { providerID: 'opencode', key: 'sk-raw-token' },
            ],
          },
        },
      ]);
    });

    it('C5（R5）：无未吊销凭据时注册不产生命令', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      prisma.modelCredential.findMany.mockResolvedValue([]);
      const dto = registerDto();

      await service.register('secret-token', dto);

      expect(service['pendingCommands'].has('w_0000000001')).toBe(false);
    });

    it('B1：首次注册（原不存在）→ 回放未吊销凭据', async () => {
      prisma.worker.findUnique.mockResolvedValue(null);
      prisma.worker.upsert.mockResolvedValue(workerRow());
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go', credentialRef: 'iv:tag:data1' },
      ]);
      const dto = registerDto();

      await service.register('secret-token', dto);

      expect(prisma.modelCredential.findMany).toHaveBeenCalled();
      expect(service['pendingCommands'].get('w_0000000001')).toHaveLength(1);
    });

    it('B1：已在线 worker reRegister（serve 重启触发）→ 不回放，切断循环', async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: WORKER_STATUS.ONLINE,
      });
      prisma.worker.upsert.mockResolvedValue(workerRow());
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go', credentialRef: 'iv:tag:data1' },
      ]);
      const dto = registerDto();

      await service.register('secret-token', dto);

      expect(prisma.modelCredential.findMany).not.toHaveBeenCalled();
      expect(service['pendingCommands'].has('w_0000000001')).toBe(false);
    });

    it('B1：原 offline worker reRegister（离线恢复上线）→ 回放凭据', async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: WORKER_STATUS.OFFLINE,
      });
      prisma.worker.upsert.mockResolvedValue(workerRow());
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go', credentialRef: 'iv:tag:data1' },
      ]);
      const dto = registerDto();

      await service.register('secret-token', dto);

      expect(prisma.modelCredential.findMany).toHaveBeenCalled();
      expect(service['pendingCommands'].get('w_0000000001')).toHaveLength(1);
    });

    it('B1：循环不复现——首次注册回放一次，在线 reRegister 不再入队（幂等）', async () => {
      // 首次注册：原不存在 → 回放入队 1 条
      prisma.worker.findUnique.mockResolvedValueOnce(null);
      // 凭据生效后 serve 重启触发 reRegister：worker 已在线 → 不回放
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        status: WORKER_STATUS.ONLINE,
      });
      prisma.worker.upsert.mockResolvedValue(workerRow());
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go', credentialRef: 'iv:tag:data1' },
      ]);
      const dto = registerDto();

      await service.register('secret-token', dto);
      await service.register('secret-token', dto);

      // 回放只发生一次（仅首次），reRegister 不产生新命令 → 命令不累积
      expect(prisma.modelCredential.findMany).toHaveBeenCalledTimes(1);
      expect(service['pendingCommands'].get('w_0000000001')).toHaveLength(1);
    });

    it('C5（R5）：回放失败（解密抛错）不阻断注册', async () => {
      prisma.worker.upsert.mockResolvedValue(workerRow());
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go', credentialRef: 'bad-ref' },
      ]);
      credentialCrypto.decrypt.mockImplementation(() => {
        throw new Error('decrypt failed');
      });
      const warnSpy = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => {});
      const dto = registerDto();

      await expect(service.register('secret-token', dto)).resolves.toMatchObject({
        workerId: 'w_0000000001',
      });
      expect(service['pendingCommands'].has('w_0000000001')).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe('heartbeat', () => {
    it('ok 心跳：更新 load + status=online + lastHeartbeatAt，返回 {workerId, status, lastHeartbeatAt}', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 2 },
        health: 'ok',
      };

      const result = await service.heartbeat('w_0000000001', dto);

      expect(prisma.worker.update).toHaveBeenCalledWith({
        where: { id: 'w_0000000001' },
        data: {
          load: { instances: 2 },
          status: WORKER_STATUS.ONLINE,
          lastHeartbeatAt: expect.any(Date),
        },
      });
      expect(result).toMatchObject({
        workerId: 'w_0000000001',
        status: WORKER_STATUS.ONLINE,
      });
    });

    it('degraded 心跳：status=degraded（存活但降权）', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 3 },
        health: 'degraded',
      };

      await service.heartbeat('w_0000000001', dto);

      expect(prisma.worker.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: WORKER_STATUS.DEGRADED }),
        }),
      );
    });

    it('T8c：携带 mcpStatus 时透传 applyHeartbeatStatus 存储 MCP 三态', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
        mcpStatus: [
          { serverName: 'gitee-ent', status: 'connected' },
          { serverName: 'test-bad-local', status: 'failed' },
        ],
      };

      await service.heartbeat('w_0000000001', dto);

      expect(mcpServers.applyHeartbeatStatus).toHaveBeenCalledWith(dto.mcpStatus);
      expect(prisma.worker.update).toHaveBeenCalled();
    });

    it('T8c：不携带 mcpStatus（旧 worker）不触发状态存储', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      await service.heartbeat('w_0000000001', dto);

      expect(mcpServers.applyHeartbeatStatus).not.toHaveBeenCalled();
    });

    it('T9：携带 mcpStatus 时按 workerId 关联保存（worker 详情接口可查）', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
        mcpStatus: [
          { serverName: 'gitee-ent', status: 'connected' },
          { serverName: 'test-bad-local', status: 'failed' },
        ],
      };

      await service.heartbeat('w_0000000001', dto);

      expect(service['workerMcpStatus'].get('w_0000000001')).toEqual(dto.mcpStatus);
    });

    it('T9：不携带 mcpStatus 时不写入该 worker 的关联状态（旧 worker 兼容）', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      await service.heartbeat('w_0000000001', dto);

      expect(service['workerMcpStatus'].has('w_0000000001')).toBe(false);
    });

    it('worker 未注册 → 404 WORKER_NOT_FOUND', async () => {
      prisma.worker.findUnique.mockResolvedValue(null);
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_unknown',
        load: { instances: 0 },
        health: 'ok',
      };

      await expect(service.heartbeat('w_unknown', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.worker.update).not.toHaveBeenCalled();
    });

    it('F2 M2：token 与注册 tokenHash 不匹配 → 401 WORKER_TOKEN_INVALID，不更新', async () => {
      mockBcryptCompare.mockResolvedValue(false);
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        tokenHash: 'hashed-other-token',
      });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      await expect(
        service.heartbeat('w_0000000001', dto, 'wrong-token'),
      ).rejects.toMatchObject({
        response: { code: 'WORKER_TOKEN_INVALID' },
      });
      expect(mockBcryptCompare).toHaveBeenCalledWith(
        'wrong-token',
        'hashed-other-token',
      );
      expect(prisma.worker.update).not.toHaveBeenCalled();
    });

    it('F2 M2：token 与 tokenHash 匹配 → 正常更新心跳', async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        tokenHash: 'hashed-token',
      });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      await service.heartbeat('w_0000000001', dto, 'secret-token');

      expect(mockBcryptCompare).toHaveBeenCalledWith(
        'secret-token',
        'hashed-token',
      );
      expect(prisma.worker.update).toHaveBeenCalled();
    });

    it('T4a：无待执行命令时响应不携带 commands 字段', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      const result = await service.heartbeat('w_0000000001', dto);

      expect(result).toMatchObject({
        workerId: 'w_0000000001',
        status: WORKER_STATUS.ONLINE,
        lastHeartbeatAt: expect.any(String),
      });
      expect(result.commands).toBeUndefined();
    });

    it('T4a：enqueueCommand 后心跳返回 commands，取出即清空（命令一次有效）', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      service.enqueueCommand('w_0000000001', {
        type: 'reload-config',
        resourceVersion: 'v2',
      });

      const result = await service.heartbeat('w_0000000001', dto);
      expect(result.commands).toEqual([
        { type: 'reload-config', resourceVersion: 'v2' },
      ]);

      // 取出即清空：第二次心跳不再携带
      const second = await service.heartbeat('w_0000000001', dto);
      expect(second.commands).toBeUndefined();
    });

    it('T4a：多次入队累积为数组，一次心跳全部下发', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      service.enqueueCommand('w_0000000001', {
        type: 'reload-config',
        resourceVersion: 'v1',
      });
      service.enqueueCommand('w_0000000001', {
        type: 'reload-config',
        resourceVersion: 'v2',
      });

      const result = await service.heartbeat('w_0000000001', dto);

      expect(result.commands).toEqual([
        { type: 'reload-config', resourceVersion: 'v1' },
        { type: 'reload-config', resourceVersion: 'v2' },
      ]);
    });

    it('T4a：不同 worker 的命令互不串扰', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      service.enqueueCommand('w_0000000002', {
        type: 'reload-config',
        resourceVersion: 'v9',
      });

      const result = await service.heartbeat('w_0000000001', dto);

      expect(result.commands).toBeUndefined();
      expect(service['pendingCommands'].get('w_0000000002')).toHaveLength(1);
    });

    it('C5（R5）：worker 从 offline 恢复上线 → 回放未吊销凭据（离线期间保存的凭据补发）', async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        tokenHash: 'hashed-token',
        status: WORKER_STATUS.OFFLINE,
      });
      prisma.worker.update.mockResolvedValue({});
      prisma.modelCredential.findMany.mockResolvedValue([
        { providerID: 'opencode-go', credentialRef: 'iv:tag:data1' },
      ]);
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      const result = await service.heartbeat('w_0000000001', dto);

      expect(prisma.modelCredential.findMany).toHaveBeenCalledWith({
        where: { revokedAt: null },
        select: { providerID: true, credentialRef: true },
      });
      // 回放命令经本次心跳响应携带（取出即清空，一次有效）
      expect(result.commands).toEqual([
        {
          type: 'model-credentials',
          resourceVersion: 'model-credentials',
          payload: {
            providerKeys: [{ providerID: 'opencode-go', key: 'sk-raw-token' }],
          },
        },
      ]);
    });

    it('C5（R5）：一直 online 的心跳不重复回放（避免每 10s 重启 serve）', async () => {
      prisma.worker.findUnique.mockResolvedValue({
        id: 'w_0000000001',
        tokenHash: 'hashed-token',
        status: WORKER_STATUS.ONLINE,
      });
      prisma.worker.update.mockResolvedValue({});
      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };

      await service.heartbeat('w_0000000001', dto);

      expect(prisma.modelCredential.findMany).not.toHaveBeenCalled();
    });
  });

  describe('broadcastCommand（F1 MAJOR：资源变更广播 reload-config）', () => {
    const command = { type: 'reload-config' as const, resourceVersion: 'v3' };

    it('对全部在线 worker 逐个入队，返回广播数', async () => {
      prisma.worker.findMany.mockResolvedValue([
        { id: 'w_0000000001' },
        { id: 'w_0000000002' },
      ]);
      const spy = jest.spyOn(service, 'enqueueCommand');

      const n = await service.broadcastCommand(command);

      expect(prisma.worker.findMany).toHaveBeenCalledWith({
        where: { status: { not: WORKER_STATUS.OFFLINE } },
        select: { id: true },
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith('w_0000000001', command);
      expect(spy).toHaveBeenCalledWith('w_0000000002', command);
      expect(n).toBe(2);
    });

    it('无在线 worker 时静默返回 0 不报错', async () => {
      prisma.worker.findMany.mockResolvedValue([]);

      const n = await service.broadcastCommand(command);

      expect(n).toBe(0);
      expect(service['pendingCommands'].size).toBe(0);
    });
  });

  describe('dispatchModelCredentials（C5 凭据下发：定向/全量唯一化分发）', () => {
    const providerKeys = [{ providerID: 'opencode-go', key: 'sk-raw-token' }];

    it('targetWorkerIds 非空 → 定向：enqueueCommand 逐个精确下发，返回目标数', async () => {
      const spy = jest.spyOn(service, 'enqueueCommand');

      const n = await service.dispatchModelCredentials(providerKeys, [
        'w_0000000001',
        'w_0000000002',
      ]);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith('w_0000000001', {
        type: 'model-credentials',
        resourceVersion: 'model-credentials',
        payload: {
          providerKeys,
          targetWorkerIds: ['w_0000000001', 'w_0000000002'],
        },
      });
      expect(spy).toHaveBeenCalledWith('w_0000000002', expect.any(Object));
      expect(n).toBe(2);
    });

    it('targetWorkerIds 为空数组 → 全量：broadcastCommand 原样广播（不改签名）', async () => {
      const broadcastSpy = jest
        .spyOn(service, 'broadcastCommand')
        .mockResolvedValue(3);

      const n = await service.dispatchModelCredentials(providerKeys, []);

      expect(broadcastSpy).toHaveBeenCalledWith({
        type: 'model-credentials',
        resourceVersion: 'model-credentials',
        payload: { providerKeys },
      });
      expect(n).toBe(3);
    });

    it('targetWorkerIds 缺省（undefined）→ 全量广播', async () => {
      const broadcastSpy = jest
        .spyOn(service, 'broadcastCommand')
        .mockResolvedValue(5);

      const n = await service.dispatchModelCredentials(providerKeys);

      expect(n).toBe(5);
    });

    it('全量下发后心跳携带 model-credentials 命令且取出即清空（一次性）', async () => {
      prisma.worker.findMany.mockResolvedValue([{ id: 'w_0000000001' }]);
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});

      await service.dispatchModelCredentials(providerKeys);

      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };
      const result = await service.heartbeat('w_0000000001', dto);
      expect(result.commands).toEqual([
        {
          type: 'model-credentials',
          resourceVersion: 'model-credentials',
          payload: { providerKeys },
        },
      ]);

      const second = await service.heartbeat('w_0000000001', dto);
      expect(second.commands).toBeUndefined();
    });
  });

  describe('HealthChecker', () => {    it('仅更新过期行：where status != offline AND (lastHeartbeatAt IS NULL OR < now-30s)', async () => {
      prisma.worker.findMany.mockResolvedValue([
        { id: 'w_0000000001' },
        { id: 'w_0000000002' },
      ]);
      prisma.worker.updateMany.mockResolvedValue({ count: 2 });

      const count = await service.markStaleWorkersOffline();

      expect(count).toBe(2);
      // T9：先查过期 worker 列表（findMany 同 where 语义）
      expect(prisma.worker.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          status: { not: WORKER_STATUS.OFFLINE },
        }),
        select: { id: true },
      });
      const [args] = prisma.worker.updateMany.mock.calls[0];
      expect(args.where.status).toEqual({ not: WORKER_STATUS.OFFLINE });
      expect(args.where.OR[0]).toEqual({ lastHeartbeatAt: null });
      // 截断时间必须是 now-30s 之前：对 lt 阈值做范围校验（允许毫秒级抖动）
      const cutoff = (args.where.OR[1].lastHeartbeatAt as { lt: Date }).lt;
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - WORKER_OFFLINE_TIMEOUT_MS + 100);
      expect(cutoff.getTime()).toBeGreaterThan(Date.now() - WORKER_OFFLINE_TIMEOUT_MS - 1000);
      expect(args.data).toEqual({ status: WORKER_STATUS.OFFLINE });
    });

    it('T9：无过期 worker 时不触发 updateMany，直接返回 0', async () => {
      prisma.worker.findMany.mockResolvedValue([]);

      const count = await service.markStaleWorkersOffline();

      expect(count).toBe(0);
      expect(prisma.worker.updateMany).not.toHaveBeenCalled();
    });

    it('T9：标记 offline 时同步清理该 worker 的 mcpStatus 内存态', async () => {
      prisma.worker.findMany.mockResolvedValue([{ id: 'w_0000000001' }]);
      prisma.worker.updateMany.mockResolvedValue({ count: 1 });
      service['workerMcpStatus'].set('w_0000000001', [
        { serverName: 'gitee-ent', status: 'connected' },
      ]);

      const count = await service.markStaleWorkersOffline();

      expect(count).toBe(1);
      expect(service['workerMcpStatus'].has('w_0000000001')).toBe(false);
    });

    it('onModuleInit 启动自愈扫描并注册健康检查定时器（onModuleDestroy 清理）', async () => {
      const spy = jest
        .spyOn(service, 'markStaleWorkersOffline')
        .mockResolvedValue(0);

      await service.onModuleInit();
      expect(spy).toHaveBeenCalled();

      service.onModuleDestroy();
      spy.mockRestore();
    });
  });

  describe('assignWorker（Scheduler）', () => {
    it('同状态内按剩余容量降序：负载最少（instances 最小）优先', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ id: 'w_busy', load: { instances: 4 } }),
        workerRow({ id: 'w_idle', load: { instances: 1 } }),
        workerRow({ id: 'w_mid', load: { instances: 3 } }),
      ]);

      const workerId = await service.assignWorker();

      expect(workerId).toBe('w_idle');
    });

    it('按 opencodeVersion 能力匹配：版本不符的 worker 被排除', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ id: 'w_v1', opencodeVersion: '1.17.0' }),
        workerRow({ id: 'w_v2', opencodeVersion: '1.18.14' }),
      ]);

      const workerId = await service.assignWorker({ opencodeVersion: '1.18.14' });

      expect(workerId).toBe('w_v2');
    });

    it('degraded worker 降权：有 online 可用时优先 online，即便 online 负载更高', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ id: 'w_online', load: { instances: 3 } }),
        workerRow({
          id: 'w_degraded',
          status: WORKER_STATUS.DEGRADED,
          load: { instances: 0 },
        }),
      ]);

      const workerId = await service.assignWorker();

      expect(workerId).toBe('w_online');
    });

    it('剩余容量不足需求的 worker 被排除', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ id: 'w_full', load: { instances: 5 } }),
        workerRow({ id: 'w_spare', load: { instances: 3 } }),
      ]);

      // maxInstances=5，需要 3 个槽位：w_spare 容量=2 < 3 被排除，w_full 容量=0 < 3 被排除
      const workerId = await service.assignWorker({ instances: 3 });

      expect(workerId).toBeNull();
    });

    it('load 缺省按 0 处理（null load 仍可被调度）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ id: 'w_noload', load: null }),
      ]);

      const workerId = await service.assignWorker();

      expect(workerId).toBe('w_noload');
    });

    it('无可用 worker → null（D3：调用方报错，不降级 mock）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ status: WORKER_STATUS.OFFLINE }),
      ]);

      const workerId = await service.assignWorker();

      expect(workerId).toBeNull();
    });

    it('C7 按模型过滤：availability 关联模型 providerID/modelID 匹配 → 选中，不符模型被排除', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({
          id: 'w_match',
          modelAvailabilities: [
            {
              modelId: 'md_0000000010',
              model: {
                enabled: true,
                providerID: 'opencode',
                modelID: 'deepseek-v4-pro',
              },
            },
          ],
        }),
        workerRow({
          id: 'w_nomatch',
          modelAvailabilities: [
            {
              modelId: 'md_0000000011',
              model: { enabled: true, providerID: 'opencode', modelID: 'glm-5.1' },
            },
          ],
        }),
      ]);

      const workerId = await service.assignWorker({
        modelId: 'opencode/deepseek-v4-pro',
      });

      expect(workerId).toBe('w_match');
      // include 须带回 model.providerID/modelID（过滤按 provider/model 拼接，md_ 主键不可比对）
      expect(prisma.worker.findMany).toHaveBeenCalledWith({
        where: { status: { not: WORKER_STATUS.OFFLINE } },
        include: {
          modelAvailabilities: {
            include: {
              model: {
                select: { enabled: true, providerID: true, modelID: true },
              },
            },
          },
        },
      });
    });

    it('C7 按模型过滤：availability 不含该模型（provider/model 不匹配）→ 排除（返回 null）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({
          id: 'w_glm',
          modelAvailabilities: [
            {
              modelId: 'md_0000000011',
              model: { enabled: true, providerID: 'opencode', modelID: 'glm-5.1' },
            },
          ],
        }),
      ]);

      const workerId = await service.assignWorker({
        modelId: 'opencode/deepseek-v4-pro',
      });

      expect(workerId).toBeNull();
    });

    it('C7 按模型过滤：availability 关联模型匹配但 enabled=false → 排除', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({
          id: 'w_disabled',
          modelAvailabilities: [
            {
              modelId: 'md_0000000010',
              model: {
                enabled: false,
                providerID: 'opencode',
                modelID: 'deepseek-v4-pro',
              },
            },
          ],
        }),
      ]);

      const workerId = await service.assignWorker({
        modelId: 'opencode/deepseek-v4-pro',
      });

      expect(workerId).toBeNull();
    });

    it('C7 按模型过滤：从未上报（availability 无行）→ 降级不受过滤约束', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ id: 'w_legacy' }),
      ]);

      const workerId = await service.assignWorker({
        modelId: 'opencode/deepseek-v4-pro',
      });

      expect(workerId).toBe('w_legacy');
    });

    it('C7 按模型过滤：worker.defaultModelId === modelId → 通过（即便 availability 不符）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({
          id: 'w_default',
          defaultModelId: 'opencode/deepseek-v4-pro',
          modelAvailabilities: [
            {
              modelId: 'md_0000000011',
              model: { enabled: true, providerID: 'opencode', modelID: 'glm-5.1' },
            },
          ],
        }),
      ]);

      const workerId = await service.assignWorker({
        modelId: 'opencode/deepseek-v4-pro',
      });

      expect(workerId).toBe('w_default');
    });

    it('C7 按模型过滤：modelId 未指定 → 不过滤（回归现状，availability 无关）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ id: 'w_none' }),
      ]);

      const workerId = await service.assignWorker();

      expect(workerId).toBe('w_none');
    });
  });

  describe('列表/详情', () => {
    it('findAll 返回列表且剔除 tokenHash', async () => {
      prisma.worker.findMany.mockResolvedValue([workerRow()]);

      const rows = await service.findAll();

      expect(prisma.worker.findMany).toHaveBeenCalledWith({
        orderBy: { registeredAt: 'desc' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('tokenHash');
      expect(rows[0]).toMatchObject({
        id: 'w_0000000001',
        status: WORKER_STATUS.ONLINE,
        capabilities: { maxInstances: 5 },
      });
    });

    it('C8：toWorkerView 透出 defaultModelId（findAll/详情均含；null=未配置）', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ defaultModelId: 'opencode-go/deepseek-v4-flash' }),
      ]);
      prisma.worker.findUnique.mockResolvedValue(workerRow());

      const rows = await service.findAll();
      expect(rows[0].defaultModelId).toBe('opencode-go/deepseek-v4-flash');

      const view = await service.findOne('w_0000000001');
      expect(view.defaultModelId).toBeNull();
    });

    it('findOne 返回视图（含 lastHeartbeatAt/load/capabilities/opencodeVersion）', async () => {
      prisma.worker.findUnique.mockResolvedValue(workerRow());

      const view = await service.findOne('w_0000000001');

      expect(view).toMatchObject({
        id: 'w_0000000001',
        opencodeVersion: '1.18.14',
        capabilities: { maxInstances: 5 },
        load: { instances: 1 },
        status: WORKER_STATUS.ONLINE,
        lastHeartbeatAt: expect.any(Date),
      });
      expect(view).not.toHaveProperty('tokenHash');
    });

    it('findOne 不存在 → 404 WORKER_NOT_FOUND', async () => {
      prisma.worker.findUnique.mockResolvedValue(null);

      await expect(service.findOne('w_unknown')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('T9：findOne 详情返回该 worker 最近上报的 mcpStatus（关联内存态）', async () => {
      prisma.worker.findUnique.mockResolvedValue(workerRow());
      service['workerMcpStatus'].set('w_0000000001', [
        { serverName: 'gitee-ent', status: 'connected' },
        { serverName: 'test-bad-local', status: 'failed' },
      ]);

      const view = await service.findOne('w_0000000001');

      expect(view.mcpStatus).toEqual([
        { serverName: 'gitee-ent', status: 'connected' },
        { serverName: 'test-bad-local', status: 'failed' },
      ]);
    });

    it('T9：未上报 mcpStatus 的 worker 详情返回空数组', async () => {
      prisma.worker.findUnique.mockResolvedValue(workerRow());

      const view = await service.findOne('w_0000000001');

      expect(view.mcpStatus).toEqual([]);
    });

    it('T9：findAll 列表同样合并每个 worker 的 mcpStatus', async () => {
      prisma.worker.findMany.mockResolvedValue([
        workerRow({ id: 'w_0000000001' }),
        workerRow({ id: 'w_0000000002' }),
      ]);
      service['workerMcpStatus'].set('w_0000000002', [
        { serverName: 'gitee-ent', status: 'needs_auth' },
      ]);

      const rows = await service.findAll();

      expect(rows[0].mcpStatus).toEqual([]);
      expect(rows[1].mcpStatus).toEqual([
        { serverName: 'gitee-ent', status: 'needs_auth' },
      ]);
    });
  });

  describe('updateDefaultModel（C8 PATCH /workers/:id）', () => {
    it('defaultModelId 在目录（enabled）→ 校验通过后落库，返回视图含新值', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue(
        workerRow({ defaultModelId: 'opencode-go/deepseek-v4-flash' }),
      );

      const view = await service.updateDefaultModel('w_0000000001', {
        defaultModelId: 'opencode-go/deepseek-v4-flash',
      });

      expect(modelsService.findCatalogByRef).toHaveBeenCalledWith(
        'opencode-go/deepseek-v4-flash',
      );
      expect(prisma.worker.update).toHaveBeenCalledWith({
        where: { id: 'w_0000000001' },
        data: { defaultModelId: 'opencode-go/deepseek-v4-flash' },
      });
      expect(view.defaultModelId).toBe('opencode-go/deepseek-v4-flash');
    });

    it('defaultModelId 不在目录 → 400 MODEL_NOT_FOUND，不落库', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      modelsService.findCatalogByRef.mockResolvedValue(null);

      await expect(
        service.updateDefaultModel('w_0000000001', {
          defaultModelId: 'opencode/unknown-model',
        }),
      ).rejects.toMatchObject({
        response: { code: 'MODEL_NOT_FOUND' },
      });
      expect(prisma.worker.update).not.toHaveBeenCalled();
    });

    it('defaultModelId 在目录但 enabled=false → 400 MODEL_NOT_FOUND（停用模型不可设为默认）', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      modelsService.findCatalogByRef.mockResolvedValue({
        id: 'md_0000000001',
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        enabled: false,
      });

      await expect(
        service.updateDefaultModel('w_0000000001', {
          defaultModelId: 'opencode-go/deepseek-v4-flash',
        }),
      ).rejects.toMatchObject({
        response: { code: 'MODEL_NOT_FOUND' },
      });
      expect(prisma.worker.update).not.toHaveBeenCalled();
    });

    it('null=清除默认模型（跳过目录校验，落库 null）', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue(workerRow());

      const view = await service.updateDefaultModel('w_0000000001', {
        defaultModelId: null,
      });

      expect(modelsService.findCatalogByRef).not.toHaveBeenCalled();
      expect(prisma.worker.update).toHaveBeenCalledWith({
        where: { id: 'w_0000000001' },
        data: { defaultModelId: null },
      });
      expect(view.defaultModelId).toBeNull();
    });

    it('defaultModelId 缺省（undefined）→ 幂等跳过不更新', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue(
        workerRow({ defaultModelId: 'opencode-go/deepseek-v4-flash' }),
      );

      const view = await service.updateDefaultModel('w_0000000001', {});

      expect(prisma.worker.update).toHaveBeenCalledWith({
        where: { id: 'w_0000000001' },
        data: {},
      });
      expect(view.defaultModelId).toBe('opencode-go/deepseek-v4-flash');
    });

    it('worker 不存在 → 404 WORKER_NOT_FOUND，不校验目录', async () => {
      prisma.worker.findUnique.mockResolvedValue(null);

      await expect(
        service.updateDefaultModel('w_unknown', {
          defaultModelId: 'opencode-go/deepseek-v4-flash',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(modelsService.findCatalogByRef).not.toHaveBeenCalled();
      expect(prisma.worker.update).not.toHaveBeenCalled();
    });
  });

  describe('UX-01 远程生命周期（requestRestart/requestShutdown）', () => {
    it('requestRestart：worker 存在 → enqueueCommand restart（一次有效，心跳取出执行）', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });

      const result = await service.requestRestart('w_0000000001');

      expect(service['pendingCommands'].get('w_0000000001')).toEqual([
        { type: 'restart', resourceVersion: 'remote-restart' },
      ]);
      expect(result).toEqual({
        workerId: 'w_0000000001',
        command: 'restart',
        queued: true,
      });
    });

    it('requestRestart：worker 不存在 → 404 WORKER_NOT_FOUND，不入队', async () => {
      prisma.worker.findUnique.mockResolvedValue(null);

      await expect(service.requestRestart('w_unknown')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(service['pendingCommands'].has('w_unknown')).toBe(false);
    });

    it('requestShutdown：worker 存在 → enqueueCommand shutdown + 立即标 offline，返回确认', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue(
        workerRow({ status: WORKER_STATUS.OFFLINE }),
      );

      const result = await service.requestShutdown('w_0000000001');

      expect(service['pendingCommands'].get('w_0000000001')).toEqual([
        { type: 'shutdown', resourceVersion: 'remote-shutdown' },
      ]);
      expect(prisma.worker.update).toHaveBeenCalledWith({
        where: { id: 'w_0000000001' },
        data: { status: WORKER_STATUS.OFFLINE },
      });
      expect(result).toEqual({
        workerId: 'w_0000000001',
        command: 'shutdown',
        queued: true,
        status: WORKER_STATUS.OFFLINE,
      });
    });

    it('requestShutdown：worker 不存在 → 404，不入队不更新', async () => {
      prisma.worker.findUnique.mockResolvedValue(null);

      await expect(service.requestShutdown('w_unknown')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(service['pendingCommands'].has('w_unknown')).toBe(false);
      expect(prisma.worker.update).not.toHaveBeenCalled();
    });

    it('requestShutdown：标记 offline 时同步清理该 worker 的 mcpStatus 内存态', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue(
        workerRow({ status: WORKER_STATUS.OFFLINE }),
      );
      service['workerMcpStatus'].set('w_0000000001', [
        { serverName: 'gitee-ent', status: 'connected' },
      ]);

      await service.requestShutdown('w_0000000001');

      expect(service['workerMcpStatus'].has('w_0000000001')).toBe(false);
    });

    it('requestRestart 命令经心跳取出即清空（一次有效，与 reload-config 同通道）', async () => {
      prisma.worker.findUnique.mockResolvedValue({ id: 'w_0000000001' });
      prisma.worker.update.mockResolvedValue({});

      await service.requestRestart('w_0000000001');

      const dto: HeartbeatWorkerDto = {
        workerId: 'w_0000000001',
        load: { instances: 1 },
        health: 'ok',
      };
      const result = await service.heartbeat('w_0000000001', dto);
      expect(result.commands).toEqual([
        { type: 'restart', resourceVersion: 'remote-restart' },
      ]);

      const second = await service.heartbeat('w_0000000001', dto);
      expect(second.commands).toBeUndefined();
    });
  });

  describe('LifecycleManager 骨架', () => {
    it.each(['createInstance', 'abortSession', 'dispatchPrompt'] as const)(
      '%s 抛出 NotImplementedException（T10 接 WorkerClient 前不实现）',
      async (method) => {
        await expect(
          (service[method] as (a: string, b: string, c?: string) => Promise<never>)(
            'w_1',
            's_1',
            'prompt',
          ),
        ).rejects.toBeInstanceOf(NotImplementedException);
      },
    );
  });
});
