import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLifecycleService } from './plan-lifecycle.service';
import { PlanStepsService } from './plan-steps.service';

/**
 * plan_tasks 语义（opencode todos 链已下线，2026-09-23 vteam_todo 复活本表）：
 * 读——无 plan 行=未拆解（degraded=false）、查询异常才 degraded；写——planId+seq compound
 * upsert（同键覆盖）、seq 缺省 max+1、plan 行兜底建；done——miss → 404。
 */
describe('PlanStepsService（plan_tasks 执行步骤）', () => {
  let service: PlanStepsService;
  let prisma: any;
  let idGen: { nextId: jest.Mock };
  let planLifecycle: { autoEnsureRow: jest.Mock };

  const TASK = 't_0000000001';

  beforeEach(async () => {
    prisma = {
      plan: { findUnique: jest.fn(), findMany: jest.fn() },
      planTask: {
        findUnique: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        aggregate: jest.fn(),
      },
    };
    idGen = { nextId: jest.fn().mockResolvedValue('pt_0000000001') };
    planLifecycle = {
      autoEnsureRow: jest.fn().mockResolvedValue({ id: 'pl_0000000001' }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanStepsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: PlanLifecycleService, useValue: planLifecycle },
      ],
    }).compile();
    service = module.get<PlanStepsService>(PlanStepsService);
  });

  const stepRow = (over: Record<string, unknown> = {}) => ({
    id: 'pt_1',
    seq: 1,
    title: '拆解验收标准与角色分工',
    content: { text: 'AC1-AC9' },
    status: 'done',
    assigneeInstanceId: 'tmm_dev',
    ...over,
  });

  describe('listPlanSteps（REST 读）', () => {
    it('无 plan 行 → steps=[]、degraded=false、workerId=null（未拆解 ≠ 降级）', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);

      const res = await service.listPlanSteps(TASK);

      expect(res).toEqual({ steps: [], workerId: null, degraded: false });
    });

    it('有 plan → 按 seq 升序，content 拼成「标题 — 明细」，assignee 透出', async () => {
      prisma.plan.findUnique.mockResolvedValue({
        planTasks: [
          stepRow({ seq: 2, title: '派发 Issue', content: { text: '' } }),
          stepRow({ seq: 1 }),
        ],
      });

      const res = await service.listPlanSteps(TASK);

      expect(res.degraded).toBe(false);
      expect(res.steps.map((s) => s.seq)).toEqual([1, 2]);
      expect(res.steps[0].content).toBe('拆解验收标准与角色分工 — AC1-AC9');
      expect(res.steps[1].content).toBe('派发 Issue');
      expect(res.steps[0].assignee).toBe('tmm_dev');
    });

    it('查询异常 → degraded=true（不冒泡到 HTTP 层）', async () => {
      prisma.plan.findUnique.mockRejectedValue(new Error('db down'));

      const res = await service.listPlanSteps(TASK);

      expect(res).toEqual({ steps: [], workerId: null, degraded: true });
    });
  });

  describe('listSteps（MCP 读）', () => {
    it('无 plan 行 → 空数组（不是错误，拆解后自然出现）', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);
      await expect(service.listSteps(TASK)).resolves.toEqual([]);
    });
  });

  describe('writeStep（MCP write）', () => {
    it('seq 缺省取 max+1；plan 行经 autoEnsureRow 兜底；status/content 落默认值', async () => {
      prisma.planTask.aggregate.mockResolvedValue({ _max: { seq: 3 } });
      prisma.planTask.upsert.mockResolvedValue(
        stepRow({ seq: 4, status: 'pending', content: { text: 'AC1' } }),
      );

      const res = await service.writeStep(TASK, { title: '汇总回执', content: 'AC1' });

      expect(planLifecycle.autoEnsureRow).toHaveBeenCalledWith(TASK);
      const arg = prisma.planTask.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({
        planId_seq: { planId: 'pl_0000000001', seq: 4 },
      });
      expect(arg.create).toMatchObject({
        id: 'pt_0000000001',
        planId: 'pl_0000000001',
        seq: 4,
        title: '汇总回执',
        content: { text: 'AC1' },
        status: 'pending',
        assigneeInstanceId: null,
      });
      expect(res.seq).toBe(4);
    });

    it('指定 seq → 同键 upsert（幂等覆盖），status/assignee 透传', async () => {
      prisma.planTask.upsert.mockResolvedValue(
        stepRow({ seq: 2, status: 'in_progress', assigneeInstanceId: 'tmm_dev' }),
      );

      const res = await service.writeStep(TASK, {
        seq: 2,
        title: '单文件实现',
        status: 'in_progress',
        assignee: 'tmm_dev',
      });

      const arg = prisma.planTask.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({
        planId_seq: { planId: 'pl_0000000001', seq: 2 },
      });
      expect(arg.update).toMatchObject({ status: 'in_progress' });
      expect(res.assignee).toBe('tmm_dev');
    });

    it('title 为空 → 400（不写库、不建 plan 行）', async () => {
      await expect(
        service.writeStep(TASK, { title: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.planTask.upsert).not.toHaveBeenCalled();
      expect(planLifecycle.autoEnsureRow).not.toHaveBeenCalled();
    });
  });

  describe('markDone（MCP done）', () => {
    it('命中 → status 置 done 并返回 view', async () => {
      prisma.plan.findUnique.mockResolvedValue({ id: 'pl_0000000001' });
      prisma.planTask.findUnique.mockResolvedValue(stepRow({ status: 'pending' }));
      prisma.planTask.update.mockResolvedValue(
        stepRow({ status: 'done' }),
      );

      const res = await service.markDone(TASK, 1);

      expect(prisma.planTask.findUnique.mock.calls[0][0].where).toEqual({
        planId_seq: { planId: 'pl_0000000001', seq: 1 },
      });
      expect(prisma.planTask.update.mock.calls[0][0].data).toEqual({
        status: 'done',
      });
      expect(res.status).toBe('done');
    });

    it('plan 行不存在 / 步骤 seq 不存在 → 404 PLAN_STEP_NOT_FOUND', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);
      const noPlan = await service.markDone(TASK, 1).catch((e) => e);
      expect(noPlan).toBeInstanceOf(NotFoundException);

      prisma.plan.findUnique.mockResolvedValue({ id: 'pl_0000000001' });
      prisma.planTask.findUnique.mockResolvedValue(null);
      const noStep = await service.markDone(TASK, 99).catch((e) => e);
      expect(noStep).toBeInstanceOf(NotFoundException);
      expect(
        (noStep as { response?: { code?: string } }).response?.code,
      ).toBe('PLATFORM_MCP_PLAN_STEP_NOT_FOUND');
      expect(prisma.planTask.update).not.toHaveBeenCalled();
    });
  });
});
