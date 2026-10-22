import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_TYPES } from '../common/constants/event.constants';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  MessageReceiptsService,
  extractReferencedMessageIds,
} from './message-receipts.service';

/**
 * 批次 A4 · 回执账本的**减法**（.omo/plans/pm-coordination-hardening.md 批次 A4）。
 *
 * 账本此前只有加法（每次 notify_agent 加一行，me_0000000030：「别用 notify 清回执，
 * 会越清越多」），于是「活干完了但账没销」永远 pending ⇒ 平台不停催办 ⇒ 误报催办
 * （me_0000000016 群聊答复不算回执、me_0000000061 question 回执永不结账、
 * me_0000000069 回执压根没落账、me_0000000122 join-pending 不是错误）。
 *
 * 本 spec 锁住三条硬约束：
 *   ① 结算**幂等**：同一条回执行至多被结一次；
 *   ② 结算**只减不增**：任何结算路径都不得新建回执行（create 一次都不许被调用）；
 *   ③ 结算**精确**：不相关/部分匹配/第三方引用一律不销（销错比漏销更糟）。
 */
describe('MessageReceiptsService 结算路径（批次 A4）', () => {
  let service: MessageReceiptsService;
  let prisma: {
    messageReceipt: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
    };
    message: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
    team: { findUnique: jest.Mock; findMany: jest.Mock };
    teamMember: { findUnique: jest.Mock };
    artifactVersion: { findFirst: jest.Mock };
    task: { findUnique: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
  };
  let realtime: { broadcast: jest.Mock };

  const dispatchMessageId = 'm_0000000100';
  const receiptRow = {
    id: 'mr_1',
    messageId: dispatchMessageId,
    taskId: 't_1',
    teamId: 'tm_1',
    fromInstanceId: 'tmm_main',
    toInstanceId: 'tmm_dev',
    status: 'pending',
  };

  /**
   * 账本当前内容（用例自定）。
   * findMany **按 where 过滤**（模拟真查询）：负例因此真正考验实现的精确性——
   * 若实现退化成子串/前缀匹配，被引用的那一行会真的被结掉 ⇒ 测试转红。
   */
  let receiptRows: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    receiptRows = [];
    prisma = {
      messageReceipt: {
        findUnique: jest.fn(),
        findMany: jest
          .fn()
          .mockImplementation((args: { where?: Record<string, unknown> }) => {
            const where = args.where ?? {};
            const inIds = where.messageId as { in?: string[] } | undefined;
            const inTargets = where.toInstanceId as
              { in?: string[] } | undefined;
            let rows = receiptRows;
            if (inIds?.in) {
              rows = rows.filter((r) =>
                inIds.in?.includes(r.messageId as string),
              );
            }
            if (inTargets?.in) {
              rows = rows.filter((r) =>
                inTargets.in?.includes(r.toInstanceId as string),
              );
            }
            if (typeof where.status === 'string') {
              rows = rows.filter((r) => r.status === where.status);
            }
            if (typeof where.teamId === 'string') {
              rows = rows.filter((r) => r.teamId === where.teamId);
            }
            return Promise.resolve(rows);
          }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
      },
      message: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
      team: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      teamMember: { findUnique: jest.fn() },
      artifactVersion: { findFirst: jest.fn() },
      task: { findUnique: jest.fn() },
      chatChannel: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    realtime = { broadcast: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageReceiptsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
      ],
    }).compile();

    service = module.get<MessageReceiptsService>(MessageReceiptsService);
  });

  describe('引用即销账（A4-1 · me_0000000237）', () => {
    it('正文精确引用派发 messageId → 该回执行结账（settled_reason=quoted）', async () => {
      receiptRows = [receiptRow];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        ...receiptRow,
        status: 'acked',
      });

      const settled = await service.settleByReference({
        teamId: 'tm_1',
        actorInstanceId: 'tmm_dev',
        content: `已完成，见派发 ${dispatchMessageId} 的要求`,
      });

      expect(settled).toBe(1);
      expect(prisma.messageReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr_1', status: 'pending' },
        data: expect.objectContaining({
          status: 'acked',
          settledReason: 'quoted',
        }),
      });
      const acked = realtime.broadcast.mock.calls.find(
        (c) => c[0] === EVENT_TYPES.RECEIPT_ACKED,
      );
      expect(acked?.[1]).toMatchObject({
        receiptId: 'mr_1',
        settledReason: 'quoted',
      });
    });

    it('**绝不新增回执行**（me_0000000030：销账是减法）', async () => {
      receiptRows = [receiptRow];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        ...receiptRow,
        status: 'acked',
      });

      await service.settleByReference({
        teamId: 'tm_1',
        actorInstanceId: 'tmm_dev',
        content: `见 ${dispatchMessageId}`,
      });

      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('负例：不相关的消息（引用了别的 messageId）→ 不销账', async () => {
      receiptRows = [receiptRow];

      const settled = await service.settleByReference({
        teamId: 'tm_1',
        actorInstanceId: 'tmm_dev',
        content: '我引用了 m_0000009999，跟这条派发无关',
      });

      expect(settled).toBe(0);
      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('负例：部分匹配（m_00000001001 含 m_0000000100）→ 不销账（只认逐字相等）', async () => {
      receiptRows = [receiptRow];

      const settled = await service.settleByReference({
        teamId: 'tm_1',
        actorInstanceId: 'tmm_dev',
        content: '见 m_00000001001',
      });

      expect(settled).toBe(0);
      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('负例：第三方引用（既不是派发方也不是被指派人）→ 不销账', async () => {
      receiptRows = [receiptRow];

      const settled = await service.settleByReference({
        teamId: 'tm_1',
        actorInstanceId: 'tmm_bystander',
        content: `转述：${dispatchMessageId} 我看到了`,
      });

      expect(settled).toBe(0);
      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('幂等：重复结算第二次是 no-op（至多结一次、不重复广播）', async () => {
      receiptRows = [receiptRow];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        ...receiptRow,
        status: 'acked',
      });
      // 第二次：条件更新抢不到（已被结）⇒ count=0。
      prisma.messageReceipt.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const first = await service.settleByReference({
        teamId: 'tm_1',
        actorInstanceId: 'tmm_dev',
        content: `见 ${dispatchMessageId}`,
      });
      const second = await service.settleByReference({
        teamId: 'tm_1',
        actorInstanceId: 'tmm_dev',
        content: `再报一次：见 ${dispatchMessageId}`,
      });

      expect(first).toBe(1);
      expect(second).toBe(0);
      expect(
        realtime.broadcast.mock.calls.filter(
          (c) => c[0] === EVENT_TYPES.RECEIPT_ACKED,
        ),
      ).toHaveLength(1);
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('并发结算：条件更新只放行一个赢家（updateMany 的 where 带 status=pending）', async () => {
      receiptRows = [receiptRow];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        ...receiptRow,
        status: 'acked',
      });
      prisma.messageReceipt.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const results = await Promise.all([
        service.settleByReference({
          teamId: 'tm_1',
          actorInstanceId: 'tmm_dev',
          content: `见 ${dispatchMessageId}`,
        }),
        service.settleByReference({
          teamId: 'tm_1',
          actorInstanceId: 'tmm_main',
          content: `见 ${dispatchMessageId}`,
        }),
      ]);

      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      expect(
        realtime.broadcast.mock.calls.filter(
          (c) => c[0] === EVENT_TYPES.RECEIPT_ACKED,
        ),
      ).toHaveLength(1);
    });
  });

  describe('extractReferencedMessageIds（精确 token 抽取）', () => {
    it('抽出逐字相等的消息 id 候选', () => {
      expect(
        extractReferencedMessageIds(`见 ${dispatchMessageId} 与 m_0000000200`),
      ).toEqual([dispatchMessageId, 'm_0000000200']);
    });

    it('不把更长的 id 截成短的（m_00000001001 ≠ m_0000000100）', () => {
      expect(extractReferencedMessageIds('见 m_00000001001')).toEqual([
        'm_00000001001',
      ]);
    });

    it('非 id 词（无下划线数字尾巴）不产出候选', () => {
      expect(extractReferencedMessageIds('编号 100 与 mr_1')).toEqual(['mr_1']);
    });
  });

  describe('主 Agent 应答后结 question/help 回执（A4-2 · me_0000000061）', () => {
    const questionReceipt = {
      id: 'mr_q',
      messageId: 'm_0000000300',
      taskId: 't_1',
      teamId: 'tm_1',
      fromInstanceId: 'tmm_dev',
      toInstanceId: 'tmm_main',
      status: 'pending',
    };
    const questionAt = new Date('2026-10-22T10:00:00Z');

    beforeEach(() => {
      prisma.team.findUnique.mockResolvedValue({
        mainAgentMemberId: 'tmm_main',
      });
      receiptRows = [questionReceipt];
      prisma.message.findUnique.mockResolvedValue({
        id: 'm_0000000300',
        channelId: 'c_1',
        createdAt: questionAt,
      });
      prisma.messageReceipt.findUnique.mockResolvedValue({
        ...questionReceipt,
        status: 'acked',
      });
    });

    it('主 Agent 在提问之后、同一频道发言 → 提问回执结账（question-answered）', async () => {
      const settled = await service.settleQuestionReceiptsAfterMainPost({
        teamId: 'tm_1',
        channelId: 'c_1',
        actorInstanceId: 'tmm_main',
        postedAt: new Date('2026-10-22T10:05:00Z'),
      });

      expect(settled).toBe(1);
      expect(prisma.messageReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr_q', status: 'pending' },
        data: expect.objectContaining({
          status: 'acked',
          settledReason: 'question-answered',
        }),
      });
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('负例：发言者不是主 Agent → 不结账', async () => {
      const settled = await service.settleQuestionReceiptsAfterMainPost({
        teamId: 'tm_1',
        channelId: 'c_1',
        actorInstanceId: 'tmm_dev',
        postedAt: new Date('2026-10-22T10:05:00Z'),
      });

      expect(settled).toBe(0);
      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('负例：发言早于提问 → 不结账', async () => {
      const settled = await service.settleQuestionReceiptsAfterMainPost({
        teamId: 'tm_1',
        channelId: 'c_1',
        actorInstanceId: 'tmm_main',
        postedAt: new Date('2026-10-22T09:59:00Z'),
      });

      expect(settled).toBe(0);
      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('负例：不在同一频道 → 不结账', async () => {
      const settled = await service.settleQuestionReceiptsAfterMainPost({
        teamId: 'tm_1',
        channelId: 'c_other',
        actorInstanceId: 'tmm_main',
        postedAt: new Date('2026-10-22T10:05:00Z'),
      });

      expect(settled).toBe(0);
      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });

    it('拉取式兜底：主 Agent 在提问频道里答过话 → 结账（覆盖非 MCP 落消息的答复）', async () => {
      prisma.team.findMany.mockResolvedValue([
        { mainAgentMemberId: 'tmm_main' },
      ]);
      receiptRows = [questionReceipt];
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm_0000000300',
          channelId: 'c_1',
          createdAt: questionAt,
        },
      ]);
      prisma.message.findFirst.mockResolvedValue({ id: 'm_0000000301' });

      const settled = await service.settleAnsweredQuestionReceipts();

      expect(settled).toBe(1);
      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            channelId: 'c_1',
            senderInstanceId: 'tmm_main',
            createdAt: { gt: questionAt },
          }),
        }),
      );
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('拉取式兜底：主 Agent 还没答过 → 不结账', async () => {
      prisma.team.findMany.mockResolvedValue([
        { mainAgentMemberId: 'tmm_main' },
      ]);
      receiptRows = [questionReceipt];
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'm_0000000300',
          channelId: 'c_1',
          createdAt: questionAt,
        },
      ]);
      prisma.message.findFirst.mockResolvedValue(null);

      await expect(service.settleAnsweredQuestionReceipts()).resolves.toBe(0);
      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('被 supersede 替换的旧派发销账（A4-4）', () => {
    it('旧派发的 pending 回执行结账（settled_reason=superseded）且不新增行', async () => {
      receiptRows = [receiptRow];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        ...receiptRow,
        status: 'acked',
      });

      const settled = await service.settleSupersededDispatch({
        messageId: dispatchMessageId,
        teamId: 'tm_1',
      });

      expect(settled).toBe(1);
      expect(prisma.messageReceipt.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr_1', status: 'pending' },
        data: expect.objectContaining({
          status: 'acked',
          settledReason: 'superseded',
        }),
      });
      expect(prisma.messageReceipt.create).not.toHaveBeenCalled();
    });

    it('幂等：重复销账第二次 no-op（至多结一次）', async () => {
      receiptRows = [receiptRow];
      prisma.messageReceipt.findUnique.mockResolvedValue({
        ...receiptRow,
        status: 'acked',
      });
      prisma.messageReceipt.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      await service.settleSupersededDispatch({
        messageId: dispatchMessageId,
        teamId: 'tm_1',
      });
      const second = await service.settleSupersededDispatch({
        messageId: dispatchMessageId,
        teamId: 'tm_1',
      });

      expect(second).toBe(0);
      expect(
        realtime.broadcast.mock.calls.filter(
          (c) => c[0] === EVENT_TYPES.RECEIPT_ACKED,
        ),
      ).toHaveLength(1);
    });

    it('旧派发没有 pending 回执行 → 零写库（no-op）', async () => {
      receiptRows = [];

      const settled = await service.settleSupersededDispatch({
        messageId: dispatchMessageId,
        teamId: 'tm_1',
      });

      expect(settled).toBe(0);
      expect(prisma.messageReceipt.updateMany).not.toHaveBeenCalled();
    });
  });
});
