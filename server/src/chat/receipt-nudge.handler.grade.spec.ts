import { Test, TestingModule } from '@nestjs/testing';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TriggerService } from '../timers/trigger.service';
import { MessageReceiptsService } from './message-receipts.service';
import {
  buildAutoNudgeText,
  RECEIPT_NUDGE_KIND,
  ReceiptNudgeHandler,
} from './receipt-nudge.handler';
import { WorkerDispatcher } from './worker-dispatcher';

/**
 * 批次 A4 · 催办文案分级（me_0000000016 / me_0000000069 的误报催办治本）。
 *
 * 旧文案只说「已发出约 N 分钟仍无回执」——这句话在多数真实场景里是**假的**
 * （活儿干完了，只是账本没记上），于是催办变成对正确行为的惩罚。本 spec 锁住：
 *   ① 三档态势（未开工 / 已交付未销账 / 回执未送达）各自的文案与**销账动作**；
 *   ② 平台证不出来时走通用文案（不假装知道）；
 *   ③ 判据只读账本/消息/产出物，读错即回落 unknown；
 *   ④ 已应答的回执不再被催（me_0000000061）。
 */
describe('ReceiptNudgeHandler 催办文案分级（批次 A4）', () => {
  let handler: ReceiptNudgeHandler;
  let prisma: {
    messageReceipt: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
    };
    message: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
    team: { findUnique: jest.Mock; findMany: jest.Mock };
    teamMember: { findUnique: jest.Mock };
    artifactVersion: { findFirst: jest.Mock };
    chatChannel: { findFirst: jest.Mock };
  };
  let timers: { registerHandler: jest.Mock; schedule: jest.Mock };
  let workerDispatcher: { dispatchAgentMention: jest.Mock };

  const payload = {
    receiptId: 'mr_1',
    teamId: 'tm_1',
    taskId: 't_1',
    channelId: 'c_1',
    messageId: 'm_0000000100',
    fromInstanceId: 'tmm_main',
    toInstanceId: 'tmm_dev',
    assigneeName: '开发者',
    fromName: '项目经理',
  };

  const pendingRow = () => ({
    id: 'mr_1',
    messageId: 'm_0000000100',
    taskId: 't_1',
    teamId: 'tm_1',
    fromInstanceId: 'tmm_main',
    toInstanceId: 'tmm_dev',
    status: 'pending',
    nudgeCount: 0,
    createdAt: new Date(Date.now() - 7 * 60 * 1000),
  });

  beforeEach(async () => {
    prisma = {
      messageReceipt: {
        findUnique: jest.fn().mockResolvedValue(pendingRow()),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: unknown }) =>
            Promise.resolve({ id: 'mr_1', ...((data as object) ?? {}) }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      message: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'm_0000000100',
          channelId: 'c_1',
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
        }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      team: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      teamMember: { findUnique: jest.fn().mockResolvedValue(null) },
      artifactVersion: { findFirst: jest.fn().mockResolvedValue(null) },
      chatChannel: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    timers = {
      registerHandler: jest.fn(),
      schedule: jest.fn().mockResolvedValue({ id: 'tmr_x' }),
    };
    workerDispatcher = {
      dispatchAgentMention: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiptNudgeHandler,
        MessageReceiptsService,
        { provide: PrismaService, useValue: prisma },
        { provide: TriggerService, useValue: timers },
        { provide: RealtimeService, useValue: { broadcast: jest.fn() } },
        { provide: WorkerDispatcher, useValue: workerDispatcher },
        { provide: IdGeneratorService, useValue: { nextId: jest.fn() } },
      ],
    }).compile();
    await module.init();

    handler = module.get(ReceiptNudgeHandler);
  });

  const nudgeText = (): string =>
    workerDispatcher.dispatchAgentMention.mock.calls[0][0].text as string;

  describe('文案分级（buildAutoNudgeText）', () => {
    const base = {
      messageId: 'm_0000000100',
      receiptId: 'mr_1',
      attempt: 1,
      elapsedMin: 7,
      fromLabel: '项目经理',
      toLabel: '开发者',
    };

    it('未开工：说清「没看到任何交付痕迹」+ 给出开工与回执动作', () => {
      const text = buildAutoNudgeText({ ...base, nudgeCase: 'not-started' });
      expect(text).toContain('平台自动催办');
      expect(text).toContain('第1次');
      expect(text).toContain('项目经理 → 开发者');
      expect(text).toContain('7 分钟');
      expect(text).toContain('m_0000000100');
      expect(text).toContain('没有看到你的任何回复或产出物');
      expect(text).toContain('请先开工');
      expect(text).toContain('vteam_notify_agent');
    });

    it('已交付未销账：说清「账上有交付、结账是平台的锅」+ 给出销账动作', () => {
      const text = buildAutoNudgeText({
        ...base,
        nudgeCase: 'delivered-unsettled',
      });
      expect(text).toContain('已经记到你的交付');
      expect(text).toContain('是平台没结账，不是你没干');
      expect(text).toContain('你不用重做');
      expect(text).toContain('带原派发消息 id（m_0000000100）');
    });

    it('回执未送达：说清「账本查不到你的回执记录」+ 劝退用 notify 清账', () => {
      const text = buildAutoNudgeText({
        ...base,
        nudgeCase: 'receipt-not-landed',
      });
      expect(text).toContain('查不到你的回执记录');
      expect(text).toContain('带原派发消息 id（m_0000000100）');
      expect(text).toContain('不要用 notify_agent 去"清"账');
      expect(text).toContain('越清越多');
    });

    it('证不出来（unknown）：走通用文案，不假装知道', () => {
      const text = buildAutoNudgeText({ ...base, nudgeCase: 'unknown' });
      expect(text).toContain('未能确证当前态势');
      expect(text).toContain('带原派发消息 id（m_0000000100）');
      // 通用文案**不**声称任何具体态势。
      expect(text).not.toContain('没有看到你的任何回复或产出物');
      expect(text).not.toContain('已经记到你的交付');
      expect(text).not.toContain('查不到你的回执记录');
    });

    it('缺省（不带 nudgeCase）→ 通用文案（既有调用方兼容）', () => {
      const text = buildAutoNudgeText(base);
      expect(text).toContain('未能确证当前态势');
      expect(text).toContain('m_0000000100');
    });
  });

  describe('态势判据（只读探针）', () => {
    it('无回信、无产出物 → 未开工', async () => {
      await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

      expect(nudgeText()).toContain('没有看到你的任何回复或产出物');
    });

    it('有回信但账本查不到回执行 → 回执未送达', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm_reply_1' }]);
      prisma.messageReceipt.count.mockResolvedValue(0);

      await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

      expect(nudgeText()).toContain('查不到你的回执记录');
    });

    it('有回信且账本查得到回执行 → 已交付未销账', async () => {
      prisma.message.findMany.mockResolvedValue([{ id: 'm_reply_1' }]);
      prisma.messageReceipt.count.mockResolvedValue(1);

      await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

      expect(nudgeText()).toContain('已经记到你的交付');
      expect(nudgeText()).toContain('是平台没结账，不是你没干');
    });

    it('没有回信但有产出物 → 回执未送达（有交付、账上没回执）', async () => {
      prisma.message.findMany.mockResolvedValue([]);
      prisma.teamMember.findUnique.mockResolvedValue({ agentId: 'a_dev' });
      prisma.artifactVersion.findFirst.mockResolvedValue({ id: 'av_1' });

      await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

      expect(nudgeText()).toContain('查不到你的回执记录');
    });

    it('探针读错 → 回落 unknown（通用文案），不假装知道', async () => {
      prisma.message.findUnique.mockRejectedValue(new Error('db down'));

      await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

      expect(nudgeText()).toContain('未能确证当前态势');
    });

    it('催办仍然照发（分级只改文案，不改催办节律）', async () => {
      await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

      expect(workerDispatcher.dispatchAgentMention).toHaveBeenCalledTimes(1);
      expect(prisma.messageReceipt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'mr_1' },
          data: expect.objectContaining({ nudgeCount: { increment: 1 } }),
        }),
      );
    });
  });

  describe('已应答的回执不再被催（me_0000000061）', () => {
    it('催办前扫描发现该回执已被主 Agent 应答结账 → 不催办、不写库', async () => {
      // 扫描期间该回执被结掉 ⇒ 重读时已非 pending。
      prisma.messageReceipt.findUnique
        .mockResolvedValueOnce(pendingRow())
        .mockResolvedValueOnce({ ...pendingRow(), status: 'acked' });

      await handler.handle({ id: 'tmr_1', kind: RECEIPT_NUDGE_KIND, payload });

      expect(workerDispatcher.dispatchAgentMention).not.toHaveBeenCalled();
      expect(prisma.messageReceipt.update).not.toHaveBeenCalled();
    });
  });
});
