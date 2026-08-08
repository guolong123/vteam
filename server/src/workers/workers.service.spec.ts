import {
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
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
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: prisma },
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
  });

  describe('HealthChecker', () => {
    it('仅更新过期行：where status != offline AND (lastHeartbeatAt IS NULL OR < now-30s)', async () => {
      prisma.worker.updateMany.mockResolvedValue({ count: 2 });

      const count = await service.markStaleWorkersOffline();

      expect(count).toBe(2);
      const [args] = prisma.worker.updateMany.mock.calls[0];
      expect(args.where.status).toEqual({ not: WORKER_STATUS.OFFLINE });
      expect(args.where.OR[0]).toEqual({ lastHeartbeatAt: null });
      // 截断时间必须是 now-30s 之前：对 lt 阈值做范围校验（允许毫秒级抖动）
      const cutoff = (args.where.OR[1].lastHeartbeatAt as { lt: Date }).lt;
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - WORKER_OFFLINE_TIMEOUT_MS + 100);
      expect(cutoff.getTime()).toBeGreaterThan(Date.now() - WORKER_OFFLINE_TIMEOUT_MS - 1000);
      expect(args.data).toEqual({ status: WORKER_STATUS.OFFLINE });
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
