import { Test, TestingModule } from '@nestjs/testing';
import { MessageReceiptsService } from '../chat/message-receipts.service';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { computePlanHash } from '../issues/review-round-ledger';
import {
  PLAN_LIFECYCLE_ERRORS,
  PLAN_LIFECYCLE_STATUS,
  PlanLifecycleService,
} from './plan-lifecycle.service';

describe('PlanLifecycleService', () => {
  let service: PlanLifecycleService;
  let prisma: {
    plan: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { create: jest.Mock };
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let receipts: { emitPlanStatusChanged: jest.Mock };
  let realtime: { broadcast: jest.Mock };

  beforeEach(async () => {
    prisma = {
      plan: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      task: { findUnique: jest.fn() },
      team: { findUnique: jest.fn() },
      chatChannel: { findFirst: jest.fn() },
      message: { create: jest.fn() },
    };
    idGen = { nextId: jest.fn(), seed: jest.fn() };
    receipts = { emitPlanStatusChanged: jest.fn() };
    realtime = { broadcast: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanLifecycleService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: MessageReceiptsService, useValue: receipts },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();

    service = module.get<PlanLifecycleService>(PlanLifecycleService);
  });

  describe('verifyEnum', () => {
    it.each([
      ['draft'],
      ['reviewing'],
      ['pending_final'],
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

    it('状态常量恰为七态 draft/reviewing/pending_final/approved/rejected/executing/completed', () => {
      expect(Object.values(PLAN_LIFECYCLE_STATUS).sort()).toEqual(
        [
          'approved',
          'completed',
          'draft',
          'executing',
          'pending_final',
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
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledWith({
        taskId: 't_1',
        from: 'approved',
        to: 'executing',
      });
    });

    it('无行→先 autoEnsureRow 建 draft 行再翻转到目标态（收敛 verdict 必落库）', async () => {
      prisma.plan.findUnique
        .mockResolvedValueOnce(null) // transition 探查
        .mockResolvedValueOnce(null); // autoEnsureRow 探查
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        title: '任务标题',
        createdBy: 'u_admin',
      });
      idGen.nextId.mockResolvedValue('pl_0000000001');
      prisma.plan.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ ...data }),
      );
      prisma.plan.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'pl_0000000001', taskId: 't_1', ...data }),
      );

      const out = await service.transition('t_1', 'pending_final');

      expect(prisma.plan.create).toHaveBeenCalledWith({
        data: {
          id: 'pl_0000000001',
          taskId: 't_1',
          title: '任务标题',
          status: 'draft',
          createdBy: 'u_admin',
        },
      });
      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: { status: 'pending_final' },
      });
      expect(out).toMatchObject({ status: 'pending_final' });
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledWith({
        taskId: 't_1',
        from: 'draft',
        to: 'pending_final',
      });
    });

    it('并发双建行竞态（autoEnsureRow P2002）→重读行后继续翻转', async () => {
      prisma.plan.findUnique
        .mockResolvedValueOnce(null) // transition 探查
        .mockResolvedValueOnce(null) // autoEnsureRow 探查
        .mockResolvedValueOnce({ status: 'draft' }); // P2002 后重读（首建者已落库）
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        title: '任务标题',
        createdBy: 'u_admin',
      });
      idGen.nextId.mockResolvedValue('pl_0000000001');
      prisma.plan.create.mockRejectedValue(
        new Error(
          'Unique constraint failed on the constraint: `plans_taskId_key` (P2002)',
        ),
      );
      prisma.plan.update.mockResolvedValue({
        id: 'pl_0000000001',
        taskId: 't_1',
        status: 'draft',
      });

      const out = await service.transition('t_1', 'draft');

      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: { status: 'draft' },
      });
      expect(out).toMatchObject({ status: 'draft' });
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledWith({
        taskId: 't_1',
        from: 'draft',
        to: 'draft',
      });
    });

    it('非法目标态→抛错且不写库不广播', async () => {
      await expect(service.transition('t_1', 'archived')).rejects.toThrow();
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(receipts.emitPlanStatusChanged).not.toHaveBeenCalled();
    });

    it('广播失败→翻转已落库，仅 warn 不抛', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'approved' });
      prisma.plan.update.mockResolvedValue({ status: 'executing' });
      receipts.emitPlanStatusChanged.mockRejectedValue(new Error('sse down'));

      await expect(
        service.transition('t_1', 'executing'),
      ).resolves.toMatchObject({ status: 'executing' });
    });
  });

  describe('confirmPlan（todo11 用户确认门：任一团队成员可点）', () => {
    const confirmed = (over: Record<string, unknown> = {}) => ({
      id: 't_1',
      teamId: 'tm_1',
      ...over,
    });

    beforeEach(() => {
      prisma.task.findUnique.mockResolvedValue(confirmed());
      idGen.nextId.mockImplementation((prefix: string) =>
        Promise.resolve(`${prefix}_0000000001`),
      );
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      prisma.message.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'm_1', ...data }),
      );
    });

    it('任务不存在→404 TASK_NOT_FOUND（行缺失永不404，只任务缺失才404）', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      const err = await service
        .confirmPlan('t_missing', { userId: 'u_1', userName: '成员' })
        .catch((e) => e);

      expect(err?.response?.code ?? err?.code).toBe('TASK_NOT_FOUND');
      expect(prisma.plan.create).not.toHaveBeenCalled();
    });

    it('无plan行→先autoEnsureRow建行，再走确认（draft行确认→精确错态码，不404）', async () => {
      prisma.plan.findUnique
        .mockResolvedValueOnce(null) // autoEnsureRow 探查
        .mockResolvedValueOnce({ status: 'draft' }); // 确认前读状态
      prisma.task.findUnique.mockResolvedValue({
        id: 't_1',
        teamId: 'tm_1',
        title: '任务',
        createdBy: 'u_1',
      });
      prisma.plan.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ ...data, status: 'draft' }),
      );

      const err = await service
        .confirmPlan('t_1', { userId: 'u_1', userName: '成员' })
        .catch((e) => e);

      expect(prisma.plan.create).toHaveBeenCalled();
      expect(err?.response?.code ?? err?.code).toBe(
        PLAN_LIFECYCLE_ERRORS.PLAN_CONFIRM_WRONG_STATE,
      );
    });

    it('approved→executing 翻转一次：记confirmedBy/confirmedAt、落系统消息、幂等标记false', async () => {
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        status: 'approved',
      });
      prisma.plan.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'pl_1', taskId: 't_1', ...data }),
      );

      const out = await service.confirmPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
      });

      expect(out.idempotent).toBe(false);
      expect(out.plan).toMatchObject({ status: 'executing' });
      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: {
          status: 'executing',
          confirmedBy: '成员甲',
          confirmedAt: expect.any(Date),
          rejectReason: null,
        },
      });
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledWith({
        taskId: 't_1',
        from: 'approved',
        to: 'executing',
      });
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      const msgData = prisma.message.create.mock.calls[0][0].data;
      expect(msgData.senderType).toBe('system');
      expect(String(msgData.content?.text ?? '')).toContain('成员甲');
    });

    it('二次POST（已executing）→幂等同结果：不重写库、不重发系统消息', async () => {
      const row = {
        id: 'pl_1',
        taskId: 't_1',
        status: 'executing',
        confirmedBy: '成员甲',
      };
      prisma.plan.findUnique.mockResolvedValue(row);

      const out = await service.confirmPlan('t_1', {
        userId: 'u_2',
        userName: '成员乙',
      });

      expect(out).toMatchObject({ idempotent: true });
      expect(out.plan).toMatchObject({
        status: 'executing',
        confirmedBy: '成员甲',
      });
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(receipts.emitPlanStatusChanged).not.toHaveBeenCalled();
    });

    it.each([
      ['draft'],
      ['reviewing'],
      ['pending_final'],
      ['rejected'],
      ['completed'],
    ])(
      '错态 %s 确认→409 精确码 PLAN_CONFIRM_WRONG_STATE（开始执行仍要求 approved）',
      async (status: string) => {
        prisma.plan.findUnique.mockResolvedValue({ status });

        const err = await service
          .confirmPlan('t_1', { userId: 'u_1' })
          .catch((e) => e);

        expect(err?.status ?? err?.getStatus?.()).toBe(409);
        expect(err?.response?.code ?? err?.code).toBe(
          PLAN_LIFECYCLE_ERRORS.PLAN_CONFIRM_WRONG_STATE,
        );
        expect(prisma.plan.update).not.toHaveBeenCalled();
      },
    );

    it('系统消息落库失败→翻转已落库，仅 warn 不抛', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'approved' });
      prisma.plan.update.mockResolvedValue({ status: 'executing' });
      prisma.message.create.mockRejectedValue(new Error('msg down'));

      await expect(
        service.confirmPlan('t_1', { userId: 'u_1', userName: '成员' }),
      ).resolves.toMatchObject({
        idempotent: false,
        plan: { status: 'executing' },
      });
    });
  });

  describe('托管模式签署（managed：主 Agent 代用户，允许跳过评审直推）', () => {
    beforeEach(() => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      prisma.message.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'm_managed', ...data }),
      );
      prisma.plan.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ ...data }),
      );
    });

    it('confirmPlan managed=true：draft 直推 executing，同事务补定稿字段与冻结锚', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'draft' });

      const res = await service.confirmPlan('t_1', {
        userId: 'tmm_main',
        userName: null,
        action: 'confirm',
        managed: true,
      });

      expect(res).toMatchObject({
        idempotent: false,
        action: 'confirm',
        plan: { status: 'executing' },
      });
      const data = prisma.plan.update.mock.calls[0][0].data;
      expect(data).toMatchObject({
        status: 'executing',
        confirmedBy: 'tmm_main',
        finalizedBy: 'tmm_main',
      });
      expect(data.confirmedAt).toBeInstanceOf(Date);
      expect(data.finalizedAt).toBeInstanceOf(Date);
      expect(data.frozenVersion).toBe('v0.1');
      expect(data.frozenHash).toBe(computePlanHash('t_1:v0.1'));
    });

    it('confirmPlan managed=true：pending_final 同样直推 executing', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'pending_final' });

      const res = await service.confirmPlan('t_1', {
        userId: 'tmm_main',
        userName: null,
        action: 'confirm',
        managed: true,
      });

      expect(res).toMatchObject({ idempotent: false, plan: { status: 'executing' } });
    });

    it('confirmPlan 未传 managed：draft 仍被人工签署门拦下（409，不写库）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'draft' });

      const err = await service
        .confirmPlan('t_1', { userId: 'u_1', action: 'confirm' })
        .catch((e) => e);

      expect(err?.response?.code ?? err?.code).toBe(
        PLAN_LIFECYCLE_ERRORS.PLAN_CONFIRM_WRONG_STATE,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });

    it('finalizePlan managed=true：draft → approved（跳过评审，冻结锚回退口径）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'draft' });

      const res = await service.finalizePlan('t_1', {
        userId: 'tmm_main',
        userName: null,
        managed: true,
      });

      expect(res).toMatchObject({
        idempotent: false,
        action: 'finalize',
        plan: { status: 'approved' },
      });
      expect(prisma.plan.update.mock.calls[0][0].data).toMatchObject({
        status: 'approved',
        finalizedBy: 'tmm_main',
        frozenVersion: 'v0.1',
        frozenHash: computePlanHash('t_1:v0.1'),
      });
    });

    it('finalizePlan 未传 managed：draft 仍 409（人工门不被静默放宽）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'draft' });

      const err = await service
        .finalizePlan('t_1', { userId: 'u_1' })
        .catch((e) => e);

      expect(err?.response?.code ?? err?.code).toBe(
        PLAN_LIFECYCLE_ERRORS.PLAN_FINALIZE_WRONG_STATE,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });
  });

  describe('finalizePlan（定稿确认 pending_final→approved，用户显式定稿门）', () => {
    beforeEach(() => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      prisma.message.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'm_4', ...data }),
      );
    });

    it('pending_final→approved 翻转一次：记finalizedBy/finalizedAt、落系统消息、幂等标记false', async () => {
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        status: 'pending_final',
      });
      prisma.plan.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'pl_1', taskId: 't_1', ...data }),
      );

      const out = await service.confirmPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'finalize',
      });

      expect(out.action).toBe('finalize');
      expect(out.idempotent).toBe(false);
      expect(out.plan).toMatchObject({ status: 'approved' });
      // todo 2 冻结：无账本 mock（prisma.issue 缺省）→回退锚与翻转同行落库
      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: {
          status: 'approved',
          finalizedBy: '成员甲',
          finalizedAt: expect.any(Date),
          rejectReason: null,
          frozenVersion: 'v0.1',
          frozenHash: computePlanHash('t_1:v0.1'),
        },
      });
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledWith({
        taskId: 't_1',
        from: 'pending_final',
        to: 'approved',
      });
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      const msgData = prisma.message.create.mock.calls[0][0].data;
      expect(String(msgData.content?.text ?? '')).toContain('成员甲');
    });

    it('二次finalize（已approved）→幂等同结果：不重写库、不重发系统消息', async () => {
      const row = {
        id: 'pl_1',
        taskId: 't_1',
        status: 'approved',
        finalizedBy: '成员甲',
      };
      prisma.plan.findUnique.mockResolvedValue(row);

      const out = await service.confirmPlan('t_1', {
        userId: 'u_2',
        userName: '成员乙',
        action: 'finalize',
      });

      expect(out).toMatchObject({ idempotent: true, action: 'finalize' });
      expect(out.plan).toMatchObject({
        status: 'approved',
        finalizedBy: '成员甲',
      });
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(receipts.emitPlanStatusChanged).not.toHaveBeenCalled();
    });

    it.each([
      ['draft'],
      ['reviewing'],
      ['rejected'],
      ['executing'],
      ['completed'],
    ])(
      '错态 %s 定稿→409 精确码 PLAN_FINALIZE_WRONG_STATE',
      async (status: string) => {
        prisma.plan.findUnique.mockResolvedValue({ status });

        const err = await service
          .confirmPlan('t_1', { userId: 'u_1', action: 'finalize' })
          .catch((e) => e);

        expect(err?.status ?? err?.getStatus?.()).toBe(409);
        expect(err?.response?.code ?? err?.code).toBe(
          PLAN_LIFECYCLE_ERRORS.PLAN_FINALIZE_WRONG_STATE,
        );
        expect(prisma.plan.update).not.toHaveBeenCalled();
      },
    );
  });

  describe('rejectPlan（todo11 approved→draft 打回带 reason）', () => {
    beforeEach(() => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      prisma.message.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'm_2', ...data }),
      );
    });

    it('approved+reason→draft：rejectReason 落库，轮次不变（只动状态+原因）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'approved' });
      prisma.plan.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ status: 'draft', ...data }),
      );

      const out = await service.rejectPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        reason: '  范围过大，先拆分  ',
      });

      expect(out.plan).toMatchObject({ status: 'draft' });
      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: { status: 'draft', rejectReason: '范围过大，先拆分' },
      });
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledWith({
        taskId: 't_1',
        from: 'approved',
        to: 'draft',
      });
    });

    it('缺reason→400 精确码 PLAN_REJECT_REASON_REQUIRED，不写库', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'approved' });

      for (const reason of [undefined, '', '   ', null]) {
        const err = await service
          .rejectPlan('t_1', {
            userId: 'u_1',
            reason: reason as unknown as string,
          })
          .catch((e) => e);
        expect(err?.status ?? err?.getStatus?.()).toBe(400);
        expect(err?.response?.code ?? err?.code).toBe(
          PLAN_LIFECYCLE_ERRORS.PLAN_REJECT_REASON_REQUIRED,
        );
      }
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });

    it('非approved打回→409 精确码 PLAN_REJECT_WRONG_STATE', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });

      const err = await service
        .rejectPlan('t_1', { userId: 'u_1', reason: '太晚了' })
        .catch((e) => e);

      expect(err?.status ?? err?.getStatus?.()).toBe(409);
      expect(err?.response?.code ?? err?.code).toBe(
        PLAN_LIFECYCLE_ERRORS.PLAN_REJECT_WRONG_STATE,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });
  });

  describe('completePlan（todo11 executing→completed，PM/主实例鉴权）', () => {
    beforeEach(() => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
      prisma.message.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'm_3', ...data }),
      );
    });

    it('任务不存在→404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      const err = await service
        .completePlan('t_missing', { userId: 'u_pm' })
        .catch((e) => e);

      expect(err?.response?.code ?? err?.code).toBe('TASK_NOT_FOUND');
    });

    it('用户PM路径（无instanceId）executing→completed', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });
      prisma.plan.update.mockResolvedValue({ status: 'completed' });

      const out = await service.completePlan('t_1', { userId: 'u_pm' });

      expect(out).toMatchObject({
        idempotent: false,
        plan: { status: 'completed' },
      });
      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: { status: 'completed' },
      });
    });

    it('agent 路径不再按主实例身份鉴权：instanceId 任意值均放行（原 403 已移除）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });
      prisma.plan.update.mockResolvedValue({ status: 'completed' });

      await expect(
        service.completePlan('t_1', {
          userId: 'w_1',
          instanceId: 'tmm_main',
        }),
      ).resolves.toMatchObject({ plan: { status: 'completed' } });

      await expect(
        service.completePlan('t_1', {
          userId: 'w_1',
          instanceId: 'tmm_dev',
        }),
      ).resolves.toMatchObject({ plan: { status: 'completed' } });
    });

    it('PLAN_COMPLETE_MAIN_ONLY 常量仍在代码中声明，但 completePlan 不再抛出它', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });
      prisma.plan.update.mockResolvedValue({ status: 'completed' });

      const err = await service
        .completePlan('t_1', { userId: 'w_1', instanceId: 'tmm_dev' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeNull();
      expect(PLAN_LIFECYCLE_ERRORS.PLAN_COMPLETE_MAIN_ONLY).toBe(
        'PLAN_COMPLETE_MAIN_ONLY',
      );
    });

    it('已completed→幂等同结果，不重写库', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'completed' });

      const out = await service.completePlan('t_1', { userId: 'u_pm' });

      expect(out).toMatchObject({
        idempotent: true,
        plan: { status: 'completed' },
      });
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });

    it('非executing完工→409 精确码 PLAN_COMPLETE_WRONG_STATE', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'approved' });

      const err = await service
        .completePlan('t_1', { userId: 'u_pm' })
        .catch((e) => e);

      expect(err?.status ?? err?.getStatus?.()).toBe(409);
      expect(err?.response?.code ?? err?.code).toBe(
        PLAN_LIFECYCLE_ERRORS.PLAN_COMPLETE_WRONG_STATE,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
    });
  });

  describe('getPlan（todo11 真值源=DB plans.status，文件仅展示）', () => {
    it('有行→原样返回DB行（状态以DB为准，不读文件）', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1' });
      const row = { id: 'pl_1', taskId: 't_1', status: 'executing' };
      prisma.plan.findUnique.mockResolvedValue(row);

      await expect(service.getPlan('t_1')).resolves.toEqual(row);
      expect(prisma.plan.findUnique).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
      });
    });

    it('任务不存在→404 TASK_NOT_FOUND', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      const err = await service.getPlan('t_missing').catch((e) => e);

      expect(err?.response?.code ?? err?.code).toBe('TASK_NOT_FOUND');
    });

    it('无行→返回null（读路径不自动建行，建行只发生在确认/完工写路径）', async () => {
      prisma.task.findUnique.mockResolvedValue({ id: 't_1' });
      prisma.plan.findUnique.mockResolvedValue(null);

      await expect(service.getPlan('t_1')).resolves.toBeNull();
      expect(prisma.plan.create).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit（pl_ 前缀续号唯一归属）', () => {
    it('按库内 pl_ 最大序号对齐 seed（跳过非数字 id）', async () => {
      (prisma.plan as any).findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'pl_0000000007' }]);

      await service.onModuleInit();

      expect((prisma.plan as any).findMany).toHaveBeenCalledWith({
        where: { id: { startsWith: 'pl_' } },
        select: { id: true },
      });
      expect(idGen.seed).toHaveBeenCalledWith('pl', 7);
    });
  });
});
