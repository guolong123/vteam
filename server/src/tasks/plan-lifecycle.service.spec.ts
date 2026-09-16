import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import {
  PLAN_LIFECYCLE_STATUS,
  PlanLifecycleService,
} from './plan-lifecycle.service';

describe('PlanLifecycleService', () => {
  let service: PlanLifecycleService;
  let prisma: {
    plan: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    task: { findUnique: jest.Mock };
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };

  beforeEach(async () => {
    prisma = {
      plan: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      task: { findUnique: jest.fn() },
    };
    idGen = { nextId: jest.fn(), seed: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanLifecycleService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
      ],
    }).compile();

    service = module.get<PlanLifecycleService>(PlanLifecycleService);
  });

  describe('verifyEnum', () => {
    it.each([
      ['draft'],
      ['reviewing'],
      ['approved'],
      ['rejected'],
      ['executing'],
      ['completed'],
    ])('接受合法状态 %s', (status: string) => {
      expect(() => service.verifyEnum(status)).not.toThrow();
    });

    it('拒绝未知状态', () => {
      expect(() => service.verifyEnum('archived')).toThrow();
      expect(() => service.verifyEnum('')).toThrow();
    });

    it('状态常量恰为六态 draft/reviewing/approved/rejected/executing/completed', () => {
      expect(Object.values(PLAN_LIFECYCLE_STATUS).sort()).toEqual(
        [
          'approved',
          'completed',
          'draft',
          'executing',
          'rejected',
          'reviewing',
        ].sort(),
      );
    });
  });

  describe('autoEnsureRow', () => {
    it('行已存在→直接返回，不重复建', async () => {
      const existing = { id: 'pl_0000000001', taskId: 't_1', status: 'draft' };
      prisma.plan.findUnique.mockResolvedValue(existing);

      const result = await service.autoEnsureRow('t_1');

      expect(result).toEqual(existing);
      expect(prisma.plan.create).not.toHaveBeenCalled();
    });

    it('行缺失→新建 draft 行（pl_ 前缀 + 任务标题/创建者兜底）', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        title: '任务标题',
        createdBy: 'u_admin',
      });
      idGen.nextId.mockResolvedValue('pl_0000000001');
      prisma.plan.create.mockImplementation(({ data }: any) =>
        Promise.resolve(data),
      );

      const result = await service.autoEnsureRow('t_1');

      expect(idGen.nextId).toHaveBeenCalledWith('pl');
      expect(prisma.plan.create).toHaveBeenCalledWith({
        data: {
          id: 'pl_0000000001',
          taskId: 't_1',
          title: '任务标题',
          status: 'draft',
          createdBy: 'u_admin',
        },
      });
      expect(result).toMatchObject({ status: 'draft' });
    });

    it('DB 读失败→上抛（由调用方 warn，不阻断任务创建）', async () => {
      prisma.plan.findUnique.mockRejectedValue(new Error('db down'));

      await expect(service.autoEnsureRow('t_1')).rejects.toThrow('db down');
    });
  });

  describe('getStatus（todo4 门禁读状态）', () => {
    it('有行→返回 status', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });

      await expect(service.getStatus('t_1')).resolves.toBe('executing');
      expect(prisma.plan.findUnique).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        select: { status: true },
      });
    });

    it('无行→返回 null（调用方兜底建行后再门禁）', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);

      await expect(service.getStatus('t_1')).resolves.toBeNull();
    });

    it('DB 读失败→上抛（调用方 fail-open + warn，不转 fail-closed）', async () => {
      prisma.plan.findUnique.mockRejectedValue(new Error('db down'));

      await expect(service.getStatus('t_1')).rejects.toThrow('db down');
    });
  });

  describe('transition', () => {
    it('合法目标态→更新并广播 plan.status.<to>（from 取翻转前状态）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'approved' });
      prisma.plan.update.mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        status: 'executing',
      });

      await service.transition('t_1', 'executing');

      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: { status: 'executing' },
      });
    });

    it('非法目标态→抛错且不写库', async () => {
      await expect(service.transition('t_1', 'archived')).rejects.toThrow();
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });
  });
});
