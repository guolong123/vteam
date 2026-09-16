import { Test, TestingModule } from '@nestjs/testing';
import { MessageReceiptsService } from '../chat/message-receipts.service';
import { IdGeneratorService } from '../common/id-generator';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  ReviewRoundLedger,
  computePlanHash,
  createLedger,
  embedLedger,
} from '../issues/review-round-ledger';
import {
  PLAN_FROZEN_FALLBACK_VERSION,
  PlanLifecycleService,
  resolveFrozenAnchor,
} from './plan-lifecycle.service';

/**
 * plan-finalize-actions todo 2 定稿后三件套（冻结/归档/通告）。
 *
 * 失败优先：本文件先于生产代码落地；三件套全部落在 finalizePlan 路径 append-only，
 * transition/confirmPlan 骨架与守卫窄豁免不动。
 */
describe('PlanLifecycleService finalize trio（todo 2：冻结/归档/通告）', () => {
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

  const FROZEN_VERSION = 'v0.4';
  const FROZEN_HASH = 'abc12345';

  function ledgerWith(opts: {
    version?: string;
    hash?: string;
    superseded?: ReviewRoundLedger['superseded'];
  }): string {
    const ledger = createLedger({
      round: 3,
      planVersion: {
        version: opts.version ?? FROZEN_VERSION,
        lines: 233,
        hash: opts.hash ?? FROZEN_HASH,
      },
      taskId: 't_1',
      issueId: 'is_1',
      expected: ['tmm_1', 'tmm_2'],
    });
    if (opts.superseded !== undefined) {
      ledger.superseded = opts.superseded;
    }
    return embedLedger('评审派发', ledger);
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

    prisma.task.findUnique.mockResolvedValue({ id: 't_1', teamId: 'tm_1' });
    prisma.chatChannel.findFirst.mockResolvedValue({ id: 'c_1' });
    prisma.message.create.mockImplementation(({ data }: { data: unknown }) =>
      Promise.resolve({ id: 'm_9', ...(data as Record<string, unknown>) }),
    );
    idGen.nextId.mockImplementation((prefix: string) =>
      Promise.resolve(`${prefix}_0000000009`),
    );
  });

  describe('冻结（frozenVersion + frozenHash 与翻转同行落库）', () => {
    it('账本有版本哈希→冻结账本值（单次 plan.update 含 status/finalized*/frozen*）', async () => {
      prisma.issue.findMany.mockResolvedValue([
        { description: ledgerWith({}) },
      ]);
      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        status: 'pending_final',
      });
      prisma.plan.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'pl_1', taskId: 't_1', ...data }),
      );

      const out = await service.confirmPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'finalize',
      });

      expect(out.idempotent).toBe(false);
      expect(prisma.plan.update).toHaveBeenCalledTimes(1);
      expect(prisma.plan.update).toHaveBeenCalledWith({
        where: { taskId: 't_1' },
        data: {
          status: 'approved',
          finalizedBy: '成员甲',
          finalizedAt: expect.any(Date),
          rejectReason: null,
          frozenVersion: FROZEN_VERSION,
          frozenHash: FROZEN_HASH,
        },
      });
      expect(out.plan).toMatchObject({
        status: 'approved',
        frozenVersion: FROZEN_VERSION,
        frozenHash: FROZEN_HASH,
      });
    });

    it('无账本→确定性回退锚（非空版本哈希，版本为回退常量）', async () => {
      prisma.issue.findMany.mockResolvedValue([]);
      prisma.plan.findUnique.mockResolvedValue({ status: 'pending_final' });
      prisma.plan.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ status: 'approved', ...data }),
      );

      const out = await service.confirmPlan('t_1', {
        userId: 'u_1',
        action: 'finalize',
      });

      expect(out.plan).toMatchObject({
        frozenVersion: PLAN_FROZEN_FALLBACK_VERSION,
        frozenHash: computePlanHash(`t_1:${PLAN_FROZEN_FALLBACK_VERSION}`),
      });
      expect(
        (out.plan as unknown as Record<string, unknown>).frozenHash,
      ).toMatch(/^[0-9a-f]{8}$/);
    });

    it('resolveFrozenAnchor 纯函数：账本有效→账本值；缺失/空哈希→回退锚', () => {
      const full = createLedger({
        planVersion: { version: 'v0.3', lines: 10, hash: 'deadbeef' },
      });
      expect(resolveFrozenAnchor('t_1', full)).toEqual({
        version: 'v0.3',
        hash: 'deadbeef',
      });
      expect(resolveFrozenAnchor('t_1', null)).toEqual({
        version: PLAN_FROZEN_FALLBACK_VERSION,
        hash: computePlanHash(`t_1:${PLAN_FROZEN_FALLBACK_VERSION}`),
      });
      const emptyHash = createLedger({
        planVersion: { version: 'v0.3', lines: 10, hash: '' },
      });
      expect(resolveFrozenAnchor('t_1', emptyHash).version).toBe('v0.3');
      expect(resolveFrozenAnchor('t_1', emptyHash).hash).toMatch(
        /^[0-9a-f]{8}$/,
      );
    });
  });

  describe('幂等（并发双 finalize 串行断言：同冻结行同结果）', () => {
    it('二次 finalize→同冻结结果：不重写库、不重发系统消息、不重播基线事件', async () => {
      prisma.issue.findMany.mockResolvedValue([
        { description: ledgerWith({}) },
      ]);
      prisma.plan.findUnique.mockResolvedValueOnce({
        id: 'pl_1',
        taskId: 't_1',
        status: 'pending_final',
      });
      prisma.plan.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'pl_1', taskId: 't_1', ...data }),
      );

      const first = await service.confirmPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'finalize',
      });
      expect(first.idempotent).toBe(false);

      prisma.plan.findUnique.mockResolvedValue({
        id: 'pl_1',
        taskId: 't_1',
        status: 'approved',
        finalizedBy: '成员甲',
        frozenVersion: FROZEN_VERSION,
        frozenHash: FROZEN_HASH,
      });

      const second = await service.confirmPlan('t_1', {
        userId: 'u_2',
        userName: '成员乙',
        action: 'finalize',
      });

      expect(second).toMatchObject({ idempotent: true, action: 'finalize' });
      expect(second.plan).toMatchObject({
        status: 'approved',
        finalizedBy: '成员甲',
        frozenVersion: FROZEN_VERSION,
        frozenHash: FROZEN_HASH,
      });
      expect(prisma.plan.update).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(receipts.emitPlanStatusChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('归档（superseded 回执保留可查，复用账本无新表）', () => {
    it('任务账本 superseded→listArchivedReceipts 原样返回', async () => {
      const superseded = [
        { member: 'tmm_1', verdict: 'REJECT', msgId: 'm_510', version: 'v0.3' },
      ] as ReviewRoundLedger['superseded'];
      prisma.issue.findMany.mockResolvedValue([
        { description: ledgerWith({ superseded }) },
      ]);

      await expect(service.listArchivedReceipts('t_1')).resolves.toEqual(
        superseded,
      );
      expect(prisma.issue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { taskId: 't_1' } }),
      );
    });

    it('无账本→空归档（不抛错，可查语义）', async () => {
      prisma.issue.findMany.mockResolvedValue([]);

      await expect(service.listArchivedReceipts('t_1')).resolves.toEqual([]);
    });
  });

  describe('通告（系统消息同通道 + SSE 基线事件含版本/哈希/定稿人）', () => {
    it('系统消息文本含版本号/哈希/定稿人', async () => {
      prisma.issue.findMany.mockResolvedValue([
        { description: ledgerWith({}) },
      ]);
      prisma.plan.findUnique.mockResolvedValue({ status: 'pending_final' });
      prisma.plan.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ status: 'approved', ...data }),
      );

      await service.confirmPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'finalize',
      });

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      const text = String(
        (
          prisma.message.create.mock.calls[0][0] as {
            data: { content: { text: string } };
          }
        ).data.content?.text ?? '',
      );
      expect(text).toContain('成员甲');
      expect(text).toContain(FROZEN_VERSION);
      expect(text).toContain(FROZEN_HASH);
    });

    it('SSE 基线事件复用 plan.status.approved 通道，载荷含版本/哈希/定稿人', async () => {
      prisma.issue.findMany.mockResolvedValue([
        { description: ledgerWith({}) },
      ]);
      prisma.plan.findUnique.mockResolvedValue({ status: 'pending_final' });
      prisma.plan.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ status: 'approved', ...data }),
      );

      await service.confirmPlan('t_1', {
        userId: 'u_1',
        userName: '成员甲',
        action: 'finalize',
      });

      const baseline = realtime.broadcast.mock.calls.find(
        ([type]: [string]) => type === EVENT_TYPES.PLAN_STATUS_APPROVED,
      );
      expect(baseline).toBeDefined();
      expect(baseline[1]).toMatchObject({
        taskId: 't_1',
        to: 'approved',
        frozenVersion: FROZEN_VERSION,
        frozenHash: FROZEN_HASH,
        finalizedBy: '成员甲',
      });
      expect(baseline[2]).toEqual({ type: 'team', id: 'tm_1' });
    });
  });
});
