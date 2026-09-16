import { Test, TestingModule } from '@nestjs/testing';
import { MessageReceiptsService } from '../chat/message-receipts.service';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ReviewRoundService } from '../issues/review-round.service';
import {
  bumpPlanVersion,
  createLedger,
  embedLedger,
  mergeLedger,
} from '../issues/review-round-ledger';
import {
  PLAN_LIFECYCLE_ERRORS,
  PlanLifecycleService,
} from './plan-lifecycle.service';

/**
 * plan-finalize-actions todo 4 修订重评小循环（含 force 口径统一）。
 *
 * 入口矩阵（docs 33 §6.4 裁决三，todo 1 决策）：
 * - approved / rejected → reject 打回 draft（带 reason）：version+1，轮次不变；
 * - executing / completed → revise 回到 draft：version+1，轮次+1，重走完整 N/N 复评；
 * - pending_final / draft / reviewing → 两动作皆非法（精确码）；
 * - 复评 quorum=N/N 沿收敛门（expected 原样保留，received 清零重收）；
 * - force 绕过审计统一记 forceReason 列，不因哈希新增限制（见
 *   platform-mcp.service.plan-hash.spec.ts force 用例，本文件只锁修订路径无 force 面）。
 *
 * 失败优先：本文件先于生产代码落地，初跑须红（revise 未实现、rejected 打回被拦）。
 */
describe('PlanLifecycleService revise-and-rereview mini-loop（todo 4）', () => {
  let service: PlanLifecycleService;
  let prisma: {
    plan: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    task: { findUnique: jest.Mock };
    team: { findUnique: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
    message: { create: jest.Mock };
    issue: { findMany: jest.Mock };
  };
  let idGen: { nextId: jest.Mock; seed: jest.Mock };
  let receipts: { emitPlanStatusChanged: jest.Mock };
  let realtime: { broadcast: jest.Mock };
  let rounds: { applyRoundUpdate: jest.Mock };

  const HOST_ISSUE_ID = 'is_host_1';

  function hostLedger(opts: { round?: number; version?: string } = {}) {
    return createLedger({
      round: opts.round ?? 3,
      planVersion: {
        version: opts.version ?? 'v0.4',
        lines: 233,
        hash: 'abc12345',
      },
      taskId: 't_1',
      issueId: HOST_ISSUE_ID,
      expected: ['tmm_1', 'tmm_2'],
      expectedRoles: ['架构视角', '开发视角'],
    });
  }

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
      issue: { findMany: jest.fn() },
    };
    idGen = { nextId: jest.fn(), seed: jest.fn() };
    receipts = { emitPlanStatusChanged: jest.fn() };
    realtime = { broadcast: jest.fn() };
    rounds = { applyRoundUpdate: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanLifecycleService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdGeneratorService, useValue: idGen },
        { provide: MessageReceiptsService, useValue: receipts },
        { provide: RealtimeService, useValue: realtime },
        { provide: ReviewRoundService, useValue: rounds },
      ],
    }).compile();

    service = module.get<PlanLifecycleService>(PlanLifecycleService);

    prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
    prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
    prisma.message.create.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve({ id: 'm_7', ...(data as Record<string, unknown>) }),
    );
    prisma.plan.update.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve({
        id: 'pl_1',
        taskId: 't_1',
        ...(data as Record<string, unknown>),
      }),
    );
    rounds.applyRoundUpdate.mockImplementation(
      (_issueId: string, update: Record<string, unknown>) =>
        Promise.resolve(
          mergeLedger(
            hostLedger(),
            update as Parameters<typeof mergeLedger>[1],
          ),
        ),
    );
  });

  function mockHost(round = 3, version = 'v0.4') {
    prisma.issue.findMany.mockResolvedValue([
      {
        id: HOST_ISSUE_ID,
        description: embedLedger('评审派发', hostLedger({ round, version })),
      },
    ]);
  }

  describe('bumpPlanVersion（version 字段即账本 planVersion 字符串）', () => {
    it.each([
      ['v0.4', 'v0.5'],
      ['v0.1', 'v0.2'],
      ['v3', 'v4'],
    ])('%s → %s', (from: string, to: string) => {
      expect(bumpPlanVersion(from)).toBe(to);
    });
  });

  describe('reject 打回（approved / rejected → draft，version+1 轮次不变）', () => {
    it('approved+reason→draft：rejectReason 落库，账本 version+1 且无 round 键（轮次不变）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'approved' });
      mockHost(3, 'v0.4');

      const out = await service.confirmPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'reject',
        reason: '范围过大，先拆分',
      });

      expect(out.action).toBe('reject');
      expect(out.plan).toMatchObject({ status: 'draft' });
      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: { status: 'draft', rejectReason: '范围过大，先拆分' },
      });
      expect(rounds.applyRoundUpdate).toHaveBeenCalledWith(HOST_ISSUE_ID, {
        planVersion: { version: 'v0.5' },
      });
      const update = rounds.applyRoundUpdate.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(update).not.toHaveProperty('round');
      expect(update).not.toHaveProperty('status');
    });

    it('rejected+reason→draft：同属合法修订入口（矩阵第二行）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'rejected' });
      mockHost(3, 'v0.4');

      const out = await service.confirmPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'reject',
        reason: '驳回意见已修完，重走评审',
      });

      expect(out.action).toBe('reject');
      expect(out.plan).toMatchObject({ status: 'draft' });
      expect(rounds.applyRoundUpdate).toHaveBeenCalledWith(HOST_ISSUE_ID, {
        planVersion: { version: 'v0.5' },
      });
    });

    it.each([
      ['pending_final'],
      ['draft'],
      ['reviewing'],
      ['executing'],
      ['completed'],
    ])(
      '错态 %s 打回→409 精确码 PLAN_REJECT_WRONG_STATE（executing/completed 请走 revise）',
      async (status: string) => {
        prisma.plan.findUnique.mockResolvedValue({ status });
        mockHost();

        const err = await service
          .confirmPlan('t_1', {
            userId: 'u_1',
            action: 'reject',
            reason: '想打回',
          })
          .catch((e) => e);

        expect(err?.status ?? err?.getStatus?.()).toBe(409);
        expect(err?.response?.code ?? err?.code).toBe(
          PLAN_LIFECYCLE_ERRORS.PLAN_REJECT_WRONG_STATE,
        );
        expect(prisma.plan.update).not.toHaveBeenCalled();
        expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
      },
    );

    it('缺 reason→400 精确码 PLAN_REJECT_REASON_REQUIRED，不写库不动账本', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'approved' });
      mockHost();

      const err = await service
        .confirmPlan('t_1', { userId: 'u_1', action: 'reject', reason: '   ' })
        .catch((e) => e);

      expect(err?.status ?? err?.getStatus?.()).toBe(400);
      expect(err?.response?.code ?? err?.code).toBe(
        PLAN_LIFECYCLE_ERRORS.PLAN_REJECT_REASON_REQUIRED,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
    });
  });

  describe('revise 修订（executing / completed → draft，version+1 轮次+1）', () => {
    it.each([['executing'], ['completed']])(
      '%s+reason→draft：rejectReason 落库，账本 round+1 + version+1 + collecting（重走完整 N/N 复评）',
      async (status: string) => {
        prisma.plan.findUnique.mockResolvedValue({ status });
        mockHost(3, 'v0.4');

        const out = await service.confirmPlan('t_1', {
          userId: 'u_1',
          userName: '成员甲',
          action: 'revise',
          reason: '需求变更，需修订重评',
        });

        expect(out.action).toBe('revise');
        expect(out.idempotent).toBe(false);
        expect(out.plan).toMatchObject({ status: 'draft' });
        expect(prisma.plan.update).toHaveBeenCalledWith({
          where: { taskId: 't_1' },
          data: { status: 'draft', rejectReason: '需求变更，需修订重评' },
        });
        expect(rounds.applyRoundUpdate).toHaveBeenCalledWith(HOST_ISSUE_ID, {
          round: 4,
          planVersion: { version: 'v0.5' },
          status: 'collecting',
        });
      },
    );

    it('revise 开新轮：expected 原样保留、received 清零（复评 quorum=N/N 沿收敛门）', async () => {
      const advanced = mergeLedger(hostLedger({ round: 3, version: 'v0.4' }), {
        round: 4,
        planVersion: { version: 'v0.5' },
        status: 'collecting',
      });

      expect(advanced.round).toBe(4);
      expect(advanced.planVersion.version).toBe('v0.5');
      expect(advanced.status).toBe('collecting');
      expect(advanced.expected).toEqual(['tmm_1', 'tmm_2']);
      expect(advanced.received).toEqual({});
    });

    it.each([
      ['approved'],
      ['rejected'],
      ['pending_final'],
      ['draft'],
      ['reviewing'],
    ])(
      '错态 %s 修订→409 精确码 PLAN_REVISE_WRONG_STATE（approved 请走 reject）',
      async (status: string) => {
        prisma.plan.findUnique.mockResolvedValue({ status });
        mockHost();

        const err = await service
          .confirmPlan('t_1', {
            userId: 'u_1',
            action: 'revise',
            reason: '想修订',
          })
          .catch((e) => e);

        expect(err?.status ?? err?.getStatus?.()).toBe(409);
        expect(err?.response?.code ?? err?.code).toBe(
          PLAN_LIFECYCLE_ERRORS.PLAN_REVISE_WRONG_STATE,
        );
        expect(prisma.plan.update).not.toHaveBeenCalled();
        expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
      },
    );

    it('缺 reason→400 精确码 PLAN_REVISE_REASON_REQUIRED，不写库不动账本', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });
      mockHost();

      const err = await service
        .confirmPlan('t_1', { userId: 'u_1', action: 'revise' })
        .catch((e) => e);

      expect(err?.status ?? err?.getStatus?.()).toBe(400);
      expect(err?.response?.code ?? err?.code).toBe(
        PLAN_LIFECYCLE_ERRORS.PLAN_REVISE_REASON_REQUIRED,
      );
      expect(prisma.plan.update).not.toHaveBeenCalled();
      expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
    });

    it('无账本宿主→翻转照常落库，账本写 warn 跳过（fail-open，不阻断修订）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });
      prisma.issue.findMany.mockResolvedValue([]);

      const out = await service.confirmPlan('t_1', {
        userId: 'u_1',
        action: 'revise',
        reason: '需求变更',
      });

      expect(out.plan).toMatchObject({ status: 'draft' });
      expect(rounds.applyRoundUpdate).not.toHaveBeenCalled();
    });

    it('在途执行不追杀：revise 只翻计划态+开新轮，不碰执行派发（无 kill 面）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });
      mockHost(3, 'v0.4');

      await service.confirmPlan('t_1', {
        userId: 'u_1',
        action: 'revise',
        reason: '需求变更',
      });

      // 断言修订写面仅 plans 翻转 + 账本开新轮 + 系统消息：无执行 kill 调用（本服务本就没有执行写口）。
      expect(prisma.plan.update).toHaveBeenCalledTimes(1);
      expect(rounds.applyRoundUpdate).toHaveBeenCalledTimes(1);
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledTimes(1);
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledWith({
        taskId: 't_1',
        from: 'executing',
        to: 'draft',
      });
    });
  });

  describe('修订路径无 force 面（force 口径沿 todo 1：只活在执行门禁 forceReason 列）', () => {
    it('confirmPlan 修订输入无 force 字段（不因哈希新增限制）', async () => {
      prisma.plan.findUnique.mockResolvedValue({ status: 'executing' });
      mockHost();

      const out = await service.confirmPlan('t_1', {
        userId: 'u_1',
        action: 'revise',
        reason: '需求变更',
      });

      expect(out.plan).toMatchObject({ status: 'draft' });
      // 修订入口只认状态+reason：force 审计行归执行门禁（plan-hash.spec 覆盖），此处无审计写。
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      const msgData = prisma.message.create.mock.calls[0][0].data as {
        content: { text: string };
      };
      expect(String(msgData.content?.text ?? '')).toContain('revise');
    });
  });
});
